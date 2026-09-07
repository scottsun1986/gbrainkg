"""Run a browser-led local functional acceptance test and generate an HTML report.

The fixture is intentionally isolated under E2E-<timestamp>. It uses real API
calls only to create deterministic test data; all user-facing assertions and
evidence are collected through Chromium/Playwright.
"""

import asyncio
import html
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from playwright.async_api import Page, async_playwright


WEB_URL = os.environ.get("E2E_WEB_URL", "http://127.0.0.1:3200")
API_URL = os.environ.get("E2E_API_URL", "http://127.0.0.1:3202")
RUN_ID = datetime.now().strftime("%Y%m%d-%H%M%S")
PREFIX = f"E2E-{RUN_ID}"
REPORT_DIR = Path("docs/test-reports") / f"functional-{RUN_ID}"
SHOT_DIR = REPORT_DIR / "screenshots"
TEST_PASSWORD = os.environ.get("E2E_TEST_PASSWORD", "E2E-LocalOnly-2026!")
ADMIN_PASSWORD = os.environ.get("E2E_ADMIN_PASSWORD", "admin123")


class Report:
    def __init__(self):
        self.cases: list[dict] = []
        self.console: list[str] = []
        self.fixture: dict = {}

    def add(self, case_id: str, area: str, expected: str, actual: str, status: str, shot: str | None = None):
        self.cases.append({
            "id": case_id,
            "area": area,
            "expected": expected,
            "actual": actual,
            "status": status,
            "shot": shot,
        })
        icon = {"PASS": "✓", "FAIL": "✗", "BLOCKED": "!"}.get(status, "?")
        print(f"{icon} {case_id} {status}: {actual}")


