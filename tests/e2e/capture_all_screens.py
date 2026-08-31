import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

SCREENSHOT_DIR = Path("/home/scottsun/gbrainkg/docs/manual/screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)
BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")

async def capture_all():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.5,
        )
        page = await context.new_page()

        # 00. Login Page
        await page.goto(BASE_URL, wait_until="networkidle")
        await page.wait_for_timeout(1000)
        await page.screenshot(path=str(SCREENSHOT_DIR / "00_login_page.png"))
        print("✓ 00_login_page.png")

        # Perform login
        inputs = page.locator("input")
        if await inputs.count() >= 2:
            await inputs.nth(0).fill("CY")
            await inputs.nth(1).fill("admin123")
            await page.locator("button:has-text('登录')").first.click()
            await page.wait_for_timeout(2500)

        # 01. Personal Knowledge Base
        await page.screenshot(path=str(SCREENSHOT_DIR / "01_personal_kb.png"))
        print("✓ 01_personal_kb.png")

        # 02. Org Knowledge Base
        org_tab = page.locator("button:has-text('组织知识库')").first
        if await org_tab.is_visible():
            await org_tab.click()
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(SCREENSHOT_DIR / "02_org_kb.png"))
            print("✓ 02_org_kb.png")

        # 03. Industry Knowledge Base
        ind_tab = page.locator("button:has-text('行业标准库')").first
        if await ind_tab.is_visible():
            await ind_tab.click()
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(SCREENSHOT_DIR / "03_industry_kb.png"))
            print("✓ 03_industry_kb.png")

        # 04. Create KB Dialog
        create_btn = page.locator("button:has-text('新建知识库')").first
        if await create_btn.is_visible():
            await create_btn.click()
            await page.wait_for_timeout(1000)
            await page.screenshot(path=str(SCREENSHOT_DIR / "04_create_kb_dialog.png"))
            print("✓ 04_create_kb_dialog.png")
            # Close dialog
            cancel_btn = page.locator("button:has-text('取消'), .x, button:has-text('×')").first
            if await cancel_btn.is_visible():
                await cancel_btn.click()
                await page.wait_for_timeout(500)

        # 05. Knowledge Graph
        graph_nav = page.locator("button:has-text('知识图谱')").first
        if await graph_nav.is_visible():
            await graph_nav.click()
            await page.wait_for_timeout(3000)
            await page.screenshot(path=str(SCREENSHOT_DIR / "05_knowledge_graph.png"))
            print("✓ 05_knowledge_graph.png")

        # 06. Admin Console - Users
        admin_nav = page.locator("button:has-text('系统管理')").first
        if await admin_nav.is_visible():
            await admin_nav.click()
            await page.wait_for_timeout(2000)
            await page.screenshot(path=str(SCREENSHOT_DIR / "06_admin_users.png"))
            print("✓ 06_admin_users.png")

            # 07. Admin Console - Orgs
            org_nav = page.locator("button:has-text('组织架构'), a:has-text('组织架构')").first
            if await org_nav.is_visible():
                await org_nav.click()
                await page.wait_for_timeout(1500)
                await page.screenshot(path=str(SCREENSHOT_DIR / "07_admin_orgs.png"))
                print("✓ 07_admin_orgs.png")

            # 08. Admin Console - Models
            model_nav = page.locator("button:has-text('模型管理'), a:has-text('模型管理')").first
            if await model_nav.is_visible():
                await model_nav.click()
                await page.wait_for_timeout(1500)
                await page.screenshot(path=str(SCREENSHOT_DIR / "08_admin_models.png"))
                print("✓ 08_admin_models.png")

        # 09. Chat view
        chat_nav = page.locator("button:has-text('知识管理')").first
        if await chat_nav.is_visible():
            await chat_nav.click()
            await page.wait_for_timeout(1000)

        chat_input = page.locator("input[placeholder*='输入'], textarea").first
        if await chat_input.is_visible():
            await chat_input.fill("请查询合规制度相关的主要要求")
            send_btn = page.locator("button:has-text('发送')").first
            if await send_btn.is_visible():
                await send_btn.click()
                await page.wait_for_timeout(3500)
            await page.screenshot(path=str(SCREENSHOT_DIR / "09_ai_chat_dialog.png"))
            print("✓ 09_ai_chat_dialog.png")

        # 10. Help - User Manual
        help_btn = page.locator("button[title*='帮助'], button[title*='?']").first
        if await help_btn.is_visible():
            await help_btn.click()
            await page.wait_for_timeout(1500)
            await page.screenshot(path=str(SCREENSHOT_DIR / "10_help_user_manual.png"))
            print("✓ 10_help_user_manual.png")

            # 11. Help - Shortcuts
            sc_btn = page.locator("button:has-text('快捷键速查')").first
            if await sc_btn.is_visible():
                await sc_btn.click()
                await page.wait_for_timeout(1000)
                await page.screenshot(path=str(SCREENSHOT_DIR / "11_help_shortcuts.png"))
                print("✓ 11_help_shortcuts.png")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(capture_all())
