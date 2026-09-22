#!/usr/bin/env bash
# Single source of truth for the release quality-gate thresholds.
#
# Why this file exists: the thresholds used to be duplicated in
# .github/workflows/quality-gate.yml (hit rate 0.80) and in ci-gate.sh / the
# self-hosted ci.yml job (0.90). Two gates with different numbers means one of
# them can pass an artefact the other rejects, and nobody can answer "what is the
# release bar" without grepping three files.
#
# Usage (bash):  source tests/evaluation/gate-thresholds.sh
# Values already present in the environment always win, so a caller can raise the
# bar for a specific release without editing this file.

export GATE_HIT_RATE="${GATE_HIT_RATE:-0.90}"
export GATE_KEYWORD_COVERAGE="${GATE_KEYWORD_COVERAGE:-0.85}"
export GATE_PERMISSION_RATE="${GATE_PERMISSION_RATE:-1.00}"
export GATE_NO_HALLUCINATION="${GATE_NO_HALLUCINATION:-0.95}"
export GATE_FAITHFULNESS="${GATE_FAITHFULNESS:-0.95}"
export GATE_CITATION_ACCURACY="${GATE_CITATION_ACCURACY:-0.90}"
export GATE_CONTEXT_PRECISION="${GATE_CONTEXT_PRECISION:-0.85}"
# Minimum filtered-HNSW Recall@10 measured against exact KNN (ann_recall_eval.py).
export GATE_ANN_RECALL="${GATE_ANN_RECALL:-0.98}"
# Release mode: with GATE_STRICT=1 a gate that cannot run is a failure, not a skip.
export GATE_STRICT="${GATE_STRICT:-0}"
# Hard-probe regression (tests/evaluation/intl-benchmark/regression): allowed drop
# in passed questions on the historical-failure probe sets.
export PROBE_TOLERANCE="${PROBE_TOLERANCE:-1}"
# No-answer safety: hallucination rate allowed on the GS-NA subset (must be ~0 —
# this category silently broke twice during the 2026-09-20/21 session).
export GATE_NO_ANSWER_HALLUCINATION_MAX="${GATE_NO_ANSWER_HALLUCINATION_MAX:-0.01}"
