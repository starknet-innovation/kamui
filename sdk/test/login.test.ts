// The login flow. No network: a fake provider and a fake recover backend stand in for the
// chain and the API, and the real pepper service runs in process (see the last describe).
import { describe, expect, test } from 'bun:test';
import { ec, hash } from 'starknet';
import {
  accountAddressFromLogin,
  authUrl,
  beginLogin,
  completeLogin,
  decodeIdToken,
  exportPepper,
  fetchPepper,
  keyProof,
  loginNonce,
  newKeyPair,
  newOwnerMessageHash,
  parseLoginRedirect,
  pepperFromFile,
  type LoginAttempt,
  type RecoverRequest,
} from '../src';
import { AUD, GOOGLE, NOW, SUB, makeIssuer, makeService } from '../../services/pepper/test/helpers';

const SEPOLIA = '0x534e5f5345504f4c4941';
const MAINNET = '0x534e5f4d41494e';
const CLASS_HASH = '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc';

/** An unsigned token: enough for the client side, which never checks signatures. */
function fakeToken(claims: Record<string, unknown>): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'k' })}.${b64(claims)}.c2ln`;
}

const baseClaims = (nonce: string) => ({ iss: GOOGLE, aud: AUD, sub: SUB, nonce, iat: 1_800_000_000, exp: 1_800_003_600 });

/** A chain with one optional account: its owners and anchor. */
function fakeChain(state: { deployed: boolean; owners: string[]; anchor: string }) {
  const waited: string[] = [];
  const provider = {
    async getClassHashAt() {
      if (!state.deployed) throw new Error('Contract not found');
      return CLASS_HASH;
    },
    async callContract({ entrypoint, calldata }: { entrypoint: string; calldata?: string[] }) {
      if (entrypoint === 'is_owner') return [state.owners.some((o) => BigInt(o) === BigInt(calldata![0]!)) ? '0x1' : '0x0'];
      if (entrypoint === 'get_owners_anchor') return [state.anchor];
      throw new Error(`unexpected call ${entrypoint}`);
    },
    async waitForTransaction(txHash: string) {
      waited.push(txHash);
      return {};
    },
  };
  return { provider: provider as any, waited, state };
}

/** A backend that "recovers": deploys the account and adds the new key. */
function fakeBackend(chain: ReturnType<typeof fakeChain>) {
  const requests: RecoverRequest[] = [];
  return {
    requests,
    backend: {
      async recover(request: RecoverRequest) {
        requests.push(request);
        chain.state.deployed = true;
        chain.state.owners.push(request.newPubkey);
        chain.state.anchor = '0x999';
        return { transaction_hash: '0xabc' };
      },
    },
  };
}

function signedIn(pepper = '0x1234') {
  const device = newKeyPair();
  const attempt = beginLogin('google', device.publicKey);
  const idToken = fakeToken(baseClaims(attempt.nonce));
  const account = accountAddressFromLogin(CLASS_HASH, { iss: GOOGLE, aud: AUD, sub: SUB }, pepper);
  return { device, attempt, idToken, account, pepper: { pepper, keyVersion: 1 } };
}

describe('starting a login', () => {
  test('the nonce is poseidon(device key, blinding), in lowercase hex', () => {
    const device = newKeyPair();
    const attempt = beginLogin('google', device.publicKey);
    expect(attempt.nonce).toBe(loginNonce(device.publicKey, attempt.blinding));
    expect(BigInt(attempt.nonce)).toBe(BigInt(hash.computePoseidonHashOnElements([device.publicKey, attempt.blinding])));
    expect(attempt.nonce).toMatch(/^0x[0-9a-f]+$/);
    // Fresh randomness every time.
    expect(beginLogin('google', device.publicKey).blinding).not.toBe(attempt.blinding);
    expect(beginLogin('google', device.publicKey).state).not.toBe(attempt.state);
  });

  test('the auth URL carries the nonce and state', () => {
    const attempt = beginLogin('google', newKeyPair().publicKey);
    const google = new URL(authUrl(attempt, 'client-1', 'https://keychain.example/callback'));
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(google.searchParams)).toMatchObject({
      client_id: 'client-1', redirect_uri: 'https://keychain.example/callback',
      nonce: attempt.nonce, state: attempt.state, response_type: 'id_token', scope: 'openid',
    });
    const apple = new URL(authUrl({ ...attempt, provider: 'apple' }, 'svc', 'https://keychain.example/callback'));
    expect(apple.hostname).toBe('appleid.apple.com');
    expect(apple.searchParams.get('response_mode')).toBe('fragment');
  });
});

describe('reading the redirect', () => {
  const device = newKeyPair();
  const attempt = beginLogin('google', device.publicKey);
  const token = fakeToken(baseClaims(attempt.nonce));

  test('returns the token and its claims', () => {
    const parsed = parseLoginRedirect(`#id_token=${token}&state=${attempt.state}`, attempt);
    expect(parsed?.idToken).toBe(token);
    expect(parsed?.claims).toMatchObject({ iss: GOOGLE, aud: AUD, sub: SUB, nonce: attempt.nonce });
  });

  test('ignores a fragment that is not a login answer', () => {
    expect(parseLoginRedirect('', attempt)).toBeNull();
    expect(parseLoginRedirect('#section-2', attempt)).toBeNull();
  });

  test('refuses an issuer error, a wrong state and a token for another nonce', () => {
    expect(() => parseLoginRedirect('#error=access_denied', attempt)).toThrow(/access_denied/);
    expect(() => parseLoginRedirect(`#id_token=${token}&state=other`, attempt)).toThrow(/state/);
    const other = fakeToken(baseClaims('0x1'));
    expect(() => parseLoginRedirect(`#id_token=${other}&state=${attempt.state}`, attempt)).toThrow(/another nonce/);
  });

  test('refuses tokens it cannot read', () => {
    expect(() => decodeIdToken('nope')).toThrow(/not a JWT/);
    expect(() => decodeIdToken('a.!!!.c')).toThrow(/cannot be read/);
    expect(() => decodeIdToken(fakeToken({ iss: GOOGLE, aud: AUD, nonce: '0x1', iat: 1, exp: 2 }))).toThrow(/no sub/);
    expect(() => decodeIdToken(fakeToken({ ...baseClaims('0x1'), exp: 'soon' }))).toThrow(/no exp/);
  });
});

