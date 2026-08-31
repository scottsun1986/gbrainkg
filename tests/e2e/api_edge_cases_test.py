import urllib.request
import urllib.error
import json
import uuid

API_URL = "http://localhost:3202"

# 1. Login to get token
req = urllib.request.Request(f"{API_URL}/api/v1/auth/login", data=json.dumps({"username":"CY","password":"admin123"}).encode('utf-8'), headers={"Content-Type":"application/json"})
with urllib.request.urlopen(req) as resp:
    token = json.loads(resp.read().decode('utf-8'))['token']

headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

issues = []

# Case 1: Duplicate User Creation
print("[Edge Test 1] Testing Duplicate User Creation...")
user_payload = json.dumps({"username": "CY", "email": "cy@example.com", "displayName": "Duplicate CY"}).encode('utf-8')
req = urllib.request.Request(f"{API_URL}/api/v1/admin/users", data=user_payload, headers=headers)
try:
    with urllib.request.urlopen(req) as resp:
        issues.append("Duplicate user was created instead of being rejected!")
except urllib.error.HTTPError as e:
    print(f"  Response Status: {e.code}")
    if e.code == 500:
        issues.append(f"Duplicate user throws unhandled 500 Internal Server Error (P2002 Unique Constraint violation) instead of 409 Conflict / 400 Bad Request.")

# Case 2: Duplicate Role Creation
print("[Edge Test 2] Testing Duplicate Role Creation...")
role_payload = json.dumps({"name": "超级管理员", "description": "Duplicate"}).encode('utf-8')
req = urllib.request.Request(f"{API_URL}/api/v1/admin/roles", data=role_payload, headers=headers)
try:
    with urllib.request.urlopen(req) as resp:
        issues.append("Duplicate role was created instead of being rejected!")
except urllib.error.HTTPError as e:
    print(f"  Response Status: {e.code}")
    if e.code == 500:
        issues.append(f"Duplicate role throws unhandled 500 Internal Server Error instead of 409/400.")

# Case 3: Invalid KB ID query
print("[Edge Test 3] Testing Invalid KB ID parameter in documents...")
req = urllib.request.Request(f"{API_URL}/api/v1/kbs/invalid-uuid-string/documents", headers=headers)
try:
    with urllib.request.urlopen(req) as resp:
        pass
except urllib.error.HTTPError as e:
    print(f"  Response Status: {e.code}")
    if e.code == 500:
        issues.append("Invalid UUID in route parameters returns 500 instead of 400 (Prisma query syntax error).")

# Case 4: Non-admin user accessing admin endpoint
print("[Edge Test 4] Testing Non-admin user access to /api/v1/admin/data...")
# Login as LK (non-admin)
req = urllib.request.Request(f"{API_URL}/api/v1/auth/login", data=json.dumps({"username":"LK","password":"admin123"}).encode('utf-8'), headers={"Content-Type":"application/json"})
try:
    with urllib.request.urlopen(req) as resp:
        lk_token = json.loads(resp.read().decode('utf-8'))['token']
        # Try accessing admin
        req_admin = urllib.request.Request(f"{API_URL}/api/v1/admin/data", headers={"Authorization": f"Bearer {lk_token}"})
        try:
            with urllib.request.urlopen(req_admin) as admin_resp:
                issues.append("CRITICAL: Non-admin user LK was able to fetch all /api/v1/admin/data!")
        except urllib.error.HTTPError as admin_err:
            print(f"  Non-admin access response: {admin_err.code} (Expected 403 Forbidden)")
            if admin_err.code != 403:
                issues.append(f"Non-admin access returned {admin_err.code} instead of 403 Forbidden.")
except Exception as err:
    print(f"  Login as LK: {err}")

# Case 5: Empty Prompt Chat
print("[Edge Test 5] Testing Empty question in chat completions...")
chat_payload = json.dumps({"question": ""}).encode('utf-8')
req = urllib.request.Request(f"{API_URL}/api/v1/chat/completions", data=chat_payload, headers=headers)
try:
    with urllib.request.urlopen(req) as resp:
        res_data = resp.read().decode('utf-8')
        print(f"  Chat response for empty question: {res_data[:100]}")
except urllib.error.HTTPError as e:
    print(f"  Chat empty query status: {e.code}")

print("\n--- Summary of Issues Found ---")
for idx, iss in enumerate(issues, 1):
    print(f"{idx}. {iss}")

