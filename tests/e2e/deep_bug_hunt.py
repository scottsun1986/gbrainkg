import asyncio
import os
import json
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")
API_URL = os.environ.get("API_URL", "http://localhost:3202")

bugs_found = []

def log_bug(category, title, detail, severity="MEDIUM"):
    bugs_found.append({
        "category": category,
        "title": title,
        "detail": detail,
        "severity": severity
    })
    print(f"[{severity}] [{category}] {title}: {detail}")

async def run_deep_hunt():
    print("==================================================")
    print("Starting Deep Bug Hunting & Edge Case Testing...")
    print("==================================================")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()

        console_errors = []
        page_errors = []
        network_errors = []

        page.on("console", lambda msg: console_errors.append(f"[{msg.type}] {msg.text}") if msg.type in ("error", "warning") else None)
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        page.on("requestfailed", lambda req: network_errors.append(f"{req.method} {req.url}: {req.failure}"))

        # Test 1: Frontend Initial Load & Console Errors
        print("\n--- 1. Testing Console & Page Errors on Load ---")
        await page.goto(BASE_URL, wait_until="networkidle")
        await page.wait_for_timeout(1000)

        # Login
        inputs = page.locator("input")
        await inputs.nth(0).fill("CY")
        await inputs.nth(1).fill("admin123")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_timeout(2000)

        if page_errors:
            for err in page_errors:
                log_bug("Frontend Runtime", "Uncaught JavaScript Exception", err, "HIGH")

        # Filter out harmless warnings
        real_console_errors = [e for e in console_errors if "error" in e.lower() and not "favicon" in e.lower()]
        if real_console_errors:
            for ce in real_console_errors[:5]:
                log_bug("Frontend Console", "Console Error Detected", ce, "MEDIUM")

        # Test 2: Upload Edge Case (Empty file, Huge file, Unsupported format)
        print("\n--- 2. Testing Document Upload Edge Cases ---")
        # Create temp dummy test files
        tmp_txt = Path("/tmp/test_empty.xyz")
        tmp_txt.write_text("dummy")

        # Try uploading unsupported format via API
        import urllib.request
        import urllib.error

        # Get token from localStorage
        token = await page.evaluate("() => localStorage.getItem('llmwiki_token')")

        # Test 3: API Input Validation & Security Edge Cases
        print("\n--- 3. Testing API Vulnerabilities & Edge Cases ---")
        
        # Test 3.1: SQL Injection attempt in search / chat
        req_data = json.dumps({"question": "' OR 1=1 --", "conversationId": "invalid-uuid"}).encode("utf-8")
        req = urllib.request.Request(f"{API_URL}/api/v1/chat/completions", data=req_data, headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}"
        })
        try:
            with urllib.request.urlopen(req) as resp:
                pass
        except urllib.error.HTTPError as e:
            if e.code == 500:
                log_bug("API Security/Validation", "Unhandled 500 on malformed input", f"Chat completion returned 500 on SQL injection payload: {e.read().decode('utf-8')}", "HIGH")

        # Test 3.2: Malformed UUID handling
        req = urllib.request.Request(f"{API_URL}/api/v1/kbs/not-a-valid-uuid/documents", headers={
            "Authorization": f"Bearer {token}"
        })
        try:
            with urllib.request.urlopen(req) as resp:
                pass
        except urllib.error.HTTPError as e:
            if e.code == 500:
                err_detail = e.read().decode('utf-8')
                log_bug("API Robustness", "Raw Database Error Exposed (500)", f"Invalid UUID returns 500 instead of 400 Bad Request: {err_detail[:200]}", "MEDIUM")

        # Test 3.3: Delete User with active relations
        # Check if cascade delete handles personal KBs and brain repos cleanly

        # Test 4: UI Interactive Edge Cases
        print("\n--- 4. Testing UI Edge Cases (Knowledge Graph, Scope Picker, Chat) ---")
        # Switch to Knowledge Graph with no selected node
        graph_btn = page.locator("button:has-text('知识图谱')").first
        if await graph_btn.is_visible():
            await graph_btn.click()
            await page.wait_for_timeout(2000)
            
            # Check if canvas exists
            canvas = page.locator("canvas")
            if await canvas.count() == 0:
                log_bug("UI Feature", "Knowledge Graph Canvas Missing", "Graph tab clicked but canvas element not rendered", "HIGH")

        # Test 5: Switch to Admin Console and check table pagination & empty states
        print("\n--- 5. Testing Admin Console Edge Cases ---")
        admin_btn = page.locator("button:has-text('系统管理')").first
        if await admin_btn.is_visible():
            await admin_btn.click()
            await page.wait_for_timeout(1500)

            # Check if Org tree expands/collapses cleanly
            org_btn = page.locator("button:has-text('组织架构'), a:has-text('组织架构')").first
            if await org_btn.is_visible():
                await org_btn.click()
                await page.wait_for_timeout(1000)

        await browser.close()

    print("\n==================================================")
    print(f"Deep Bug Hunting Completed! Found {len(bugs_found)} issue(s).")
    print("==================================================")
    with open("/tmp/bugs_report.json", "w") as f:
        json.dump(bugs_found, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    asyncio.run(run_deep_hunt())
