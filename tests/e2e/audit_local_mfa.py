"""Validate local TOTP rendering and lazy chat loading without a real account."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
import cv2
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--output', default='/tmp/gbrain-local-mfa')
args = parser.parse_args()
assert urlsplit(args.url).hostname in ('localhost', '127.0.0.1')
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
secret = 'JBSWY3DPEHPK3PXP'
uri = f'otpauth://totp/GBrain:fixture?secret={secret}&issuer=GBrain'

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        requests, errors, scripts = [], [], []
        page.on('request', lambda request: requests.append(request.url))
        page.on('pageerror', lambda error: errors.append(str(error)))
        def capture(response):
            if '/_next/' in response.url and response.url.split('?')[0].endswith('.js'):
                scripts.append(response.body().decode('utf8'))
        page.on('response', capture)
        def api(route):
            path = urlsplit(route.request.url).path
            payload = {'oidcEnabled': False}
            if path.endswith('/auth/login'):
                payload = {'mfaSetupRequired': True, 'mfaToken': 'fixture-mfa-token'}
            elif path.endswith('/mfa/setup'):
                payload = {'secret': secret, 'otpauthUri': uri}
            route.fulfill(json=payload)
        page.route('**/api/**', api)
        page.route('https://**', lambda route: route.abort())
        page.goto(args.url, wait_until='networkidle')
        page.locator('#login-username').wait_for()
        assert not any('answer-markdown' in script for script in scripts), 'Login downloaded chat renderer'
        login_bytes = sum(len(script.encode()) for script in scripts)
        page.locator('#login-username').fill('fixture')
        page.locator('#login-password').fill('fixture-password')
        page.get_by_role('button', name='登录', exact=True).click()
        canvas = page.get_by_role('img', name='身份验证器绑定二维码')
        canvas.wait_for()
        page.wait_for_function("() => { const c=document.querySelector('canvas'); return c?.width===168 && c?.getContext('2d').getImageData(0,0,168,168).data.some((v,i)=>i%4===3 && v===255); }")
        canvas.screenshot(path=str(output / 'totp-qr.png'))
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(str(output / 'totp-qr.png')))
        assert decoded == uri, 'Rendered QR did not preserve the provisioning URI'
        assert not any('qrserver.com' in url or secret in url or 'otpauth' in url for url in requests)
        assert not errors, errors
        result = {'local_qr_decodes_to_exact_provisioning_uri': 'passed', 'no_external_provisioning_request': 'passed', 'logged_out_does_not_download_chat_renderer': 'passed', 'login_javascript_uncompressed_bytes': login_bytes, 'runtime_errors': errors}
        for status in (503, 401):
            check = browser.new_page()
            observed = []
            check.add_init_script("localStorage.setItem('llmwiki_token','fixture-session')")
            def failing_api(route):
                path = urlsplit(route.request.url).path
                observed.append(path)
                if path.endswith('/session/bootstrap'):
                    route.fulfill(status=status, json={'message': 'Fixture failure'})
                else:
                    route.fulfill(json=[] if path.endswith('/conversations') else {})
            check.route('**/api/**', failing_api)
            check.route('https://**', lambda route: route.abort())
            check.goto(args.url, wait_until='networkidle')
            check.locator('#login-username').wait_for()
            if status == 503:
                check.get_by_text('服务器暂未响应，已保留你的登录凭证。').wait_for()
                assert check.evaluate("localStorage.getItem('llmwiki_token')") == 'fixture-session'
            else:
                assert check.evaluate("localStorage.getItem('llmwiki_token')") is None
            assert not any(path.endswith('/admin/data') for path in observed)
            check.close()
        result['temporary_session_failure_preserves_token_and_does_not_fetch_admin'] = 'passed'
        result['invalid_session_clears_token_and_does_not_fetch_admin'] = 'passed'
        (output / 'results.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
    finally:
        browser.close()
