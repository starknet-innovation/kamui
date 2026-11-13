#!/usr/bin/env python3
"""Read-only, fixed-origin HTTPS acceptance. No auth, POST, raw bodies or redirects."""
import argparse
import hashlib
from html.parser import HTMLParser
import json
import os
import re
from pathlib import Path
import ssl
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[4]
KEYCHAIN = 'https://sepolia.kamui.page'
PEPPER = 'https://pepper-sepolia.kamui.page'
RPC = 'https://sepolia.nodes.starknet.org/rpc/v0_10'
RPC_FALLBACK = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10'
# The pinned browser prover v1.0.1 accepts only ZAN; move to RPC with prover v1.0.2.
PROVER_RPC = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10'
CLASS = '0x1e128dae2cb709cac9263afa1c6fdb33f7f1f5c2d969547d9739326d08399f6'
REGISTRY = '0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808'
EXECUTOR = '0x44c921502db6c924a29f78256d72926060efa599cd13d97142efa192eaebd4c'

class Failure(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

OPENER = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

def fetch(url, limit=262144, digest_only=False):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc not in ('sepolia.kamui.page', 'pepper-sepolia.kamui.page') or parsed.query or parsed.fragment:
        raise Failure('URL_REFUSED')
    request = urllib.request.Request(url, headers={'Accept-Encoding': 'identity', 'User-Agent': 'Kamui-Hosted-Acceptance/1'}, method='GET')
    try:
        response = OPENER.open(request, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    except Exception:
        raise Failure('HTTPS_UNAVAILABLE') from None
    with response:
        status = response.status
        headers = {k.lower(): v for k, v in response.headers.items()}
        if int(headers.get('content-length', '0')) > limit:
            raise Failure('RESPONSE_TOO_LARGE')
        if headers.get('content-encoding', 'identity') != 'identity':
            raise Failure('ENCODING_REFUSED')
        size = 0
        digest = hashlib.sha256()
        chunks = []
        while True:
            part = response.read(min(65536, limit + 1 - size))
            if not part:
                break
            size += len(part)
            if size > limit:
                raise Failure('RESPONSE_TOO_LARGE')
            digest.update(part)
            if not digest_only:
                chunks.append(part)
        return status, headers, b''.join(chunks), size, digest.hexdigest()

def require(condition, code):
    if not condition:
        raise Failure(code)

def headers_ok(headers, asset=False):
    require(headers.get('x-content-type-options') == 'nosniff', 'NOSNIFF_MISSING')
    require(headers.get('referrer-policy') == 'no-referrer', 'REFERRER_POLICY_MISSING')
    require('max-age=31536000' in headers.get('strict-transport-security', ''), 'HSTS_MISSING')
    csp = headers.get('content-security-policy', '')
    directives = dict((v.split(None, 1) + [''])[:2] for v in csp.split(';') if v.strip())
    for name, expected in {'default-src': "'none'", 'script-src': "'self' 'wasm-unsafe-eval'", 'worker-src': "'self'", 'style-src': "'self'", 'base-uri': "'none'", 'form-action': "'none'", 'frame-ancestors': "'none'"}.items():
        require(directives.get(name) == expected, 'CSP_MISMATCH')
    require(set(directives.get('connect-src', '').split()) == {"'self'", "data:", "https://sepolia.nodes.starknet.org", "https://api.zan.top", "https://pepper-sepolia.kamui.page"}, 'CSP_CONNECT_MISMATCH')
    cache = headers.get('cache-control', '')
    require(('immutable' in cache and 'max-age=31536000' in cache) if asset else cache == 'no-store', 'CACHE_POLICY_MISMATCH')

def config_ok(config, client_id):
    expected = {'proverReady': True, 'proverExecutor': EXECUTOR, 'jwkRegistry': REGISTRY, 'googleClientId': client_id,
                'appleClientId': '', 'rpcUrl': RPC, 'rpcFallbackUrl': RPC_FALLBACK, 'proverRpcUrl': PROVER_RPC, 'classHash': CLASS,
                'pepperUrl': PEPPER, 'apiUrl': '/api', 'redirectUri': KEYCHAIN + '/callback'}
    require(set(config) == set(expected) | {'pollMs'}, 'CONFIG_FIELDS_MISMATCH')
    require(all(config.get(k) == v for k, v in expected.items()), 'PUBLIC_CONFIG_MISMATCH')
    require(type(config['pollMs']) is int and 0 < config['pollMs'] <= 10000, 'POLL_INTERVAL_INVALID')

class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.scripts.append(dict(attrs).get('src'))

def run(client_id=None, probe_only=False, fetcher=fetch, main_sha256=None):
    checks = []
    def check(label, operation):
        try:
            operation()
            checks.append({'check': label, 'status': 'passed'})
        except Exception as error:
            code = str(error) if isinstance(error, Failure) else 'CHECK_FAILED'
            checks.append({'check': label, 'status': 'failed', 'code': code})
    def status(origin, path, expected):
        result = fetcher(origin + path)
        require(result[0] == expected, 'HTTP_STATUS_MISMATCH')
        return result
    check('keychain_https_live', lambda: status(KEYCHAIN, '/live', 200))
    check('pepper_https_health', lambda: status(PEPPER, '/health', 200))
    if not probe_only:
        def page():
            _, h, body, _, _ = status(KEYCHAIN, '/', 200)
            headers_ok(h)
            scripts = Scripts(); scripts.feed(body.decode('utf8'))
            require(scripts.scripts == ['/main.js'], 'PAGE_SCRIPT_MISMATCH')
        check('page_headers_and_script_origins', page)
        def config():
            _, h, body, _, _ = status(KEYCHAIN, '/config.json', 200)
            headers_ok(h)
            config_ok(json.loads(body), client_id)
        check('google_only_public_config', config)
        def main_bundle():
            code, h, _, _, digest = fetcher(KEYCHAIN + '/main.js', limit=16 * 1024 * 1024, digest_only=True)
            require(code == 200, 'MAIN_BUNDLE_UNAVAILABLE')
            headers_ok(h)
            require(h.get('content-type', '').split(';')[0] == 'text/javascript', 'MAIN_BUNDLE_MIME_MISMATCH')
            require(main_sha256 is not None and digest == main_sha256, 'MAIN_BUNDLE_PIN_MISMATCH')
        check('reviewed_main_bundle', main_bundle)
        for path in ['/metrics', '/metrics/private', '/api/metrics', '/api/metrics/private', '/api/recover', '/api/deploy', '/api/health/rotator', '/api/health/prover', '/api/sponsor', '/api/wallet/sponsor']:
            check('get_denied_' + path.replace('/', '_'), lambda p=path: status(KEYCHAIN, p, 404))
        manifest = json.loads((ROOT/'keychain/prover/manifest.json').read_text())
        for name, pin in manifest['files'].items():
            def asset(n=name, p=pin):
                code, h, _, size, digest = fetcher(KEYCHAIN + '/prover/v1.0.1/' + n, limit=p['bytes'], digest_only=True)
                require(code == 200, 'ASSET_UNAVAILABLE')
                headers_ok(h, asset=True)
                mime = 'application/wasm' if n.endswith('.wasm') else 'text/javascript' if n.endswith(('.mjs', '.js')) else 'text/plain'
                require(h.get('content-type', '').split(';')[0] == mime, 'ASSET_MIME_MISMATCH')
                require(size == p['bytes'] and digest == p['sha256'], 'ASSET_PIN_MISMATCH')
            check('pinned_asset_' + name.replace('/', '_'), asset)
    return {'schema': 'kamui.hosted-https-acceptance.v1', 'mode': 'probe-only' if probe_only else 'public-https-and-pinned-assets',
            'keychainOrigin': KEYCHAIN, 'pepperOrigin': PEPPER, 'checks': checks,
            'passed': all(c['status'] == 'passed' for c in checks),
            'unverified': ['Google authentication and browser proving', 'private API and database network isolation', 'funding policy and restart persistence', 'backup restore and alert delivery', 'AWS permissions and custody review']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe-only', action='store_true', help='Two read-only HTTPS health requests; does not establish acceptance')
    parser.add_argument('--google-client-id', help='Expected existing public Google OAuth client ID; required for full checks')
    parser.add_argument('--main-sha256', help='SHA-256 of main.js from the matching reviewed release build; required for full checks')
    parser.add_argument('--output', help='Exclusive private JSON result path outside Git; no response bodies are retained')
    args = parser.parse_args()
    if not args.probe_only and (not args.google_client_id or not args.google_client_id.endswith('.apps.googleusercontent.com')):
        parser.error('full checks require the expected public Google client ID')
    if not args.probe_only and not re.fullmatch('[0-9a-f]{64}', args.main_sha256 or ''):
        parser.error('full checks require --main-sha256 from the matching reviewed release build')
    result = run(args.google_client_id, args.probe_only, main_sha256=args.main_sha256)
    if args.output:
        p = Path(args.output)
        if not p.is_absolute() or p.parent.resolve().is_relative_to(ROOT) or p.parent.stat().st_mode & 0o077 or p.parent.stat().st_uid != os.getuid():
            raise Failure('PRIVATE_OUTPUT_DIRECTORY_REQUIRED')
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(json.dumps(result, indent=2) + '\n'); f.flush(); os.fsync(f.fileno())
    print(json.dumps(result))
    return 0 if result['passed'] else 1

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Failure:
        print('HOSTED_ACCEPTANCE_FAILED')
        raise SystemExit(1)
