# LLMWiki Golden Evaluation Framework

## Overview
This framework evaluates the retrieval and generation quality of the LLMWiki system based on the P0/P1 standard documented in the project plan.
It runs a multi-stage evaluation on the system separating retrieval effectiveness (Hit Rate, MRR, Context Recall) from generation quality (Faithfulness, Keyword Coverage, Hallucination avoidance).

## Components
- `golden_dataset.json`: 220+ golden standard evaluation questions covering 9 enterprise scenarios.
- `conftest.py`: Reusable fixtures for SSE streaming, authentication, and HTTP sessions.
- `test_retrieval_quality.py`: Pytest suite that compares LLMWiki's real-time chat completions against the golden references.
- `quality_gate.py`: CI script that reads results and enforces thresholds before deployment.

## Execution

```bash
# Run tests
TEST_PORT=3202 pytest test_retrieval_quality.py -v --golden-file=golden_dataset.json

# Run quality gate
python quality_gate.py
```

## Which dataset is which

Two golden sets exist and they are not interchangeable:

- `golden_dataset.json` (220 cases, 9 categories) drives `test_retrieval_quality.py`
  and the `latest_results.json` regression artifact.
- `golden-dataset.json` (50 cases) drives `quality-gate.ts` / `ci-gate.sh`, i.e.
  the release gate. It is the smaller, hand-audited set, so "the gate passed" does
  not mean "the 220-case suite passed"; both are reported separately.

## Thresholds

`gate-thresholds.sh` is the single source of truth for every gate threshold and
is sourced by `ci-gate.sh`, `.github/workflows/ci.yml` and
`.github/workflows/quality-gate.yml`. Environment variables still win, so a
release can raise the bar without editing the file. Never hardcode a threshold in
a workflow: two gates with different numbers is how an artefact passes one and
fails the other.

## Public-benchmark runbook (BEIR / official qrels)

The external-benchmark harness must be run against real data and the run files
kept, otherwise the numbers cannot be reproduced:

```bash
# 1. fetch a dataset (SciFact is the current reference corpus: 5,183 docs / 300 queries)
python intl-benchmark/fetch_datasets.py --dataset scifact --output-dir /data/beir

# 2. ingest the corpus into a dedicated evaluation knowledge base
python intl-benchmark/beir_pipeline.py --dataset-dir /data/beir/scifact \
  --run-out run_scifact.jsonl --manifest-out manifest_scifact.json

# 3. score the run file against the official qrels (missing queries count as 0)
python intl-benchmark/standard_ir_eval.py --qrels /data/beir/scifact/qrels/test.tsv \
  --run run_scifact.jsonl

# 4. filtered-HNSW recall against exact KNN (gold)
python intl-benchmark/ann_recall_eval.py --k 10 --target-recall 0.98
```

Record the resulting metrics in the version matrix (see
`docs/sota-optimization-plan-inst1-2026-09-20.md`), keep `run_*.jsonl` next to the
metrics, and treat `gate-thresholds.sh:GATE_ANN_RECALL` as the release bar for
step 4. Setting `RETRIEVAL_BENCHMARK_PATTERNS=1` when running the multi-hop sets
(2WikiMultiHopQA / HotpotQA) restores the benchmark-shaped decomposition rules
that are off in production.

## Report naming policy

An artefact may only be named after a framework if it is produced by that
framework. The local scorer is `answer_quality_heuristic_suite.py` and its
outputs are `reports/heuristic_answer_quality_report.json` /
`reports/heuristic_answer_quality_dashboard.html`; they must never be reported as
Ragas or DeepEval results.
