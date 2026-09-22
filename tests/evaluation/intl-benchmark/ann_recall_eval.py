#!/usr/bin/env python3
"""Filtered-HNSW recall harness (exact KNN as gold).

The audit's second P0 gap: the pipeline filters a global HNSW index by
knowledge base and document status, but pgvector applies the filter *after* the
graph scan, so a selective filter can silently return fewer neighbours than
requested. This harness measures that directly:

  * gold   = exact KNN over the same filtered candidate set
             (``SET LOCAL enable_indexscan = off`` -> sequential exact scan)
  * system = the production query shape with the configured
             ``hnsw.ef_search`` and ``hnsw.iterative_scan`` settings

For each sampled query vector it reports Recall@K, how many rows the ANN query
returned (a short result set is the failure mode the audit calls out) and wall
clock latency, bucketed by filter selectivity.

Usage:
    python3 ann_recall_eval.py --selftest
    python3 ann_recall_eval.py --limit 200 --k 10 --out report.json
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from typing import Any

DEFAULT_DATABASE_URL = os.environ.get(
    "ANN_EVAL_DATABASE_URL",
    os.environ.get("DATABASE_URL", "postgresql://llmwiki:llmwiki_pass@localhost:5433/llmwiki"),
)


def parse_dsn(dsn: str) -> dict[str, Any]:
    """Parse a postgres:// URL into pg8000 connection kwargs."""
    from urllib.parse import unquote, urlsplit

    parts = urlsplit(dsn)
    return {
        "user": unquote(parts.username or ""),
        "password": unquote(parts.password or ""),
        "host": parts.hostname or "localhost",
        "port": parts.port or 5432,
        "database": (parts.path or "/").lstrip("/") or "postgres",
    }


def connect(dsn: str):
    import pg8000.dbapi

    return pg8000.dbapi.connect(**parse_dsn(dsn), timeout=120)


def vector_literal(vector: Any) -> str:
    """Render a pgvector value (list or '[..]' string) as a literal."""
    if isinstance(vector, str):
        return vector if vector.startswith("[") else f"[{vector}]"
    return "[" + ",".join(f"{float(x):.6f}" for x in vector) + "]"


def recall_at_k(gold: list[str], system: list[str]) -> float:
    if not gold:
        return 0.0
    gold_set = set(gold)
    return len([x for x in system if x in gold_set]) / len(gold_set)


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((p / 100.0) * (len(ordered) - 1))))
    return ordered[idx]


def selectivity_bucket(ratio: float) -> str:
    if ratio < 0.05:
        return "selective(<5%)"
    if ratio < 0.3:
        return "moderate(5-30%)"
    return "broad(>=30%)"


