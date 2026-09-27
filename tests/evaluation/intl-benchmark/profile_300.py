#!/usr/bin/env python3
"""Build and optionally ingest isolated, reproducible 300-document benchmark KBs.

Build is offline. Ingest creates/resumes only the profile-specific KB whose name
contains the corpus hash; it never accesses the legacy benchmark KB by name.
"""

import argparse
import hashlib
import json
import random
import time
from pathlib import Path

import ingest_corpus as api

BASE = Path(__file__).parent
PROFILE = BASE / "profiles" / "300"
DATASETS = ("2wiki", "hotpot", "musique")
DEV_SOURCE = {
    "2wiki": "2wiki_dev.parquet",
    "hotpot": "hotpot_dev.parquet",
    "musique": "musique_dev.jsonl",
}
SEED = 42
MAX_DOCS = 300


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    return sha256_bytes(path.read_bytes())


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def build(dataset):
    source_path = BASE / "corpus" / f"{dataset}_corpus.json"
    eval_path = BASE / f"{dataset}_eval_set.json"
    source = json.loads(source_path.read_text())
    questions = json.loads(eval_path.read_text())
    by_title = {}
    for item in source:
        key = item["title"].casefold()
        if key in by_title:
            raise ValueError(f"duplicate corpus title: {item['title']}")
        by_title[key] = item
    gold_keys = {title.casefold() for row in questions for title in row["gold_titles"]}
    missing = sorted(gold_keys - by_title.keys())
    if missing:
        raise ValueError(f"{dataset}: {len(missing)} gold titles absent: {missing[:10]}")
    if len(gold_keys) > MAX_DOCS:
        raise ValueError(f"{dataset}: {len(gold_keys)} gold documents exceed {MAX_DOCS}")
    gold = sorted((by_title[key] for key in gold_keys), key=lambda item: item["title"].casefold())
    negative_pool = sorted((item for key, item in by_title.items() if key not in gold_keys),
                           key=lambda item: item["title"].casefold())
    negatives = random.Random(SEED).sample(negative_pool, MAX_DOCS - len(gold))
    selected = gold + negatives
    assert len(selected) == MAX_DOCS and len({item["title"].casefold() for item in selected}) == MAX_DOCS
    if len({item["title"][:200] for item in selected}) != MAX_DOCS:
        raise ValueError(f"{dataset}: titles collide after API's 200-character limit")
    PROFILE.mkdir(parents=True, exist_ok=True)
    corpus_path = PROFILE / f"{dataset}_corpus.json"
    manifest_path = PROFILE / f"{dataset}_manifest.json"
    corpus_path.write_text(json.dumps(selected, ensure_ascii=False, indent=2) + "\n")
    corpus_hash = sha256_bytes(canonical_json(selected))
    kb_name = f"{api.KB_NAMES[dataset]}-300docs-seed{SEED}-{corpus_hash[:12]}"
    manifest = {
        "profile": "300", "dataset": dataset, "seed": SEED, "kb_name": kb_name,
        "max_documents": MAX_DOCS, "selected_documents": len(selected),
        "gold_documents": len(gold), "negative_documents": len(negatives),
        "gold_coverage": len(gold_keys - set(by_title)) == 0,
        "question_count": len(questions), "source_documents": len(source),
        "source_sha256": file_hash(source_path), "eval_sha256": file_hash(eval_path),
        "dev_source_file": DEV_SOURCE[dataset],
        "dev_source_sha256": file_hash(BASE / "data" / DEV_SOURCE[dataset]),
        "prep_data_sha256": file_hash(BASE / "prep_data.py"),
        "selected_corpus_sha256": corpus_hash,
        "output_file_sha256": file_hash(corpus_path),
        "gold_titles": [item["title"] for item in gold],
        "negative_titles": [item["title"] for item in negatives],
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"{dataset}: {len(gold)} gold + {len(negatives)} negative = {len(selected)}; {kb_name}")
    return manifest


def validate_profile_documents(documents, selected_titles, require_published):
    titles = [doc.get("title") for doc in documents]
    title_set = set(titles)
    missing = selected_titles - title_set
    extra = title_set - selected_titles
    duplicates = len(titles) - len(title_set)
    unpublished = [doc.get("title") for doc in documents if doc.get("status") != "published"] if require_published else []
    if len(documents) != MAX_DOCS or missing or extra or duplicates or unpublished:
        raise RuntimeError(
            f"profile KB mismatch: count={len(documents)} expected={MAX_DOCS} "
            f"missing={sorted(missing)[:5]} extra={sorted(extra)[:5]} "
            f"duplicates={duplicates} unpublished={unpublished[:5]}"
        )


def profile_status_counts(token, kb_id):
    status, body = api.http("GET", f"/api/v1/kbs/{kb_id}/documents?page=1&limit=1", token=token)
    if status not in (200, 201):
        raise RuntimeError(f"profile KB status query failed: {status} {body}")
    counts = body.get("statusCounts")
    if not isinstance(counts, dict) or "total" not in counts:
        raise RuntimeError("profile KB statusCounts unavailable")
    if int(counts["total"]) > MAX_DOCS:
        raise RuntimeError(f"profile KB exceeds {MAX_DOCS} documents: {counts}")
    return counts


def wait_for_status(token, kb_id, published=False, timeout_s=10800, interval_s=20):
    """Wait for whole-KB counts to settle before traversing mutable offset pages."""
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        counts = profile_status_counts(token, kb_id)
        if counts != last:
            print(f"  statusCounts={counts}", flush=True)
            last = counts
        processing = int(counts.get("processing") or 0)
        if published:
            if int(counts["total"]) == MAX_DOCS and int(counts.get("published") or 0) == MAX_DOCS and processing == 0:
                return counts
            if int(counts["total"]) == MAX_DOCS and processing == 0 and int(counts.get("failed") or 0) > 0:
                raise RuntimeError(f"profile KB has failed documents: {counts}")
        elif processing == 0:
            return counts
        time.sleep(interval_s)
    raise TimeoutError(f"profile KB did not settle after {timeout_s}s: {last}")


