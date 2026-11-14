import { expect, test } from 'bun:test';
import { keychainOrigin } from './server-config';

test('local dev uses its listening port and public mode uses only the explicit HTTPS origin', () => {
  expect(keychainOrigin({ port: 5173 })).toEqual({ origin: 'http://localhost:5173', redirectUri: 'http://localhost:5173/callback' });
  expect(keychainOrigin({ port: 5183 })).toEqual({ origin: 'http://localhost:5183', redirectUri: 'http://localhost:5183/callback' });
  expect(keychainOrigin({ port: 5173, publicOrigin: 'https://sepolia.kamui.page' })).toEqual({
    origin: 'https://sepolia.kamui.page', redirectUri: 'https://sepolia.kamui.page/callback',
  });
  expect(keychainOrigin({ port: 5173, publicOrigin: 'https://sepolia.kamui.page/' }).redirectUri).toBe('https://sepolia.kamui.page/callback');
});

test('refuses callback injection, non-HTTPS URLs, credentials, IPs and paths', () => {
  for (const publicOrigin of [
    '', 'sepolia.kamui.page', 'http://sepolia.kamui.page', 'javascript:alert(1)',
    'https://localhost', 'https://app.localhost', 'https://127.0.0.1', 'https://[::1]', 'https://2130706433',
    'https://user:password@sepolia.kamui.page', 'https://sepolia.kamui.page/callback',
    'https://sepolia.kamui.page/another/path', 'https://sepolia.kamui.page/a/..', 'https://sepolia.kamui.page/..', 'https://sepolia.kamui.page?next=evil',
    'https://sepolia.kamui.page#evil', 'https://sepolia.kamui.page?', 'https://sepolia.kamui.page#',
    ' https://sepolia.kamui.page', 'https://sepolia.kamui.page\n', 'https://bad_host.kamui.page', 'https://sepolia.ka\nmui.page',
  ]) expect(() => keychainOrigin({ port: 5173, publicOrigin })).toThrow('KEYCHAIN_PUBLIC_ORIGIN');
});

test('rejects invalid listening ports before making a callback', () => {
  for (const port of [0, -1, 1.5, 65536, NaN, Infinity]) expect(() => keychainOrigin({ port })).toThrow('PORT');
});

