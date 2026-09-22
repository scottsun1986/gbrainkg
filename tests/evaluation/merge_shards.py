#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Merge sharded pytest result artifacts and recompute the summary with the exact
same function the suite uses, so a sharded run is reported identically to a
single-process run (no duplicated metric math).

Usage:
    python3 merge_shards.py results/golden-shard-{0,1,2,3}.json \
        --out results/golden-220-<date>.json
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_retrieval_quality import _compute_summary  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("shards", nargs="+")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    results, run_ids, commits = [], [], set()
    for path in args.shards:
        payload = json.load(open(path, encoding="utf-8"))
        results.extend(payload.get("results") or [])
        run_ids.append(payload.get("runId"))
        commits.add(payload.get("gitCommit"))
    results.sort(key=lambda item: item.get("id") or "")

    merged = {
        "runId": run_ids[0] if len(run_ids) == 1 else f"merged:{len(run_ids)}",
        "gitCommit": ",".join(sorted(c for c in commits if c)),
        "timestamp": datetime.now(timezone.utc).timestamp(),
        "timestamp_iso": datetime.now(timezone.utc).isoformat(),
        "dry_run": False,
        "total_cases": len(results),
        "sharded": True,
        "results": results,
        "summary": _compute_summary(results),
    }
    json.dump(merged, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"merged {len(results)} cases from {len(run_ids)} shards -> {args.out}")
    print(json.dumps(merged["summary"]["overall"], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
