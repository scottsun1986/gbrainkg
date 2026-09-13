#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""闭卷基线:同一批问题,无检索直接问 LLM(deepseek-chat),衡量 RAG 增益参照线。

注意:系统 E2E 用的默认生成模型为 mygpt/gpt-5-6;闭卷基线走 .env 的
DeepSeek 直连(deepseek-chat),两条线不可直接比较,仅作"无检索 LLM"参照。
"""
import json
import os
import re
import string
import sys
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

BASE = Path(__file__).parent
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
KEY = os.environ.get("DEEPSEEK_API_KEY", "")
WORKERS = 4


def normalize_answer(s):
    def remove_articles(text):
        return re.sub(r"\b(a|an|the)\b", " ", text)
    return " ".join(remove_articles("".join(ch for ch in str(s).lower() if ch not in set(string.punctuation))).split())


def f1(pred, gold):
    pt, gt = normalize_answer(pred).split(), normalize_answer(gold).split()
    common = Counter(pt) & Counter(gt)
    n = sum(common.values())
    if not pt or not gt:
        return float(pt == gt)
    if n == 0:
        return 0.0
    p, r = n / len(pt), n / len(gt)
    return 2 * p * r / (p + r)


def em(pred, gold):
    return float(normalize_answer(pred) == normalize_answer(gold))


def ask(question):
    resp = requests.post(DEEPSEEK_URL, headers={"Authorization": f"Bearer {KEY}"},
                         json={"model": "deepseek-chat", "temperature": 0,
                               "messages": [
                                   {"role": "system", "content": "Answer the question directly and concisely. If unsure, give your best guess in a few words. Answer with the short answer only."},
                                   {"role": "user", "content": question}]},
                         timeout=120)
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


def main(dataset):
    if not KEY:
        print("DEEPSEEK_API_KEY missing; skip")
        return
    eval_set = json.load(open(BASE / f"{dataset}_eval_set.json"))

    def run(q):
        try:
            ans = ask(q["question"])
            err = None
        except Exception as e:
            ans, err = "", str(e)[:150]
        return {"qid": q["qid"], "gold": q["answer"], "answer": ans, "error": err,
                "em": em(ans, q["answer"]), "f1": f1(ans, q["answer"])}

    rows = []
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for r in ex.map(run, eval_set):
            rows.append(r)
    ok = [r for r in rows if not r["error"]]
    out = {"dataset": dataset, "n": len(eval_set), "errors": len(rows) - len(ok),
           "em": round(sum(r["em"] for r in ok) / len(ok), 4),
           "f1": round(sum(r["f1"] for r in ok) / len(ok), 4),
           "detail": rows, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    fp = BASE / "results" / f"closedbook-{dataset}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    fp.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(dataset, "closed-book EM:", out["em"], "F1:", out["f1"], "errors:", out["errors"])


if __name__ == "__main__":
    main(sys.argv[1])
