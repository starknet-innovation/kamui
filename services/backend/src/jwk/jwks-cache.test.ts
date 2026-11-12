// Kamui: audit finding #3. The issuer's keys are cached, fetched with a deadline, and one
// request cannot cause one fetch.
import { describe, expect, test } from 'bun:test';
import { HttpError } from '../http';
import { TEST_JWK } from '../test-fixtures';
import { JwksCache } from './verification';

const GOOGLE = 'https://accounts.google.com';
const ROTATED = { ...TEST_JWK, kid: 'rotated-kid' };

function issuer(keys = [TEST_JWK]) {
  const state = { fetches: 0, keys, down: false, hang: false };
  const send = async () => {
    state.fetches += 1;
    if (state.hang) return new Promise<Response>(() => {});
    if (state.down) throw new Error('connect ECONNREFUSED');
    return Response.json({ keys: state.keys });
  };
  return { state, send };
}
const status = (p: Promise<unknown>) => p.then(() => 'ok', (e: HttpError) => `${e.status} ${e.message}`);

describe('issuer key cache', () => {
  test('many requests, one fetch; concurrent misses share it', async () => {
    const { state, send } = issuer();
    const cache = new JwksCache({ send });
    const answers = await Promise.all(Array.from({ length: 20 }, () => cache.keys(GOOGLE, TEST_JWK.kid)));
    for (let i = 0; i < 20; i++) await cache.keys(GOOGLE, TEST_JWK.kid);
    expect(state.fetches).toBe(1);
    expect(answers[0]).toEqual([TEST_JWK]);
  });

  test('made-up kids cost at most one refresh per minute', async () => {
    let now = 0;
    const { state, send } = issuer();
    const cache = new JwksCache({ send, now: () => now });
    await cache.keys(GOOGLE, TEST_JWK.kid);
    now += 61_000;
    for (let i = 0; i < 50; i++) await cache.keys(GOOGLE, `made-up-${i}`);
    expect(state.fetches).toBe(2);
    now += 30_000;
    for (let i = 0; i < 50; i++) await cache.keys(GOOGLE, `other-${i}`);
    expect(state.fetches).toBe(2);
  });

  test('a rotated key is picked up: at once after a minute for a token that names it, and for everyone after five', async () => {
    let now = 0;
    const { state, send } = issuer();
    const cache = new JwksCache({ send, now: () => now });
    await cache.keys(GOOGLE, TEST_JWK.kid);
    state.keys = [TEST_JWK, ROTATED];
    now += 60_000;
    expect((await cache.keys(GOOGLE, ROTATED.kid)).map((k) => k.kid)).toContain(ROTATED.kid);
    expect(state.fetches).toBe(2);

    state.keys = [ROTATED];
    now += 5 * 60_000;
    expect((await cache.keys(GOOGLE)).map((k) => k.kid)).toEqual([ROTATED.kid]);
    expect(state.fetches).toBe(3);
  });

  test('an issuer that is down is a 502, and is not asked again for every request', async () => {
    let now = 0;
    const { state, send } = issuer();
    state.down = true;
    const cache = new JwksCache({ send, now: () => now });
    for (let i = 0; i < 10; i++) expect(await status(cache.keys(GOOGLE, 'k'))).toBe('502 JWKS_UNAVAILABLE');
    expect(state.fetches).toBe(1);
    now += 10_000;
    state.down = false;
    expect(await status(cache.keys(GOOGLE, 'k'))).toBe('ok');
    expect(state.fetches).toBe(2);
  });

  test('an issuer that never answers fails at the deadline', async () => {
    const { state, send } = issuer();
    state.hang = true;
    const cache = new JwksCache({ send, timeoutMs: 30 });
    const started = Date.now();
    const results = await Promise.all([status(cache.keys(GOOGLE, 'k')), status(cache.keys(GOOGLE, 'k'))]);
    expect(results).toEqual(['502 JWKS_UNAVAILABLE', '502 JWKS_UNAVAILABLE']);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(state.fetches).toBe(1);
  });

  test('expired keys are not used when the issuer is down; unexpired ones still are', async () => {
    let now = 0;
    const { state, send } = issuer();
    const cache = new JwksCache({ send, now: () => now });
    await cache.keys(GOOGLE, TEST_JWK.kid);
    state.down = true;
    now += 61_000;
    expect(await cache.keys(GOOGLE, 'unknown-kid')).toEqual([TEST_JWK]);
    now += 5 * 60_000;
    expect(await status(cache.keys(GOOGLE, TEST_JWK.kid))).toBe('502 JWKS_UNAVAILABLE');
  });

  test('an issuer that is not Google or Apple is refused without a fetch', async () => {
    const { state, send } = issuer();
    expect(await status(new JwksCache({ send }).keys('https://evil.example', 'k'))).toBe('400 WRONG_ISSUER');
    expect(state.fetches).toBe(0);
  });
});