test('served callback stays pinned when Host and forwarding headers are spoofed', async () => {
  // Reserve an unused local port, then let the separate server process bind it.
  const reservation = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('reserved') });
  const port = reservation.port!;
  reservation.stop(true);
  const child = Bun.spawn([process.execPath, 'server.ts'], {
    cwd: import.meta.dir,
    env: { ...process.env, PORT: String(port), KEYCHAIN_PUBLIC_ORIGIN: 'https://sepolia.kamui.page',
      GOOGLE_CLIENT_ID: 'test-google-client', APPLE_CLIENT_ID: 'test-apple-client',
      RPC_URL: 'https://rpc.example.test', PEPPER_URL: 'https://pepper.example.test',
      KAMUI_ACCOUNT_CLASS_HASH: '0x1', API_URL: 'http://127.0.0.1:5195' },
    stdout: 'ignore', stderr: 'ignore',
  });
  try {
    let response: Response | undefined;
    for (let i = 0; i < 100; i++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/config.json`, {
          headers: { host: 'attacker.invalid', 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'http' },
        });
        break;
      } catch { await Bun.sleep(20); }
    }
    if (!response) throw new Error('Test keychain server did not become ready');
    expect(response.status).toBe(200);
    const config = await response.json();
    expect(config.redirectUri).toBe('https://sepolia.kamui.page/callback');
    expect(config.googleClientId).toBe('test-google-client');
    expect(config.appleClientId).toBe('test-apple-client');
  } finally {
    child.kill();
    await child.exited;
  }
}, 10_000);

test('public proxy admits only reviewed API methods and exact paths', async () => {
  const { apiProxyAllowed, publicHttpsUrl } = await import('./server-config');
  expect(apiProxyAllowed('/relay', 'POST')).toBe(true);
  expect(apiProxyAllowed('/wallet/sponsor', 'POST')).toBe(true);
  expect(apiProxyAllowed('/wallet/sponsor', 'GET')).toBe(false);
  expect(apiProxyAllowed('/recover/status', 'POST')).toBe(true);
  expect(apiProxyAllowed('/health/api', 'GET')).toBe(true);
  for (const path of ['/metrics', '/metrics/', '/recover', '/deploy', '/registry/sessions/../metrics', '/relay?next=x', '//relay']) {
    expect(apiProxyAllowed(path, 'POST')).toBe(false);
  }
  expect(apiProxyAllowed('/relay', 'GET')).toBe(false);
  expect(apiProxyAllowed('/relay', 'PUT')).toBe(false);
  const { forwardsSponsorCredential } = await import('./server-config');
  for (const path of ['/sponsor', '/sponsor/usage', '/sponsor/token/rotate', '/sponsor/token/revoke']) {
    expect(apiProxyAllowed(path, 'POST')).toBe(true);
    expect(apiProxyAllowed(path, 'GET')).toBe(false);
    expect(forwardsSponsorCredential(path, 'POST')).toBe(true);
    expect(forwardsSponsorCredential(path, 'GET')).toBe(false);
  }
  for (const path of ['/sponsor/token', '/sponsor/usage/', '/sponsor/token/rotate/x', '/wallet/sponsor', '/registry/sessions/list', '/relay', '/health/api']) {
    expect(forwardsSponsorCredential(path, 'POST')).toBe(false);
  }
  expect(apiProxyAllowed('/sponsor/token', 'POST')).toBe(false);
  for (const value of [undefined, 'http://rpc.example', 'https://user:pass@rpc.example', 'https://rpc.example?api_key=example']) {
    expect(() => publicHttpsUrl(value, 'PUBLIC_RPC_URL')).toThrow('PUBLIC_RPC_URL_INVALID');
  }
});

test('proxy forwards a caller sponsor credential only to sponsor and strips upstream secret headers', async () => {
  const seen: (string | null)[] = [];
  const cacheControl: (string | null)[] = [];
  const backend = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    seen.push(request.headers.get('x-kamui-sponsor-token'));
    return Response.json({ ok: true }, { headers: { 'x-kamui-sponsor-token': 'must-not-reflect', 'set-cookie': 'must-not-forward' } });
  } });
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = reservation.port!; reservation.stop(true);
  const child = Bun.spawn([process.execPath, 'server.ts'], { cwd: import.meta.dir,
    env: { ...process.env, PORT: String(port), GOOGLE_CLIENT_ID:'fixture-google', KAMUI_ACCOUNT_CLASS_HASH:'0x1', API_URL:`http://127.0.0.1:${backend.port}` },
    stdout:'ignore', stderr:'ignore' });
  try {
    let ready = false;
    for (let i=0;i<100;i++) {
      try { const r=await fetch(`http://127.0.0.1:${port}/live`); if(r.ok){ready=true;break;} } catch {}
      await Bun.sleep(20);
    }
    if(!ready) throw Error('TEST_KEYCHAIN_UNAVAILABLE');
    for (const path of ['/api/sponsor','/api/wallet/sponsor','/api/registry/sessions/list','/api/sponsor/usage','/api/sponsor/token/rotate','/api/sponsor/token/revoke']) {
      const response=await fetch(`http://127.0.0.1:${port}${path}`, { method:'POST', headers:{'x-kamui-sponsor-token':'fixture-server-token'},body:'{}' });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-kamui-sponsor-token')).toBeNull();
      expect(response.headers.get('set-cookie')).toBeNull();
      cacheControl.push(response.headers.get('cache-control'));
      expect(await response.json()).toEqual({ok:true});
    }
    expect(seen).toEqual(['fixture-server-token',null,null,'fixture-server-token','fixture-server-token','fixture-server-token']);
    expect(cacheControl).toEqual(Array(6).fill('no-store'));
    expect((await fetch(`http://127.0.0.1:${port}/api/metrics`)).status).toBe(404);
  } finally { child.kill(); await child.exited; backend.stop(true); }
},10_000);
