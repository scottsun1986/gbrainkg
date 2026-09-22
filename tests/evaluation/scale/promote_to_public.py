#!/usr/bin/env python3
"""Promote an isolated scale_bench corpus into public under a dedicated KB.

Creates (or reuses) the KnowledgeBase `scale-bench-100k`, then bulk-copies
Document / Chunk / ChunkLexicalDoc / LexicalTermStat / KbLexicalStat rows so
the real API (`/api/v1/chat/search`) can retrieve at 100k scale with
hybrid+rerank.

IDs are rewritten with a SCALE100K namespace so the copy is idempotent and
the cleanup script can delete it by prefix.

Usage:
  python3 promote_to_public.py --from-schema scale_bench --kb-name scale-bench-100k
  python3 promote_to_public.py --cleanup
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request
import ssl
from typing import Any

DEFAULT_DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://llmwiki:llmwiki_pass@localhost:5433/llmwiki",
)
API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:3202")
USER = os.environ.get("LLMWIKI_USER", "admin")
PASSWORD = os.environ.get("LLMWIKI_PASS", "123456")

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

# Fixed namespace for rewritten ids: 5c41e000-... (ASCII-ish "SCALE")
DOC_PREFIX = "5c41e000-d0c0-4e00-8000-"
CHUNK_PREFIX = "5c41e000-c40c-4e00-8000-"
SOURCE_KB_PREFIX = "11111111-1111-4111-8111-"


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


def connect(dsn: str):
    import pg8000.dbapi

    return pg8000.dbapi.connect(**parse_dsn(dsn), timeout=120)


def api_login() -> str:
    req = urllib.request.Request(
        f"{API_BASE}/api/v1/auth/login",
        data=json.dumps({"username": USER, "password": PASSWORD}).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30, context=CTX) as resp:
        return json.loads(resp.read().decode())["token"]


def api_json(path: str, token: str, body: dict | None = None, method: str = "POST") -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API_BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60, context=CTX) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"{method} {path} -> HTTP {exc.code}: {exc.read().decode()[:500]}") from exc


def ensure_kb(token: str, name: str) -> str:
    listed = api_json("/api/v1/admin/kbs", token, method="GET")
    # admin GET returns various shapes; fall back to raw SQL lookup via caller.
    return name  # actual id resolved in SQL


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url", default=DEFAULT_DATABASE_URL)
    parser.add_argument("--from-schema", default="scale_bench")
    parser.add_argument("--kb-name", default="scale-bench-100k")
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    conn = connect(args.database_url)
    cur = conn.cursor()
    stats: dict[str, Any] = {
        "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "from_schema": args.from_schema,
        "kb_name": args.kb_name,
    }

    if args.cleanup:
        cur.execute(
            """
            DELETE FROM "Document" WHERE "kbId" IN (
              SELECT id FROM "KnowledgeBase" WHERE name = %s
            )
            """,
            (args.kb_name,),
        )
        cur.execute("DELETE FROM \"KnowledgeBase\" WHERE name = %s", (args.kb_name,))
        conn.commit()
        stats["cleaned"] = True
        print(json.dumps(stats, indent=2))
        return 0

    token = api_login()
    stats["api_login"] = "ok"

    # Reuse an existing bench KB or create one via the real admin API.
    cur.execute("SELECT id::text FROM \"KnowledgeBase\" WHERE name = %s", (args.kb_name,))
    row = cur.fetchone()
    if row:
        kb_id = row[0]
        stats["kb_action"] = "reused"
    else:
        created = api_json(
            "/api/v1/admin/kbs",
            token,
            {
                "name": args.kb_name,
                "type": "personal",
                "description": "SCALE100K isolated benchmark corpus (dev/test only)",
            },
        )
        kb_id = created["knowledgeBase"]["id"]
        stats["kb_action"] = "created"
    stats["kb_id"] = kb_id

    # Clear any previous promoted rows for this KB so the copy is idempotent.
    cur.execute("DELETE FROM \"Document\" WHERE \"kbId\" = %s::uuid", (kb_id,))
    conn.commit()

    started = time.perf_counter()

    # Documents: rewrite id/kbId, keep everything else. Title gets SCALE100K- prefix.
    cur.execute(
        f"""
        INSERT INTO "Document" (
          id, "kbId", "mdPath", title, "sourceType", "storageProvider", sensitivity,
          version, status, "indexReadiness", "createdAt", "updatedAt", "contentHash"
        )
        SELECT
          ('{DOC_PREFIX}' || substr(md5(d.id::text), 1, 12))::uuid,
          %s::uuid,
          '/synthetic/scale100k/' || d.id::text || '/content.md',
          'SCALE100K-' || d.title,
          'synthetic',
          'local',
          'internal',
          d.version,
          'published',
          'ready',
          now(), now(),
          'scale100k-' || d.id::text
        FROM "{args.from_schema}"."Document" d
        """,
        (kb_id,),
    )
    docs = cur.rowcount

    # Chunks: rewrite ids to stay unique in public, point at rewritten parents.
    cur.execute(
        f"""
        INSERT INTO "Chunk" (
          id, "documentId", "kbId", ord, content, "tokenCount",
          "charStart", "charEnd", metadata, embedding, "late_context",
          "hybrid_indexed", "parentChunkId", "contentHash"
        )
        SELECT
          ('{CHUNK_PREFIX}' || substr(md5(c.id::text), 1, 12))::uuid,
          ('{DOC_PREFIX}' || substr(md5(c."documentId"::text), 1, 12))::uuid,
          %s::uuid,
          c.ord, c.content, c."tokenCount", c."charStart", c."charEnd",
          c.metadata, c.embedding, false, false, NULL,
          'scale100k-' || c.id::text
        FROM "{args.from_schema}"."Chunk" c
        """,
        (kb_id,),
    )
    chunks = cur.rowcount

    # Lexical postings + term stats so hybrid (vector+BM25) is real.
    cur.execute(
        f"""
        INSERT INTO "ChunkLexicalDoc" ("chunkId", "kbId", "documentId", len, tsv, "updatedAt")
        SELECT
          ('{CHUNK_PREFIX}' || substr(md5(l."chunkId"::text), 1, 12))::uuid,
          %s::uuid,
          ('{DOC_PREFIX}' || substr(md5(l."documentId"::text), 1, 12))::uuid,
          l.len, l.tsv, now()
        FROM "{args.from_schema}"."ChunkLexicalDoc" l
        """,
        (kb_id,),
    )
    postings = cur.rowcount

    cur.execute(
        f"""
        INSERT INTO "LexicalTermStat" ("kbId", term, df, "updatedAt")
        SELECT %s::uuid, t.term, t.df, now()
        FROM "{args.from_schema}"."LexicalTermStat" t
        ON CONFLICT ("kbId", term) DO UPDATE SET df = EXCLUDED.df, "updatedAt" = now()
        """,
        (kb_id,),
    )
    terms = cur.rowcount

    cur.execute(
        f"""
        INSERT INTO "KbLexicalStat" ("kbId", "docCount", "totalLen", "statsVersion", "updatedAt")
        SELECT %s::uuid, s."docCount", s."totalLen", s."statsVersion", now()
        FROM "{args.from_schema}"."KbLexicalStat" s
        ON CONFLICT ("kbId") DO UPDATE
          SET "docCount" = EXCLUDED."docCount",
              "totalLen" = EXCLUDED."totalLen",
              "statsVersion" = EXCLUDED."statsVersion",
              "updatedAt" = now()
        """,
        (kb_id,),
    )
    conn.commit()

    # n_live_tup estimates + sizes
    cur.execute(
        """
        SELECT
          (SELECT count(*)::int FROM "Document" WHERE "kbId" = %s::uuid) AS docs,
          (SELECT count(*)::int FROM "Chunk" WHERE "kbId" = %s::uuid) AS chunks,
          (SELECT count(*)::int FROM "Chunk" WHERE "kbId" = %s::uuid AND embedding IS NOT NULL) AS embedded,
          (SELECT count(*)::int FROM "ChunkLexicalDoc" WHERE "kbId" = %s::uuid) AS postings
        """,
        (kb_id, kb_id, kb_id, kb_id),
    )
    counts = cur.fetchone()
    conn.commit()
    stats["promote_seconds"] = round(time.perf_counter() - started, 2)
    stats["inserted"] = {
        "documents": docs,
        "chunks": chunks,
        "postings": postings,
        "terms": terms,
    }
    stats["public_counts"] = {
        "documents": counts[0],
        "chunks": counts[1],
        "embedded": counts[2],
        "postings": counts[3],
    }
    stats["embedding_coverage"] = (
        round(counts[2] / counts[1], 4) if counts[1] else 0.0
    )

    text = json.dumps(stats, indent=2, ensure_ascii=False)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
