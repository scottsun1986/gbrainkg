#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SOTA10 评测执行:对 10 个基准逐项真实调用 GBrainKG API 并计算得分。

- QA/鲁棒性类(hotpot/2wiki/musique/squad/mintaka/rgb): /chat/completions 端到端问答
  指标: containment / alias_match / F1 / EM(引注剥离) / citation_hit / refusal 正确率 / 时延
- 检索类(scifact/nfcorpus/fiqa/arguana): /chat/search 官方 qrels 评分
  指标: recall@10 / full_evidence@10 / mrr@10 / ndcg@10
- QA 类同时记录检索层 recall@10(搜索接口)以对照论文检索指标

结果写 results/{bench}.json,汇总写 results/_summary.json
"""
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import (API, CTX, http, login, normalize_answer, f1_score, em_score,
                    strip_citation_tags, gold_variants, answer_match, is_refusal,
                    ranking_metrics_ids, sha256_of)  # noqa: E402

BASE = Path(__file__).parent
TASKS = BASE / "tasks"
RESULTS = BASE / "results"
RESULTS.mkdir(exist_ok=True)

QA_BENCHES = {"hotpot", "2wiki", "musique", "squad", "mintaka", "rgb"}
IR_BENCHES = {"scifact", "nfcorpus", "fiqa", "arguana"}

QA_WORKERS = int(__import__("os").environ.get("QA_WORKERS", "3"))
SEARCH_WORKERS = int(__import__("os").environ.get("SEARCH_WORKERS", "4"))
CHAT_TIMEOUT = float(__import__("os").environ.get("CHAT_TIMEOUT", "240"))


def chat_once(token, message, kb_id):
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


def search_once(token, query, kb_id, limit=30, retries=2):
    err = None
    for i in range(retries + 1):
        s, raw = http("POST", "/api/v1/chat/search",
                      {"query": query, "kb_scope": [kb_id], "limit": limit},
                      token=token, timeout=120)
        if s in (200, 201):
            try:
                return json.loads(raw), None
            except json.JSONDecodeError:
                err = "json:" + raw[:140]
        else:
            err = f"{s}:{raw[:140]}"
            if s not in (500, 502, 503, 0):
                break
        time.sleep(2 * (i + 1))
    return None, err


def avg(k, rows, nd=4):
    vals = [r[k] for r in rows if r.get(k) is not None]
    return round(sum(vals) / len(vals), nd) if vals else None


def pct(k, rows):
    vals = [r.get(k) for r in rows if r.get(k) is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


def pctl(vals, p):
    if not vals:
        return None
    vals = sorted(vals)
    i = max(0, min(len(vals) - 1, int(round(p / 100 * (len(vals) - 1)))))
    return vals[i]


def beir_docid_from_title(title):
    m = re.match(r"^\[([^\]]+)\]", str(title or ""))
    return m.group(1) if m else None


# ---------------- per-bench runners ----------------

def run_qa_bench(bench, task, token):
    meta_kb = list(task["kbs"].keys())
    kb_ids = {}
    for kb_name in meta_kb:
        s, raw = http("GET", "/api/v1/kbs?page=1&limit=200", token=token)
        for kb in (json.loads(raw).get("items") or []):
            if kb["name"] == kb_name:
                kb_ids[kb_name] = kb["id"]
    title2id, id2kb = {}, {}
    for kb_name, docs in task["kbs"].items():
        for d in docs:
            title2id[d["title"].casefold()] = (d["id"], kb_name)
            id2kb[d["id"]] = kb_name

    questions = task["questions"]

    def cit_to_docid(c):
        return title2id.get(str(c.get("title") or "").casefold(), (None,))[0]

    def do_qa(q):
        kb_name = q.get("kb") or meta_kb[0]
        c = chat_once(token, q["question"], kb_ids[kb_name])
        ans_raw = c.get("answer") or ""
        ans = strip_citation_tags(ans_raw)
        gold = q["gold_answer"]
        variants = [str(v) for v in (q.get("gold_variants") or []) + (q.get("aliases") or []) + [gold] if v]
        hit = any(normalize_answer(v) in normalize_answer(ans) for v in variants if v)
        cit_ids = [cit_to_docid(x) for x in c.get("citations") or []]
        gold_ids = set(q.get("gold_doc_ids") or [])
        refus = is_refusal(ans)
        expect_refuse = (q.get("rgb") or {}).get("expect") == "refuse"
        row = {"qid": q["qid"], "type": q.get("type"), "question": q["question"], "gold": gold,
               "answer": ans_raw, "citations": [x.get("title") for x in c.get("citations") or []],
               "ttft": c.get("ttft"), "latency": c.get("latency"), "error": c.get("error"),
               "containment": float(hit),
               "f1": max(f1_score(ans, v) for v in variants if v) if any(variants) else None,
               "em": max(em_score(ans, v) for v in variants if v) if any(variants) else None,
               "refusal": refus}
        if gold_ids:
            row["citation_hit"] = float(any(cid in gold_ids for cid in cit_ids if cid))
        if expect_refuse:
            row["reject_correct"] = float(refus)
        elif bench == "rgb":
            # counterfactual 应跟随证据(fakeanswer),noise/integration 应答对
            row["rgb_follow_evidence"] = float(hit)
        return row

    qa_rows = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=QA_WORKERS) as ex:
        for r in ex.map(do_qa, questions):
            qa_rows.append(r)
            done = len(qa_rows)
            if done % 5 == 0 or done == len(questions):
                print(f"  [QA {bench}] {done}/{len(questions)} elapsed={int(time.time()-t0)}s", flush=True)

    # 检索层对照(同一批问题走 /chat/search)
    def do_search(q):
        kb_name = q.get("kb") or meta_kb[0]
        res, err = search_once(token, q["question"], kb_ids[kb_name])
        if err:
            return {"qid": q["qid"], "search_error": err, "recall@10": 0.0,
                    "full_evidence@10": 0.0, "mrr@10": 0.0, "ndcg@10": 0.0}
        ranked_ids = []
        for r_ in (res.get("results") or []):
            title = r_.get("title")
            cid = beir_docid_from_title(title) or title2id.get(str(title or "").casefold(), (None,))[0]
            if cid:
                ranked_ids.append(cid)
        return {"qid": q["qid"], **ranking_metrics_ids(ranked_ids, q.get("gold_doc_ids") or [])}

    search_rows = []
    with ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as ex:
        for r in ex.map(do_search, questions):
            search_rows.append(r)

    summary = {
        "n": len(qa_rows),
        "errors": sum(1 for r in qa_rows if r.get("error")),
        "containment": pct("containment", qa_rows),
        "f1": avg("f1", qa_rows),
        "em": avg("em", qa_rows),
        "citation_hit": pct("citation_hit", qa_rows),
        "reject_correct": pct("reject_correct", qa_rows),
        "retrieval_recall@10": pct("recall@10", search_rows),
        "retrieval_full_evidence@10": pct("full_evidence@10", search_rows),
        "retrieval_mrr@10": pct("mrr@10", search_rows),
        "retrieval_ndcg@10": pct("ndcg@10", search_rows),
        "latency_p50": pctl([r["latency"] for r in qa_rows if r.get("latency")], 50),
        "latency_p95": pctl([r["latency"] for r in qa_rows if r.get("latency")], 95),
        "ttft_p50": pctl([r["ttft"] for r in qa_rows if r.get("ttft")], 50),
        "refusal_rate": pct("refusal", qa_rows),
    }
    return {"rows_qa": qa_rows, "rows_search": search_rows, "summary": summary}


def run_ir_bench(bench, task, token):
    kb_name = list(task["kbs"].keys())[0]
    s, raw = http("GET", "/api/v1/kbs?page=1&limit=200", token=token)
    kb_id = None
    for kb in (json.loads(raw).get("items") or []):
        if kb["name"] == kb_name:
            kb_id = kb["id"]
    id_by_title = {d["title"].casefold(): d["id"] for d in task["kbs"][kb_name]}
    beir2internal = {beir_docid_from_title(t): did for t, did in id_by_title.items()}
    questions = task["questions"]

    def do_search(q):
        res, err = search_once(token, q["question"], kb_id)
        if err:
            return {"qid": q["qid"], "search_error": err, **{k: 0.0 for k in
                    ("recall@10", "full_evidence@10", "mrr@10", "ndcg@10")}}
        ranked_ids = []
        for r_ in (res.get("results") or []):
            cid = beir2internal.get(beir_docid_from_title(r_.get("title"))) \
                or id_by_title.get(str(r_.get("title") or "").casefold())
            if cid:
                ranked_ids.append(cid)
        return {"qid": q["qid"], **ranking_metrics_ids(ranked_ids, q.get("gold_doc_ids") or [])}

    rows = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as ex:
        for r in ex.map(do_search, questions):
            rows.append(r)
    lats = []
    summary = {
        "n": len(rows),
        "errors": sum(1 for r in rows if r.get("search_error")),
        "retrieval_recall@10": pct("recall@10", rows),
        "retrieval_full_evidence@10": pct("full_evidence@10", rows),
        "retrieval_mrr@10": pct("mrr@10", rows),
        "retrieval_ndcg@10": pct("ndcg@10", rows),
        "search_wall_secs": round(time.time() - t0, 1),
    }
    return {"rows_search": rows, "summary": summary}


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("benches", nargs="*")
    args = ap.parse_args()
    token = login()
    benches = args.benches or sorted(
        p.stem for p in TASKS.glob("*.json") if not p.stem.startswith("_"))
    combined = {}
    for bench in benches:
        task_file = TASKS / f"{bench}.json"
        if not task_file.exists():
            print(f"[{bench}] 任务包不存在,跳过")
            continue
        if not (BASE / "ingest_meta" / f"{bench}.json").exists():
            print(f"[{bench}] 尚未注入,跳过")
            continue
        task = json.load(open(task_file))
        print(f"\n▶ 评测 [{bench}] n={len(task['questions'])} mode={'QA' if bench in QA_BENCHES else 'IR'}", flush=True)
        try:
            result = run_qa_bench(bench, task, token) if bench in QA_BENCHES else run_ir_bench(bench, task, token)
        except Exception as e:
            print(f"[{bench}] FAILED: {e}")
            continue
        result["meta"] = task["meta"]
        result["score_sha"] = sha256_of(result["summary"])
        json.dump(result, open(RESULTS / f"{bench}.json", "w"), ensure_ascii=False, indent=1)
        combined[bench] = result["summary"]
        print(f"[{bench}] summary: {json.dumps(result['summary'], ensure_ascii=False)}", flush=True)
    if (RESULTS / "_summary.json").exists() and not args.benches:
        pass
    json.dump(combined, open(RESULTS / "_summary.json", "w"), ensure_ascii=False, indent=1)
    print("\nDONE", json.dumps(combined, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
