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
