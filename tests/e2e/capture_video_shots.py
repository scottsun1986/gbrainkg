"""Capture 1080p light-theme screenshots for the product intro video.
Covers the full business flow: login -> three KB types -> permission center ->
permission contrast (admin vs normal user) -> scoped Q&A with citations -> audit/graph.
"""
import asyncio
import os
from pathlib import Path

from playwright.async_api import async_playwright

OUT = Path("/home/scottsun/gbrainkg/docs/video/screenshots")
OUT.mkdir(parents=True, exist_ok=True)
BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")


async def shot(page, name, wait=800):
    await page.wait_for_timeout(wait)
    await page.screenshot(path=str(OUT / f"{name}.png"))
    print(f"  ✓ {name}.png")


async def login(page, username, password):
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    await page.evaluate("localStorage.setItem('llmwiki_theme','light')")
    await page.evaluate("localStorage.removeItem('llmwiki_token')")
    await page.goto(BASE_URL, wait_until="networkidle")
    await page.wait_for_timeout(1200)
    inputs = page.locator("input:visible")
    if await inputs.count() >= 2:
        await inputs.nth(0).fill(username)
        await inputs.nth(1).fill(password)
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_timeout(3000)


async def click_nav(page, label):
    nav = page.locator(f".nav-item:has-text('{label}')").first
    if await nav.count():
        await nav.click()
        return True
    return False


async def admin_flow(page):
    print("[admin]")
    await shot(page, "v02_kb_tabs", 1500)
    await click_nav(page, "知识库")
    await shot(page, "v02_kb_tabs", 1800)

    # 新建个人库弹窗
    create = page.locator("button:has-text('新建个人库')").first
    if await create.count() and await create.is_visible():
        await create.click()
        await shot(page, "v03_new_kb_dialog", 900)
        cancel = page.locator("button:has-text('取消')").first
        if await cancel.count() and await cancel.is_visible():
            await cancel.click()
            await page.wait_for_timeout(400)

    # 打开一个有文档的库（系统测试-回归库v2 或首个）
    target = page.locator(".kb-card:has-text('系统测试-回归库v2')").first
    if await target.count() and await target.is_visible():
        await target.click()
        await shot(page, "v04_kb_docs_published", 2200)

    # 管理后台
    await click_nav(page, "管理后台")
    await shot(page, "v05_org_topology", 2500)
    for label, name, wait in [
        ("行业库管理", "v06_industry_mgmt", 1800),
        ("权限授权", "v07_grant_center", 1800),
        ("人员管理", "v08_users_roles", 2000),
        ("角色管理", "v09_roles", 1600),
        ("审计日志", "v10_audit", 1800),
        ("系统运行监控", "v11_status", 2200),
    ]:
        tab = page.locator(f".a-nav-i:has-text('{label}')").first
        if await tab.count() and await tab.is_visible():
            await tab.click()
            await shot(page, name, wait)

    # 知识图谱
    await click_nav(page, "知识图谱")
    try:
        await page.wait_for_selector(".graph-canvas svg", timeout=30000)
    except Exception:
        pass
    await shot(page, "v12_graph", 1500)


async def user_flow(page):
    print("[normal user lk]")
    # 普通用户知识库可见范围（权限对比）
    await click_nav(page, "知识库")
    await shot(page, "v13_user_kb_scope", 2000)
    # 数一下可见标签数量（供文档使用）
    try:
        counter = await page.locator(".lib-tab").all_inner_texts()
        print("  tabs:", " | ".join(t.replace("\n", " ") for t in counter))
    except Exception:
        pass

    # 对话：范围选择器 + 提问带引用
    await click_nav(page, "对话")
    await page.wait_for_timeout(1200)
    scope = page.locator(".scope-trigger").first
    if await scope.count() and await scope.is_visible():
        await scope.click()
        await shot(page, "v14_chat_scope_picker", 900)
        await scope.click()
        await page.wait_for_timeout(400)

    box = page.locator("input[placeholder*='输入'], textarea").first
    await box.fill("请说明数据可用性指标和审计日志的保留期限要求？")
    await box.press("Enter")
    await page.wait_for_timeout(9000)
    await shot(page, "v15_chat_citations", 800)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-proxy-server", "--disable-gpu", "--no-sandbox"])
        ctx = await browser.new_context(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
        page = await ctx.new_page()
        await page.route("**/fonts.googleapis.com/**", lambda route: route.abort())
        await page.route("**/fonts.gstatic.com/**", lambda route: route.abort())

        # 登录页
        await page.goto(BASE_URL, wait_until="domcontentloaded")
        await page.evaluate("localStorage.setItem('llmwiki_theme','light')")
        await page.goto(BASE_URL, wait_until="networkidle")
        await page.wait_for_timeout(1200)
        await page.screenshot(path=str(OUT / "v01_login.png"))
        print("  ✓ v01_login.png")

        await login(page, "admin", "123456")
        await admin_flow(page)

        # 切换普通用户
        await login(page, "lk", "123456")
        await user_flow(page)

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
