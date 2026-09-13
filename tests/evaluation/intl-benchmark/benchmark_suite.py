#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三大国际公开基准标准化套件 (2WikiMultiHopQA / HotpotQA / MuSiQue)
支持:
1. 单数据集 / 全量数据集并发评测 (all / 2wiki / hotpot / musique)
2. 检索专用极速模式 (--mode retrieval) / 端到端全量模式 (--mode full)
3. 抽样快速验证 (--limit N)
4. 自动基准对比 (--baseline) 与退化门禁 (--gate)
5. 结果历史存档与 Markdown 看板生成
"""

import argparse
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

BASE = Path(__file__).parent
API = os.environ.get("API_BASE", "http://127.0.0.1:3202")
USER = os.environ.get("TEST_USER", "admin")
PASS = os.environ.get("TEST_PASSWORD", "123456")
QA_WORKERS = int(os.environ.get("QA_WORKERS", "3"))
SEARCH_WORKERS = int(os.environ.get("SEARCH_WORKERS", "4"))
CHAT_TIMEOUT = float(os.environ.get("CHAT_TIMEOUT", "240"))

DEFAULT_BASELINE = BASE / "baselines" / "golden_baseline_v14.json"

KB_NAMES = {
    "2wiki": "公开基准-2WikiMultiHopQA-EN",
    "hotpot": "公开基准-HotpotQA-EN",
    "musique": "公开基准-MuSiQue-EN",
}

REFUSALS = (
    "无法回答", "无法根据", "未包含", "没有找到", "无法从", "知识库中未", "不足以回答",
    "don't know", "cannot answer", "not enough information", "no relevant", "unable to answer",
    "无法确定", "抱歉"
)

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


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


def login():
    s, raw = http("POST", "/api/v1/auth/login", {"username": USER, "password": PASS})
    if s not in (200, 201):
        raise RuntimeError(f"Login failed ({s}): {raw}")
    return json.loads(raw)["token"]


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


def ranking_metrics(ranked_titles, gold_titles):
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


def run_single_benchmark(dataset, mode="full", limit=0, token=None):
    eval_file = BASE / f"{dataset}_eval_set.json"
    meta_file = BASE / f"{dataset}_ingest_meta.json"
    if not eval_file.exists() or not meta_file.exists():
        raise FileNotFoundError(f"Missing dataset files for {dataset}")

    eval_set = json.load(open(eval_file))
    if limit > 0:
        eval_set = eval_set[:limit]

    meta = json.load(open(meta_file))
    kb_id = meta["kb_id"]
    if not token:
        token = login()

    print(f"\n▶ 正在评测基准 [{dataset.upper()}]: 题量={len(eval_set)}, 模式={mode.upper()}, KB={kb_id}")

    # 1. 检索排名
    def do_search(q):
        res, err = search_once(token, q["question"], kb_id)
        if err:
            return {"qid": q["qid"], "error": err}
        titles = [r.get("title") for r in (res.get("results") or []) if r.get("title")]
        m = ranking_metrics(titles, q["gold_titles"])
        return {"qid": q["qid"], "ranked": titles[:20], **m, "error": None}

    search_rows = []
    t_search_start = time.time()
    with ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as ex:
        for r in ex.map(do_search, eval_set):
            search_rows.append(r)
    t_search_dur = round(time.time() - t_search_start, 2)
    search_errors = sum(1 for r in search_rows if r["error"])
    ret_summary = {k: avg(k, search_rows) for k in ("recall@2", "recall@5", "recall@10", "full_evidence", "mrr@10", "ndcg@10")}
    print(f"  [检索阶段完成 - 耗时 {t_search_dur}s]: Recall@10={ret_summary['recall@10']}, FullEvidence={ret_summary['full_evidence']}, MRR@10={ret_summary['mrr@10']}")

    qa_summary = None
    qa_rows = []
    if mode == "full":
        t_qa_start = time.time()
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

        with ThreadPoolExecutor(max_workers=QA_WORKERS) as ex:
            for i, r in enumerate(ex.map(do_qa, eval_set)):
                qa_rows.append(r)
                if (i + 1) % 25 == 0 or (i + 1) == len(eval_set):
                    print(f"  [问答进度]: {i+1}/{len(eval_set)}", flush=True)
        t_qa_dur = round(time.time() - t_qa_start, 2)
        qa_errors = sum(1 for r in qa_rows if r["error"])
        answered = [r for r in qa_rows if not r["error"]]
        refusals = [r for r in answered if r["refusal"]]
        non_ref = [r for r in answered if not r["refusal"]]
        qa_summary = {
            "containment": avg("containment", answered),
            "citation_hit": avg("citation_hit", answered),
            "refusal_rate_on_answerable": round(len(refusals) / len(answered), 4) if answered else None,
            "em": avg("em", answered),
            "f1": avg("f1", answered),
            "f1_on_attempted": avg("f1", non_ref),
            "em_on_attempted": avg("em", non_ref),
            "api_errors": qa_errors,
            "avg_ttft": avg("ttft", answered),
            "avg_latency": avg("latency", answered),
        }
        print(f"  [问答阶段完成 - 耗时 {t_qa_dur}s]: Containment={qa_summary['containment']}, CitationHit={qa_summary['citation_hit']}, RefusalRate={qa_summary['refusal_rate_on_answerable']}")

    result = {
        "dataset": dataset,
        "kb_id": kb_id,
        "n": len(eval_set),
        "mode": mode,
        "retrieval": ret_summary,
        "retrieval_api_errors": search_errors,
        "qa": qa_summary,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "detail_qa": qa_rows,
        "detail_retrieval": search_rows,
    }

    res_dir = BASE / "results"
    res_dir.mkdir(parents=True, exist_ok=True)
    out_file = res_dir / f"intl-{dataset}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out_file.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"  ✓ 结果保存至: {out_file.relative_to(BASE.parent.parent)}")
    return result


def compare_with_baseline(current_results, baseline_path=DEFAULT_BASELINE):
    if not Path(baseline_path).exists():
        print(f"⚠️ 基准文件未找到: {baseline_path}，跳过对比")
        return []

    baseline_data = json.load(open(baseline_path))
    b_datasets = baseline_data.get("datasets", {})
    b_version = baseline_data.get("version", "unknown")

    diff_reports = []
    print(f"\n==========================================================================================")
    print(f"               国际基准实测效果对比 (当前 Run vs Golden Baseline: {b_version})")
    print(f"==========================================================================================")

    for res in current_results:
        ds = res["dataset"]
        b_ds = b_datasets.get(ds)
        if not b_ds:
            print(f"基准中未定义数据集 {ds}")
            continue

        mode = res.get("mode", "full")
        n = res.get("n", len(res.get("detail_retrieval") or []))
        print(f"\n### 数据集: {ds.upper()} (n={n}, mode={mode})")
        header = f"| {'指标名称':<28} | {'Golden ' + b_version:<15} | {'当前实测':<15} | {'差值 (Delta)':<15} | {'判定状态':<8} |"
        sep = f"|{'-'*30}|{'-'*17}|{'-'*17}|{'-'*17}|{'-'*10}|"
        print(header)
        print(sep)

        # 检索指标
        ret_metrics = [
            ("Recall@2", "recall@2", False),
            ("Recall@5", "recall@5", False),
            ("Recall@10", "recall@10", False),
            ("Full Evidence (全证据)", "full_evidence", False),
            ("MRR@10", "mrr@10", False),
            ("nDCG@10", "ndcg@10", False),
        ]
        qa_metrics = [
            ("Answer Containment (包含率)", "containment", False),
            ("Citation Hit (引用命中)", "citation_hit", False),
            ("Refusal Rate (可答拒答率)", "refusal_rate_on_answerable", True), # lower is better
            ("F1 Score", "f1", False),
            ("Exact Match (EM)", "em", False),
        ]

        ds_diff = {"dataset": ds, "metrics": []}

        for label, key, lower_is_better in ret_metrics:
            b_val = b_ds["retrieval"].get(key)
            c_val = res["retrieval"].get(key)
            if b_val is None or c_val is None:
                continue
            delta = round(c_val - b_val, 4)
            delta_str = f"{delta:+.4f}"
            if abs(delta) < 0.001:
                status = "➖ 持平"
            elif (delta > 0 and not lower_is_better) or (delta < 0 and lower_is_better):
                status = "✅ 提升"
            else:
                status = "⚠️ 退化"
            print(f"| {label:<28} | {b_val:<15.4f} | {c_val:<15.4f} | {delta_str:<15} | {status:<8} |")
            ds_diff["metrics"].append({"label": label, "key": key, "base": b_val, "curr": c_val, "delta": delta, "status": status})

        if res.get("qa"):
            for label, key, lower_is_better in qa_metrics:
                b_val = b_ds["qa"].get(key)
                c_val = res["qa"].get(key)
                if b_val is None or c_val is None:
                    continue
                delta = round(c_val - b_val, 4)
                delta_str = f"{delta:+.4f}"
                if abs(delta) < 0.001:
                    status = "➖ 持平"
                elif (delta > 0 and not lower_is_better) or (delta < 0 and lower_is_better):
                    status = "✅ 提升"
                else:
                    status = "⚠️ 退化"
                print(f"| {label:<28} | {b_val:<15.4f} | {c_val:<15.4f} | {delta_str:<15} | {status:<8} |")
                ds_diff["metrics"].append({"label": label, "key": key, "base": b_val, "curr": c_val, "delta": delta, "status": status})

        diff_reports.append(ds_diff)
    return diff_reports


def check_gate(current_results, baseline_path=DEFAULT_BASELINE):
    baseline_data = json.load(open(baseline_path))
    b_datasets = baseline_data.get("datasets", {})
    failed = []

    print(f"\n==========================================================================================")
    print(f"                          基准质量门禁检查 (Quality Gate)")
    print(f"==========================================================================================")

    for res in current_results:
        ds = res["dataset"]
        b_ds = b_datasets.get(ds, {})
        gates = b_ds.get("gates", {})
        if not gates:
            continue

        ret = res["retrieval"]
        qa = res.get("qa") or {}

        # 检查项
        if "recall@10_min" in gates:
            target = gates["recall@10_min"]
            actual = ret.get("recall@10", 0)
            if actual < target:
                failed.append(f"[{ds}] Recall@10 = {actual:.4f} 低于门禁阈值 {target:.4f}")
            else:
                print(f"  ✓ [{ds}] Recall@10 达标: {actual:.4f} >= {target:.4f}")

        if "full_evidence_min" in gates:
            target = gates["full_evidence_min"]
            actual = ret.get("full_evidence", 0)
            if actual < target:
                failed.append(f"[{ds}] Full Evidence = {actual:.4f} 低于门禁阈值 {target:.4f}")
            else:
                print(f"  ✓ [{ds}] Full Evidence 达标: {actual:.4f} >= {target:.4f}")

        if res.get("mode", "full") == "full":
            if "refusal_rate_max" in gates:
                target = gates["refusal_rate_max"]
                actual = qa.get("refusal_rate_on_answerable", 1.0)
                if actual > target:
                    failed.append(f"[{ds}] 可答拒答率 = {actual:.4f} 高于门禁容忍上限 {target:.4f}")
                else:
                    print(f"  ✓ [{ds}] 拒答率达标: {actual:.4f} <= {target:.4f}")

            if "containment_min" in gates:
                target = gates["containment_min"]
                actual = qa.get("containment", 0)
                if actual < target:
                    failed.append(f"[{ds}] Answer Containment = {actual:.4f} 低于门禁阈值 {target:.4f}")
                else:
                    print(f"  ✓ [{ds}] 答案包含率达标: {actual:.4f} >= {target:.4f}")

    if failed:
        print(f"\n❌ QUALITY GATE FAILED! 发现 {len(failed)} 项指标未通过门禁:")
        for f in failed:
            print(f"  - {f}")
        return False
    else:
        print(f"\n✅ QUALITY GATE PASSED! 全部核心指标满足基准门禁要求。")
        return True


def main():
    parser = argparse.ArgumentParser(description="三大国际公开基准标准化测试与效果比对套件")
    parser.add_argument("dataset", nargs="?", default="all", choices=["all", "2wiki", "hotpot", "musique"],
                        help="测试数据集 (all / 2wiki / hotpot / musique)")
    parser.add_argument("--mode", default="full", choices=["full", "retrieval"],
                        help="测试模式: retrieval (仅检索, 快速验证) 或 full (全量问答生成)")
    parser.add_argument("--limit", type=int, default=0,
                        help="限制评测题目数量 (默认 0 表示全量 100 题)")
    parser.add_argument("--baseline", default=str(DEFAULT_BASELINE),
                        help="基准对照文件路径")
    parser.add_argument("--gate", action="store_true",
                        help="开启防退化门禁判定，未通过则 exit 1")
    parser.add_argument("--compare-only", type=str, default="",
                        help="仅做比对模式：输入一个或多个历史结果 json 文件进行比对分析")

    args = parser.parse_args()

    if args.compare_only:
        files = [Path(f) for f in args.compare_only.split(",")]
        loaded_results = [json.load(open(f)) for f in files if f.exists()]
        compare_with_baseline(loaded_results, args.baseline)
        if args.gate:
            passed = check_gate(loaded_results, args.baseline)
            sys.exit(0 if passed else 1)
        return

    datasets_to_run = ["2wiki", "hotpot", "musique"] if args.dataset == "all" else [args.dataset]

    token = login()
    current_results = []
    for ds in datasets_to_run:
        res = run_single_benchmark(ds, mode=args.mode, limit=args.limit, token=token)
        current_results.append(res)

    compare_with_baseline(current_results, args.baseline)

    if args.gate:
        passed = check_gate(current_results, args.baseline)
        if not passed:
            sys.exit(1)


if __name__ == "__main__":
    main()
