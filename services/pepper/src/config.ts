// Reads the environment. Development only: the key comes from PEPPER_KEY_HEX.
import { inMemoryDeriver, keyCheckValue, KEY_BYTES, type PepperDeriver } from './derive';
import { ISSUERS } from './jwt';

export type Env = Record<string, string | undefined>;

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function number(env: Env, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

export function loadKey(env: Env): Uint8Array {
  const hex = env.PEPPER_KEY_HEX ?? '';
  if (!new RegExp(`^[0-9a-fA-F]{${KEY_BYTES * 2}}$`).test(hex)) throw new Error('PEPPER_KEY_HEX must be 64 hex characters');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export function loadDeriver(env: Env): PepperDeriver {
  const key = loadKey(env);
  const expected = (env.PEPPER_KEY_CHECK ?? '').toLowerCase();
  // Error text never includes the key or the computed check value.
  if (expected && expected !== keyCheckValue(key)) throw new Error('PEPPER_KEY_CHECK does not match the loaded key');
  return inMemoryDeriver(key, number(env, 'PEPPER_KEY_VERSION', 1));
}

export function loadConfig(env: Env) {
  const audiences: Record<string, string[]> = {
    [ISSUERS[0].iss]: list(env.GOOGLE_AUDIENCES),
    [ISSUERS[1].iss]: list(env.APPLE_AUDIENCES),
  };
  if (Object.values(audiences).every((a) => a.length === 0)) throw new Error('Set GOOGLE_AUDIENCES or APPLE_AUDIENCES');
  return {
    port: number(env, 'PORT', 8787),
    audiences,
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    requireKeyProof: (env.REQUIRE_KEY_PROOF ?? 'true') !== 'false',
    maxTokenAgeSeconds: number(env, 'MAX_TOKEN_AGE_SECONDS', 600),
    trustProxy: env.TRUST_PROXY === 'true',
    limits: {
      ipBurst: number(env, 'RATE_IP_BURST', 30),
      ipPerMinute: number(env, 'RATE_IP_PER_MINUTE', 30),
      subjectBurst: number(env, 'RATE_SUBJECT_BURST', 10),
      subjectPerHour: number(env, 'RATE_SUBJECT_PER_HOUR', 10),
    },
  };
}