class AnnEvaluator:
    """Runs the exact/ANN comparison against a live database."""

    def __init__(self, conn, schema: str | None = None):
        self.conn = conn
        self.schema = schema
        if schema:
            if not schema.replace("_", "").isalnum():
                raise ValueError(f"unsafe schema name: {schema}")
            cur = self.conn.cursor()
            # Benchmark isolation: point every unqualified relation at the
            # benchmark schema, never at the application schema.
            cur.execute(f'SET search_path TO "{schema}", public')
            self.conn.commit()

    def sample_queries(self, limit: int, kb: str | None) -> list[dict[str, Any]]:
        sql = """
            SELECT c.id::text, c."kbId"::text, c.embedding::text
            FROM "Chunk" c
            JOIN "Document" d ON d.id = c."documentId"
            WHERE c.embedding IS NOT NULL AND d.status = 'published'
        """
        params: list[Any] = []
        if kb:
            sql += ' AND c."kbId" = %s::uuid'
            params.append(kb)
        sql += ' ORDER BY md5(c.id::text) LIMIT %s'
        params.append(limit)
        cur = self.conn.cursor()
        cur.execute(sql, tuple(params))
        return [{"id": r[0], "kbId": r[1], "embedding": r[2]} for r in cur.fetchall()]

    def knn(
        self,
        kb_scope: list[str],
        vector: Any,
        k: int,
        *,
        exact: bool,
        ef_search: int = 40,
        iterative_scan: str = "off",
    ) -> tuple[list[str], float, int]:
        cur = self.conn.cursor()
        cur.execute("SET LOCAL statement_timeout = 60000")
        if exact:
            # pgvector documents disabling the index scan as the way to get an
            # exact (sequential) neighbour list for a recall baseline.
            cur.execute("SET LOCAL enable_indexscan = off")
            cur.execute("SET LOCAL enable_bitmapscan = off")
        else:
            # SET does not accept bind parameters; both values are validated
            # (ints / argparse choice) before reaching this point.
            cur.execute(f"SET LOCAL hnsw.ef_search = {int(ef_search)}")
            if iterative_scan not in {"off", "relaxed_order", "strict_order"}:
                raise ValueError(f"unsupported iterative scan mode: {iterative_scan}")
            cur.execute(f"SET LOCAL hnsw.iterative_scan = {iterative_scan}")
        sql = """
            SELECT c.id::text
            FROM "Chunk" c
            JOIN "Document" d ON d.id = c."documentId"
            WHERE c."kbId" = ANY(%s::uuid[])
              AND c.embedding IS NOT NULL
              AND d.status = 'published'
            ORDER BY c.embedding <=> %s::vector
            LIMIT %s
        """
        started = time.perf_counter()
        cur.execute(sql, (kb_scope, vector_literal(vector), k))
        ids = [row[0] for row in cur.fetchall()]
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        # End the transaction so the SET LOCAL overrides (notably disabling the
        # index scan for the gold run) never leak into the next measurement.
        self.conn.commit()
        return ids, elapsed_ms, len(ids)

    def filter_ratio(self, kb_scope: list[str]) -> float:
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT
              (SELECT count(*) FROM "Chunk" c JOIN "Document" d ON d.id = c."documentId"
                WHERE c."kbId" = ANY(%s::uuid[]) AND c.embedding IS NOT NULL
                  AND d.status = 'published')::float,
              (SELECT count(*) FROM "Chunk" WHERE embedding IS NOT NULL)::float
            """,
            (kb_scope,),
        )
        filtered, total = cur.fetchone()
        self.conn.commit()
        return (filtered or 0) / max(total or 1, 1)


def evaluate(args) -> dict[str, Any]:
    conn = connect(args.database_url)
    try:
        evaluator = AnnEvaluator(conn, schema=args.schema)
        queries = evaluator.sample_queries(args.limit, args.kb)
        if not queries:
            raise SystemExit("no embedded chunks found; nothing to evaluate")

        # Gold once per query, reused by every configuration.
        golds: list[tuple[dict[str, Any], list[str], float]] = []
        bucket_counts: dict[str, int] = {}
        for query in queries:
            scope = [query["kbId"]]
            gold, exact_ms, _ = evaluator.knn(scope, query["embedding"], args.k, exact=True)
            golds.append((query, gold, exact_ms))
            bucket = selectivity_bucket(evaluator.filter_ratio(scope))
            bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1

        configurations = [{"name": "exact_knn(gold)", "exact": True}]
        for ef in args.ef_search:
            for scan in args.iterative_scan:
                configurations.append(
                    {
                        "name": f"ann ef_search={ef} iterative_scan={scan}",
                        "exact": False,
                        "ef_search": ef,
                        "iterative_scan": scan,
                    }
                )

        report: dict[str, Any] = {
            "database": parse_dsn(args.database_url)["database"],
            "k": args.k,
            "queries": len(queries),
            "schema": args.schema or "public",
            "selectivity_buckets": bucket_counts,
            "configurations": [],
        }

        for config in configurations:
            recalls: list[float] = []
            latencies: list[float] = []
            rows_returned: list[int] = []
            per_bucket: dict[str, list[float]] = {}
            for query, gold, exact_ms in golds:
                scope = [query["kbId"]]
                if config["exact"]:
                    system, latency, rows = gold, exact_ms, len(gold)
                else:
                    system, latency, rows = evaluator.knn(
                        scope,
                        query["embedding"],
                        args.k,
                        exact=False,
                        ef_search=config["ef_search"],
                        iterative_scan=config["iterative_scan"],
                    )
                value = recall_at_k(gold, system)
                recalls.append(value)
                latencies.append(latency)
                rows_returned.append(rows)
                bucket = selectivity_bucket(evaluator.filter_ratio(scope))
                per_bucket.setdefault(bucket, []).append(value)
            report["configurations"].append(
                {
                    "configuration": config["name"],
                    "recall_at_k_mean": round(statistics.fmean(recalls), 4),
                    "recall_at_k_min": round(min(recalls), 4),
                    "perfect_recall_share": round(
                        len([r for r in recalls if r >= 0.999]) / len(recalls), 4
                    ),
                    "rows_returned_mean": round(statistics.fmean(rows_returned), 2),
                    "short_result_share": round(
                        len([r for r in rows_returned if r < args.k]) / len(rows_returned), 4
                    ),
                    "latency_ms_p50": round(percentile(latencies, 50), 2),
                    "latency_ms_p95": round(percentile(latencies, 95), 2),
                    "by_selectivity": {
                        bucket: round(statistics.fmean(values), 4)
                        for bucket, values in sorted(per_bucket.items())
                    },
                }
            )

        report["gate"] = {
            "target_recall_at_k": args.target_recall,
            "passes": all(
                entry["recall_at_k_mean"] >= args.target_recall
                for entry in report["configurations"]
                if not entry["configuration"].startswith("exact")
            ),
        }
        return report
    finally:
        conn.close()


def selftest() -> int:
    """Verify the metric maths without a database."""
    assert recall_at_k(["a", "b", "c"], ["a", "b", "x"]) == 2 / 3
    assert recall_at_k(["a"], ["a"]) == 1.0
    assert recall_at_k(["a"], ["b"]) == 0.0
    assert recall_at_k([], ["a"]) == 0.0
    assert vector_literal([1, 2]) == "[1.000000,2.000000]"
    assert vector_literal("[1,2]") == "[1,2]"
    assert percentile([1.0, 2.0, 3.0, 4.0], 50) == 3.0
    assert parse_dsn("postgresql://u:p@h:5433/db")["port"] == 5433
    assert selectivity_bucket(0.01) == "selective(<5%)"
    print("ann_recall_eval selftest OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Filtered HNSW recall vs exact KNN")
    parser.add_argument("--database-url", default=DEFAULT_DATABASE_URL)
    parser.add_argument("--limit", type=int, default=100, help="number of query vectors")
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--kb", default=None, help="restrict sampling to one knowledge base")
    parser.add_argument(
        "--schema",
        default=None,
        help="run against an isolated benchmark schema instead of the application schema",
    )
    parser.add_argument("--ef-search", type=int, nargs="+", default=[40, 100, 200])
    parser.add_argument(
        "--iterative-scan",
        nargs="+",
        default=["off", "relaxed_order"],
        choices=["off", "relaxed_order", "strict_order"],
    )
    parser.add_argument("--target-recall", type=float, default=0.98)
    parser.add_argument("--out", default=None, help="write the JSON report here")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    report = evaluate(args)
    text = json.dumps(report, indent=2, ensure_ascii=False)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0 if report["gate"]["passes"] else 1


if __name__ == "__main__":
    sys.exit(main())
