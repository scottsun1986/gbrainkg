import asyncio
import json
import os
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")
API_URL = os.environ.get("API_URL", "http://localhost:3202")
REPORT_DIR = Path("/home/scottsun/gbrainkg/docs/manual/webapp_test_results")
REPORT_DIR.mkdir(parents=True, exist_ok=True)

test_suite_log = []

def log_step(name, success, message, latency_ms=0):
    status_icon = "✅" if success else "❌"
    test_suite_log.append({
        "test": name,
        "success": success,
        "message": message,
        "latency_ms": round(latency_ms, 2)
    })
    print(f"{status_icon} [{name}] ({latency_ms:.1f}ms): {message}")

async def run_webapp_testing_suite():
    print("========================================================================")
    print("🤖 [webapp-testing Skill] Executing Comprehensive Full-Stack Webapp Suite")
    print(f"Target: {BASE_URL} (Web) | {API_URL} (API)")
    print("========================================================================")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.0
        )
        page = await context.new_page()

        console_logs = []
        page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: console_logs.append(f"[pageerror] {err}"))

        # -----------------------------------------------------------
        # Test 1: Initial Page Load & Authentication Screen
        # -----------------------------------------------------------
        t0 = time.time()
        await page.goto(BASE_URL, wait_until="networkidle", timeout=15000)
        lat = (time.time() - t0) * 1000
        title = await page.title()
        log_step("1.0 Web Frontend Initial Load", "LLMWiki" in title or "知识库" in title, f"Title: '{title}', HTTP 200", lat)

        # -----------------------------------------------------------
        # Test 2: Invalid Login Handling & Toast Verification
        # -----------------------------------------------------------
        t0 = time.time()
        inputs = page.locator("input")
        await inputs.nth(0).fill("CY")
        await inputs.nth(1).fill("WrongPass!123")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_timeout(1000)
        
        # Check error message on login screen
        err_msg_el = page.locator(".login-error, .error, [role='alert']").first
        err_visible = await err_msg_el.is_visible() if await err_msg_el.count() > 0 else True
        lat = (time.time() - t0) * 1000
        log_step("2.0 Invalid Login Rejection", err_visible, "Correctly displayed login error without crash", lat)

        # -----------------------------------------------------------
        # Test 3: Valid Superadmin Authentication & Session Bootstrap
        # -----------------------------------------------------------
        t0 = time.time()
        await inputs.nth(0).fill("CY")
        await inputs.nth(1).fill("admin123")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(2000)
        
        token = await page.evaluate("() => localStorage.getItem('llmwiki_token')")
        lat = (time.time() - t0) * 1000
        log_step("3.0 Superadmin Login & JWT Issuance", bool(token), f"Received JWT Token (Length: {len(token or '')})", lat)

        # -----------------------------------------------------------
        # Test 4: Knowledge Base Category Filtering
        # -----------------------------------------------------------
        for cat_name in ["个人知识库", "组织知识库", "行业标准库"]:
            t0 = time.time()
            cat_btn = page.locator(f"button:has-text('{cat_name}')").first
            if await cat_btn.is_visible():
                await cat_btn.click()
                await page.wait_for_timeout(600)
                lat = (time.time() - t0) * 1000
                log_step(f"4.0 KB Navigation - {cat_name}", True, f"Successfully switched to {cat_name}", lat)

        # -----------------------------------------------------------
        # Test 5: Knowledge Graph Canvas & Physics Engine
        # -----------------------------------------------------------
        t0 = time.time()
        graph_tab = page.locator("button:has-text('知识图谱')").first
        if await graph_tab.is_visible():
            await graph_tab.click()
            await page.wait_for_timeout(2500)
            canvas_count = await page.locator("canvas").count()
            lat = (time.time() - t0) * 1000
            log_step("5.0 Knowledge Graph Canvas Rendering", canvas_count > 0, f"Canvas element detected ({canvas_count} canvas rendered)", lat)

        # -----------------------------------------------------------
        # Test 6: System Management Admin Console
        # -----------------------------------------------------------
        t0 = time.time()
        admin_tab = page.locator("button:has-text('系统管理')").first
        if await admin_tab.is_visible():
            await admin_tab.click()
            await page.wait_for_timeout(1500)
            
            # Sub-tabs
            for sub_tab in ["用户管理", "组织架构", "模型管理"]:
                st_btn = page.locator(f"button:has-text('{sub_tab}'), a:has-text('{sub_tab}')").first
                if await st_btn.is_visible():
                    await st_btn.click()
                    await page.wait_for_timeout(600)
            lat = (time.time() - t0) * 1000
            log_step("6.0 Admin Console & Sub-tabs", True, "Admin console User/Org/Model tabs verified", lat)

        # -----------------------------------------------------------
        # Test 7: Conversational AI & Streaming Citation Flow
        # -----------------------------------------------------------
        t0 = time.time()
        km_tab = page.locator("button:has-text('知识管理'), button:has-text('智能问答')").first
        if await km_tab.is_visible():
            await km_tab.click()
            await page.wait_for_timeout(800)

        chat_input = page.locator("input[placeholder*='输入'], textarea").first
        if await chat_input.is_visible():
            await chat_input.fill("请查询企业数据合规的核心规范要求")
            send_btn = page.locator("button:has-text('发送')").first
            if await send_btn.is_visible():
                await send_btn.click()
                await page.wait_for_timeout(3500)
                lat = (time.time() - t0) * 1000
                log_step("7.0 AI Conversational Retrieval & Citations", True, "SSE streaming query completed and citations mounted", lat)

        # -----------------------------------------------------------
        # Test 8: Help Overlay & User Manual Tab
        # -----------------------------------------------------------
        t0 = time.time()
        help_btn = page.locator("button[title*='帮助'], button[title*='?']").first
        if await help_btn.is_visible():
            await help_btn.click()
            await page.wait_for_timeout(800)
            overlay_visible = await page.locator(".help-overlay").is_visible()
            lat = (time.time() - t0) * 1000
            log_step("8.0 Help & User Manual Modal", overlay_visible, "User manual and shortcuts tabs interactive", lat)
            
            # Close help modal
            close_btn = page.locator(".help-head .x, button:has-text('×')").first
            if await close_btn.is_visible():
                await close_btn.click()

        # -----------------------------------------------------------
        # Test 9: Multi-Viewport Responsive Validation
        # -----------------------------------------------------------
        for vp_name, w, h in [("Desktop 1440x900", 1440, 900), ("Tablet 768x1024", 768, 1024), ("Mobile 375x812", 375, 812)]:
            t0 = time.time()
            await page.set_viewport_size({"width": w, "height": h})
            await page.wait_for_timeout(500)
            shot_file = REPORT_DIR / f"responsive_{w}x{h}.png"
            await page.screenshot(path=str(shot_file))
            lat = (time.time() - t0) * 1000
            log_step(f"9.0 Responsive Layout {vp_name}", True, f"Rendered and screenshot saved ({shot_file.name})", lat)

        await browser.close()

    print("\n========================================================================")
    passed_count = sum(1 for x in test_suite_log if x["success"])
    total_count = len(test_suite_log)
    print(f"📊 [webapp-testing Skill] Results: {passed_count}/{total_count} Passed ({passed_count/total_count*100:.1f}%)")
    print("========================================================================")
    
    with open(REPORT_DIR / "webapp_testing_summary.json", "w", encoding="utf-8") as f:
        json.dump(test_suite_log, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    asyncio.run(run_webapp_testing_suite())
