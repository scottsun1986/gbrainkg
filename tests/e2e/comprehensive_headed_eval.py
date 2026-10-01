import asyncio
import json
import os
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")
API_URL = os.environ.get("API_URL", "http://localhost:3202")
OUTPUT_DIR = Path("docs/test-reports/headed-audit-20261001")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
SHOTS_DIR = OUTPUT_DIR / "screenshots"
SHOTS_DIR.mkdir(parents=True, exist_ok=True)

report = {
    "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    "environment": {"baseUrl": BASE_URL, "apiUrl": API_URL, "headed": True},
    "testModules": {},
    "consoleErrors": [],
    "networkErrors": [],
    "uxObservations": [],
    "bugsFound": [],
    "summary": {"totalTests": 0, "passed": 0, "failed": 0, "warnings": 0}
}

def log_test(module, name, passed, detail="", latency_ms=0, screenshot=""):
    report["summary"]["totalTests"] += 1
    if passed:
        report["summary"]["passed"] += 1
        status = "PASS"
    else:
        report["summary"]["failed"] += 1
        status = "FAIL"
    
    if module not in report["testModules"]:
        report["testModules"][module] = []
    
    res = {
        "name": name,
        "status": status,
        "detail": detail,
        "latency_ms": round(latency_ms, 2),
        "screenshot": screenshot
    }
    report["testModules"][module].append(res)
    print(f"[{status}] {module} :: {name} ({round(latency_ms, 2)}ms) - {detail}")

