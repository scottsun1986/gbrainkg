#!/usr/bin/env python3
"""Concurrency / latency load test for the GBrainKG retrieval + answer API.

Reports real p50/p95/p99 latency, throughput (QPS) and error rate under a
configurable concurrency level — the numbers needed to back (or refute) a
"10 万级" performance claim. No fake padding of any kind.

Usage:
    python3 load_test.py --selftest
    python3 load_test.py --api-base http://127.0.0.1:3000 --kb-id <uuid> \\
        --endpoint search --concurrency 16 --requests 500 \\
        --queries queries.txt --output load_report.json
"""
from __future__ import annotations

import argparse
import json
import math
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

DEFAULT_QUERIES = [
    "报销标准是什么",
    "年假有多少天",
    "请假流程如何办理",
    "考勤打卡规定",
    "差旅费如何计算",
]


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    if p <= 0:
        return sorted_values[0]
    if p >= 100:
        return sorted_values[-1]
    rank = (p / 100) * (len(sorted_values) - 1)
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return sorted_values[low]
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (rank - low)


def _latency_summary(latencies: list[float]) -> dict:
    ordered = sorted(latencies)
    return {
        "min": round(ordered[0] * 1000, 2) if ordered else 0.0,
        "p50": round(percentile(ordered, 50) * 1000, 2),
        "p95": round(percentile(ordered, 95) * 1000, 2),
        "p99": round(percentile(ordered, 99) * 1000, 2),
        "max": round(ordered[-1] * 1000, 2) if ordered else 0.0,
        "mean": round((sum(ordered) / len(ordered)) * 1000, 2) if ordered else 0.0,
    }


def summarize(success_latencies: list[float], error_latencies: list[float], wall_seconds: float) -> dict:
    total = len(success_latencies) + len(error_latencies)
    return {
        "requests": total,
        "success": len(success_latencies),
        "errors": len(error_latencies),
        "error_rate": round(len(error_latencies) / total, 4) if total else 0.0,
        # Throughput counts every completed request. Keep successful QPS as a
        # separate SLO signal so failures cannot disappear from throughput.
        "qps": round(total / wall_seconds, 2) if wall_seconds > 0 else 0.0,
        "success_qps": round(len(success_latencies) / wall_seconds, 2) if wall_seconds > 0 else 0.0,
        "latency_ms": _latency_summary(success_latencies + error_latencies),
        "success_latency_ms": _latency_summary(success_latencies),
        "error_latency_ms": _latency_summary(error_latencies),
    }


class Client:
    def __init__(self, base: str, user: str, password: str, timeout: float):
        self.base = base.rstrip("/")
        self.user = user
        self.password = password
        self.timeout = timeout
        self.token: str | None = None

    def request(self, path: str, body=None, auth=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.base}{path}", data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if auth and self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        with urllib.request.urlopen(req, timeout=self.timeout, context=CTX) as resp:
            return resp.read()

    def login(self):
        raw = self.request(
            "/api/v1/auth/login",
            {"username": self.user, "password": self.password},
            auth=False,
        )
        self.token = json.loads(raw.decode("utf-8"))["token"]


def run_load(client, kb_id, queries, endpoint, concurrency, total_requests, timeout):
    success_latencies: list[float] = []
    error_latencies: list[float] = []
    error_types: Counter[str] = Counter()
    lock = threading.Lock()
    counter = {"n": 0}

    def worker():
        while True:
            with lock:
                if counter["n"] >= total_requests:
                    return
                index = counter["n"]
                counter["n"] += 1
            query = queries[index % len(queries)]
            started = time.time()
            try:
                if endpoint == "completions":
                    client.request(
                        "/api/v1/chat/completions",
                        {"message": query, "kb_scope": [kb_id]},
                    )
                else:
                    client.request(
                        "/api/v1/chat/search",
                        {"query": query, "kb_scope": [kb_id], "limit": 20},
                    )
                elapsed = time.time() - started
                with lock:
                    success_latencies.append(elapsed)
            except Exception as exc:
                elapsed = time.time() - started
                with lock:
                    error_latencies.append(elapsed)
                    if isinstance(exc, urllib.error.HTTPError):
                        error_types[f"http_{exc.code}"] += 1
                    elif isinstance(exc, TimeoutError):
                        error_types["timeout"] += 1
                    else:
                        error_types[type(exc).__name__] += 1

    threads = [threading.Thread(target=worker) for _ in range(concurrency)]
    wall_start = time.time()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    wall = time.time() - wall_start
    return success_latencies, error_latencies, dict(error_types), wall


def _selftest() -> int:
    assert percentile([], 50) == 0.0
    assert percentile([1.0], 95) == 1.0
    assert percentile([0.0, 1.0], 50) == 0.5
    assert abs(percentile([0.0, 10.0], 95) - 9.5) < 1e-9
    report = summarize([0.1, 0.2, 0.3], [0.4], 1.0)
    assert report["success"] == 3 and report["errors"] == 1
    assert abs(report["error_rate"] - 0.25) < 1e-9
    assert report["qps"] == 4.0 and report["success_qps"] == 3.0
    assert report["latency_ms"]["p50"] == 250.0
    print("load_test selftest OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="API load test")
    parser.add_argument("--api-base", default="http://127.0.0.1:3000")
    parser.add_argument("--user", default="admin")
    parser.add_argument("--password", default="123456")
    parser.add_argument("--kb-id")
    parser.add_argument("--endpoint", choices=["search", "completions"], default="search")
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--requests", type=int, default=100)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--warmup", type=int, default=10, help="warm-up requests excluded from metrics")
    parser.add_argument("--queries", type=Path, help="one query per line")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return _selftest()
    if not args.kb_id:
        parser.error("--kb-id is required")

    queries = DEFAULT_QUERIES
    if args.queries:
        queries = [line.strip() for line in args.queries.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not queries:
        parser.error("no queries provided")

    client = Client(args.api_base, args.user, args.password, args.timeout)
    client.login()
    if args.warmup > 0:
        run_load(
            client, args.kb_id, queries, args.endpoint,
            min(args.concurrency, args.warmup), args.warmup, args.timeout,
        )
    success_latencies, error_latencies, error_types, wall = run_load(
        client, args.kb_id, queries, args.endpoint, args.concurrency, args.requests, args.timeout
    )
    report = summarize(success_latencies, error_latencies, wall)
    report.update(
        {
            "endpoint": args.endpoint,
            "concurrency": args.concurrency,
            "warmup_requests": args.warmup,
            "wall_seconds": round(wall, 2),
            "error_types": error_types,
        }
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if args.output:
        args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
