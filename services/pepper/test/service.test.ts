import { beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { derivePepper, inMemoryDeriver, pepperToHex, FELT_PRIME } from '../src/derive';
import { ApiError } from '../src/errors';
import { cachedJwks } from '../src/jwt';
import { loadConfig, loadDeriver } from '../src/config';
import { keyCheckValue } from '../src/derive';
import {
  APPLE, AUD, GOOGLE, NOW, RECOVERY_AUD, SUB, claims, makeDevice, makeIssuer, makeService, type Issuer,
} from './helpers';

let issuer: Issuer;
let other: Issuer;
beforeAll(async () => {
  issuer = await makeIssuer('kid-1');
  other = await makeIssuer('kid-1'); // same kid, different key: a forger's key
});

/** A valid request body for the given claims. */
async function request(over: Record<string, unknown> = {}, signer = issuer) {
  const device = makeDevice();
  return { jwt: await signer.sign(claims({ nonce: device.nonce, ...over })), ...device.proof };
}

describe('POST /v1/pepper', () => {
  test('returns the pepper for (iss, sub) as a felt, uncacheable', async () => {
    const svc = makeService([issuer]);
    const res = await svc.post(await request());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pepper: pepperToHex(derivePepper(svc.key, GOOGLE, SUB)), key_version: 1 });
    expect(res.body.pepper).toMatch(/^0x[0-9a-f]+$/);
    expect(BigInt(res.body.pepper!) < FELT_PRIME).toBe(true);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('same pepper for the same user across logins and across aud', async () => {
    const svc = makeService([issuer]);
    const a = await svc.post(await request());
    const b = await svc.post(await request({ iat: NOW / 1000 - 1 }));
    const c = await svc.post(await request({ aud: RECOVERY_AUD }));
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(b.body.pepper).toBe(a.body.pepper);
    expect(c.body.pepper).toBe(a.body.pepper);
  });

  test('different pepper for a different sub and for a different iss', async () => {
    const svc = makeService([issuer]);
    const base = await svc.post(await request());
    const otherSub = await svc.post(await request({ sub: '999' }));
    const otherIss = await svc.post(await request({ iss: APPLE }));
    expect([otherSub.status, otherIss.status]).toEqual([200, 200]);
    expect(otherSub.body.pepper).not.toBe(base.body.pepper);
    expect(otherIss.body.pepper).not.toBe(base.body.pepper);
  });

  test('rejects a bad signature', async () => {
    const svc = makeService([issuer]);
    // Signed by a key that is not the issuer's, under the issuer's kid.
    expect((await svc.post(await request({}, other))).body).toEqual({ error: 'BAD_SIGNATURE' });
    // A genuine token with the payload swapped for another sub.
    const body = await request();
    const [h, , s] = body.jwt.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ sub: 'victim' }))).toString('base64url');
    const res = await svc.post({ ...body, jwt: `${h}.${forged}.${s}` });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'BAD_SIGNATURE' });
  });

  test('rejects an expired token', async () => {
    const svc = makeService([issuer]);
    const res = await svc.post(await request({ iat: NOW / 1000 - 300, exp: NOW / 1000 - 1 }));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_EXPIRED' });
    // exp equal to now is expired too.
    expect((await svc.post(await request({ exp: NOW / 1000 }))).body.error).toBe('TOKEN_EXPIRED');
  });

  test('rejects a token issued in the future', async () => {
    const svc = makeService([issuer]);
    expect((await svc.post(await request({ iat: NOW / 1000 + 600 }))).body.error).toBe('TOKEN_NOT_YET_VALID');
  });

  test('rejects a token older than the maximum age, even if not expired', async () => {
    const svc = makeService([issuer]);
    const res = await svc.post(await request({ iat: NOW / 1000 - 601 }));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'TOKEN_TOO_OLD' });
    expect((await svc.post(await request({ iat: NOW / 1000 - 599 }))).status).toBe(200);
  });

  test('rejects an unknown aud, and an aud allowed only for another issuer', async () => {
    const svc = makeService([issuer]);
    const res = await svc.post(await request({ aud: 'some-other-app.apps.example' }));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'WRONG_AUDIENCE' });
    // RECOVERY_AUD is configured for Google only.
    expect((await svc.post(await request({ iss: APPLE, aud: RECOVERY_AUD }))).body.error).toBe('WRONG_AUDIENCE');
  });

  test('rejects a wrong iss, even when correctly signed by a key the service knows', async () => {
    const svc = makeService([issuer]);
    const res = await svc.post(await request({ iss: 'https://evil.example' }));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'WRONG_ISSUER' });
    // Google's other historical form is not what the contract accepts either.
    expect((await svc.post(await request({ iss: 'accounts.google.com' }))).body.error).toBe('WRONG_ISSUER');
  });

  test('rejects an unknown kid, alg none, HS256, and malformed tokens', async () => {
    const svc = makeService([issuer]);
    const stranger = await makeIssuer('kid-unknown');
    expect((await svc.post(await request({}, stranger))).body.error).toBe('UNKNOWN_KID');

    const device = makeDevice();
    const none = await issuer.sign(claims({ nonce: device.nonce }), { alg: 'none' });
    expect((await svc.post({ jwt: none, ...device.proof })).body.error).toBe('UNSUPPORTED_ALG');
    const hs = await issuer.sign(claims({ nonce: device.nonce }), { alg: 'HS256' });
    expect((await svc.post({ jwt: hs, ...device.proof })).body.error).toBe('UNSUPPORTED_ALG');

    expect((await svc.post({ jwt: 'a.b' })).body.error).toBe('BAD_JWT');
    expect((await svc.post({ jwt: '!!.!!.!!' })).body.error).toBe('BAD_JWT');
    expect((await svc.post({})).body.error).toBe('BAD_REQUEST');
    expect((await svc.post('{not json')).body.error).toBe('BAD_JSON');
    expect((await svc.post(await request({ aud: [AUD] }))).body.error).toBe('BAD_PAYLOAD');
    expect((await svc.post(await request({ sub: undefined }))).body.error).toBe('BAD_PAYLOAD');
  });
});

