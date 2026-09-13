#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""国际基准端到端评测:检索排名(Recall/MRR/nDCG)+ 端到端问答(EM/F1/引用命中/拒答)。"""
import json
import os
import re
import ssl
import string
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

API = os.environ.get("API_BASE", "http://127.0.0.1:3202")
USER = os.environ.get("TEST_USER", "admin")
PASS = os.environ.get("TEST_PASSWORD", "123456")
QA_WORKERS = int(os.environ.get("QA_WORKERS", "3"))
SEARCH_WORKERS = int(os.environ.get("SEARCH_WORKERS", "4"))
CHAT_TIMEOUT = float(os.environ.get("CHAT_TIMEOUT", "240"))
BASE = Path(__file__).parent
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

KB_NAMES = {
    "hotpot": "公开基准-HotpotQA-EN",
    "2wiki": "公开基准-2WikiMultiHopQA-EN",
    "musique": "公开基准-MuSiQue-EN",
}
REFUSALS = ("无法回答", "无法根据", "未包含", "没有找到", "无法从", "知识库中未", "不足以回答",
            "don't know", "cannot answer", "not enough information", "no relevant", "unable to answer",
            "无法确定", "抱歉")


def http(method, path, body=None, token=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


# ---------------- 官方 SQuAD/HotpotQA 口径 ----------------
def normalize_answer(s):
    def remove_articles(text):
        return re.sub(r"\b(a|an|the)\b", " ", text)
    def white_space_fix(text):
        return " ".join(text.split())
    def remove_punc(text):
        exclude = set(string.punctuation)
        return "".join(ch for ch in text if ch not in exclude)
    return white_space_fix(remove_articles(remove_punc(str(s).lower())))


def f1_score(pred, gold):
    pt, gt = normalize_answer(pred).split(), normalize_answer(gold).split()
    common = Counter(pt) & Counter(gt)
    num_same = sum(common.values())
    if len(pt) == 0 or len(gt) == 0:
        return float(pt == gt)
    if num_same == 0:
        return 0.0
    precision, recall = num_same / len(pt), num_same / len(gt)
    return 2 * precision * recall / (precision + recall)


def em_score(pred, gold):
    return float(normalize_answer(pred) == normalize_answer(gold))


def is_refusal(answer):
    a = (answer or "").strip()
    return any(k in a.lower() for k in REFUSALS)


# ---------------- API ----------------
def login():
    s, raw = http("POST", "/api/v1/auth/login", {"username": USER, "password": PASS})
    assert s in (200, 201), raw
    return json.loads(raw)["token"]


def chat_once(token, message, kb_id):
    """SSE 问答,返回 dict(answer, citations, ttft, latency, error)。"""
    body = {"message": message, "kb_scope": [kb_id]}
    req = urllib.request.Request(f"{API}/api/v1/chat/completions",
                                 data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    out = {"answer": "", "citations": [], "ttft": None, "latency": None, "error": None}
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=CHAT_TIMEOUT, context=CTX) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: "):
                    continue
                payload = line[6:].strip()
                if payload == "[DONE]":
                    break
                try:
                    d = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                kind = d.get("type")
                if kind == "delta":
                    if out["ttft"] is None:
                        out["ttft"] = round(time.time() - t0, 2)
                    out["answer"] += d.get("content") or ""
                elif kind == "citation":
                    te = d.get("timeline_entry") or {}
                    if te.get("doc_title"):
                        out["citations"].append({"title": te.get("doc_title"),
                                                 "document_id": te.get("document_id"),
                                                 "score": te.get("score")})
        out["latency"] = round(time.time() - t0, 2)
    except Exception as e:
        out["error"] = str(e)[:200]
        out["latency"] = round(time.time() - t0, 2)
    return out


def search_once(token, query, kb_id, limit=50):
    s, raw = http("POST", "/api/v1/chat/search",
                  {"query": query, "kb_scope": [kb_id], "limit": limit},
                  token=token, timeout=120)
    if s not in (200, 201):
        return None, f"{s}:{raw[:120]}"
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        return None, "json:" + raw[:120]


# ---------------- 指标 ----------------
def ranking_metrics(ranked_titles, gold_titles):
    """ranked_titles: 按序的检索结果标题;gold: 金标标题集(大小写不敏感)。"""
    gold = set(g.casefold() for g in gold_titles)
    def is_rel(t):
        return t.casefold() in gold
    hits = {}
    for i, t in enumerate(ranked_titles):
        if is_rel(t) and t not in hits:
            hits[t] = i + 1
    recall2 = 1.0 if any(r <= 2 for r in hits.values()) else 0.0
    recall5 = 1.0 if any(r <= 5 for r in hits.values()) else 0.0
    recall10 = 1.0 if any(r <= 10 for r in hits.values()) else 0.0
    full = 1.0 if len(hits) == len(gold) else 0.0
    mrr = 1.0 / min(hits.values()) if hits else 0.0
    dcg = sum(1.0 / (i + 1 + 1) ** 0.5 for i, t in enumerate(ranked_titles[:10]) if is_rel(t))
    idcg = sum(1.0 / (i + 2) ** 0.5 for i in range(min(len(gold), 10)))
    return {"recall@2": recall2, "recall@5": recall5, "recall@10": recall10,
            "full_evidence": full, "mrr@10": mrr, "ndcg@10": dcg / idcg if idcg else 0.0}


def avg(k, rows):
    vals = [r[k] for r in rows if r.get(k) is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


def main(dataset):
    eval_set = json.load(open(BASE / f"{dataset}_eval_set.json"))
    limit = int(os.environ.get("EVAL_LIMIT", "0"))
    if limit > 0:
        eval_set = eval_set[:limit]
    meta = json.load(open(BASE / f"{dataset}_ingest_meta.json"))
    kb_id = meta["kb_id"]
    token = login()
    print(f"== {dataset}: kb={kb_id}, {len(eval_set)} questions")

    # ---- 检索排名 ----
    def do_search(q):
        res, err = search_once(token, q["question"], kb_id)
        if err:
            return {"qid": q["qid"], "error": err}
        titles = []
        for r in res.get("results") or []:
            t = r.get("title")
            if t:
                titles.append(t)
        m = ranking_metrics(titles, q["gold_titles"])
        return {"qid": q["qid"], "ranked": titles[:20], **m, "error": None}

    rows = []
    with ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as ex:
        for r in ex.map(do_search, eval_set):
            rows.append(r)
    search_errors = sum(1 for r in rows if r["error"])
    ret = {k: avg(k, rows) for k in ("recall@2", "recall@5", "recall@10", "full_evidence", "mrr@10", "ndcg@10")}
    print("retrieval:", ret, "errors:", search_errors)

    # ---- 端到端问答 ----
    def do_qa(q):
        c = chat_once(token, q["question"], kb_id)
        ans = c.get("answer") or ""
        cit_titles = [x["title"] for x in c.get("citations") or []]
        return {
            "qid": q["qid"], "question": q["question"], "gold": q["answer"], "type": q["type"],
            "answer": ans, "citations": cit_titles, "ttft": c.get("ttft"), "latency": c.get("latency"),
            "error": c.get("error"),
            "em": em_score(ans, q["answer"]),
            "f1": f1_score(ans, q["answer"]),
            "containment": float(normalize_answer(q["answer"]) in normalize_answer(ans)),
            "citation_hit": float(any(t.casefold() in set(g.casefold() for g in q["gold_titles"]) for t in cit_titles)),
            "refusal": is_refusal(ans),
        }

    qa_rows = []
    with ThreadPoolExecutor(max_workers=QA_WORKERS) as ex:
        for i, r in enumerate(ex.map(do_qa, eval_set)):
            qa_rows.append(r)
            if (i + 1) % 20 == 0:
                print(f"  qa {i+1}/{len(eval_set)}", flush=True)
    qa_errors = sum(1 for r in qa_rows if r["error"])
    answered = [r for r in qa_rows if not r["error"]]
    refusals = [r for r in answered if r["refusal"]]
    non_ref = [r for r in answered if not r["refusal"]]
    qa = {
        "em": avg("em", answered), "f1": avg("f1", answered),
        "containment": avg("containment", answered),
        "citation_hit": avg("citation_hit", answered),
        "refusal_rate_on_answerable": round(len(refusals) / len(answered), 4) if answered else None,
        "f1_on_attempted": avg("f1", non_ref),
        "em_on_attempted": avg("em", non_ref),
        "api_errors": qa_errors,
        "avg_ttft": avg("ttft", answered), "avg_latency": avg("latency", answered),
    }
    print("qa:", qa)

    out = {
        "dataset": dataset, "kb_id": kb_id, "n": len(eval_set),
        "meta": {
            "sampling": "seed=42, n=100 per dataset, shared dedup corpus from question contexts",
            "git_commit": os.environ.get("EVAL_GIT_COMMIT", "69a0cf7+working-tree(415-fix)"),
            "generator": "deepseek-chat (mygpt/gpt-5-6 provider was 502 during eval; default LLM switched, see report §9)",
            "embedding": "BAAI/bge-m3 (1024d, siliconflow)",
            "rerank": "BAAI/bge-reranker-v2-m3 (siliconflow)",
            "api_base": API,
        },
        "retrieval": ret, "retrieval_api_errors": search_errors, "qa": qa,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "detail_qa": qa_rows, "detail_retrieval": rows,
    }
    fp = BASE / "results" / f"intl-{dataset}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    fp.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print("saved", fp)


if __name__ == "__main__":
    main(sys.argv[1])
