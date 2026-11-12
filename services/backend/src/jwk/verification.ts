import { HttpError } from '../http';
import { metrics } from '../metrics';
import { fetchWithTimeout, type Fetch } from '../net';

// `variant` is the index of the `Issuer` enum in social_account/src/jwt/types.cairo, the calldata form of the issuer.
export const ISSUERS = [
  { iss: 'https://accounts.google.com', variant: 0, certs: 'https://www.googleapis.com/oauth2/v3/certs' },
  { iss: 'https://appleid.apple.com', variant: 1, certs: 'https://appleid.apple.com/auth/oauth2/v2/keys' },
] as const;

export type Jwk = {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string
};

export type IssuerJwks = { iss: string; keys: Jwk[]; headers: Headers };

// Kamui: issuer fetches have a deadline, and the api reads keys through `JwksCache` below.
export const JWKS_TIMEOUT_MS = 5_000;

/** One uncached fetch of an issuer's keys, bounded by `timeoutMs`. The rotator and the watcher use this directly. */
export async function fetchJwks(iss: string, send: Fetch = fetch, timeoutMs = JWKS_TIMEOUT_MS): Promise<IssuerJwks> {
  const issuer = ISSUERS.find((i) => i.iss === iss);
  if (!issuer) throw new Error('WRONG_ISSUER');
  const res = await fetchWithTimeout(issuer.certs, {}, timeoutMs, send);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys) || !body.keys.every((k) => k && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string')) {
    throw new Error('JWKS fetch failed: not a key set');
  }
  return { iss, keys: body.keys as Jwk[], headers: res.headers };
}

export type JwksCacheOptions = {
  send?: Fetch;
  now?: () => number;
  /** How long fetched keys are used without asking again. */
  ttlMs?: number;
  /** A token naming a kid that is not in the cache forces a refresh at most this often. */
  minRefreshMs?: number;
  /** After a failed fetch, requests fail at once for this long instead of asking again. */
  failureBackoffMs?: number;
  timeoutMs?: number;
};

/**
 * Kamui (audit finding #3): the issuer keys the api verifies tokens with, cached per issuer.
 *
 * - Keys are fetched at most once per `ttlMs` (5 minutes), and concurrent misses share one fetch.
 * - A token whose kid is not in the cache triggers one refresh, at most once per `minRefreshMs`
 *   (1 minute) per issuer. So a rotated key is usable within a minute of its first token, and
 *   five minutes at worst; unsigned tokens with made-up kids cost one fetch a minute, not one each.
 * - A fetch is bounded by `timeoutMs`. After a failure, requests are refused at once with 502
 *   JWKS_UNAVAILABLE for `failureBackoffMs` (10 seconds). Expired keys are never used: the
 *   request fails instead.
 */
export class JwksCache {
  private entries = new Map<string, { keys?: Jwk[]; fetchedAt: number; attemptedAt: number; failedAt: number; inflight?: Promise<Jwk[]> }>();
  private send: Fetch;
  private now: () => number;
  private ttlMs: number;
  private minRefreshMs: number;
  private failureBackoffMs: number;
  private timeoutMs: number;

  constructor(options: JwksCacheOptions = {}) {
    this.send = options.send ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.minRefreshMs = options.minRefreshMs ?? 60_000;
    this.failureBackoffMs = options.failureBackoffMs ?? 10_000;
    this.timeoutMs = options.timeoutMs ?? JWKS_TIMEOUT_MS;
  }

  /** The issuer's keys. Pass the token's `kid` so a kid newer than the cache can trigger a refresh. */
  async keys(iss: string, kid?: string): Promise<Jwk[]> {
    if (!ISSUERS.some((i) => i.iss === iss)) throw new HttpError(400, 'WRONG_ISSUER');
    let entry = this.entries.get(iss);
    if (!entry) this.entries.set(iss, (entry = { fetchedAt: -Infinity, attemptedAt: -Infinity, failedAt: -Infinity }));
    const now = this.now();
    const fresh = entry.keys !== undefined && now - entry.fetchedAt < this.ttlMs;
    if (fresh) {
      const known = kid === undefined || entry.keys!.some((k) => k.kid === kid);
      if (known || now - entry.attemptedAt < this.minRefreshMs) return entry.keys!;
    }
    if (entry.inflight) return fresh ? entry.inflight.catch(() => entry.keys!) : entry.inflight;
    if (now - entry.failedAt < this.failureBackoffMs) {
      if (fresh) return entry.keys!;
      throw new HttpError(502, 'JWKS_UNAVAILABLE');
    }

    entry.attemptedAt = now;
    const current = entry;
    const inflight = fetchJwks(iss, this.send, this.timeoutMs).then(
      ({ keys }) => {
        current.keys = keys;
        current.fetchedAt = this.now();
        metrics.jwksFetches.inc({ issuer: iss, result: 'ok' });
        return keys;
      },
      () => {
        current.failedAt = this.now();
        metrics.jwksFetches.inc({ issuer: iss, result: 'failed' });
        metrics.outboundFailures.inc({ target: 'jwks' });
        throw new HttpError(502, 'JWKS_UNAVAILABLE');
      },
    ).finally(() => {
      current.inflight = undefined;
    });
    entry.inflight = inflight;
    // A refresh for an unknown kid that fails still leaves the unexpired keys usable.
    return fresh ? inflight.catch(() => current.keys!) : inflight;
  }
}

export type Jwt = {
  kid: string;
  iss: string;
  aud: string;
  sub: string;
  nonce: string;
  exp: number;
  iat: number;
  // `header`.`payload` is the message signed and produced the `signature`
  messageToSign: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
};

export function extractJwt(jwt: string): Jwt {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('BAD_JWT');

  const [header, payload, signature] = parts;
  const json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());
  const h = json(header) as { alg?: string; kid?: string };
  const p = json(payload) as Partial<Pick<Jwt, 'iss' | 'aud' | 'sub' | 'nonce' | 'exp' | 'iat'>>;

  if (h.alg !== 'RS256' || !h.kid) throw new Error('UNSUPPORTED_ALG');
  if (!p.iss || !p.aud || !p.sub || !p.nonce || !p.exp || !p.iat) throw new Error('BAD_PAYLOAD');

  return {
    kid: h.kid,
    iss: p.iss,
    aud: p.aud,
    sub: p.sub,
    nonce: p.nonce,
    exp: p.exp,
    iat: p.iat,
    messageToSign: new Uint8Array(new TextEncoder().encode(`${header}.${payload}`)),
    signature: new Uint8Array(Buffer.from(signature, 'base64url')),
  };
}

/** 
 * Verifies JWT with RS256 against JWK. Checks expiry based
 * on `Date.now()` and allows well-known `iss`.
 */
export async function verifyJwt(token: Jwt, keys: Jwk[]): Promise<Jwk> {
  const jwk = keys.find((k) => k.kid === token.kid);
  if (!jwk) throw new Error('UNKNOWN_KID');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, token.signature, token.messageToSign);
  if (!ok) throw new Error('BAD_SIGNATURE');

  if (!ISSUERS.some((i) => i.iss === token.iss)) throw new Error('WRONG_ISSUER');
  if (token.exp <= Date.now() / 1000) throw new Error('TOKEN_EXPIRED');

  return jwk;
}
