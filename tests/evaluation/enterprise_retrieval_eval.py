#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Retrieval-path evaluation on the enterprise (Chinese) golden set.

Why this exists
---------------
The 220-case golden suite drives ``/api/v1/chat/completions``, i.e. the *chat* path.
Changes to the *agent search* path (``/api/v1/chat/search``: arm policy, LLM probes,
per-probe-group cross-encoder rerank) were therefore measurable only on English public
benchmarks — the enterprise corpus had no retrieval gold set at all, so a change that
helped HotpotQA could silently hurt Chinese policy documents.

The golden cases already carry ``expected_doc_titles`` (the document that answers the
question), which is exactly a retrieval gold. This harness scores the search path
against those titles and reports hit@k / MRR overall and per category, so both the
public benchmarks and the enterprise corpus can gate the same change.

Usage:
    python3 enterprise_retrieval_eval.py --label with-rerank
    RETRIEVAL_SEARCH_RERANK=false ... (restart API) ... --label without-rerank
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = Path(__file__).parent
RESULTS_DIR = BASE / "results"
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def normalize_title(value: str) -> str:
    """Case/extension/whitespace-insensitive title comparison."""
    text = str(value or "").strip().lower()
    text = re.sub(r"\.(docx?|pdf|xlsx?|pptx?|txt|md|csv|html?)$", "", text)
    text = re.sub(r"[\s\-_·．。()（）\[\]【】]+", "", text)
    return text


def load_corpus_titles(database_url: str | None) -> set[str] | None:
    """Normalised titles of every published document, or None when unavailable.

    A golden case whose expected document is not in the corpus at all cannot be
    retrieved by any retriever, so counting it as a retrieval miss understates the
    system. Measured example: 30 of the 190 enterprise cases expect
    "2026年度培训计划.pptx" / "特种设备检验规程.pdf", neither of which was ever
    ingested into this environment — that is a corpus gap, not a search failure.
    """
    if not database_url:
        return None
    try:
        import pg8000.dbapi  # type: ignore
    except Exception:  # noqa: BLE001 - optional dependency
        print("  (pg8000 not installed: corpus-presence check disabled)")
        return None
    try:
        parsed = urllib.parse.urlparse(database_url)
        connection = pg8000.dbapi.connect(
            user=urllib.parse.unquote(parsed.username or ""),
            password=urllib.parse.unquote(parsed.password or ""),
            host=parsed.hostname or "127.0.0.1",
            port=parsed.port or 5432,
            database=(parsed.path or "/").lstrip("/") or "llmwiki",
            timeout=30,
        )
        cursor = connection.cursor()
        cursor.execute("SELECT title FROM \"Document\" WHERE status = 'published'")
        titles = {normalize_title(row[0]) for row in cursor.fetchall()}
        connection.close()
        return titles
    except Exception as exc:  # noqa: BLE001 - never block the evaluation
        print(f"  (corpus-presence check unavailable: {str(exc)[:120]})")
        return None


def login(api_base: str, user: str, password: str) -> str:
    preset = os.environ.get("LLMWIKI_TOKEN") or os.environ.get("EVAL_BEARER_TOKEN")
    if preset:
        return preset
    body = json.dumps({"username": user, "password": password}).encode()
    request = urllib.request.Request(f"{api_base}/api/v1/auth/login", data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=30, context=CTX) as response:
        return json.loads(response.read().decode())["token"]


def search(api_base: str, token: str, query: str, limit: int, timeout: float) -> tuple[list[str], str | None]:
    body = json.dumps({"query": query, "limit": limit}).encode()
    request = urllib.request.Request(f"{api_base}/api/v1/chat/search", data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=CTX) as response:
            payload = json.loads(response.read().decode())
        titles = [str(item.get("title") or "") for item in (payload.get("results") or [])]
        return titles, None
    except Exception as exc:  # noqa: BLE001 - report, never abort the run
        return [], str(exc)[:160]


