#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Regrade stored benchmark run files into a comparable golden baseline.

Why this exists
---------------
The v14 golden baseline was produced by ``run_eval.py``, whose metric was a
*binary hit indicator*:

    recall@10 = 1.0 if ANY gold title appears in the top-10 else 0.0

``benchmark_suite.py`` (v42, the current gate) measures true fractional recall:

    recall@10 = (# distinct gold titles found in top-10) / (# gold titles)

For a 4-title multi-hop gold set, finding one title scored 1.0 under the old
grader and 0.25 under the correct one, so the two are not comparable at all. The
old numbers could not be reproduced from their own stored ranked lists (2Wiki:
claimed 1.00 → regraded 0.725).

This script rebuilds a baseline that IS comparable: it replays the stored ranked
lists of the baseline runs through the current grader and records the exact
metric definition, so a future gate can refuse to compare across graders.

Usage:
    python3 regrade_baseline.py \
        --run 2wiki=results/intl-2wiki-20260913-121603.json \
        --run hotpot=results/intl-hotpot-20260913-132204.json \
        --run musique=results/intl-musique-20260913-134657.json \
        --out baselines/golden_baseline_v15_regraded.json
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

BASE = Path(__file__).parent
sys.path.insert(0, str(BASE))
from benchmark_suite import ranking_metrics  # noqa: E402  (path set above)

METRIC_DEFINITION = "gold_title_fraction_v1"


def regrade(dataset: str, run_path: Path) -> dict:
    run = json.loads(run_path.read_text(encoding="utf-8"))
    eval_path = BASE / f"{dataset}_eval_set.json"
    eval_set = {q["qid"]: q for q in json.loads(eval_path.read_text(encoding="utf-8"))}

    rows = []
    missing_qids = []
    for detail in run.get("detail_retrieval") or []:
        qid = detail.get("qid")
        question = eval_set.get(qid)
        if not question:
            missing_qids.append(qid)
            continue
        rows.append(ranking_metrics(detail.get("ranked") or [], question["gold_titles"]))

    if not rows:
        raise SystemExit(f"no gradable rows in {run_path}")

    def avg(key: str) -> float:
        return round(statistics.fmean(r[key] for r in rows), 4)

    return {
        "n": len(rows),
        "source_run": str(run_path.relative_to(BASE)) if run_path.is_relative_to(BASE) else str(run_path),
        "unmatched_qids": missing_qids,
        "retrieval": {
            "recall@2": avg("recall@2"),
            "recall@5": avg("recall@5"),
            "recall@10": avg("recall@10"),
            "full_evidence": avg("full_evidence"),
            "mrr@10": avg("mrr@10"),
            "ndcg@10": avg("ndcg@10"),
        },
        # Regression gate expressed as a tolerance below the regraded baseline
        # rather than an unattainable absolute. A gate that the system has never
        # met (or that a laxer grader met by accident) trains everyone to ignore it;
        # this one answers "did we get worse than the honest baseline".
        "gates": {
            "recall@10_min": round(max(0.0, avg("recall@10") - 0.03), 4),
            "full_evidence_min": round(max(0.0, avg("full_evidence") - 0.05), 4),
            "refusal_rate_max": 0.05,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Regrade stored runs into a comparable baseline")
    parser.add_argument(
        "--run",
        action="append",
        required=True,
        metavar="DATASET=PATH",
        help="dataset id and stored result file, repeatable (2wiki=/path.json)",
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--note", default="")
    args = parser.parse_args()

    datasets: dict[str, dict] = {}
    for spec in args.run:
        if "=" not in spec:
            raise SystemExit(f"--run expects DATASET=PATH, got {spec!r}")
        dataset, path = spec.split("=", 1)
        datasets[dataset] = regrade(dataset, Path(path))

    payload = {
        "version": "v15.0-regraded",
        "metric_definition": METRIC_DEFINITION,
        "description": (
            "Baseline regraded from the stored ranked lists of the v14 runs with the "
            "current fractional grader. Supersedes golden_baseline_v14.json, which was "
            "produced by a binary any-gold-in-top-k indicator and is not comparable."
        ),
        "supersedes": "golden_baseline_v14.json",
        "note": args.note,
        "datasets": datasets,
    }
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for dataset, data in datasets.items():
        r = data["retrieval"]
        print(
            f"{dataset:<8} n={data['n']:<4} R@10={r['recall@10']:.4f} "
            f"FullEv={r['full_evidence']:.3f} MRR={r['mrr@10']:.4f} nDCG={r['ndcg@10']:.4f}"
        )
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
