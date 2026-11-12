// The session registry client: the signed message, the three calls, and how an untrusted
// listing is read. No network.
import { describe, expect, test } from 'bun:test';
import { ec, hash, num, shortString, uint256 } from 'starknet';
import {
  REGISTRY_MAX_ENTRIES,
  keyPairFromPrivateKey,
  parseRegistryList,
  registryClient,
  registryContentHash,
  registryMessageHash,
  signRegistryRequest,
  type RegistrySession,
} from '../src';

const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const SEPOLIA = '0x534e5f5345504f4c4941';
const MAINNET = '0x534e5f4d41494e';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const SESSION_KEY = '0x5f513650a95ebc650404cfb1da39de4eba808aab4273f0c9a0d6d3bb09d3966';
const OWNER = keyPairFromPrivateKey('0x1234567890abcdef');
const NOW = 1_800_000_000;
const NONCE = '0x5eed';

const session: RegistrySession = {
  publicKey: SESSION_KEY,
  origin: 'https://game.example',
  appName: 'Example Game',
  validUntil: NOW + 3600,
  maxCalls: 20,
  maxFeePerTx: '0x0',
  calls: [{ to: GAME, entrypoint: 'move' }, { to: TOKEN, entrypoint: 'transfer' }],
  limits: [{ token: TOKEN, maxPerCall: '0x64', maxPerWindow: '0x96', windowSeconds: 3600 }],
};

/** Whether `[r, s]` is the owner's signature over `messageHash`. */
function signedByOwner(messageHash: string, [r, s]: [string, string]): boolean {
  const signature = new ec.starkCurve.Signature(BigInt(r), BigInt(s));
  const digest = BigInt(messageHash).toString(16).padStart(64, '0');
  return ec.starkCurve.verify(signature, digest, ec.starkCurve.getPublicKey(OWNER.privateKey, false));
}

/** A registry that records what it is sent and answers with `answer`. */
function fakeServer(answer: (path: string, body: any) => { status?: number; body: unknown }) {
  const requests: { url: string; method: string; headers: Record<string, string>; body: any }[] = [];
  const send = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body);
    requests.push({ url, method: init.method, headers: init.headers, body });
    const result = answer(new URL(url).pathname, body);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
  };
  return { requests, send };
}

const client = (send: ReturnType<typeof fakeServer>['send']) =>
  registryClient({ apiUrl: 'https://keychain.example/api/', chainId: SEPOLIA, account: ACCOUNT, ownerPrivateKey: OWNER.privateKey, fetch: send, now: () => NOW, nonce: () => NONCE });