def main() -> int:
    parser = argparse.ArgumentParser(description="Enterprise retrieval evaluation (/chat/search)")
    parser.add_argument("--api-base", default=os.environ.get("API_BASE", "http://127.0.0.1:3202"))
    parser.add_argument("--dataset", type=Path, default=BASE / "golden_dataset.json")
    parser.add_argument("--user", default=os.environ.get("TEST_USER", "admin"))
    parser.add_argument("--password", default=os.environ.get("TEST_PASSWORD", "123456"))
    parser.add_argument("--limit", type=int, default=10, help="results requested per query")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--label", default="run")
    parser.add_argument("--out", type=Path)
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL", ""),
        help="PostgreSQL URL used to detect golden documents missing from the corpus",
    )
    parser.add_argument("--skip-corpus-check", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cases = [
        case for case in json.loads(args.dataset.read_text(encoding="utf-8"))
        if case.get("expected_doc_titles")
    ]
    if args.dry_run:
        print(f"{len(cases)} cases carry expected_doc_titles")
        return 0

    token = login(args.api_base, args.user, args.password)
    started = time.time()
    corpus = None if args.skip_corpus_check else load_corpus_titles(args.database_url)

    def evaluate(case: dict) -> dict:
        query = str(case.get("query") or "").strip()
        expected = [normalize_title(t) for t in case["expected_doc_titles"]]
        titles, error = search(args.api_base, token, query, args.limit, args.timeout)
        normalized = [normalize_title(t) for t in titles]
        rank = next((index + 1 for index, title in enumerate(normalized) if title in expected), None)
        return {
            "id": case.get("id"),
            "category": case.get("category"),
            "query": query,
            "expected": case["expected_doc_titles"],
            "returned": titles,
            "rank": rank,
            "error": error,
        }

    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for index, row in enumerate(pool.map(evaluate, cases), start=1):
            rows.append(row)
            if index % 25 == 0 or index == len(cases):
                print(f"  [{index}/{len(cases)}] evaluated", flush=True)

    # Cases whose gold document is absent from the corpus are reported separately:
    # they measure the corpus, not the retriever.
    for row in rows:
        expected = [normalize_title(title) for title in row["expected"]]
        row["corpus_missing"] = bool(corpus is not None and not any(title in corpus for title in expected))
    scored_rows = [row for row in rows if not row["corpus_missing"]]

    def metrics(items: list[dict]) -> dict:
        count = len(items)
        hits = {1: 0, 5: 0, 10: 0}
        reciprocal = 0.0
        for row in items:
            rank = row["rank"]
            if rank:
                if rank <= 1:
                    hits[1] += 1
                if rank <= 5:
                    hits[5] += 1
                if rank <= 10:
                    hits[10] += 1
                reciprocal += 1.0 / rank
        return {
            "count": count,
            "hit@1": hits[1] / count if count else 0.0,
            "hit@5": hits[5] / count if count else 0.0,
            "hit@10": hits[10] / count if count else 0.0,
            "mrr": reciprocal / count if count else 0.0,
        }

    total = len(rows)
    hits = {1: 0, 5: 0, 10: 0}
    reciprocal = 0.0
    for row in rows:
        rank = row["rank"]
        if rank:
            if rank <= 1:
                hits[1] += 1
            if rank <= 5:
                hits[5] += 1
            if rank <= 10:
                hits[10] += 1
            reciprocal += 1.0 / rank

    by_category: dict[str, dict] = {}
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in scored_rows:
        grouped[str(row["category"])].append(row)
    for category, items in sorted(grouped.items()):
        ranks = [row["rank"] for row in items if row["rank"]]
        by_category[category] = {
            "count": len(items),
            "hit@1": sum(1 for r in ranks if r <= 1) / len(items),
            "hit@5": sum(1 for r in ranks if r <= 5) / len(items),
            "hit@10": sum(1 for r in ranks if r <= 10) / len(items),
            "mrr": (sum(1.0 / r for r in ranks) / len(items)) if items else 0.0,
        }

    summary = {
        "label": args.label,
        "dataset": str(args.dataset.name),
        "limit": args.limit,
        "count": total,
        "corpus_checked": corpus is not None,
        "corpus_missing_cases": sum(1 for row in rows if row["corpus_missing"]),
        "scored": metrics(scored_rows),
        "errors": sum(1 for row in rows if row["error"]),
        "hit@1": hits[1] / total if total else 0.0,
        "hit@5": hits[5] / total if total else 0.0,
        "hit@10": hits[10] / total if total else 0.0,
        "mrr": reciprocal / total if total else 0.0,
        "wall_seconds": round(time.time() - started, 1),
        "by_category": by_category,
    }

    print(
        f"\n[{args.label}] n={total} (corpus-missing={summary['corpus_missing_cases']}, "
        f"scored={summary['scored']['count']}) errors={summary['errors']}\n"
        f"  all cases     hit@1={summary['hit@1']:.4f} hit@5={summary['hit@5']:.4f} "
        f"hit@10={summary['hit@10']:.4f} mrr={summary['mrr']:.4f}\n"
        f"  retrievable   hit@1={summary['scored']['hit@1']:.4f} hit@5={summary['scored']['hit@5']:.4f} "
        f"hit@10={summary['scored']['hit@10']:.4f} mrr={summary['scored']['mrr']:.4f} "
        f"({summary['wall_seconds']}s)"
    )
    for category, metrics in by_category.items():
        print(
            f"  {category:<24} n={metrics['count']:<3} hit@5={metrics['hit@5']:.3f} "
            f"hit@10={metrics['hit@10']:.3f} mrr={metrics['mrr']:.3f}"
        )

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = args.out or RESULTS_DIR / f"enterprise-retrieval-{args.label}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
