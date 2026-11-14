// Your server's sponsor route: POST /api/kamui/sponsor with { account, calldata }.
// It adds your app's sponsorship credential and forwards the call to Kamui. Written as a plain
// fetch handler (Request -> Response): it drops into Next.js route handlers, SvelteKit
// +server.ts, Hono, Bun.serve or Remix actions as is.
//
// The credential lives only here. Never send it to the browser.
const KAMUI_SPONSOR_URL = 'https://sepolia.kamui.page/api/sponsor';
const APP_KEY = process.env.KAMUI_APP_KEY!; // public identifier Kamui gave your app
const SPONSOR_TOKEN = process.env.KAMUI_SPONSOR_TOKEN!; // private credential

export async function POST(request: Request): Promise<Response> {
  // Kamui approves your app, not your users. Decide here who may spend your budget:
  // your own login, a rate limit per user or IP, a captcha, an allow-list of accounts.
  // if (!(await isAllowed(request))) return Response.json({ error: 'FORBIDDEN' }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { account?: unknown; calldata?: unknown } | null;
  if (!body || typeof body.account !== 'string' || !Array.isArray(body.calldata) || body.calldata.length > 600) {
    return Response.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }

  const upstream = await fetch(KAMUI_SPONSOR_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kamui-app-key': APP_KEY,
      'x-kamui-sponsor-token': SPONSOR_TOKEN,
    },
    body: JSON.stringify({ account: body.account, calldata: body.calldata }),
    signal: AbortSignal.timeout(40_000),
  });
  // { transaction_hash } on success, { error: CODE } otherwise.
  return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
}
