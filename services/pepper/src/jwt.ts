// JWT parsing and RS256 verification against the issuer's JWKS.
//
// Ported from keep-starknet-strange/social-account (MIT), backend/src/jwk/verification.ts at
// commit e1681348afbf5fc55ea410ea7ef93e1df575e969. See ../THIRD_PARTY.md.
// Changes: typed errors, claim type checks, an injectable clock and JWKS fetcher, a JWKS
// cache, `iat` and token-age checks, and the audience check moved in here.
import { ApiError } from './errors';

export const ISSUERS = [
  { name: 'google', iss: 'https://accounts.google.com', certs: 'https://www.googleapis.com/oauth2/v3/certs' },
  { name: 'apple', iss: 'https://appleid.apple.com', certs: 'https://appleid.apple.com/auth/oauth2/v2/keys' },
] as const;
export type IssuerName = (typeof ISSUERS)[number]['name'];

export type Jwk = { kid: string; kty: string; alg?: string; use?: string; n: string; e: string };
/** Returns the issuer's current signing keys. Injected so tests never reach the network. */
export type JwksFetcher = (iss: string) => Promise<Jwk[]>;

export type Jwt = {
  kid: string;
  iss: string;
  aud: string;
  sub: string;
  nonce: string;
  exp: number;
  iat: number;
  /** `header.payload`, the bytes the issuer signed. */
  messageToSign: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
};

export function issuerOf(iss: string) {
  return ISSUERS.find((i) => i.iss === iss);
}

export const fetchJwks: JwksFetcher = async (iss) => {
  const issuer = issuerOf(iss);
  if (!issuer) throw new ApiError(401, 'WRONG_ISSUER');
  const res = await fetch(issuer.certs, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  return ((await res.json()) as { keys: Jwk[] }).keys;
};

/**
 * Caches each issuer's keys for `ttlMs`. A `kid` that is not in the cache triggers one
 * refetch, at most every `minRefetchMs`, so a new issuer key works at once and an attacker
 * sending random `kid`s cannot make the service hammer the issuer.
 */
export function cachedJwks(
  fetcher: JwksFetcher,
  now: () => number,
  ttlMs = 3_600_000,
  minRefetchMs = 60_000,
): (iss: string, kid: string) => Promise<Jwk | undefined> {
  const cache = new Map<string, { keys: Jwk[]; at: number }>();
  return async (iss, kid) => {
    let entry = cache.get(iss);
    const age = entry ? now() - entry.at : Infinity;
    const hit = entry?.keys.find((k) => k.kid === kid);
    if (!entry || age > ttlMs || (!hit && age > minRefetchMs)) {
      try {
        entry = { keys: await fetcher(iss), at: now() };
        cache.set(iss, entry);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // Keep serving known keys if the issuer is unreachable; fail only with no keys at all.
        if (!entry) throw new ApiError(503, 'JWKS_UNAVAILABLE');
      }
    }
    return entry.keys.find((k) => k.kid === kid);
  };
}

export function extractJwt(jwt: string): Jwt {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new ApiError(400, 'BAD_JWT');
  const [header, payload, signature] = parts;

  let h: Record<string, unknown>, p: Record<string, unknown>;
  try {
    const json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());
    h = json(header);
    p = json(payload);
  } catch {
    throw new ApiError(400, 'BAD_JWT');
  }
  if (typeof h !== 'object' || h === null || typeof p !== 'object' || p === null) throw new ApiError(400, 'BAD_JWT');

  // RS256 only: `none` and HMAC algorithms are refused here, before any key is looked up.
  if (h.alg !== 'RS256' || typeof h.kid !== 'string' || !h.kid) throw new ApiError(400, 'UNSUPPORTED_ALG');
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  const int = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  // `aud` must be one string. The contract hashes it as one ByteArray, and both issuers send one.
  if (!str(p.iss) || !str(p.aud) || !str(p.sub) || !str(p.nonce) || !int(p.exp) || !int(p.iat))
    throw new ApiError(400, 'BAD_PAYLOAD');

  return {
    kid: h.kid,
    iss: p.iss as string,
    aud: p.aud as string,
    sub: p.sub as string,
    nonce: p.nonce as string,
    exp: p.exp as number,
    iat: p.iat as number,
    messageToSign: new Uint8Array(new TextEncoder().encode(`${header}.${payload}`)),
    signature: new Uint8Array(Buffer.from(signature, 'base64url')),
  };
}

export type VerifyOptions = {
  /** Allowed `aud` values per `iss`. An issuer with no entry is refused. */
  audiences: Record<string, readonly string[]>;
  lookupKey: (iss: string, kid: string) => Promise<Jwk | undefined>;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** Tolerance for a token issued slightly in the future by the issuer's clock. */
  iatLeewaySeconds?: number;
  /** Refuse tokens issued longer ago than this, even if not expired. Shrinks the replay window. */
  maxAgeSeconds?: number;
};

/**
 * Checks, in order: known issuer, signature (RS256 against the issuer's key for `kid`),
 * expiry, `iat` not in the future, token age, allowed audience. Nothing from the token is trusted
 * before the signature check except `iss` and `kid`, which only select the key.
 */
export async function verifyJwt(token: Jwt, opts: VerifyOptions): Promise<void> {
  if (!issuerOf(token.iss)) throw new ApiError(401, 'WRONG_ISSUER');

  const jwk = await opts.lookupKey(token.iss, token.kid);
  if (!jwk) throw new ApiError(401, 'UNKNOWN_KID');
  if (jwk.kty !== 'RSA') throw new ApiError(401, 'UNKNOWN_KID');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, token.signature, token.messageToSign);
  if (!ok) throw new ApiError(401, 'BAD_SIGNATURE');

  const nowSeconds = opts.now() / 1000;
  if (token.exp <= nowSeconds) throw new ApiError(401, 'TOKEN_EXPIRED');
  if (token.iat > nowSeconds + (opts.iatLeewaySeconds ?? 60)) throw new ApiError(401, 'TOKEN_NOT_YET_VALID');
  if (opts.maxAgeSeconds !== undefined && token.iat < nowSeconds - opts.maxAgeSeconds) throw new ApiError(401, 'TOKEN_TOO_OLD');
  if (!(opts.audiences[token.iss] ?? []).includes(token.aud)) throw new ApiError(403, 'WRONG_AUDIENCE');
}
