// The HTTP layer: POST /v1/pepper and GET /health. Everything it depends on is injected,
// so tests run it without a network, a real clock or a real key.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { encodeInput, pepperToHex, type PepperDeriver } from './derive';
import { ApiError } from './errors';
import { extractJwt, issuerOf, verifyJwt, type Jwk } from './jwt';
import { parseKeyProof, parseNonce, verifyKeyProof } from './keyproof';
import type { LogEntry, Logger } from './log';
import { RateLimiter } from './ratelimit';

export type AppConfig = {
  deriver: PepperDeriver;
  /** Allowed `aud` values per `iss` (plan D3). */
  audiences: Record<string, readonly string[]>;
  lookupKey: (iss: string, kid: string) => Promise<Jwk | undefined>;
  now: () => number;
  log: Logger;
  requireKeyProof: boolean;
  /** Oldest token accepted, in seconds since its `iat`. */
  maxTokenAgeSeconds: number;
  /** Browser origins allowed by CORS. */
  allowedOrigins: readonly string[];
  limits: { ipBurst: number; ipPerMinute: number; subjectBurst: number; subjectPerHour: number };
};

const MAX_BODY_BYTES = 16 * 1024;

export function createApp(cfg: AppConfig) {
  const ipLimit = new RateLimiter(cfg.limits.ipBurst, cfg.limits.ipPerMinute / 60_000, cfg.now);
  const subjectLimit = new RateLimiter(cfg.limits.subjectBurst, cfg.limits.subjectPerHour / 3_600_000, cfg.now);
  // Rate-limit buckets are keyed by a MAC of (iss, sub) under a key that exists only in this
  // process, so the limiter's memory holds no raw subject identifiers.
  const bucketKey = randomBytes(32);
  const subjectBucket = (iss: string, sub: string) =>
    createHmac('sha256', bucketKey).update(encodeInput(iss, sub)).digest('base64');

  async function pepper(req: Request, clientIp: string, entry: LogEntry): Promise<Response> {
    if (!ipLimit.take(clientIp)) throw new ApiError(429, 'RATE_LIMITED');
    if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json'))
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE');

    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'BAD_JSON');
    }
    if (typeof body !== 'object' || body === null || typeof body.jwt !== 'string') throw new ApiError(400, 'BAD_REQUEST');

    const token = extractJwt(body.jwt);
    await verifyJwt(token, { audiences: cfg.audiences, lookupKey: cfg.lookupKey, now: cfg.now, maxAgeSeconds: cfg.maxTokenAgeSeconds });
    // From here on the token is authentic, so the issuer and audience are safe to log.
    entry.issuer = issuerOf(token.iss)!.name;
    entry.audience_index = cfg.audiences[token.iss].indexOf(token.aud);

    // A token with no usable nonce can never pass `prove_jwt`, so it has no business here.
    const nonce = parseNonce(token.nonce);
    if (cfg.requireKeyProof) verifyKeyProof(nonce, parseKeyProof(body));

    if (!subjectLimit.take(subjectBucket(token.iss, token.sub))) throw new ApiError(429, 'RATE_LIMITED');

    const value = await cfg.deriver.derive(token.iss, token.sub);
    entry.key_version = cfg.deriver.version;
    return json(200, { pepper: pepperToHex(value), key_version: cfg.deriver.version });
  }

  /** `clientIp` comes from the socket (or a trusted proxy header); it is used for rate limiting only and is not logged. */
  return async function handle(req: Request, clientIp: string): Promise<Response> {
    const started = cfg.now();
    const url = new URL(req.url);
    const origin = req.headers.get('origin');
    const cors = corsHeaders(origin, cfg.allowedOrigins);

    if (url.pathname === '/health' && req.method === 'GET') return json(200, { status: 'ok' });
    if (url.pathname !== '/v1/pepper') return json(404, { error: 'NOT_FOUND' });
    if (req.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });

    const entry: LogEntry = { event: 'request', request_id: randomUUID() };
    let res: Response;
    try {
      if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      // CORS is not authentication (the token is); this only stops other sites' pages.
      if (origin && !cors) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED');
      res = await pepper(req, clientIp, entry);
      entry.outcome = 'OK';
    } catch (e) {
      if (e instanceof ApiError) {
        entry.outcome = e.code;
        res = json(e.status, { error: e.code });
      } else {
        // Unexpected. Log the class only: an error message may quote the input.
        cfg.log({ event: 'internal_error', request_id: entry.request_id, error_class: e instanceof Error ? e.name : 'unknown' });
        entry.outcome = 'INTERNAL';
        res = json(500, { error: 'INTERNAL' });
      }
    }
    for (const [k, v] of Object.entries(cors ?? {})) res.headers.set(k, v);
    res.headers.set('x-request-id', entry.request_id!);
    entry.status = res.status;
    entry.duration_ms = cfg.now() - started;
    cfg.log(entry);
    return res;
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    // A pepper must never sit in a browser or proxy cache.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}
