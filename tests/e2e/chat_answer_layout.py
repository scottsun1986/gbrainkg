"""Visual regression against actual React-rendered answers; no API/model calls.

First generate the fixture from apps/web:
  npx tsx __tests__/answer-layout.fixture.tsx /tmp/gbrain-answer-layout.html
Then: python3 tests/e2e/chat_answer_layout.py
"""
import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--html', default='/tmp/gbrain-answer-layout.html')
parser.add_argument('--output', default='/tmp/gbrain-answer-layout-screenshots')
args = parser.parse_args()
source = Path(args.html).resolve()
if not source.is_file():
    parser.error('Generate the React answer fixture first')
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        for name, width, height, theme in [
            ('desktop', 1440, 1000, 'light'),
            ('mobile', 390, 844, 'light'),
            ('mobile-dark', 390, 844, 'dark'),
            ('small-mobile', 320, 740, 'light'),
        ]:
            page = browser.new_page(viewport={'width': width, 'height': height})
            page.goto(source.as_uri())
            page.wait_for_load_state('networkidle')
            page.evaluate('(theme) => document.documentElement.dataset.theme = theme', theme)
            answer = page.locator('.answer-markdown')
            assert answer.locator('h2').count() == 3
            assert answer.locator('ol > li').count() == 2
            assert answer.locator('blockquote').count() == 1
            assert answer.locator('.cite-chip').count() >= 6
            assert answer.locator('pre .cite-chip').count() == 0
            assert answer.locator('input[type=checkbox]').count() == 2
            assert '[x]' not in answer.inner_text() and '[ ]' not in answer.inner_text()
            assert answer.locator('script, img').count() == 0
            assert page.evaluate('window.answerXss === undefined')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), name
            assert answer.locator('p').first.evaluate('(p) => parseFloat(getComputedStyle(p).marginBottom) >= 12')
            assert answer.evaluate('(el) => parseFloat(getComputedStyle(el).lineHeight) / parseFloat(getComputedStyle(el).fontSize) >= 1.7')
            assert answer.locator('ol').evaluate('(el) => getComputedStyle(el).listStyleType === "decimal"')
            assert answer.locator('pre').evaluate('(el) => getComputedStyle(el).whiteSpace === "pre"')
            tables = answer.locator('.answer-table-scroll')
            assert tables.count() == 3
            for table in tables.all():
                assert table.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1'), name
                assert table.locator('td').evaluate_all('(cells) => cells.every(el => el.scrollWidth <= el.clientWidth + 1)'), name
            assert tables.nth(0).locator('tbody tr').first.evaluate('(el) => getComputedStyle(el).display === "block"')
            compact = tables.nth(1)
            expected = 'block' if width <= 390 else 'table-row'
            assert compact.locator('tbody tr').first.evaluate('(el) => getComputedStyle(el).display') == expected
            assert compact.locator('.answer-cell-value').all_text_contents() == [
                '第一项', '10 分钟', '简短比较，桌面保留表格，手机逐项呈现。1',
                '第二项', '20 分钟', '仍按原文顺序展示。2']
            # The visual labels are not repeated focusable source buttons.
            assert answer.locator('.answer-cell-label button').count() == 0
            page.screenshot(path=str(output / f'{name}.png'), full_page=True)
            page.close()
            print(f'{name}: semantic blocks, spacing, safe citations and bounded overflow passed')
    finally:
        browser.close()
