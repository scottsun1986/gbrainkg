#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LLM re-grade of saved answer artefacts.

Why this exists
---------------
`containment` is a strict substring test on normalised text. Measured on the
MuSiQue hard probe (2026-09-21) it flipped on three kinds of *wording* rather
than capability:

  * the same answer written in a different word order
    ("counties of Lithuania" vs "Lithuania's 10 counties"),
  * a named entity with an extra middle name,
  * a gold answer carrying an alias in brackets.

Those flips are noise on top of the noise already documented for n=100 runs, so
an A/B can look flat (or negative) while the system genuinely improved. This
script re-reads a saved run and asks a judge model a single, narrow question:
*does the prediction answer the question, given the gold answer?* It never
looks at the retrieval, so it cannot be gamed by changing the corpus, and it
writes a new file instead of mutating the original artefact.

Usage:
    export DEEPSEEK_API_KEY=sk-...
    python3 regrade_answers.py results/intl-musique-<ts>.json --out /tmp/graded.json
"""

import argparse
import json
import os
import re
import time
import urllib.request
from pathlib import Path

API_BASE = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
MODEL = os.environ.get("JUDGE_MODEL", os.environ.get("LLM_MODEL", "deepseek-chat"))

SYSTEM = (
    "You grade question-answering outputs. You are given a question, the gold "
    "answer, and a candidate answer. Decide only whether the candidate answers "
    "the question with the same fact as the gold answer. "
    "Differences that must NOT count against the candidate: wording, word order, "
    "extra explanation, an extra middle name in a personal name, a bracketed "
    "alias expansion, units written differently, and additional true detail. "
    "Count against the candidate: a different fact, a missing required fact, a "
    "refusal ('not recorded in the materials'), or a claim contradicted by the gold. "
    "Reply with exactly one word: CORRECT or INCORRECT."
)


def judge(question, gold, pred, key, timeout=60):
    user = f"Question: {question}\nGold answer: {gold}\nCandidate answer: {pred}"
    body = {
        "model": MODEL,
        "temperature": 0,
        "max_tokens": 8,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
        ],
    }
    req = urllib.request.Request(
        f"{API_BASE}/chat/completions",
        data=json.dumps(body).encode(),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {key}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode())
    text = (payload["choices"][0]["message"].get("content") or "").strip().upper()
    if "INCORRECT" in text:
        return 0.0
    if "CORRECT" in text:
        return 1.0
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("results", nargs="+")
    ap.add_argument("--out", help="write merged grades here (default: <input>.graded.json)")
    args = ap.parse_args()

    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not key:
        raise SystemExit("set DEEPSEEK_API_KEY (or OPENAI_API_KEY)")

    for path in args.results:
        data = json.load(open(path))
        rows = data.get("detail_qa") or []
        graded, failures = 0, 0
        t0 = time.time()
        for row in rows:
            ans = (row.get("answer") or "").strip()
            if row.get("error"):
                row["llm_correct"] = 0.0
                continue
            if not ans:
                row["llm_correct"] = 0.0
                continue
            try:
                verdict = judge(row["question"], row["gold"], ans, key)
            except Exception as exc:  # network/rate-limit: keep the row unscored
                failures += 1
                row["llm_correct"] = None
                row["llm_error"] = str(exc)[:120]
                continue
            if verdict is None:
                failures += 1
                row["llm_correct"] = None
                continue
            row["llm_correct"] = verdict
            graded += 1
        scored = [r["llm_correct"] for r in rows if r.get("llm_correct") is not None]
        summary = {
            "model": MODEL,
            "n": len(rows),
            "graded": len(scored),
            "ungraded": failures,
            "llm_correct": round(sum(scored) / len(scored), 4) if scored else None,
            "strict_containment": data.get("qa", {}).get("containment"),
            "alias_match": data.get("qa", {}).get("alias_match"),
            "seconds": round(time.time() - t0, 1),
        }
        if summary["graded"]:
            both = [r for r in rows
                    if r.get("llm_correct") is not None and r.get("containment") is not None]
            fp = [r["qid"] for r in both if r["llm_correct"] and not r["containment"]]
            fn = [r["qid"] for r in both if r["containment"] and not r["llm_correct"]]
            summary["strict_false_negative"] = len(fp)
            summary["strict_false_negative_qids"] = fp
            summary["strict_false_positive_qids"] = fn
        data["llm_grade"] = summary
        out = args.out or re.sub(r"\.json$", "", path) + ".graded.json"
        Path(out).write_text(json.dumps(data, ensure_ascii=False, indent=2))
        print(f"{path}\n  -> {out}\n  {json.dumps(summary, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
