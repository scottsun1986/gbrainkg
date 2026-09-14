import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

os.environ["http_proxy"] = ""
os.environ["https_proxy"] = ""
os.environ["all_proxy"] = ""

BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:3200")
SCREENSHOT_DIR = Path("/home/scottsun/gbrainkg/docs/test-reports/interaction")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

async def run_layout_and_interaction_tests():
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-proxy-server", "--disable-gpu", "--no-sandbox"],
        )
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            device_scale_factor=1.5,
        )
        page = await context.new_page()

        # 拦截外网 Google 字体请求，防止内网环境 page.screenshot 等待字体超时
        await page.route("**/fonts.googleapis.com/**", lambda route: route.abort())
        await page.route("**/fonts.gstatic.com/**", lambda route: route.abort())

        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        print("1. 访问系统首页...")
        await page.goto(BASE_URL, wait_until="domcontentloaded")
        await page.wait_for_selector("#root", timeout=10000)
        await page.wait_for_timeout(1000)

        # 检查是否需要登录
        inputs = page.locator("input")
        if await inputs.count() >= 2:
            print("2. 执行管理员登录...")
            await inputs.nth(0).fill("admin")
            await inputs.nth(1).fill("123456")
            await page.locator("button:has-text('登录')").first.click()
            await page.wait_for_timeout(2000)

        print("✓ 登录成功，当前处于主工作区")
        await page.screenshot(path=str(SCREENSHOT_DIR / "01_chat_full_layout.png"))

        # ==========================================
        # 测试 1: 侧边栏折叠/展开与快捷键联动
        # ==========================================
        print("\n--- [测试 1] 验证可折叠侧边栏 (Collapsible Rail) ---")
        side_el = page.locator("aside.side")
        box_before = await side_el.bounding_box()
        print(f"展开状态侧边栏宽度: {box_before['width']}px (预期 ~248px)")
        assert 240 <= box_before["width"] <= 260, f"展开宽度异常: {box_before['width']}"

        print("点击侧边栏底部折叠切换按钮...")
        toggle_btn = page.locator(".collapse-toggle-btn").first
        await toggle_btn.click()
        await page.wait_for_timeout(500)

        box_collapsed = await side_el.bounding_box()
        print(f"收起状态侧边栏宽度: {box_collapsed['width']}px (预期 ~64px)")
        assert 60 <= box_collapsed["width"] <= 70, f"收起宽度异常: {box_collapsed['width']}"

        await page.screenshot(path=str(SCREENSHOT_DIR / "02_side_collapsed_mode.png"))
        print("✓ 侧边栏成功平滑收缩至 64px 极简图标 Rail 模式")

        print("使用 TopBar 左侧的展开按钮还原侧边栏...")
        desktop_toggle = page.locator(".desktop-collapse-btn").first
        await desktop_toggle.click()
        await page.wait_for_timeout(500)

        box_restored = await side_el.bounding_box()
        print(f"还原后侧边栏宽度: {box_restored['width']}px")
        assert 240 <= box_restored["width"] <= 260, f"还原宽度异常: {box_restored['width']}"
        print("✓ 侧边栏成功还原为 248px 完整导航")

        # ==========================================
        # 测试 2: 知识库详情页紧凑型上传条与 KPI 点击过滤
        # ==========================================
        print("\n--- [测试 2] 知识库紧凑型上传条与 KPI 穿透过滤 ---")
        kb_nav = page.locator(".nav-item:has-text('知识库')").first
        await kb_nav.click()
        await page.wait_for_timeout(1500)

        target_kb = page.locator(".kb-card:has-text('系统测试-解析矩阵库')").first
        await target_kb.scroll_into_view_if_needed()
        await target_kb.click()
        await page.wait_for_timeout(2000)

        # 检查紧凑型上传条
        compact_dropzone = page.locator(".compact-dropzone").first
        assert await compact_dropzone.is_visible(), "未找到紧凑型上传行动条"
        dropzone_box = await compact_dropzone.bounding_box()
        print(f"紧凑型上传条高度: {dropzone_box['height']}px (远低于原先 160px+ 的笨重虚线框)")
        assert dropzone_box["height"] <= 90, f"上传条高度过大: {dropzone_box['height']}"

        # 检查可交互 KPI 卡片
        kpi_published = page.locator(".kpi.interactive:has-text('已发布')").first
        kpi_needs_review = page.locator(".kpi.interactive:has-text('待复核')").first
        kpi_total = page.locator(".kpi.interactive:has-text('总文档')").first

        print("点击『待复核』KPI 卡片进行状态一键过滤...")
        await kpi_needs_review.click()
        await page.wait_for_timeout(600)

        # 验证下拉选择框也自动联动为 needs_review，且卡片处于 active
        select_filter = page.locator("select.filter-select").first
        selected_val = await select_filter.input_value()
        print(f"下拉筛选器当前值: {selected_val} (预期 'needs_review')")
        assert selected_val == "needs_review", f"筛选器联动异常: {selected_val}"
        kpi_active_class = await kpi_needs_review.get_attribute("class")
        assert "active" in kpi_active_class, "KPI 卡片未显示 active 激活高亮态"
        print("✓ 点击『待复核』KPI 成功触发状态过滤与高亮激活态")

        await page.screenshot(path=str(SCREENSHOT_DIR / "03_kpi_filter_needs_review.png"))

        print("再次点击『待复核』KPI，取消过滤...")
        await kpi_needs_review.click()
        await page.wait_for_timeout(600)
        selected_val_reset = await select_filter.input_value()
        print(f"取消后下拉筛选器值: {selected_val_reset} (预期 'all')")
        assert selected_val_reset == "all", f"重置异常: {selected_val_reset}"

        # ==========================================
        # 测试 3: 靠右分屏双生画布模式 (Dual Canvas)
        # ==========================================
        print("\n--- [测试 3] 验证靠右分屏对比模式 (Dual Canvas) ---")
        search_input = page.locator("input[placeholder*='搜索文档名称']").first
        await search_input.fill("training")
        await page.wait_for_timeout(1000)

        doc_item = page.locator(".doc-row .ttl:has-text('24_training_60slides.pptx')").first
        await doc_item.click()
        await page.wait_for_timeout(3000)

        # 检查模态框默认已打开
        preview_modal = page.locator(".preview-modal").first
        assert await preview_modal.is_visible(), "预览窗口未正常弹出"
        default_box = await preview_modal.bounding_box()
        print(f"默认居中模态框宽度: {default_box['width']}px, 靠左位置: {default_box['x']}px")

        # 点击靠右分屏按钮
        print("点击顶部工具栏『◫ 靠右分屏对照』按钮...")
        dock_btn = page.locator("button[title*='靠右分屏对照']").first
        await dock_btn.click()
        await page.wait_for_timeout(1000)

        docked_class = await preview_modal.get_attribute("class")
        assert "docked" in docked_class, "预览窗口未进入 docked 模式"
        docked_box = await preview_modal.bounding_box()
        print(f"分屏模式模态框靠右贴边: x={docked_box['x']}px, 宽度={docked_box['width']}px (占据约全屏 52%)")
        assert docked_box["x"] > 500, f"分屏靠右位置异常: x={docked_box['x']}"

        # 检查分屏徽标
        dock_badge = page.locator(".dock-hint-badge").first
        assert await dock_badge.is_visible(), "未见分屏对照模式提示徽标"
        print("✓ 分屏对照模式已生效，提示徽标显示正常")

        await page.screenshot(path=str(SCREENSHOT_DIR / "04_dual_canvas_docked_split_view.png"))

        print("\n==============================================")
        print("🎉 全部布局与交互体验验收 100% 成功！")
        print("==============================================")

        await browser.close()

if __name__ == "__main__":
    asyncio.run(run_layout_and_interaction_tests())
