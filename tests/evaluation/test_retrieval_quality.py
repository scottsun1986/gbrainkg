"""
LLMWiki Golden Evaluation — Three-Stage Independent Quality Assessment
=====================================================================
Stage 0 (Ranking):   Independent retrieval ranking via POST /chat/search:
                     Recall@5, Recall@10, MRR@10, nDCG@10 (binary relevance
                     against expected_doc_titles)
Stage 1 (End-to-End): Hit Rate@5, MRR@10, Context Recall, Context Precision
                     from the final chat citations
Stage 2 (Generation): Keyword Coverage, Faithfulness (sentence-level
                     groundedness), Hallucination Detection

API failures are recorded as 0 scores and counted as failures in the summary
(never skipped).

Usage:
    # Live evaluation against running LLMWiki instance
    TEST_PORT=3202 pytest tests/evaluation/test_retrieval_quality.py -v

    # Dry-run (no API required, validates dataset & framework only)
    pytest tests/evaluation/test_retrieval_quality.py -v --dry-run

    # Smoke: limit number of cases
    EVAL_LIMIT=1 pytest tests/evaluation/test_retrieval_quality.py -v

    # Scope /chat/search ranking calls to specific KB ids (comma separated)
    EVAL_KB_SCOPE="kb-id-1,kb-id-2" pytest tests/evaluation/test_retrieval_quality.py -v

    # Run specific category
    pytest tests/evaluation/test_retrieval_quality.py -v -k "exact_clause"

    # Custom golden dataset
    pytest tests/evaluation/test_retrieval_quality.py --golden-file=my_dataset.json

    # Real (judge-based) faithfulness instead of the substring proxy
    EVAL_LLM_JUDGE=true pytest tests/evaluation/test_retrieval_quality.py -v
"""

import os
import re
import json
import math
import time
import uuid
import subprocess
import pytest
import requests
from typing import Any
from datetime import datetime, timezone

# ── Result collection ──────────────────────────────────────────────

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "results")
os.makedirs(RESULTS_DIR, exist_ok=True)

_all_results: list[dict] = []


def _git_commit() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=os.path.dirname(__file__),
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


# Run provenance: stable per pytest session, written into the results file.
_RUN_META = {
    "runId": str(uuid.uuid4()),
    "gitCommit": _git_commit(),
}


# ── Parametrize from golden dataset ────────────────────────────────

def pytest_generate_tests(metafunc):
    if "test_case" in metafunc.fixturenames:
        golden_file = metafunc.config.getoption("golden_file")
        if not os.path.isabs(golden_file):
            golden_file = os.path.join(os.path.dirname(__file__), golden_file)

        with open(golden_file, "r", encoding="utf-8") as f:
            dataset = json.load(f)

        # EVAL_LIMIT: restrict to the first N cases (smoke runs).
        limit = int(os.environ.get("EVAL_LIMIT", "0") or 0)
        if limit > 0:
            dataset = dataset[:limit]

        metafunc.parametrize("test_case", dataset,
                             ids=[c["id"] for c in dataset])


# ── Chat API caller with SSE parsing ──────────────────────────────

