#!/usr/bin/env python3
"""Standard, official-qrels IR evaluation for GBrainKG.

This is the trustworthy counterpart to the legacy title-matching heuristic in
``benchmark_suite.py``:

* It consumes the exact format the official benchmarks ship (BEIR:
  ``qrels/test.tsv`` + ``queries.jsonl``; or a generic ``qrels.tsv``).
* Retrieval and generation are evaluated separately.
* Metrics are the standard IR measures (nDCG@k, Recall@k, MRR@k, MAP@k)
  computed strictly from graded qrels — never from a gold-answer fallback.
* The retrieval side is evaluated from a TREC-style run file, so the ranking
  is produced by the real system and can be reproduced/audited independently.

Run file format (JSONL, one object per query):
    {"qid": "q1", "docids": ["d3", "d1", "d9"]}

Usage:
    # evaluate an already-produced run
    python3 standard_ir_eval.py --qrels qrels/test.tsv --run run.jsonl --k 10,100
    # validate the metric implementation
    python3 standard_ir_eval.py --selftest
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Iterable


def dcg_at_k(gains: Iterable[float], k: int) -> float:
    total = 0.0
    for rank, gain in enumerate(list(gains)[:k]):
        total += gain / math.log2(rank + 2)
    return total


def dedupe_ranking(ranked: Iterable[str]) -> list[str]:
    """Keep the first occurrence of each document id.

    A retrieval run is a ranking of unique documents. Counting a duplicate as
    another relevant hit can make nDCG and AP exceed 1.0, so every metric uses
    the same defensive normalization even when called outside ``load_run``.
    """
    seen: set[str] = set()
    unique: list[str] = []
    for raw in ranked:
        doc_id = str(raw)
        if not doc_id or doc_id in seen:
            continue
        seen.add(doc_id)
        unique.append(doc_id)
    return unique


def ndcg_at_k(ranked: list[str], qrels: dict[str, float], k: int) -> float:
    gains = [qrels.get(doc_id, 0.0) for doc_id in dedupe_ranking(ranked)[:k]]
    dcg = dcg_at_k(gains, k)
    ideal = sorted(qrels.values(), reverse=True)[:k]
    idcg = dcg_at_k(ideal, k)
    return dcg / idcg if idcg > 0 else 0.0


def recall_at_k(ranked: list[str], qrels: dict[str, float], k: int) -> float:
    relevant = {doc_id for doc_id, gain in qrels.items() if gain > 0}
    if not relevant:
        return 0.0
    retrieved = set(dedupe_ranking(ranked)[:k])
    return len(relevant & retrieved) / len(relevant)


def mrr_at_k(ranked: list[str], qrels: dict[str, float], k: int) -> float:
    for rank, doc_id in enumerate(dedupe_ranking(ranked)[:k], start=1):
        if qrels.get(doc_id, 0.0) > 0:
            return 1.0 / rank
    return 0.0


def average_precision_at_k(ranked: list[str], qrels: dict[str, float], k: int) -> float:
    relevant = {doc_id for doc_id, gain in qrels.items() if gain > 0}
    if not relevant:
        return 0.0
    hits = 0
    precision_sum = 0.0
    for rank, doc_id in enumerate(dedupe_ranking(ranked)[:k], start=1):
        if doc_id in relevant:
            hits += 1
            precision_sum += hits / rank
    return precision_sum / min(len(relevant), k)


METRIC_FUNCS = {
    "ndcg": ndcg_at_k,
    "recall": recall_at_k,
    "mrr": mrr_at_k,
    "map": average_precision_at_k,
}


def load_qrels(path: Path) -> dict[str, dict[str, float]]:
    """Load qrels TSV. Accepts BEIR ``test.tsv`` (query-id/corpus-id/score) and
    plain ``qid<TAB>docid<TAB>gain`` files, with or without a header."""
    qrels: dict[str, dict[str, float]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            parts = line.split("\t")
            if len(parts) < 3:
                parts = line.split()
            if len(parts) < 3:
                continue
            qid, doc_id, raw_score = parts[0], parts[1], parts[2]
            if qid.lower() in {"query-id", "query_id", "qid"}:
                continue
            try:
                score = float(raw_score)
            except ValueError:
                continue
            qrels.setdefault(qid, {})[doc_id] = score
    return qrels


def load_run(path: Path) -> dict[str, list[str]]:
    run: dict[str, list[str]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            qid = str(record.get("qid") or record.get("query_id") or "")
            if not qid:
                continue
            docids = [str(d) for d in (record.get("docids") or record.get("doc_ids") or [])]
            run[qid] = dedupe_ranking(docids)
    return run


def evaluate(
    qrels: dict[str, dict[str, float]],
    run: dict[str, list[str]],
    k_values: list[int],
) -> dict[str, float]:
    """Macro-average each metric over queries present in qrels. Queries with no
    retrieved result score 0 (they are NOT skipped — dropping hard queries is
    how a benchmark inflates itself)."""
    totals: dict[str, float] = {}
    count = 0
    for qid, relevance in qrels.items():
        if not relevance:
            continue
        ranked = run.get(qid, [])
        count += 1
        for k in k_values:
            for name, func in METRIC_FUNCS.items():
                totals[f"{name}@{k}"] = totals.get(f"{name}@{k}", 0.0) + func(ranked, relevance, k)
    if count == 0:
        return {}
    return {key: value / count for key, value in totals.items()}


def parse_thresholds(values: list[str]) -> dict[str, float]:
    thresholds: dict[str, float] = {}
    for raw in values or []:
        for token in raw.split(","):
            token = token.strip()
            if not token:
                continue
            if "=" not in token:
                raise SystemExit(f"Invalid --threshold '{token}', expected metric=value")
            key, value = token.split("=", 1)
            thresholds[key.strip()] = float(value)
    return thresholds


def check_thresholds(metrics: dict[str, float], thresholds: dict[str, float]) -> list[str]:
    failures: list[str] = []
    for key, minimum in thresholds.items():
        actual = metrics.get(key)
        if actual is None:
            failures.append(f"{key}: not computed")
        elif actual + 1e-9 < minimum:
            failures.append(f"{key}: {actual:.4f} < required {minimum:.4f}")
    return failures


def _selftest() -> int:
    qrels = {
        "q1": {"d1": 2, "d2": 1},
        "q2": {"d3": 1},
    }
    run = {
        "q1": ["d1", "d2", "d9"],
        "q2": ["d9", "d3"],
    }
    result = evaluate(qrels, run, [1, 2, 10])
    # q1 recall@1 = 1/2, q2 recall@1 = 0 -> macro 0.25
    assert abs(result["recall@1"] - 0.25) < 1e-9, result
    assert abs(result["recall@2"] - 1.0) < 1e-9, result
    assert abs(result["mrr@10"] - 0.75) < 1e-9, result
    # q1 nDCG@2 = 1.0, q2 nDCG@2 = 1/log2(3) -> macro average
    assert abs(result["ndcg@2"] - (1.0 + (1.0 / math.log2(3))) / 2) < 1e-9, result
    # Missing query contributes 0, not excluded.
    partial = evaluate({"q1": {"d1": 1}, "q2": {"d3": 1}}, {"q1": ["d1"]}, [1])
    assert abs(partial["recall@1"] - 0.5) < 1e-9, partial
    assert ndcg_at_k(["x"], {}, 10) == 0.0
    # Duplicate relevant ids must never create a metric greater than one.
    assert ndcg_at_k(["d1", "d1"], {"d1": 1}, 10) == 1.0
    assert average_precision_at_k(["d1", "d1"], {"d1": 1}, 10) == 1.0
    assert recall_at_k(["d1", "d1"], {"d1": 1}, 10) == 1.0
    duplicate_run = evaluate({"q": {"d1": 1}}, {"q": ["d1", "d1"]}, [10])
    assert all(0.0 <= value <= 1.0 for value in duplicate_run.values()), duplicate_run
    assert parse_thresholds(["ndcg@10=0.5,recall@100=0.9"]) == {"ndcg@10": 0.5, "recall@100": 0.9}
    assert check_thresholds(result, {"ndcg@2": 0.5}) == []
    assert check_thresholds(result, {"ndcg@2": 0.99}) != []
    print("standard_ir_eval selftest OK:", json.dumps(result, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Official-qrels IR evaluation")
    parser.add_argument("--qrels", type=Path, help="qrels TSV path")
    parser.add_argument("--run", type=Path, help="TREC-style run JSONL path")
    parser.add_argument("--k", default="1,5,10,100", help="comma-separated cutoffs")
    parser.add_argument("--output", type=Path, help="write metrics JSON here")
    parser.add_argument(
        "--threshold",
        action="append",
        default=[],
        help="gate metric, e.g. --threshold ndcg@10=0.5,recall@100=0.9 (repeatable)",
    )
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return _selftest()
    if not args.qrels or not args.run:
        parser.error("--qrels and --run are required unless --selftest is given")

    k_values = [int(x) for x in str(args.k).split(",") if x.strip()]
    qrels = load_qrels(args.qrels)
    run = load_run(args.run)
    metrics = evaluate(qrels, run, k_values)
    if not metrics:
        print("No evaluable queries (empty qrels?)", file=sys.stderr)
        return 1
    print(json.dumps(metrics, indent=2, ensure_ascii=False))
    if args.output:
        args.output.write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")

    thresholds = parse_thresholds(args.threshold)
    if thresholds:
        failures = check_thresholds(metrics, thresholds)
        if failures:
            print("\n[IR GATE] FAILED:", file=sys.stderr)
            for failure in failures:
                print(f"  - {failure}", file=sys.stderr)
            return 1
        print("\n[IR GATE] PASSED:", ", ".join(f"{k}>={v}" for k, v in thresholds.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
