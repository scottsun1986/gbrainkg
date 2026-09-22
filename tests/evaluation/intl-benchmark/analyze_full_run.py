#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Per-question failure taxonomy for a `--mode full` result artifact.

Answers one question the aggregate metrics cannot: *where* the pipeline lost
the case. Every case is bucketed by (evidence retrieved? x answer contains
gold?) so retrieval-side gaps are never confused with generation-side gaps,
and the generated text is scanned for output-hygiene defects that aggregate
scores hide (raw model reasoning leaking into the answer, upstream provider
error strings surfaced as an answer, empty answers).

Usage:
    python3 analyze_full_run.py results/intl-2wiki-20260920-173651.json
    python3 analyze_full_run.py results/intl-*.json --examples 5
"""

import argparse
import glob
import json
import re
from collections import Counter

# Text that only appears when a model's planning/reasoning stream is surfaced
# as the user-visible answer. Kept generic (no domain vocabulary).
REASONING_LEAK_PATTERNS = (
    r"\bhmm[,\s]",
    r"\blet'?s break (this|it) down\b",
    r"\bwe need to (figure|find|determine|identify)\b",
    r"\bthe user (is asking|asks|wants to know)\b",
    r"\bstep[- ]by[- ]step\b",
    r"\bi need to (find|check|look)\b",
    r"\bokay,?\s+(so\s+)?(the\s+)?(user|question)\b",
    r"^\s*(thinking|thought)\s*[:：]",
    r"我们需要先",
    r"用户的问题是",
    r"让我们(一步步|逐步)",
)

# Upstream provider / transport failures that must never reach a user as prose.
PROVIDER_ERROR_PATTERNS = (
    r"\brequest was rejected\b",
    r"\bconsidered high[- ]risk\b",
    r"\brate limit (reached|exceeded|hit)\b",
    r"\btoo many requests\b",
    r"\binsufficient (balance|quota|credit)\b",
    r"\bcontext length exceeded\b",
    r"\b(internal server error|service unavailable|bad gateway|gateway timeout)\b",
    r"\bmodel not found\b",
    r"请求被拒绝",
    r"触发限流",
)

LEAK_RE = re.compile("|".join(REASONING_LEAK_PATTERNS), re.I)
ERR_RE = re.compile("|".join(PROVIDER_ERROR_PATTERNS), re.I)


def analyse(path, examples=3):
    run = json.load(open(path, encoding="utf-8"))
    qa = {c["qid"]: c for c in run.get("detail_qa") or []}
    ret = {c["qid"]: c for c in run.get("detail_retrieval") or []}
    buckets = Counter()
    leaks, errors, empties, refusals = [], [], [], []

    for qid, case in qa.items():
        answer = case.get("answer") or ""
        evidence_ok = (ret.get(qid, {}).get("full_evidence", 0) or 0) > 0
        answer_ok = (case.get("containment") or 0) > 0
        buckets[("evidence" if evidence_ok else "no_evidence",
                 "answer" if answer_ok else "no_answer")] += 1
        if not answer.strip():
            empties.append(qid)
        if case.get("refusal") or (ret.get(qid, {}).get("refusal")):
            refusals.append(qid)
        if LEAK_RE.search(answer):
            leaks.append(qid)
        if ERR_RE.search(answer):
            errors.append(qid)

    total = len(qa)
    print(f"\n=== {path} ===")
    print(f"dataset={run.get('dataset')} n={run.get('n')} mode={run.get('mode')} "
          f"generated_at={run.get('generated_at')}")
    print(f"retrieval: {json.dumps(run.get('retrieval'), ensure_ascii=False)}")
    print(f"qa       : {json.dumps(run.get('qa'), ensure_ascii=False)}")
    print(f"\n-- (evidence retrieved?) x (gold in answer?)  [n={total}] --")
    for (ev, ans) in (("evidence", "answer"), ("evidence", "no_answer"),
                      ("no_evidence", "answer"), ("no_evidence", "no_answer")):
        count = buckets[(ev, ans)]
        pct = (count / total * 100) if total else 0
        label = "完整证据" if ev == "evidence" else "证据缺失"
        outcome = "答案正确" if ans == "answer" else "答案错误"
        print(f"  {label:6s} + {outcome:6s}: {count:4d}  ({pct:5.1f}%)")

    gen_side = buckets[("evidence", "no_answer")]
    ret_side = buckets[("no_evidence", "no_answer")]
    if gen_side + ret_side:
        share = gen_side / (gen_side + ret_side) * 100
        print(f"  -> 失败构成: 生成侧 {gen_side} ({share:.0f}%) / 检索侧 {ret_side} "
              f"({100 - share:.0f}%)")

    print(f"\n-- 输出卫生 / 兜底 --")
    print(f"  推理文本外泄 (raw reasoning in answer): {len(leaks)}")
    print(f"  上游报错当答案 (provider error text)  : {len(errors)}")
    print(f"  空答案                               : {len(empties)}")
    print(f"  拒答                                 : {len(refusals)}")
    for label, qids in (("推理外泄", leaks), ("报错当答案", errors),
                        ("空答案", empties)):
        for qid in qids[:examples]:
            answer = (qa[qid].get("answer") or "").strip().replace("\n", " ")
            print(f"    [{label}] {qid} :: {answer[:160]}")
    return buckets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--examples", type=int, default=3)
    args = parser.parse_args()
    files = []
    for pattern in args.paths:
        files.extend(sorted(glob.glob(pattern)) or [pattern])
    for path in files:
        analyse(path, args.examples)


if __name__ == "__main__":
    main()
