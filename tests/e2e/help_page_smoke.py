from playwright.sync_api import sync_playwright


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.goto("http://127.0.0.1:3000/help")
    page.wait_for_load_state("networkidle")
    assert page.get_by_role("heading", name="把知识变成").is_visible()
    assert page.get_by_text("从上传一份制度文件，到带着原文依据得到答案").is_visible()
    page.get_by_role("link", name="智能问答").first.click()
    assert page.url.endswith("/help#ask")
    assert page.locator("#ask").is_visible()
    page.screenshot(path="/tmp/gbrain-help.png", full_page=True)
    page.get_by_role("link", name="返回系统").first.click()
    page.wait_for_url("**/")
    assert page.url.endswith("/")
    browser.close()