describe('completing a login', () => {
  test('first login: the backend is asked, with a signature over anchor 0', async () => {
    const { device, attempt, idToken, account, pepper } = signedIn();
    const chain = fakeChain({ deployed: false, owners: [], anchor: '0x0' });
    const { backend, requests } = fakeBackend(chain);

    const result = await completeLogin({ provider: chain.provider, backend, chainId: SEPOLIA, classHash: CLASS_HASH, idToken, attempt, device, pepper });

    expect(result).toMatchObject({ account, status: 'added', existed: false, transactionHash: '0xabc', pepper: '0x1234', keyVersion: 1 });
    expect(chain.waited).toEqual(['0xabc']);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request).toMatchObject({ jwt: idToken, account, newPubkey: device.publicKey, blinding: attempt.blinding, pepper: '0x1234', override: false });
    const signature = new ec.starkCurve.Signature(BigInt(request.signature[0]), BigInt(request.signature[1]));
    expect(ec.starkCurve.verify(signature, newOwnerMessageHash(account, '0x0'), ec.starkCurve.getPublicKey(device.privateKey))).toBe(true);
  });

  test('new device on an existing account: the signature is over the current anchor', async () => {
    const { device, attempt, idToken, account, pepper } = signedIn();
    const chain = fakeChain({ deployed: true, owners: ['0x111'], anchor: '0x777' });
    const { backend, requests } = fakeBackend(chain);

    const result = await completeLogin({ provider: chain.provider, backend, chainId: SEPOLIA, classHash: CLASS_HASH, idToken, attempt, device, pepper });

    expect(result).toMatchObject({ status: 'added', existed: true });
    const [r, s] = requests[0]!.signature;
    const signature = new ec.starkCurve.Signature(BigInt(r), BigInt(s));
    const publicKey = ec.starkCurve.getPublicKey(device.privateKey);
    expect(ec.starkCurve.verify(signature, newOwnerMessageHash(account, '0x777'), publicKey)).toBe(true);
    expect(ec.starkCurve.verify(signature, newOwnerMessageHash(account, '0x0'), publicKey)).toBe(false);
  });

  test('returning device: nothing is sent', async () => {
    const { device, attempt, idToken, pepper } = signedIn();
    const chain = fakeChain({ deployed: true, owners: [device.publicKey], anchor: '0x777' });
    const { backend, requests } = fakeBackend(chain);

    const result = await completeLogin({ provider: chain.provider, backend, chainId: SEPOLIA, classHash: CLASS_HASH, idToken, attempt, device, pepper });

    expect(result).toMatchObject({ status: 'already-owner', existed: true });
    expect(result.transactionHash).toBeUndefined();
    expect(requests).toHaveLength(0);
    expect(chain.waited).toHaveLength(0);
  });

  test('a different pepper is a different account', async () => {
    const a = signedIn('0x1234');
    const b = signedIn('0x1235');
    expect(a.account).not.toBe(b.account);
  });

  test('refuses pepper 0 on mainnet, and allows it on a testnet', async () => {
    const { device, attempt, idToken } = signedIn();
    const chain = fakeChain({ deployed: false, owners: [], anchor: '0x0' });
    const { backend } = fakeBackend(chain);
    const args = { provider: chain.provider, backend, classHash: CLASS_HASH, idToken, attempt, device, pepper: { pepper: '0x0', keyVersion: 1 } };
    await expect(completeLogin({ ...args, chainId: MAINNET })).rejects.toThrow(/mainnet/);
    await expect(completeLogin({ ...args, chainId: SEPOLIA })).resolves.toMatchObject({ status: 'added' });
  });

  test('refuses a token for another attempt and a device key that did not start it', async () => {
    const { device, attempt, idToken, pepper } = signedIn();
    const chain = fakeChain({ deployed: false, owners: [], anchor: '0x0' });
    const { backend, requests } = fakeBackend(chain);
    const args = { provider: chain.provider, backend, chainId: SEPOLIA, classHash: CLASS_HASH, idToken, attempt, device, pepper };
    await expect(completeLogin({ ...args, idToken: fakeToken(baseClaims('0x1')) })).rejects.toThrow(/another nonce/);
    await expect(completeLogin({ ...args, device: newKeyPair() })).rejects.toThrow(/not the one/);
    expect(requests).toHaveLength(0);
  });

  test('fails loudly if the recovery lands but the key is not an owner', async () => {
    const { device, attempt, idToken, pepper } = signedIn();
    const chain = fakeChain({ deployed: false, owners: [], anchor: '0x0' });
    const backend = { recover: async () => ({ transaction_hash: '0xdead' }) };
    await expect(
      completeLogin({ provider: chain.provider, backend, chainId: SEPOLIA, classHash: CLASS_HASH, idToken, attempt, device, pepper }),
    ).rejects.toThrow(/not an owner/);
  });
});

