#!/usr/bin/env python3
"""Download + normalise public retrieval benchmarks into the layout consumed by
``beir_pipeline.py`` (and therefore ``standard_ir_eval.py``).

Supported sources:
  * BEIR (https://github.com/beir-cellar/beir): SciFact, NFCorpus, fiqa,
    ArguAna, SCIDOCS, FEVER, HotpotQA, NQ, Quora, climate-fever, scidocs, ...
  * Any dataset already present as <corpus.jsonl, queries.jsonl, qrels/test.tsv>.

The script can subset a corpus to a target document budget while *guaranteeing*
every retained query keeps all of its judged (gold) documents — otherwise the
official qrels would silently reference missing documents and inflate/deflate
the metrics.

Usage:
    python3 fetch_datasets.py --list
    python3 fetch_datasets.py --dataset scifact --output-dir /data/beir
    python3 fetch_datasets.py --dataset nq --output-dir /data/beir \\
        --limit-docs 100000 --limit-queries 500 --seed 42
    python3 fetch_datasets.py --selftest
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

BEIR_BASE_URL = "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets"

# name -> rough corpus size, for operator awareness (not enforced).
KNOWN_DATASETS = {
    "scifact": "~5K docs",
    "nfcorpus": "~3.6K docs",
    "fiqa": "~57K docs",
    "arguana": "~8.7K docs",
    "scidocs": "~25K docs",
    "climate-fever": "~5.4M docs",
    "dbpedia-entity": "~4.6M docs",
    "fever": "~5.4M docs",
    "hotpotqa": "~5.2M docs",
    "nq": "~2.7M docs",
    "quora": "~523K docs",
    "webis-touche2020": "~382K docs",
    "trec-covid": "~171K docs",
}


def subset_beir(
    corpus: dict,
    queries: dict,
    qrels: dict,
    *,
    limit_docs: int | None = None,
    limit_queries: int | None = None,
    seed: int = 42,
):
    """Return a (corpus, queries, qrels) subset that never drops a gold doc of a
    retained query."""
    rng = random.Random(seed)
    evaluable_qids = [qid for qid in qrels.keys() if qid in queries and qrels[qid]]
    if limit_queries and limit_queries < len(evaluable_qids):
        evaluable_qids = rng.sample(evaluable_qids, limit_queries)

    required_docs: set[str] = set()
    for qid in evaluable_qids:
        required_docs.update(doc for doc in qrels[qid] if doc in corpus)

    selected_docs = set(required_docs)
    if limit_docs and len(selected_docs) < limit_docs:
        optional = [doc for doc in corpus.keys() if doc not in selected_docs]
        fill = min(limit_docs - len(selected_docs), len(optional))
        selected_docs.update(rng.sample(optional, fill))

    sub_corpus = {doc: corpus[doc] for doc in selected_docs}
    sub_queries = {qid: queries[qid] for qid in evaluable_qids}
    sub_qrels = {
        qid: {doc: gain for doc, gain in qrels[qid].items() if doc in sub_corpus}
        for qid in evaluable_qids
    }
    sub_qrels = {qid: rel for qid, rel in sub_qrels.items() if rel}
    return sub_corpus, sub_queries, sub_qrels


def read_jsonl(path: Path) -> dict:
    items: dict = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            items[str(record["_id"])] = record
    return items


def read_qrels(path: Path) -> dict[str, dict[str, float]]:
    qrels: dict[str, dict[str, float]] = {}
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            parts = line.strip().split("\t")
            if len(parts) < 3:
                parts = line.split()
            if len(parts) < 3:
                continue
            qid, doc_id, score = parts[0], parts[1], parts[2]
            if qid.lower() in {"query-id", "query_id", "qid"}:
                continue
            try:
                qrels.setdefault(qid, {})[doc_id] = float(score)
            except ValueError:
                continue
    return qrels


def write_beir(out_dir: Path, corpus: dict, queries: dict, qrels: dict) -> None:
    (out_dir / "qrels").mkdir(parents=True, exist_ok=True)
    with (out_dir / "corpus.jsonl").open("w", encoding="utf-8") as handle:
        for doc_id, item in corpus.items():
            handle.write(json.dumps({"_id": doc_id, **item}, ensure_ascii=False) + "\n")
    with (out_dir / "queries.jsonl").open("w", encoding="utf-8") as handle:
        for qid, item in queries.items():
            text = item.get("text") if isinstance(item, dict) else item
            handle.write(json.dumps({"_id": qid, "text": text}, ensure_ascii=False) + "\n")
    with (out_dir / "qrels" / "test.tsv").open("w", encoding="utf-8") as handle:
        handle.write("query-id\tcorpus-id\tscore\n")
        for qid, rel in qrels.items():
            for doc_id, gain in rel.items():
                handle.write(f"{qid}\t{doc_id}\t{gain:g}\n")


def download_beir(name: str, work_dir: Path) -> Path:
    work_dir.mkdir(parents=True, exist_ok=True)
    archive = work_dir / f"{name}.zip"
    url = f"{BEIR_BASE_URL}/{name}.zip"
    print(f"[fetch] downloading {url}")
    with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    extract_dir = work_dir / f"{name}-raw"
    if extract_dir.exists():
        shutil.rmtree(extract_dir)
    with zipfile.ZipFile(archive) as zf:
        zf.extractall(extract_dir)
    candidates = list(extract_dir.rglob("corpus.jsonl"))
    if not candidates:
        raise SystemExit(f"corpus.jsonl not found inside {archive}")
    return candidates[0].parent


def _selftest() -> int:
    corpus = {f"d{i}": {"title": f"T{i}", "text": "x"} for i in range(20)}
    queries = {f"q{i}": {"text": f"query {i}"} for i in range(5)}
    qrels = {"q0": {"d0": 1, "d1": 1}, "q1": {"d19": 1}, "q2": {"d5": 1}}

    # Subset docs far below the gold count: gold docs are never dropped.
    sub_corpus, sub_queries, sub_qrels = subset_beir(
        corpus, queries, qrels, limit_docs=2, limit_queries=2, seed=1
    )
    for qid, rel in sub_qrels.items():
        for doc in rel:
            assert doc in sub_corpus, f"gold {doc} missing from subset"
    assert set(sub_queries.keys()) == set(sub_qrels.keys())

    # No limits returns everything evaluable.
    full_corpus, full_queries, full_qrels = subset_beir(corpus, queries, qrels)
    assert set(full_qrels.keys()) == {"q0", "q1", "q2"}
    assert set(full_queries.keys()) == {"q0", "q1", "q2"}

    # Deterministic under a fixed seed.
    a = subset_beir(corpus, queries, qrels, limit_docs=10, seed=7)
    b = subset_beir(corpus, queries, qrels, limit_docs=10, seed=7)
    assert a[0].keys() == b[0].keys()
    print("fetch_datasets selftest OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch + normalise BEIR datasets")
    parser.add_argument("--dataset")
    parser.add_argument("--output-dir", type=Path, default=Path("/data/beir"))
    parser.add_argument("--work-dir", type=Path, default=Path("/tmp/beir-download"))
    parser.add_argument("--limit-docs", type=int)
    parser.add_argument("--limit-queries", type=int)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--local-dir", type=Path, help="normalise an existing dataset dir")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return _selftest()
    if args.list:
        for name, size in sorted(KNOWN_DATASETS.items()):
            print(f"{name:<20} {size}")
        return 0

    if args.local_dir:
        source = args.local_dir
    elif args.dataset:
        source = download_beir(args.dataset, args.work_dir)
    else:
        parser.error("--dataset or --local-dir is required (or --list/--selftest)")

    corpus = read_jsonl(source / "corpus.jsonl")
    queries = read_jsonl(source / "queries.jsonl")
    qrels_path = next((p for p in [source / "qrels" / "test.tsv", source / "qrels.tsv"] if p.exists()), None)
    if qrels_path is None:
        raise SystemExit(f"No qrels found under {source}")
    qrels = read_qrels(qrels_path)
    print(f"[data] corpus={len(corpus)} queries={len(queries)} qrels={len(qrels)}")

    corpus, queries, qrels = subset_beir(
        corpus, queries, qrels,
        limit_docs=args.limit_docs, limit_queries=args.limit_queries, seed=args.seed,
    )
    name = args.dataset or source.name
    out_dir = args.output_dir / name
    write_beir(out_dir, corpus, queries, qrels)
    print(f"[done] wrote {out_dir} (corpus={len(corpus)} queries={len(queries)} qrels={len(qrels)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