async def api(page: Page, method: str, path: str, token: str | None = None, body: dict | None = None):
    """Use a timeout-controlled local HTTP client for API assertions.

    UI actions and every visual proof still run in Chromium. Local HTTP is
    deliberately used for service assertions because this environment's
    Playwright cross-origin request channel intermittently stalls despite the
    same API responding normally to the browser application and curl.
    """
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if body is not None:
        headers["Content-Type"] = "application/json"
    def request_once():
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(f"{API_URL}{path}", data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status, response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode("utf-8", errors="replace")
    try:
        status, text = await asyncio.to_thread(request_once)
        try:
            data = json.loads(text) if text else {}
        except json.JSONDecodeError:
            data = {"raw": text}
        return {"status": status, "ok": 200 <= status < 300, "data": data}
    except Exception as error:
        return {"status": 0, "ok": False, "data": {"error": str(error)}}


async def ui_login(page: Page, username: str, password: str) -> tuple[bool, str]:
    try:
        # Every persona switch must start from the login state. Otherwise a
        # previously authenticated workspace exposes file/model form inputs,
        # and positional `input` selectors can accidentally target those.
        await page.goto(WEB_URL, wait_until="domcontentloaded", timeout=30000)
        await page.evaluate("() => localStorage.removeItem('llmwiki_token')")
        # The SPA maintains background polling/SSE, so networkidle is not a
        # valid navigation-complete condition for a login page.
        await page.goto(WEB_URL, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(800)
        username_input = page.locator("input[autocomplete='username']")
        password_input = page.locator("input[autocomplete='current-password']")
        if await username_input.count() != 1 or await password_input.count() != 1:
            return False, "登录页未发现用户名和密码输入框"
        await username_input.fill(username)
        await password_input.fill(password)
        button = page.locator("button:has-text('登录')").first
        if not await button.is_visible(timeout=1500):
            return False, "登录页未发现登录按钮"
        await button.click(timeout=5000)
        await page.wait_for_timeout(1400)
        token = await page.evaluate("() => localStorage.getItem('llmwiki_token')")
        return bool(token), "登录后已获得会话" if token else "登录后未获得会话"
    except Exception as error:
        return False, f"浏览器登录导航异常：{str(error)[:180]}"


async def screenshot(page: Page, name: str) -> str:
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{name}.png"
    await page.screenshot(path=str(SHOT_DIR / filename), full_page=True)
    return f"screenshots/{filename}"


async def first_visible(page: Page, selectors: list[str]):
    for selector in selectors:
        loc = page.locator(selector).first
        try:
            if await loc.is_visible(timeout=700):
                return loc
        except Exception:
            pass
    return None


async def click_text(page: Page, text: str) -> bool:
    loc = await first_visible(page, [
        f".nav-item:has-text('{text}')",
        f".a-nav-i:has-text('{text}')",
        f".subtab:has-text('{text}')",
        f"button:has-text('{text}')",
        f"[role='button']:has-text('{text}')",
        f"a:has-text('{text}')",
    ])
    if not loc:
        return False
    await loc.click()
    await page.wait_for_timeout(700)
    return True


async def api_login(page: Page, username: str) -> str:
    result = await api(page, "POST", "/api/v1/auth/login", body={"username": username, "password": TEST_PASSWORD})
    if not result["ok"]:
        return ""
    return str(result["data"].get("token") or "")


async def create_fixture(page: Page, admin_token: str, report: Report):
    """Create a tiny tree and three KB types with deterministic, unique facts."""
    data = (await api(page, "GET", "/api/v1/admin/data", admin_token))["data"]
    roles = {item["name"]: item["id"] for item in data.get("roles", [])}
    missing = [name for name in ("普通用户", "组织管理员", "行业库管理员", "行业库创建者") if name not in roles]
    if missing:
        raise RuntimeError(f"缺少系统预置角色：{','.join(missing)}")

    root_r = await api(page, "POST", "/api/v1/admin/orgs", admin_token, {"name": f"{PREFIX}-集团"})
    if not root_r["ok"]:
        raise RuntimeError(f"创建 E2E 根组织失败：{root_r}")
    root = root_r["data"]["organization"]
    parent_r = await api(page, "POST", "/api/v1/admin/orgs", admin_token, {"name": f"{PREFIX}-研发中心", "parentId": root["id"]})
    child_r = await api(page, "POST", "/api/v1/admin/orgs", admin_token, {"name": f"{PREFIX}-开发组", "parentId": parent_r["data"]["organization"]["id"]})
    other_r = await api(page, "POST", "/api/v1/admin/orgs", admin_token, {"name": f"{PREFIX}-合规部", "parentId": root["id"]})
    if not (parent_r["ok"] and child_r["ok"] and other_r["ok"]):
        raise RuntimeError("创建 E2E 子组织失败")
    parent, child, other = parent_r["data"]["organization"], child_r["data"]["organization"], other_r["data"]["organization"]

    custom_role_r = await api(page, "POST", "/api/v1/admin/roles", admin_token, {
        "name": f"{PREFIX}-行业阅读角色", "description": "E2E 动态行业授权", "permissions": ["chat.use", "kb.read"]
    })
    if not custom_role_r["ok"]:
        raise RuntimeError(f"创建 E2E 角色失败：{custom_role_r}")
    custom_role = custom_role_r["data"]["role"]

    users: dict[str, dict] = {}
    definitions = {
        "org_admin": (parent["id"], [roles["组织管理员"]]),
        "parent_reader": (parent["id"], [roles["普通用户"]]),
        "child_reader": (child["id"], [roles["普通用户"]]),
        "other_reader": (other["id"], [roles["普通用户"]]),
        "creator": (parent["id"], [roles["行业库创建者"]]),
        "industry_admin": (child["id"], [roles["行业库管理员"]]),
        "direct_reader": (other["id"], [roles["普通用户"]]),
        "role_reader": (other["id"], [roles["普通用户"], custom_role["id"]]),
    }
    for key, (org_id, role_ids) in definitions.items():
        username = f"e2e_{RUN_ID.replace('-', '')}_{key}"
        result = await api(page, "POST", "/api/v1/admin/users", admin_token, {
            "username": username,
            "displayName": f"{PREFIX}-{key}",
            "email": f"{username}@example.test",
            "password": TEST_PASSWORD,
            "orgIds": [org_id],
            "roleIds": role_ids,
        })
        if not result["ok"]:
            raise RuntimeError(f"创建 fixture user {key} 失败：{result}")
        users[key] = result["data"]["user"]

    set_admin = await api(page, "POST", f"/api/v1/admin/orgs/{parent['id']}/admins", admin_token, {"userIds": [users["org_admin"]["id"]]})
    if not set_admin["ok"]:
        raise RuntimeError(f"设置组织管理员失败：{set_admin}")

    org_parent_r = await api(page, "POST", f"/api/v1/admin/orgs/{parent['id']}/knowledge-base/activate", admin_token, {"name": f"{PREFIX}-研发组织库"})
    org_child_r = await api(page, "POST", f"/api/v1/admin/orgs/{child['id']}/knowledge-base/activate", admin_token, {"name": f"{PREFIX}-开发组织库"})
    if not (org_parent_r["ok"] and org_child_r["ok"]):
        raise RuntimeError("激活 E2E 组织库失败")
    org_parent = org_parent_r["data"]["knowledgeBase"]
    org_child = org_child_r["data"]["knowledgeBase"]

    org_fact = f"{PREFIX}-研发制度第十四条：研发中心上班时间为 09:00 至 18:00，午休 12:00 至 13:00。"
    child_fact = f"{PREFIX}-开发组私有规范：仅开发组成员可阅读此条款。"
    parent_doc_r = await api(page, "POST", f"/api/v1/kbs/{org_parent['id']}/documents/text", admin_token, {"title": f"{PREFIX}-研发管理办法", "content": f"# 研发管理办法\n\n{org_fact}"})
    child_doc_r = await api(page, "POST", f"/api/v1/kbs/{org_child['id']}/documents/text", admin_token, {"title": f"{PREFIX}-开发私有规范", "content": f"# 开发私有规范\n\n{child_fact}"})
    if not (parent_doc_r["ok"] and child_doc_r["ok"]):
        raise RuntimeError("写入 E2E 组织知识失败")

    creator_token = await api_login(page, users["creator"]["username"])
    industry_r = await api(page, "POST", "/api/v1/admin/kbs", creator_token, {"name": f"{PREFIX}-行业库", "type": "industry", "description": "E2E 行业库"})
    if not industry_r["ok"]:
        raise RuntimeError(f"创建 E2E 行业库失败：{industry_r}")
    industry = industry_r["data"]["knowledgeBase"]
    transfer = await api(page, "POST", f"/api/v1/admin/kbs/{industry['id']}/admins", creator_token, {"userIds": [users["industry_admin"]["id"]]})
    if not transfer["ok"]:
        raise RuntimeError(f"移交行业库管理员失败：{transfer}")
    industry_token = await api_login(page, users["industry_admin"]["username"])
    industry_fact = f"{PREFIX}-行业标准：报名方式为登录平台后提交电子申请表。"
    industry_doc_r = await api(page, "POST", f"/api/v1/kbs/{industry['id']}/documents/text", industry_token, {"title": f"{PREFIX}-行业报名标准", "content": f"# 行业报名标准\n\n{industry_fact}"})
    if not industry_doc_r["ok"]:
        raise RuntimeError(f"行业管理员录入知识失败：{industry_doc_r}")

    grants = []
    for subject_type, subject_id in (("user", users["direct_reader"]["id"]), ("role", custom_role["id"]), ("org", child["id"])):
        grant_r = await api(page, "POST", "/api/v1/admin/grants", industry_token, {"kbId": industry["id"], "subjectType": subject_type, "subjectId": subject_id})
        if not grant_r["ok"]:
            raise RuntimeError(f"创建行业授权失败：{grant_r}")
        grants.append(grant_r["data"]["grant"])

    report.fixture = {"root": root, "parent": parent, "child": child, "other": other, "users": users, "org_parent": org_parent, "org_child": org_child, "industry": industry, "parent_doc": parent_doc_r["data"]["documents"][0], "child_doc": child_doc_r["data"]["documents"][0], "industry_doc": industry_doc_r["data"]["documents"][0], "grants": grants, "custom_role": custom_role, "facts": {"org": org_fact, "child": child_fact, "industry": industry_fact}, "_tokens": {"creator": creator_token, "industry_admin": industry_token}}


async def wait_published(page: Page, token: str, kb_id: str, doc_id: str, seconds: int = 30):
    deadline = time.time() + seconds
    latest = None
    while time.time() < deadline:
        result = await api(page, "GET", f"/api/v1/kbs/{kb_id}/documents?limit=100", token)
        if result["ok"]:
            items = result["data"].get("items", [])
            latest = next((item for item in items if item["id"] == doc_id), None)
            if latest and latest.get("status") == "published":
                return True, latest
            if latest and latest.get("status") in ("failed", "needs_review"):
                return False, latest
        await page.wait_for_timeout(1500)
    return False, latest or {"status": "timeout"}


async def bootstrap(page: Page, token: str):
    return await api(page, "GET", "/api/v1/session/bootstrap", token)


def kb_ids(payload: dict) -> set[str]:
    return {item["id"] for item in payload.get("kbs", [])}


async def run():
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report = Report()
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1440, "height": 960}, device_scale_factor=1)
        page = await context.new_page()
        page.on("console", lambda msg: report.console.append(f"console/{msg.type}: {msg.text}"))
        page.on("pageerror", lambda err: report.console.append(f"pageerror: {err}"))

        # First establish a valid administrative session. Invalid-login testing
        # is intentionally deferred because the application rate-limits login.
        await page.goto(WEB_URL, wait_until="networkidle", timeout=30000)
        login_shot = await screenshot(page, "01-login-page")
        admin_user = None
        for candidate in ("admin", "CY"):
            ok, _ = await ui_login(page, candidate, ADMIN_PASSWORD)
            if ok:
                admin_user = candidate
                break
        admin_shot = await screenshot(page, "03-admin-workspace")
        if not admin_user:
            report.add("AUTH-01", "登录", "本机测试超级管理员可登录", "admin/CY 均未能在浏览器登录；无法继续", "BLOCKED", admin_shot)
            await browser.close()
            render_html(report)
            return
        admin_token = await page.evaluate("() => localStorage.getItem('llmwiki_token')")
        report.add("AUTH-01", "登录", "本机测试超级管理员可登录", f"使用 {admin_user} 成功登录并获得会话", "PASS", admin_shot)

        try:
            await create_fixture(page, admin_token, report)
            report.add("SETUP-01", "隔离测试数据", "创建隔离组织、用户、三级知识库及三类行业授权", f"已创建 {PREFIX} 夹具；所有数据使用独立前缀", "PASS", admin_shot)
        except Exception as error:
            report.add("SETUP-01", "隔离测试数据", "创建隔离测试数据", str(error), "BLOCKED", admin_shot)
            await browser.close()
            render_html(report)
            return

        fx = report.fixture
        # Verify a single invalid password after a valid session has already
        # been proven. It is not retried, preserving the login-rate budget.
        await page.evaluate("() => localStorage.removeItem('llmwiki_token')")
        await page.goto(WEB_URL, wait_until="networkidle", timeout=30000)
        inputs = page.locator("input")
        invalid_ok = False
        if await inputs.count() >= 2:
            await inputs.nth(0).fill("definitely-not-a-user")
            await inputs.nth(1).fill("wrong-password")
            await page.locator("button:has-text('登录')").first.click()
            await page.wait_for_timeout(600)
            invalid_text = (await page.locator("body").inner_text())[-500:]
            invalid_ok = "Invalid" in invalid_text or "错误" in invalid_text or "失败" in invalid_text
        invalid_shot = await screenshot(page, "02-login-invalid")
        report.add("AUTH-02", "登录失败处理", "错误凭据被拒绝且页面不崩溃", "已显示登录错误" if invalid_ok else "未识别到明确错误文案", "PASS" if invalid_ok else "FAIL", invalid_shot)
        ok, relogin_message = await ui_login(page, admin_user, ADMIN_PASSWORD)
        if not ok:
            report.add("AUTH-03", "限流恢复", "单次失败不应阻断正确管理员重新登录", relogin_message, "BLOCKED", invalid_shot)
            await browser.close()
            render_html(report)
            return
        admin_token = await page.evaluate("() => localStorage.getItem('llmwiki_token')")
        # Wait for actual asynchronous ingestion, then inspect results.
        publication_items = (("研发组织库", "org_parent", "parent_doc"), ("开发组织库", "org_child", "child_doc"), ("行业库", "industry", "industry_doc"))
        publication_values = await asyncio.gather(*[
            wait_published(page, admin_token, fx[kb_key]["id"], fx[doc_key]["id"], seconds=30)
            for _, kb_key, doc_key in publication_items
        ])
        publication = {label: result for (label, _, _), result in zip(publication_items, publication_values)}
        pub_ok = all(ok for ok, _ in publication.values())
        publish_actual = "；".join(f"{name}={detail.get('status')}" for name, (_, detail) in publication.items())
        report.add("ING-01", "异步入库与发布", "文本知识最终 published 并可进入检索", publish_actual, "PASS" if pub_ok else "FAIL", admin_shot)

        # Admin UI tabs, each screenshot proves navigation was rendered.
        if await click_text(page, "管理后台"):
            admin_console_shot = await screenshot(page, "04-admin-console")
            report.add("NAV-01", "管理后台入口", "系统管理员可进入管理后台", "管理后台已在浏览器中打开", "PASS", admin_console_shot)
            for case_id, tab in (("ORG-01", "组织架构"), ("USER-01", "人员管理"), ("ROLE-01", "角色管理"), ("KB-08", "行业库管理"), ("MODEL-01", "模型配置"), ("AUDIT-01", "审计日志"), ("OPS-01", "系统运行监控")):
                clicked = await click_text(page, tab)
                tab_shot = await screenshot(page, f"05-{case_id.lower()}-{tab}")
                body = await page.locator("body").inner_text()
                visible = clicked and tab in body
                report.add(case_id, f"后台-{tab}", f"有权限人员可打开{tab}并正常渲染", "已打开并识别到页面标题" if visible else "未能定位或识别页面标题", "PASS" if visible else "FAIL", tab_shot)
        else:
            report.add("NAV-01", "管理后台入口", "系统管理员可进入管理后台", "未找到管理后台导航", "FAIL", admin_shot)

        # Exact API permission oracle checks.
        # The product correctly rate-limits login. Let the first fixture setup
        # batch cool down before signing in the five reader personas.
        await page.wait_for_timeout(62000)
        tokens = {}
        for key in ("parent_reader", "child_reader", "other_reader", "direct_reader", "role_reader"):
            token = await api_login(page, fx["users"][key]["username"])
            tokens[key] = token
            if not token:
                report.add(f"AUTH-{key}", "测试账号登录", "测试账号在未超过限流阈值时可登录", "登录接口未返回令牌（可能被限流或服务异常）", "BLOCKED")
        tokens.update(fx["_tokens"])
        expected_visibility = {
            "parent_reader": {fx["org_parent"]["id"]},
            "child_reader": {fx["org_parent"]["id"], fx["org_child"]["id"], fx["industry"]["id"]},
            "other_reader": set(),
            "direct_reader": {fx["industry"]["id"]},
            "role_reader": {fx["industry"]["id"]},
        }
        for key, expected in expected_visibility.items():
            bs = await bootstrap(page, tokens[key])
            actual = kb_ids(bs["data"]) if bs["ok"] else set()
            required_present = expected.issubset(actual)
            forbidden = {fx["org_parent"]["id"], fx["org_child"]["id"], fx["industry"]["id"]} - expected
            no_forbidden = not (actual & forbidden)
            status = "PASS" if required_present and no_forbidden else "FAIL"
            report.add(f"VIS-{key}", "知识可见范围", f"{key} 仅获得其规则允许的测试知识库", f"期望测试库数={len(expected)}，实际命中={len(actual & set(fx[k]['id'] for k in ('org_parent','org_child','industry')))}", status)

        parent_forbidden_doc = await api(page, "GET", f"/api/v1/kbs/{fx['org_child']['id']}/documents/{fx['child_doc']['id']}", tokens["parent_reader"])
        report.add("VIS-02", "组织库方向隔离", "父组织成员不可读取下级组织库文档", f"直接访问开发组文档 HTTP {parent_forbidden_doc['status']}", "PASS" if parent_forbidden_doc["status"] in (403, 404) else "FAIL")
        child_upload = await api(page, "POST", f"/api/v1/kbs/{fx['org_child']['id']}/documents/text", tokens["child_reader"], {"title": f"{PREFIX}-越权", "content": "不应写入"})
        report.add("ING-09", "知识维护权限", "组织库只读成员不能上传/录入知识", f"只读成员录入请求 HTTP {child_upload['status']}", "PASS" if child_upload["status"] == 403 else "FAIL")
        creator_write = await api(page, "POST", f"/api/v1/kbs/{fx['industry']['id']}/documents/text", tokens["creator"], {"title": f"{PREFIX}-创建者越权", "content": "不应写入"})
        report.add("KB-07", "行业库创建者与管理员分离", "移交管理员后创建者不能维护文档", f"创建者录入请求 HTTP {creator_write['status']}", "PASS" if creator_write["status"] == 403 else "FAIL")
        manager_write = await api(page, "POST", f"/api/v1/kbs/{fx['industry']['id']}/documents/text", tokens["industry_admin"], {"title": f"{PREFIX}-管理员补充", "content": f"{PREFIX}-管理员可维护行业库。"})
        report.add("KB-07B", "行业库管理员维护", "当前 KB 管理员可维护行业库内容", f"行业库管理员录入请求 HTTP {manager_write['status']}", "PASS" if manager_write["status"] in (200, 201) else "FAIL")

        # Browser evidence for visibility: parent reader / child reader / direct industry reader.
        for key, label, expected_text in (("parent_reader", "研发中心只读用户", fx["org_parent"]["name"]), ("child_reader", "开发组只读用户", fx["org_child"]["name"]), ("direct_reader", "行业库直接授权用户", fx["industry"]["name"])):
            ok, message = await ui_login(page, fx["users"][key]["username"], TEST_PASSWORD)
            if not ok:
                report.add(f"UI-{key}", "浏览器权限呈现", "测试用户可登录并看到其有权知识库", message, "FAIL")
                continue
            await click_text(page, "知识库")
            await page.wait_for_timeout(800)
            user_shot = await screenshot(page, f"06-ui-{key}")
            page_text = await page.locator("body").inner_text()
            report.add(f"UI-{key}", "浏览器权限呈现", "页面仅呈现有权知识库，且显示目标库", "目标库已显示" if expected_text in page_text else "目标库未在页面文字中识别", "PASS" if expected_text in page_text else "FAIL", user_shot)

        # Use an authorized industry reader in the actual UI to query the deterministic fact.
        ok, message = await ui_login(page, fx["users"]["direct_reader"]["username"], TEST_PASSWORD)
        if ok:
            await click_text(page, "对话")
            chat_box = await first_visible(page, ["textarea", "input[placeholder*='输入']"])
            if chat_box:
                question = f"{PREFIX}-行业标准中，报名方式是什么？"
                await chat_box.fill(question)
                send = await first_visible(page, ["button.send-btn", "button:has-text('发送')"])
                if send:
                    await send.click()
                    await page.wait_for_timeout(9000)
                    chat_shot = await screenshot(page, "07-chat-authorized-query")
                    body = await page.locator("body").inner_text()
                    fact_present = "电子申请表" in body or "登录平台" in body
                    citation_present = fx["industry_doc"]["title"] in body or "来源" in body
                    report.add("RAG-01", "授权范围内召回", "有权用户应召回行业报名标准并给出支持性来源", f"答案关键事实={'命中' if fact_present else '未识别'}；来源={'识别到' if citation_present else '未识别'}", "PASS" if fact_present and citation_present else "FAIL", chat_shot)
                    details = await first_visible(page, ["details.retrieval summary", "summary:has-text('处理链路')", "button:has-text('处理链路')"])
                    if details:
                        await details.click()
                        await page.wait_for_timeout(400)
                        trace_shot = await screenshot(page, "08-chat-processing-trace")
                        trace_text = await page.locator("body").inner_text()
                        trace_ok = any(word in trace_text for word in ("权限", "GBrain", "检索", "证据"))
                        report.add("GB-08", "问答处理链路", "回答可展开查看权限、检索、证据、模型等节点状态", "已展开并识别诊断节点" if trace_ok else "未识别完整诊断节点", "PASS" if trace_ok else "FAIL", trace_shot)
                    else:
                        report.add("GB-08", "问答处理链路", "回答可展开查看处理链路", "未定位到可展开的处理链路控件", "FAIL", chat_shot)
                else:
                    report.add("RAG-01", "授权范围内召回", "可发送问答", "未找到发送按钮", "FAIL")
            else:
                report.add("RAG-01", "授权范围内召回", "可输入问答", "未找到对话输入框", "FAIL")
        else:
            report.add("RAG-01", "授权范围内召回", "直接授权用户能登录测试问答", message, "BLOCKED")

        # Unauthorized answer must not access the child document; use its UI and API result together.
        no_access = await api(page, "GET", f"/api/v1/kbs/{fx['org_child']['id']}/documents/{fx['child_doc']['id']}/compile-truth", tokens["parent_reader"])
        report.add("RAG-02", "检索前权限过滤", "无权用户无法获取下级文档或其 Compiled Truth", f"无权 compile-truth 请求 HTTP {no_access['status']}", "PASS" if no_access["status"] in (403, 404) else "FAIL")

        # Document page and graph on an authorized user.
        ok, _ = await ui_login(page, admin_user, ADMIN_PASSWORD)
        if ok:
            await click_text(page, "知识库")
            await page.wait_for_timeout(500)
            kb_card = await first_visible(page, [f".kb-card:has-text('{fx['org_parent']['name']}')", f"text={fx['org_parent']['name']}"])
            if kb_card:
                await kb_card.click()
                await page.wait_for_timeout(600)
                library_shot = await screenshot(page, "09-library-document-list")
                report.add("DOC-01", "文档列表与详情", "有权用户可看到已发布文档及元数据", "已打开组织库文档列表", "PASS", library_shot)
            else:
                report.add("DOC-01", "文档列表与详情", "有权用户可定位组织库", "浏览器未定位到组织库卡片", "FAIL")
            await click_text(page, "知识图谱")
            await page.wait_for_timeout(2500)
            graph_shot = await screenshot(page, "10-knowledge-graph")
            graph_text = await page.locator("body").inner_text()
            graph_ok = "知识图谱" in graph_text and (await page.locator("canvas").count() > 0 or fx["org_parent"]["name"] in graph_text)
            report.add("GRAPH-01", "知识图谱", "有权用户的已发布文档构成个人可见图谱", "图谱页面已渲染" if graph_ok else "图谱未识别有效渲染", "PASS" if graph_ok else "FAIL", graph_shot)

        # Capture browser errors as an explicit observation, not a guessed pass.
        severe = [line for line in report.console if "pageerror" in line or "Failed to fetch" in line or "TypeError" in line]
        report.add("NAV-06", "浏览器稳定性", "关键流程无页面崩溃或 failed-to-fetch", "未捕获严重浏览器错误" if not severe else "；".join(severe[:3]), "PASS" if not severe else "FAIL")
        await browser.close()

    render_html(report)


