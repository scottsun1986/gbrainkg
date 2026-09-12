import os
import json
import pytest
import requests

# Environment variables
TEST_HOST = os.environ.get("TEST_HOST", "http://127.0.0.1")
TEST_PORT = os.environ.get("TEST_PORT", "3202")
TEST_USER = os.environ.get("TEST_USER", "admin")
TEST_PASSWORD = os.environ.get("TEST_PASSWORD", "123456")
API_BASE = f"{TEST_HOST}:{TEST_PORT}/api/v1"

def pytest_addoption(parser):
    parser.addoption(
        "--golden-file",
        action="store",
        default="golden_dataset.json",
        help="Path to the golden evaluation dataset JSON file"
    )
    parser.addoption(
        "--dry-run",
        action="store_true",
        default=False,
        help="Skip real API calls; validate dataset & metrics logic only"
    )

@pytest.fixture(scope="session")
def auth_token():
    try:
        url = f"{API_BASE}/auth/login"
        resp = requests.post(url, json={"username": TEST_USER, "password": TEST_PASSWORD}, timeout=5)
        if resp.status_code in (200, 201):
            return resp.json().get("token", "dummy_token")
        raise RuntimeError(f"Login failed: {resp.status_code} {resp.text}")
    except Exception as e:
        raise RuntimeError(f"Failed to authenticate: {e}")

@pytest.fixture(scope="session")
def sse_parser():
    def parse(sse_stream):
        events = []
        for line in sse_stream.iter_lines():
            if line:
                decoded = line.decode('utf-8')
                if decoded.startswith('data: '):
                    try:
                        data = json.loads(decoded[6:])
                        events.append(data)
                    except json.JSONDecodeError:
                        pass
        return events
    return parse

@pytest.fixture(scope="session")
def api_base_url():
    return API_BASE

@pytest.fixture(scope="session")
def eval_kb_scope():
    """Optional KB scope for /chat/search ranking eval (EVAL_KB_SCOPE, comma separated)."""
    raw = os.environ.get("EVAL_KB_SCOPE", "")
    scopes = [s.strip() for s in raw.split(",") if s.strip()]
    return scopes or None
