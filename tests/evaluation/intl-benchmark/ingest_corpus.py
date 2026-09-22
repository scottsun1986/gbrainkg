#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把基准语料摄入 GBrainKG:登录 → 建库 → 逐段 text 入库 → 轮询至全部发布。

- 限速 4 req/s + 429 指数退避(全局 ThrottlerGuard 600/min)
- 断点续传:按标题跳过 KB 中已存在的文档;failed 文档走 /retry 端点
- 轮询分页拉全量(list 接口单页上限 100)
"""
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = os.environ.get("API_BASE", "http://127.0.0.1:3202")
USER = os.environ.get("TEST_USER", "admin")
PASS = os.environ.get("TEST_PASSWORD", "123456")
BASE = Path(__file__).parent
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

KB_NAMES = {
    "hotpot": "公开基准-HotpotQA-EN",
    "2wiki": "公开基准-2WikiMultiHopQA-EN",
    "musique": "公开基准-MuSiQue-EN",
}


def http(method, path, body=None, token=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace") or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


def login():
    preset = os.environ.get("LLMWIKI_TOKEN") or os.environ.get("EVAL_BEARER_TOKEN")
    if preset:
        return preset
    s, b = http("POST", "/api/v1/auth/login", {"username": USER, "password": PASS})
    assert s in (200, 201), f"login failed: {s} {b}"
    return b["token"]


def find_or_create_kb(token, name):
    s, b = http("GET", "/api/v1/kbs?page=1&limit=200", token=token)
    for kb in (b.get("items") or []):
        if kb.get("name") == name and kb.get("status") == "active":
            return kb["id"], False
    s, b = http("POST", "/api/v1/kbs/personal", {"name": name,
                "description": f"国际基准测评语料库 {name}(seed=42)"}, token=token)
    assert s in (200, 201), f"create kb failed: {s} {b}"
    kb = b.get("knowledgeBase") or b
    return kb["id"], True


def list_all_docs(token, kb_id):
    docs, page = [], 1
    while True:
        s, b = http("GET", f"/api/v1/kbs/{kb_id}/documents?page={page}&limit=100", token=token)
        items = b.get("items") or []
        docs.extend(items)
        total = b.get("total")
        if not items or len(docs) >= (total or 0) or page > 100:
            break
        page += 1
    return docs


class RateLimiter:
    def __init__(self, per_second=4.0):
        self.interval = 1.0 / per_second
        self.last = 0.0

    def wait(self):
        now = time.time()
        delta = self.last + self.interval - now
        if delta > 0:
            time.sleep(delta)
        self.last = time.time()


def ingest_one(token, kb_id, item, limiter):
    for attempt in range(5):
        limiter.wait()
        s, b = http("POST", f"/api/v1/kbs/{kb_id}/documents/text",
                    {"title": item["title"][:200], "content": item["text"]},
                    token=token, timeout=120)
        if s in (200, 201):
            doc = (b.get("documents") or [{}])[0]
            return item["title"], doc.get("id"), None
        if s == 429:
            time.sleep(min(30, 2 ** attempt * 2))
            continue
        return item["title"], None, f"{s}:{str(b)[:120]}"
    return item["title"], None, "429:exhausted"


def poll_published(token, kb_id, total, timeout_s=10800):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout_s:
        docs = list_all_docs(token, kb_id)
        by_status = {}
        for d in docs:
            by_status[d.get("status")] = by_status.get(d.get("status"), 0) + 1
        if by_status != last:
            print(f"  [{int(time.time()-t0)}s] {by_status} (total {len(docs)})", flush=True)
            last = by_status
        if docs and len(docs) >= total:
            active = by_status.get("parsing", 0) + by_status.get("indexing", 0)
            if active == 0:
                return by_status.get("published", 0) >= total, by_status
        time.sleep(20)
    return False, {"timeout": True}


def main(dataset):
    corpus = json.load(open(BASE / "corpus" / f"{dataset}_corpus.json"))
    token = login()
    kb_id, created = find_or_create_kb(token, KB_NAMES[dataset])
    existing = {d.get("title"): d for d in list_all_docs(token, kb_id)}
    print(f"KB={KB_NAMES[dataset]} id={kb_id} corpus={len(corpus)} existing={len(existing)}", flush=True)

    meta_path = BASE / f"{dataset}_ingest_meta.json"
    meta = json.load(open(meta_path)) if meta_path.exists() else {}

    if not created or os.environ.get("FORCE_INGEST") == "1":
        pass  # 续传逻辑总是执行
    todo = [it for it in corpus if it["title"][:200] not in existing]
    failed_docs = [d for d in existing.values() if d.get("status") == "failed"]
    print(f"to_post={len(todo)} to_retry={len(failed_docs)}", flush=True)

    limiter = RateLimiter(4.0)
    fail = []
    if todo:
        with ThreadPoolExecutor(max_workers=4) as ex:
            for i, (title, doc_id, err) in enumerate(
                    ex.map(lambda it: ingest_one(token, kb_id, it, limiter), todo)):
                if err:
                    fail.append((title, err))
                if (i + 1) % 100 == 0:
                    print(f"  posted {i+1}/{len(todo)} failed_so_far={len(fail)}", flush=True)

    for d in failed_docs:
        limiter.wait()
        s, b = http("POST", f"/api/v1/kbs/{kb_id}/documents/{d['id']}/retry", {}, token=token, timeout=120)
        if s not in (200, 201):
            fail.append((d.get("title"), f"retry:{s}"))

    print(f"posted={len(todo)-len(fail)} retry_triggerd={len(failed_docs)} new_failures={len(fail)}")
    for t, e in fail[:10]:
        print("  FAIL", t, e)

    ok, status = poll_published(token, kb_id, len(corpus))
    meta.update({"kb_id": kb_id, "corpus": len(corpus), "all_published": ok, "final_status": status,
                 "post_failures": fail})
    json.dump(meta, open(meta_path, "w"), ensure_ascii=False, indent=1)
    print("DONE", dataset, "all_published=", ok, status)


if __name__ == "__main__":
    main(sys.argv[1])
