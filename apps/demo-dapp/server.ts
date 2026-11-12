// A small app that connects through the Kamui keychain. Development only.
//
//   bun run server.ts        http://localhost:5175
//
// It asks the keychain for a session limited to one function of one contract, then sends
// sponsored calls with it. /api is proxied to the backend, whose /sponsor pays for the calls.
const ROOT = `${import.meta.dir}/../..`;

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
const PORT = Number(process.env.PORT ?? 5175);
const API = process.env.API_URL ?? 'http://localhost:3000';
if (!secrets.RPC_URL) throw new Error('RPC_URL is not set in services/backend/.env.local');

// Public values only.
const config = {
  keychainUrl: process.env.KEYCHAIN_URL ?? 'http://localhost:5173',
  rpcUrl: secrets.RPC_URL,
  // A `Target` test contract on Sepolia (contracts/src/mocks.cairo): ping() and count().
  target: process.env.TARGET ?? '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc',
  sponsorUrl: '/api/sponsor',
};

const build = await Bun.build({ entrypoints: [`${import.meta.dir}/main.ts`], target: 'browser' });
if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error('could not bundle main.ts');
}
const script = await build.outputs[0]!.text();
const page = await Bun.file(`${import.meta.dir}/index.html`).text();

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
  idleTimeout: 120,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/main.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (url.pathname === '/config.json') return Response.json(config);
    if (url.pathname.startsWith('/api/')) {
      return fetch(`${API}${url.pathname.slice(4)}`, {
        method: request.method,
        headers: proxyHeaders(request, server.requestIP(request)?.address),
        body: request.method === 'GET' ? undefined : await request.text(),
      });
    }
    if (url.pathname === '/') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('not found', { status: 404 });
  },
});
console.log(`demo app on http://localhost:${PORT}`);