describe('the signed message', () => {
  const put = { chainId: SEPOLIA, account: ACCOUNT, action: 'put' as const, timestamp: NOW, nonce: NONCE, subject: SESSION_KEY, session };

  test('is the poseidon hash the protocol describes', () => {
    const expected = hash.computePoseidonHashOnElements([
      shortString.encodeShortString('kamui.registry.v2'),
      SEPOLIA,
      ACCOUNT,
      shortString.encodeShortString('put'),
      '0x6b49d200', // 1800000000
      NONCE,
      SESSION_KEY,
      registryContentHash(session),
    ]);
    expect(registryMessageHash(put)).toBe(expected);
  });

  test('the content hash is built as the protocol describes', () => {
    const keccak = (value: string) => num.toHex(hash.starknetKeccak(value));
    const expected = hash.computePoseidonHashOnElements([
      keccak(session.origin),
      keccak(session.appName!),
      num.toHex(session.validUntil),
      num.toHex(session.maxCalls),
      session.maxFeePerTx,
      num.toHex(session.calls.length),
      ...session.calls.flatMap((call) => [call.to, hash.getSelectorFromName(call.entrypoint)]),
      num.toHex(session.limits.length),
      ...session.limits.flatMap((limit) => {
        const perCall = uint256.bnToUint256(limit.maxPerCall);
        const perWindow = uint256.bnToUint256(limit.maxPerWindow);
        return [limit.token, num.toHex(perCall.low), num.toHex(perCall.high), num.toHex(perWindow.low), num.toHex(perWindow.high), num.toHex(limit.windowSeconds)];
      }),
    ]);
    expect(registryContentHash(session)).toBe(expected);
  });

  test('every field of the record changes the content hash', () => {
    const { appName, ...unnamed } = session;
    const call = session.calls[0]!;
    const limit = session.limits[0]!;
    const withLimit = { ...session, limits: [limit] };
    const variants = [
      withLimit,
      { ...withLimit, origin: 'https://other.example' },
      { ...withLimit, appName: 'Other' },
      { ...unnamed, limits: [limit] },
      { ...withLimit, validUntil: session.validUntil + 1 },
      { ...withLimit, maxCalls: session.maxCalls + 1 },
      { ...withLimit, maxFeePerTx: '0x77' },
      { ...withLimit, calls: [] },
      { ...withLimit, calls: [{ ...call, to: '0x999' }, ...session.calls.slice(1)] },
      { ...withLimit, calls: [{ ...call, entrypoint: 'another_entry' }, ...session.calls.slice(1)] },
      { ...withLimit, calls: [...session.calls, call] },
      { ...withLimit, limits: [] },
      { ...withLimit, limits: [{ ...limit, token: '0x998' }] },
      { ...withLimit, limits: [{ ...limit, maxPerCall: '0x11' }] },
      { ...withLimit, limits: [{ ...limit, maxPerWindow: '0x101' }] },
      { ...withLimit, limits: [{ ...limit, windowSeconds: limit.windowSeconds + 1 }] },
      // An amount above 128 bits: the high half counts too.
      { ...withLimit, limits: [{ ...limit, maxPerCall: '0x1' + '0'.repeat(32) }] },
    ];
    const hashes = variants.map(registryContentHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test('a listing signs 0 as its subject and content, whatever is passed', () => {
    const expected = hash.computePoseidonHashOnElements([shortString.encodeShortString('kamui.registry.v2'), SEPOLIA, ACCOUNT, shortString.encodeShortString('list'), '0x6b49d200', NONCE, '0x0', '0x0']);
    expect(registryMessageHash({ chainId: SEPOLIA, account: ACCOUNT, action: 'list', timestamp: NOW, nonce: NONCE })).toBe(expected);
    expect(registryMessageHash({ chainId: SEPOLIA, account: ACCOUNT, action: 'list', timestamp: NOW, nonce: NONCE, subject: SESSION_KEY, session })).toBe(expected);
  });

  test('the action, the chain, the account, the time, the nonce, the session and its content each change it', () => {
    const hashes = [
      registryMessageHash(put),
      registryMessageHash({ ...put, action: 'remove' }),
      registryMessageHash({ ...put, chainId: MAINNET }),
      registryMessageHash({ ...put, account: '0x1' }),
      registryMessageHash({ ...put, timestamp: NOW + 1 }),
      registryMessageHash({ ...put, nonce: '0x2' }),
      registryMessageHash({ ...put, subject: '0x2', session: { ...session, publicKey: '0x2' } }),
      registryMessageHash({ ...put, session: { ...session, origin: 'https://evil.example' } }),
    ];
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  test('put and remove need a session key, put needs the record, and the timestamp must be whole seconds', () => {
    const base = { chainId: SEPOLIA, account: ACCOUNT, timestamp: NOW, nonce: NONCE };
    expect(() => registryMessageHash({ ...base, action: 'put' })).toThrow(/needs a session key/);
    expect(() => registryMessageHash({ ...base, action: 'remove' })).toThrow(/needs a session key/);
    expect(() => registryMessageHash({ ...base, action: 'put', subject: SESSION_KEY })).toThrow(/needs the session/);
    expect(() => registryMessageHash({ ...base, action: 'put', subject: '0x2', session })).toThrow(/not the one named/);
    expect(() => registryMessageHash({ ...base, action: 'list', timestamp: Date.now() / 1000 + 0.5 })).toThrow(/bad timestamp/);
  });

  test('the signature is two felts and verifies against the owner key', () => {
    const args = { chainId: SEPOLIA, account: ACCOUNT, action: 'remove' as const, timestamp: NOW, nonce: NONCE, subject: SESSION_KEY };
    const signature = signRegistryRequest({ ...args, ownerPrivateKey: OWNER.privateKey });
    expect(signature).toHaveLength(2);
    for (const part of signature) expect(part).toMatch(/^0x[0-9a-f]+$/);
    expect(signedByOwner(registryMessageHash(args), signature)).toBe(true);
    expect(signedByOwner(registryMessageHash({ ...args, action: 'list' }), signature)).toBe(false);
  });
});

describe('the three calls', () => {
  test('put posts the session with a signature over its key', async () => {
    const server = fakeServer(() => ({ body: { ok: true } }));
    await client(server.send).put(session);
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request!.url).toBe('https://keychain.example/api/registry/sessions');
    expect(request!.method).toBe('POST');
    expect(request!.headers['content-type']).toBe('application/json');
    expect(request!.body).toEqual({ account: ACCOUNT, timestamp: NOW, nonce: NONCE, signature: request!.body.signature, session });
    expect(signedByOwner(registryMessageHash({ chainId: SEPOLIA, account: ACCOUNT, action: 'put', timestamp: NOW, nonce: NONCE, subject: SESSION_KEY, session }), request!.body.signature)).toBe(true);
  });

  test('put leaves out an app name that was not given, and sends nothing the protocol does not name', async () => {
    const server = fakeServer(() => ({ body: { ok: true } }));
    const { appName, ...unnamed } = session;
    await client(server.send).put({ ...unnamed, extra: 'x' } as RegistrySession);
    expect(server.requests[0]!.body.session).toEqual(unnamed);
  });

  test('list posts a signature over subject 0 and returns the sessions', async () => {
    const entry = { ...session, createdAt: NOW - 10 };
    const server = fakeServer(() => ({ body: { sessions: [entry] } }));
    expect(await client(server.send).list()).toEqual([entry]);
    const [request] = server.requests;
    expect(request!.url).toBe('https://keychain.example/api/registry/sessions/list');
    expect(request!.body).toEqual({ account: ACCOUNT, timestamp: NOW, nonce: NONCE, signature: request!.body.signature });
    expect(signedByOwner(registryMessageHash({ chainId: SEPOLIA, account: ACCOUNT, action: 'list', timestamp: NOW, nonce: NONCE }), request!.body.signature)).toBe(true);
  });

  test('remove posts the session key with a signature over it', async () => {
    const server = fakeServer(() => ({ body: { ok: true } }));
    await client(server.send).remove(SESSION_KEY);
    const [request] = server.requests;
    expect(request!.url).toBe('https://keychain.example/api/registry/sessions/remove');
    expect(request!.body).toEqual({ account: ACCOUNT, timestamp: NOW, nonce: NONCE, signature: request!.body.signature, publicKey: SESSION_KEY });
    expect(signedByOwner(registryMessageHash({ chainId: SEPOLIA, account: ACCOUNT, action: 'remove', timestamp: NOW, nonce: NONCE, subject: SESSION_KEY }), request!.body.signature)).toBe(true);
  });

  test('an error answer is reported with the server\'s reason, or the status', async () => {
    const refused = fakeServer(() => ({ status: 401, body: { error: 'bad signature' } }));
    await expect(client(refused.send).list()).rejects.toThrow('registry: bad signature');
    const broken = fakeServer(() => ({ status: 502, body: 'gateway' }));
    await expect(client(broken.send).put(session)).rejects.toThrow('registry: 502');
    await expect(client(broken.send).remove(SESSION_KEY)).rejects.toThrow('registry: 502');
  });

  test('the server\'s refusals of a put are passed on by name, and too many limits are not sent', async () => {
    const expired = fakeServer(() => ({ status: 400, body: { error: 'SESSION_EXPIRED' } }));
    await expect(client(expired.send).put(session)).rejects.toThrow('registry: SESSION_EXPIRED');
    const full = fakeServer(() => ({ status: 409, body: { error: 'REGISTRY_FULL' } }));
    await expect(client(full.send).put(session)).rejects.toThrow('registry: REGISTRY_FULL');

    const server = fakeServer(() => ({ body: { ok: true } }));
    const limits = Array.from({ length: 33 }, (_, i) => ({ token: `0x${(i + 1).toString(16)}`, maxPerCall: '0x1', maxPerWindow: '0x1', windowSeconds: 60 }));
    await expect(client(server.send).put({ ...session, limits })).rejects.toThrow('more than 32 spending limits');
    expect(server.requests).toHaveLength(0);
    await client(server.send).put({ ...session, limits: limits.slice(0, 32) });
    expect(server.requests).toHaveLength(1);
  });

  test('a listing is read whatever the formatting of its keys', async () => {
    // The server answers keys as lower-case hex without leading zeros.
    const short = { ...session, publicKey: '0x00ABC', createdAt: NOW };
    const server = fakeServer(() => ({ body: { sessions: [short, { ...short, publicKey: '0xabc' }] } }));
    expect(await client(server.send).list()).toEqual([short]);
  });

  test('the timestamp is this machine\'s clock by default', async () => {
    const server = fakeServer(() => ({ body: { sessions: [] } }));
    await registryClient({ apiUrl: 'https://keychain.example/api', chainId: SEPOLIA, account: ACCOUNT, ownerPrivateKey: OWNER.privateKey, fetch: server.send }).list();
    expect(Math.abs(server.requests[0]!.body.timestamp - Date.now() / 1000)).toBeLessThan(5);
    expect(Number.isInteger(server.requests[0]!.body.timestamp)).toBe(true);
  });
});

describe('reading an untrusted listing', () => {
  const entry = { ...session, createdAt: NOW };

  test('an answer that is not a listing is refused', () => {
    for (const body of [null, 'x', {}, { sessions: 'x' }, { ok: true }]) {
      expect(() => parseRegistryList(body)).toThrow(/not a list of sessions/);
    }
  });

  test('entries that are not shaped as the protocol says are dropped, the others kept', () => {
    const bad = [
      null,
      'text',
      { ...entry, publicKey: 'not-hex' },
      { ...entry, publicKey: `0x${'f'.repeat(65)}` },
      { ...entry, validUntil: '1800003600' },
      { ...entry, maxCalls: 0 },
      { ...entry, maxFeePerTx: 5 },
      { ...entry, createdAt: 'yesterday' },
      { ...entry, origin: '' },
      { ...entry, origin: 'x'.repeat(201) },
      { ...entry, origin: { toString: () => 'https://game.example' } },
      { ...entry, appName: 'x'.repeat(61) },
      { ...entry, appName: ['x'] },
      { ...entry, calls: 'move' },
      { ...entry, calls: [{ to: GAME, entrypoint: 'move()<script>' }] },
      { ...entry, calls: [{ to: 'game', entrypoint: 'move' }] },
      { ...entry, calls: Array.from({ length: 65 }, () => ({ to: GAME, entrypoint: 'move' })) },
      { ...entry, limits: [{ token: TOKEN, maxPerCall: 100, maxPerWindow: '0x96', windowSeconds: 3600 }] },
      { ...entry, limits: [{ token: TOKEN, maxPerCall: '0x64', maxPerWindow: '0x96', windowSeconds: 0 }] },
      { ...entry, limits: Array.from({ length: 33 }, () => ({ token: TOKEN, maxPerCall: '0x64', maxPerWindow: '0x96', windowSeconds: 60 })) },
    ];
    const good = { ...entry, publicKey: '0x777' };
    expect(parseRegistryList({ sessions: [...bad, good] })).toEqual([good]);
  });

  test('text fields are kept as they are, to be shown as text', () => {
    const markup = { ...entry, origin: '<img src=x onerror=alert(1)>', appName: '<script>alert(1)</script>' };
    expect(parseRegistryList({ sessions: [markup] })).toEqual([markup]);
  });

  test('fields the protocol does not name are not passed on', () => {
    const [parsed] = parseRegistryList({ sessions: [{ ...entry, html: '<b>x</b>', calls: [{ to: GAME, entrypoint: 'move', note: 'x' }] }] });
    expect(parsed).toEqual({ ...entry, calls: [{ to: GAME, entrypoint: 'move' }] });
  });

  test('a session key listed twice is kept once, whatever its formatting', () => {
    const again = { ...entry, publicKey: SESSION_KEY.replace('0x', '0x0').toUpperCase().replace('0X', '0x'), origin: 'https://other.example' };
    expect(parseRegistryList({ sessions: [entry, again] })).toEqual([entry]);
  });

  test('a listing is cut at the maximum number of entries', () => {
    const many = Array.from({ length: REGISTRY_MAX_ENTRIES + 20 }, (_, i) => ({ ...entry, publicKey: `0x${(i + 1).toString(16)}` }));
    expect(parseRegistryList({ sessions: many })).toHaveLength(REGISTRY_MAX_ENTRIES);
  });
});