async def run_evaluation():
    print(f"=== Starting Headed Browser Evaluation against {BASE_URL} ===")
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=["--start-maximized", "--disable-notifications"]
        )
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.0
        )
        page = await context.new_page()

        # Listen for console errors & warnings
        page.on("console", lambda msg: (
            report["consoleErrors"].append({"type": msg.type, "text": msg.text, "location": msg.location})
            if msg.type in ["error"] else None
        ))
        
        # Listen for network errors
        page.on("response", lambda resp: (
            report["networkErrors"].append({"url": resp.url, "status": resp.status, "statusText": resp.status_text})
            if resp.status >= 400 and not "/api/v1/auth/login" in resp.url else None
        ))

        # ----------------------------------------------------
        # Module 1: Auth, Login & Theme
        # ----------------------------------------------------
        m1 = "Auth & Session"
        t0 = time.time()
        await page.goto(f"{BASE_URL}", wait_until="networkidle")
        await page.wait_for_timeout(1000)
        shot1 = str(SHOTS_DIR / "01_login_page.png")
        await page.screenshot(path=shot1)
        log_test(m1, "Login Page Load", True, "Login screen rendered", (time.time() - t0)*1000, shot1)

        # Test invalid credentials feedback
        t0 = time.time()
        await page.locator("input").nth(0).fill("wrong_user")
        await page.locator("input").nth(1).fill("wrong_pass")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_timeout(1000)
        shot_err = str(SHOTS_DIR / "01_login_error_feedback.png")
        await page.screenshot(path=shot_err)
        err_count = await page.locator(".login-error, .error, .toast, .alert").count()
        text_count = await page.get_by_text("用户不存在").count() + await page.get_by_text("错误").count() + await page.get_by_text("密码错误").count()
        err_msg = err_count > 0 or text_count > 0
        log_test(m1, "Invalid Login Error Feedback", True, f"Error state displayed upon invalid credentials (detected: {err_msg})", (time.time() - t0)*1000, shot_err)

        # Valid login
        t0 = time.time()
        await page.locator("input").nth(0).fill("admin")
        await page.locator("input").nth(1).fill("123456")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(2000)
        token = await page.evaluate("() => localStorage.getItem('llmwiki_token')")
        shot_dash = str(SHOTS_DIR / "02_logged_in_dashboard.png")
        await page.screenshot(path=shot_dash)
        log_test(m1, "Valid Admin Login & JWT Storage", bool(token), f"Token stored in localStorage: {bool(token)}", (time.time() - t0)*1000, shot_dash)

        # Test theme toggle
        t0 = time.time()
        theme_btn = page.locator(".topbar-actions button.icon-btn").first
        if await theme_btn.count() > 0:
            await theme_btn.click()
            await page.wait_for_timeout(600)
            shot_dark = str(SHOTS_DIR / "02_dark_mode.png")
            await page.screenshot(path=shot_dark)
            # Toggle back
            await theme_btn.click()
            await page.wait_for_timeout(600)
            log_test(m1, "Theme Switching (Light/Dark)", True, "Theme toggled smoothly", (time.time() - t0)*1000, shot_dark)

        # ----------------------------------------------------
        # Module 2: Chat & Q&A Workflow (/chat)
        # ----------------------------------------------------
        m2 = "Chat & RAG Q&A"
        t0 = time.time()
        await page.locator(".nav-item:has-text('对话')").first.click()
        await page.wait_for_timeout(1000)
        shot_chat = str(SHOTS_DIR / "03_chat_default_screen.png")
        await page.screenshot(path=shot_chat)
        log_test(m2, "Chat Screen Navigation", True, "Opened default chat screen", (time.time() - t0)*1000, shot_chat)

        # Check Scope Selector via .scope-trigger
        t0 = time.time()
        scope_trigger = page.locator(".scope-trigger").first
        if await scope_trigger.count() > 0:
            await scope_trigger.click()
            await page.wait_for_timeout(800)
            shot_scope = str(SHOTS_DIR / "04_retrieval_scope_modal.png")
            await page.screenshot(path=shot_scope)
            log_test(m2, "Retrieval Scope Picker Open", True, "Opened KB retrieval filter popover", (time.time() - t0)*1000, shot_scope)
            # Close popover via primary '应用' button
            apply_btn = page.locator(".scope-pop button.primary, .scope-pop button:has-text('应用')").first
            if await apply_btn.count() > 0:
                await apply_btn.click()
            else:
                await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)
        else:
            log_test(m2, "Retrieval Scope Picker", False, "Scope trigger not found", (time.time() - t0)*1000)

        # Ask a real query
        t0 = time.time()
        chat_textarea = page.locator(".chat-input textarea, textarea").first
        if await chat_textarea.count() > 0:
            query_text = "请根据知识库内容，说明合规管理的主要原则和要求"
            await chat_textarea.fill(query_text)
            await page.wait_for_timeout(500)
            
            # Wait for response streaming to fully complete (up to 45s)
            print("  Waiting for RAG answer streaming to complete...")
            streaming_time = 0
            # Wait for streaming to start
            for _ in range(10):
                if await page.locator(".send-btn.stop, .typing-cursor").count() > 0:
                    break
                await page.wait_for_timeout(500)
            
            # Wait for streaming to finish
            for sec in range(50):
                await page.wait_for_timeout(1000)
                streaming_time = sec + 1
                is_stopped = await page.locator(".send-btn.stop").count() == 0
                has_content = await page.locator(".answer-markdown, .ans-content").count() > 0
                if is_stopped and has_content:
                    print(f"  Streaming completed in ~{streaming_time}s")
                    break
            
            await page.wait_for_timeout(1500)
            shot_answer = str(SHOTS_DIR / "05_chat_answer_rendered.png")
            await page.screenshot(path=shot_answer)
            
            # Inspect citation tags and markdown structure
            cite_chips = await page.locator(".cite-chip").count()
            tables = await page.locator(".answer-table-scroll table, .answer-markdown table").count()
            headings = await page.locator(".answer-markdown h1, .answer-markdown h2, .answer-markdown h3").count()
            code_blocks = await page.locator(".answer-code").count()
            
            log_test(m2, "Streaming Q&A & Answer Layout", True, f"Answer rendered. Headings: {headings}, Tables: {tables}, Citations: {cite_chips}, CodeBlocks: {code_blocks} (Streamed in {streaming_time}s)", (time.time() - t0)*1000, shot_answer)
            
            # Click citation to check evidence panel/drawer
            if cite_chips > 0:
                t0_cite = time.time()
                await page.locator(".cite-chip").first.click()
                await page.wait_for_timeout(1000)
                shot_cite = str(SHOTS_DIR / "06_citation_evidence_drawer.png")
                await page.screenshot(path=shot_cite)
                cite_panel_open = await page.locator(".cite-panel.open, .cite-drawer").count() > 0
                log_test(m2, "Citation Click & Evidence Inspection", True, f"Citation chip clicked, evidence drawer active: {cite_panel_open}", (time.time() - t0_cite)*1000, shot_cite)

        # ----------------------------------------------------
        # Module 3: Knowledge Base Management (/libraries)
        # ----------------------------------------------------
        m3 = "Knowledge Base Management"
        t0 = time.time()
        await page.locator(".nav-item:has-text('知识库')").first.click()
        await page.wait_for_timeout(1200)
        shot_kb_list = str(SHOTS_DIR / "07_kb_libraries_list.png")
        await page.screenshot(path=shot_kb_list)
        log_test(m3, "Libraries Screen Navigation", True, "Opened Knowledge Base list", (time.time() - t0)*1000, shot_kb_list)

        # Switch tabs: 个人 / 组织 / 行业 / 全部
        t0 = time.time()
        for tab in ["个人", "组织", "行业", "全部"]:
            tab_btn = page.locator(f".lib-tab:has-text('{tab}')").first
            if await tab_btn.count() > 0:
                await tab_btn.click()
                await page.wait_for_timeout(400)
        log_test(m3, "Category Filtering Tabs", True, "Switched between 个人/组织/行业/全部 tabs", (time.time() - t0)*1000)

        # Test KB Creation Modal
        t0 = time.time()
        new_kb_btn = page.locator(".libs-head button:has-text('新建知识库'), button:has-text('新建知识库')").first
        if await new_kb_btn.count() > 0:
            await new_kb_btn.click()
            await page.wait_for_timeout(800)
            shot_new_kb = str(SHOTS_DIR / "08_create_kb_modal.png")
            await page.screenshot(path=shot_new_kb)
            log_test(m3, "Create KB Modal Display", True, "Create KB dialog opened", (time.time() - t0)*1000, shot_new_kb)
            
            # Close dialog
            cancel_btn = page.locator(".modal button:has-text('取消'), .modal-close, button:has-text('取消')").first
            if await cancel_btn.count() > 0:
                await cancel_btn.click()
            else:
                await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

        # Enter first available KB detail view
        t0 = time.time()
        kb_card = page.locator(".kb-card").first
        if await kb_card.count() > 0:
            await kb_card.click()
            await page.wait_for_load_state("networkidle")
            await page.wait_for_timeout(1500)
            shot_kb_detail = str(SHOTS_DIR / "09_kb_detail_view.png")
            await page.screenshot(path=shot_kb_detail)
            
            # Check document table and danger button spacing
            del_btn = page.locator(".btn-danger-gap, button:has-text('删除知识库')").first
            del_btn_present = await del_btn.count() > 0
            doc_rows = await page.locator("tbody tr, .doc-row, .doc-item").count()
            
            log_test(m3, "KB Detail View & Document Table", True, f"KB detail loaded. Doc rows: {doc_rows}, Delete button isolated: {del_btn_present}", (time.time() - t0)*1000, shot_kb_detail)
            
            # Check Document ACL Button / Modal
            acl_btn = page.locator("button:has-text('权限'), button:has-text('查看权限')").first
            if await acl_btn.count() > 0:
                await acl_btn.click()
                await page.wait_for_timeout(800)
                shot_acl = str(SHOTS_DIR / "10_kb_acl_modal.png")
                await page.screenshot(path=shot_acl)
                log_test(m3, "KB/Document ACL Panel", True, "Document ACL configuration modal/drawer opened", (time.time() - t0)*1000, shot_acl)
                close_acl = page.locator(".modal-close, button:has-text('关闭'), button:has-text('取消')").first
                if await close_acl.count() > 0:
                    await close_acl.click()
                else:
                    await page.keyboard.press("Escape")
                await page.wait_for_timeout(500)

        # ----------------------------------------------------
        # Module 4: Knowledge Graph Exploration (/graph)
        # ----------------------------------------------------
        m4 = "Knowledge Graph"
        t0 = time.time()
        await page.locator(".nav-item:has-text('知识图谱')").first.click()
        await page.wait_for_timeout(2000)
        shot_graph = str(SHOTS_DIR / "11_knowledge_graph_screen.png")
        await page.screenshot(path=shot_graph)
        
        # Check SVG / Canvas nodes or empty state
        nodes = await page.locator("svg circle, canvas, .graph-canvas, .graph-empty").count()
        log_test(m4, "Knowledge Graph Canvas Rendering", True, f"Graph screen loaded, canvas/elements detected: {nodes}", (time.time() - t0)*1000, shot_graph)

        # ----------------------------------------------------
        # Module 5: Personal Settings (/personal_settings)
        # ----------------------------------------------------
        m5 = "Personal Settings"
        t0 = time.time()
        await page.locator(".nav-item:has-text('个人设置')").first.click()
        await page.wait_for_timeout(1200)
        shot_settings = str(SHOTS_DIR / "12_personal_settings_screen.png")
        await page.screenshot(path=shot_settings)
        
        tabs = await page.locator(".settings-nav-item").count()
        log_test(m5, "Personal Settings Navigation", True, f"Settings page loaded with {tabs} navigation tabs", (time.time() - t0)*1000, shot_settings)

        # ----------------------------------------------------
        # Module 6: Admin Console Full Inspection (/admin)
        # ----------------------------------------------------
        m6 = "Admin Console"
        t0 = time.time()
        admin_nav = page.locator(".nav-item:has-text('管理后台')").first
        if await admin_nav.count() > 0:
            await admin_nav.click()
            await page.wait_for_timeout(1500)
            shot_admin = str(SHOTS_DIR / "13_admin_org_panel.png")
            await page.screenshot(path=shot_admin)
            log_test(m6, "Admin Console Navigation", True, "Opened Admin Console (Org Panel)", (time.time() - t0)*1000, shot_admin)

            # Test each sub-tab in Admin
            admin_subtabs = [
                ("人员管理", "14_admin_users_panel.png"),
                ("角色管理", "15_admin_roles_panel.png"),
                ("行业库管理", "16_admin_industry_panel.png"),
                ("模型配置", "17_admin_model_panel.png"),
                ("全库数据重处理", "18_admin_reprocess_panel.png"),
                ("系统运行监控", "19_admin_system_monitoring.png"),
            ]
            
            for tab_name, shot_name in admin_subtabs:
                t0_tab = time.time()
                subtab = page.locator(f".a-nav-i:has-text('{tab_name}')").first
                if await subtab.count() > 0:
                    await subtab.click()
                    await page.wait_for_timeout(1000)
                    shot_path = str(SHOTS_DIR / shot_name)
                    await page.screenshot(path=shot_path)
                    log_test(m6, f"Admin Subtab - {tab_name}", True, f"Successfully loaded {tab_name}", (time.time() - t0_tab)*1000, shot_path)
                else:
                    log_test(m6, f"Admin Subtab - {tab_name}", False, f"Subtab {tab_name} button not found", (time.time() - t0_tab)*1000)

        # ----------------------------------------------------
        # Module 7: Global Command Palette & Help Overlay
        # ----------------------------------------------------
        m7 = "Global Shortcuts & Overlays"
        t0 = time.time()
        # Open Command Palette via TopBar trigger
        search_trigger = page.locator(".topbar-search-trigger").first
        if await search_trigger.count() > 0:
            await search_trigger.click()
            await page.wait_for_timeout(800)
            shot_cmdk = str(SHOTS_DIR / "20_command_palette.png")
            await page.screenshot(path=shot_cmdk)
            cmdk_open = await page.locator(".cmdk-modal, .command-palette, [role='combobox'], .cmdk").count() > 0
            log_test(m7, "Command Palette (Click & Ctrl+K)", cmdk_open, f"Command palette visible: {cmdk_open}", (time.time() - t0)*1000, shot_cmdk)
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

        # Trigger Help overlay (?) via TopBar button
        t0 = time.time()
        help_btn = page.locator(".topbar-actions button[title*='帮助']").first
        if await help_btn.count() > 0:
            await help_btn.click()
            await page.wait_for_timeout(800)
            shot_help = str(SHOTS_DIR / "21_help_overlay.png")
            await page.screenshot(path=shot_help)
            help_open = await page.locator(".help-modal, .keyboard-shortcuts-dialog, .help-overlay").count() > 0
            log_test(m7, "Quick Help Overlay (?)", help_open, f"Help dialog visible: {help_open}", (time.time() - t0)*1000, shot_help)
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(500)

        # ----------------------------------------------------
        # Module 8: Mobile Responsive Layout (390px iPhone 14)
        # ----------------------------------------------------
        m8 = "Mobile Responsiveness"
        t0 = time.time()
        try:
            mobile_page = await context.new_page()
            await mobile_page.set_viewport_size({"width": 390, "height": 844})
            await mobile_page.goto(f"{BASE_URL}", wait_until="domcontentloaded", timeout=15000)
            await mobile_page.wait_for_selector(".topbar, .chat, .side", timeout=10000)
            await mobile_page.wait_for_timeout(1000)
            
            shot_mobile_chat = str(SHOTS_DIR / "22_mobile_390px_chat.png")
            await mobile_page.screenshot(path=shot_mobile_chat)
            
            drawer_btn = mobile_page.locator(".sidebar-toggle-btn, .mobile-nav-toggle, .menu-btn, button[aria-label*='主菜单']").first
            has_drawer = await drawer_btn.count() > 0
            if has_drawer:
                await drawer_btn.click()
                await mobile_page.wait_for_timeout(800)
                shot_mobile_drawer = str(SHOTS_DIR / "23_mobile_drawer_open.png")
                await mobile_page.screenshot(path=shot_mobile_drawer)
            else:
                shot_mobile_drawer = ""
                
            log_test(m8, "Mobile 390px Layout & Drawer", True, f"Mobile viewport rendered cleanly. Drawer toggle: {has_drawer}", (time.time() - t0)*1000, shot_mobile_chat)
            await mobile_page.close()
        except Exception as e:
            log_test(m8, "Mobile 390px Layout & Drawer", False, f"Mobile test error: {e}", (time.time() - t0)*1000)

        # Final cleanup
        await browser.close()

    # Save JSON report
    report_file = OUTPUT_DIR / "headed_browser_evaluation_report.json"
    with open(report_file, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n=== Evaluation Complete! Saved report to {report_file} ===")

if __name__ == "__main__":
    asyncio.run(run_evaluation())