def call_chat_api(api_base: str, token: str, query: str,
                  timeout: float = 60.0) -> dict[str, Any]:
    """
    Call POST /chat/completions, parse the SSE stream, and return
    structured result with answer text, citations, and trace steps.
    """
    url = f"{api_base}/chat/completions"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
    }
    payload = {"message": query}

    answer_parts: list[str] = []
    citations: list[dict] = []
    trace_steps: list[dict] = []
    ttft: float | None = None
    t0 = time.time()

    resp = requests.post(url, json=payload, headers=headers,
                         stream=True, timeout=timeout)
    resp.raise_for_status()

    for raw_line in resp.iter_lines():
        if not raw_line:
            continue
        line = raw_line.decode("utf-8", errors="replace")
        if not line.startswith("data: "):
            continue
        data_str = line[6:]
        if data_str.strip() == "[DONE]":
            break
        try:
            evt = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        evt_type = evt.get("type") or evt.get("event")

        # Collect answer tokens
        if evt_type in ("delta", "token", "content", None):
            delta = (evt.get("choices", [{}])[0]
                     .get("delta", {})
                     .get("content", "")
                     if "choices" in evt
                     else evt.get("content", ""))
            if delta:
                if ttft is None:
                    ttft = time.time() - t0
                answer_parts.append(delta)

        # Collect citations
        elif evt_type == "citation":
            citations.append(evt)
        elif evt_type == "citations":
            c_list = evt.get("citations", evt.get("data", []))
            if isinstance(c_list, list):
                citations.extend(c_list)

        # Collect trace steps
        elif evt_type == "trace":
            trace_steps.append(evt)

        # Done event with metadata
        elif evt_type == "done":
            if "citations" in evt and isinstance(evt["citations"], list):
                citations.extend(evt["citations"])

    total_time = time.time() - t0
    answer = "".join(answer_parts)

    # Extract cited document titles from citations
    cited_doc_titles: list[str] = []
    for c in citations:
        tle = c.get("timeline_entry", {}) if isinstance(c, dict) and isinstance(c.get("timeline_entry"), dict) else {}
        title = (tle.get("doc_title")
                 or c.get("doc_title")
                 or c.get("docTitle")
                 or c.get("title") or "")
        if title and title not in cited_doc_titles:
            cited_doc_titles.append(title)

    return {
        "answer": answer,
        "citations": citations,
        "cited_doc_titles": cited_doc_titles,
        "trace_steps": trace_steps,
        "ttft_sec": ttft,
        "total_sec": total_time,
    }


# ── Retrieval ranking API caller (independent of chat generation) ──

def call_search_api(api_base: str, token: str, query: str,
                    kb_scope: list[str] | None = None,
                    limit: int = 10, timeout: float = 30.0) -> list[str]:
    """
    Call POST /chat/search and return document titles in ranked order.

    Response shape (ChatController.searchKnowledge -> searchKnowledgeForAgent):
    {"success": bool, "query": str, "total": int,
     "results": [{"documentId", "kbId", "title", "evidence", "score", ...}]}
    """
    url = f"{api_base}/chat/search"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {"query": query, "limit": limit}
    if kb_scope:
        payload["kb_scope"] = kb_scope

    resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    resp.raise_for_status()
    body = resp.json()
    rows = body.get("results") if isinstance(body, dict) else body
    if not isinstance(rows, list):
        raise ValueError(f"Unexpected /chat/search response shape: {str(body)[:200]}")
    titles = [str(r.get("title") or "").strip() for r in rows if isinstance(r, dict)]
    return [t for t in titles if t]


def compute_ranking_metrics(
    ranked_titles: list[str],
    expected_docs: list[str],
) -> dict[str, float]:
    """Stage 0: retrieval ranking metrics with binary relevance."""
    if not expected_docs:
        # No gold documents declared: vacuously perfect ranking.
        return {"rank_recall_5": 1.0, "rank_recall_10": 1.0,
                "rank_mrr_10": 1.0, "rank_ndcg_10": 1.0}

    def recall_at(k: int) -> float:
        top_k = ranked_titles[:k]
        found = sum(1 for ed in expected_docs
                    if any(_fuzzy_doc_match(t, [ed]) for t in top_k))
        return found / len(expected_docs)

    mrr = 0.0
    for i, title in enumerate(ranked_titles[:10]):
        if _fuzzy_doc_match(title, expected_docs):
            mrr = 1.0 / (i + 1)
            break

    dcg = 0.0
    matched_expected: set[str] = set()
    for i, title in enumerate(ranked_titles[:10]):
        for ed in expected_docs:
            if ed in matched_expected:
                continue
            if _fuzzy_doc_match(title, [ed]):
                # Binary relevance: each gold document contributes gain once,
                # at its best rank. Multiple chunks of the same document must
                # not stack DCG gains beyond the ideal.
                dcg += 1.0 / math.log2(i + 2)
                matched_expected.add(ed)
                break
    ideal_hits = min(len(expected_docs), 10)
    idcg = sum(1.0 / math.log2(i + 2) for i in range(ideal_hits))
    ndcg = dcg / idcg if idcg > 0 else 0.0

    return {"rank_recall_5": recall_at(5), "rank_recall_10": recall_at(10),
            "rank_mrr_10": mrr, "rank_ndcg_10": ndcg}


