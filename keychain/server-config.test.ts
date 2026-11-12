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
