import copy
import importlib.util
import json
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('hosted_acceptance', Path(__file__).with_name('hosted_acceptance.py'))
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)

HEADERS = {
    'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; connect-src 'self' data: https://api.zan.top https://api.zan.top https://pepper-sepolia.kamui.page; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000', 'cache-control': 'no-store'
}
CONFIG = {'proverReady': True, 'proverExecutor': m.EXECUTOR, 'jwkRegistry': m.REGISTRY,
          'googleClientId': 'public-fixture.apps.googleusercontent.com', 'appleClientId': '',
          'rpcUrl': m.RPC, 'proverRpcUrl': m.RPC, 'classHash': m.CLASS, 'pepperUrl': m.PEPPER,
          'apiUrl': '/api', 'redirectUri': m.KEYCHAIN + '/callback', 'pollMs': 2000}

class HostedAcceptanceTests(unittest.TestCase):
    def test_probe_does_not_download_assets_or_imply_full_acceptance(self):
        calls=[]
        def get(url, **_):
            calls.append(url); return 200, {}, b'', 0, ''
        result=m.run(probe_only=True, fetcher=get)
        self.assertTrue(result['passed']); self.assertEqual(len(calls), 2)
        self.assertEqual(result['mode'], 'probe-only')
        self.assertIn('Google authentication and browser proving', result['unverified'])

    def test_config_rejects_changed_identity_apple_credentials_and_extra_fields(self):
        m.config_ok(CONFIG, CONFIG['googleClientId'])
        for key, value in [('classHash', '0x1'), ('appleClientId', 'enabled'), ('rpcUrl', 'https://name:password@api.zan.top'), ('redirectUri', 'http://localhost/callback'), ('secret', 'fixture')]:
            changed={**CONFIG, key:value}
            with self.assertRaises(m.Failure): m.config_ok(changed, CONFIG['googleClientId'])

    def test_browser_boundary_rejects_extra_script_connect_and_frame_sources(self):
        m.headers_ok(HEADERS)
        for before, after in [("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'unsafe-inline'"), ('https://api.zan.top', 'https://wrong.invalid'), ("frame-ancestors 'none'", "frame-ancestors *")]:
            changed={**HEADERS, 'content-security-policy': HEADERS['content-security-policy'].replace(before,after)}
            with self.assertRaises(m.Failure):m.headers_ok(changed)
        with self.assertRaises(m.Failure):m.headers_ok({**HEADERS,'cache-control':'public'})

    def test_all_asset_hashes_and_private_route_boundaries_checked(self):
        manifest=json.loads((m.ROOT/'keychain/prover/manifest.json').read_text())
        seen=[]
        def get(url, **_):
            seen.append(url)
            if '/prover/v1.0.1/' in url:
                name=url.split('/prover/v1.0.1/')[1]; p=manifest['files'][name]
                mime='application/wasm' if name.endswith('.wasm') else 'text/javascript' if name.endswith(('.mjs','.js')) else 'text/plain'
                return 200,{**HEADERS,'cache-control':'public, max-age=31536000, immutable','content-type':mime},b'',p['bytes'],p['sha256']
            if url.endswith('/main.js'):return 200,{**HEADERS,'content-type':'text/javascript'},b'',42,'a'*64
            if url.endswith('/config.json'):return 200,HEADERS,json.dumps(CONFIG).encode(),0,''
            if url==m.KEYCHAIN+'/':return 200,HEADERS,b'<script type="module" src="/main.js"></script>',0,''
            if url.endswith(('/live','/health')):return 200,{},b'',0,''
            return 404,{},b'',0,''
        self.assertTrue(m.run(CONFIG['googleClientId'],fetcher=get,main_sha256='a'*64)['passed'])
        self.assertEqual(sum('/prover/' in url for url in seen),len(manifest['files']))
        def corrupt(url, **kwargs):
            status,h,body,size,digest=get(url,**kwargs)
            if url.endswith('sequencer-prover.wasm'):digest='0'*64
            return status,h,body,size,digest
        bad=m.run(CONFIG['googleClientId'],fetcher=corrupt,main_sha256='a'*64)
        self.assertFalse(bad['passed'])
        self.assertTrue(any(c.get('code')=='ASSET_PIN_MISMATCH' for c in bad['checks']))

    def test_url_refuses_unselected_host_credentials_and_redirects(self):
        for url in ['http://sepolia.kamui.page/', 'https://user:secret@sepolia.kamui.page/', 'https://wrong.invalid/', m.KEYCHAIN+'/?token=fixture']:
            with self.assertRaises(m.Failure):m.fetch(url)
        self.assertIsNone(m.NoRedirect().redirect_request(None,None,302,'',{},'https://wrong.invalid'))

    def test_untrusted_exception_body_is_not_in_evidence(self):
        def fail(*_,**__):raise RuntimeError('PRIVATE_FIXTURE_BODY_MUST_NOT_LEAK')
        result=m.run(probe_only=True,fetcher=fail)
        self.assertFalse(result['passed'])
        self.assertNotIn('PRIVATE_FIXTURE',json.dumps(result))

if __name__=='__main__':unittest.main()
