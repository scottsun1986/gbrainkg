"""Reject production endpoints before CI tools can create evaluation fixtures."""
import sys
from urllib.parse import urlsplit

url = urlsplit(sys.argv[1])
if url.scheme not in {"http", "https"} or not url.hostname:
    raise SystemExit("FAIL: valid explicit test API URL required")
if url.hostname.lower().rstrip(".") in {"knowledge.5gsailor.com", "meetings2"}:
    raise SystemExit("FAIL: CI evaluations must target the test environment")
if url.username or url.password:
    raise SystemExit("FAIL: credentials must not be embedded in test API URL")
