#!/usr/bin/env python3
"""BEIR ingestion + retrieval pipeline for real, large-scale IR evaluation.

Produces a TREC-style run file from the live GBrainKG API so it can be scored
by ``standard_ir_eval.py`` with official qrels.

Supported dataset layout (BEIR standard):
    <dataset>/
      corpus.jsonl      {"_id", "title", "text"}
      queries.jsonl     {"_id", "text"}
      qrels/test.tsv    query-id  corpus-id  score

To map chunk-level search hits back to corpus ids, ingested documents are
titled ``[BEIR:<corpus_id>] <original title>``. The marker survives retrieval
and is parsed from the result title; a manifest (written during ingestion) maps
system document ids to corpus ids as a fallback.

Usage:
    # smoke test the loaders/mapping without any API
    python3 beir_pipeline.py --selftest

    # ingest a corpus (10 万级 scale via --limit-docs) and build a run file
    python3 beir_pipeline.py --dataset-dir /data/beir/scifact \\
        --api-base http://127.0.0.1:3000 --kb-id <kb-uuid> \\
        --ingest --limit-docs 100000 --limit-queries 300 \\
        --run-out run_scifact.jsonl --manifest-out manifest_scifact.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

BEIR_PREFIX = "[BEIR:"
BEIR_SUFFIX = "]"


def build_beir_title(beir_id: str, title: str | None) -> str:
    clean = (title or "").strip()
    return f"{BEIR_PREFIX}{beir_id}{BEIR_SUFFIX} {clean}".strip()


def parse_beir_id(title: str | None) -> str | None:
    if not title:
        return None
    start = title.find(BEIR_PREFIX)
    if start < 0:
        return None
    end = title.find(BEIR_SUFFIX, start + len(BEIR_PREFIX))
    if end < 0:
        return None
    value = title[start + len(BEIR_PREFIX):end].strip()
    return value or None


def load_beir(dataset_dir: Path):
    corpus: dict[str, dict] = {}
    queries: dict[str, str] = {}
    corpus_path = dataset_dir / "corpus.jsonl"
    queries_path = dataset_dir / "queries.jsonl"
    qrels_candidates = [dataset_dir / "qrels" / "test.tsv", dataset_dir / "qrels.tsv"]

    with corpus_path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            corpus[str(item["_id"])] = item
    with queries_path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            queries[str(item["_id"])] = item.get("text", "")

    qrels_path = next((p for p in qrels_candidates if p.exists()), None)
    if qrels_path is None:
        raise SystemExit(f"No qrels file found under {dataset_dir}")
    qrels: dict[str, dict[str, float]] = {}
    with qrels_path.open(encoding="utf-8") as handle:
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
    if not corpus or not qrels:
        raise ValueError("BEIR corpus and qrels must be nonempty")
    for qid, judgments in qrels.items():
        if qid not in queries or not queries[qid].strip():
            raise ValueError(f"{qid}: qrels query missing or empty")
        for doc_id, gain in judgments.items():
            if not math.isfinite(gain):
                raise ValueError(f"{qid}/{doc_id}: nonfinite qrel gain")
            if gain > 0 and doc_id not in corpus:
                raise ValueError(f"{qid}/{doc_id}: positive qrel document missing from corpus")
    return corpus, queries, qrels


class ApiClient:
    def __init__(self, base: str, user: str, password: str, timeout: float = 120.0):
        self.base = base.rstrip("/")
        self.user = user
        self.password = password
        self.timeout = timeout
        self.token: str | None = None

    def _request(self, path: str, method: str, body=None, auth=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{self.base}{path}", data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if auth and self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout, context=CTX) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "replace")

    def login(self):
        preset = os.environ.get("LLMWIKI_TOKEN") or os.environ.get("EVAL_BEARER_TOKEN")
        if preset:
            self.token = preset
        else:
            status, raw = self._request(
                "/api/v1/auth/login", "POST",
                {"username": self.user, "password": self.password}, auth=False,
            )
            if status not in (200, 201):
                raise RuntimeError(f"login failed (HTTP {status})")
            self.token = json.loads(raw).get("token")
        if not isinstance(self.token, str) or not self.token.strip():
            raise RuntimeError("authentication response contains no token")
        # Pre-minted credentials must also prove they work before ingestion/run.
        status, raw = self._request("/api/v1/auth/me", "GET")
        if status != 200 or not isinstance(json.loads(raw), dict):
            raise RuntimeError(f"authentication preflight failed (HTTP {status})")
        return self.token


def select_corpus_ids(corpus, qrels, *, limit_docs=None, limit_queries=None, seed=42):
    """Choose a deterministic corpus subset without dropping evaluation golds."""
    all_ids = sorted(corpus.keys())
    qids = sorted(qrels.keys())
    if limit_queries and limit_queries < len(qids):
        qids = qids[:limit_queries]
    missing_gold = sorted({
        doc_id
        for qid in qids
        for doc_id, gain in qrels.get(qid, {}).items()
        if gain > 0 and doc_id not in corpus
    })
    if missing_gold:
        raise ValueError(
            f"corpus is missing {len(missing_gold)} positive-qrel documents; "
            f"examples: {missing_gold[:5]}"
        )
    if limit_docs is None or limit_docs >= len(all_ids):
        return all_ids
    required = {
        doc_id
        for qid in qids
        for doc_id, gain in qrels.get(qid, {}).items()
        if gain > 0 and doc_id in corpus
    }
    if len(required) > limit_docs:
        raise ValueError(
            f"--limit-docs={limit_docs} cannot preserve {len(required)} gold documents "
            f"for {len(qids)} evaluated queries"
        )
    remaining = [doc_id for doc_id in all_ids if doc_id not in required]
    random.Random(seed).shuffle(remaining)
    return sorted(required) + remaining[: limit_docs - len(required)]


def ingest_corpus(client, kb_id, corpus, *, ids=None, workers=4):
    ids = list(ids or sorted(corpus.keys()))
    manifest: dict[str, str] = {}

    def ingest_one(doc_id: str) -> tuple[str, str | None, str | None]:
        item = corpus[doc_id]
        body = {
            "title": build_beir_title(doc_id, item.get("title", "")),
            "content": item.get("text", ""),
        }
        try:
            status, raw = client._request(f"/api/v1/kbs/{kb_id}/documents/text", "POST", body)
        except Exception as exc:
            # Keep successful siblings in the returned manifest for safe resume.
            return doc_id, None, f"submission transport failed: {type(exc).__name__}"
        if status not in (200, 201):
            return doc_id, None, f"HTTP {status}: {raw[:160]}"
        try:
            documents = json.loads(raw).get("documents") or []
            if documents:
                return doc_id, documents[0].get("id"), None
        except (json.JSONDecodeError, AttributeError, TypeError):
            return doc_id, None, "invalid JSON response"
        return doc_id, None, "response contained no document id"

    failures: list[dict[str, str]] = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for index, (doc_id, system_id, error) in enumerate(pool.map(ingest_one, ids), start=1):
            if system_id:
                manifest[system_id] = doc_id
            else:
                failures.append({"doc_id": doc_id, "error": error or "unknown ingestion error"})
            if index % 500 == 0:
                print(f"[ingest] {index}/{len(ids)}", flush=True)
    return manifest, failures


def ready_beir_count(client, kb_id):
    marker = urllib.parse.quote(BEIR_PREFIX, safe="")
    path = (
        f"/api/v1/kbs/{kb_id}/documents?status=published&indexReadiness=ready"
        f"&search={marker}&page=1&limit=1"
    )
    status, raw = client._request(path, "GET")
    if status not in (200, 201):
        raise RuntimeError(f"readiness query failed: HTTP {status}: {raw[:160]}")
    return int(json.loads(raw).get("total") or 0)


def wait_for_ready(client, kb_id, expected_total, *, timeout_seconds=7200, poll_seconds=10):
    """Wait until every submitted BEIR document is published and enriched."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            ready = ready_beir_count(client, kb_id)
            print(f"[readiness] published+ready={ready}/{expected_total}", flush=True)
            if ready >= expected_total:
                return ready
        except Exception as exc:
            print(f"[readiness] {exc}", file=sys.stderr, flush=True)
        time.sleep(max(1, poll_seconds))
    raise TimeoutError(
        f"timed out after {timeout_seconds}s waiting for {expected_total} published+ready BEIR documents"
    )