# ── Faithfulness: sentence-level groundedness ─────────────────────
#
# Why this exists
# ---------------
# Faithfulness used to be `(# must_contain_snippets found verbatim in the
# answer) / len(must_contain_snippets)`. On Chinese answers that collapses to
# ~0 even when the answer is correct and fully grounded, because the model
# paraphrases instead of copying the gold snippet: the 0.1125 in
# results/latest_results.json measured wording, not grounding. That substring
# rate is still reported, under its honest name `snippet_match_rate`, and
# `faithfulness` is now either a judge-scored entailment ratio or None. A metric
# that was not measured must never be reported as if it were.

# Opt-in: the judge needs a live model route and spends tokens per answer, so
# the suite must keep running fully offline by default.
FAITHFULNESS_JUDGE_ENV = "EVAL_LLM_JUDGE"
FAITHFULNESS_JUDGE_TIMEOUT = float(os.environ.get("EVAL_LLM_JUDGE_TIMEOUT", "60"))
_API_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "api", ".env")
_api_env_cache: dict[str, str] | None = None

# Refusal language (shared with the no-answer path of stage 2). A refusal
# asserts nothing about the corpus, so it has no claim to entail.
REFUSAL_PHRASES = [
    "未检索到", "未包含", "无法回答", "没有找到", "不包含",
    "未找到", "资料中未", "当前知识库", "暂无", "无相关",
]

# Fenced code is masked before splitting: its `.`/`?` would otherwise shred a
# sentence mid-block, and source code is not a factual claim about the corpus.
_FENCE_RE = re.compile(r"```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)")

# Sentence boundaries. CJK terminators split unconditionally; an ASCII period
# only splits when followed by whitespace or end of text, which keeps decimals
# ("3.5%"), versions ("v1.2.3") and dotted names ("example.com") intact.
# Newlines end a unit too, so list items and table rows are judged separately.
_SENTENCE_SPLIT_RE = re.compile(
    r"(?<=[。！？])"
    r"|(?<=[.!?])(?=\s|$)"
    r"|\n+"
)
# A fragment must carry a letter or CJK character to be a claim; this drops
# list markers ("1."), table separators ("|---|") and bare citations ("[2]").
_CLAIM_CONTENT_RE = re.compile(r"[A-Za-z一-鿿]")


def faithfulness_judge_enabled() -> bool:
    """Read at call time so a test (or a sharded run) can toggle it per process."""
    return os.environ.get(FAITHFULNESS_JUDGE_ENV, "").strip().lower() in ("1", "true", "yes")


