#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SOTA10 注入:把 tasks/{bench}.json 的文档真实注入 GBrainKG(建库 → text 入库 → 轮询发布)。

- 限速 4 req/s + 429 指数退避(对齐全局 ThrottlerGuard)
- 断点续传:按标题跳过已存在文档
- 记录注入成功率 / 发布耗时,写 ingest_meta/{bench}.json
"""
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import http, login, RateLimiter  # noqa: E402

BASE = Path(__file__).parent
META_DIR = BASE / "ingest_meta"
META_DIR.mkdir(exist_ok=True)


def find_or_create_kb(token, name, description):
    s, raw = http("GET", "/api/v1/kbs?page=1&limit=200", token=token)
    if s in (200, 201):
        for kb in (json.loads(raw).get("items") or []):
            if kb.get("name") == name and kb.get("status") == "active":
                return kb["id"], False
    s, raw = http("POST", "/api/v1/kbs/personal", {"name": name, "description": description}, token=token)
    if s not in (200, 201):
        raise RuntimeError(f"create kb failed: {s} {raw[:200]}")
    kb = json.loads(raw)
    kb = kb.get("knowledgeBase") or kb
    return kb["id"], True


def list_all_docs(token, kb_id):
    docs, page = [], 1
    while True:
        s, raw = http("GET", f"/api/v1/kbs/{kb_id}/documents?page={page}&limit=100", token=token)
        if s not in (200, 201):
            break
        body = json.loads(raw)
        items = body.get("items") or []
        docs.extend(items)
        total = body.get("total") or 0
        if not items or len(docs) >= total or page > 50:
            break
        page += 1
    return docs


def ingest_one(token, kb_id, item, limiter):
    for attempt in range(6):
        limiter.wait()
        s, raw = http("POST", f"/api/v1/kbs/{kb_id}/documents/text",
                      {"title": item["title"][:200], "content": item["text"]},
                      token=token, timeout=120)
        if s in (200, 201):
            doc = (json.loads(raw).get("documents") or [{}])[0]
            return item["id"], doc.get("id"), None
        if s == 429:
            time.sleep(min(30, 2 ** attempt * 2))
            continue
        return item["id"], None, f"{s}:{raw[:120]}"
    return item["id"], None, "429:exhausted"


def poll_published(token, kb_id, total, timeout_s=3600):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout_s:
        docs = list_all_docs(token, kb_id)
        by_status = {}
        for d in docs:
            by_status[d.get("status")] = by_status.get(d.get("status"), 0) + 1
        cur = (by_status, len(docs))
        if cur != last:
            print(f"  [{int(time.time()-t0)}s] {by_status} (total {len(docs)})", flush=True)
            last = cur
        if docs and len(docs) >= total:
            active = by_status.get("parsing", 0) + by_status.get("indexing", 0)
            if active == 0:
                return by_status.get("published", 0) >= total, by_status, int(time.time() - t0)
        time.sleep(15)
    return False, {"timeout": True}, int(time.time() - t0)


def ingest_bench(bench, task, token):
    limiter = RateLimiter(4.0)
    out = {"bench": bench, "kbs": {}}
    for kb_name, docs in task["kbs"].items():
        kb_id, created = find_or_create_kb(token, kb_name,
                                           f"SOTA10 国际基准测评库 {bench} (seed=42, ≤30 docs)")
        existing = {d.get("title"): d for d in list_all_docs(token, kb_id)}
        todo = [d for d in docs if d["title"][:200] not in existing]
        failed_existing = [d for d in existing.values() if d.get("status") == "failed"]
        print(f"[{bench}] KB={kb_name} id={kb_id} docs={len(docs)} existing={len(existing)} todo={len(todo)} retry={len(failed_existing)}", flush=True)
        t0 = time.time()
        post_fail = []
        with ThreadPoolExecutor(max_workers=4) as ex:
            for i, (did, sid, err) in enumerate(ex.map(
                    lambda d: ingest_one(token, kb_id, d, limiter), todo)):
                if err:
                    post_fail.append({"doc": did, "err": err})
                if (i + 1) % 10 == 0:
                    print(f"  posted {i+1}/{len(todo)} failed={len(post_fail)}", flush=True)
        for d in failed_existing:
            limiter.wait()
            http("POST", f"/api/v1/kbs/{kb_id}/documents/{d['id']}/retry", {}, token=token, timeout=120)
        ok, status, poll_secs = poll_published(token, kb_id, len(docs) - len(post_fail))
        full_ok = ok and (status.get("published", 0) if isinstance(status, dict) else 0) >= len(docs)
        elapsed = round(time.time() - t0, 1)
        out["kbs"][kb_name] = {"kb_id": kb_id, "created": created, "expected": len(docs),
                               "all_published": full_ok, "final_status": status, "post_failures": post_fail,
                               "elapsed_secs": elapsed, "poll_secs": poll_secs}
        print(f"[{bench}] {kb_name}: published={full_ok} elapsed={elapsed}s status={status}", flush=True)
    json.dump(out, open(META_DIR / f"{bench}.json", "w"), ensure_ascii=False, indent=1)
    return out


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("benches", nargs="*", help="基准名,缺省为全部已构建任务包")
    args = ap.parse_args()
    token = login()
    tasks_dir = BASE / "tasks"
    benches = args.benches or sorted(p.stem for p in tasks_dir.glob("*.json") if not p.stem.startswith("_"))
    for bench in benches:
        task_file = tasks_dir / f"{bench}.json"
        if not task_file.exists():
            print(f"[{bench}] 任务包不存在,跳过")
            continue
        task = json.load(open(task_file))
        try:
            ingest_bench(bench, task, token)
        except Exception as e:
            print(f"[{bench}] FAILED: {e}", flush=True)


if __name__ == "__main__":
    main()
