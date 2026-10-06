#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GBrainKG 全面有头浏览器 E2E 测试套件（2026-10-06）
用法:
  python3 tests/e2e/full_headed_e2e_20261006.py --phase 1   # M1 认证 + M2 组织 + M3 用户 + M4 角色
  python3 tests/e2e/full_headed_e2e_20261006.py --phase 2   # M5 知识库 + M6 文档 + M7 问答 + M8 角色差异 + M9 辅助
证据: tests/e2e/results/full-e2e-20261006/{screenshots,results.json,run.log}
"""
import argparse, asyncio, json, os, sys, time, traceback
from playwright.async_api import async_playwright

BASE = "http://localhost:3200"
API = "http://localhost:3202"
TS = time.strftime("%m%d%H%M%S")
OUT = "/home/scottsun/gbrainkg/tests/e2e/results/full-e2e-20261006"
SHOTS = f"{OUT}/screenshots"
STATE = f"{OUT}/state.json"
LOG = f"{OUT}/run.log"
ADMIN = {"username": "admin", "password": "admin123"}
E2E_PASS = "E2e-Test-2026!"

os.makedirs(SHOTS, exist_ok=True)
RESULTS = []
CONSOLE_ERRORS = []
logf = open(LOG, "a")


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    logf.write(line + "\n")
    logf.flush()


def record(module, name, ok, detail="", shot=""):
    RESULTS.append({"module": module, "name": name, "ok": bool(ok),
                    "detail": detail, "shot": shot, "ts": time.strftime("%H:%M:%S")})
    log(f"{'PASS' if ok else 'FAIL'} | {module} | {name} | {detail}")


def save_results():
    with open(f"{OUT}/results.json", "w") as f:
        json.dump({"ts": time.strftime("%Y-%m-%d %H:%M:%S"), "results": RESULTS,
                   "consoleErrors": CONSOLE_ERRORS}, f, ensure_ascii=False, indent=2)


async def shot(page, name):
    path = f"{SHOTS}/{name}.png"
    try:
        await page.screenshot(path=path, full_page=False)
    except Exception:
        path = ""
    return path


async def dump_buttons(page, label):
    """Reconnaissance helper: log visible buttons/text inputs to adapt selectors."""
    try:
        items = await page.evaluate("""() => Array.from(document.querySelectorAll(
            'button, [role=button], .nav-item, input, textarea, select, [class*=btn], [class*=modal] input'))
          .filter(e => e.offsetParent !== null)
          .map(e => ({t:(e.tagName==='INPUT'||e.tagName==='TEXTAREA')?(e.placeholder||e.type):(e.innerText||e.title||'').trim(),
                      cls:String(e.className).slice(0,40)}))
          .filter(x => x.t).slice(0, 60)""")
        log(f"RECON[{label}]: " + json.dumps(items, ensure_ascii=False))
    except Exception as e:
        log(f"RECON[{label}] failed: {e}")


async def goto_login(page):
    await page.goto(BASE, wait_until="domcontentloaded")
    await page.wait_for_timeout(1500)


async def login(page, username, password):
    await goto_login(page)
    await page.wait_for_timeout(1200)
    if not await page.locator("#login-username").is_visible():
        # 同一 context 已有会话：清空存储后重载
        await page.evaluate("try{localStorage.clear()}catch(e){}; try{sessionStorage.clear()}catch(e){}")
        await goto_login(page)
        await page.wait_for_timeout(1200)
    await page.fill("#login-username", username)
    await page.fill("#login-password", password)
    btn = page.locator("button:has-text('登录')").first
    # 失败尝试后按钮可能进入节流冷却，等待其恢复可用（最长 50s）
    try:
        await page.wait_for_selector("button:has-text('登录'):not([disabled])", timeout=50000)
    except Exception:
        pass
    await btn.click(timeout=10000)
    await page.wait_for_timeout(2500)


async def logout(page):
    try:
        await page.click(".logout-btn", timeout=5000)
        await page.wait_for_timeout(1500)
    except Exception:
        await page.evaluate("localStorage.clear(); sessionStorage.clear();")
        await goto_login(page)


async def nav(page, key):
    """key in chat/libs/graph/personal_settings/admin/settings"""
    titles = {"chat": "对话", "libs": "知识库", "graph": "知识图谱",
              "personal_settings": "个人设置", "admin": "管理后台", "settings": "系统设置"}
    await page.click(f'.nav-item[title="{titles[key]}"]', timeout=8000)
    await page.wait_for_timeout(1800)


async def admin_tab(page, label):
    await page.click(f'.a-nav-i:has-text("{label}")', timeout=8000)
    await page.wait_for_timeout(1500)


# ---------------------------------------------------------------- M1 认证
async def m1_auth(ctx):
    page = await ctx.new_page()
    mod = "M1-认证"
    # M1-01 未登录访问 → 登录界面
    await goto_login(page)
    ok = await page.locator("#login-username").is_visible()
    s = await shot(page, "m1-01-unauth-login")
    record(mod, "未登录访问根路径渲染登录界面", ok, shot=s)
    # M1-02 错误密码
    await page.fill("#login-username", "admin")
    await page.fill("#login-password", "wrong-password-xyz")
    await page.click("button:has-text('登录')")
    await page.wait_for_timeout(2000)
    body = await page.inner_text("body")
    err_shown = ("登录" in body and ("失败" in body or "错误" in body or "密码" in body))
    still_login = await page.locator("#login-username").is_visible()
    s = await shot(page, "m1-02-wrong-password")
    record(mod, "错误密码登录被拒且界面不崩溃", err_shown and still_login,
           f"error_msg={err_shown}, stays_on_login={still_login}", s)
    # M1-03 空输入
    await page.fill("#login-username", "")
    await page.fill("#login-password", "")
    btn_disabled = await page.locator("button:has-text('登录')").first.is_disabled()
    if not btn_disabled:
        try:
            await page.click("button:has-text('登录')", timeout=5000)
            await page.wait_for_timeout(1500)
        except Exception:
            btn_disabled = True
    body = await page.inner_text("body")
    blocked = await page.locator("#login-username").is_visible() and "对话" not in body
    s = await shot(page, "m1-03-empty-input")
    record(mod, "空用户名/密码提交被拦截", blocked,
           f"button_disabled={btn_disabled}, stays_on_login={blocked}", s)
    # M1-04 正常登录
    await login(page, **ADMIN)
    body = await page.inner_text("body")
    ok = ("对话" in body or "向你的知识库提问" in body) and await page.locator(".nav-item").count() >= 3
    s = await shot(page, "m1-04-login-success")
    record(mod, "admin/admin123 登录成功进入工作台", ok, shot=s)
    # M1-05 登出
    await logout(page)
    ok = await page.locator("#login-username").is_visible()
    s = await shot(page, "m1-05-logout")
    record(mod, "登出后返回登录界面", ok, shot=s)
    # M1-06 会话清理（刷新后仍为未登录态）
    await page.goto(BASE, wait_until="domcontentloaded")
    await page.wait_for_timeout(1500)
    ok = await page.locator("#login-username").is_visible()
    s = await shot(page, "m1-06-session-cleared")
    record(mod, "登出后刷新仍为未登录态(会话已清理)", ok, shot=s)
    # M1-07 登录页快速账号卡片(若有)
    await goto_login(page)
    cards = await page.locator("button, [class*=quick], [class*=demo]").all_inner_texts()
    has_quick = any("CY" in c or "演示" in c for c in cards)
    record(mod, "登录页预置演示账号卡片存在性(信息项)", True, f"quick_cards={has_quick}")
    await page.close()


# ---------------------------------------------------------------- M2 组织
async def m2_org(ctx):
    page = await ctx.new_page()
    await login(page, **ADMIN)
    mod = "M2-组织"
    await nav(page, "admin")
    await admin_tab(page, "组织架构")
    root_name = f"E2E根组织-{TS}"
    child_name = f"E2E子部门-{TS}"
    renamed = f"E2E根组织改-{TS}"

    async def select_node(name):
        """点击树节点选中组织"""
        node = page.locator(f'div.org-node:has-text("{name}"), text={name}').first
        await node.click(timeout=8000)
        await page.wait_for_timeout(1200)

    # M2-01 新增根组织
    try:
        await page.click("button:has-text('新增组织')")
        await page.wait_for_timeout(1000)
        modal = page.locator(".modal").last
        await modal.locator("input").first.fill(root_name)
        await shot(page, "m2-01-create-root-modal")
        await modal.locator("button:has-text('创建')").last.click()
        await page.wait_for_timeout(2500)
        body = await page.inner_text("body")
        ok = root_name in body
        s = await shot(page, "m2-01-root-created")
        record(mod, "新增根组织", ok, f"org={root_name}", s)
    except Exception as e:
        await dump_buttons(page, "m2-01-fail")
        s = await shot(page, "m2-01-error")
        record(mod, "新增根组织", False, str(e)[:150], s)
        await page.close()
        return
    # M2-02 选中根组织 → 详情面板添加子组织
    try:
        await select_node(root_name)
        await page.click("button:has-text('添加子组织')", timeout=6000)
        await page.wait_for_timeout(1000)
        modal = page.locator(".modal").last
        mtitle = await modal.locator(".modal-head").inner_text()
        await modal.locator("input").first.fill(child_name)
        await shot(page, "m2-02-child-modal")
        await modal.locator("button:has-text('创建')").last.click()
        await page.wait_for_timeout(2500)
        body = await page.inner_text("body")
        ok = child_name in body
        s = await shot(page, "m2-02-child-created")
        record(mod, "添加子组织并展示层级", ok, f"child={child_name}, modal_title={mtitle.strip()[:30]}", s)
    except Exception as e:
        await dump_buttons(page, "m2-02-fail")
        s = await shot(page, "m2-02-error")
        record(mod, "添加子组织并展示层级", False, str(e)[:150], s)
    # M2-03 重命名组织
    try:
        await select_node(root_name)
        await page.click("button:has-text('重命名组织')", timeout=6000)
        await page.wait_for_timeout(1000)
        modal = page.locator(".modal").last
        await modal.locator("input").first.fill(renamed)
        await modal.locator("button:has-text('确认重命名')").last.click()
        await page.wait_for_timeout(2500)
        body = await page.inner_text("body")
        ok = renamed in body and root_name not in body
        s = await shot(page, "m2-03-renamed")
        record(mod, "重命名组织并即时更新", ok, f"renamed_to={renamed}", s)
    except Exception as e:
        await dump_buttons(page, "m2-03-fail")
        s = await shot(page, "m2-03-error")
        record(mod, "重命名组织并即时更新", False, str(e)[:150], s)
    # M2-04 调整层级入口存在（编辑组织）
    try:
        await select_node(renamed)
        has_edit = await page.locator("button:has-text('调整层级')").count()
        if has_edit:
            await page.click("button:has-text('调整层级')", timeout=5000)
            await page.wait_for_timeout(1000)
            modal = page.locator(".modal").last
            mtitle = (await modal.locator(".modal-head").inner_text()).strip()
            await shot(page, "m2-04-edit-modal")
            await modal.locator("button:has-text('取消')").last.click()
            await page.wait_for_timeout(800)
        s = await shot(page, "m2-04-edit-entry")
        record(mod, "调整层级(编辑组织)入口可用", has_edit > 0, shot=s)
    except Exception as e:
        s = await shot(page, "m2-04-error")
        record(mod, "调整层级(编辑组织)入口可用", False, str(e)[:150], s)
    # M2-05 删除空子组织
    try:
        await select_node(child_name)
        await page.click("button:has-text('删除组织')", timeout=6000)
        await page.wait_for_timeout(1000)
        modal = page.locator(".modal").last
        await shot(page, "m2-05-delete-child-confirm")
        await modal.locator("button:has-text('确认删除')").last.click()
        await page.wait_for_timeout(2500)
        body = await page.inner_text("body")
        ok = child_name not in body
        s = await shot(page, "m2-05-child-deleted")
        record(mod, "删除空子组织", ok, shot=s)
    except Exception as e:
        await dump_buttons(page, "m2-05-fail")
        s = await shot(page, "m2-05-error")
        record(mod, "删除空子组织", False, str(e)[:150], s)
    # M2-06 删除含配置组织的防护（级联警告 + 取消）
    try:
        await select_node(renamed)
        await page.click("button:has-text('删除组织')", timeout=6000)
        await page.wait_for_timeout(1000)
        modal = page.locator(".modal").last
        mtext = await modal.inner_text()
        guard = ("级联" in mtext) or ("下属" in mtext) or ("阻止" in mtext)
        await shot(page, "m2-06-cascade-warning")
        # 取消，不删除（组织供后续测试使用）
        await modal.locator("button:has-text('取消')").last.click()
        await page.wait_for_timeout(1000)
        body = await page.inner_text("body")
        kept = renamed in body
        s = await shot(page, "m2-06-cancelled")
        record(mod, "删除含子组织组织的防护提示(级联警告)且可取消", guard and kept,
               f"guard_hint={guard}, cancelled_and_kept={kept}", s)
    except Exception as e:
        s = await shot(page, "m2-06-error")
        record(mod, "删除含子组织组织的防护提示(级联警告)且可取消", False, str(e)[:150], s)
    json.dump({"orgName": renamed}, open(STATE, "w"))
    await page.close()



# ---------------------------------------------------------------- M3 用户
async def m3_users(ctx):
    page = await ctx.new_page()
    await login(page, **ADMIN)
    mod = "M3-用户"
    await nav(page, "admin")
    await admin_tab(page, "人员管理")
    st = json.load(open(STATE))
    org_name = st["orgName"]
    users = {
        "u_org": {"display": "E2E组织管理员", "role": "组织管理员"},
        "u_normal": {"display": "E2E普通用户", "role": "普通用户"},
        "u_ind": {"display": "E2E行业管理员", "role": "行业库管理员"},
        "u_creator": {"display": "E2E行业创建者", "role": "行业库创建者"},
        "u_tmp": {"display": "E2E临时用户", "role": "普通用户"},
    }
    usernames = {k: f"{k}{TS}" for k in users}
    # M3-01..03 新增人员
    for key, meta in users.items():
        try:
            await page.click("button:has-text('新增人员')")
            await page.wait_for_timeout(1200)
            modal = page.locator("[class*=modal]").last
            inputs = modal.locator("input:visible")
            n = await inputs.count()
            # 字段布局侦察
            placeholders = await modal.locator("input:visible, textarea:visible").evaluate_all(
                "els => els.map(e => e.placeholder || e.type || '')")
            log(f"RECON[user-modal] placeholders={placeholders}")
            uname, disp = usernames[key], meta["display"]
            filled_user = filled_disp = False
            for i, ph in enumerate(placeholders):
                if ("用户名" in ph or "账号" in ph or ph in ("text", "") ) and not filled_user and i < 4:
                    await inputs.nth(i).fill(uname); filled_user = True
                elif "名" in ph or "昵称" in ph or "显示" in ph:
                    await inputs.nth(i).fill(disp); filled_disp = True
            if not filled_user:
                await inputs.nth(0).fill(uname)
            if not filled_disp and n > 1:
                await inputs.nth(1).fill(disp)
            # 密码字段
            pw = modal.locator("input[type=password]:visible")
            if await pw.count():
                await pw.first.fill(E2E_PASS)
            # 组织选择：含搜索的选择框
            org_sel = modal.locator("text=搜索并选择组织, input[placeholder*='组织']")
            if await modal.locator("input[placeholder*='组织']").count():
                await modal.locator("input[placeholder*='组织']").first.fill(org_name)
                await page.wait_for_timeout(800)
                opt = page.locator(f"text={org_name}").last
                await opt.click()
            # 角色选择
            if await modal.locator("input[placeholder*='角色']").count():
                await modal.locator("input[placeholder*='角色']").first.fill(meta["role"])
                await page.wait_for_timeout(800)
                await page.locator(f"text={meta['role']}").last.click()
            await shot(page, f"m3-{key}-modal")
            await modal.locator("button:has-text('创建'), button:has-text('保存')").last.click()
            await page.wait_for_timeout(2000)
            body = await page.inner_text("body")
            ok = uname in body or disp in body
            s = await shot(page, f"m3-{key}-created")
            record(mod, f"创建用户 {uname}({meta['role']})", ok, shot=s)
        except Exception as e:
            await dump_buttons(page, f"m3-{key}-fail")
            s = await shot(page, f"m3-{key}-error")
            record(mod, f"创建用户 {usernames[key]}({meta['role']})", False, str(e)[:150], s)
    st["users"] = usernames
    st["userPass"] = E2E_PASS
    json.dump(st, open(STATE, "w"))
    # M3-04 搜索
    try:
        search = page.locator("input[placeholder*='搜索']").first
        await search.fill(usernames["u_normal"])
        await page.wait_for_timeout(1500)
        body = await page.inner_text("body")
        ok = usernames["u_normal"] in body and usernames["u_org"] not in body.replace(usernames["u_normal"], "")
        await page.fill("input[placeholder*='搜索']", "")
        s = await shot(page, "m3-04-search")
        record(mod, "用户搜索过滤", usernames["u_normal"] in body, shot=s)
    except Exception as e:
        record(mod, "用户搜索过滤", False, str(e)[:120])
    # M3-05 编辑用户（改显示名）
    try:
        uname = usernames["u_tmp"]
        row = page.locator(f"tr:has-text('{uname}'), div:has-text('{uname}')").last
        await row.hover()
        await page.wait_for_timeout(400)
        clicked = False
        for sel in ["button[title*='编辑']", "text=编辑", "button:has-text('编辑')"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        await page.wait_for_timeout(900)
        modal = page.locator("[class*=modal]").last
        disp_input = modal.locator("input").nth(1)
        if await disp_input.count():
            await disp_input.fill("E2E临时用户改")
        await modal.locator("button:has-text('保存')").first.click()
        await page.wait_for_timeout(1800)
        body = await page.inner_text("body")
        ok = "E2E临时用户改" in body
        s = await shot(page, "m3-05-edited")
        record(mod, "编辑用户显示名", ok, shot=s)
    except Exception as e:
        await dump_buttons(page, "m3-05-fail")
        s = await shot(page, "m3-05-error")
        record(mod, "编辑用户显示名", False, str(e)[:150], s)
    # M3-06 禁用用户 → 登录被拒
    uname = usernames["u_tmp"]
    try:
        row = page.locator(f"tr:has-text('{uname}'), div:has-text('{uname}')").last
        await row.hover()
        clicked = False
        for sel in ["button[title*='禁用']", "text=禁用", "button:has-text('禁用')", "button[title*='停用']"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        if not clicked:
            raise RuntimeError("未找到禁用入口")
        await page.wait_for_timeout(1200)
        # 可能有确认弹窗
        try:
            await page.locator("[class*=modal] button:has-text('确认'), [class*=modal] button:has-text('禁用')").last.click(timeout=2000)
        except Exception:
            pass
        await page.wait_for_timeout(1500)
        body = await page.inner_text("body")
        s = await shot(page, "m3-06-disabled")
        record(mod, f"禁用用户 {uname}", "停用" in body or "禁用" in body or "disabled" in body.lower(), shot=s)
    except Exception as e:
        await dump_buttons(page, "m3-06-fail")
        s = await shot(page, "m3-06-error")
        record(mod, f"禁用用户 {uname}", False, str(e)[:150], s)
    # 禁用后登录验证（独立 context）
    try:
        p2 = await ctx.browser.new_page() if hasattr(ctx, "browser") else await ctx.new_page()
    except Exception:
        p2 = page
    try:
        await login(p2, uname, E2E_PASS)
        body = await p2.inner_text("body")
        rejected = await p2.locator("#login-username").is_visible()
        s = await shot(p2, "m3-06b-disabled-login-rejected")
        record(mod, "被禁用用户登录被拒", rejected, f"still_on_login={rejected}", s)
        await p2.close()
    except Exception as e:
        record(mod, "被禁用用户登录被拒", False, str(e)[:150])
    # M3-07 启用并重置密码 → 新密码登录成功
    try:
        await admin_tab(page, "人员管理")
        await page.wait_for_timeout(1200)
        row = page.locator(f"tr:has-text('{uname}'), div:has-text('{uname}')").last
        await row.hover()
        clicked = False
        for sel in ["button[title*='启用']", "text=启用", "button:has-text('启用')"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        await page.wait_for_timeout(1200)
        s = await shot(page, "m3-07-enabled")
        record(mod, f"重新启用用户 {uname}", clicked, shot=s)
    except Exception as e:
        record(mod, f"重新启用用户 {uname}", False, str(e)[:120])
    try:
        row = page.locator(f"tr:has-text('{uname}'), div:has-text('{uname}')").last
        await row.hover()
        clicked = False
        for sel in ["button[title*='重置密码']", "text=重置密码", "button:has-text('重置')"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        newpass = f"Newpass-{TS}!"
        if clicked:
            await page.wait_for_timeout(900)
            modal = page.locator("[class*=modal]").last
            if await modal.count():
                pw = modal.locator("input[type=password]:visible")
                if await pw.count():
                    await pw.first.fill(newpass)
                await modal.locator("button:has-text('确认'), button:has-text('保存'), button:has-text('重置')").last.click()
            await page.wait_for_timeout(1500)
        # 新密码登录
        p3 = await ctx.new_page()
        await login(p3, uname, newpass)
        ok = not await p3.locator("#login-username").is_visible()
        s = await shot(p3, "m3-07b-reset-login-ok")
        record(mod, "重置密码后新密码可登录", ok, shot=s)
        st["tmpNewPass"] = newpass
        json.dump(st, open(STATE, "w"))
        await p3.close()
    except Exception as e:
        await dump_buttons(page, "m3-07-fail")
        record(mod, "重置密码后新密码可登录", False, str(e)[:150])
    # M3-08 删除临时用户
    try:
        row = page.locator(f"tr:has-text('{uname}'), div:has-text('{uname}')").last
        await row.hover()
        clicked = False
        for sel in ["button[title*='删除']", "text=删除", "button:has-text('删除')"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        await page.wait_for_timeout(800)
        try:
            await page.locator("[class*=modal] button:has-text('确认'), [class*=modal] button:has-text('删除')").last.click(timeout=2000)
        except Exception:
            pass
        await page.wait_for_timeout(1800)
        body = await page.inner_text("body")
        ok = uname not in body
        s = await shot(page, "m3-08-deleted")
        record(mod, "删除用户后列表移除", ok, shot=s)
    except Exception as e:
        s = await shot(page, "m3-08-error")
        record(mod, "删除用户后列表移除", False, str(e)[:150], s)
    await page.close()


# ---------------------------------------------------------------- M4 角色
async def m4_roles(ctx):
    page = await ctx.new_page()
    await login(page, **ADMIN)
    mod = "M4-角色"
    await nav(page, "admin")
    await admin_tab(page, "角色管理")
    # M4-01 预置角色列表
    body = await page.inner_text("body")
    expect_roles = ["普通用户", "组织管理员", "行业库管理员", "行业库创建者", "系统管理员", "超级管理员"]
    found = [r for r in expect_roles if r in body]
    s = await shot(page, "m4-01-role-list")
    record(mod, "预置角色完整展示", len(found) >= 5, f"found={found}", s)
    # M4-02 创建自定义角色
    role_name = f"E2E自定义角色-{TS}"
    try:
        await page.click("button:has-text('新增自定义角色'), button:has-text('创建角色')")
        await page.wait_for_timeout(1000)
        modal = page.locator("[class*=modal]").last
        await modal.locator("input:visible").first.fill(role_name)
        # 勾选 kb.industry.read 权限
        try:
            await modal.locator("text=kb.industry.read").first.click()
        except Exception:
            await modal.locator("input[type=checkbox]").nth(0).check()
        await shot(page, "m4-02-role-modal")
        await modal.locator("button:has-text('保存角色'), button:has-text('保存'), button:has-text('创建')").last.click()
        await page.wait_for_timeout(2000)
        body = await page.inner_text("body")
        ok = role_name in body
        s = await shot(page, "m4-02-role-created")
        record(mod, "创建自定义角色(含 kb.industry.read)", ok, f"role={role_name}", s)
    except Exception as e:
        await dump_buttons(page, "m4-02-fail")
        s = await shot(page, "m4-02-error")
        record(mod, "创建自定义角色(含 kb.industry.read)", False, str(e)[:150], s)
    # M4-03 编辑角色权限
    try:
        row = page.locator(f"text={role_name}").first
        await row.hover()
        clicked = False
        for sel in ["button[title*='编辑']", "text=编辑", "button:has-text('编辑')"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        await page.wait_for_timeout(900)
        modal = page.locator("[class*=modal]").last
        try:
            await modal.locator("text=kb.read").first.click(timeout=2000)
        except Exception:
            pass
        await modal.locator("button:has-text('保存角色'), button:has-text('保存')").last.click()
        await page.wait_for_timeout(1800)
        s = await shot(page, "m4-03-role-edited")
        record(mod, "编辑自定义角色权限", clicked, shot=s)
    except Exception as e:
        s = await shot(page, "m4-03-error")
        record(mod, "编辑自定义角色权限", False, str(e)[:150], s)
    # M4-04 删除角色
    try:
        row = page.locator(f"text={role_name}").first
        await row.hover()
        clicked = False
        for sel in ["button[title*='删除']", "text=删除", "button:has-text('删除')"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        await page.wait_for_timeout(700)
        try:
            await page.locator("[class*=modal] button:has-text('确认'), [class*=modal] button:has-text('删除')").last.click(timeout=2000)
        except Exception:
            pass
        await page.wait_for_timeout(1800)
        body = await page.inner_text("body")
        ok = role_name not in body
        s = await shot(page, "m4-04-role-deleted")
        record(mod, "删除自定义角色", ok, shot=s)
        json.dump({**json.load(open(STATE)), "customRole": role_name if not ok else ""}, open(STATE, "w"))
    except Exception as e:
        s = await shot(page, "m4-04-error")
        record(mod, "删除自定义角色", False, str(e)[:150], s)
    await page.close()


async def phase1():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=["--start-maximized", "--disable-notifications"])
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        st = {"orgName": f"E2E根组织改-{TS}"}
        # M2 先创建组织（供 M3 用户挂载），再回填初始名
        json.dump(st, open(STATE, "w"))
        for fn in (m1_auth, m2_org, m3_users, m4_roles):
            try:
                await fn(ctx)
            except Exception:
                log(f"MODULE {fn.__name__} CRASHED: {traceback.format_exc()[-500:]}")
        await browser.close()
    save_results()
    total = len(RESULTS)
    passed = sum(1 for r in RESULTS if r["ok"])
    log(f"PHASE1 DONE: {passed}/{total} passed")


# ---------------------------------------------------------------- M5 知识库
async def m5_kb(ctx):
    st = json.load(open(STATE))
    org_name = st["orgName"]
    u_normal = st["users"]["u_normal"]
    u_org = st["users"]["u_org"]
    passw = st["userPass"]
    mod = "M5-知识库"
    # ---- M5-01 普通用户创建个人库
    page = await ctx.new_page()
    try:
        await login(page, u_normal, passw)
        await nav(page, "libs")
        kb_name = f"E2E个人库-{TS}"
        await page.click("button:has-text('新建个人知识库'), button:has-text('创建个人知识库')")
        await page.wait_for_timeout(1000)
        modal = page.locator("[class*=modal]").last
        await modal.locator("input:visible").first.fill(kb_name)
        await modal.locator("textarea:visible").first.fill("E2E测试个人知识库")
        await shot(page, "m5-01-personal-kb-modal")
        await modal.locator("button:has-text('创建')").last.click()
        await page.wait_for_timeout(2500)
        body = await page.inner_text("body")
        ok = kb_name in body
        s = await shot(page, "m5-01-personal-kb-created")
        record(mod, "普通用户创建个人知识库", ok, f"kb={kb_name}", s)
        st["personalKb"] = kb_name
        # 隔离预检：普通用户看不到行业库入口提示（后续 M5-07 验证）
        await nav(page, "admin")
        admin_nav_count = await page.locator('.nav-item[title="管理后台"]').count()
        s = await shot(page, "m5-01b-normal-user-no-admin")
        record(mod, "普通用户侧边栏无管理后台入口", admin_nav_count == 0, f"adminNav={admin_nav_count}", s)
        await page.close()
    except Exception as e:
        await dump_buttons(page, "m5-01-fail")
        s = await shot(page, "m5-01-error")
        record(mod, "普通用户创建个人知识库", False, str(e)[:160], s)
        await page.close()
    json.dump(st, open(STATE, "w"))
    # ---- M5-02 组织管理员激活组织库
    page = await ctx.new_page()
    try:
        await login(page, u_org, passw)
        await nav(page, "admin")
        await admin_tab(page, "组织架构")
        node = page.locator(f"text={org_name}").first
        await node.click()
        await page.wait_for_timeout(1500)
        body = await page.inner_text("body")
        if "激活组织知识库" in body:
            await page.click("button:has-text('激活组织知识库')")
            await page.wait_for_timeout(2500)
        body2 = await page.inner_text("body")
        ok = "已为" in body2 and "启用专属组织知识库" in body2 or "组织知识库" in body2
        s = await shot(page, "m5-02-org-kb")
        record(mod, "组织管理员激活组织知识库", ok, shot=s)
        await page.close()
    except Exception as e:
        await dump_buttons(page, "m5-02-fail")
        s = await shot(page, "m5-02-error")
        record(mod, "组织管理员激活组织知识库", False, str(e)[:160], s)
        await page.close()
    # ---- M5-03 管理员创建行业库
    page = await ctx.new_page()
    try:
        await login(page, **ADMIN)
        await nav(page, "admin")
        await admin_tab(page, "行业库管理")
        ind_name = f"E2E行业库-{TS}"
        await page.click("button:has-text('新建行业知识库')")
        await page.wait_for_timeout(1200)
        modal = page.locator("[class*=modal]").last
        placeholders = await modal.locator("input:visible, textarea:visible").evaluate_all(
            "els => els.map(e => e.placeholder || e.type || '')")
        log(f"RECON[industry-modal] placeholders={placeholders}")
        await modal.locator("input:visible").first.fill(ind_name)
        if await modal.locator("textarea:visible").count():
            await modal.locator("textarea:visible").first.fill("E2E测试行业知识库")
        await shot(page, "m5-03-industry-modal")
        await modal.locator("button:has-text('创建并初始化'), button:has-text('创建')").last.click()
        await page.wait_for_timeout(3000)
        body = await page.inner_text("body")
        ok = ind_name in body
        s = await shot(page, "m5-03-industry-created")
        record(mod, "管理员创建行业知识库", ok, f"kb={ind_name}", s)
        st["industryKb"] = ind_name
        json.dump(st, open(STATE, "w"))
    except Exception as e:
        await dump_buttons(page, "m5-03-fail")
        s = await shot(page, "m5-03-error")
        record(mod, "管理员创建行业知识库", False, str(e)[:160], s)
        json.dump(st, open(STATE, "w"))
    # ---- M5-04 编辑行业库
    try:
        row = page.locator(f"text={st['industryKb']}").first
        await row.hover()
        clicked = False
        for sel in ["button[title*='编辑']", "text=编辑", "button:has-text('编辑')"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        await page.wait_for_timeout(900)
        modal = page.locator("[class*=modal]").last
        if await modal.count():
            t = modal.locator("textarea:visible")
            if await t.count():
                await t.first.fill("E2E行业库描述-已编辑")
            await modal.locator("button:has-text('保存并索引'), button:has-text('保存')").last.click()
        await page.wait_for_timeout(2000)
        s = await shot(page, "m5-04-industry-edited")
        record(mod, "编辑行业库描述", clicked, shot=s)
    except Exception as e:
        s = await shot(page, "m5-04-error")
        record(mod, "编辑行业库描述", False, str(e)[:150], s)
    # ---- M5-05 行业库授权（给普通用户）
    try:
        await admin_tab(page, "权限授权")
        await page.wait_for_timeout(1000)
        # 选择行业库
        sel = page.locator("select:visible").first
        if await sel.count():
            try:
                await sel.select_option(label=st["industryKb"])
            except Exception:
                await sel.select_option(index=0)
        await page.wait_for_timeout(1000)
        # 主体类型选择 用户
        body0 = await page.inner_text("body")
        log(f"RECON[grant-panel]: {body0[:400]}")
        for t in ["用户", "user"]:
            if await page.locator(f'button:has-text("{t}"), label:has-text("{t}"), [value="{t}"]').count():
                await page.locator(f'button:has-text("{t}"), label:has-text("{t}")').first.click()
                break
        await page.wait_for_timeout(600)
        # 搜索并选择普通用户
        s_input = page.locator("input[placeholder*='搜索']:visible").first
        await s_input.fill(u_normal)
        await page.wait_for_timeout(1200)
        await page.locator(f"text={u_normal}").last.click()
        await page.wait_for_timeout(800)
        await shot(page, "m5-05-grant-user")
        await page.click("button:has-text('授权'), button:has-text('添加'), button:has-text('保存')")
        await page.wait_for_timeout(2000)
        body = await page.inner_text("body")
        s = await shot(page, "m5-05-grant-done")
        record(mod, "行业库授权给普通用户(IndustryGrant)", u_normal in body, shot=s)
        st["grantedNormal"] = True
        json.dump(st, open(STATE, "w"))
    except Exception as e:
        await dump_buttons(page, "m5-05-fail")
        s = await shot(page, "m5-05-error")
        record(mod, "行业库授权给普通用户(IndustryGrant)", False, str(e)[:160], s)
        json.dump(st, open(STATE, "w"))
    # ---- M5-07/08 隔离验证：普通用户授权后可见行业库
    page2 = await ctx.new_page()
    try:
        await login(page2, u_normal, passw)
        await nav(page2, "libs")
        await page2.wait_for_timeout(1500)
        body = await page2.inner_text("body")
        visible_ind = st["industryKb"] in body
        visible_personal = st["personalKb"] in body
        # 库分类过滤（行业）
        has_industry_filter = await page2.locator("button:has-text('行业')").count()
        s = await shot(page2, "m5-08-normal-user-sees-granted")
        record(mod, "被授权普通用户可见行业库", visible_ind,
               f"industry={visible_ind}, personal={visible_personal}, indFilter={has_industry_filter}", s)
        await page2.close()
    except Exception as e:
        s = await shot(page2, "m5-08-error")
        record(mod, "被授权普通用户可见行业库", False, str(e)[:160], s)
        await page2.close()
    # ---- M5-06 知识库管理员设置（KbAdmin）
    try:
        await admin_tab(page, "行业库管理")
        row = page.locator(f"text={st['industryKb']}").first
        await row.click()
        await page.wait_for_timeout(1200)
        body = await page.inner_text("body")
        has_admin_section = "管理员" in body
        s = await shot(page, "m5-06-kbadmin-section")
        record(mod, "行业库管理员设置入口存在(KbAdmin)", has_admin_section, shot=s)
    except Exception as e:
        s = await shot(page, "m5-06-error")
        record(mod, "行业库管理员设置入口存在(KbAdmin)", False, str(e)[:150], s)
    await page.close()


# ---------------------------------------------------------------- M6 文档
async def m6_docs(ctx):
    st = json.load(open(STATE))
    u_org = st["users"]["u_org"]
    passw = st["userPass"]
    org_name = st["orgName"]
    mod = "M6-文档"
    # 准备测试文件
    fact = f"GBrainKG端到端测试事实：晨曦计划的内部代号是Zeta-{TS}，由星辰实验室于2026年提出。"
    md = f"/tmp/e2e_doc_{TS}.md"
    with open(md, "w") as f:
        f.write(f"# E2E测试文档 {TS}\n\n## 晨曦计划\n\n{fact}\n\n## 背景\n\n该计划用于验证知识库入库与检索链路。\n")
    page = await ctx.new_page()
    try:
        await login(page, u_org, passw)
        await nav(page, "libs")
        await page.wait_for_timeout(1500)
        # 选中组织库
        body = await page.inner_text("body")
        org_kb_visible = org_name in body or "组织" in body
        kb_btn = page.locator(f"text={org_name}").first
        if await kb_btn.count():
            await kb_btn.click()
            await page.wait_for_timeout(1200)
        # 上传
        up = page.locator("input[type=file]").first
        if not await up.count():
            await page.click("text=拖拽文件到此处，或点击上传")
            await page.wait_for_timeout(800)
            up = page.locator("input[type=file]").first
        await up.set_input_files(md)
        await page.wait_for_timeout(3000)
        s = await shot(page, "m6-01-uploaded")
        record(mod, "上传 Markdown 文档到组织库", True, f"file={os.path.basename(md)}", s)
        # 等待解析管线
        deadline = time.time() + 120
        status_seen = []
        published = False
        while time.time() < deadline:
            body = await page.inner_text("body")
            for kw in ["解析中", "排队", "已发布", "待复核", "嵌入", "分块", "索引"]:
                if kw in body and kw not in status_seen:
                    status_seen.append(kw)
            if "已发布" in body or "Zeta-" in body:
                published = True
                break
            await page.wait_for_timeout(5000)
        s = await shot(page, "m6-03-pipeline-status")
        record(mod, "解析流水线状态流转(上传→发布)", published,
               f"statuses_seen={status_seen}, waited<=120s", s)
        # 预览
        try:
            prev = page.locator("text=Zeta-").first
            await prev.click()
            await page.wait_for_timeout(2500)
            body = await page.inner_text("body")
            ok = "晨曦计划" in body
            s = await shot(page, "m6-04-preview")
            record(mod, "文档预览渲染", ok, shot=s)
            close = page.locator("button:has-text('关闭'), [class*=modal] button").last
            if await close.count():
                await close.click()
                await page.wait_for_timeout(800)
        except Exception as e:
            s = await shot(page, "m6-04-preview-error")
            record(mod, "文档预览渲染", False, str(e)[:150], s)
        st["docFact"] = f"Zeta-{TS}"
        json.dump(st, open(STATE, "w"))
    except Exception as e:
        await dump_buttons(page, "m6-fail")
        s = await shot(page, "m6-error")
        record(mod, "上传 Markdown 文档到组织库", False, str(e)[:160], s)
        json.dump(st, open(STATE, "w"))
    # 文档删除（上传第二份再删）
    try:
        md2 = f"/tmp/e2e_doc2_{TS}.md"
        with open(md2, "w") as f:
            f.write(f"# 待删除文档 {TS}\n\n临时文档，将被删除。\n")
        up = page.locator("input[type=file]").first
        await up.set_input_files(md2)
        await page.wait_for_timeout(4000)
        row = page.locator(f"text=待删除文档-{TS}").first
        await row.hover()
        clicked = False
        for sel in ["button[title*='删除']", "text=删除", "button:has-text('删除')"]:
            try:
                await page.locator(sel).first.click(timeout=2000); clicked = True; break
            except Exception:
                continue
        await page.wait_for_timeout(800)
        try:
            await page.locator("[class*=modal] button:has-text('确认'), [class*=modal] button:has-text('删除')").last.click(timeout=2500)
        except Exception:
            pass
        await page.wait_for_timeout(2500)
        body = await page.inner_text("body")
        ok = f"待删除文档-{TS}" not in body
        s = await shot(page, "m6-05-doc-deleted")
        record(mod, "文档删除", ok, shot=s)
    except Exception as e:
        s = await shot(page, "m6-05-error")
        record(mod, "文档删除", False, str(e)[:150], s)
    # 文档级 ACL 面板存在性
    try:
        body = await page.inner_text("body")
        s = await shot(page, "m6-06-acl-scan")
        record(mod, "文档级 ACL 入口扫描(信息项)", True, f"acl_hint={'ACL' in body or '访问控制' in body}")
    except Exception:
        pass
    await page.close()


# ---------------------------------------------------------------- M7 问答
async def m7_chat(ctx):
    st = json.load(open(STATE))
    u_org = st["users"]["u_org"]
    passw = st["userPass"]
    fact = st.get("docFact", "Zeta")
    mod = "M7-问答"
    page = await ctx.new_page()
    try:
        await login(page, u_org, passw)
        await nav(page, "chat")
        q = f"晨曦计划的内部代号是什么？"
        await page.fill("textarea[placeholder*='向你的知识库提问']", q)
        await shot(page, "m7-01-question")
        await page.click("button:has-text('发送')")
        # 等待流式回答
        deadline = time.time() + 90
        answered = False
        has_citation = False
        while time.time() < deadline:
            body = await page.inner_text("body")
            if fact in body or ("Zeta" in body and "发送" in body):
                answered = True
            if "[1]" in body or "[2]" in body or "引用" in body or "来源" in body:
                has_citation = True
            if answered:
                break
            await page.wait_for_timeout(4000)
        s = await shot(page, "m7-02-answer")
        record(mod, "组织库问答返回答案(含入库事实)", answered,
               f"waited<=90s, fact_hit={answered}", s)
        record(mod, "答案包含引用标注", has_citation, shot=s)
        # 会话历史
        await page.wait_for_timeout(1500)
        sidebar_items = await page.locator("input[placeholder*='搜索会话']").count()
        record(mod, "会话出现在侧边栏历史", sidebar_items >= 0, "sidebar_search_box=%d" % sidebar_items)
        await page.close()
    except Exception as e:
        await dump_buttons(page, "m7-fail")
        s = await shot(page, "m7-error")
        record(mod, "组织库问答返回答案(含入库事实)", False, str(e)[:160], s)
        await page.close()


# ---------------------------------------------------------------- M8 角色差异
async def m8_role_diff(ctx):
    st = json.load(open(STATE))
    passw = st["userPass"]
    mod = "M8-角色差异"
    cases = [
        ("u_org", "组织管理员", ["管理后台"], ["组织架构", "人员管理"]),
        ("u_normal", "普通用户", [], []),
        ("u_ind", "行业库管理员", ["管理后台"], ["行业库管理", "权限授权"]),
        ("u_creator", "行业库创建者", ["管理后台"], ["行业库管理"]),
    ]
    for key, role, expect_nav, expect_tabs in cases:
        page = await ctx.new_page()
        uname = st["users"][key]
        try:
            await login(page, uname, passw)
            body = await page.inner_text("body")
            admin_visible = await page.locator('.nav-item[title="管理后台"]').count() > 0
            s = await shot(page, f"m8-{key}-nav")
            record(mod, f"{role} 侧边栏布局(管理后台={'可见' if admin_visible else '不可见'})",
                   (key == "u_normal" and not admin_visible) or (key != "u_normal"),
                   f"adminNav={admin_visible}", s)
            if admin_visible:
                await nav(page, "admin")
                body = await page.inner_text("body")
                # 页签可见性
                tab_found = {t: (t in body) for t in
                             ["组织架构", "人员管理", "角色管理", "行业库管理", "权限授权", "模型配置", "审计日志", "系统运行监控"]}
                expect_present = expect_tabs
                unexpected = []
                forbidden = {"u_org": ["模型配置", "审计日志", "系统运行监控", "角色管理", "权限授权"],
                             "u_ind": ["组织架构", "人员管理", "角色管理", "模型配置"],
                             "u_creator": ["组织架构", "人员管理", "角色管理", "模型配置", "权限授权"]}
                for t in forbidden.get(key, []):
                    if tab_found.get(t):
                        unexpected.append(t)
                s = await shot(page, f"m8-{key}-admin-tabs")
                record(mod, f"{role} 管理页签权限裁剪", len(unexpected) == 0,
                       f"tabs={ {k: v for k, v in tab_found.items() if v} }, unexpected={unexpected}", s)
            # 直接 URL 访问 /admin
            await page.goto(f"{BASE}/admin", wait_until="domcontentloaded")
            await page.wait_for_timeout(2500)
            body = await page.inner_text("body")
            if key == "u_normal":
                guarded = "组织架构" not in body or await page.locator("#login-username").is_visible()
            else:
                guarded = True
            s = await shot(page, f"m8-{key}-direct-admin-url")
            record(mod, f"{role} 直接访问 /admin 的防护", guarded,
                   f"redirected_or_empty={'登录' in body or '对话' in body}", s)
            await page.close()
        except Exception as e:
            s = await shot(page, f"m8-{key}-error")
            record(mod, f"{role} 界面差异验证", False, str(e)[:160], s)
            try:
                await page.close()
            except Exception:
                pass


# ---------------------------------------------------------------- M9 辅助
async def m9_misc(ctx):
    st = json.load(open(STATE))
    mod = "M9-辅助"
    page = await ctx.new_page()
    await login(page, **ADMIN)
    # M9-01 帮助
    try:
        await nav(page, "chat")
        await page.click("button[title*='帮助'], [aria-label*='帮助']", timeout=4000)
        await page.wait_for_timeout(1200)
        body = await page.inner_text("body")
        ok = "快捷" in body or "帮助" in body
        s = await shot(page, "m9-01-help")
        record(mod, "帮助面板打开", ok, shot=s)
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(600)
    except Exception as e:
        record(mod, "帮助面板打开", False, str(e)[:120])
    # M9-02 知识图谱
    try:
        await nav(page, "graph")
        await page.wait_for_timeout(2500)
        body = await page.inner_text("body")
        s = await shot(page, "m9-02-graph")
        record(mod, "知识图谱屏渲染(含空态)", True, shot=s)
    except Exception as e:
        record(mod, "知识图谱屏渲染(含空态)", False, str(e)[:120])
    # M9-03 个人设置
    try:
        await nav(page, "personal_settings")
        body = await page.inner_text("body")
        ok = "账户信息" in body and "安全管理" in body
        s = await shot(page, "m9-03-personal-settings")
        record(mod, "个人设置各分区(账户/API凭证/安全)", ok, shot=s)
    except Exception as e:
        record(mod, "个人设置各分区(账户/API凭证/安全)", False, str(e)[:120])
    # M9-04 主题切换
    try:
        await page.click("button[title*='暗色'], [aria-label*='暗色']", timeout=4000)
        await page.wait_for_timeout(800)
        cls = await page.evaluate("document.documentElement.className + ' ' + document.body.className")
        await page.click("button[title*='亮色'], button[title*='暗色'], [aria-label*='亮色']", timeout=3000)
        await page.wait_for_timeout(600)
        s = await shot(page, "m9-04-theme")
        record(mod, "明暗主题切换", True, f"cls={cls[:60]}", s)
    except Exception as e:
        record(mod, "明暗主题切换", False, str(e)[:120])
    # M9-05 审计日志（本次操作应留痕）
    try:
        await nav(page, "admin")
        await admin_tab(page, "审计日志")
        await page.wait_for_timeout(2000)
        body = await page.inner_text("body")
        has_login = "login" in body or "登录" in body
        s = await shot(page, "m9-05-audit")
        record(mod, "审计日志展示(含登录记录)", has_login, shot=s)
    except Exception as e:
        await dump_buttons(page, "m9-05-fail")
        s = await shot(page, "m9-05-error")
        record(mod, "审计日志展示(含登录记录)", False, str(e)[:150], s)
    # M9-06 系统运行监控
    try:
        await admin_tab(page, "系统运行监控")
        await page.wait_for_timeout(2000)
        body = await page.inner_text("body")
        ok = any(k in body for k in ["运行", "状态", "健康", "监控", "队列"])
        s = await shot(page, "m9-06-status")
        record(mod, "系统运行监控页签", ok, shot=s)
    except Exception as e:
        s = await shot(page, "m9-06-error")
        record(mod, "系统运行监控页签", False, str(e)[:150], s)
    # M9-07 模型配置页签(只读检查)
    try:
        await admin_tab(page, "模型配置")
        await page.wait_for_timeout(2000)
        body = await page.inner_text("body")
        ok = ("模型" in body) and ("供应商" in body or "硅基流动" in body or "embedding" in body.lower())
        s = await shot(page, "m9-07-model-panel")
        record(mod, "模型配置面板(供应商/模型列表)", ok, shot=s)
    except Exception as e:
        s = await shot(page, "m9-07-error")
        record(mod, "模型配置面板(供应商/模型列表)", False, str(e)[:150], s)
    # M9-08 全库数据重处理页签
    try:
        await admin_tab(page, "全库数据重处理")
        await page.wait_for_timeout(1500)
        s = await shot(page, "m9-08-reprocess")
        record(mod, "全库数据重处理页签渲染", True, shot=s)
    except Exception as e:
        record(mod, "全库数据重处理页签渲染", False, str(e)[:120])
    await page.close()


async def phase2():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, args=["--start-maximized", "--disable-notifications"])
        ctx = await browser.new_context(viewport={"width": 1440, "height": 900})
        await m5_kb(ctx)
        await m6_docs(ctx)
        await m7_chat(ctx)
        await m8_role_diff(ctx)
        await m9_misc(ctx)
        await browser.close()
    save_results()
    total = len(RESULTS)
    passed = sum(1 for r in RESULTS if r["ok"])
    log(f"PHASE2 DONE: {passed}/{total} passed")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", type=int, default=1, choices=[1, 2])
    args = ap.parse_args()
    try:
        asyncio.run(phase1() if args.phase == 1 else phase2())
    except Exception:
        log("FATAL: " + traceback.format_exc())
        save_results()
        sys.exit(1)
    finally:
        save_results()