def retrieve_run(client, kb_id, queries, qrels, *, manifest=None, top_k=100, workers=4, limit_queries=None):
    missing_queries = sorted(set(qrels) - set(queries))
    if missing_queries:
        raise ValueError(f"qrels queries missing from dataset: {missing_queries[:5]}")
    qids = sorted(qrels)
    if not qids:
        raise ValueError("no qrels queries to evaluate")
    if limit_queries and limit_queries < len(qids):
        qids = qids[:limit_queries]

    def query_one(qid: str):
        body = {"query": queries[qid], "kb_scope": [kb_id], "limit": top_k}
        status, raw = 0, ""
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                status, raw = client._request("/api/v1/chat/search", "POST", body)
            except Exception as exc:
                last_error = exc
                time.sleep(3 * (attempt + 1))
                continue
            if status in (200, 201):
                last_error = None
                break
            last_error = RuntimeError(f"HTTP {status}")
            if status < 500 and status != 429:
                break  # 4xx 是确定性失败，重试无意义
            time.sleep(3 * (attempt + 1))
        if last_error is not None or status not in (200, 201):
            raise RuntimeError(f"{qid}: retrieval failed ({last_error}); run invalid") from last_error
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{qid}: invalid retrieval JSON; run invalid") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise RuntimeError(f"{qid}: retrieval response lacks result list; run invalid")
        results = payload["results"]
        if any(not isinstance(item, dict) for item in results):
            raise RuntimeError(f"{qid}: malformed retrieval hit; run invalid")
        docids: list[str] = []
        seen = set()
        for item in results:
            beir_id = parse_beir_id(item.get("title"))
            if not beir_id and manifest:
                system_id = item.get("document_id") or item.get("documentId") or item.get("docId")
                beir_id = manifest.get(str(system_id)) if system_id else None
            if not beir_id:
                raise RuntimeError(f"{qid}: nonempty hit cannot be mapped to a BEIR corpus ID; run invalid")
            if beir_id in seen:
                continue
            seen.add(beir_id)
            docids.append(beir_id)
        return qid, docids

    run: dict[str, list[str]] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for index, (qid, docids) in enumerate(pool.map(query_one, qids), start=1):
            run[qid] = docids
            if index % 50 == 0:
                print(f"[retrieve] {index}/{len(qids)}", flush=True)
    if set(run) != set(qids):
        raise RuntimeError("retrieval query count mismatch; run invalid")
    return run


