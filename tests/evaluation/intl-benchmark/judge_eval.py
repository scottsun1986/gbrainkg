#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对 run_eval 的问答结果做 LLM-judge 正确性判定(correct/partial/incorrect/refusal)。

判定模型 deepseek-chat temperature 0,输出严格 JSON。
注意:判定模型与生成模型同为 deepseek 家族,存在 self-preference 风险,报告需注明。
"""
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from glob import glob
from pathlib import Path

import requests

BASE = Path(__file__).parent
URL = "https://api.deepseek.com/v1/chat/completions"
KEY = os.environ.get("DEEPSEEK_API_KEY", "")
WORKERS = 4

PROMPT = """You are a strict QA grader. Compare the system's answer against the gold reference for a multi-hop question.

Rules:
- "correct": the system answer conveys the gold answer's key fact (entities/values/yes-no) correctly, even if phrased differently or with extra explanation.
- "partial": the answer contains the key fact but with material errors, or answers only part of a multi-part question.
- "incorrect": the answer contradicts the gold or asserts something different.
- "refusal": the system declined to answer / said it lacks the information.

Question: {q}
Gold reference: {g}
System answer: {a}

Reply with JSON only: {{"verdict": "correct|partial|incorrect|refusal", "reason": "<=20 words"}}"""


def judge(q, g, a):
    resp = requests.post(URL, headers={"Authorization": f"Bearer {KEY}"},
                         json={"model": "deepseek-chat", "temperature": 0,
                               "response_format": {"type": "json_object"},
                               "messages": [{"role": "user",
                                             "content": PROMPT.format(q=q, g=g, a=a[:4000])}]},
                         timeout=120)
    resp.raise_for_status()
    m = re.search(r'\{.*\}', resp.json()["choices"][0]["message"]["content"], re.S)
    return json.loads(m.group(0))


def main(path):
    data = json.load(open(path))
    rows = data["detail_qa"]
    score_map = {"correct": 1.0, "partial": 0.5, "incorrect": 0.0, "refusal": 0.0}

    def run(r):
        if r["error"] or not (r["answer"] or "").strip():
            return {**r, "judge_verdict": "incorrect", "judge_reason": "empty/errored answer", "judge_score": 0.0}
        for attempt in range(3):
            try:
                v = judge(r["question"], r["gold"], r["answer"])
                return {**r, "judge_verdict": v.get("verdict", "incorrect"),
                        "judge_reason": str(v.get("reason", ""))[:120],
                        "judge_score": score_map.get(v.get("verdict"), 0.0)}
            except Exception as e:
                if attempt == 2:
                    return {**r, "judge_verdict": "judge_error", "judge_reason": str(e)[:120], "judge_score": 0.0}
                time.sleep(3)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        rows2 = list(ex.map(run, rows))
    n = len(rows2)
    summary = {
        "judge_accuracy": round(sum(r["judge_score"] for r in rows2) / n, 4),
        "judge_strict_accuracy": round(sum(1 for r in rows2 if r["judge_verdict"] == "correct") / n, 4),
        "verdicts": {v: sum(1 for r in rows2 if r["judge_verdict"] == v) for v in
                     ("correct", "partial", "incorrect", "refusal", "judge_error")},
        "judge_model": "deepseek-chat",
    }
    data["qa"]["llm_judge"] = summary
    data["detail_qa_judged"] = rows2
    out = path.replace(".json", "-judged.json")
    open(out, "w").write(json.dumps(data, ensure_ascii=False, indent=1))
    print(out)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    for p in sys.argv[1:] or [sorted(glob(str(BASE / "results" / "intl-*-*.json")))[-1]]:
        main(p)
