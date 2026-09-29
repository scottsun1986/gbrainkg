#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SOTA10 评测公共库:HTTP、登录、打分、任务包读写。

对齐 tests/evaluation/intl-benchmark/benchmark_suite.py 的判定口径:
- containment / alias / F1 / EM(引注剥离后) 与 ranking 指标(recall@k / mrr@10 / ndcg@10)。
"""
import hashlib
import json
import math
import os
import re
import ssl
import string
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

BASE = Path(__file__).parent
API = os.environ.get("API_BASE", "http://127.0.0.1:3202")
USER = os.environ.get("TEST_USER", "admin")
PASS = os.environ.get("TEST_PASSWORD", "123456")
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

REFUSALS = (
    "无法回答", "无法根据", "未包含", "没有找到", "无法从", "知识库中未", "不足以回答",
    "don't know", "cannot answer", "not enough information", "no relevant", "unable to answer",
    "无法确定", "抱歉", "not mentioned", "not provided", "does not contain", "cannot find",
    "not available", "not recorded", "no record",
)


def http(method, path, body=None, token=None, timeout=60, base=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base or API}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def login():
    preset = os.environ.get("LLMWIKI_TOKEN") or os.environ.get("EVAL_BEARER_TOKEN")
    if preset:
        return preset
    s, raw = http("POST", "/api/v1/auth/login", {"username": USER, "password": PASS})
    if s not in (200, 201):
        raise RuntimeError(f"Login failed ({s}): {raw}")
    return json.loads(raw)["token"]


# ---------------- answer normalization / scoring (same convention as suite) ----------------

def normalize_answer(s):
    def remove_articles(text):
        return re.sub(r"\b(a|an|the)\b", " ", text)
    def remove_punc(text):
        exclude = set(string.punctuation)
        return "".join(ch for ch in text if ch not in exclude)
    def white_space_fix(text):
        return " ".join(text.split())
    return white_space_fix(remove_articles(remove_punc(str(s).lower())))


def f1_score(pred, gold):
    pt, gt = normalize_answer(pred).split(), normalize_answer(gold).split()
    common = Counter(pt) & Counter(gt)
    num_same = sum(common.values())
    if len(pt) == 0 or len(gt) == 0:
        return float(pt == gt)
    if num_same == 0:
        return 0.0
    precision, recall = num_same / len(pt), num_same / len(gt)
    return 2 * precision * recall / (precision + recall)


def em_score(pred, gold):
    return float(normalize_answer(pred) == normalize_answer(gold))


def strip_citation_tags(answer):
    return re.sub(r"\[\d+\]", "", str(answer or ""))


def gold_variants(gold):
    base = str(gold or "").strip()
    if not base:
        return []
    variants = [base]
    collapsed = re.sub(r"\s*-\s*", "-", base)
    if collapsed != base:
        variants.append(collapsed)
    outside = re.sub(r"[\(\[](?:[^\)\]]*)[\)\]]", " ", base)
    if outside.strip():
        variants.append(outside.strip())
        collapsed_outside = re.sub(r"\s*-\s*", "-", outside.strip())
        if collapsed_outside != outside.strip():
            variants.append(collapsed_outside)
    for m in re.findall(r"[\(\[]([^\)\]]*)[\)\]]", base):
        if m.strip():
            variants.append(m.strip())
    for v in list(variants):
        if re.search(r"\bor\b", v, re.I):
            for piece in re.split(r"\s+or\s+", v, flags=re.I):
                if piece.strip():
                    variants.append(piece.strip())
    for v in list(variants):
        tokens = normalize_answer(v).split()
        if (3 <= len(tokens) <= 4
                and re.fullmatch(r"(?:[A-Z][a-z’'–-]+\s+){2,3}[A-Z][a-z’'–-]+", v.strip())):
            variants.append(f"{tokens[0]} {tokens[-1]}")
    seen, out = set(), []
    for v in variants:
        key = normalize_answer(v)
        if key and key not in seen:
            seen.add(key)
            out.append(v)
    return out


def answer_match(pred, gold):
    p = normalize_answer(pred)
    if not p:
        return False
    return any(normalize_answer(v) in p for v in gold_variants(gold))


def is_refusal(answer):
    a = (answer or "").strip().lower()
    if not a:
        return True
    return any(k in a for k in REFUSALS)


# ---------------- ranking metrics over doc ids ----------------

def ranking_metrics_ids(ranked_ids, gold_ids, k=10):
    gold = [g for g in dict.fromkeys(gold_ids)]
    hits = {}
    for i, t in enumerate(ranked_ids[:k]):
        if t in gold and t not in hits:
            hits[t] = i + 1
    denom = len(gold)
    recall10 = sum(1 for r in hits.values() if r <= 10) / denom if denom else 0.0
    full = 1.0 if denom > 0 and recall10 == 1.0 else 0.0
    top10 = [r for r in hits.values() if r <= 10]
    mrr = 1.0 / min(top10) if top10 else 0.0
    seen = set()
    dcg = 0.0
    for i, t in enumerate(ranked_ids[:10]):
        if t in gold and t not in seen:
            seen.add(t)
            dcg += 1.0 / math.log2(i + 2)
    num_gold = min(len(gold), 10)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(num_gold))
    return {"recall@10": recall10, "full_evidence@10": full, "mrr@10": mrr,
            "ndcg@10": dcg / idcg if idcg > 0 else 0.0}


# ---------------- task bundle io ----------------

def load_task(bench):
    return json.load(open(BASE / "tasks" / f"{bench}.json"))


def sha256_of(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


class RateLimiter:
    def __init__(self, per_second=4.0):
        self.interval = 1.0 / per_second
        self.last = 0.0

    def wait(self):
        now = time.time()
        delta = self.last + self.interval - now
        if delta > 0:
            time.sleep(delta)
        self.last = time.time()
