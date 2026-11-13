import { describe, expect, test } from 'bun:test';
import { extractJwt } from './verification';

const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const HEADER = { alg: 'RS256', kid: 'k1' };
const PAYLOAD = { iss: 'https://accounts.google.com', aud: 'a', sub: 's', nonce: '0x1', exp: 2_000_000_000, iat: 1_700_000_000 };
const token = (header: unknown = HEADER, payload: unknown = PAYLOAD) => `${b64(header)}.${b64(payload)}.c2ln`;
const code = (jwt: string) => {
  try {
    extractJwt(jwt);
    return 'ok';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('extractJwt', () => {
  test('reads a well-formed token', () => {
    const t = extractJwt(token());
    expect({ ...t, messageToSign: undefined, signature: undefined }).toEqual({ kid: 'k1', ...PAYLOAD, messageToSign: undefined, signature: undefined });
    expect(new TextDecoder().decode(t.signature)).toBe('sig');
  });

  test('an undecodable part is BAD_JWT, never a JSON error that echoes the token', () => {
    for (const jwt of ['a.b', 'a.b.c.d', 'eyJhbGci.e30.x', `${b64('not json')}.${b64(PAYLOAD)}.x`, token(HEADER, 'nope'), token(null), token(HEADER, null), token(HEADER, 7)]) {
      expect(code(jwt)).toBe('BAD_JWT');
    }
  });

  test('anything but RS256 with a kid is UNSUPPORTED_ALG', () => {
    for (const header of [{ alg: 'none', kid: 'k1' }, { alg: 'HS256', kid: 'k1' }, { alg: 'RS256' }, { alg: 'RS256', kid: '' }, { alg: 'RS256', kid: 7 }]) {
      expect(code(token(header))).toBe('UNSUPPORTED_ALG');
    }
  });

  test('a claim of the wrong type is BAD_PAYLOAD', () => {
    const bad: Record<string, unknown>[] = [
      { aud: ['a', 'b'] }, { aud: '' }, { iss: 7 }, { sub: 123 }, { nonce: 1 },
      { exp: '2000000000' }, { exp: 1.5 }, { exp: 0 }, { iat: -1 }, { iat: Number.MAX_VALUE },
    ];
    for (const change of bad) expect(code(token(HEADER, { ...PAYLOAD, ...change }))).toBe('BAD_PAYLOAD');
    for (const missing of Object.keys(PAYLOAD)) {
      const { [missing]: _, ...rest } = PAYLOAD as Record<string, unknown>;
      expect(code(token(HEADER, rest))).toBe('BAD_PAYLOAD');
    }
  });
});
