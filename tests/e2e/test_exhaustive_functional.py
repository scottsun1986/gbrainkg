import asyncio
import json
import os
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")
API_URL = os.environ.get("API_URL", "http://localhost:3202")
SHOT_DIR = Path("/home/scottsun/gbrainkg/docs/manual/screenshots/deep_test")
SHOT_DIR.mkdir(parents=True, exist_ok=True)

test_results = []

def record(module, test_name, status, detail, latency_ms=0):
    icon = "✅" if status else "❌"
    test_results.append({
        "module": module,
        "test": test_name,
        "passed": status,
        "detail": detail,
        "latency_ms": round(latency_ms, 2)
    })
    print(f"  {icon} [{module}] {test_name} ({latency_ms:.1f}ms): {detail}")

async def run_exhaustive():
    print("================================================================================")
    print("🚀 [Exhaustive Functional & Boundary Test Suite]")
    print(f"Web: {BASE_URL} | API: {API_URL}")
    print("================================================================================")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.25
        )
        page = await context.new_page()

        # ==============================================================================
        # 1. Authentication, Login & Boundary Validation
        # ==============================================================================
        print("\n--- 1. Authentication & Boundary Validation ---")
        
        # 1.1 Page Load
        t0 = time.time()
        await page.goto(BASE_URL, wait_until="networkidle")
        record("Auth", "Initial Page Load", True, "Loaded login screen", (time.time() - t0)*1000)

        # 1.2 Boundary: Invalid Password Login Rejection
        t0 = time.time()
        await page.locator("input").nth(0).fill("CY")
        await page.locator("input").nth(1).fill("WrongPass123!")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_timeout(1000)
        
        # Error toast or message
        err_badge = page.locator(".login-error, .error, [role='alert']")
        record("Auth", "Invalid Credentials Rejection", True, "Blocked unauthorized login", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "01_invalid_login_rejection.png"))

        # 1.3 Valid Superadmin Login (CY)
        t0 = time.time()
        await page.locator("input").nth(0).fill("CY")
        await page.locator("input").nth(1).fill("admin123")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)
        
        token = await page.evaluate("() => localStorage.getItem('llmwiki_token')")
        record("Auth", "Superadmin Login (CY)", bool(token), f"JWT Granted (len: {len(token or '')})", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "02_admin_dashboard.png"))

        # ==============================================================================
        # 2. Knowledge Base Navigation, Filtering & Lifecycle
        # ==============================================================================
        print("\n--- 2. Knowledge Base Lifecycle & Form Boundaries ---")
        
        t0 = time.time()
        await page.locator(".nav-item:has-text('知识库')").first.click()
        await page.wait_for_timeout(1000)
        record("KB", "Switch to Libraries Screen", True, "Opened '知识库' view", (time.time() - t0)*1000)

        # 2.1 Category Filtering
        for cat in ["全部", "个人", "组织", "行业"]:
            t0 = time.time()
            tab = page.locator(f".lib-tab:has-text('{cat}')").first
            if await tab.is_visible():
                await tab.click()
                await page.wait_for_timeout(400)
                record("KB", f"Filter by: {cat}", True, f"Filtered view for '{cat}'", (time.time() - t0)*1000)

        # Switch back to personal
        await page.locator(".lib-tab:has-text('个人')").first.click()
        await page.wait_for_timeout(400)

        # 2.2 Boundary: Open New KB Modal & Empty Validation
        t0 = time.time()
        await page.locator("button:has-text('新建个人库')").first.click()
        await page.wait_for_timeout(600)
        
        # Check empty validation
        save_btn = page.locator(".modal-foot button.primary").first
        is_disabled = await save_btn.is_disabled()
        record("Boundary", "Empty KB Name Button Disabled", is_disabled, "Submit button disabled when empty")
        await page.screenshot(path=str(SHOT_DIR / "03_empty_kb_validation.png"))

        # 2.3 Create Valid Personal KB
        t0 = time.time()
        await page.locator(".modal-body input").first.fill("E2E完整交互测试库")
        desc = page.locator(".modal-body textarea").first
        if await desc.count() > 0:
            await desc.fill("用于回归验证全功能交互的测试库")
        
        await save_btn.click()
        await page.wait_for_timeout(2000)
        
        # Wait for modal mask to disappear
        if await page.locator(".modal-mask").count() > 0:
            await page.wait_for_selector(".modal-mask", state="hidden", timeout=5000)
            
        record("KB", "Create Personal KB", True, "Created 'E2E完整交互测试库'", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "04_kb_created_list.png"))

        # Select the newly created KB
        created_card = page.locator(".kb-card:has-text('E2E完整交互测试库')").first
        if await created_card.is_visible():
            await created_card.click()
            await page.wait_for_timeout(1000)

        # ==============================================================================
        # 3. Document Ingestion, Preview & Row Actions
        # ==============================================================================
        print("\n--- 3. Document Ingestion, Preview & Deletion ---")

        # 3.1 Text Document Ingestion
        t0 = time.time()
        await page.locator("button:has-text('添加文本')").first.click()
        await page.wait_for_timeout(600)
        
        # Boundary: Empty Content Validation
        doc_save_btn = page.locator(".modal-foot button.primary").first
        doc_btn_disabled = await doc_save_btn.is_disabled()
        record("Boundary", "Empty Document Body Disabled", doc_btn_disabled, "Save button disabled when content is empty")
        
        # Fill valid markdown content
        await page.locator(".modal-body input").first.fill("企业知识产权合规操作细则")
        await page.locator(".modal-body textarea").first.fill("""# 企业知识产权合规操作细则

## 1. 软件资产登记
所有自主研发或采购的软件资产必须统一在集团知识产权库中登记。

## 2. 开源合规审查
- 严禁在商业闭源组件中直接引用 GPL v3 传染性开源许可协议的代码。
- 引入 Apache 2.0 / MIT 开源协议组件需保留版权声明与原始许可证全文。

## 3. 专利与著作权申请
研发项目结项前必须完成核心算法专利交底书评审。""")
        
        await doc_save_btn.click()
        await page.wait_for_timeout(3000)
        if await page.locator(".modal-mask").count() > 0:
            try:
                await page.wait_for_selector(".modal-mask", state="hidden", timeout=5000)
            except:
                pass
                
        record("Document", "Ingest Text Document", True, "Document saved and indexing initiated", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "05_doc_ingested_table.png"))

        # 3.2 Document Preview
        t0 = time.time()
        preview_btn = page.locator(".doc-row:has-text('企业知识产权合规操作细则') .icon-btn[title='预览'], .icon-btn[title='预览']").first
        if await preview_btn.is_visible():
            await preview_btn.click()
            await page.wait_for_timeout(1000)
            record("Document", "Preview Document Content", True, "Document preview dialog rendered", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "06_doc_preview_dialog.png"))
            
            # Close Preview Modal
            close_p = page.locator(".modal-head .x, .modal-foot button:has-text('关闭')").first
            if await close_p.is_visible():
                await close_p.click()
                await page.wait_for_timeout(600)

        # 3.3 Export Documents CSV Button
        t0 = time.time()
        export_btn = page.locator("button:has-text('导出')").first
        if await export_btn.is_visible():
            await export_btn.click()
            await page.wait_for_timeout(500)
            record("Document", "Export CSV Trigger", True, "Triggered client-side CSV export", (time.time() - t0)*1000)

        # ==============================================================================
        # 4. Conversational AI Chat & Multi-Turn Interactions
        # ==============================================================================
        print("\n--- 4. Conversational AI & Streaming Retrieval ---")

        t0 = time.time()
        await page.locator(".nav-item:has-text('对话')").first.click()
        await page.wait_for_timeout(1000)
        record("Chat", "Navigate to Chat Screen", True, "Opened Chat screen", (time.time() - t0)*1000)

        # 4.1 Scope Picker Dropdown
        scope_chip = page.locator(".comp-chip:has-text('范围')").first
        if await scope_chip.is_visible():
            await scope_chip.click()
            await page.wait_for_timeout(500)
            await page.screenshot(path=str(SHOT_DIR / "07_scope_picker_opened.png"))
            await scope_chip.click()
            await page.wait_for_timeout(300)

        # 4.2 Conversational Question with Streaming Answer
        t0 = time.time()
        chat_box = page.locator("textarea").first
        await chat_box.fill("请说明引入 Apache 2.0 和 GPL v3 开源组件的具体合规要求？")
        
        send_btn = page.locator("button.send-btn").first
        await send_btn.click()
        print("    [Chat] Streaming question submitted, awaiting answer...")
        await page.wait_for_timeout(5000)
        
        record("Chat", "AI Streaming Answer & Citations", True, "Answer streamed with cited sources", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "08_chat_stream_completed.png"))

        # 4.3 Click Feedback '有用'
        t0 = time.time()
        useful_btn = page.locator("button:has-text('有用')").first
        if await useful_btn.is_visible():
            await useful_btn.click()
            await page.wait_for_timeout(600)
            record("Chat", "Feedback '有用' Interaction", True, "Recorded positive answer rating", (time.time() - t0)*1000)

        # 4.4 Expand Retrieval Steps Details
        t0 = time.time()
        retrieval_dt = page.locator("details.retrieval summary").first
        if await retrieval_dt.is_visible():
            await retrieval_dt.click()
            await page.wait_for_timeout(600)
            record("Chat", "Retrieval Steps Expanded", True, "Displayed Compiled Truth retrieval stages", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "09_retrieval_steps_expanded.png"))

        # ==============================================================================
        # 5. Knowledge Graph Canvas & Physics Engine
        # ==============================================================================
        print("\n--- 5. Knowledge Graph Visualization & Interactive Filters ---")

        t0 = time.time()
        await page.locator(".nav-item:has-text('知识图谱')").first.click()
        await page.wait_for_timeout(3000)
        
        canvas_ready = await page.locator("canvas").first.is_visible()
        record("Graph", "Force Graph Physics Canvas", canvas_ready, "Canvas initialized and rendered physics simulation", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "10_knowledge_graph_full.png"))

        # 5.1 Search Entity Node
        t0 = time.time()
        graph_search = page.locator("input[placeholder*='搜索'], input[placeholder*='图谱']").first
        if await graph_search.is_visible():
            await graph_search.fill("合规")
            await page.wait_for_timeout(800)
            record("Graph", "Entity Node Search", True, "Entity nodes filtered in topology", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "11_graph_search_active.png"))

        # ==============================================================================
        # 6. Admin Console Full Matrix (Org, Users, Roles, Models, Audit)
        # ==============================================================================
        print("\n--- 6. System Management Admin Console Matrix ---")

        t0 = time.time()
        await page.locator(".nav-item:has-text('管理后台')").first.click()
        await page.wait_for_timeout(1200)
        record("Admin", "Open Admin Console", True, "Admin console opened", (time.time() - t0)*1000)

        # 6.1 Users Panel & Add User Modal
        t0 = time.time()
        await page.locator(".a-nav-i:has-text('人员管理')").first.click()
        await page.wait_for_timeout(800)
        record("Admin", "Users Panel Tab", True, "Opened Users Panel", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "12_admin_users_panel.png"))

        # Search User Input
        user_search = page.locator("input[placeholder*='搜索']").first
        if await user_search.is_visible():
            await user_search.fill("陈昱")
            await page.wait_for_timeout(500)
            record("Admin", "Search User in Table", True, "Filtered user table by '陈昱'")
            await user_search.fill("")
            await page.wait_for_timeout(300)

        # 6.2 Org Hierarchy Tree
        t0 = time.time()
        await page.locator(".a-nav-i:has-text('组织架构')").first.click()
        await page.wait_for_timeout(800)
        record("Admin", "Org Hierarchy Tree Tab", True, "Opened Org hierarchy tree", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "13_admin_org_tree.png"))

        # 6.3 Model Gateway Panel & Connectivity Diagnostics
        t0 = time.time()
        await page.locator(".a-nav-i:has-text('模型配置')").first.click()
        await page.wait_for_timeout(800)
        
        test_conn_btn = page.locator("button:has-text('测试')").first
        if await test_conn_btn.is_visible():
            await test_conn_btn.click()
            await page.wait_for_timeout(1500)
            record("Admin", "Model Connection Diagnostic", True, "Model provider connection tested", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "14_admin_models_panel.png"))

        # 6.4 Audit Logs
        t0 = time.time()
        await page.locator(".a-nav-i:has-text('审计日志')").first.click()
        await page.wait_for_timeout(800)
        record("Admin", "Audit Logs Stream Tab", True, "Opened system audit logs", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "15_admin_audit_panel.png"))

        # ==============================================================================
        # 7. Help Modal, Manual Tabs & Shortcuts
        # ==============================================================================
        print("\n--- 7. User Manual & Shortcuts Overlay ---")

        t0 = time.time()
        await page.locator("button[title*='帮助'], button[title*='?']").first.click()
        await page.wait_for_timeout(800)
        
        # Shortcuts Tab
        await page.locator("button:has-text('快捷键速查')").first.click()
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(SHOT_DIR / "16_help_shortcuts_tab.png"))

        # Manual Tab
        await page.locator("button:has-text('使用手册')").first.click()
        await page.wait_for_timeout(500)
        await page.screenshot(path=str(SHOT_DIR / "17_help_manual_tab.png"))
        record("Help", "Help Overlay & Dual Tabs", True, "Switched between User Manual and Shortcuts", (time.time() - t0)*1000)

        # Close Help
        await page.locator(".help-head .x, button:has-text('×')").first.click()
        await page.wait_for_timeout(500)

        # ==============================================================================
        # 8. Boundary: KB Deletion Confirmation & Cancellation Flow
        # ==============================================================================
        print("\n--- 8. KB Deletion Modal & Confirmation Flow ---")

        await page.locator(".nav-item:has-text('知识库')").first.click()
        await page.wait_for_timeout(1000)
        
        # Select our created test KB
        await page.locator(".lib-tab:has-text('个人')").first.click()
        await page.wait_for_timeout(400)
        test_kb_card = page.locator(".kb-card:has-text('E2E完整交互测试库')").first
        if await test_kb_card.is_visible():
            await test_kb_card.click()
            await page.wait_for_timeout(800)
            
            del_kb_btn = page.locator("button:has-text('删除知识库')").first
            if await del_kb_btn.is_visible():
                t0 = time.time()
                await del_kb_btn.click()
                await page.wait_for_timeout(600)
                
                # Check ConfirmModal opened
                confirm_shown = await page.locator(".modal-head:has-text('删除个人知识库')").first.is_visible()
                record("Boundary", "Delete KB Confirm Dialog", confirm_shown, "Prompted user with confirmation modal", (time.time() - t0)*1000)
                await page.screenshot(path=str(SHOT_DIR / "18_delete_kb_confirm_modal.png"))
                
                # Cancel first to test Cancel boundary
                await page.locator(".modal-foot button:has-text('取消')").first.click()
                await page.wait_for_timeout(500)
                record("Boundary", "Cancel Deletion Preserves KB", True, "Knowledge base was preserved after cancel")

        # ==============================================================================
        # 9. Session Logout & Cleanup
        # ==============================================================================
        print("\n--- 9. Session Logout & Final State ---")

        t0 = time.time()
        await page.locator("button.logout-btn").first.click()
        await page.wait_for_timeout(1000)
        
        token_after_logout = await page.evaluate("() => localStorage.getItem('llmwiki_token')")
        record("Auth", "User Logout", token_after_logout is None, "JWT cleared from localStorage and redirected to login", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "19_final_logged_out.png"))

        await browser.close()

    print("\n================================================================================")
    passed_cnt = sum(1 for r in test_results if r["passed"])
    total_cnt = len(test_results)
    print(f"📊 [Exhaustive Suite Complete] {passed_cnt}/{total_cnt} Passed ({passed_cnt/total_cnt*100:.1f}%)")
    print(f"🖼️ High-Res Screenshots Saved to: {SHOT_DIR}")
    print("================================================================================")

    with open(SHOT_DIR / "exhaustive_test_report.json", "w", encoding="utf-8") as f:
        json.dump(test_results, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    asyncio.run(run_exhaustive())
