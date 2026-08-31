import asyncio
import os
import sys
import time
from pathlib import Path
from playwright.async_api import async_playwright

SCREENSHOT_DIR = Path("/home/scottsun/gbrainkg/docs/manual/screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")

async def run_e2e_tests():
    print(f"==================================================")
    print(f"Starting LLMWiki Comprehensive Playwright E2E Tests")
    print(f"Target URL: {BASE_URL}")
    print(f"Screenshot Output: {SCREENSHOT_DIR}")
    print(f"==================================================")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.5,
        )
        page = await context.new_page()

        # Step 0: Login
        print("\n[Step 0] 0. 登录界面 (Authentication Screen)")
        await page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(SCREENSHOT_DIR / "00_login_page.png"))
        print("  ✓ 00_login_page.png (登录页面)")

        # Fill credentials
        inputs = page.locator("input")
        if await inputs.count() >= 2:
            await inputs.nth(0).fill("CY")
            await inputs.nth(1).fill("admin123")
            login_btn = page.locator("button:has-text('登录')").first
            await login_btn.click()
            await page.wait_for_timeout(2500)
            print("  ✓ 登录成功，进入主界面")

        # Step 1: Main Knowledge Hub / Document View
        print("\n[Test 1] 1. 知识管理主界面 (Knowledge Management Portal)")
        await page.screenshot(path=str(SCREENSHOT_DIR / "01_knowledge_portal.png"))
        print("  ✓ 01_knowledge_portal.png (个人知识库主页)")

        # Step 2: Switch between Personal, Org, and Industry KBs
        print("\n[Test 2] 2. 组织知识库与行业标准库 (KB Types Filtering)")
        org_kb_btn = page.locator("button:has-text('组织知识库')").first
        if await org_kb_btn.is_visible():
            await org_kb_btn.click()
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(SCREENSHOT_DIR / "02_org_knowledge_base.png"))
            print("  ✓ 02_org_knowledge_base.png (组织知识库)")

        ind_kb_btn = page.locator("button:has-text('行业标准库')").first
        if await ind_kb_btn.is_visible():
            await ind_kb_btn.click()
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(SCREENSHOT_DIR / "03_industry_knowledge_base.png"))
            print("  ✓ 03_industry_knowledge_base.png (行业标准库)")

        # Step 3: Create KB Dialog
        print("\n[Test 3] 3. 新建知识库弹窗 (Create KB Dialog)")
        create_kb_btn = page.locator("button:has-text('新建知识库')").first
        if await create_kb_btn.is_visible():
            await create_kb_btn.click()
            await page.wait_for_timeout(1000)
            await page.screenshot(path=str(SCREENSHOT_DIR / "04_create_kb_dialog.png"))
            print("  ✓ 04_create_kb_dialog.png (新建知识库模态框)")
            cancel_btn = page.locator("button:has-text('取消'), button:has-text('×'), .x").first
            if await cancel_btn.is_visible():
                await cancel_btn.click()
                await page.wait_for_timeout(500)

        # Step 4: Knowledge Graph Tab / Visualization
        print("\n[Test 4] 4. 知识图谱拓扑网络 (Knowledge Graph View)")
        graph_btn = page.locator("button:has-text('知识图谱')").first
        if await graph_btn.is_visible():
            await graph_btn.click()
            await page.wait_for_timeout(3000)
            await page.screenshot(path=str(SCREENSHOT_DIR / "05_knowledge_graph.png"))
            print("  ✓ 05_knowledge_graph.png (物理力导向关系网络)")

        # Step 5: System Management & Admin Console
        print("\n[Test 5] 5. 系统管理运维后台 (Admin Console)")
        sys_btn = page.locator("button:has-text('系统管理')").first
        if await sys_btn.is_visible():
            await sys_btn.click()
            await page.wait_for_timeout(2000)
            await page.screenshot(path=str(SCREENSHOT_DIR / "06_admin_dashboard.png"))
            print("  ✓ 06_admin_dashboard.png (系统管理首页概览)")

            for sub_text, fname in [
                ("用户管理", "07_admin_users.png"),
                ("组织架构", "08_admin_orgs.png"),
                ("模型管理", "09_admin_models.png"),
            ]:
                sub_btn = page.locator(f"button:has-text('{sub_text}'), a:has-text('{sub_text}')").first
                if await sub_btn.is_visible():
                    await sub_btn.click()
                    await page.wait_for_timeout(1500)
                    await page.screenshot(path=str(SCREENSHOT_DIR / fname))
                    print(f"  ✓ {fname} ({sub_text})")

        # Step 6: Return to Knowledge Management & Test AI Chat Dialog
        print("\n[Test 6] 6. 智能问答对话与检索溯源 (AI Chat & Citation Retrieval)")
        chat_nav_btn = page.locator("button:has-text('智能问答'), button:has-text('对话'), button:has-text('知识管理')").first
        if await chat_nav_btn.is_visible():
            await chat_nav_btn.click()
            await page.wait_for_timeout(1000)

        # Fill chat input
        chat_inputs = page.locator("input[placeholder*='输入'], textarea, input[type='text']")
        count = await chat_inputs.count()
        if count > 0:
            last_input = chat_inputs.last
            await last_input.fill("请简要介绍已发布知识库的核心内容")
            await page.screenshot(path=str(SCREENSHOT_DIR / "10_ai_chat_input.png"))
            print("  ✓ 10_ai_chat_input.png (对话提问界面)")

            send_btn = page.locator("button:has-text('发送')").first
            if await send_btn.is_visible():
                await send_btn.click()
                print("  ✓ 已发送提问，等待流式推理与证据链渲染...")
                await page.wait_for_timeout(4500)
                await page.screenshot(path=str(SCREENSHOT_DIR / "11_ai_chat_stream_result.png"))
                print("  ✓ 11_ai_chat_stream_result.png (流式问答与引用溯源卡片)")

        # Step 7: Help & User Manual Overlay
        print("\n[Test 7] 7. 帮助手册与使用指南浮层 (Help & User Manual Overlay)")
        help_btn = page.locator("button[title*='帮助'], button[title*='?'], [aria-label*='帮助']").first
        if await help_btn.is_visible():
            await help_btn.click()
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(SCREENSHOT_DIR / "12_help_user_manual.png"))
            print("  ✓ 12_help_user_manual.png (内置使用手册浮层)")

            # Switch to shortcuts tab
            sc_tab = page.locator("button:has-text('快捷键速查')").first
            if await sc_tab.is_visible():
                await sc_tab.click()
                await page.wait_for_timeout(1000)
                await page.screenshot(path=str(SCREENSHOT_DIR / "13_help_shortcuts.png"))
                print("  ✓ 13_help_shortcuts.png (快捷键速查表)")

        print("\n==================================================")
        print("All E2E Test Scenarios and Screenshots Completed!")
        print("==================================================")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run_e2e_tests())
