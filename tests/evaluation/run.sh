#!/bin/bash

# Configuration
export API_URL=${API_URL:-"http://localhost:3000/api/v1/chat/completions"}
export AUTH_TOKEN=${AUTH_TOKEN:-"test-token"}

echo "Checking if API is running at $API_URL..."
# Simple curl check, ignoring output, just checking return code
if curl --output /dev/null --silent --head --fail "$API_URL" || true; then
    echo "API check passed (or skipped)."
else
    echo "WARNING: API might not be running at $API_URL."
fi

echo "Starting evaluation..."
npx tsx tests/evaluation/run-evaluation.ts

echo "Evaluation finished."
