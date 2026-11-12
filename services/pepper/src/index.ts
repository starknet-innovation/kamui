// Entry point. `bun run src/index.ts` serves; `--print-key-check` prints the key check value.
import { createApp } from './app';
import { loadConfig, loadDeriver, loadKey } from './config';
import { keyCheckValue } from './derive';
import { cachedJwks, fetchJwks } from './jwt';
import { stdoutLogger } from './log';

if (process.argv.includes('--print-key-check')) {
  console.log(keyCheckValue(loadKey(process.env)));
  process.exit(0);
}

const cfg = loadConfig(process.env);
const handle = createApp({
  deriver: loadDeriver(process.env),
  audiences: cfg.audiences,
  lookupKey: cachedJwks(fetchJwks, Date.now),
  now: Date.now,
  log: stdoutLogger,
  requireKeyProof: cfg.requireKeyProof,
  maxTokenAgeSeconds: cfg.maxTokenAgeSeconds,
  allowedOrigins: cfg.allowedOrigins,
  limits: cfg.limits,
});

const server = Bun.serve({
  port: cfg.port,
  fetch(req, srv) {
    // Behind a proxy the socket address is the proxy's; take the last hop it appended.
    const forwarded = cfg.trustProxy ? req.headers.get('x-forwarded-for')?.split(',').pop()?.trim() : undefined;
    return handle(req, forwarded || srv.requestIP(req)?.address || 'unknown');
  },
});
stdoutLogger({ event: 'start', port: server.port });
