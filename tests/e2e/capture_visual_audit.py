"""Capture all app screens for visual audit (light + dark)."""
import asyncio
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

TAG = sys.argv[1] if len(sys.argv) > 1 else "audit"
OUT = Path(f"/home/scottsun/gbrainkg/docs/test-reports/visual-audit/{TAG}")
OUT.mkdir(parents=True, exist_ok=True)
BASE_URL = os.environ.get("BASE_URL", "http://localhost:3200")


async def shot(page, name, wait=700, full=False):
    await page.wait_for_timeout(wait)
    await page.screenshot(path=str(OUT / f"{name}.png"), full_page=full)
    print(f"  ✓ {name}.png")


async def click_nav(page, label):
    nav = page.locator(f".nav-item:has-text('{label}')").first
    if await nav.count() and await awaitable_visible(nav):
        await nav.click()
        return True
    return False


async def awaitable_visible(loc):
    try:
        return await loc.is_visible()
    except Exception:
        return False


async def set_theme(page, theme):
    await page.evaluate(f"localStorage.setItem('llmwiki_theme','{theme}')")


async def capture_theme(page, theme):
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    await set_theme(page, theme)
    await page.goto(BASE_URL, wait_until="networkidle")
    await page.wait_for_timeout(1200)
    t = theme[:1]
    print(f"[{theme}]")

    # 00 Login
    await page.screenshot(path=str(OUT / f"{t}00_login.png"))
    print(f"  ✓ {t}00_login.png")

    # login
    inputs = page.locator("input:visible")
    if await inputs.count() >= 2:
        await inputs.nth(0).fill("admin")
        await inputs.nth(1).fill("123456")
        await page.locator("button:has-text('登录')").first.click()
        await page.wait_for_timeout(3000)

    # 01 Chat (default landing)
    await shot(page, f"{t}01_chat", 800)

    # 02-04 KB library + tabs
    if await click_nav(page, "知识库"):
        await shot(page, f"{t}02_kb_all", 1200)
        org_tab = page.locator(".lib-tab:has-text('组织')").first
        if await awaitable_visible(org_tab):
            await org_tab.click()
            await shot(page, f"{t}03_kb_org", 1000)
        ind_tab = page.locator(".lib-tab:has-text('行业')").first
        if await awaitable_visible(ind_tab):
            await ind_tab.click()
            await shot(page, f"{t}04_kb_industry", 1000)
        all_tab = page.locator(".lib-tab:has-text('全部')").first
        if await awaitable_visible(all_tab):
            await all_tab.click()
            await page.wait_for_timeout(800)

        # 05 KB detail: open first kb card
        card = page.locator(".kb-card, [class*='kb-card'], .lib-card").first
        if not await card.count():
            card = page.locator("text=文档（").first
        if await card.count() and await awaitable_visible(card):
            await card.click()
            await shot(page, f"{t}05_kb_detail", 1500)
            back = page.locator("button:has-text('返回'), [title*='返回']").first
            if await back.count() and await awaitable_visible(back):
                await back.click()
                await page.wait_for_timeout(600)

        # 06 New KB dialog
        create = page.locator("button:has-text('新建个人库')").first
        if await awaitable_visible(create):
            await create.click()
            await shot(page, f"{t}06_new_kb_dialog", 800)
            cancel = page.locator("button:has-text('取消')").first
            if await awaitable_visible(cancel):
                await cancel.click()
                await page.wait_for_timeout(400)

    # 07 Graph
    if await click_nav(page, "知识图谱"):
        await shot(page, f"{t}07_graph", 2500)
        # wait for actual graph to render (loading state -> canvas/svg nodes)
        try:
            await page.wait_for_selector(".graph-canvas svg, .kg-canvas svg, canvas", timeout=15000)
            await shot(page, f"{t}07b_graph_loaded", 2500)
        except Exception:
            pass

    # 08-14 Admin tabs
    if await click_nav(page, "管理后台"):
        await shot(page, f"{t}08_admin_org", 2000)
        admin_tabs = [
            ("人员管理", "09_admin_users"),
            ("角色管理", "10_admin_roles"),
            ("行业库管理", "11_admin_industry"),
            ("权限授权", "12_admin_grant"),
            ("模型配置", "13_admin_model"),
            ("全库数据重处理", "14_admin_reprocess"),
            ("审计日志", "15_admin_audit"),
            ("系统运行监控", "16_admin_status"),
        ]
        for label, name in admin_tabs:
            tab = page.locator(f".a-nav-i:has-text('{label}')").first
            if await tab.count() and await awaitable_visible(tab):
                await tab.click()
                await shot(page, f"{t}{name}", 1500)

    # 15 System settings
    if await click_nav(page, "系统设置"):
        await shot(page, f"{t}17_settings", 2000)

    # 16 Personal settings
    if await click_nav(page, "个人设置"):
        await shot(page, f"{t}18_personal_settings", 1500)

    # 17 Help overlay
    help_btn = page.locator("button[title*='帮助'], button[title*='?'], .icon-btn:has-text('?')").first
    if await help_btn.count():
        try:
            await help_btn.click(timeout=2000)
            await shot(page, f"{t}19_help", 1200)
            close = page.locator("button:has-text('关闭'), [title*='关闭'], .modal button").first
            if await close.count() and await awaitable_visible(close):
                await close.click()
                await page.wait_for_timeout(400)
        except Exception:
            pass

    # 18 Command palette (⌘K / Ctrl+K)
    await page.keyboard.press("Control+k")
    await shot(page, f"{t}20_cmdk", 900)
    await page.keyboard.press("Escape")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1.5)
        page = await ctx.new_page()
        await capture_theme(page, "dark")
        # clear auth token only (keep theme) so next run shows the login screen
        await page.evaluate("localStorage.removeItem('llmwiki_token')")
        await capture_theme(page, "light")
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
