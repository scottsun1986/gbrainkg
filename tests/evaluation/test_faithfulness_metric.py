"""Unit tests for the sentence-level faithfulness metric in the golden suite.

These cover the metric itself (sentence splitting, entailment scoring, refusal
handling, aggregation), not the live API: the suite is expected to run offline,
so no test here reaches the network. What is asserted is the honesty contract —
a groundedness number is reported only when it was actually measured.

Run: python3 -m pytest tests/evaluation/test_faithfulness_metric.py -q
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_retrieval_quality as trq  # noqa: E402


# ── Fixtures / helpers ────────────────────────────────────────────

FAKE_ROUTE = {"base_url": "http://judge.invalid/v1", "model": "stub", "api_key": "k"}


@pytest.fixture
def judge_route(monkeypatch):
    """Pretend a model route is configured, so the judge path is reachable."""
    monkeypatch.setattr(trq, "_judge_route", lambda: FAKE_ROUTE)


class StubTransport:
    """Records prompts and replies with a canned judge verdict table."""

    def __init__(self, verdicts=None, payload=None):
        self.verdicts = verdicts
        self.payload = payload
        self.prompts = []

    def __call__(self, prompt, system, model, base_url, api_key, timeout=None):
        self.prompts.append(prompt)
        if self.payload is not None:
            return self.payload
        return {"verdicts": list(self.verdicts or [])}


def citations(*snippets):
    return [{"timeline_entry": {"doc_title": f"文档{i}", "snippet": s}}
            for i, s in enumerate(snippets, start=1)]


# ── Sentence splitting ────────────────────────────────────────────

def test_splits_chinese_sentences_on_cjk_terminators():
    text = "第一条规定了考核原则。第二条说明了具体指标！第三条适用于全公司？"
    assert trq.split_sentences(text) == [
        "第一条规定了考核原则。",
        "第二条说明了具体指标！",
        "第三条适用于全公司？",
    ]


def test_splits_english_sentences_on_latin_terminators():
    text = "The policy applies to all staff. It took effect in 2024! Was it revised?"
    got = trq.split_sentences(text)
    assert len(got) == 3
    assert got[0].startswith("The policy applies")
    assert got[1] == "It took effect in 2024!"
    assert got[2] == "Was it revised?"


def test_does_not_split_decimals_versions_or_dotted_names():
    text = "覆盖率提升到 3.5% 后趋于稳定。Version 1.2.3 shipped from example.com today."
    got = trq.split_sentences(text)
    assert len(got) == 2, got
    assert "3.5%" in got[0]
    assert "1.2.3" in got[1] and "example.com" in got[1]


def test_does_not_split_inside_code_fence():
    text = (
        "配置如下。\n"
        "```python\n"
        "def f(x):\n"
        "    return x * 2.5\n"
        "```\n"
        "第二段说明结束。"
    )
    got = trq.split_sentences(text)
    assert all("return x * 2.5" not in s for s in got)
    assert got[0] == "配置如下。"
    assert got[-1] == "第二段说明结束。"


def test_unterminated_code_fence_is_still_masked():
    got = trq.split_sentences("答案如下。\n```\nprint(1.5)\n")
    assert all("print" not in s for s in got)


def test_drops_fragments_carrying_no_claim():
    # List markers, table separators and bare citations are not assertions.
    got = trq.split_sentences("1.\n|---|\n[2]\n制度自 2024 年起施行。")
    assert got == ["制度自 2024 年起施行。"]


def test_empty_answer_has_no_sentences():
    assert trq.split_sentences("") == []
    assert trq.split_sentences("   \n  ") == []


# ── Refusal detection ─────────────────────────────────────────────

def test_has_refusal_detects_chinese_refusal_language():
    assert trq.has_refusal("当前知识库中未包含相关信息，无法回答。")
    assert trq.has_refusal("资料中未找到该条款。")
    assert not trq.has_refusal("第 3 条规定了绩效考核的具体指标。")


def test_refusal_is_fully_faithful_when_judged(judge_route):
    # A refusal asserts nothing, so there is no claim that could be unsupported.
    score, note = trq.judge_faithfulness("未检索到相关内容，无法回答。", citations("无关片段"))
    assert score == 1.0
    assert "refusal" in note


# ── Judge off: report nothing rather than a proxy ─────────────────

def test_judge_off_reports_none_not_the_substring_proxy():
    # The paraphrase this metric exists for: "明确了考核原则" for gold snippets
    # "规定了" / "绩效考核". Substring matching scores it 0.0 despite the answer
    # being correct — exactly the collapse that made 0.1125 meaningless.
    answer = "软件研发中心绩效管理办法第 1 条明确了考核原则。"
    metrics = trq.compute_generation_metrics(
        answer=answer,
        expected_keywords=["考核原则", "具体指标"],
        must_contain=["规定了", "绩效考核"],
        cited_docs=["绩效管理办法"],
        forbidden_docs=[],
        judge_enabled=False,
    )
    assert metrics["snippet_match_rate"] == 0.0
    # The keyword arm half-matches on the same answer, so the 0.0 above is a
    # property of substring scoring, not of the answer being wrong.
    assert metrics["keyword_hit_rate"] == pytest.approx(0.5)
    # ...and that 0.0 is not allowed to answer to the name "faithfulness".
    assert metrics["faithfulness"] is None
    assert metrics["faithfulness_measured"] is False


def test_snippet_match_rate_counts_verbatim_hits_under_its_own_name():
    metrics = trq.compute_generation_metrics(
        answer="该办法规定了绩效考核的适用范围。",
        expected_keywords=["适用范围"],
        must_contain=["规定了", "绩效考核"],
        cited_docs=["绩效管理办法"],
        forbidden_docs=[],
        judge_enabled=False,
    )
    assert metrics["snippet_match_rate"] == 1.0
    assert metrics["faithfulness"] is None


def test_proxy_is_never_labelled_faithfulness_even_at_one():
    # A verbatim gold answer is still not a measurement of grounding.
    metrics = trq.compute_generation_metrics(
        answer="规定了绩效考核",
        expected_keywords=["绩效考核"],
        must_contain=["规定了", "绩效考核"],
        cited_docs=[],
        forbidden_docs=[],
        judge_enabled=False,
    )
    assert metrics["snippet_match_rate"] == 1.0
    assert metrics["faithfulness"] is None
    assert metrics["faithfulness_measured"] is False


def test_judge_enabled_without_a_route_is_not_measured(monkeypatch):
    monkeypatch.setattr(trq, "_judge_route", lambda: None)
    score, note = trq.judge_faithfulness("制度自 2024 年起施行。", citations("制度自 2024 年起施行"))
    assert score is None
    assert "no LLM route" in note


# ── Judge on: stubbed entailment scoring ──────────────────────────

def test_judge_scores_fraction_of_entailed_sentences(judge_route):
    transport = StubTransport(verdicts=[True, False, True, False])
    answer = "第一条自 2024 年起施行。第二条覆盖全公司。第三条每月结算。第四条无需审批。"
    score, note = trq.judge_faithfulness(
        answer, citations("第一条自 2024 年起施行", "第三条每月结算"), transport=transport
    )
    assert score == pytest.approx(0.5)
    assert note.startswith("llm entailment")
    # The retrieved snippets are what the judge is given — not the gold snippets.
    assert "第一条自 2024 年起施行" in transport.prompts[0]
    assert "1. 第一条自 2024 年起施行。" in transport.prompts[0]


def test_judge_without_cited_evidence_scores_zero(judge_route):
    transport = StubTransport(verdicts=[True])
    score, note = trq.judge_faithfulness("制度自 2024 年起施行。", [], transport=transport)
    assert score == 0.0
    assert note == "no retrieved evidence"
    assert transport.prompts == []  # never asks the judge to invent support


def test_unusable_judge_reply_is_unmeasured_not_zero(judge_route):
    # Wrong-length verdict tables must not silently shrink the denominator.
    short = trq.judge_faithfulness(
        "第一句成立。第二句也成立。", citations("证据"), transport=StubTransport(verdicts=[True])
    )
    assert short[0] is None
    assert "unusable" in short[1] or "error" in short[1]

    errored = trq.judge_faithfulness(
        "第一句成立。", citations("证据"), transport=StubTransport(payload={"error": "HTTP 500"})
    )
    assert errored[0] is None
    assert "HTTP 500" in errored[1]


def test_judge_transport_failure_is_unmeasured(judge_route):
    def boom(*_a, **_kw):
        raise RuntimeError("connection reset")

    score, note = trq.judge_faithfulness("第一句成立。", citations("证据"), transport=boom)
    assert score is None
    assert "judge error" in note


def test_compute_generation_metrics_uses_the_judge_when_enabled(judge_route):
    metrics = trq.compute_generation_metrics(
        answer="第一条自 2024 年起施行。第二条覆盖全公司。",
        expected_keywords=["覆盖全公司"],
        must_contain=["规定了"],           # deliberately absent: paraphrased answer
        cited_docs=["制度"],
        forbidden_docs=[],
        citations=citations("第一条自 2024 年起施行"),
        judge_enabled=True,
        judge_transport=StubTransport(verdicts=[True, False]),
    )
    assert metrics["snippet_match_rate"] == 0.0   # wording overlap, honestly labelled
    assert metrics["faithfulness"] == pytest.approx(0.5)
    assert metrics["faithfulness_measured"] is True


def test_no_answer_case_scores_refusal_only_when_judged():
    refused = trq.compute_generation_metrics(
        answer="当前知识库未包含相关信息。", expected_keywords=[], must_contain=[],
        cited_docs=[], forbidden_docs=[], is_no_answer=True, judge_enabled=True,
        citations=[], judge_transport=StubTransport(verdicts=[True]),
    )
    assert refused["faithfulness"] == 1.0
    assert refused["faithfulness_measured"] is True

    fabricated = trq.compute_generation_metrics(
        answer="该制度规定每年发放两次奖金。", expected_keywords=[], must_contain=[],
        cited_docs=[], forbidden_docs=[], is_no_answer=True, judge_enabled=True,
        citations=[], judge_transport=StubTransport(verdicts=[True]),
    )
    assert fabricated["faithfulness"] == 0.0
    assert fabricated["hallucination"] is True

    unjudged = trq.compute_generation_metrics(
        answer="当前知识库未包含相关信息。", expected_keywords=[], must_contain=[],
        cited_docs=[], forbidden_docs=[], is_no_answer=True, judge_enabled=False,
    )
    assert unjudged["faithfulness"] is None
    assert unjudged["faithfulness_measured"] is False


# ── Verdict parsing ───────────────────────────────────────────────

def test_parse_verdicts_accepts_booleans_and_objects():
    assert trq._parse_verdicts({"verdicts": [True, False]}, 2) == [True, False]
    assert trq._parse_verdicts(
        {"verdicts": [{"entailed": True}, {"supported": False}]}, 2) == [True, False]


def test_parse_verdicts_rejects_wrong_length_and_non_boolean():
    assert trq._parse_verdicts({"verdicts": [True]}, 2) is None
    assert trq._parse_verdicts({"verdicts": ["yes", "no"]}, 2) is None
    assert trq._parse_verdicts("not json", 1) is None
    assert trq._parse_verdicts({"error": "boom"}, 1) is None


# ── Summary aggregation ───────────────────────────────────────────

def _row(faithfulness, measured, snippet=None):
    return {
        "category": "exact_clause", "hit_rate_5": 1.0, "rank_ndcg_10": 1.0,
        "mrr_10": 1.0, "keyword_hit_rate": 0.5, "hallucination": False,
        "faithfulness": faithfulness,
        "faithfulness_measured": measured,
        "snippet_match_rate": snippet if snippet is not None else 0.0,
        "failure": False, "corpus_absent": False,
    }


def test_summary_marks_unmeasured_faithfulness_and_reports_none():
    summary = trq._compute_summary([_row(None, False, 0.1), _row(None, False, 0.2)])
    assert summary["overall"]["faithfulness"] is None
    assert summary["overall"]["faithfulness_measured"] is False
    assert summary["overall"]["faithfulness_coverage"] == 0.0
    assert summary["overall"]["snippet_match_rate"] == pytest.approx(0.15)
    assert summary["by_category"]["exact_clause"]["faithfulness_measured"] is False


def test_summary_averages_only_measured_rows_and_reports_coverage():
    summary = trq._compute_summary([_row(1.0, True), _row(0.5, True), _row(None, False)])
    assert summary["overall"]["faithfulness"] == pytest.approx(0.75)
    assert summary["overall"]["faithfulness_measured"] is True
    assert summary["overall"]["faithfulness_coverage"] == pytest.approx(2 / 3)


def test_summary_does_not_count_legacy_proxy_as_faithfulness():
    # Rows written before this change hold the substring proxy in `faithfulness`
    # and no `faithfulness_measured` key at all.
    legacy = {"category": "exact_clause", "hit_rate_5": 1.0, "rank_ndcg_10": 1.0,
              "mrr_10": 1.0, "keyword_hit_rate": 0.5, "hallucination": False,
              "faithfulness": 0.1125, "failure": False, "corpus_absent": False}
    summary = trq._compute_summary([legacy])
    assert summary["overall"]["faithfulness"] is None
    assert summary["overall"]["faithfulness_measured"] is False
    assert summary["overall"]["snippet_match_rate"] == pytest.approx(0.1125)
