"""Deterministic browser regression against a local production web build.
All API calls use an in-memory HTTP fixture; no credentials or business DB.
Run: python3 tests/e2e/audit_chat_experience.py --url http://127.0.0.1:3210
"""
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--output', default='/tmp/gbrain-audit-browser')
args = parser.parse_args()
assert args.url.startswith(('http://127.0.0.1:', 'http://localhost:'))
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
state = {'feedback': [], 'count': 0, 'admin_finished': False, 'history_finished': False, 'requests': []}
bootstrap = {'user': {'id': 'fixture-user', 'displayName': '审查用户'}, 'capabilities': ['*'],
             'kbs': [{'id': 'fixture-kb', 'name': '验收知识库', 'type': 'personal'}]}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def headers_for(self, kind='application/json'):
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Methods', '*')
        self.end_headers()

    def do_OPTIONS(self):
        self.headers_for()

    def do_GET(self):
        if self.path.endswith('/admin/data'):
            time.sleep(3)
            state['admin_finished'] = True
            data = {**bootstrap, 'kbs': [{'id': 'replacement-kb', 'name': '新授权知识库', 'type': 'personal'}]}
        elif self.path.endswith('/session/bootstrap'):
            data = bootstrap
        elif self.path.endswith('/conversations'):
            time.sleep(3)
            state['history_finished'] = True
            data = []
        elif '/conversations/slow' in self.path:
            time.sleep(1)
            data = {'messages': [{'id': 'old-answer', 'role': 'assistant', 'content': '迟到历史回答'}]}
        else:
            data = {}
        self.headers_for()
        try:
            self.wfile.write(json.dumps(data).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path.endswith('/feedback'):
            state['feedback'].append(self.path)
            self.send_response(500)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            return
        payload = json.loads(raw or b'{}')
        state['requests'].append(payload)
        state['count'] += 1
        count = state['count']
        self.headers_for('text/event-stream')
        def event(data):
            self.wfile.write(('data: ' + json.dumps(data) + '\n\n').encode())
            self.wfile.flush()
        try:
            event({'type': 'conversation', 'conversation_id': 'fixture-conv'})
            if payload.get('message') == '停止测试':
                for i in range(50):
                    event({'type': 'delta', 'content': f'段落{i}。'})
                    time.sleep(.1)
            else:
                event({'type': 'delta', 'content': f'## 回答{count}\n\n已核对事实。'})
            event({'type': 'done', 'message_id': f'answer-{count}'})
        except (BrokenPipeError, ConnectionResetError):
            pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
fixture_url = f'http://127.0.0.1:{server.server_port}'
results = {}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('**/api/**', lambda route: route.continue_(url=fixture_url + '/api/' + route.request.url.split('/api/', 1)[1]))
        page.route('https://fonts.googleapis.com/**', lambda route: route.abort())
        page.route('https://fonts.gstatic.com/**', lambda route: route.abort())
        page.add_init_script("localStorage.setItem('llmwiki_token','fixture-token')")
        started = time.perf_counter()
        page.goto(args.url, wait_until='domcontentloaded')
        composer = page.locator('textarea').first
        composer.wait_for(state='visible')
        results['shell_ready_ms_with_3000ms_admin_delay'] = round((time.perf_counter() - started) * 1000)
        assert not state['admin_finished'], 'Shell waited for admin data'
        assert not state['history_finished'], 'Shell waited for conversation history'
        results['slow_history_does_not_block_composer'] = 'passed'
        page.wait_for_timeout(3200)
        composer.wait_for(state='visible')
        for index, question in enumerate(['第一问', '第二问']):
            composer.fill(question)
            composer.press('Enter')
            page.locator('.msg-ai .actions').nth(index).wait_for()
        page.get_by_role('button', name='有用', exact=True).first.click()
        page.wait_for_function("() => document.querySelector('.toast')?.textContent.includes('反馈提交失败')")
        assert state['feedback'][0].endswith('/messages/answer-1/feedback'), state['feedback']
        assert state['requests'][0]['kb_scope'] == ['replacement-kb'], state['requests']
        results['scope_refresh_with_same_library_count'] = 'passed'
        results['feedback_original_message_and_http_error'] = 'passed'
        composer.fill('停止测试')
        composer.press('Enter')
        page.wait_for_function("() => document.querySelectorAll('.answer-markdown')[2]?.textContent.includes('段落1')")
        page.get_by_role('button', name='停止生成', exact=True).click()
        page.locator('.msg-ai .actions').nth(2).wait_for()
        assert page.locator('.answer-markdown .cursor').count() == 0
        assert '段落' in page.locator('.answer-markdown').nth(2).inner_text()
        results['stop_keeps_partial_answer_and_completes_ui'] = 'passed'
        page.evaluate("window.dispatchEvent(new CustomEvent('app-new-chat'))")
        page.evaluate("window.dispatchEvent(new CustomEvent('app-open-conversation',{detail:'slow'}))")
        page.wait_for_timeout(100)
        page.evaluate("window.dispatchEvent(new CustomEvent('app-new-chat'))")
        page.wait_for_timeout(1200)
        assert page.locator('.msg-ai').count() == 0
        results['new_chat_fences_late_history_response'] = 'passed'
        page.screenshot(path=str(output / 'desktop.png'), full_page=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(output / 'mobile.png'), full_page=True)
        assert not errors, errors
        results['runtime_errors'] = errors
        results['mobile_overflow'] = 'passed'
        print(json.dumps(results, ensure_ascii=False, indent=2))
        (output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    finally:
        browser.close()
        server.shutdown()
