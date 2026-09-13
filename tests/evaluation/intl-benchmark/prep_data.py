#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""构建国际基准评测集(HotpotQA / 2WikiMultiHopQA / MuSiQue)。

每数据集固定 seed=42 抽样 100 题;语料 = 抽样题目的 context 段落去重合并
(共享语料库,跨题干扰,接近 open-domain RAG 而非逐题 10 选 2)。
"""
import json
import random
import pandas as pd
from pathlib import Path

BASE = Path(__file__).parent
DATA = BASE / "data"
N = 100
SEED = 42


def norm_title(t):
    return " ".join(str(t).split())


def build_hotpot():
    df = pd.read_parquet(DATA / "hotpot_dev.parquet")
    df = df.sample(n=N, random_state=SEED).reset_index(drop=True)
    title2text, gold_prefer = {}, {}

    def put(title, sents, gold):
        t = norm_title(title)
        text = "".join(list(sents)).strip()
        if not t or not text:
            return
        if gold:
            # gold 文本优先于同名干扰段
            if t not in gold_prefer:
                gold_prefer[t] = text
        elif t not in gold_prefer and t not in title2text:
            title2text[t] = text

    questions = []
    for _, r in df.iterrows():
        ctx = r["context"]
        titles = list(ctx["title"])
        sent_lists = list(ctx["sentences"])
        gold_titles = sorted(set(norm_title(t) for t in r["supporting_facts"]["title"]))
        for t, ss in zip(titles, sent_lists):
            put(t, ss, norm_title(t) in gold_titles)
        questions.append({
            "qid": str(r["id"]),
            "question": str(r["question"]),
            "answer": str(r["answer"]),
            "gold_titles": gold_titles,
            "type": f'{r["type"]}/{r["level"]}',
        })
    corpus = {**title2text, **gold_prefer}
    return corpus, questions


def build_2wiki():
    df = pd.read_parquet(DATA / "2wiki_dev.parquet")
    df = df.sample(n=N, random_state=SEED).reset_index(drop=True)
    title2text, gold_prefer = {}, {}

    def put(title, sents, gold):
        t = norm_title(title)
        text = " ".join(list(sents)).strip()
        if not t or not text:
            return
        if gold:
            if t not in gold_prefer:
                gold_prefer[t] = text
        elif t not in gold_prefer and t not in title2text:
            title2text[t] = text

    questions = []
    for _, r in df.iterrows():
        ctx = json.loads(r["context"]) if isinstance(r["context"], str) else r["context"]
        gold_titles = sorted(set(norm_title(t) for t, _ in
                                 (json.loads(r["supporting_facts"]) if isinstance(r["supporting_facts"], str)
                                  else r["supporting_facts"])))
        for title, sents in ctx:
            put(title, sents, norm_title(title) in gold_titles)
        questions.append({
            "qid": str(r["_id"]),
            "question": str(r["question"]),
            "answer": str(r["answer"]),
            "gold_titles": gold_titles,
            "type": str(r["type"]),
        })
    corpus = {**title2text, **gold_prefer}
    return corpus, questions


def build_musique():
    rows = [json.loads(l) for l in open(DATA / "musique_dev.jsonl", encoding="utf-8")]
    rng = random.Random(SEED)
    rows = rng.sample(rows, N)
    title2text, gold_prefer = {}, {}
    questions = []
    for r in rows:
        paras = r["paragraphs"]
        gold_titles = []
        for p in paras:
            sup = str(p["is_supporting"]).strip().lower() == "true"
            t, text = norm_title(p["title"]), str(p["paragraph_text"]).strip()
            if not t or not text:
                continue
            if sup:
                gold_titles.append(t)
                if t not in gold_prefer:
                    gold_prefer[t] = text
            else:
                # 非支撑段按题随机保留 7 条作干扰,控制语料规模
                if rng.random() < 7.0 / max(1, len(paras) - sum(1 for q in paras if str(q["is_supporting"]).strip().lower() == "true")):
                    if t not in gold_prefer and t not in title2text:
                        title2text[t] = text
        questions.append({
            "qid": str(r["id"]),
            "question": str(r["question"]),
            "answer": str(r["answer"]),
            "gold_titles": sorted(set(gold_titles)),
            "type": f'{len(r["question_decomposition"])}-hop',
        })
    corpus = {**title2text, **gold_prefer}
    return corpus, questions


for name, fn in [("hotpot", build_hotpot), ("2wiki", build_2wiki), ("musique", build_musique)]:
    corpus, qs = fn()
    (BASE / "corpus" / f"{name}_corpus.json").write_text(
        json.dumps([{"title": t, "text": x} for t, x in sorted(corpus.items())], ensure_ascii=False, indent=1))
    (BASE / f"{name}_eval_set.json").write_text(json.dumps(qs, ensure_ascii=False, indent=1))
    gold_cov = sum(1 for q in qs if all(g in corpus for g in q["gold_titles"]))
    print(f"{name}: corpus={len(corpus)} paragraphs, questions={len(qs)}, gold-in-corpus={gold_cov}/{N}")
    from collections import Counter
    print("  types:", dict(Counter(q["type"] for q in qs)))
