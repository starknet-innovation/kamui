import { createHash } from 'node:crypto';
// Local server for the keychain. Development only.
//
//   bun run server.ts        http://localhost:5173
//
// It bundles src/main.ts for the browser, serves the page with a strict content security
// policy, hands it public settings, and proxies /api to the backend (which sends no CORS
// headers), passing on the client's address and the page's app key if it sent one. Settings come from the backend's local files:
//   services/backend/.env.local       RPC_URL, AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID,
//                                     AUTHORIZED_APPLE_RECOVERY_CLIENT_ID (optional)
//   services/backend/deployments.env  KAMUI_ACCOUNT_CLASS_HASH
import { keychainOrigin, apiProxyAllowed, publicHttpsUrl } from './server-config';

const ROOT = `${import.meta.dir}/..`;
const production = process.env.NODE_ENV === 'production';

async function envFile(path: string): Promise<Record<string, string>> {
  const text = await Bun.file(path).text().catch(() => '');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

const secrets = production ? {} : await envFile(`${ROOT}/services/backend/.env.local`);
const deployments = production ? {} : await envFile(`${ROOT}/services/backend/deployments.env`);
const need = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const PORT = Number(process.env.PORT ?? 5173);
const API = process.env.API_URL ?? 'http://localhost:3000';
if (production && (!process.env.KEYCHAIN_PUBLIC_ORIGIN || !process.env.API_URL)) throw new Error('KEYCHAIN_PRODUCTION_CONFIG_REQUIRED');
const { origin, redirectUri } = keychainOrigin({ port: PORT, publicOrigin: process.env.KEYCHAIN_PUBLIC_ORIGIN });
// Public values only. The environment wins over the backend's files, which is how the browser
// tests point the keychain at their own fakes.
const config = {
  proverReady: false,
  proverExecutor: process.env.PROVER_EXECUTOR_ADDRESS ?? deployments.PROVER_EXECUTOR_ADDRESS ?? '',
  jwkRegistry: process.env.JWK_REGISTRY_ADDRESS ?? deployments.SN_SEPOLIA_REGISTRY_ADDRESS ?? '',
  googleClientId: need(process.env.GOOGLE_CLIENT_ID ?? secrets.AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID, 'AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID'),
  // Optional. Without it the page does not offer "Continue with Apple".
  appleClientId: process.env.APPLE_CLIENT_ID ?? secrets.AUTHORIZED_APPLE_RECOVERY_CLIENT_ID ?? '',
  // The keychain never reads a credential-bearing backend RPC URL from its secret file.
  rpcUrl: (production ? publicHttpsUrl(process.env.PUBLIC_RPC_URL, 'PUBLIC_RPC_URL') : process.env.PUBLIC_RPC_URL ?? process.env.RPC_URL) ?? 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10',
  // Pinned upstream state acquisition deliberately supports only this public endpoint.
  proverRpcUrl: 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10',
  classHash: need(process.env.KAMUI_ACCOUNT_CLASS_HASH ?? deployments.KAMUI_ACCOUNT_CLASS_HASH, 'KAMUI_ACCOUNT_CLASS_HASH'),
  pepperUrl: production ? publicHttpsUrl(process.env.PEPPER_URL, 'PEPPER_URL') : process.env.PEPPER_URL ?? 'http://localhost:8787',
  apiUrl: '/api',
  redirectUri,
  // How often the page asks the chain whether a transaction has landed. starknet.js waits 5 s
  // before its first look by default, which is felt on every approval.
  pollMs: Number(process.env.POLL_MS ?? 2000),
};

const manifest = await Bun.file(`${import.meta.dir}/prover/manifest.json`).json();
const proverFiles = new Map<string, Uint8Array>();
// Validate every byte of the complete pinned runtime before exposing it. Missing binaries fail
// only proving requests, so an existing owner can still use the wallet.
let proverReady = true;
for (const [path, pin] of Object.entries(manifest.files) as [string, { bytes: number; sha256: string }][]) {
  const file = Bun.file(`${import.meta.dir}/prover/${path}`);
  const data = await file.arrayBuffer().catch(() => new ArrayBuffer(0));
  if (data.byteLength !== pin.bytes || createHash('sha256').update(new Uint8Array(data)).digest('hex') !== pin.sha256) proverReady = false;
  proverFiles.set(`/prover/v1.0.1/${path}`, new Uint8Array(data));
}
config.proverReady = proverReady;
if (production && !proverReady) throw new Error('PINNED_PROVER_ASSETS_REQUIRED');
let script: string;
if (production) script = await Bun.file(`${import.meta.dir}/dist/main.js`).text();
else {
  const build = await Bun.build({ entrypoints: [`${import.meta.dir}/src/main.ts`], target: 'browser' });
  if (!build.success) throw new Error('KEYCHAIN_BUILD_FAILED');
  script = await build.outputs[0]!.text();
}
const page = await Bun.file(`${import.meta.dir}/index.html`).text();
const style = await Bun.file(`${import.meta.dir}/style.css`).text();

// Only this origin's own script and style run. The page may talk to itself, the RPC and the
// pepper service, and nothing may put it in a frame.
const security = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "style-src 'self'",
    `connect-src 'self' data: ${new URL(config.rpcUrl).origin} ${new URL(config.proverRpcUrl).origin} ${new URL(config.pepperUrl).origin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};
const respond = (body: string, type: string) => new Response(body, { headers: { 'content-type': type, ...security } });

/**
 * Headers for a proxied /api request: the client's address appended to X-Forwarded-For, so the
 * backend can rate-limit per client and not per proxy, and the app key if the page sent one.
 */
function proxyHeaders(request: Request, clientAddress: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const trusted = !production || process.env.KEYCHAIN_TRUST_PROXY === 'true';
  const forwarded = [trusted ? request.headers.get('x-forwarded-for') : undefined, clientAddress].filter(Boolean).join(', ');
  if (forwarded) headers['x-forwarded-for'] = forwarded;
  const appKey = request.headers.get('x-kamui-app-key');
  if (appKey) headers['x-kamui-app-key'] = appKey;
  // Approved app servers may pass their own credential through this one route.
  // Never load/inject a wallet credential or forward it to unrelated API routes.
  if (request.method === 'POST' && new URL(request.url).pathname === '/api/sponsor') {
    const sponsorToken = request.headers.get('x-kamui-sponsor-token');
    if (sponsorToken) headers['x-kamui-sponsor-token'] = sponsorToken;
  }
  return headers;
}

Bun.serve({
  port: PORT,
  hostname: process.env.HOST ?? (production ? '127.0.0.1' : '0.0.0.0'),
  maxRequestBodySize: 1_000_000,
  idleTimeout: 255, // a proof takes tens of seconds
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/prover/v1.0.1/')) {
      if (!proverReady) return new Response('Pinned prover assets unavailable', { status: 503, headers: security });
      // Exact manifest allow-list; no path traversal or directory listing.
      const file = proverFiles.get(url.pathname);
      if (!file || request.method !== 'GET') return new Response('not found', { status: 404 });
      return new Response(file, { headers: { ...security, 'content-type': url.pathname.endsWith('.wasm') ? 'application/wasm' : /\.(mjs|js)$/.test(url.pathname) ? 'text/javascript' : 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' } });
    }
    if (url.pathname === '/main.js') return respond(script, 'text/javascript');
    if (url.pathname === '/style.css') return respond(style, 'text/css');
    if (url.pathname === '/config.json') return respond(JSON.stringify(config), 'application/json');
    if (url.pathname === '/live' && request.method === 'GET') return respond('{"ok":true}', 'application/json');
    if (url.pathname.startsWith('/api/')) {
      const target = url.pathname.slice(4);
      if (!apiProxyAllowed(target, request.method)) return new Response('not found', { status: 404, headers: security });
      try {
        const response = await fetch(`${API}${target}`, {
          method: request.method,
          headers: proxyHeaders(request, server.requestIP(request)?.address),
          body: request.method === 'GET' ? undefined : await request.text(),
          redirect: 'error',
          signal: AbortSignal.timeout(35_000),
        });
        // Do not expose backend cookies, cache directives or arbitrary upstream headers.
        return new Response(response.body, { status: response.status, headers: { ...security, 'content-type': 'application/json' } });
      } catch { return new Response('{"error":"API_UNAVAILABLE"}', { status: 502, headers: { ...security, 'content-type': 'application/json' } }); }
    }
    if (url.pathname === '/' || url.pathname === '/connect' || url.pathname === '/execute' || url.pathname === '/callback') {
      return respond(page, 'text/html; charset=utf-8');
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`keychain on ${origin} (listening on port ${PORT})`);
