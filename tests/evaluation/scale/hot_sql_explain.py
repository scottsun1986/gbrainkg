#!/usr/bin/env python3
"""EXPLAIN ANALYZE the three hot retrieval SQL shapes used in production.

Shapes (mirroring retrieval-arms.ts / lexical-index-store.ts):
  1. filtered vector KNN (HNSW)
  2. exact vector KNN (seqscan gold)
  3. lexical GIN + ts_rank_cd candidates

Usage:
  python3 hot_sql_explain.py --schema scale_bench --out report.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
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


def fetch_one(conn, sql: str, params: tuple = ()) -> tuple:
    cur = conn.cursor()
    cur.execute(sql, params)
    row = cur.fetchone()
    conn.commit()
    return row


def parse_explain(text: str) -> dict[str, Any]:
    times = [float(x) for x in re.findall(r"actual time=([\d.]+)\.\.([\d.]+)", text) for x in x]
    # Prefer the root node's total time (last "actual time=a..b" on the top plan).
    root = re.search(r"actual time=([\d.]+)\.\.([\d.]+)", text)
    total_ms = None
    for match in re.finditer(r"actual time=([\d.]+)\.\.([\d.]+)", text):
        total_ms = float(match.group(2))
    planning = re.search(r"Planning Time: ([\d.]+) ms", text)
    execution = re.search(r"Execution Time: ([\d.]+) ms", text)
    return {
        "planning_ms": float(planning.group(1)) if planning else None,
        "execution_ms": float(execution.group(1)) if execution else None,
        "root_actual_ms": total_ms,
        "uses_hnsw": "hnsw" in text.lower() or "Hnsw" in text,
        "uses_seq_scan": "Seq Scan" in text,
        "uses_gin": "gin" in text.lower() or "Bitmap Index Scan" in text,
        "node_hits": len(re.findall(r"actual rows=", text)),
    }


def run_explain(conn, label: str, sql: str, params: tuple, *, setup: list[str] | None = None) -> dict:
    if setup:
        cur = conn.cursor()
        for statement in setup:
            cur.execute(statement)
        conn.commit()
    cur = conn.cursor()
    started = time.perf_counter()
    cur.execute("EXPLAIN (ANALYZE, BUFFERS, VERBOSE) " + sql, params)
    rows = cur.fetchall()
    wall_ms = (time.perf_counter() - started) * 1000.0
    conn.commit()
    plan = "\n".join(str(r[0]) for r in rows)
    summary = parse_explain(plan)
    summary.update(
        {
            "label": label,
            "wall_ms_including_explain": round(wall_ms, 2),
            "sql": " ".join(sql.split()),
            "plan": plan,
        }
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="EXPLAIN ANALYZE hot retrieval SQL")
    parser.add_argument("--database-url", default=DEFAULT_DATABASE_URL)
    parser.add_argument("--schema", default=None)
    parser.add_argument("--kb", default=None, help="optional kbId filter")
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--ef-search", type=int, default=100)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    conn = connect(args.database_url, args.schema)
    try:
        vec_row = fetch_one(
            conn,
            """
            SELECT c.embedding::text, c."kbId"::text
            FROM "Chunk" c
            JOIN "Document" d ON d.id = c."documentId"
            WHERE c.embedding IS NOT NULL AND d.status = 'published'
            ORDER BY md5(c.id::text) LIMIT 1
            """,
        )
        if not vec_row:
            raise SystemExit("no embedded chunk found")
        embedding, sampled_kb = vec_row
        kb = args.kb or sampled_kb

        lex_row = fetch_one(
            conn,
            """
            SELECT coalesce(min(term), '制度')
            FROM "LexicalTermStat"
            WHERE "kbId" = %s::uuid AND df BETWEEN 5 AND 5000
            """,
            (kb,),
        )
        term = lex_row[0] if lex_row and lex_row[0] else "制度"

        vector_sql = """
            SELECT c.id::text
            FROM "Chunk" c
            JOIN "Document" d ON d.id = c."documentId"
            WHERE c."kbId" = %s::uuid
              AND c.embedding IS NOT NULL
              AND d.status = 'published'
            ORDER BY c.embedding <=> %s::vector
            LIMIT %s
        """
        lexical_sql = """
            SELECT l."chunkId"::text, ts_rank_cd(l."tsv", q.tsq) AS rank
            FROM "ChunkLexicalDoc" l
            JOIN "Document" d ON d.id = l."documentId"
            CROSS JOIN (SELECT lexical_tsquery(ARRAY[%s]) AS tsq) q
            WHERE q.tsq IS NOT NULL
              AND l."kbId" = ANY(ARRAY[%s]::uuid[])
              AND d.status = 'published'
              AND l."tsv" @@ q.tsq
            ORDER BY rank DESC, l."chunkId"
            LIMIT %s
        """

        report = {
            "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "schema": args.schema or "public",
            "kb_id": kb,
            "sample_term": term,
            "k": args.k,
            "queries": [],
        }

        report["queries"].append(
            run_explain(
                conn,
                "hot1_filtered_hnsw_knn",
                vector_sql,
                (kb, embedding, args.k),
                setup=[
                    f"SET LOCAL hnsw.ef_search = {int(args.ef_search)}",
                ],
            )
        )
        # enable_indexscan=off cannot be SET LOCAL outside a txn block reliably
        # through this driver; use a session-level toggle and restore after.
        report["queries"].append(
            run_explain(
                conn,
                "hot2_exact_knn_seqscan",
                vector_sql,
                (kb, embedding, args.k),
                setup=[
                    "SET enable_indexscan = off",
                    "SET enable_bitmapscan = off",
                ],
            )
        )
        cur = conn.cursor()
        cur.execute("SET enable_indexscan = on")
        cur.execute("SET enable_bitmapscan = on")
        conn.commit()

        report["queries"].append(
            run_explain(
                conn,
                "hot3_lexical_gin_tsrank",
                lexical_sql,
                (f"lex:{term}", kb, args.k),
            )
        )

        text = json.dumps(report, indent=2, ensure_ascii=False)
        print(
            json.dumps(
                {
                    "timestamp_utc": report["timestamp_utc"],
                    "schema": report["schema"],
                    "kb_id": report["kb_id"],
                    "sample_term": report["sample_term"],
                    "summaries": [
                        {k: v for k, v in q.items() if k != "plan"} for q in report["queries"]
                    ],
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        if args.out:
            with open(args.out, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
