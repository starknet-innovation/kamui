// Pepper confirmation, with the three real parts in process: the SDK builds the key proof, this
// backend forwards it, and the pepper service answers. Only the issuer is a test one.
import { describe, expect, test } from 'bun:test';
import { beginLogin, fetchPepper, keyProof, newKeyPair } from '../../../../../sdk/src';
import { AUD, GOOGLE, NOW, SUB, makeIssuer, makeService } from '../../../../pepper/test/helpers';
import { HttpError } from '../../http';
import { confirmPepper, pepperSettings } from './pepper';

const URL = 'http://pepper.test';
const issuer = await makeIssuer('kid-1');
const service = makeService([issuer]);
const viaService = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  service.handle(new Request(url, init), '203.0.113.7');

async function login() {
  const device = newKeyPair();
  const attempt = beginLogin('google', device.publicKey);
  const jwt = await issuer.sign({ iss: GOOGLE, aud: AUD, sub: SUB, nonce: attempt.nonce, iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600 });
  const { pepper } = await fetchPepper({ serviceUrl: URL, idToken: jwt, attempt, device, fetch: viaService });
  return { jwt, newPubkey: device.publicKey, blinding: attempt.blinding, pepper, keyProof: keyProof(attempt, device).signature as string[] };
}

const withService = { serviceUrl: URL, mainnet: false };
const code = (promise: Promise<void>) => promise.then(() => 'accepted', (e: HttpError) => `${e.status} ${e.message}`);

describe('pepper confirmation', () => {
  test('accepts the pepper the service derives for the token', async () => {
    expect(await code(confirmPepper(await login(), withService, viaService))).toBe('accepted');
  });

  test('refuses a made-up pepper, without echoing either value', async () => {
    const request = await login();
    const result = await code(confirmPepper({ ...request, pepper: '0x1234' }, withService, viaService));
    expect(result).toBe('400 WRONG_PEPPER');
    expect(result).not.toContain(request.pepper);
  });

  test('refuses pepper 0 when a service is configured', async () => {
    expect(await code(confirmPepper({ ...(await login()), pepper: '0x0' }, withService, viaService))).toBe('400 WRONG_PEPPER');
  });

  test('requires the key proof', async () => {
    const { keyProof: _, ...request } = await login();
    expect(await code(confirmPepper(request, withService, viaService))).toBe('400 KEY_PROOF_REQUIRED');
    expect(await code(confirmPepper({ ...request, keyProof: ['0x1'] }, withService, viaService))).toBe('400 KEY_PROOF_REQUIRED');
  });

  test("passes the service's refusal through", async () => {
    const request = await login();
    // A key proof by another key: the service refuses, the backend reports its code.
    const other = await login();
    const result = await code(confirmPepper({ ...request, keyProof: other.keyProof }, withService, viaService));
    expect(result).toMatch(/^400 PEPPER_SERVICE: /);
  });

  test('a service that is down or broken is a 502, not an acceptance', async () => {
    const request = await login();
    const down = async () => { throw new Error('connect ECONNREFUSED'); };
    expect(await code(confirmPepper(request, withService, down))).toBe('502 PEPPER_SERVICE_UNAVAILABLE');
    const broken = async () => new Response('oops', { status: 500 });
    expect(await code(confirmPepper(request, withService, broken))).toBe('502 PEPPER_SERVICE_UNAVAILABLE');
    const nonsense = async () => Response.json({ pepper: 'not-hex' });
    expect(await code(confirmPepper(request, withService, nonsense))).toBe('502 PEPPER_SERVICE_UNAVAILABLE');
  });

  test('rejects a malformed pepper before asking anyone', async () => {
    const request = await login();
    let asked = false;
    const spy = async () => { asked = true; return Response.json({}); };
    expect(await code(confirmPepper({ ...request, pepper: 'zero' }, withService, spy))).toBe('400 BAD_PEPPER');
    expect(asked).toBe(false);
  });
});

describe('pepper settings', () => {
  test('mainnet needs a pepper service and never accepts pepper 0', async () => {
    expect(() => pepperSettings('SN_MAIN', undefined)).toThrow(/required on mainnet/);
    const mainnet = pepperSettings('SN_MAIN', URL);
    expect(mainnet).toEqual({ serviceUrl: URL, mainnet: true });
    expect(await code(confirmPepper({ ...(await login()), pepper: '0x0' }, mainnet, viaService))).toBe('400 PEPPER_REQUIRED');
  });

  test('a testnet without a service accepts any pepper, including 0', async () => {
    const testnet = pepperSettings('SN_SEPOLIA', '');
    expect(testnet).toEqual({ serviceUrl: undefined, mainnet: false });
    const request = { jwt: 'x', newPubkey: '0x1', blinding: '0x2', pepper: '0x0' };
    expect(await code(confirmPepper(request, testnet))).toBe('accepted');
  });
});
