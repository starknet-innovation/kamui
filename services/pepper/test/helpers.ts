// Test fixtures: a throwaway RSA issuer key, self-signed tokens, a throwaway device key.
// Nothing here reaches the network and no key outlives the test process.
import { randomBytes } from 'node:crypto';
import { getPublicKey, poseidonHashMany, sign, utils } from '@scure/starknet';
import { createApp, type AppConfig } from '../src/app';
import { inMemoryDeriver } from '../src/derive';
import { cachedJwks, type Jwk } from '../src/jwt';
import { keyProofHash } from '../src/keyproof';
import type { LogEntry } from '../src/log';

export const GOOGLE = 'https://accounts.google.com';
export const APPLE = 'https://appleid.apple.com';
export const AUD = 'kamui-keychain.apps.example';
export const RECOVERY_AUD = 'kamui-recovery.apps.example';
export const SUB = '123456789012345678901';
/** A fixed test clock, in milliseconds. */
export const NOW = 1_800_000_000_000;

const b64 = (v: string | Uint8Array) => Buffer.from(v).toString('base64url');

export type Issuer = { kid: string; jwk: Jwk; sign: (payload: object, header?: object) => Promise<string> };

export async function makeIssuer(kid: string): Promise<Issuer> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    jwk: { kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: pub.n!, e: pub.e! },
    async sign(payload, header = {}) {
      const message = `${b64(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }))}.${b64(JSON.stringify(payload))}`;
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(message));
      return `${message}.${b64(new Uint8Array(sig))}`;
    },
  };
}

/** A device key and the nonce the keychain would put in the OAuth request for it. */
export function makeDevice() {
  const privateKey = utils.randomPrivateKey();
  // Starknet public key: the x coordinate of the point.
  const publicKey = `0x${Buffer.from(getPublicKey(privateKey, true)).subarray(1).toString('hex')}`;
  const blinding = `0x${randomBytes(31).toString('hex')}`;
  const nonce = poseidonHashMany([BigInt(publicKey), BigInt(blinding)]);
  const sig = sign(keyProofHash(nonce).toString(16).padStart(64, '0'), privateKey);
  return {
    privateKey,
    publicKey,
    blinding,
    nonce: `0x${nonce.toString(16)}`,
    proof: { public_key: publicKey, blinding, signature: [`0x${sig.r.toString(16)}`, `0x${sig.s.toString(16)}`] },
  };
}

export function claims(over: Record<string, unknown> = {}) {
  return { iss: GOOGLE, aud: AUD, sub: SUB, nonce: '0x1', iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600, ...over };
}

export function makeService(issuers: Issuer[], over: Partial<AppConfig> = {}) {
  const logs: LogEntry[] = [];
  const key = Uint8Array.from(randomBytes(32));
  let fetches = 0;
  const cfg: AppConfig = {
    deriver: inMemoryDeriver(key, 1),
    audiences: { [GOOGLE]: [AUD, RECOVERY_AUD], [APPLE]: [AUD] },
    lookupKey: cachedJwks(async () => (fetches++, issuers.map((i) => i.jwk)), () => NOW),
    now: () => NOW,
    log: (e) => logs.push(e),
    requireKeyProof: true,
    maxTokenAgeSeconds: 600,
    allowedOrigins: ['https://keychain.example'],
    limits: { ipBurst: 1000, ipPerMinute: 1000, subjectBurst: 1000, subjectPerHour: 1000 },
    ...over,
  };
  const handle = createApp(cfg);
  const post = async (body: unknown, headers: Record<string, string> = {}, ip = '203.0.113.1') => {
    const res = await handle(
      new Request('http://pepper.test/v1/pepper', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      ip,
    );
    return { status: res.status, headers: res.headers, body: (await res.json()) as { pepper?: string; key_version?: number; error?: string } };
  };
  return { handle, post, logs, key, fetches: () => fetches };
}
