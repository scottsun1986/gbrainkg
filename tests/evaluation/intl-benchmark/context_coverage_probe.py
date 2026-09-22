#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Context-coverage probe: is the *gold answer text* actually inside the evidence
that was assembled for the model?

Why this exists
---------------
Answer containment is a noisy proxy: it moves with the model's phrasing, with
provider-side variation, and with refusal behaviour. Diagnosing the remaining
multi-hop gap that way produced three false leads in a row (see
docs/sota-evaluation-comprehensive-2026-09-20.md §13).

Context coverage is the deterministic half of the problem: given the same
retrieval and selection, the assembled context either contains the gold string
or it does not. Splitting the failures with it tells you *where* to work:

  gold in context + answer wrong  -> generation side
  gold not in context             -> retrieval/selection side

⚠️ Caveat learned the hard way (2026-09-21): for *short* golds — a bare year
("1978"), a city ("Rome"), a surname ("Tisch") — the gold string appears inside a
20k+ character context by chance, so "gold in context" is inflated and the
generation-side bucket is over-counted. Read this probe as an upper bound on
context coverage; for short golds require corroboration (e.g. the containing
sentence must also cover question terms) before believing a positive.

Requires the API to run with `CHAT_LOG_CONTEXT_PREVIEW=true`
(`CHAT_LOG_CONTEXT_PREVIEW_CHARS` controls how much of each source is logged).

Usage:
    python3 context_coverage_probe.py /tmp/genfail-musique.json --kb <kb_id> --limit 10