def write_run(path: Path, run: dict[str, list[str]]):
    with path.open("w", encoding="utf-8") as handle:
        for qid in sorted(run.keys()):
            handle.write(json.dumps({"qid": qid, "docids": run[qid]}, ensure_ascii=False) + "\n")


def _selftest() -> int:
    assert parse_beir_id(build_beir_title("d1", "标题")) == "d1"
    assert parse_beir_id("[BEIR:d2]") == "d2"
    assert parse_beir_id("no marker") is None
    assert parse_beir_id("") is None
    selected = select_corpus_ids(
        {"d1": {}, "d2": {}, "d3": {}, "d4": {}},
        {"q1": {"d3": 1}},
        limit_docs=2,
        limit_queries=1,
        seed=42,
    )
    assert "d3" in selected and len(selected) == 2
    try:
        select_corpus_ids(
            {"d1": {}, "d2": {}},
            {"q1": {"d1": 1, "d2": 1}},
            limit_docs=1,
        )
        raise AssertionError("gold-preserving selection should reject an undersized limit")
    except ValueError:
        pass

    from unittest.mock import patch

    class FakeClient:
        def __init__(self, response):
            self.response = response
        def _request(self, *args, **kwargs):
            if isinstance(self.response, Exception):
                raise self.response
            return self.response

    class MixedIngestClient:
        def _request(self, path, method, body):
            if 'd2' in body['title']:
                raise OSError('offline')
            return 201, '{"documents": [{"id": "system-d1"}]}'
    partial_manifest, failures = ingest_corpus(MixedIngestClient(), 'kb',
        {"d1": {"text": "one"}, "d2": {"text": "two"}}, workers=1)
    assert partial_manifest == {"system-d1": "d1"}
    assert len(failures) == 1 and failures[0]['doc_id'] == 'd2'

    queries, judgments = {"q": "question"}, {"q": {"d": 1}}
    # A legitimate empty ranking is measurable; environment errors are not.
    assert retrieve_run(FakeClient((200, '{"results": []}')), "kb", queries, judgments) == {"q": []}
    assert retrieve_run(FakeClient((200, '{"results": [{"title": "[BEIR:d]", "documentId": "x"}]}')),
                        "kb", queries, judgments) == {"q": ["d"]}
    assert retrieve_run(FakeClient((200, '{"results": [{"title": "original", "documentId": "system"}]}')),
                        "kb", queries, judgments, manifest={"system": "d"}) == {"q": ["d"]}
    for response in ((401, '{}'), (403, '{}'), (500, '{}'), (200, 'invalid'),
                     (200, '{}'), (200, '{"results": [null]}'), (200, '{"results": [{"title": "unmapped"}]}'), OSError("transport")):
        with patch("time.sleep"):
            try:
                retrieve_run(FakeClient(response), "kb", queries, judgments)
            except RuntimeError:
                pass
            else:
                raise AssertionError(f"invalid retrieval response accepted: {response}")
    try:
        retrieve_run(FakeClient((200, '{"results": []}')), "kb", {}, judgments)
    except ValueError:
        pass
    else:
        raise AssertionError("missing qrels query silently skipped")
    for budget in (None, 100):
        try:
            select_corpus_ids({"d": {}}, {"q": {"missing": 1}}, limit_docs=budget)
        except ValueError:
            pass
        else:
            raise AssertionError("unlimited corpus selector missed absent positive gold")
    for status in (200, 401):
        client = ApiClient("http://offline-fixture", "user", "password")
        with patch.dict(os.environ, {"LLMWIKI_TOKEN": "fixture"}), patch.object(
                client, "_request", return_value=(status, '{}')):
            if status == 200:
                assert client.login() == "fixture"
            else:
                try:
                    client.login()
                except RuntimeError:
                    pass
                else:
                    raise AssertionError("expired preset token accepted")

    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "qrels").mkdir()
        (root / "corpus.jsonl").write_text(
            json.dumps({"_id": "d1", "title": "T", "text": "body"}, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        (root / "queries.jsonl").write_text(
            json.dumps({"_id": "q1", "text": "query"}, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        (root / "qrels" / "test.tsv").write_text(
            "query-id\tcorpus-id\tscore\nq1\td1\t1\n", encoding="utf-8"
        )
        corpus, queries, qrels = load_beir(root)
        assert list(corpus) == ["d1"] and queries["q1"] == "query"
        assert qrels["q1"]["d1"] == 1.0
        (root / "qrels" / "test.tsv").write_text("query-id\tcorpus-id\tscore\nq1\tmissing\t1\n")
        try:
            load_beir(root)
        except ValueError:
            pass
        else:
            raise AssertionError("loader silently accepted missing positive gold")
    print("beir_pipeline selftest OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="BEIR ingestion + retrieval pipeline")
    parser.add_argument("--dataset-dir", type=Path)
    parser.add_argument("--api-base", default="http://127.0.0.1:3000")
    parser.add_argument("--user", default="admin")
    parser.add_argument("--password", default="123456")
    parser.add_argument("--kb-id")
    parser.add_argument("--ingest", action="store_true")
    parser.add_argument("--limit-docs", type=int)
    parser.add_argument("--limit-queries", type=int)
    parser.add_argument("--top-k", type=int, default=100)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--run-out", type=Path, default=Path("beir_run.jsonl"))
    parser.add_argument("--manifest-out", type=Path)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--readiness-timeout", type=int, default=7200)
    parser.add_argument("--readiness-poll", type=int, default=10)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return _selftest()
    if not args.dataset_dir:
        parser.error("--dataset-dir is required unless --selftest")
    if not args.kb_id:
        parser.error("--kb-id is required")

    for name in ("limit_docs", "limit_queries", "top_k", "workers"):
        value = getattr(args, name)
        if value is not None and value <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if args.top_k > 100:
        parser.error("--top-k cannot exceed the native search limit of 100")
    # A failed attempt must not leave an older output at the advertised path.
    if args.run_out.exists():
        parser.error("--run-out already exists; use a fresh path for each evaluation")
    corpus, queries, qrels = load_beir(args.dataset_dir)
    print(f"[data] corpus={len(corpus)} queries={len(queries)} qrels={len(qrels)}")
    client = ApiClient(args.api_base, args.user, args.password)
    client.login()

    manifest: dict[str, str] = {}
    if args.ingest:
        started = time.time()
        ready_before = ready_beir_count(client, args.kb_id)
        selected_ids = select_corpus_ids(
            corpus,
            qrels,
            limit_docs=args.limit_docs,
            limit_queries=args.limit_queries,
            seed=args.seed,
        )
        manifest, failures = ingest_corpus(
            client, args.kb_id, corpus, ids=selected_ids, workers=args.workers,
        )
        if failures:
            sample = "; ".join(f"{f['doc_id']}: {f['error']}" for f in failures[:5])
            raise SystemExit(f"[ingest] {len(failures)}/{len(selected_ids)} submissions failed; aborting: {sample}")
        if len(manifest) != len(selected_ids):
            raise SystemExit(
                f"[ingest] manifest mismatch: expected {len(selected_ids)}, got {len(manifest)}"
            )
        print(f"[ingest] submitted {len(selected_ids)} documents in {time.time() - started:.1f}s")
        if args.manifest_out:
            args.manifest_out.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        wait_for_ready(
            client,
            args.kb_id,
            ready_before + len(selected_ids),
            timeout_seconds=args.readiness_timeout,
            poll_seconds=args.readiness_poll,
        )
    elif args.manifest_out and args.manifest_out.exists():
        manifest = json.loads(args.manifest_out.read_text(encoding="utf-8"))

    run = retrieve_run(
        client, args.kb_id, queries, qrels,
        manifest=manifest,
        top_k=args.top_k, workers=args.workers, limit_queries=args.limit_queries,
    )
    write_run(args.run_out, run)
    print(f"[done] wrote run file: {args.run_out} ({len(run)} queries)")
    print(
        "Next: python3 standard_ir_eval.py "
        f"--qrels {args.dataset_dir}/qrels/test.tsv --run {args.run_out} --k 1,5,10,100"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