describe('key proof (nonce binding)', () => {
  test('a captured token alone is not enough', async () => {
    const svc = makeService([issuer]);
    const { jwt } = await request();
    expect((await svc.post({ jwt })).body.error).toBe('BAD_KEY_PROOF');
  });

  test('a proof for another device key is refused', async () => {
    const svc = makeService([issuer]);
    const { jwt } = await request();
    const attacker = makeDevice();
    const res = await svc.post({ jwt, ...attacker.proof });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('NONCE_MISMATCH');
  });

  test('the right public key and blinding with a signature from another key is refused', async () => {
    const svc = makeService([issuer]);
    const body = await request();
    const attacker = makeDevice();
    const res = await svc.post({ ...body, signature: attacker.proof.signature });
    expect(res.body.error).toBe('BAD_KEY_PROOF_SIGNATURE');
  });

  test('a token whose nonce is not a lowercase hex felt is refused', async () => {
    const svc = makeService([issuer]);
    expect((await svc.post(await request({ nonce: 'hello' }))).body.error).toBe('BAD_NONCE');
    expect((await svc.post(await request({ nonce: '0xAB' }))).body.error).toBe('BAD_NONCE');
  });

  test('can be switched off, and the nonce format is still checked', async () => {
    const svc = makeService([issuer], { requireKeyProof: false });
    const { jwt } = await request();
    expect((await svc.post({ jwt })).status).toBe(200);
    expect((await svc.post({ jwt: await issuer.sign(claims({ nonce: 'x' })) })).body.error).toBe('BAD_NONCE');
  });
});

describe('rate limiting', () => {
  test('per subject: the bucket empties and other users are unaffected', async () => {
    const svc = makeService([issuer], { limits: { ipBurst: 1000, ipPerMinute: 1000, subjectBurst: 2, subjectPerHour: 1 } });
    expect((await svc.post(await request())).status).toBe(200);
    expect((await svc.post(await request())).status).toBe(200);
    const third = await svc.post(await request());
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: 'RATE_LIMITED' });
    expect((await svc.post(await request({ sub: 'someone-else' }))).status).toBe(200);
  });

  test('per client address, before the token is looked at', async () => {
    const svc = makeService([issuer], { limits: { ipBurst: 1, ipPerMinute: 1, subjectBurst: 1000, subjectPerHour: 1000 } });
    expect((await svc.post({ jwt: 'junk' }, {}, '198.51.100.7')).status).toBe(400);
    expect((await svc.post(await request(), {}, '198.51.100.7')).status).toBe(429);
    expect((await svc.post(await request(), {}, '198.51.100.8')).status).toBe(200);
  });

  test('invalid tokens do not consume the subject bucket of the user they name', async () => {
    const svc = makeService([issuer], { limits: { ipBurst: 1000, ipPerMinute: 1000, subjectBurst: 1, subjectPerHour: 1 } });
    for (let i = 0; i < 3; i++) expect((await svc.post(await request({}, other))).status).toBe(401);
    expect((await svc.post(await request())).status).toBe(200);
  });
});

