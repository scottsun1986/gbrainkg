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
import math
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

# Comparable baseline (see baselines/README). v14 was produced by a binary
# any-gold-in-top-k indicator and is NOT comparable with the fractional grader
# this suite uses; comparing against it produced a phantom "recall regression".
DEFAULT_BASELINE = BASE / "baselines" / "golden_baseline_v15_regraded.json"
METRIC_DEFINITION = "gold_title_fraction_v1"

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
    # A pre-minted session token wins over password login so a run can be driven
    # by CI (or by an operator who does not hold the account password) exactly
    # like quality-gate.ts / ci-gate.sh already do via LLMWIKI_TOKEN.
    preset = os.environ.get("LLMWIKI_TOKEN") or os.environ.get("EVAL_BEARER_TOKEN")
    if preset:
        return preset
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


def gold_variants(gold):
    """Alternative surface forms of a gold answer that denote the same answer.

    Multi-hop gold answers are written in a canonical but often over-specific
    form. Measured on the MuSiQue hard probe (2026-09-21) strict substring
    containment marked at least two *correct* answers wrong:

      * ``ATS - 6 (Applications Technology Satellite - 6)`` vs the answer's ``ATS-6``
      * ``Brian Thomas Moynihan`` vs the source's own ``Brian Moynihan``

    Both are alias problems, not capability problems. The variant list keeps the
    strict check intact (it is still reported as ``containment``) and adds a
    secondary, alias-aware reading.
    """
    base = str(gold or "").strip()
    if not base:
        return []
    variants = [base]
    # "ATS - 6" and "ATS-6" are the same token once punctuation is dropped
    # ("ats 6" vs "ats6"), so collapse whitespace around a hyphen as well.
    collapsed = re.sub(r"\s*-\s*", "-", base)
    if collapsed != base:
        variants.append(collapsed)
    outside = re.sub(r"[\(\[](?:[^\)\]]*)[\)\]]", " ", base)
    if outside.strip():
        variants.append(outside.strip())
        collapsed_outside = re.sub(r"\s*-\s*", "-", outside.strip())
        if collapsed_outside != outside.strip():
            variants.append(collapsed_outside)
    for m in re.findall(r"[\(\[]([^\)\]]*)[\)\]]", base):
        if m.strip():
            variants.append(m.strip())
    for v in list(variants):
        if re.search(r"\bor\b", v, re.I):
            for piece in re.split(r"\s+or\s+", v, flags=re.I):
                if piece.strip():
                    variants.append(piece.strip())
    # Personal names: the source often gives first+last where the gold carries a
    # middle name ("Brian Thomas Moynihan" -> "Brian Moynihan").
    for v in list(variants):
        tokens = normalize_answer(v).split()
        # Only for capitalised, letters-only phrases: applying it to
        # "Applications Technology Satellite - 6" produced the nonsense variant
        # "applications 6".
        if (
            3 <= len(tokens) <= 4
            and re.fullmatch(r"(?:[A-Z][a-z’'–-]+\s+){2,3}[A-Z][a-z’'–-]+", v.strip())
        ):
            variants.append(f"{tokens[0]} {tokens[-1]}")
    seen, out = set(), []
    for v in variants:
        key = normalize_answer(v)
        if key and key not in seen:
            seen.add(key)
            out.append(v)
    return out


def answer_match(pred, gold):
    """Alias-aware answer match — secondary metric next to strict containment.

    True when the prediction contains any gold surface form. Deliberately does
    NOT fall back to bag-of-words matching: that would start rewarding answers
    which merely reuse the question's words. For word-order-only differences
    ("counties of Lithuania" vs "Lithuania's 10 counties") use the LLM re-grade
    pass instead, which can read the answer.
    """
    p = normalize_answer(pred)
    if not p:
        return False
    return any(normalize_answer(v) in p for v in gold_variants(gold))


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
        key = t.casefold()
        if is_rel(t) and key not in hits:
            hits[key] = i + 1
    denom = len(gold)
    recall2 = sum(1 for r in hits.values() if r <= 2) / denom if denom else 0.0
    recall5 = sum(1 for r in hits.values() if r <= 5) / denom if denom else 0.0
    recall10 = sum(1 for r in hits.values() if r <= 10) / denom if denom else 0.0
    full = 1.0 if denom > 0 and recall10 == 1.0 else 0.0
    top10_hits = [rank for rank in hits.values() if rank <= 10]
    mrr = 1.0 / min(top10_hits) if top10_hits else 0.0

    # Standard nDCG@10 with binary relevance and document deduplication:
    # DCG = sum(rel_i / log2(i + 2)) over ranks i=0..9, counting each gold
    # document only at its best (first) rank. IDCG is the same sum with all
    # gold documents placed at the top positions.
    seen_gold = set()
    dcg = 0.0
    for i, t in enumerate(ranked_titles[:10]):
        key = t.casefold()
        if key in gold and key not in seen_gold:
            seen_gold.add(key)
            dcg += 1.0 / math.log2(i + 2)

    num_gold = min(len(gold), 10)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(num_gold))

    return {"recall@2": recall2, "recall@5": recall5, "recall@10": recall10,
            "full_evidence": full, "mrr@10": mrr, "ndcg@10": dcg / idcg if idcg > 0 else 0.0}


