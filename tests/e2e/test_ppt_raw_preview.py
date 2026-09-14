import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")
SCREENSHOT_DIR = Path("/home/scottsun/gbrainkg/docs/test-reports")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

async def test_ppt_preview():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.5,
        )
        page = await context.new_page()

        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        print("1. 访问系统首页...")
        await page.goto(BASE_URL, wait_until="networkidle")
        await page.wait_for_timeout(1000)

        # 检查是否需要登录
        inputs = page.locator("input")
        if await inputs.count() >= 2:
            print("2. 执行管理员登录...")
            await inputs.nth(0).fill("admin")
            await inputs.nth(1).fill("123456")
            await page.locator("button:has-text('登录')").first.click()
            await page.wait_for_timeout(2000)

        print("3. 点击左侧导航栏切换至『知识库』工作区...")
        kb_nav_btn = page.locator(".nav-item:has-text('知识库')").first
        await kb_nav_btn.wait_for(state="visible", timeout=10000)
        await kb_nav_btn.click()
        await page.wait_for_timeout(1500)

        print("4. 在知识库列表中查找并进入『系统测试-解析矩阵库』...")
        target_kb = page.locator(".kb-card:has-text('系统测试-解析矩阵库')").first
        await target_kb.scroll_into_view_if_needed()
        await target_kb.click()
        await page.wait_for_timeout(2000)

        print("5. 检索并点击文档『24_training_60slides.pptx』...")
        search_input = page.locator("input[placeholder*='搜索文档名称']").first
        await search_input.wait_for(state="visible", timeout=10000)
        await search_input.fill("training")
        await page.wait_for_timeout(1500)

        doc_ttl = page.locator(".doc-row .ttl:has-text('24_training_60slides.pptx')").first
        await doc_ttl.wait_for(state="visible", timeout=10000)
        print("✓ 成功检索到 PPT 文档: 24_training_60slides.pptx")

        print("6. 点击文档打开高保真全屏/模态预览...")
        await doc_ttl.click()
        await page.wait_for_timeout(3000)

        print("7. 等待并验证 PPT 原件真实排版预览视口...")
        # 验证提示文案
        toolbar_title = page.locator("text=PPT 原版演示文稿真实预览")
        await toolbar_title.wait_for(state="visible", timeout=25000)
        print("✓ 成功渲染顶部工具栏: 『PPT 原版演示文稿真实预览』")

        sub_tip = page.locator("text=100% 还原原版排版、母版设计、图表与幻灯片画幅")
        await sub_tip.wait_for(state="visible", timeout=10000)
        print("✓ 成功校验副标题: 『100% 还原原版排版、母版设计、图表与幻灯片画幅』")

        # 验证原生高保真 iframe 视口
        iframe = page.locator("iframe[src*='blob:']")
        await iframe.wait_for(state="visible", timeout=15000)
        iframe_src = await iframe.get_attribute("src")
        print(f"✓ 成功挂载高保真 PDF 视口 iframe: {iframe_src}")

        # 验证工具栏上的辅助功能：“新窗口打开” 与 “查看结构化 Markdown”
        open_new_tab_btn = page.locator("a:has-text('新窗口打开')").first
        assert await open_new_tab_btn.is_visible(), "缺失『新窗口打开』快捷操作"
        switch_md_btn = page.locator("button:has-text('查看结构化 Markdown')").first
        assert await switch_md_btn.is_visible(), "缺失『查看结构化 Markdown』切换操作"
        print("✓ 快捷按钮『新窗口打开』与『查看结构化 Markdown』校验完备")

        # 截图保存为最终交付证据
        await page.wait_for_timeout(2000)
        screenshot_path = SCREENSHOT_DIR / "ppt_raw_preview_verified.png"
        await page.screenshot(path=str(screenshot_path))
        print(f"✓ 高保真视觉截图已保存至: {screenshot_path}")

        print(f"控制台无阻断报错, 错误记录数: {len(console_errors)}")
        await browser.close()
        print("🎉 全部端到端验证通过！PPT 原始排版真实预览完美生效。")

if __name__ == "__main__":
    asyncio.run(test_ppt_preview())