"""

import argparse
import json
import os
import re
import subprocess
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path


def norm(text: str) -> str:
    """Normalise for substring comparison (case, punctuation, dates, numbers)."""
    value = unicodedata.normalize("NFKD", str(text or "")).lower()
    value = re.sub(r"(?<=\d),(?=\d)", "", value)
    value = re.sub(r"[\u2013\u2014-]", " ", value)
    value = re.sub(r"[^0-9a-z\u4e00-\u9fa5]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def question_terms(question: str) -> list[str]:
    """Content terms of a question: Latin words >=4 chars plus CJK bigrams."""
    text = str(question or "").lower()
    stop = {
        "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "the",
        "and", "or", "of", "in", "on", "at", "to", "for", "with", "by", "from", "that",
        "this", "is", "was", "were", "are", "be", "did", "do", "does", "has", "have",
    }
    terms = {w for w in re.findall(r"[a-z][a-z'-]{3,}", text) if w not in stop}
    cjk = "".join(re.findall(r"[\u4e00-\u9fa5]+", str(question or "")))
    terms.update(cjk[i:i + 2] for i in range(len(cjk) - 1))
    return sorted(terms)


def gold_in_context(previews: list[str], gold: str, question: str) -> bool:
    """Is `gold` present in a context passage that also speaks to the question?

    Short golds ("1978", "Rome", "Tisch") otherwise match by chance inside 20k+
    characters of context, which inflated the "generation side" bucket and sent
    three consecutive experiments in the wrong direction. For golds under 15
    characters we therefore require sentence-level corroboration: the sentence
    holding the gold must also cover at least two of the question's own terms.
    """
    gold_norm = norm(gold)
    if not gold_norm:
        return False
    joined = norm("\n".join(previews))
    if gold_norm not in joined:
        return False
    if len(gold_norm) >= 15:
        return True
    terms = question_terms(question)
    if not terms:
        return True
    for preview in previews:
        for sentence in re.split(r"(?<=[.!?。！？；;])\s+", preview):
            sentence_norm = norm(sentence)
            if gold_norm not in sentence_norm:
                continue
            hits = sum(1 for term in terms if norm(term) and norm(term) in sentence_norm)
            if hits >= 2:
                return True
    return False


def read_context_previews(since: datetime) -> list[str]:
    """Context lines the API logged for a request that started at `since`."""
    # `@epoch` instead of a formatted wall-clock stamp: the caller records
    # `datetime.now(timezone.utc)` while journalctl parses a bare stamp in LOCAL
    # time. On a UTC+8 host that mismatch made every read cover the previous
    # eight hours of logs (measured 2026-09-22: one request "returned" 12,229
    # context lines), which silently inflates "gold was in the context".
    stamp = f"@{int(since.timestamp())}"
    out = subprocess.run(
        ["journalctl", "--user", "-u", "llmwiki-api", "--since", stamp, "--no-pager"],
        capture_output=True, text=True,
    ).stdout
    return [line.split("::", 1)[-1].strip() for line in out.splitlines() if "CTX_PREVIEW" in line]


def read_pool_previews(since: datetime) -> list[str]:
    """Candidate-pool lines (`[POOL_TEXT] #n <title> :: <text>`), same time window.

    Splitting "gold is missing" into "never retrieved", "retrieved but not
    selected" and "selected but unused" matters: the three have completely
    different fixes (recall arm / relevance floor + guarantee / generation).
    Requires CHAT_LOG_POOL_PREVIEW=true and CHAT_LOG_POOL_TEXT=true.
    """
    stamp = f"@{int(since.timestamp())}"
    out = subprocess.run(
        ["journalctl", "--user", "-u", "llmwiki-api", "--since", stamp, "--no-pager"],
        capture_output=True, text=True,
    ).stdout
    return [line.split("::", 1)[-1].strip() for line in out.splitlines() if "POOL_TEXT]" in line]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("cases", help="JSON list with question/answer (gold) fields")
    parser.add_argument("--kb", help="kb_scope to pin (defaults to all authorised KBs)")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--sleep", type=float, default=1.0, help="settle time before reading logs")
    parser.add_argument("--pool", action="store_true",
                        help="also read [POOL_TEXT] lines and report gold_in_pool "
                             "(needs CHAT_LOG_POOL_PREVIEW+CHAT_LOG_POOL_TEXT)")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    cases = json.load(open(args.cases, encoding="utf-8"))[: args.limit]
    token = Path("/tmp/llmwiki-eval-token").read_text().strip()
    rows = []
    for case in cases:
        question, gold = case["question"], str(case["answer"])
        started = datetime.now(timezone.utc)
        cmd = ["python3", "repro_chat.py", "--question", question, "--json-out", "/tmp/ccp-run.json"]
        if args.kb:
            cmd += ["--kb", args.kb]
        env = dict(os.environ, LLMWIKI_TOKEN=token)
        subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=600)
        answer = json.load(open("/tmp/ccp-run.json"))["answer"]
        time.sleep(args.sleep)
        previews = read_context_previews(started)
        pool = read_pool_previews(started) if args.pool else []
        context = norm("\n".join(previews))
        gold_norm = norm(gold)
        in_context = gold_in_context(previews, gold, question)
        in_pool = (gold_in_context(pool, gold, question) if args.pool else None)
        correct = gold_norm in norm(answer)
        rows.append({
            "qid": case.get("qid"), "question": question, "gold": gold,
            "sources": len(previews), "gold_in_context": in_context,
            "pool_items": len(pool), "gold_in_pool": in_pool, "correct": correct,
            "answer": answer[:400],
        })
        print(
            f"  {str(case.get('qid')):24s} sources={len(previews):2d} "
            + (f"pool={in_pool!s:5s} " if args.pool else "")
            + f"gold_in_context={in_context!s:5s} correct={correct!s:5s} | {question[:60]}",
            flush=True,
        )

    n = len(rows)
    in_ctx = sum(1 for r in rows if r["gold_in_context"])
    correct = sum(1 for r in rows if r["correct"])
    both = sum(1 for r in rows if r["gold_in_context"] and r["correct"])
    print(
        f"\nn={n}  gold 在上下文: {in_ctx} ({in_ctx / n:.2f}) | 答案正确: {correct} ({correct / n:.2f})"
        f"\n  -> 上下文有 gold 且答对: {both}"
        f"\n  -> 上下文有 gold 但答错: {in_ctx - both} (生成侧)"
        f"\n  -> 上下文没有 gold: {n - in_ctx} (检索/选择侧)"
    )
    if args.pool:
        pool = sum(1 for r in rows if r["gold_in_pool"])
        pool_not_ctx = sum(1 for r in rows if r["gold_in_pool"] and not r["gold_in_context"])
        print(
            f"  gold 在候选池: {pool} ({pool / n:.2f})"
            f"\n    -> 池里有但没进上下文: {pool_not_ctx} (选择侧：地板/保底/预算)"
            f"\n    -> 池里也没有: {n - pool} (检索侧：召回臂)"
        )
    if args.out:
        json.dump(rows, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