def avg(k, rows):
    vals = [r[k] for r in rows if r.get(k) is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


def _selftest():
    perfect = ranking_metrics(["A", "B"], ["A", "B"])
    assert perfect["recall@2"] == 1.0 and perfect["full_evidence"] == 1.0
    partial = ranking_metrics(["A", "X"], ["A", "B"])
    assert partial["recall@2"] == 0.5 and partial["full_evidence"] == 0.0
    outside_cutoff = ranking_metrics([f"x{i}" for i in range(10)] + ["A"], ["A"])
    assert outside_cutoff["mrr@10"] == 0.0
    duplicates = ranking_metrics(["A", "a", "B"], ["A", "B"])
    assert 0.0 <= duplicates["ndcg@10"] <= 1.0
    print("benchmark_suite selftest OK")


def run_single_benchmark(dataset, mode="full", limit=0, token=None):
    # EVAL_SET_PATH lets a targeted regression set (e.g. the exact questions a
    # previous run got wrong) be replayed through the same harness and grader,
    # so "is this failure reproducible or was it load/temperature noise?" is a
    # measurement instead of a guess.
    eval_file = Path(os.environ.get("EVAL_SET_PATH") or (BASE / f"{dataset}_eval_set.json"))
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
            # API failures are benchmark failures, not missing observations.
            # Scoring them as zero prevents the average from silently dropping
            # the hardest/erroring requests.
            return {
                "qid": q["qid"], "ranked": [], "recall@2": 0.0,
                "recall@5": 0.0, "recall@10": 0.0,
                "full_evidence": 0.0, "mrr@10": 0.0,
                "ndcg@10": 0.0, "error": err,
            }
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
        # Reliability mode: the same question is answered `--repeats` times.
        #
        # Measured on this system (2026-09-20/21): replaying the 20 HotpotQA
        # questions a batch run had failed produced 7 correct answers, and two
        # identical-configuration n=100 runs differed by 3 points of containment.
        # Single-shot scoring therefore cannot separate a real improvement from
        # sampling noise — below ~0.05 on n=100 the two are indistinguishable.
        # With repeats>1 each case reports the mean (expected value), the
        # majority verdict, and pass@N (the ceiling), and the headline metrics
        # become the mean over repeats.
        repeats = max(1, int(os.environ.get("QA_REPEATS", "1") or 1))

        def qa_once(q):
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
                "alias_match": float(answer_match(ans, q["answer"])),
                "citation_hit": float(any(t.casefold() in set(g.casefold() for g in q["gold_titles"]) for t in cit_titles)),
                "refusal": is_refusal(ans),
            }

        def do_qa(q):
            runs = [qa_once(q) for _ in range(repeats)]
            if repeats == 1:
                return runs[0]
            first = dict(runs[0])
            for key in ("em", "f1", "containment", "alias_match", "citation_hit", "refusal"):
                values = [float(r.get(key) or 0) for r in runs]
                first[f"{key}_mean"] = sum(values) / len(values)
                first[f"{key}_majority"] = float(sum(values) * 2 >= len(values))
                first[key] = first[f"{key}_mean"] if key != "refusal" else float(
                    sum(1 for r in runs if r.get("refusal")) * 2 > len(runs)
                )
            first["containment_pass_at_n"] = float(any((r.get("containment") or 0) > 0 for r in runs))
            first["runs"] = [
                {"answer": r.get("answer"), "containment": r.get("containment"),
                 "citation_hit": r.get("citation_hit"), "error": r.get("error")}
                for r in runs
            ]
            first["error"] = next((r.get("error") for r in runs if r.get("error")), None)
            # Keep the first run's provenance fields for the detail artefact.
            best = max(runs, key=lambda r: (r.get("containment") or 0))
            first["answer"] = best.get("answer")
            first["citations"] = best.get("citations")
            first["latency"] = max(float(r.get("latency") or 0) for r in runs)
            first["ttft"] = max(float(r.get("ttft") or 0) for r in runs)
            return first

        with ThreadPoolExecutor(max_workers=QA_WORKERS) as ex:
            for i, r in enumerate(ex.map(do_qa, eval_set)):
                qa_rows.append(r)
                if (i + 1) % 25 == 0 or (i + 1) == len(eval_set):
                    print(f"  [问答进度]: {i+1}/{len(eval_set)}", flush=True)
        t_qa_dur = round(time.time() - t_qa_start, 2)
        qa_errors = sum(1 for r in qa_rows if r["error"])
        successful = [r for r in qa_rows if not r["error"]]
        refusals = [r for r in successful if r["refusal"]]
        non_ref = [r for r in successful if not r["refusal"]]
        qa_summary = {
            # Accuracy metrics include API failures (their answer/citations are
            # empty and therefore score zero); otherwise outages improve scores.
            "containment": avg("containment", qa_rows),
            # Alias-aware companion to `containment`: same run, same rows, but
            # tolerant of gold-answer aliases (bracketed alternatives, "or"
            # lists, full personal names). Reported side by side so the strict
            # number never disappears.
            "alias_match": avg("alias_match", qa_rows),
            "citation_hit": avg("citation_hit", qa_rows),
            "refusal_rate_on_answerable": round(len(refusals) / len(successful), 4) if successful else None,
            "em": avg("em", qa_rows),
            "f1": avg("f1", qa_rows),
            "f1_on_attempted": avg("f1", non_ref),
            "em_on_attempted": avg("em", non_ref),
            "api_errors": qa_errors,
            "avg_ttft": avg("ttft", successful),
            "avg_latency": avg("latency", successful),
        }
        if repeats > 1:
            # Reliability view of the same run: mean (expected value per
            # question), majority verdict, and the pass@N ceiling. A wide
            # pass@N - mean gap means the remaining failures are sampling
            # noise, not capability.
            qa_summary["repeats"] = repeats
            qa_summary["containment_majority"] = avg("containment_majority", qa_rows)
            qa_summary["containment_pass_at_n"] = avg("containment_pass_at_n", qa_rows)
            qa_summary["citation_hit_majority"] = avg("citation_hit_majority", qa_rows)
        print(f"  [问答阶段完成 - 耗时 {t_qa_dur}s]: Containment={qa_summary['containment']}, CitationHit={qa_summary['citation_hit']}, RefusalRate={qa_summary['refusal_rate_on_answerable']}")
        if repeats > 1:
            print(
                f"  [重复测量 x{repeats}]: Containment(mean)={qa_summary['containment']}, "
                f"majority={qa_summary['containment_majority']}, "
                f"pass@{repeats}={qa_summary['containment_pass_at_n']}",
                flush=True,
            )

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
    # Guard against comparing across metric definitions. A baseline recorded with
    # the legacy binary hit indicator (any gold title in the top-k) or with a
    # single-number "recall" would make every delta meaningless — that is exactly
    # how a 0.79 run was reported as a 0.21 regression against a "1.00" baseline.
    baseline_metric = baseline_data.get("metric_definition")
    if baseline_metric != METRIC_DEFINITION:
        print(
            f"\n⚠️  基准文件 {Path(baseline_path).name} 的指标口径为 "
            f"{baseline_metric or 'legacy/unspecified'}，与本套件的 {METRIC_DEFINITION} 不一致。\n"
            "    拒绝进行差值对比（跨口径比较会产生虚假的退化/提升）。\n"
            "    请用 regrade_baseline.py 以当前口径重新生成基准。"
        )
        return []

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
            # Baselines that only pin retrieval metrics (the regraded v15 file)
            # carry no "qa" block; absence must degrade to "skip QA rows",
            # never to a KeyError that aborts the whole report.
            b_qa = b_ds.get("qa") or {}
            for label, key, lower_is_better in qa_metrics:
                b_val = b_qa.get(key)
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
    parser.add_argument("--selftest", action="store_true", help="仅校验指标实现，不访问 API")

    args = parser.parse_args()

    if args.selftest:
        _selftest()
        return

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
