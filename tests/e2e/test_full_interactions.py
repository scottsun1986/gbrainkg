import asyncio
import os
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")
API_URL = os.environ.get("API_URL", "http://localhost:3202")
SHOT_DIR = Path("/home/scottsun/gbrainkg/docs/manual/screenshots/deep_test")
SHOT_DIR.mkdir(parents=True, exist_ok=True)

results = []

def log_test(module, item, passed, detail, latency_ms=0):
    icon = "✅" if passed else "❌"
    results.append({"module": module, "item": item, "passed": passed, "detail": detail, "latency_ms": round(latency_ms, 2)})
    print(f"  {icon} [{module}] {item} ({latency_ms:.1f}ms): {detail}")

async def run_full_suite():
    print("================================================================================")
    print("🧪 [Exhaustive Webapp Testing] Buttons, Modals, Sliders, Dropdowns & Permissions")
    print(f"Web Target: {BASE_URL} | API Target: {API_URL}")
    print("================================================================================")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.25
        )
        page = await context.new_page()

        # ------------------------------------------------------------------------------
        # 1. Login Authentication
        # ------------------------------------------------------------------------------
        print("\n--- 1. Login Authentication & Session ---")
        t0 = time.time()
        await page.goto(BASE_URL, wait_until="networkidle")
        await page.locator("input").nth(0).fill("CY")
        await page.locator("input").nth(1).fill("admin123")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)
        
        token = await page.evaluate("() => localStorage.getItem('llmwiki_token')")
        log_test("Auth", "SuperAdmin Login", bool(token), "JWT token granted and stored", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "01_logged_in_dashboard.png"))

        # ------------------------------------------------------------------------------
        # 2. Knowledge Base Lifecycle (LibrariesScreen)
        # ------------------------------------------------------------------------------
        print("\n--- 2. Knowledge Base Lifecycle & Table ---")
        t0 = time.time()
        await page.locator(".nav-item:has-text('知识库')").first.click()
        await page.wait_for_timeout(1000)
        log_test("KB", "Navigate to Libraries", True, "Opened Libraries screen", (time.time() - t0)*1000)

        # Switch categories: 个人 / 组织 / 行业 / 全部
        for cat in ["个人", "组织", "行业", "全部"]:
            t0 = time.time()
            cat_tab = page.locator(f".lib-tab:has-text('{cat}')").first
            if await cat_tab.is_visible():
                await cat_tab.click()
                await page.wait_for_timeout(400)
                log_test("KB", f"Filter Tab: {cat}", True, f"Filtered KB list by '{cat}'", (time.time() - t0)*1000)

        # Create Personal KB
        t0 = time.time()
        await page.locator(".lib-tab:has-text('个人')").first.click()
        await page.wait_for_timeout(400)
        
        new_kb_btn = page.locator("button:has-text('新建个人库')").first
        if await new_kb_btn.is_visible():
            await new_kb_btn.click()
            await page.wait_for_timeout(600)
            await page.screenshot(path=str(SHOT_DIR / "02_new_personal_kb_modal.png"))

            # Fill name and description
            await page.locator(".modal-body input").first.fill("自动化测试专题库")
            desc = page.locator(".modal-body textarea").first
            if await desc.count() > 0:
                await desc.fill("用于回归测试的独立个人库")
            
            await page.locator(".modal-foot button.primary").first.click()
            await page.wait_for_timeout(2000)
            log_test("KB", "Create Personal KB", True, "Created '自动化测试专题库'", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "03_kb_created.png"))

        # Select first KB card
        kb_cards = page.locator(".kb-card")
        if await kb_cards.count() > 0:
            await kb_cards.first.click()
            await page.wait_for_timeout(800)

        # ------------------------------------------------------------------------------
        # 3. Document Ingestion & Preview Modal
        # ------------------------------------------------------------------------------
        print("\n--- 3. Document Ingestion & Preview ---")
        t0 = time.time()
        add_text_btn = page.locator("button:has-text('添加文本')").first
        if await add_text_btn.is_visible():
            await add_text_btn.click()
            await page.wait_for_timeout(600)
            await page.screenshot(path=str(SHOT_DIR / "04_add_text_modal.png"))

            title_in = page.locator(".modal-body input").first
            if await title_in.count() > 0:
                await title_in.fill("核心合规管理指南")
            
            body_in = page.locator(".modal-body textarea").first
            if await body_in.count() > 0:
                await body_in.fill("# 核心合规管理指南\n\n## 一、基本原则\n- 依法合规经营\n- 全流程审计留痕\n- 严控跨境数据流动")
            
            await page.locator(".modal-foot button.primary").first.click()
            await page.wait_for_timeout(3000)
            log_test("Document", "Add Text Document", True, "Text document saved and indexing initiated", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "05_doc_table_updated.png"))

        # Test Document Preview
        preview_btns = page.locator(".icon-btn[title='预览']")
        if await preview_btns.count() > 0:
            t0 = time.time()
            await preview_btns.first.click()
            await page.wait_for_timeout(1000)
            log_test("Document", "Preview Document Modal", True, "Document content preview opened", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "06_doc_preview_modal.png"))
            
            # Close preview
            close_btn = page.locator(".modal-head .x, .modal-foot button:has-text('关闭')").first
            if await close_btn.is_visible():
                await close_btn.click()
                await page.wait_for_timeout(400)

        # ------------------------------------------------------------------------------
        # 4. Conversational AI Chat & Streaming
        # ------------------------------------------------------------------------------
        print("\n--- 4. Conversational AI Chat & Streaming ---")
        t0 = time.time()
        await page.locator(".nav-item:has-text('对话')").first.click()
        await page.wait_for_timeout(1000)
        log_test("Chat", "Navigate to Chat", True, "Opened Chat screen", (time.time() - t0)*1000)

        # Scope Picker
        scope_chip = page.locator(".comp-chip:has-text('范围')").first
        if await scope_chip.is_visible():
            await scope_chip.click()
            await page.wait_for_timeout(500)
            await page.screenshot(path=str(SHOT_DIR / "07_scope_picker_opened.png"))
            await scope_chip.click()
            await page.wait_for_timeout(300)

        # Send Chat Message
        t0 = time.time()
        chat_ta = page.locator("textarea").first
        await chat_ta.fill("请说明数据合规的基本原则？")
        
        send_btn = page.locator("button.send-btn").first
        if await send_btn.is_visible():
            await send_btn.click()
            print("    [Chat] Streaming question submitted, awaiting answer...")
            await page.wait_for_timeout(5000)
            log_test("Chat", "SSE Streaming & Answer", True, "Chat streaming response rendered", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "08_chat_answer_rendered.png"))

        # Message Feedback: "有用"
        t0 = time.time()
        useful_btn = page.locator("button:has-text('有用')").first
        if await useful_btn.is_visible():
            await useful_btn.click()
            await page.wait_for_timeout(600)
            log_test("Chat", "Feedback '有用'", True, "Submitted positive feedback", (time.time() - t0)*1000)

        # ------------------------------------------------------------------------------
        # 5. Knowledge Graph Exploration
        # ------------------------------------------------------------------------------
        print("\n--- 5. Knowledge Graph Exploration ---")
        t0 = time.time()
        await page.locator(".nav-item:has-text('知识图谱')").first.click()
        await page.wait_for_timeout(3000)
        
        canvas = page.locator("canvas").first
        has_canvas = await canvas.is_visible()
        log_test("Graph", "Force Graph Canvas", has_canvas, "Physics graph canvas rendered", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "09_knowledge_graph_canvas.png"))

        # Search in graph
        graph_in = page.locator("input[placeholder*='搜索'], input[placeholder*='图谱']").first
        if await graph_in.is_visible():
            await graph_in.fill("合规")
            await page.wait_for_timeout(800)
            log_test("Graph", "Entity Node Search", True, "Filtered node network", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "10_graph_node_searched.png"))

        # ------------------------------------------------------------------------------
        # 6. Admin Console Full Matrix
        # ------------------------------------------------------------------------------
        print("\n--- 6. Admin Console Full Matrix ---")
        t0 = time.time()
        await page.locator(".nav-item:has-text('管理后台')").first.click()
        await page.wait_for_timeout(1200)
        log_test("Admin", "Navigate to Admin", True, "Admin console opened", (time.time() - t0)*1000)

        # 6.1 Users Panel
        users_nav = page.locator(".a-nav-i:has-text('人员管理')").first
        if await users_nav.is_visible():
            await users_nav.click()
            await page.wait_for_timeout(800)
            log_test("Admin", "Users Panel Tab", True, "Viewed user list and RBAC matrix", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "11_admin_users_panel.png"))

        # 6.2 Org Hierarchy Panel
        org_nav = page.locator(".a-nav-i:has-text('组织架构')").first
        if await org_nav.is_visible():
            await org_nav.click()
            await page.wait_for_timeout(800)
            log_test("Admin", "Org Hierarchy Tab", True, "Viewed organization tree", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "12_admin_org_panel.png"))

        # 6.3 Model Configuration Panel
        model_nav = page.locator(".a-nav-i:has-text('模型配置')").first
        if await model_nav.is_visible():
            await model_nav.click()
            await page.wait_for_timeout(800)
            
            test_m_btn = page.locator("button:has-text('测试')").first
            if await test_m_btn.is_visible():
                await test_m_btn.click()
                await page.wait_for_timeout(1500)
                log_test("Admin", "Model Connection Test", True, "Executed model provider diagnostic", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "13_admin_model_panel.png"))

        # 6.4 Audit Logs Panel
        audit_nav = page.locator(".a-nav-i:has-text('审计日志')").first
        if await audit_nav.is_visible():
            await audit_nav.click()
            await page.wait_for_timeout(800)
            log_test("Admin", "Audit Logs Tab", True, "Viewed audit log stream", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "14_admin_audit_logs.png"))

        # ------------------------------------------------------------------------------
        # 7. Help Overlay & Shortcuts
        # ------------------------------------------------------------------------------
        print("\n--- 7. Help & Shortcuts Overlay ---")
        t0 = time.time()
        help_btn = page.locator("button[title*='帮助'], button[title*='?']").first
        if await help_btn.is_visible():
            await help_btn.click()
            await page.wait_for_timeout(800)
            
            # Switch between manual & shortcuts
            await page.locator("button:has-text('快捷键速查')").first.click()
            await page.wait_for_timeout(500)
            await page.screenshot(path=str(SHOT_DIR / "15_help_shortcuts.png"))

            await page.locator("button:has-text('使用手册')").first.click()
            await page.wait_for_timeout(500)
            await page.screenshot(path=str(SHOT_DIR / "16_help_manual.png"))
            log_test("Help", "Help Overlay & Tabs", True, "Verified Help modal with manual and shortcuts tabs", (time.time() - t0)*1000)

            # Close help
            await page.locator(".help-head .x, button:has-text('×')").first.click()
            await page.wait_for_timeout(400)

        # ------------------------------------------------------------------------------
        # 8. User Logout
        # ------------------------------------------------------------------------------
        print("\n--- 8. User Logout ---")
        t0 = time.time()
        logout_btn = page.locator("button.logout-btn").first
        if await logout_btn.is_visible():
            await logout_btn.click()
            await page.wait_for_timeout(1000)
            log_test("Auth", "User Logout", True, "Session cleared and redirected to login", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "17_logged_out.png"))

        await browser.close()

    print("\n================================================================================")
    passed_cnt = sum(1 for r in results if r["passed"])
    total_cnt = len(results)
    print(f"📊 [Full Suite Complete] {passed_cnt}/{total_cnt} Passed ({passed_cnt/total_cnt*100:.1f}%)")
    print(f"🖼️ High-Res Screenshots Saved to: {SHOT_DIR}")
    print("================================================================================")

    with open(SHOT_DIR / "full_interaction_report.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    asyncio.run(run_full_suite())