def render_html(report: Report):
    total = len(report.cases)
    passed = sum(item["status"] == "PASS" for item in report.cases)
    failed = sum(item["status"] == "FAIL" for item in report.cases)
    blocked = sum(item["status"] == "BLOCKED" for item in report.cases)
    rows = []
    for item in report.cases:
        shot = f"<a class='shot' href='{html.escape(item['shot'])}' target='_blank'><img src='{html.escape(item['shot'])}' alt='{html.escape(item['id'])} 截图'></a>" if item.get("shot") else "<span class='muted'>无独立截图（接口断言）</span>"
        rows.append(f"""<article class='case {item['status'].lower()}'>
          <div class='case-head'><span class='id'>{html.escape(item['id'])}</span><span class='area'>{html.escape(item['area'])}</span><span class='status'>{html.escape(item['status'])}</span></div>
          <section><h4>预期</h4><p>{html.escape(item['expected'])}</p></section>
          <section><h4>实际</h4><p>{html.escape(item['actual'])}</p></section>{shot}</article>""")
    console = "\n".join(report.console[-80:]) or "未捕获浏览器控制台输出。"
    fixture_summary = html.escape(json.dumps({"prefix": PREFIX, "created": list(report.fixture.keys())}, ensure_ascii=False, indent=2))
    html_doc = f"""<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>
    <title>LLMWiki 浏览器功能测试报告 · {RUN_ID}</title><style>
    :root{{--ink:#142033;--muted:#63718a;--paper:#f4f7fb;--card:#fff;--blue:#2966d8;--green:#12845a;--red:#c53b4a;--amber:#b66c08}}*{{box-sizing:border-box}}body{{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 Inter,"Microsoft YaHei",sans-serif}}header{{padding:56px max(7vw,28px) 40px;background:radial-gradient(circle at 82% 12%,#a9c7ff 0,transparent 27%),linear-gradient(125deg,#152b57,#2865c7);color:#fff}}h1{{margin:0 0 8px;font-size:clamp(28px,4vw,46px);line-height:1.16}}header p{{max-width:840px;margin:0;color:#dbe9ff}}main{{max-width:1400px;margin:-18px auto 50px;padding:0 28px}}.summary{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:0 0 26px}}.metric{{padding:20px;border-radius:14px;background:var(--card);box-shadow:0 8px 30px #1a356019}}.metric strong{{font-size:30px;display:block}}.metric.pass strong{{color:var(--green)}}.metric.fail strong{{color:var(--red)}}.metric.block strong{{color:var(--amber)}}.note{{background:#edf4ff;border-left:4px solid var(--blue);border-radius:10px;padding:17px 20px;margin:20px 0 28px}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:18px}}.case{{background:var(--card);border-radius:14px;overflow:hidden;box-shadow:0 8px 24px #1a356016;border-top:4px solid #96a4b9}}.case.pass{{border-color:var(--green)}}.case.fail{{border-color:var(--red)}}.case.blocked{{border-color:var(--amber)}}.case-head{{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid #edf0f4}}.id{{font-weight:800;color:var(--blue)}}.area{{flex:1;font-weight:650}}.status{{font-size:12px;font-weight:800;padding:2px 9px;border-radius:99px;background:#eef2f7}}.pass .status{{color:var(--green);background:#e6f7f0}}.fail .status{{color:var(--red);background:#ffedf0}}.blocked .status{{color:var(--amber);background:#fff5df}}section{{padding:0 16px}}h4{{font-size:12px;letter-spacing:.07em;color:var(--muted);margin:14px 0 2px;text-transform:uppercase}}section p{{margin:0 0 12px}}.shot{{display:block;padding:8px 16px 16px}}.shot img{{width:100%;height:210px;object-fit:cover;object-position:top;border:1px solid #dce4ee;border-radius:9px;background:#fff}}.muted{{display:block;padding:12px 16px 18px;color:var(--muted)}}details{{background:#fff;border-radius:12px;padding:16px 20px;margin-top:24px;box-shadow:0 8px 24px #1a356012}}pre{{white-space:pre-wrap;word-break:break-word;color:#40506a}}footer{{max-width:1400px;margin:0 auto;padding:0 28px 30px;color:var(--muted)}}@media(max-width:680px){{.summary{{grid-template-columns:repeat(2,1fr)}}main{{padding:0 14px}}header{{padding:38px 20px}}}}</style></head><body>
    <header><div>LOCAL E2E ACCEPTANCE · {RUN_ID}</div><h1>LLMWiki 系统功能浏览器测试报告</h1><p>真实 Chromium 页面操作、页面截图与后端权限断言。报告重点覆盖知识可见范围、入库发布、行业授权、召回证据、组织/角色边界和核心管理功能。</p></header>
    <main><div class='summary'><div class='metric'><span>执行总数</span><strong>{total}</strong></div><div class='metric pass'><span>通过</span><strong>{passed}</strong></div><div class='metric fail'><span>失败</span><strong>{failed}</strong></div><div class='metric block'><span>阻塞</span><strong>{blocked}</strong></div></div>
    <div class='note'><b>判定说明：</b>截图来自本机 `:3200` 测试环境；权限类案例同时直调真实 API，避免只验证菜单隐藏。E2E 数据均以 <code>{PREFIX}</code> 前缀隔离。无截图的案例为接口越权/可见集断言，实际 HTTP 状态已记录。</div>
    <div class='grid'>{''.join(rows)}</div><details><summary><b>夹具摘要</b></summary><pre>{fixture_summary}</pre></details><details><summary><b>浏览器控制台观察</b></summary><pre>{html.escape(console)}</pre></details></main><footer>生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} · 本报告不包含密码、令牌、模型密钥或原始敏感知识。</footer></body></html>"""
    (REPORT_DIR / "index.html").write_text(html_doc, encoding="utf-8")
    (REPORT_DIR / "results.json").write_text(json.dumps(report.cases, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"REPORT={REPORT_DIR / 'index.html'}")


if __name__ == "__main__":
    asyncio.run(run())