def _api_env_file_values() -> dict[str, str]:
    """Parse apps/api/.env once, mirroring loadApiEnv() in llm-client.ts.

    The judge must use the same route the runtime is configured with, and the
    process environment wins over the file (as in llm-client.ts). The file is
    only read when the judge is actually enabled.
    """
    global _api_env_cache
    if _api_env_cache is not None:
        return _api_env_cache
    values: dict[str, str] = {}
    line_re = re.compile(r"""^\s*([A-Z][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#]*))\s*$""")
    try:
        with open(_API_ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                m = line_re.match(line.rstrip("\r\n"))
                if not m:
                    continue
                value = m.group(2) if m.group(2) is not None else (
                    m.group(3) if m.group(3) is not None else (m.group(4) or "").strip())
                values[m.group(1)] = value
    except OSError:
        pass  # CI may provide the route through the environment instead.
    _api_env_cache = values
    return values


def _judge_route() -> dict[str, Any] | None:
    """Resolve the judge route exactly as llmConfig() in llm-client.ts does."""
    file_env = _api_env_file_values()

    def get(key: str) -> str:
        return os.environ.get(key) or file_env.get(key) or ""

    base_url = get("LLM_BASE_URL").rstrip("/")
    api_key = get("DEEPSEEK_API_KEY") or get("LLM_API_KEY")
    model = get("LLM_MODEL")
    if not (base_url and api_key and model):
        return None
    return {"base_url": base_url, "model": model, "api_key": api_key}


def strip_code_fences(text: str) -> str:
    """Mask fenced code so a fence never contributes a sentence boundary."""
    return _FENCE_RE.sub(" ", text)


def split_sentences(text: str) -> list[str]:
    """Split an answer into sentence-level claims for entailment scoring.

    CJK terminators (。！？) and English (.!?) end a sentence; decimals and
    versions do not, and nothing inside a code fence is split (or judged).
    Fragments with no letter/CJK content are dropped: a list marker or a bare
    citation carries no assertion, and counting it would inflate the
    denominator.
    """
    if not text or not text.strip():
        return []
    sentences: list[str] = []
    for part in _SENTENCE_SPLIT_RE.split(strip_code_fences(text)):
        frag = (part or "").strip()
        if frag and _CLAIM_CONTENT_RE.search(frag):
            sentences.append(frag)
    return sentences


def has_refusal(answer: str) -> bool:
    return any(p in answer for p in REFUSAL_PHRASES)


def _citation_evidence(citations: list[dict], max_chars: int = 800, max_docs: int = 8) -> str:
    """Numbered evidence text for the judge (same bounds as quality-gate.ts)."""
    lines: list[str] = []
    for c in citations or []:
        if len(lines) >= max_docs:
            break
        if not isinstance(c, dict):
            continue
        tle = c.get("timeline_entry") if isinstance(c.get("timeline_entry"), dict) else {}
        title = tle.get("doc_title") or c.get("doc_title") or c.get("docTitle") or c.get("title") or ""
        snippet = str(tle.get("snippet") or c.get("snippet") or c.get("evidence") or "").strip()
        if not snippet:
            # A title alone cannot entail a claim; offering it would let the
            # judge "support" sentences on document names.
            continue
        lines.append(f"[{len(lines) + 1}] 《{title or '未命名文档'}》 {snippet[:max_chars]}")
    return "\n".join(lines)


_JUDGE_SYSTEM = (
    "You are an independent groundedness judge. For each numbered answer sentence, "
    "decide whether it is entailed by the evidence snippets alone. Do not use outside "
    "knowledge. Paraphrase, synonyms and different word order do NOT count against a "
    "sentence; a fact, number or condition the evidence does not state does. "
    'Reply in JSON only: {"verdicts": [true, false, ...]} with exactly one boolean per '
    "sentence, in order."
)


def _parse_verdicts(reply: Any, expected: int) -> list[bool] | None:
    """One boolean per sentence, or None.

    The verdict table is recounted here instead of trusting a judge-computed
    score. A table of the wrong length is rejected rather than scored, because
    a short table would silently shrink the denominator.
    """
    if not isinstance(reply, dict) or "error" in reply:
        return None
    rows = reply.get("verdicts")
    if not isinstance(rows, list) or len(rows) != expected:
        return None
    out: list[bool] = []
    for row in rows:
        if isinstance(row, dict):
            row = row.get("entailed", row.get("supported"))
        if not isinstance(row, bool):
            return None
        out.append(row)
    return out


def _load_judge_transport():
    """Reuse query_llm_judge from the intl-benchmark suite (no third client).

    Imported lazily: that module creates its reports dir and parses
    RAGAS_KB_SCOPES at import time, which an offline run must not depend on.
    """
    import sys
    bench_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "intl-benchmark")
    if bench_dir not in sys.path:
        sys.path.insert(0, bench_dir)
    from answer_quality_heuristic_suite import query_llm_judge  # noqa: E402
    return query_llm_judge


def judge_faithfulness(
    answer: str,
    citations: list[dict],
    *,
    transport=None,
) -> tuple[float | None, str]:
    """Sentence-level groundedness: fraction of answer sentences entailed by
    the evidence the system actually retrieved.

    Returns (score, note). score is None whenever the judge did not produce a
    usable verdict, so a judge outage surfaces as "not measured" instead of a
    0.0 that would read as measured unfaithfulness. Scoring is against the
    retrieved snippets, never the golden must_contain_snippets: grading against
    gold text would reward copying it, not following the sources.
    """
    route = _judge_route()
    if route is None:
        return None, "no LLM route (LLM_BASE_URL / DEEPSEEK_API_KEY|LLM_API_KEY / LLM_MODEL)"
    if has_refusal(answer):
        return 1.0, "refusal: no claim to entail"
    sentences = split_sentences(answer)
    if not sentences:
        return None, "no judgeable sentence"
    evidence = _citation_evidence(citations)
    if not evidence:
        # Claims with no retrieved evidence are ungrounded by construction; this
        # mirrors the no-citation branch of quality-gate.ts.
        return 0.0, "no retrieved evidence"
    numbered = "\n".join(f"{i + 1}. {s}" for i, s in enumerate(sentences))
    prompt = f"Evidence snippets:\n{evidence}\n\nAnswer sentences:\n{numbered}\n\nReturn the JSON verdicts."
    try:
        send = transport or _load_judge_transport()
        reply = send(prompt, _JUDGE_SYSTEM, route["model"], route["base_url"], route["api_key"],
                     timeout=FAITHFULNESS_JUDGE_TIMEOUT)
    except Exception as e:  # transport, import or HTTP failure: unmeasured, not zero
        return None, f"judge error: {e}"
    verdicts = _parse_verdicts(reply, len(sentences))
    if verdicts is None:
        err = reply.get("error") if isinstance(reply, dict) else None
        return None, f"judge error: {err}" if err else "judge reply unusable"
    return sum(verdicts) / len(sentences), f"llm entailment {sum(verdicts)}/{len(sentences)}"


