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
const ROOT = `${import.meta.dir}/..`;

async function envFile(path: string): Promise<Record<string, string>> {
  const text = await Bun.file(path).text().catch(() => '');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

const secrets = await envFile(`${ROOT}/services/backend/.env.local`);
const deployments = await envFile(`${ROOT}/services/backend/deployments.env`);
const need = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const PORT = Number(process.env.PORT ?? 5173);
const API = process.env.API_URL ?? 'http://localhost:3000';
// Public values only. The environment wins over the backend's files, which is how the browser
// tests point the keychain at their own fakes.
const config = {
  googleClientId: need(process.env.GOOGLE_CLIENT_ID ?? secrets.AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID, 'AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID'),
  // Optional. Without it the page does not offer "Continue with Apple".
  appleClientId: process.env.APPLE_CLIENT_ID ?? secrets.AUTHORIZED_APPLE_RECOVERY_CLIENT_ID ?? '',
  rpcUrl: need(process.env.RPC_URL ?? secrets.RPC_URL, 'RPC_URL'),
  classHash: need(process.env.KAMUI_ACCOUNT_CLASS_HASH ?? deployments.KAMUI_ACCOUNT_CLASS_HASH, 'KAMUI_ACCOUNT_CLASS_HASH'),
  pepperUrl: process.env.PEPPER_URL ?? 'http://localhost:8787',
  apiUrl: '/api',
  redirectUri: `http://localhost:${PORT}/callback`,
  // How often the page asks the chain whether a transaction has landed. starknet.js waits 5 s
  // before its first look by default, which is felt on every approval.
  pollMs: Number(process.env.POLL_MS ?? 2000),
};

const build = await Bun.build({ entrypoints: [`${import.meta.dir}/src/main.ts`], target: 'browser' });
if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error('could not bundle src/main.ts');
}
const script = await build.outputs[0]!.text();
const page = await Bun.file(`${import.meta.dir}/index.html`).text();
const style = await Bun.file(`${import.meta.dir}/style.css`).text();

// Only this origin's own script and style run. The page may talk to itself, the RPC and the
// pepper service, and nothing may put it in a frame.
const security = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src 'self' ${new URL(config.rpcUrl).origin} ${new URL(config.pepperUrl).origin}`,
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
  const forwarded = [request.headers.get('x-forwarded-for'), clientAddress].filter(Boolean).join(', ');
  if (forwarded) headers['x-forwarded-for'] = forwarded;
  const appKey = request.headers.get('x-kamui-app-key');
  if (appKey) headers['x-kamui-app-key'] = appKey;
  return headers;
}

Bun.serve({
  port: PORT,
  idleTimeout: 255, // a proof takes tens of seconds
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/main.js') return respond(script, 'text/javascript');
    if (url.pathname === '/style.css') return respond(style, 'text/css');
    if (url.pathname === '/config.json') return respond(JSON.stringify(config), 'application/json');
    if (url.pathname.startsWith('/api/')) {
      return fetch(`${API}${url.pathname.slice(4)}`, {
        method: request.method,
        headers: proxyHeaders(request, server.requestIP(request)?.address),
        body: request.method === 'GET' ? undefined : await request.text(),
      });
    }
    if (url.pathname === '/' || url.pathname === '/connect' || url.pathname === '/execute' || url.pathname === '/callback') {
      return respond(page, 'text/html; charset=utf-8');
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`keychain on http://localhost:${PORT}`);
