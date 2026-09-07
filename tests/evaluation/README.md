# GBrainKG Evaluation Infrastructure

This directory contains the evaluation infrastructure for measuring RAG retrieval quality.

## Files
- `golden-dataset.json`: 50 annotated test questions.
- `run-evaluation.ts`: TypeScript script to run the evaluation.
- `run.sh`: Bash wrapper script to easily execute the evaluation.

## Running the Evaluation
You can run the evaluation using the shell script:
```bash
bash tests/evaluation/run.sh
```

Or using `npm run evaluate` (if configured in `package.json`).

## Metrics Output
Results will be saved in the `results/` directory as timestamped JSON files.
