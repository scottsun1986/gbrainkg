#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Split a golden dataset into N contiguous shards.

The 220-case enterprise suite takes ~20s per case, so a full pass is sharded
across processes; each shard is driven by its own golden file plus
`EVAL_RESULTS_NAME`, then recombined by merge_shards.py.

Usage:
    python3 shard_golden.py golden_dataset.json --shards 4 --prefix /tmp/golden-shard
"""

import argparse
import json
import math


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("golden")
    parser.add_argument("--shards", type=int, default=4)
    parser.add_argument("--prefix", default="/tmp/golden-shard")
    args = parser.parse_args()

    cases = json.load(open(args.golden, encoding="utf-8"))
    size = math.ceil(len(cases) / args.shards)
    for i in range(args.shards):
        chunk = cases[i * size:(i + 1) * size]
        if not chunk:
            continue
        path = f"{args.prefix}-{i}.json"
        json.dump(chunk, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"{path}: {len(chunk)} cases "
              f"({chunk[0]['id']} .. {chunk[-1]['id']})")


if __name__ == "__main__":
    main()
