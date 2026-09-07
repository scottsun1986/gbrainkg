"""Exercise the production Markdown renderer with its real libraries in Chrome.

No application data or authentication is needed: the renderer is stateless.
"""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "apps/web"


def main():
    compiled = subprocess.check_output([
        "node", "-e",
        "const fs=require('fs'),ts=require('typescript');"
        "process.stdout.write(ts.transpileModule(fs.readFileSync('src/lib/markdown.ts','utf8'),"
        "{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText)",
    ], cwd=WEB, text=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/opt/google/chrome/chrome", headless=True, args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content('<main id="preview"></main>')
        page.add_script_tag(path=str(WEB / "node_modules/dompurify/dist/purify.js"))
        page.add_script_tag(path=str(WEB / "node_modules/marked/lib/marked.umd.js"))
        page.evaluate("""() => {
            window.exports = {};
            window.require = name => name === 'dompurify' ? window.DOMPurify : window.marked;
        }""")
        page.add_script_tag(content=compiled)
        result = page.evaluate("""() => {
            const render = window.exports.renderMarkdown;
            const payload = '# 安全预览\\n\\n'
              + '<img src="invalid" onerror="window.__executed=true">'
              + '<svg onload="window.__executed=true"></svg>'
              + '<iframe srcdoc="<script>window.__executed=true</script>"></iframe>'
              + '[危险](javascript:alert(1))\\n\\n'
              + '| 条款 | 说明 |\\n| --- | --- |\\n| 第十条 | 考勤规则 |\\n\\n'
              + '[正常链接](https://example.com/rules)\\n\\n`<img onerror=bad>`';
            const html = render(payload, ['第十条', '安全', '<img']);
            const root = document.querySelector('#preview');
            root.innerHTML = html;
            const bad = [...root.querySelectorAll('*')].some(el => [...el.attributes].some(a => /^on/i.test(a.name)));
            const plain = document.createElement('div');
            const literal = '<img onerror=bad> &lt;script&gt; literal';
            plain.innerHTML = window.exports.renderPlainText(literal, ['img', 'literal']);
            return {
              plaintextPreserved: plain.textContent === literal,
              plaintextNotHtml: !plain.querySelector('img,script'),
              plaintextHighlighted: plain.querySelector('mark')?.textContent === 'img',
              noHandlers: !bad,
              noExecutableTags: !root.querySelector('script,svg,iframe,object,form'),
              noScriptUrls: ![...root.querySelectorAll('a')].some(a => a.getAttribute('href')?.startsWith('javascript:')),
              tablePreserved: !!root.querySelector('table tbody td'),
              linkPreserved: !!root.querySelector('a[href="https://example.com/rules"]'),
              highlightPreserved: root.querySelector('td mark')?.textContent === '第十条',
              codePreserved: root.querySelector('code')?.textContent === '<img onerror=bad>',
              noNestedHighlights: !root.querySelector('mark mark'),
            };
        }""")
        page.wait_for_load_state("networkidle")
        result["noScriptExecution"] = page.evaluate("window.__executed !== true")
        browser.close()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    assert all(result.values()), result


if __name__ == "__main__":
    main()