# ── Metric calculators ────────────────────────────────────────────

def compute_retrieval_metrics(
    cited_docs: list[str],
    expected_docs: list[str],
    forbidden_docs: list[str],
) -> dict[str, float]:
    """Stage 1: Retrieval-only quality metrics."""
    if not expected_docs:
        # No-answer / negative cases: success = no irrelevant citations
        return {
            "hit_rate_5": 1.0,
            "mrr_10": 1.0,
            "context_recall": 1.0,
            "context_precision": 1.0 if not cited_docs else 0.0,
        }

    # Hit Rate@5: at least one expected doc in top-5 citations
    top5 = cited_docs[:5]
    hit = any(_fuzzy_doc_match(c, expected_docs) for c in top5)
    hit_rate = 1.0 if hit else 0.0

    # MRR@10: reciprocal rank of first relevant citation
    mrr = 0.0
    for i, c in enumerate(cited_docs[:10]):
        if _fuzzy_doc_match(c, expected_docs):
            mrr = 1.0 / (i + 1)
            break

    # Context Recall: fraction of expected docs found
    found = sum(1 for ed in expected_docs
                if any(_fuzzy_doc_match(cd, [ed]) for cd in cited_docs))
    recall = found / len(expected_docs)

    # Context Precision: fraction of cited docs that are relevant
    relevant_cited = sum(1 for cd in cited_docs
                        if _fuzzy_doc_match(cd, expected_docs))
    precision = (relevant_cited / len(cited_docs)) if cited_docs else 1.0

    return {
        "hit_rate_5": hit_rate,
        "mrr_10": mrr,
        "context_recall": recall,
        "context_precision": precision,
    }


def compute_generation_metrics(
    answer: str,
    expected_keywords: list[str],
    must_contain: list[str],
    cited_docs: list[str],
    forbidden_docs: list[str],
    is_no_answer: bool = False,
    citations: list[dict] | None = None,
    judge_enabled: bool | None = None,
    judge_transport=None,
) -> dict[str, Any]:
    """Stage 2: Generation-only quality metrics.

    `faithfulness` is the judge-scored sentence-level groundedness, or None
    when it was not measured (judge off, dry run, or judge outage);
    `faithfulness_measured` says which. `snippet_match_rate` is the former
    substring proxy, kept under its own name so trend data stays comparable.
    """
    if judge_enabled is None:
        judge_enabled = faithfulness_judge_enabled()

    if is_no_answer:
        # For no-answer cases: answer should contain refusal language
        refused = has_refusal(answer)
        if judge_enabled:
            # A correct refusal is fully faithful; any non-refusal on a question
            # the corpus cannot answer is fabricated by definition (the same
            # rule the quality-gate.ts judge prompt applies).
            faith: float | None = 1.0 if refused else 0.0
            note = "no-answer case: scored on refusal"
        else:
            faith, note = None, f"not measured ({FAITHFULNESS_JUDGE_ENV} off)"
        return {
            "keyword_hit_rate": 1.0 if refused else 0.0,
            "snippet_match_rate": 1.0 if refused else 0.0,
            "faithfulness": faith,
            "faithfulness_measured": faith is not None,
            "faithfulness_note": note,
            "hallucination": not refused,
            "hallucinated_docs": [],
        }

    # Keyword coverage
    kw_hits = sum(1 for kw in expected_keywords if kw in answer)
    kw_rate = kw_hits / max(len(expected_keywords), 1)

    # Snippet match rate: verbatim substring hits on gold snippets. Measures
    # wording overlap, NOT grounding — never report it as faithfulness.
    snip_hits = sum(1 for s in must_contain if s in answer)
    snippet_rate = snip_hits / max(len(must_contain), 1)

    # Faithfulness: sentence-level entailment against the retrieved evidence.
    if judge_enabled:
        faith, note = judge_faithfulness(answer, citations or [], transport=judge_transport)
    else:
        faith, note = None, f"not measured ({FAITHFULNESS_JUDGE_ENV} off)"

    # Hallucination: cited a forbidden doc?
    halluc_docs = [fd for fd in forbidden_docs
                   if any(_fuzzy_doc_match(cd, [fd]) for cd in cited_docs)]

    return {
        "keyword_hit_rate": kw_rate,
        "snippet_match_rate": snippet_rate,
        "faithfulness": faith,
        "faithfulness_measured": faith is not None,
        "faithfulness_note": note,
        "hallucination": len(halluc_docs) > 0,
        "hallucinated_docs": halluc_docs,
    }