describe('pepper from a recovery file', () => {
  const claims = { iss: GOOGLE, aud: AUD, sub: SUB };
  const file = exportPepper({ chainId: SEPOLIA, classHash: CLASS_HASH, claims, pepper: '0x1234', keyVersion: 3 });

  test('is used when the file belongs to this login', () => {
    expect(pepperFromFile(file, claims, SEPOLIA)).toEqual({ pepper: '0x1234', keyVersion: 3 });
  });

  test('is refused for another user or network', () => {
    expect(() => pepperFromFile(file, { ...claims, sub: 'someone-else' }, SEPOLIA)).toThrow(/another user/);
    expect(() => pepperFromFile(file, claims, MAINNET)).toThrow(/another user/);
  });
});

// The real pepper service, in process, with its own test issuer. This is the check that the
// SDK's key proof is the one the service accepts.
describe('against the pepper service', async () => {
  const issuer = await makeIssuer('kid-1');
  const service = makeService([issuer]);
  const viaService = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
    service.handle(new Request(url, init), '203.0.113.9');

  async function login(overrides: Record<string, unknown> = {}) {
    const device = newKeyPair();
    const attempt: LoginAttempt = beginLogin('google', device.publicKey);
    const idToken = await issuer.sign({ iss: GOOGLE, aud: AUD, sub: SUB, nonce: attempt.nonce, iat: NOW / 1000 - 10, exp: NOW / 1000 + 3600, ...overrides });
    return { device, attempt, idToken };
  }

  test('the service accepts the SDK key proof and returns a pepper', async () => {
    const { device, attempt, idToken } = await login();
    const pepper = await fetchPepper({ serviceUrl: 'http://pepper.test/', idToken, attempt, device, fetch: viaService });
    expect(pepper.keyVersion).toBe(1);
    expect(BigInt(pepper.pepper)).toBeGreaterThan(0n);
    expect(BigInt(pepper.pepper)).toBeLessThan(1n << 250n);
  });

  test('the same user gets the same pepper from another device', async () => {
    const first = await login();
    const second = await login();
    const a = await fetchPepper({ serviceUrl: 'http://pepper.test', idToken: first.idToken, attempt: first.attempt, device: first.device, fetch: viaService });
    const b = await fetchPepper({ serviceUrl: 'http://pepper.test', idToken: second.idToken, attempt: second.attempt, device: second.device, fetch: viaService });
    expect(a.pepper).toBe(b.pepper);
  });

  test('a token without its device key gets nothing', async () => {
    const { attempt, idToken } = await login();
    // Someone who captured the token and even the blinding, but holds another key.
    const thief = newKeyPair();
    expect(() => keyProof(attempt, thief)).toThrow(/not the one/);
    const forged = { public_key: thief.publicKey, blinding: attempt.blinding, signature: ['0x1', '0x2'] };
    const response = await service.post({ jwt: idToken, ...forged });
    expect(response.status).toBe(401);
    expect(response.body.pepper).toBeUndefined();
  });

  test('service errors surface with their code, never as pepper 0', async () => {
    const { device, attempt, idToken } = await login({ aud: 'some-other-app' });
    await expect(fetchPepper({ serviceUrl: 'http://pepper.test', idToken, attempt, device, fetch: viaService })).rejects.toThrow(/pepper service:/);
  });
});
