import os
import json
import sys
from datetime import datetime, timezone

MAX_AGE_HOURS = 24.0


def _invalid(reason):
    print(f"Invalid results file: {reason}")
    sys.exit(1)


def _validate_run(data):
    """Reject dry-run, unprovenanced or stale results (gate errors out)."""
    if data.get("dry_run") is True:
        _invalid("dry_run=true results are not valid for gating")

    run_id = data.get("runId") or data.get("run_id")
    if not run_id:
        _invalid("missing runId (result not bound to a run)")
    git_commit = data.get("gitCommit") or data.get("git_commit")
    if not git_commit:
        _invalid("missing gitCommit (result not bound to a commit)")

    ts_raw = data.get("timestamp_iso") or data.get("timestamp")
    try:
        parsed = datetime.fromisoformat(str(ts_raw))
    except (TypeError, ValueError):
        _invalid(f"unparseable timestamp: {ts_raw!r}")
        return
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    age_hours = (datetime.now(timezone.utc) - parsed).total_seconds() / 3600
    if age_hours > MAX_AGE_HOURS:
        _invalid(f"results are stale ({age_hours:.1f}h old, max {MAX_AGE_HOURS}h)")
    print(f"runId: {run_id}  commit: {str(git_commit)[:12]}  age: {age_hours:.1f}h")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="LLMWiki Quality Gate")
    parser.add_argument("--threshold-hit-rate", type=float, default=float(os.environ.get("QG_THRESHOLD_HIT_RATE", "0.80")),
                        help="Minimum required Hit Rate @ 5 (default: 0.80)")
    parser.add_argument("--threshold-faithfulness", type=float, default=float(os.environ.get("QG_THRESHOLD_FAITHFULNESS", "0.95")),
                        help="Minimum required Faithfulness (default: 0.95)")
    parser.add_argument("--threshold-ndcg", type=float, default=float(os.environ.get("QG_THRESHOLD_NDCG", "0.60")),
                        help="Minimum required retrieval nDCG @ 10 (default: 0.60)")
    args = parser.parse_args()

    threshold_hit_rate = args.threshold_hit_rate
    threshold_faithfulness = args.threshold_faithfulness
    threshold_ndcg = args.threshold_ndcg

    results_file = os.path.join(os.path.dirname(__file__), "results", "latest_results.json")
    if not os.path.exists(results_file):
        print("No results file found at:", results_file)
        sys.exit(1)

    with open(results_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    _validate_run(data)

    results = data.get("results", data if isinstance(data, list) else [])
    if not results:
        print("Results empty")
        sys.exit(1)

    overall = data.get("summary", {}).get("overall", {})
    api_failure_count = overall.get("api_failure_count",
                                    sum(1 for r in results if r.get("failure")))
    if api_failure_count:
        print(f"API failures recorded as 0-score cases: {api_failure_count} (Threshold: 0)")
        print("\n❌ Quality Gate FAILED")
        sys.exit(1)

    avg_hit_rate = sum(r["hit_rate_5"] for r in results) / len(results)
    avg_faith = sum(r["faithfulness"] for r in results) / len(results)
    ndcg_values = [r["rank_ndcg_10"] for r in results if isinstance(r.get("rank_ndcg_10"), (int, float))]
    hallucination_count = sum(1 for r in results if r["hallucination"])

    print("=== Quality Gate Summary ===")
    print(f"Total Cases: {len(results)}")
    print(f"Hit Rate @ 5: {avg_hit_rate:.2%} (Threshold: {threshold_hit_rate:.2%})")
    print(f"Faithfulness: {avg_faith:.2%} (Threshold: {threshold_faithfulness:.2%})")
    if ndcg_values:
        avg_ndcg = sum(ndcg_values) / len(ndcg_values)
        print(f"nDCG @ 10: {avg_ndcg:.2%} (Threshold: {threshold_ndcg:.2%})")
    else:
        avg_ndcg = float("inf")  # ranking metrics absent: do not fail on them
        print("nDCG @ 10: n/a (no ranking metrics in results)")
    print(f"Hallucination Cases: {hallucination_count} (Threshold: 0)")

    passed = (avg_hit_rate >= threshold_hit_rate
              and avg_faith >= threshold_faithfulness
              and avg_ndcg >= threshold_ndcg
              and hallucination_count == 0)

    if passed:
        print("\n✅ Quality Gate PASSED")
        sys.exit(0)
    else:
        print("\n❌ Quality Gate FAILED")
        sys.exit(1)

if __name__ == "__main__":
    main()