def list_profile_documents(token, kb_id, counts):
    """Reject a drifting/duplicated page view; never use it to decide reposts."""
    docs = api.list_all_docs(token, kb_id)
    ids = [doc.get("id") for doc in docs]
    if len(docs) != int(counts["total"]) or len(set(ids)) != len(ids) or any(not doc_id for doc_id in ids):
        raise RuntimeError(
            f"unstable document pagination: rows={len(docs)} unique_ids={len(set(ids))} "
            f"status_total={counts['total']}; refusing to infer missing titles"
        )
    return docs


def ingest(dataset):
    manifest = build(dataset)
    corpus_path = PROFILE / f"{dataset}_corpus.json"
    selected = json.loads(corpus_path.read_text())
    if sha256_bytes(canonical_json(selected)) != manifest["selected_corpus_sha256"]:
        raise ValueError("profile corpus hash mismatch")
    token = api.login()
    name = manifest["kb_name"]
    matches = []
    page = 1
    while True:
        status, body = api.http("GET", f"/api/v1/kbs?page={page}&limit=100", token=token)
        if status not in (200, 201):
            raise RuntimeError(f"list KB failed: {status} {body}")
        items = body.get("items") or []
        matches.extend(kb for kb in items if kb.get("name") == name and kb.get("status") == "active")
        if not items or page * 100 >= int(body.get("total") or len(items)):
            break
        page += 1
    if len(matches) > 1:
        raise RuntimeError(f"multiple KBs named {name}")
    if matches:
        kb_id = matches[0]["id"]
        description = str(matches[0].get("description") or "")
        if manifest["selected_corpus_sha256"] not in description:
            raise RuntimeError("existing profile KB has different or unverifiable corpus identity")
    else:
        description = f"国际基准隔离测评 profile=300 dataset={dataset} corpus_sha256={manifest['selected_corpus_sha256']}"
        status, body = api.http("POST", "/api/v1/kbs/personal",
                                {"name": name, "description": description}, token=token)
        if status not in (200, 201):
            raise RuntimeError(f"create profile KB failed: {status} {body}")
        kb_id = (body.get("knowledgeBase") or body)["id"]
    initial_counts = wait_for_status(token, kb_id)
    existing = list_profile_documents(token, kb_id, initial_counts)
    selected_titles = {item["title"][:200] for item in selected}
    unexpected = [doc.get("title") for doc in existing if doc.get("title") not in selected_titles]
    if unexpected or len(existing) > MAX_DOCS:
        raise RuntimeError(f"profile KB contains unexpected documents: {unexpected[:10]}")
    if int(initial_counts["total"]) == MAX_DOCS:
        # A full KB cannot accept further posts. A mismatch is an audit failure,
        # not permission to infer that a title is missing from drifting pages.
        validate_profile_documents(existing, selected_titles, require_published=False)
    existing_titles = {doc.get("title") for doc in existing}
    todo = [item for item in selected if item["title"][:200] not in existing_titles]
    limiter = api.RateLimiter(2.0)
    failures = []
    print(f"profile KB={kb_id}; existing={len(existing)}; to_post={len(todo)}", flush=True)
    # Sequential posting makes the shared limiter effective across requests.
    for index, item in enumerate(todo, 1):
        title, _doc_id, error = api.ingest_one(token, kb_id, item, limiter)
        if error:
            failures.append((title, error))
        if index % 25 == 0 or index == len(todo):
            print(f"posted {index}/{len(todo)}; failed={len(failures)}", flush=True)
    for doc in existing:
        if doc.get("status") != "failed":
            continue
        limiter.wait()
        status, _body = api.http("POST", f"/api/v1/kbs/{kb_id}/documents/{doc['id']}/retry",
                                  {}, token=token, timeout=120)
        if status not in (200, 201):
            failures.append((doc.get("title"), f"retry:{status}"))
    if failures:
        raise RuntimeError(f"{dataset}: posting/retry failed: {failures[:5]}")
    final_status = wait_for_status(token, kb_id, published=True)
    final_docs = list_profile_documents(token, kb_id, final_status)
    validate_profile_documents(final_docs, selected_titles, require_published=True)
    complete = True
    meta = {
        "profile": "300", "dataset": dataset, "kb_id": kb_id,
        "kb_name": name, "selected_corpus_sha256": manifest["selected_corpus_sha256"],
        "manifest_sha256": file_hash(PROFILE / f"{dataset}_manifest.json"),
        "gold_documents": manifest["gold_documents"],
        "negative_documents": manifest["negative_documents"],
        "corpus": MAX_DOCS, "all_published": complete,
        "exact_manifest": True,
        "published_count": sum(doc.get("status") == "published" for doc in final_docs),
        "final_status": final_status, "post_failures": failures,
        "finished_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    (PROFILE / f"{dataset}_ingest_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    print(f"{dataset}: published={complete}; status={final_status}; failures={len(failures)}")
    if not complete or failures:
        raise RuntimeError(f"{dataset} profile ingestion incomplete")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("build", "ingest"))
    parser.add_argument("dataset", choices=(*DATASETS, "all"))
    args = parser.parse_args()
    for dataset in DATASETS if args.dataset == "all" else (args.dataset,):
        (build if args.action == "build" else ingest)(dataset)