def _fuzzy_doc_match(cited: str, expected_list: list[str]) -> bool:
    """Fuzzy match: cited doc title contains or is contained by an expected title."""
    cited_lower = cited.lower().strip()
    for exp in expected_list:
        exp_lower = exp.lower().strip()
        if exp_lower in cited_lower or cited_lower in exp_lower:
            return True
    return False


# ── Main test function ─────────────────────────────────────────────

def test_quality(test_case, auth_token, api_base_url, eval_kb_scope,
                 sse_parser, request):
    """
    Execute a single golden evaluation case:
    0. Query POST /chat/search and compute ranking metrics (Stage 0)
    1. Call the chat API (or simulate in dry-run mode)
    2. Compute end-to-end retrieval metrics (Stage 1)
    3. Compute generation metrics (Stage 2)
    4. Accumulate results for final report

    API exceptions are recorded as 0 scores and failure — never skipped.
    """
    dry_run = request.config.getoption("dry_run", default=False)
    is_no_answer = test_case["category"] == "no_answer"
    search_error: str | None = None
    chat_error: str | None = None

    if dry_run:
        # Dry-run: use ground truth as simulated ranking/answer
        ranked_titles = list(test_case["expected_doc_titles"])
        answer = test_case["ground_truth_answer"]
        cited_docs = list(test_case["expected_doc_titles"])
        # No retrieved evidence exists in a dry run, so groundedness cannot be
        # measured; the judge is forced off below rather than scoring 0.0.
        citations: list[dict] = []
        ttft = 0.0
        total_time = 0.0
    else:
        # Stage 0: independent retrieval ranking (no generation involved)
        try:
            ranked_titles = call_search_api(api_base_url, auth_token,
                                            test_case["query"], eval_kb_scope)
        except Exception as e:
            ranked_titles = []
            search_error = f"chat/search: {e}"

        # End-to-end chat completion
        try:
            result = call_chat_api(api_base_url, auth_token,
                                   test_case["query"])
            answer = result["answer"]
            cited_docs = result["cited_doc_titles"]
            citations = result["citations"]
            ttft = result["ttft_sec"]
            total_time = result["total_sec"]
        except Exception as e:
            answer = ""
            cited_docs = []
            citations = []
            ttft = None
            total_time = None
            chat_error = f"chat/completions: {e}"

    # Stage 0 metrics: zeroed on API failure so the case counts as a failure.
    if search_error:
        ranking = {"rank_recall_5": 0.0, "rank_recall_10": 0.0,
                   "rank_mrr_10": 0.0, "rank_ndcg_10": 0.0}
    else:
        ranking = compute_ranking_metrics(
            ranked_titles=ranked_titles,
            expected_docs=test_case["expected_doc_titles"],
        )

    # Stage 1 + 2 metrics: zeroed on chat API failure.
    if chat_error:
        retrieval = {"hit_rate_5": 0.0, "mrr_10": 0.0,
                     "context_recall": 0.0, "context_precision": 0.0}
        # API failures score 0 (never skipped). Faithfulness follows the same
        # rule only when it is being measured at all; otherwise it stays None
        # so an offline run never reports a groundedness number.
        failed_faith = 0.0 if (faithfulness_judge_enabled() and not dry_run) else None
        generation = {"keyword_hit_rate": 0.0, "snippet_match_rate": 0.0,
                      "faithfulness": failed_faith,
                      "faithfulness_measured": failed_faith is not None,
                      "faithfulness_note": "chat API failure",
                      "hallucination": True, "hallucinated_docs": []}
    else:
        # Stage 1: End-to-end retrieval metrics
        retrieval = compute_retrieval_metrics(
            cited_docs=cited_docs,
            expected_docs=test_case["expected_doc_titles"],
            forbidden_docs=test_case.get("forbidden_doc_titles", []),
        )

        # Stage 2: Generation metrics
        generation = compute_generation_metrics(
            answer=answer,
            expected_keywords=test_case["expected_keywords"],
            must_contain=test_case["must_contain_snippets"],
            cited_docs=cited_docs,
            forbidden_docs=test_case.get("forbidden_doc_titles", []),
            is_no_answer=is_no_answer,
            citations=citations,
            judge_enabled=faithfulness_judge_enabled() and not dry_run,
        )

    api_error = search_error or chat_error

    # Combine result
    case_result = {
        "id": test_case["id"],
        "category": test_case["category"],
        "query": test_case["query"],
        "difficulty": test_case.get("difficulty", "medium"),
        # Cases whose gold document is absent from this environment measure the corpus,
        # not the system (see flag_corpus_absent_cases.py and the 2026-09-12 acceptance
        # report). They stay in `results` but are excluded from the aggregate metrics.
        "corpus_absent": bool(test_case.get("corpus_absent")),
        "dry_run": dry_run,
        "failure": bool(api_error),
        "api_error": api_error,
        # Stage 0: independent ranking
        **ranking,
        # Stage 1: end-to-end retrieval
        "hit_rate_5": retrieval["hit_rate_5"],
        "mrr_10": retrieval["mrr_10"],
        "context_recall": retrieval["context_recall"],
        "context_precision": retrieval["context_precision"],
        # Stage 2
        "keyword_hit_rate": generation["keyword_hit_rate"],
        "snippet_match_rate": generation["snippet_match_rate"],
        "faithfulness": generation["faithfulness"],
        "faithfulness_measured": generation["faithfulness_measured"],
        "faithfulness_note": generation["faithfulness_note"],
        "hallucination": generation["hallucination"],
        # Performance
        "ttft_sec": ttft,
        "total_sec": total_time,
    }
    _all_results.append(case_result)

    # Persist incrementally
    _write_results()

    # API failures must fail the case (already recorded as 0 scores above).
    assert api_error is None, \
        f"[{test_case['id']}] API failure (recorded as 0 score): {api_error}"

    # Assertions (soft: record failures but don't abort entire suite)
    if is_no_answer:
        assert not generation["hallucination"], \
            f"[{test_case['id']}] Hallucinated on no-answer question"
    else:
        # Retrieval assertion (informational — don't hard-fail individual cases)
        pass

    assert not generation["hallucination"], \
        f"[{test_case['id']}] Cited forbidden document: {generation.get('hallucinated_docs')}"


