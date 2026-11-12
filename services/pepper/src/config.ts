// Reads the environment. PEPPER_KEY_SOURCE=env (development: the key comes from PEPPER_KEY_HEX)
// or kms (production: the key is an AWS KMS HMAC key).
import { inMemoryDeriver, keyCheckValue, KEY_BYTES, type PepperDeriver } from './derive';
import { ISSUERS } from './jwt';
import { assertPepperKey, macDeriver, macKeyCheckValue, type KmsKeyInfo, type MacClient } from './kms';

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

export type KeySource = 'env' | 'kms';

export function keySource(env: Env): KeySource {
  const source = env.PEPPER_KEY_SOURCE ?? 'env';
  if (source !== 'env' && source !== 'kms') throw new Error('PEPPER_KEY_SOURCE must be env or kms');
  return source;
}

export function kmsSettings(env: Env): { keyId: string; region: string } {
  const keyId = env.KMS_KEY_ID ?? '';
  // An ARN names the account and Region, so an alias in the wrong place cannot be picked up.
  if (!/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(keyId)) throw new Error('KMS_KEY_ID must be a KMS key ARN');
  const region = env.AWS_REGION || keyId.split(':')[3]!;
  return { keyId, region };
}

/**
 * The production deriver. Refuses to start unless the KMS key is the kind the design calls for
 * and PEPPER_KEY_CHECK matches it. The check is mandatory here: pointing the service at another
 * HMAC key would not fail by itself, it would give every user a different, empty account.
 */
export async function loadKmsDeriver(
  env: Env,
  kms: { client: MacClient; describe(): Promise<KmsKeyInfo> },
): Promise<{ deriver: PepperDeriver; key: KmsKeyInfo }> {
  const expected = (env.PEPPER_KEY_CHECK ?? '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(expected)) throw new Error('PEPPER_KEY_CHECK is required with PEPPER_KEY_SOURCE=kms');
  const key = await kms.describe();
  assertPepperKey(key);
  // Error text never includes the computed check value.
  if ((await macKeyCheckValue(kms.client)) !== expected) throw new Error('PEPPER_KEY_CHECK does not match the KMS key');
  return { deriver: macDeriver(kms.client, number(env, 'PEPPER_KEY_VERSION', 1)), key };
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
