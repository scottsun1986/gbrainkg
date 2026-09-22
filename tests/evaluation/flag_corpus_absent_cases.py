#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mark golden cases whose expected documents are absent from this environment.

Why: the golden set was authored for a corpus that includes
`特种设备检验规程.pdf` and `2026年度培训计划.pptx`, but this environment never ingested
them (the repository's own acceptance report from 2026-09-12 says the same:
"30 题期望文档在本环境不存在 … 非系统缺陷"). Both evaluation suites therefore reported
those 30 cases as failures — the chat suite scored `long_doc_completeness` and
`scan_ocr_ppt` at 0.000, and the retrieval harness deflated hit@5 from 1.000 to 0.842 —
even though no retriever or generator could have answered them.

This script checks each case's `expected_doc_titles` against the published corpus and
sets `corpus_absent: true` on the cases whose gold document is not present, so both
suites can report the answerable subset and keep the missing ones visible as a
corpus gap. Re-run it after ingesting the missing documents (it clears the flag again).

Usage:
    DATABASE_URL=postgresql://... python3 flag_corpus_absent_cases.py [--dataset golden_dataset.json]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
from pathlib import Path

BASE = Path(__file__).parent
sys.path.insert(0, str(BASE))
from enterprise_retrieval_eval import load_corpus_titles, normalize_title  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Flag cases whose gold documents are absent")
    parser.add_argument("--dataset", type=Path, default=BASE / "golden_dataset.json")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""))
    args = parser.parse_args()

    if not args.database_url:
        raise SystemExit("DATABASE_URL (or --database-url) is required")
    corpus = load_corpus_titles(args.database_url)
    if corpus is None:
        raise SystemExit("could not read the corpus title list")

    cases = json.loads(args.dataset.read_text(encoding="utf-8"))
    flagged: list[str] = []
    cleared: list[str] = []
    for case in cases:
        expected = [normalize_title(title) for title in (case.get("expected_doc_titles") or [])]
        absent = bool(expected) and not any(title in corpus for title in expected)
        if absent and not case.get("corpus_absent"):
            case["corpus_absent"] = True
            flagged.append(str(case.get("id")))
        elif not absent and case.get("corpus_absent"):
            case.pop("corpus_absent", None)
            cleared.append(str(case.get("id")))

    args.dataset.write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    total_flagged = sum(1 for case in cases if case.get("corpus_absent"))
    print(f"dataset: {args.dataset.name}  cases: {len(cases)}  corpus_absent: {total_flagged}")
    if flagged:
        print(f"  newly flagged ({len(flagged)}): {', '.join(flagged[:8])}{' …' if len(flagged) > 8 else ''}")
    if cleared:
        print(f"  cleared ({len(cleared)}): {', '.join(cleared[:8])}{' …' if len(cleared) > 8 else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
