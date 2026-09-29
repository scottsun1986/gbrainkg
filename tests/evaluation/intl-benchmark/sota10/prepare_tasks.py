#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SOTA10 任务包构建:把 10 个国际主流基准采样为「每项 ≤30 题 / 每库 ≤30 文档」的任务包。

数据源(全部真实公开数据集,seed=42 可复现):
  hotpot / 2wiki / musique  — tests/evaluation/intl-benchmark/data/  (dev, 含 context)
  squad                     — SQuAD v1.1 dev (rajpurkar.github.io)
  mintaka                   — Mintaka dev (amazon-science/Mintaka) + Wikidata API 实体证据
  scifact/nfcorpus/fiqa/arguana — BEIR (corpus+queries+qrels, gold 保证子集)
  rgb                       — RGB (chen700564/RGB): noise/rejection/integration/counterfactual

产出 tasks/{bench}.json: {"kbs": {kb名: [docs]}, "questions": [...], "meta": {...}}
"""
import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE = Path(__file__).parent
REPO_INTL = BASE.parent
SOTA_DATA = Path("/home/scottsun/sota10/data")
LOCAL_DATA = REPO_INTL / "data"
DOC_BUDGET = 30          # 每个知识库硬上限
QUESTION_BUDGET = 30     # 每个基准硬上限
SEED = 42


def norm_title(t):
    return " ".join(str(t).split())


class Corpus:
    """带 gold 保护的语料收集器:doc 去重、预算控制。title 唯一,重复 add 返回既有 id。"""

    def __init__(self, budget=DOC_BUDGET):
        self.budget = budget
        self.docs = []
        self.by_title = {}

    def add(self, title, text, origin):
        t = norm_title(title)
        if not t or len(self.docs) >= self.budget:
            return None
        if t in self.by_title:
            return self.by_title[t]["id"]
        if not str(text or "").strip():
            return None
        doc = {"id": f"d{len(self.docs):04d}", "title": t[:200], "text": str(text), "origin": origin}
        self.docs.append(doc)
        self.by_title[t] = doc
        return doc["id"]

    def full(self):
        return len(self.docs) >= self.budget


# ---------------- multi-hop QA (hotpot / 2wiki / musique) ----------------

def build_multihop(bench):
    import pandas as pd
    rng = random.Random(SEED)
    rows = []
    if bench == "hotpot":
        df = pd.read_parquet(LOCAL_DATA / "hotpot_dev.parquet").sample(n=400, random_state=SEED).reset_index(drop=True)
        for _, r in df.iterrows():
            ctx = r["context"]
            titles = [norm_title(t) for t in ctx["title"]]
            sents = ["".join(list(s)).strip() for s in ctx["sentences"]]
            gold_titles = sorted({norm_title(t) for t in r["supporting_facts"]["title"]})
            paras = {}
            for t, tx in zip(titles, sents):
                if t not in paras or t in gold_titles:
                    paras[t] = tx
            rows.append({"qid": str(r["id"]), "question": str(r["question"]), "answer": str(r["answer"]),
                         "gold_titles": gold_titles, "paras": paras,
                         "type": f'{r["type"]}/{r["level"]}'})
    elif bench == "2wiki":
        df = pd.read_parquet(LOCAL_DATA / "2wiki_dev.parquet").sample(n=400, random_state=SEED).reset_index(drop=True)
        for _, r in df.iterrows():
            ctx = json.loads(r["context"]) if isinstance(r["context"], str) else r["context"]
            sf = json.loads(r["supporting_facts"]) if isinstance(r["supporting_facts"], str) else r["supporting_facts"]
            if isinstance(ctx, dict):
                raw_titles, raw_sents = ctx["title"], ctx["sentences"]
            elif ctx and isinstance(ctx[0], dict):
                raw_titles = [p["title"] for p in ctx]
                raw_sents = [p["sentences"] for p in ctx]
            else:  # 2wiki parquet: [[title, [sents]], ...]
                raw_titles = [p[0] for p in ctx]
                raw_sents = [p[1] for p in ctx]
            titles = [norm_title(t) for t in raw_titles]
            sents = [" ".join(list(s)).strip() for s in raw_sents]
            gold_titles = sorted({norm_title(t) for t, _ in sf})
            paras = {}
            for t, tx in zip(titles, sents):
                if t not in paras or t in gold_titles:
                    paras[t] = tx
            rows.append({"qid": str(r["_id"]), "question": str(r["question"]), "answer": str(r["answer"]),
                         "gold_titles": gold_titles, "paras": paras, "type": str(r["type"])})
    else:  # musique
        all_rows = [json.loads(l) for l in open(LOCAL_DATA / "musique_dev.jsonl") if l.strip()]
        rng.shuffle(all_rows)
        for r in all_rows[:400]:
            # 同一题的 20 段里同名段落可能有多个(逐题定制上下文),gold 支撑段优先
            support = {d["paragraph_support_idx"] for d in r["question_decomposition"]}
            paras = {}
            for i, p in enumerate(r["paragraphs"]):
                t = norm_title(p["title"])
                if t not in paras or i in support:
                    paras[t] = p["paragraph_text"]
            ordered = [norm_title(p["title"]) for p in sorted(r["paragraphs"], key=lambda x: x["idx"])]
            gold_titles = sorted({ordered[d["paragraph_support_idx"]] for d in r["question_decomposition"]})
            rows.append({"qid": str(r["id"]), "question": str(r["question"]), "answer": str(r["answer"]),
                         "gold_titles": gold_titles, "paras": paras,
                         "aliases": [str(a) for a in (r.get("answer_aliases") or [])],
                         "type": f'{len(r["question_decomposition"])}hop'})

    rng.shuffle(rows)
    corpus = Corpus(DOC_BUDGET - 2)   # 预留 2 篇干扰位
    questions, skipped = [], 0

    def gold_in_doc(title, text):
        """同名段落在不同题目里可能是不同版本(MuSiQue 逐题定制 20 段上下文,
        同名 gold 段内容不同;实测 418/7274 个共享标题存在版本冲突)。
        已存在同标题文档时合并变体,保证本题 gold 文本确实入库、题目在库内可答。"""
        t = norm_title(title)
        if t in corpus.by_title:
            doc = corpus.by_title[t]
            stripped = str(text or "").strip()
            if stripped and stripped not in doc["text"]:
                doc["text"] = doc["text"].rstrip() + "\n\n" + stripped
            return doc["id"]
        return corpus.add(t, text, "gold")

    for r in rows:
        if len(questions) >= QUESTION_BUDGET or corpus.full():
            break
        gold_texts = {t: r["paras"].get(t) or "" for t in r["gold_titles"]}
        if any(not x.strip() for x in gold_texts.values()):
            skipped += 1
            continue
        need = [t for t in r["gold_titles"] if t not in corpus.by_title]
        if corpus.budget - len(corpus.docs) < len(need):
            skipped += 1
            continue
        ids = [gold_in_doc(t, gold_texts[t]) or corpus.by_title[t]["id"] for t in r["gold_titles"]]
        q = {"qid": r["qid"], "question": r["question"], "gold_answer": r["answer"],
             "gold_doc_ids": ids, "gold_titles": r["gold_titles"], "type": r["type"]}
        if r.get("aliases"):
            q["aliases"] = r["aliases"]
        questions.append(q)
    # 干扰文档:未抽中题目的 gold 段落(真实文本、跨题干扰)
    for r in rows:
        if corpus.full():
            break
        for t in r["gold_titles"]:
            if corpus.full():
                break
            if t not in corpus.by_title:
                corpus.add(t, r["paras"].get(t) or "", "distractor")
    return corpus, questions, skipped


# ---------------- SQuAD v1.1 ----------------

def build_squad():
    rng = random.Random(SEED)
    data = json.load(open(SOTA_DATA / "squad_dev_v11.json"))["data"]
    arts = data[:]
    rng.shuffle(arts)
    corpus, questions = Corpus(DOC_BUDGET), []
    seen_titles = set()
    for a in arts:
        if len(questions) >= 28 or corpus.full():
            break
        paras = a["paragraphs"][:]
        rng.shuffle(paras)
        for p in paras:
            if len(questions) >= 28 or corpus.full():
                break
            qas = [q for q in p["qas"] if q.get("answers")]
            if not qas:
                continue
            title = f"{a['title']} (¶{len(seen_titles) + 1})"
            q = qas[0]
            did = corpus.add(title, p["context"], "gold")
            if not did or title in seen_titles:
                continue
            seen_titles.add(title)
            questions.append({"qid": q["id"], "question": q["question"],
                              "gold_answer": q["answers"][0]["text"],
                              "gold_variants": sorted({x["text"] for x in q["answers"]}),
                              "gold_doc_ids": [did], "type": "extractive"})
    return corpus, questions, 0


# ---------------- Mintaka (KBQA over Wikidata) ----------------

WD_API = "https://www.wikidata.org/w/api.php"
WD_QUAL = {"P585": "point in time", "P580": "start time", "P582": "end time", "P1545": "series ordinal"}


WD_CACHE = SOTA_DATA / "wd_cache.json"


def _load_cache():
    return json.load(open(WD_CACHE)) if WD_CACHE.exists() else {"ents": {}, "labels": {}}


def wd_get(params, tries=5):
    """Wikidata API 调用。注:该环境下 python-urllib 的 TLS ClientHello 对
    wikidata.org 会被静默丢弃(curl 正常),故走 curl 子进程。"""
    import subprocess
    url = WD_API + "?" + urllib.parse.urlencode({**params, "format": "json"})
    last = None
    for i in range(tries):
        try:
            r = subprocess.run(["curl", "-s", "--fail", "--max-time", "60", url],
                               capture_output=True, timeout=70)
            if r.returncode == 0 and r.stdout.strip():
                return json.loads(r.stdout.decode("utf-8", "replace"))
            last = RuntimeError(f"curl rc={r.returncode} {r.stderr[:80]}")
        except Exception as e:
            last = e
        time.sleep(min(20, 3 * (i + 1)))
    raise last


def wd_fetch_entities(qids):
    cache = _load_cache()
    out = {q: cache["ents"][q] for q in qids if q in cache["ents"]}
    ids = [q for q in qids if re.fullmatch(r"Q\d+", q) and q not in out]
    for i in range(0, len(ids), 40):
        batch = ids[i:i + 40]
        try:
            data = wd_get({"action": "wbgetentities", "ids": "|".join(batch),
                           "props": "labels|descriptions|claims", "languages": "en"})
        except Exception:
            continue
        for qid, ent in (data.get("entities") or {}).items():
            rec = {"id": qid,
                   "label": ((ent.get("labels") or {}).get("en") or {}).get("value", qid),
                   "desc": ((ent.get("descriptions") or {}).get("en") or {}).get("value", ""),
                   "claims": ent.get("claims") or {}}
            out[qid] = rec
            cache["ents"][qid] = rec
        time.sleep(0.5)
        json.dump(cache, open(WD_CACHE, "w"))
    return out


def wd_collect_pcodes(ents):
    codes = set()
    for e in ents:
        codes.update(e["claims"].keys())
    return {c for c in codes if re.fullmatch(r"P\d+", c)}


def wd_fetch_labels(ids):
    cache = _load_cache()
    out = {q: cache["labels"][q] for q in ids if q in cache["labels"]}
    todo = sorted(set(ids) - set(out))
    for i in range(0, len(todo), 50):
        batch = todo[i:i + 50]
        try:
            data = wd_get({"action": "wbgetentities", "ids": "|".join(batch), "props": "labels", "languages": "en"})
        except Exception:
            continue
        for qid, ent in (data.get("entities") or {}).items():
            lab = ((ent.get("labels") or {}).get("en") or {}).get("value", qid)
            out[qid] = lab
            cache["labels"][qid] = lab
        time.sleep(0.5)
        json.dump(cache, open(WD_CACHE, "w"))
    return out


def wd_value_id(snak):
    dv = snak.get("datavalue") or {}
    v = dv.get("value")
    if isinstance(v, dict) and dv.get("type") == "wikibase-entityid":
        return v.get("id")
    return None


def wd_value_text(snak):
    dv = snak.get("datavalue") or {}
    v = dv.get("value")
    if isinstance(v, dict):
        if "time" in v:
            return v["time"][:12].lstrip("+")
        if "amount" in v:
            return v["amount"].lstrip("+")
        return json.dumps(v, ensure_ascii=False)[:50]
    return str(v)[:80] if v is not None else ""


def wd_verbalize(ent, plabels):
    lines = [f"**{ent['label']}** ({ent['id']})" + (f" — {ent['desc']}." if ent['desc'] else "."),
             "Key facts:"]
    facts = []
    for pc, claims in list(ent["claims"].items())[:25]:
        for cl in claims[:2]:
            ms = cl.get("mainsnak") or {}
            if ms.get("snaktype") != "value":
                continue
            vid = wd_value_id(ms)
            val = plabels.get(vid, vid) if vid else wd_value_text(ms)
            quals = []
            for qpc, qvals in (cl.get("qualifiers") or {}).items():
                if qpc in WD_QUAL:
                    for qv in qvals[:1]:
                        qid = wd_value_id(qv)
                        qtext = plabels.get(qid, qid) if qid else wd_value_text(qv)
                        quals.append(f"{WD_QUAL[qpc]}={qtext}")
            facts.append(f"- {plabels.get(pc, pc)}: {val}" + (f" ({'; '.join(quals)})" if quals else ""))
    return "\n".join(lines + facts[:25])


def build_mintaka():
    rng = random.Random(SEED)
    rows = json.load(open(SOTA_DATA / "mintaka-main" / "data" / "mintaka_dev.json"))
    keep_types = {"generic", "yesno", "ordinal", "intersection", "multihop"}
    rows = [r for r in rows if r["complexityType"] in keep_types]
    rng.shuffle(rows)

    qids = set()
    for r in rows[:150]:
        for qe in r["questionEntity"]:
            if qe.get("entityType") == "entity" and isinstance(qe.get("name"), str):
                qids.add(qe["name"])
    ents = wd_fetch_entities(sorted(qids))

    def answer_labels(r):
        a = r.get("answer") or {}
        labs = []
        for x in (a.get("answer") or []):
            if isinstance(x, dict):
                lab = (x.get("label") or {}).get("en") or x.get("name")
                if lab:
                    labs.append(str(lab))
            elif x is not None:
                labs.append(str(x))
        if a.get("mention"):
            labs.append(str(a["mention"]))
        if a.get("answerType") == "yesno":
            labs = ["yes", "no", "true", "false"]
        return labs

    corpus, questions = Corpus(DOC_BUDGET - 2), []
    for r in rows:
        if len(questions) >= QUESTION_BUDGET - 2 or corpus.full():
            break
        qes = [ents[qe["name"]] for qe in r["questionEntity"]
               if qe.get("entityType") == "entity" and qe["name"] in ents]
        if not qes:
            continue
        # 1-hop 邻居实体(多跳链路文档)
        neighbor_ids = set()
        for e in qes:
            for claims in e["claims"].values():
                for cl in claims[:4]:
                    vid = wd_value_id(cl.get("mainsnak") or {})
                    if vid and vid in ents:
                        neighbor_ids.add(vid)
        cand = qes + [ents[n] for n in sorted(neighbor_ids)]
        cand = [e for e in cand if e["label"] not in corpus.by_title]
        if not cand or corpus.budget - len(corpus.docs) < min(len(cand), 2):
            continue
        ids = []
        for e in cand:
            did = corpus.add(e["label"], "PENDING", "wikidata")
            if did:
                ids.append((e, did))
        if not ids:
            continue
        gold_labs = answer_labels(r)
        questions.append({"qid": r["id"], "question": r["question"],
                          "gold_answer": (gold_labs or [""])[0],
                          "gold_variants": gold_labs,
                          "gold_doc_ids": [corpus.by_title[e["label"]]["id"] for e in qes],
                          "gold_titles": [e["label"] for e in qes],
                          "mintaka": {"entity_ids": [e["id"] for e, _ in ids],
                                      "answer_labels": gold_labs,
                                      "ctype": r["complexityType"], "category": r.get("category")},
                          "type": f'kbqa/{r["complexityType"]}'})
        # 文本回填所需实体缓存
        for e, did in ids:
            e["_did"] = did

    # 回填文档文本:property labels 一次批量拉取
    seen_ids = set()
    for q in questions:
        seen_ids.update(q["mintaka"]["entity_ids"])
    by_id = {e["id"]: e for e in ents.values()}
    used = [by_id[i] for i in sorted(seen_ids) if i in by_id]
    pcodes = wd_collect_pcodes(used)
    plabels = wd_fetch_labels(pcodes) if pcodes else {}
    answerable = []
    for q in questions:
        texts = []
        for eid in q["mintaka"]["entity_ids"]:
            e = by_id.get(eid)
            doc = corpus.by_title.get(e["label"]) if e else None
            if doc is not None:
                doc["text"] = wd_verbalize(e, plabels)
                texts.append(doc["text"])
        blob = "\n".join(texts).lower()
        if q["mintaka"]["ctype"] == "yesno" or any(
                str(v).strip().lower() in blob for v in q["mintaka"]["answer_labels"]):
            answerable.append(q)
    # 未回填成功的占位文档转干扰文本(避免空文档)
    for d in corpus.docs:
        if d["text"] == "PENDING":
            e = by_id.get(d["title"] and next((x["id"] for x in used if x["label"] == d["title"]), None))
            d["text"] = wd_verbalize(e, plabels) if e else f"{d['title']} (Wikidata entity)"
    questions = answerable[:QUESTION_BUDGET - 2]
    return corpus, questions, 0


# ---------------- BEIR ----------------

def read_jsonl_map(path):
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            out[str(r["_id"])] = r
    return out


def read_qrels(path):
    qrels = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            parts = line.strip().split("\t")
            if len(parts) < 3:
                parts = line.split()
            if len(parts) < 3 or parts[0].lower() == "query-id":
                continue
            try:
                qrels.setdefault(parts[0], {})[parts[1]] = float(parts[2])
            except ValueError:
                continue
    return qrels


def build_beir(name):
    d = SOTA_DATA / "beir" / name
    corpus_data = read_jsonl_map(d / "corpus.jsonl")
    queries = read_jsonl_map(d / "queries.jsonl")
    qrels_all = read_qrels(d / "qrels" / "test.tsv")
    rng = random.Random(SEED)
    qids = [q for q in qrels_all if q in queries and qrels_all[q]]
    rng.shuffle(qids)

    def doc_title(docid):
        c = corpus_data[docid]
        return f"[{docid}] {norm_title(c.get('title') or docid)}"[:200]

    corpus_obj, questions = Corpus(DOC_BUDGET), []
    for qid in qids:
        if len(questions) >= QUESTION_BUDGET or corpus_obj.full():
            break
        gold = [g for g, gain in sorted(qrels_all[qid].items()) if gain >= 1 and g in corpus_data]
        if not gold:
            continue
        missing = [g for g in gold if f"[{g}]" not in corpus_obj.by_title and doc_title(g) not in corpus_obj.by_title]
        if corpus_obj.budget - len(corpus_obj.docs) < len(missing):
            continue
        ids = []
        for g in gold:
            c = corpus_data[g]
            did = corpus_obj.add(doc_title(g), f"{c.get('title') or g}\n{c.get('text') or ''}", "gold")
            ids.append(did or corpus_obj.by_title[doc_title(g)]["id"])
        questions.append({"qid": qid, "question": queries[qid].get("text") or "",
                          "gold_answer": None, "gold_doc_ids": ids,
                          "beir_gold_ids": gold, "type": f"beir/{name}"})
    # 干扰文档:未抽中查询的 gold 文档
    for qid in qids:
        if corpus_obj.full():
            break
        for g, gain in sorted(qrels_all[qid].items()):
            if corpus_obj.full():
                break
            if gain >= 1 and g in corpus_data and doc_title(g) not in corpus_obj.by_title:
                c = corpus_data[g]
                corpus_obj.add(doc_title(g), f"{c.get('title') or g}\n{c.get('text') or ''}", "distractor")
    return corpus_obj, questions, 0


# ---------------- RGB ----------------

def build_rgb():
    rng = random.Random(SEED)
    en = [json.loads(l) for l in open(SOTA_DATA / "RGB-master" / "data" / "en.json") if l.strip()]
    en_int = [json.loads(l) for l in open(SOTA_DATA / "RGB-master" / "data" / "en_int.json") if l.strip()]
    en_fact = [json.loads(l) for l in open(SOTA_DATA / "RGB-master" / "data" / "en_fact.json") if l.strip()]
    rng.shuffle(en)
    rng.shuffle(en_int)
    rng.shuffle(en_fact)

    kbs = {"SOTA10-RGB-main": [], "SOTA10-RGB-reject": []}
    questions = []
    NOISE_N, REJ_N, INT_N, FACT_N, DOCS_PER_CASE = 8, 8, 4, 4, 5

    def add_doc(kb, title, text):
        docs = kbs[kb]
        key = norm_title(title)[:200]
        for d in docs:
            if d["title"] == key:
                return d["id"]
        did = f"{'rej' if 'reject' in kb else 'rgb'}-{len(docs):04d}"
        docs.append({"id": did, "title": key, "text": text, "origin": "rgb"})
        return did

    for r in en[:NOISE_N]:
        pos = [str(x) for x in (r.get("positive") or []) if str(x).strip()][:2]
        neg = [str(x) for x in (r.get("negative") or []) if str(x).strip()]
        docs = pos + neg[:max(0, DOCS_PER_CASE - len(pos))]
        ids = [add_doc("SOTA10-RGB-main", f"rgb-doc {r['id']} #{i}", t) for i, t in enumerate(docs)]
        questions.append({"qid": f"noise-{r['id']}", "question": r["query"], "gold_answer": r["answer"],
                          "gold_doc_ids": ids[:len(pos)], "kb": "SOTA10-RGB-main",
                          "rgb": {"ability": "noise", "n_pos": len(pos)}, "type": "rgb/noise"})
    for r in en[NOISE_N:NOISE_N + REJ_N]:
        neg = [str(x) for x in (r.get("negative") or []) if str(x).strip()][:DOCS_PER_CASE]
        ids = [add_doc("SOTA10-RGB-reject", f"rgb-rej {r['id']} #{i}", t) for i, t in enumerate(neg)]
        questions.append({"qid": f"reject-{r['id']}", "question": r["query"], "gold_answer": r["answer"],
                          "gold_doc_ids": [], "kb": "SOTA10-RGB-reject",
                          "rgb": {"ability": "rejection", "expect": "refuse"}, "type": "rgb/rejection"})
    def flatten_gold(x):
        if isinstance(x, list):
            out = []
            for i in x:
                if isinstance(i, list):
                    out += [str(j) for j in i]
                elif i:
                    out.append(str(i))
            return out
        return [str(x)] if x else []

    for r in en_int[:INT_N]:
        pos_lists = r.get("positive") or []
        docs = [str(pl[0]) if isinstance(pl, list) else str(pl) for pl in pos_lists][:DOCS_PER_CASE]
        neg = [str(x) for x in (r.get("negative") or []) if str(x).strip()]
        docs += neg[:max(0, DOCS_PER_CASE - len(docs))]
        ids = [add_doc("SOTA10-RGB-main", f"rgb-int {r['id']} #{i}", t) for i, t in enumerate(docs)]
        variants = flatten_gold(r.get("asnwer1")) + flatten_gold(r.get("asnwer2")) \
            + flatten_gold(r.get("answer"))
        questions.append({"qid": f"int-{r['id']}", "question": r["query"],
                          "gold_answer": variants[0] if variants else "",
                          "gold_variants": variants,
                          "gold_doc_ids": ids[:min(len(pos_lists), DOCS_PER_CASE)],
                          "kb": "SOTA10-RGB-main", "rgb": {"ability": "integration"},
                          "type": "rgb/integration"})
    for r in en_fact[:FACT_N]:
        wrong = [str(x) for x in (r.get("positive_wrong") or []) if str(x).strip()][:2]
        neg = [str(x) for x in (r.get("negative") or []) if str(x).strip()]
        docs = wrong + neg[:max(0, DOCS_PER_CASE - len(wrong))]
        ids = [add_doc("SOTA10-RGB-main", f"rgb-fact {r['id']} #{i}", t) for i, t in enumerate(docs)]
        questions.append({"qid": f"fact-{r['id']}", "question": r["query"],
                          "gold_answer": r.get("fakeanswer") or "",
                          "gold_variants": [r.get("fakeanswer") or ""],
                          "gold_doc_ids": ids[:len(wrong)], "kb": "SOTA10-RGB-main",
                          "rgb": {"ability": "counterfactual", "true_answer": r.get("answer") or ""},
                          "type": "rgb/counterfactual"})
    return kbs, questions, {kb: len(v) for kb, v in kbs.items()}


# ---------------- main ----------------

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="仅构建指定基准(hotpot/2wiki/musique/squad/mintaka/scifact/.../rgb)")
    args = ap.parse_args()
    tasks_dir = BASE / "tasks"
    tasks_dir.mkdir(exist_ok=True)
    report = {}
    if (tasks_dir / "_build_report.json").exists():
        report = json.load(open(tasks_dir / "_build_report.json"))

    def save(bench, corpus_or_kbs, questions, source, extra_meta=None):
        if isinstance(corpus_or_kbs, Corpus):
            kbs = {f"SOTA10-{bench.upper()}": corpus_or_kbs.docs}
            n_docs = len(corpus_or_kbs.docs)
        else:
            kbs = corpus_or_kbs
            n_docs = sum(len(v) for v in kbs.values())
        task = {"bench": bench, "kbs": kbs, "questions": questions,
                "meta": {"source": source, "n_docs": n_docs, "n_questions": len(questions),
                         "seed": SEED, "doc_budget": DOC_BUDGET, "question_budget": QUESTION_BUDGET,
                         **(extra_meta or {})}}
        json.dump(task, open(tasks_dir / f"{bench}.json", "w"), ensure_ascii=False, indent=1)
        report[bench] = task["meta"]
        print(f"{bench}: docs={n_docs} questions={len(questions)}")

    only = {args.only} if args.only else None

    def wanted(b):
        return only is None or b in only

    for bench in ["hotpot", "2wiki", "musique"]:
        if not wanted(bench):
            continue
        corpus, questions, skipped = build_multihop(bench)
        src = {"hotpot": "HotpotQA dev (distractor setting)", "2wiki": "2WikiMultiHopQA dev",
               "musique": "MuSiQue dev (answerable)"}[bench]
        save(bench, corpus, questions, src, {"skipped_for_budget": skipped})
    if wanted("squad"):
        corpus, questions, _ = build_squad()
        save("squad", corpus, questions, "SQuAD v1.1 dev (Wikipedia paragraphs)")
    if wanted("mintaka"):
        corpus, questions, _ = build_mintaka()
        save("mintaka", corpus, questions,
             "Mintaka dev (KBQA) + Wikidata evidence; types: generic/yesno/ordinal/intersection/multihop",
             {"note": "comparative/difference/superlative/count 类需要跨实体聚合证据,不在闭库协议内"})
    for name in ["scifact", "nfcorpus", "fiqa", "arguana"]:
        if not wanted(name):
            continue
        corpus, questions, _ = build_beir(name)
        save(name, corpus, questions, f"BEIR {name} (test qrels, gold-guaranteed subset)")
    if wanted("rgb"):
        kbs, questions, meta_docs = build_rgb()
        save("rgb", kbs, questions, "RGB (noise/rejection/integration/counterfactual)",
             {"docs_per_kb": meta_docs,
              "note": "RGB 为逐案例证据设计,文档随案例提供;题目数遵守 ≤30 约束"})

    json.dump(report, open(tasks_dir / "_build_report.json", "w"), ensure_ascii=False, indent=1)
    print("DONE")


if __name__ == "__main__":
    main()
