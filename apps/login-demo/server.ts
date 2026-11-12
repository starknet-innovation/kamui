// A small local page that runs the SDK's login flow end to end. Development only.
//
//   bun run server.ts        then open http://localhost:5173
//
// It bundles main.ts for the browser, serves it, hands the page its public settings, and
// proxies /api to the recover API (which sends no CORS headers). The pepper service is called
// by the page directly, so its CORS allow-list is exercised.
//
// Settings come from the backend's local files, so nothing is configured twice:
//   services/backend/.env.local       RPC_URL, AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID
//   services/backend/deployments.env  KAMUI_ACCOUNT_CLASS_HASH
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
const deployments = await envFile(`${ROOT}/services/backend/deployments.env`);
const need = (value: string | undefined, name: string) => {
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const PORT = Number(process.env.PORT ?? 5173);
const API = process.env.API_URL ?? 'http://localhost:3000';
// Public values only: nothing here is a secret.
const config = {
  googleClientId: need(secrets.AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID, 'AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID'),
  rpcUrl: need(secrets.RPC_URL, 'RPC_URL'),
  classHash: need(deployments.KAMUI_ACCOUNT_CLASS_HASH, 'KAMUI_ACCOUNT_CLASS_HASH'),
  pepperUrl: process.env.PEPPER_URL ?? 'http://localhost:8787',
  apiUrl: '/api',
  redirectUri: `http://localhost:${PORT}/callback`,
};

const build = await Bun.build({ entrypoints: [`${import.meta.dir}/main.ts`], target: 'browser' });
if (!build.success) {
  for (const log of build.logs) console.error(log);
  throw new Error('could not bundle main.ts');
}
const script = await build.outputs[0]!.text();
const page = await Bun.file(`${import.meta.dir}/index.html`).text();

Bun.serve({
  port: PORT,
  idleTimeout: 255, // a proof takes tens of seconds
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/main.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } });
    if (url.pathname === '/config.json') return Response.json(config);
    if (url.pathname.startsWith('/api/')) {
      return fetch(`${API}${url.pathname.slice(4)}`, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: request.method === 'GET' ? undefined : await request.text(),
      });
    }
    if (url.pathname === '/' || url.pathname === '/callback') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`login demo on http://localhost:${PORT}`);
