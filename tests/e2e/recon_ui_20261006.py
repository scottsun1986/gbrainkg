#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UI reconnaissance: login and dump interactive elements of each screen."""
import asyncio, json, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:3200"
OUT = "/home/scottsun/gbrainkg/tests/e2e/results/recon-20261006"

async def dump(page, name):
    await page.wait_for_timeout(800)
    await page.screenshot(path=f"{OUT}/{name}.png", full_page=False)
    items = await page.evaluate("""() => {
      const els = document.querySelectorAll('button, input, [role="button"], [role="tab"], a[href], select, textarea');
      return Array.from(els).filter(e => e.offsetParent !== null).map(e => ({
        tag: e.tagName.toLowerCase(),
        text: (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 40),
        id: e.id || '', cls: (e.className && typeof e.className === 'string') ? e.className.slice(0,50) : ''
      })).filter(x => x.text || x.id);
    }""")
    print(f"\n===== {name} ({len(items)} elements) =====")
    for it in items[:80]:
        print(f"  [{it['tag']}] text={it['text']!r} id={it['id']!r}")

async def main():
    import os
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=["--start-maximized", "--disable-notifications"])
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await ctx.new_page()
        await page.goto(BASE, wait_until="domcontentloaded")
        await page.wait_for_timeout(800)
        await dump(page, "01_login")
        # login
        await page.fill("#login-username", "admin")
        await page.fill("#login-password", "admin123")
        await page.click("button:has-text('登录')")
        await page.wait_for_timeout(3000)
        await dump(page, "02_chat")
        # libs screen
        try:
            await page.click("text=知识库")
            await page.wait_for_timeout(2000)
            await dump(page, "03_libs")
        except Exception as e:
            print("libs fail:", e)
        # admin screen
        try:
            await page.click("text=管理")
            await page.wait_for_timeout(2500)
            await dump(page, "04_admin")
        except Exception as e:
            print("admin fail:", e)
        # admin users tab
        try:
            await page.click("text=人员管理")
            await page.wait_for_timeout(2000)
            await dump(page, "05_admin_users")
        except Exception as e:
            print("users fail:", e)
        try:
            await page.click("text=组织架构")
            await page.wait_for_timeout(1500)
            await dump(page, "06_admin_org")
        except Exception as e:
            print("org fail:", e)
        try:
            await page.click("text=角色管理")
            await page.wait_for_timeout(1500)
            await dump(page, "07_admin_roles")
        except Exception as e:
            print("roles fail:", e)
        try:
            await page.click("text=行业库管理")
            await page.wait_for_timeout(1500)
            await dump(page, "08_admin_industry")
        except Exception as e:
            print("industry fail:", e)
        try:
            await page.click("text=权限授权")
            await page.wait_for_timeout(1500)
            await dump(page, "09_admin_grant")
        except Exception as e:
            print("grant fail:", e)
        try:
            await page.click("text=审计日志")
            await page.wait_for_timeout(1500)
            await dump(page, "10_admin_audit")
        except Exception as e:
            print("audit fail:", e)
        # graph + personal settings
        try:
            await page.click("text=知识图谱")
            await page.wait_for_timeout(2000)
            await dump(page, "11_graph")
        except Exception as e:
            print("graph fail:", e)
        try:
            await page.click("text=个人设置")
            await page.wait_for_timeout(1500)
            await dump(page, "12_personal_settings")
        except Exception as e:
            print("settings fail:", e)
        await browser.close()

asyncio.run(main())
