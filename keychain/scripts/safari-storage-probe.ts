// Disposable local-only fixture. Never sign in here or use a real device key.
// Run from keychain/: bun run scripts/safari-storage-probe.ts
const built = await Bun.build({ entrypoints: [`${import.meta.dir}/safari-storage-probe-client.ts`], target: 'browser' });
if (!built.success) throw new Error('Could not build the storage probe');
const script = await built.outputs[0]!.text();
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Kamui Safari storage probe</title>
<h1>Kamui Safari storage probe</h1><p>Disposable fixture at a separate origin. No wallet, account or sign-in is used.</p>
<p>It stores a fixed non-secret marker through Kamui's real encrypted vault.</p>
<button id="write">Write disposable probe</button> <button id="read">Read stored probe</button>
<button id="clear">Simulate storage loss for this probe</button>
<pre id="result" role="status">Reading…</pre><script src="/probe.js"></script></html>`;
Bun.serve({ hostname: '127.0.0.1', port: 5193, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/probe.js') return new Response(script, { headers: { 'content-type': 'text/javascript' } });
  if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
  return new Response('not found', { status: 404 });
} });
console.log('Disposable Safari probe: http://127.0.0.1:5193/');