describe('HTTP surface', () => {
  test('CORS: allowed origin is echoed, other origins are refused', async () => {
    const svc = makeService([issuer]);
    const ok = await svc.post(await request(), { origin: 'https://keychain.example' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://keychain.example');
    const bad = await svc.post(await request(), { origin: 'https://evil.example' });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe('ORIGIN_NOT_ALLOWED');
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('health, 404, 405, 415 and an oversized body', async () => {
    const svc = makeService([issuer]);
    expect((await svc.handle(new Request('http://pepper.test/health'), 'ip')).status).toBe(200);
    expect((await svc.handle(new Request('http://pepper.test/nope'), 'ip')).status).toBe(404);
    expect((await svc.handle(new Request('http://pepper.test/v1/pepper'), 'ip')).status).toBe(405);
    expect((await svc.post(await request(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await svc.post({ jwt: 'x'.repeat(20_000) })).status).toBe(413);
  });
});

describe('logging', () => {
  test('no log line contains a sub, a token, a nonce, a pepper, a device key or the client address', async () => {
    const svc = makeService([issuer]);
    const good = await request();
    const ok = await svc.post(good, {}, '203.0.113.77');
    const bad = await request({ aud: 'unknown-aud' });
    await svc.post(bad, {}, '203.0.113.77');
    await svc.post(await request({}, other), {}, '203.0.113.77');
    await svc.post({ jwt: good.jwt }, {}, '203.0.113.77');

    const text = JSON.stringify(svc.logs);
    expect(svc.logs.length).toBe(4);
    const secrets = [
      SUB, ...good.jwt.split('.'), ...bad.jwt.split('.'), good.public_key, good.blinding, ...good.signature,
      ok.body.pepper!, ok.body.pepper!.slice(2), Buffer.from(svc.key).toString('hex'), '203.0.113.77', 'unknown-aud', AUD,
    ];
    for (const s of secrets) expect(text.includes(s)).toBe(false);

    expect(svc.logs[0]).toMatchObject({ event: 'request', outcome: 'OK', status: 200, issuer: 'google', audience_index: 0, key_version: 1 });
    expect(svc.logs[1]).toMatchObject({ outcome: 'WRONG_AUDIENCE', status: 403 });
    // An unverified token contributes nothing to the log, not even its issuer.
    expect(svc.logs[2]).toMatchObject({ outcome: 'BAD_SIGNATURE', status: 401 });
    expect(svc.logs[2].issuer).toBeUndefined();
  });

  test('an unexpected failure logs the error class only and answers 500 without detail', async () => {
    const svc = makeService([issuer], {
      deriver: { version: 1, derive: async () => { throw new Error(`HSM said no for ${SUB}`); } },
    });
    const res = await svc.post(await request());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'INTERNAL' });
    expect(JSON.stringify(svc.logs).includes(SUB)).toBe(false);
    expect(svc.logs[0]).toMatchObject({ event: 'internal_error', error_class: 'Error' });
  });
});

describe('JWKS cache', () => {
  test('one fetch serves many requests; an unknown kid refetches at most once per interval', async () => {
    const svc = makeService([issuer]);
    for (let i = 0; i < 3; i++) await svc.post(await request());
    expect(svc.fetches()).toBe(1);
    const stranger = await makeIssuer('kid-unknown');
    for (let i = 0; i < 3; i++) await svc.post(await request({}, stranger));
    expect(svc.fetches()).toBe(1); // within minRefetchMs of the first fetch on a fixed clock
  });

  test('a rotated issuer key is picked up; an unreachable issuer with no cached keys gives 503', async () => {
    let t = 0;
    let keys = [issuer.jwk];
    const lookup = cachedJwks(async () => keys, () => t);
    expect(await lookup(GOOGLE, 'kid-1')).toBeDefined();
    const next = await makeIssuer('kid-2');
    keys = [next.jwk];
    expect(await lookup(GOOGLE, 'kid-2')).toBeUndefined(); // too soon to refetch
    t = 61_000;
    expect(await lookup(GOOGLE, 'kid-2')).toBeDefined();

    const down = cachedJwks(async () => { throw new Error('network'); }, () => 0);
    await expect(down(GOOGLE, 'kid-1')).rejects.toEqual(new ApiError(503, 'JWKS_UNAVAILABLE'));
  });
});

describe('configuration', () => {
  const key = randomBytes(32);
  const env = { PEPPER_KEY_HEX: key.toString('hex'), GOOGLE_AUDIENCES: `${AUD}, ${RECOVERY_AUD}` };

  test('parses audiences per issuer and defaults', () => {
    const cfg = loadConfig(env);
    expect(cfg.audiences[GOOGLE]).toEqual([AUD, RECOVERY_AUD]);
    expect(cfg.audiences[APPLE]).toEqual([]);
    expect(cfg.requireKeyProof).toBe(true);
    expect(() => loadConfig({ PEPPER_KEY_HEX: env.PEPPER_KEY_HEX })).toThrow('AUDIENCES');
  });

  test('refuses a missing, short or zero key, and a key that does not match its check value', async () => {
    expect(() => loadDeriver({})).toThrow('PEPPER_KEY_HEX');
    expect(() => loadDeriver({ PEPPER_KEY_HEX: 'abcd' })).toThrow('PEPPER_KEY_HEX');
    expect(() => loadDeriver({ PEPPER_KEY_HEX: '00'.repeat(32) })).toThrow('ZERO_KEY');
    expect(() => loadDeriver({ ...env, PEPPER_KEY_CHECK: '0123456789abcdef' })).toThrow('PEPPER_KEY_CHECK');
    const d = loadDeriver({ ...env, PEPPER_KEY_CHECK: keyCheckValue(key) });
    expect(await d.derive(GOOGLE, SUB)).toBe(await inMemoryDeriver(key, 1).derive(GOOGLE, SUB));
  });
});
