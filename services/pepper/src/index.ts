// Entry point. `bun run src/index.ts` serves; `--print-key-check` prints the key check value.
// PEPPER_KEY_SOURCE picks the key holder: env (development) or kms (AWS KMS).
import { createApp } from './app';
import { keySource, kmsSettings, loadConfig, loadDeriver, loadKey, loadKmsDeriver } from './config';
import { keyCheckValue } from './derive';
import { cachedJwks, fetchJwks } from './jwt';
import { awsKms, macKeyCheckValue } from './kms';
import { stdoutLogger } from './log';

async function main(): Promise<void> {
  const source = keySource(process.env);
  const kms = source === 'kms' ? await awsKms(kmsSettings(process.env).keyId, kmsSettings(process.env).region) : undefined;

  // Run once when the key is created, and record the output as PEPPER_KEY_CHECK.
  if (process.argv.includes('--print-key-check')) {
    console.log(kms ? await macKeyCheckValue(kms.client) : keyCheckValue(loadKey(process.env)));
    process.exit(0);
  }

  const cfg = loadConfig(process.env);
  let deriver;
  if (kms) {
    const loaded = await loadKmsDeriver(process.env, kms);
    deriver = loaded.deriver;
    stdoutLogger({ event: 'kms_key', multi_region: loaded.key.multiRegion === true });
  } else {
    deriver = loadDeriver(process.env);
  }
  const handle = createApp({
    deriver,
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
}

void main().catch(() => { console.error(JSON.stringify({ event: 'pepper_startup_failed' })); process.exit(1); });