def _write_results():
    """Persist current results to disk (with run provenance for the gate)."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output = {
        **_RUN_META,
        "timestamp": timestamp,
        "timestamp_iso": datetime.now(timezone.utc).isoformat(),
        "dry_run": bool(_all_results) and all(r.get("dry_run") for r in _all_results),
        "total_cases": len(_all_results),
        "results": _all_results,
        "summary": _compute_summary(_all_results),
    }
    # EVAL_RESULTS_NAME lets the suite be sharded across processes for a large
    # (220-case) run without every shard overwriting the same artefact; the
    # shard files are merged afterwards with the same _compute_summary().
    results_name = os.environ.get("EVAL_RESULTS_NAME") or "latest_results.json"
    path = os.path.join(RESULTS_DIR, results_name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)


def _compute_summary(results: list[dict]) -> dict:
    """Compute aggregate metrics over the cases this environment can answer.

    Cases flagged `corpus_absent` expect documents that were never ingested here, so
    they cannot be answered by any system. Keeping them in the aggregate made
    `long_doc_completeness` / `scan_ocr_ppt` look like a 0% capability when in fact
    they are a corpus gap; they are reported separately instead.
    """
    if not results:
        return {}

    unanswerable = [r for r in results if r.get("corpus_absent")]
    results = [r for r in results if not r.get("corpus_absent")]

    n = len(results)
    if n == 0:
        # A shard can legitimately reach this point with only corpus-absent cases
        # processed so far (the results file is rewritten after every case). An
        # empty aggregate must be reported as empty — dividing by zero here used
        # to fail the *case* and, with it, the shard.
        return {
            "overall": {"count": 0},
            "by_category": {},
            "corpus_absent": {
                "count": len(unanswerable),
                "categories": sorted({str(r.get("category")) for r in unanswerable}),
                "note": "only corpus-absent cases recorded so far; no aggregate yet",
            },
        }
    by_category: dict[str, list[dict]] = {}
    for r in results:
        by_category.setdefault(r["category"], []).append(r)

    def avg(key: str, data: list[dict]) -> float:
        vals = [d[key] for d in data if isinstance(d.get(key), (int, float))]
        return sum(vals) / len(vals) if vals else 0.0

    def faith_stats(data: list[dict]) -> dict[str, Any]:
        """Faithfulness aggregates over *measured* rows only.

        avg() maps "no values" to 0.0, which would turn an unmeasured run into a
        measured 0% — so faithfulness is aggregated separately and is None when
        no row was measured. Rows written before `faithfulness_measured` existed
        carried the substring proxy in `faithfulness`; they count toward
        `snippet_match_rate` (their true meaning), never toward faithfulness.
        """
        measured = [d["faithfulness"] for d in data
                    if d.get("faithfulness_measured") is True
                    and isinstance(d.get("faithfulness"), (int, float))]
        snippet = [d["snippet_match_rate"] if "faithfulness_measured" in d else d.get("faithfulness")
                   for d in data]
        snippet = [v for v in snippet if isinstance(v, (int, float))]
        return {
            "faithfulness": sum(measured) / len(measured) if measured else None,
            "faithfulness_measured": bool(measured),
            # Fraction of cases the judge actually scored; < 1.0 means judge
            # outages, and the faithfulness mean covers only the scored cases.
            "faithfulness_coverage": len(measured) / len(data) if data else 0.0,
            "snippet_match_rate": sum(snippet) / len(snippet) if snippet else 0.0,
        }

    summary = {
        "overall": {
            "count": n,
            # Stage 0: independent retrieval ranking
            "rank_recall_5": avg("rank_recall_5", results),
            "rank_recall_10": avg("rank_recall_10", results),
            "rank_mrr_10": avg("rank_mrr_10", results),
            "rank_ndcg_10": avg("rank_ndcg_10", results),
            # Stage 1: end-to-end retrieval
            "hit_rate_5": avg("hit_rate_5", results),
            "mrr_10": avg("mrr_10", results),
            "context_recall": avg("context_recall", results),
            "context_precision": avg("context_precision", results),
            # Stage 2: generation
            "keyword_hit_rate": avg("keyword_hit_rate", results),
            **faith_stats(results),
            "hallucination_rate": sum(1 for r in results if r.get("hallucination")) / n,
            # API failures recorded as 0-score cases (must be 0 for the gate)
            "api_failure_count": sum(1 for r in results if r.get("failure")),
            "avg_ttft_sec": avg("ttft_sec", results),
            "avg_total_sec": avg("total_sec", results),
        },
        "by_category": {},
        "corpus_absent": {
            "count": len(unanswerable),
            "categories": sorted({str(r.get("category")) for r in unanswerable}),
            "note": "expected documents are not in this environment; excluded from the metrics above",
        },
    }

    for cat, cat_results in sorted(by_category.items()):
        summary["by_category"][cat] = {
            "count": len(cat_results),
            "rank_ndcg_10": avg("rank_ndcg_10", cat_results),
            "hit_rate_5": avg("hit_rate_5", cat_results),
            "mrr_10": avg("mrr_10", cat_results),
            **faith_stats(cat_results),
            "keyword_hit_rate": avg("keyword_hit_rate", cat_results),
        }

    return summary
