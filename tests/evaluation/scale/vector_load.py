#!/usr/bin/env python3
"""Concurrent pure-vector KNN load harness (pgvector HNSW path).

Measures the exact production vector-arm SQL shape used by
`retrieval-arms.ts` (kbId filter + published join + cosine KNN) under
configurable concurrency. No API stack, no rerank — this isolates the
pure-vector retrieval path.

Usage:
  python3 vector_load.py --schema scale_bench --concurrency 10 --requests 100
  python3 vector_load.py --schema public --kb <uuid> --concurrency 50
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import threading
import time
from typing import Any

DEFAULT_DATABASE_URL = os.environ.get(
    "ANN_EVAL_DATABASE_URL",
    os.environ.get(
        "DATABASE_URL",
        "postgresql://llmwiki:llmwiki_pass@localhost:5433/llmwiki",
    ),
)


def parse_dsn(dsn: str) -> dict[str, Any]:
    from urllib.parse import unquote, urlsplit

    parts = urlsplit(dsn)
    return {
        "user": unquote(parts.username or ""),
        "password": unquote(parts.password or ""),
        "host": parts.hostname or "localhost",
        "port": parts.port or 5432,
        "database": (parts.path or "/").lstrip("/") or "postgres",
    }


def connect(dsn: str, schema: str | None):
    import pg8000.dbapi

    conn = pg8000.dbapi.connect(**parse_dsn(dsn), timeout=120)
    if schema:
        cur = conn.cursor()
        cur.execute(f'SET search_path TO "{schema}", public')
        conn.commit()
    return conn


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if p <= 0:
        return ordered[0]
    if p >= 100:
        return ordered[-1]
    rank = (p / 100) * (len(ordered) - 1)
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def summarize(latencies: list[float], errors: list[float], wall: float) -> dict:
    total = len(latencies) + len(errors)
    ordered = sorted(latencies)
    return {
        "path": "pure_vector_knn",
        "requests": total,
        "success": len(latencies),
        "errors": len(errors),
        "error_rate": round(len(errors) / total, 4) if total else 0.0,
        "qps": round(total / wall, 2) if wall > 0 else 0.0,
        "success_qps": round(len(latencies) / wall, 2) if wall > 0 else 0.0,
        "wall_seconds": round(wall, 3),
        "latency_ms": {
            "min": round(ordered[0] * 1000, 2) if ordered else 0.0,
            "p50": round(percentile(ordered, 50) * 1000, 2),
            "p95": round(percentile(ordered, 95) * 1000, 2),
            "p99": round(percentile(ordered, 99) * 1000, 2),
            "max": round(ordered[-1] * 1000, 2) if ordered else 0.0,
            "mean": round(statistics.fmean(ordered) * 1000, 2) if ordered else 0.0,
        },
    }


def sample_query_vectors(conn, limit: int, kb: str | None) -> list[list[float]]:
    sql = """
        SELECT c.embedding::text
        FROM "Chunk" c
        JOIN "Document" d ON d.id = c."documentId"
        WHERE c.embedding IS NOT NULL AND d.status = 'published'
    """
    params: list[Any] = []
    if kb:
        sql += ' AND c."kbId" = %s::uuid'
        params.append(kb)
    sql += " ORDER BY md5(c.id::text) LIMIT %s"
    params.append(limit)
    cur = conn.cursor()
    cur.execute(sql, tuple(params))
    rows = cur.fetchall()
    conn.commit()
    out: list[list[float]] = []
    for (text,) in rows:
        inner = text.strip()
        if inner.startswith("[") and inner.endswith("]"):
            inner = inner[1:-1]
        out.append([float(x) for x in inner.split(",") if x])
    return out


def run_load(
    *,
    dsn: str,
    schema: str | None,
    kb: str | None,
    vectors: list[list[float]],
    concurrency: int,
    total_requests: int,
    k: int,
    ef_search: int,
) -> dict:
    success: list[float] = []
    errors: list[float] = []
    error_types: dict[str, int] = {}
    lock = threading.Lock()
    counter = {"n": 0}
    rows_seen: list[int] = []

    def worker(worker_id: int) -> None:
        conn = connect(dsn, schema)
        try:
            cur = conn.cursor()
            cur.execute("BEGIN")
            cur.execute(f"SET LOCAL hnsw.ef_search = {int(ef_search)}")
            conn.commit()
            while True:
                with lock:
                    if counter["n"] >= total_requests:
                        return
                    index = counter["n"]
                    counter["n"] += 1
                vec = vectors[index % len(vectors)]
                literal = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
                started = time.perf_counter()
                try:
                    cur = conn.cursor()
                    cur.execute("SET LOCAL statement_timeout = 60000")
                    cur.execute(f"SET LOCAL hnsw.ef_search = {int(ef_search)}")
                    if kb:
                        cur.execute(
                            """
                            SELECT c.id::text
                            FROM "Chunk" c
                            JOIN "Document" d ON d.id = c."documentId"
                            WHERE c."kbId" = %s::uuid
                              AND c.embedding IS NOT NULL
                              AND d.status = 'published'
                            ORDER BY c.embedding <=> %s::vector
                            LIMIT %s
                            """,
                            (kb, literal, k),
                        )
                    else:
                        cur.execute(
                            """
                            SELECT c.id::text
                            FROM "Chunk" c
                            JOIN "Document" d ON d.id = c."documentId"
                            WHERE c.embedding IS NOT NULL
                              AND d.status = 'published'
                            ORDER BY c.embedding <=> %s::vector
                            LIMIT %s
                            """,
                            (literal, k),
                        )
                    ids = cur.fetchall()
                    conn.commit()
                    elapsed = time.perf_counter() - started
                    with lock:
                        success.append(elapsed)
                        rows_seen.append(len(ids))
                except Exception as exc:  # noqa: BLE001 - load harness records all failures
                    elapsed = time.perf_counter() - started
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    with lock:
                        errors.append(elapsed)
                        key = type(exc).__name__
                        error_types[key] = error_types.get(key, 0) + 1
        finally:
            try:
                conn.close()
            except Exception:
                pass

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(concurrency)]
    wall_start = time.perf_counter()
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    wall = time.perf_counter() - wall_start
    report = summarize(success, errors, wall)
    report.update(
        {
            "concurrency": concurrency,
            "k": k,
            "ef_search": ef_search,
            "schema": schema or "public",
            "kb_id": kb,
            "error_types": error_types,
            "rows_returned_mean": round(statistics.fmean(rows_seen), 2) if rows_seen else 0.0,
        }
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Pure-vector KNN concurrency load")
    parser.add_argument("--database-url", default=DEFAULT_DATABASE_URL)
    parser.add_argument("--schema", default=None)
    parser.add_argument("--kb", default=None, help="restrict to one kbId")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--requests", type=int, default=50)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--ef-search", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20260922)
    parser.add_argument("--output", default=None)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        assert abs(percentile([0.0, 10.0], 95) - 9.5) < 1e-9
        report = summarize([0.1, 0.2], [0.4], 1.0)
        assert report["errors"] == 1 and report["success"] == 2
        print("vector_load selftest OK")
        return 0

    random.seed(args.seed)
    probe = connect(args.database_url, args.schema)
    try:
        vectors = sample_query_vectors(probe, max(args.requests, 32), args.kb)
    finally:
        probe.close()
    if not vectors:
        raise SystemExit("no embedded chunks found for query sampling")

    if args.warmup > 0:
        run_load(
            dsn=args.database_url,
            schema=args.schema,
            kb=args.kb,
            vectors=vectors,
            concurrency=min(args.concurrency, args.warmup),
            total_requests=args.warmup,
            k=args.k,
            ef_search=args.ef_search,
        )

    report = run_load(
        dsn=args.database_url,
        schema=args.schema,
        kb=args.kb,
        vectors=vectors,
        concurrency=args.concurrency,
        total_requests=args.requests,
        k=args.k,
        ef_search=args.ef_search,
    )
    report["timestamp_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    text = json.dumps(report, indent=2, ensure_ascii=False)
    print(text)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
