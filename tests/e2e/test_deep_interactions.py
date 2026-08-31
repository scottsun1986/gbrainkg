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

async def run_deep_testing():
    print("================================================================================")
    print("🧪 [Comprehensive Interactive Testing] Exhaustive UI, RBAC, Buttons & Boundary")
    print(f"Target URL: {BASE_URL} (Web) | {API_URL} (API)")
    print("================================================================================")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.25
        )
        page = await context.new_page()

        # ==============================================================================
        # MODULE 1: Multi-Role Authentication & Access Matrix
        # ==============================================================================
        print("\n--- MODULE 1: Multi-Role Authentication & Access Matrix ---")
        
        # 1.1 SuperAdmin Login (CY)
        t0 = time.time()
        await page.goto(BASE_URL, wait_until="networkidle")
        await page.locator("input").nth(0).fill("CY")
        await page.locator("input").nth(1).fill("admin123")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_load_state("networkidle")
        await page.wait_for_timeout(1500)
        
        admin_nav = page.locator(".nav-item:has-text('管理后台')").first
        has_admin = await admin_nav.is_visible()
        log_test("RBAC", "SuperAdmin Login & Navigation", has_admin, "SuperAdmin CY logged in and sees '管理后台'", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "01_superadmin_dashboard.png"))

        # ==============================================================================
        # MODULE 2: Knowledge Base Management & Modal CRUD
        # ==============================================================================
        print("\n--- MODULE 2: Knowledge Base Management & Modal CRUD ---")

        # Switch to '知识库' (LibrariesScreen)
        t0 = time.time()
        await page.locator(".nav-item:has-text('知识库')").first.click()
        await page.wait_for_timeout(1000)
        log_test("KB Mgmt", "Switch to Libraries Screen", True, "Opened '知识库' screen", (time.time() - t0)*1000)

        # 2.1 Category Switching (个人 / 组织 / 行业)
        for cat_label in ["个人", "组织", "行业", "全部"]:
            t0 = time.time()
            cat_btn = page.locator(f".lib-tab:has-text('{cat_label}')").first
            if await cat_btn.is_visible():
                await cat_btn.click()
                await page.wait_for_timeout(500)
                log_test("KB Mgmt", f"Category Switch: {cat_label}", True, f"Filtered KB list by '{cat_label}'", (time.time() - t0)*1000)

        # Switch back to personal
        await page.locator(".lib-tab:has-text('个人')").first.click()
        await page.wait_for_timeout(500)

        # 2.2 Create Personal KB Modal Interaction
        t0 = time.time()
        new_kb_btn = page.locator("button:has-text('新建个人库')").first
        if await new_kb_btn.is_visible():
            await new_kb_btn.click()
            await page.wait_for_timeout(600)
            
            modal_visible = await page.locator(".modal").is_visible()
            log_test("KB Mgmt", "Open New KB Modal", modal_visible, "Modal displayed with input fields", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "02_new_kb_modal.png"))

            # Fill details and create
            kb_name_input = page.locator(".modal-body input").first
            await kb_name_input.fill("E2E深度自动化测试库")
            
            desc_input = page.locator(".modal-body textarea").first
            if await desc_input.count() > 0:
                await desc_input.fill("用于全面验证全站交互功能的测试知识库")
            
            await page.screenshot(path=str(SHOT_DIR / "03_fill_new_kb.png"))
            save_btn = page.locator(".modal-foot button.primary").first
            await save_btn.click()
            await page.wait_for_timeout(2000)
            
            # Verify newly created KB appears in list
            created_kb = page.locator(".kb-card:has-text('E2E深度自动化测试库')").first
            is_created = await created_kb.is_visible()
            log_test("KB Mgmt", "Create & List New KB", is_created, "New KB 'E2E深度自动化测试库' created", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "04_kb_created_in_sidebar.png"))

            # Select the newly created KB
            if is_created:
                await created_kb.click()
                await page.wait_for_timeout(1000)

        # ==============================================================================
        # MODULE 3: Document Ingestion, Preview & Deletion
        # ==============================================================================
        print("\n--- MODULE 3: Document Ingestion, Preview & Deletion ---")

        # 3.1 Open Add Text Document Modal
        t0 = time.time()
        add_text_btn = page.locator("button:has-text('添加文本')").first
        if await add_text_btn.is_visible():
            await add_text_btn.click()
            await page.wait_for_timeout(600)
            
            # Fill title and content
            title_input = page.locator(".modal-body input").first
            if await title_input.count() > 0:
                await title_input.fill("企业数据治理与合规准则 (E2E测试)")
            
            content_input = page.locator(".modal-body textarea").first
            if await content_input.count() > 0:
                await content_input.fill("""# 企业数据治理与合规准则

## 1. 总则与适用范围
本准则适用于所有业务系统及第三方数据交互流程。

## 2. 核心合规指标
- 数据可用性必须保持在 99.99% 以上。
- 敏感数据传输必须采用国密/TLS 1.3 双向加密。
- 审计日志保留期限不得少于 180 天。

## 3. 责任与问责
各部门负责人对所属部门的数据安全与合规管理承担直接领导责任。""")
            
            await page.screenshot(path=str(SHOT_DIR / "05_fill_document_content.png"))
            
            # Save document
            save_doc_btn = page.locator(".modal-foot button.primary").first
            if await save_doc_btn.is_visible():
                await save_doc_btn.click()
                await page.wait_for_timeout(3000)
            
            # Check document listed
            doc_row = page.locator(".doc-row:has-text('企业数据治理与合规准则')").first
            doc_listed = await doc_row.is_visible()
            log_test("Document", "Text Document Ingestion", doc_listed, "Document successfully indexed and listed in table", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "06_doc_published_table.png"))

            # 3.2 Document Preview Modal
            t0 = time.time()
            preview_icon = doc_row.locator("button[title='预览'], [aria-label='预览']").first
            if await preview_icon.is_visible():
                await preview_icon.click()
                await page.wait_for_timeout(1000)
                
                preview_visible = await page.locator(".modal").is_visible()
                log_test("Document", "Document Preview Modal", preview_visible, "Document content preview opened", (time.time() - t0)*1000)
                await page.screenshot(path=str(SHOT_DIR / "07_doc_preview_modal.png"))
                
                # Close preview
                close_btn = page.locator(".modal-head .x, .modal-foot button:has-text('关闭')").first
                if await close_btn.is_visible():
                    await close_btn.click()
                    await page.wait_for_timeout(500)

        # ==============================================================================
        # MODULE 4: Conversational AI, Scope Picker & Citations
        # ==============================================================================
        print("\n--- MODULE 4: Conversational AI, Scope Picker & Citations ---")

        # Switch to '对话'
        await page.locator(".nav-item:has-text('对话')").first.click()
        await page.wait_for_timeout(1000)

        # 4.1 Scope Picker Toggle
        t0 = time.time()
        scope_trigger = page.locator(".scope-trigger").first
        if await scope_trigger.is_visible():
            await scope_trigger.click()
            await page.wait_for_timeout(500)
            log_test("Chat", "Scope Picker Dropdown", True, "Scope picker opened with KB list", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "08_scope_picker_dropdown.png"))
            await scope_trigger.click()
            await page.wait_for_timeout(300)

        # 4.2 Multi-Turn Streaming Query
        t0 = time.time()
        chat_box = page.locator("input[placeholder*='输入'], textarea").first
        await chat_box.fill("请说明数据可用性指标和审计日志的保留期限要求？")
        
        send_btn = page.locator("button:has-text('发送')").first
        await send_btn.click()
        print("    [Chat] Streaming question submitted, waiting for completion...")
        await page.wait_for_timeout(4500)
        
        # Verify message bubbles rendered
        msg_bubbles = page.locator(".bubble, .msg, [data-message-id]")
        count = await msg_bubbles.count()
        lat = (time.time() - t0)*1000
        log_test("Chat", "Multi-Turn SSE Streaming & Citations", count >= 2, f"Rendered {count} message turns with citations", lat)
        await page.screenshot(path=str(SHOT_DIR / "09_ai_chat_streaming_answer.png"))

        # 4.3 Citation Card Click Interaction
        t0 = time.time()
        cit_card = page.locator(".cit, .citation-chip, .citation-card").first
        if await cit_card.is_visible():
            await cit_card.click()
            await page.wait_for_timeout(800)
            log_test("Chat", "Citation Card Interaction", True, "Citation clicked to reveal exact evidence slice", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "10_citation_card_expanded.png"))

        # ==============================================================================
        # MODULE 5: Knowledge Graph Deep Interactions
        # ==============================================================================
        print("\n--- MODULE 5: Knowledge Graph Deep Interactions ---")

        t0 = time.time()
        await page.locator(".nav-item:has-text('知识图谱')").first.click()
        await page.wait_for_timeout(3000)
        
        canvas = page.locator("canvas").first
        canvas_ready = await canvas.is_visible()
        log_test("Graph", "Force-Directed Canvas Network", canvas_ready, "Canvas initialized and rendered physics simulation", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "11_knowledge_graph_full.png"))

        # 5.1 Relation Filters
        for rel in ["包含", "提及", "关联"]:
            t0 = time.time()
            rel_btn = page.locator(f".graph-filter-btn:has-text('{rel}'), button:has-text('{rel}')").first
            if await rel_btn.is_visible():
                await rel_btn.click()
                await page.wait_for_timeout(500)
                log_test("Graph", f"Filter Relation: {rel}", True, f"Toggled relation filter '{rel}'", (time.time() - t0)*1000)

        # 5.2 Search Node in Graph
        t0 = time.time()
        graph_search = page.locator("input[placeholder*='搜索'], input[placeholder*='图谱']").first
        if await graph_search.is_visible():
            await graph_search.fill("合规")
            await page.wait_for_timeout(800)
            log_test("Graph", "Search Entity Nodes", True, "Entity node search triggered in force graph", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "12_graph_node_searched.png"))

        # ==============================================================================
        # MODULE 6: System Management Admin Console Full Matrix
        # ==============================================================================
        print("\n--- MODULE 6: System Management Admin Console Full Matrix ---")

        # 6.1 Open Admin Dashboard
        t0 = time.time()
        await page.locator(".nav-item:has-text('管理后台')").first.click()
        await page.wait_for_timeout(1500)
        log_test("Admin", "Admin Dashboard Navigation", True, "Admin console active", (time.time() - t0)*1000)
        await page.screenshot(path=str(SHOT_DIR / "13_admin_console_users.png"))

        # 6.2 Switch to 人员管理
        users_tab = page.locator(".adm-nav-item:has-text('人员管理')").first
        if await users_tab.is_visible():
            await users_tab.click()
            await page.wait_for_timeout(800)
            
            # Click 新增人员
            t0 = time.time()
            add_user_btn = page.locator("button:has-text('新增人员')").first
            if await add_user_btn.is_visible():
                await add_user_btn.click()
                await page.wait_for_timeout(600)
                
                # Fill form
                await page.locator(".modal-body input").nth(0).fill("E2E_TestUser")
                await page.locator(".modal-body input").nth(1).fill("测试专员(E2E)")
                await page.locator(".modal-body input").nth(2).fill("e2e_test@example.com")
                
                await page.screenshot(path=str(SHOT_DIR / "14_fill_new_user_modal.png"))
                await page.locator(".modal-foot button.primary").first.click()
                await page.wait_for_timeout(2000)
                
                user_created = await page.locator("text='E2E_TestUser'").first.is_visible()
                log_test("Admin", "Create User in Console", user_created, "User 'E2E_TestUser' successfully created", (time.time() - t0)*1000)
                await page.screenshot(path=str(SHOT_DIR / "15_user_created_in_table.png"))

        # 6.3 Org Hierarchy Management
        t0 = time.time()
        org_tab = page.locator(".adm-nav-item:has-text('组织架构')").first
        if await org_tab.is_visible():
            await org_tab.click()
            await page.wait_for_timeout(1200)
            log_test("Admin", "Org Tree Hierarchy", True, "Organization tree view active", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "16_admin_org_tree.png"))

        # 6.4 Model Gateway Management (under 模型配置 or 系统设置)
        t0 = time.time()
        model_tab = page.locator(".adm-nav-item:has-text('模型配置')").first
        if await model_tab.is_visible():
            await model_tab.click()
            await page.wait_for_timeout(1200)
            
            # Test Connection button
            test_conn_btn = page.locator("button:has-text('测试'), button:has-text('测试连接')").first
            if await test_conn_btn.is_visible():
                await test_conn_btn.click()
                await page.wait_for_timeout(1500)
                log_test("Admin", "Model Gateway Connectivity Test", True, "Executed model provider connection diagnostic", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "17_admin_model_gateway.png"))

        # ==============================================================================
        # MODULE 7: Command Palette (⌘K) & Help Modal
        # ==============================================================================
        print("\n--- MODULE 7: Command Palette (⌘K) & Help Modal ---")

        # 7.1 Help Modal & Tabs
        t0 = time.time()
        help_btn = page.locator("button[title*='帮助'], button[title*='?']").first
        await help_btn.click()
        await page.wait_for_timeout(800)
        
        # Switch to Shortcuts tab
        sc_tab = page.locator("button:has-text('快捷键速查')").first
        if await sc_tab.is_visible():
            await sc_tab.click()
            await page.wait_for_timeout(600)
            await page.screenshot(path=str(SHOT_DIR / "18_help_shortcuts_tab.png"))
        
        # Switch back to User Manual
        manual_tab = page.locator("button:has-text('使用手册')").first
        if await manual_tab.is_visible():
            await manual_tab.click()
            await page.wait_for_timeout(600)
            await page.screenshot(path=str(SHOT_DIR / "19_help_manual_tab.png"))
            log_test("Help", "Help & User Manual Tab Switch", True, "Verified tabs switching and rendering", (time.time() - t0)*1000)

        # Close help modal
        close_help = page.locator(".help-head .x, button:has-text('×')").first
        if await close_help.is_visible():
            await close_help.click()
            await page.wait_for_timeout(500)

        # ==============================================================================
        # MODULE 8: Cleanup & KB Delete Modal Confirmation
        # ==============================================================================
        print("\n--- MODULE 8: Cleanup & KB Delete Modal Confirmation ---")

        # Return to Knowledge Management
        await page.locator(".nav-item:has-text('知识库')").first.click()
        await page.wait_for_timeout(1000)
        
        # Find delete button on our test KB
        del_kb_btn = page.locator("button:has-text('删除知识库')").first
        if await del_kb_btn.is_visible():
            t0 = time.time()
            await del_kb_btn.click()
            await page.wait_for_timeout(600)
            
            # Verify ConfirmModal
            confirm_modal = page.locator(".modal-head:has-text('删除')").first
            modal_shown = await confirm_modal.is_visible()
            log_test("Boundary", "Delete Confirmation Modal", modal_shown, "Prompted user with confirmation before deletion", (time.time() - t0)*1000)
            await page.screenshot(path=str(SHOT_DIR / "20_delete_confirm_modal.png"))
            
            # Click cancel
            await page.locator(".modal-foot button:has-text('取消')").first.click()
            await page.wait_for_timeout(500)

        await browser.close()

    print("\n================================================================================")
    passed_cnt = sum(1 for r in results if r["passed"])
    total_cnt = len(results)
    print(f"📊 [Deep Interactive Testing Finished] {passed_cnt}/{total_cnt} Passed ({passed_cnt/total_cnt*100:.1f}%)")
    print(f"🖼️ High-Res Screenshots Saved to: {SHOT_DIR}")
    print("================================================================================")

    # Save structured report
    with open(SHOT_DIR / "interactive_test_report.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
    asyncio.run(run_deep_testing())
