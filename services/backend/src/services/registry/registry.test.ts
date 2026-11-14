// Kamui: the session registry. The owner signatures are real, made by the SDK's registry client
// code, so this also checks that both sides hash the same message. The chain is a fake whose
// `is_valid_signature` behaves like the account's: two elements are checked against the owner
// key, four are a session signature and are accepted (which is why the server must refuse them
// itself).
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ec, shortString } from 'starknet';
import { registryContentHash, signRegistryRequest, type RegistryAction } from '../../../../../sdk/src/registry';
import { HttpError } from '../../http';
import { listSessions, putSession, registryMessageHash, removeSession, sessionContentHash, type RegistryContext } from './registry';
import { RegistryStore } from './store';

const CHAIN_ID = '0x534e5f5345504f4c4941';
const CLASS = '0x13c5e8166199db99e894da9e55ce642267e5258c42eae8851357747b6201fdc';
const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const OTHER_ACCOUNT = '0x4ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const OWNER = '0x1234567890abcdef1234567890abcdef';
const STRANGER = '0xfedcba0987654321';
const VALID = shortString.encodeShortString('VALID');
const NOW = 1_800_000_000;

function context(over: { classHash?: string; maxPerAccount?: number } = {}) {
  const state = { now: NOW, calls: 0 };
  const owner = ec.starkCurve.getPublicKey(OWNER);
  const ctx: RegistryContext = {
    chainId: CHAIN_ID,
    classHash: CLASS,
    store: new RegistryStore(':memory:', over.maxPerAccount),
    now: () => state.now,
    provider: {
      getClassHashAt: async () => over.classHash ?? CLASS,
      callContract: async ({ entrypoint, calldata }: { entrypoint: string; calldata: string[] }) => {
        state.calls += 1;
        if (entrypoint !== 'is_valid_signature') throw new Error('unexpected call');
        const [hash, length, ...signature] = calldata;
        if (Number(length) === 4) return [VALID];
        const [r, s] = signature.map(BigInt);
        const ok = ec.starkCurve.verify(new ec.starkCurve.Signature(r!, s!), BigInt(hash!).toString(16).padStart(64, '0'), owner);
        return [ok ? VALID : '0x0'];
      },
    } as any,
  };
  return { ctx, state };
}

const session = (publicKey = '0xabc', over: Record<string, unknown> = {}) => ({
  publicKey,
  origin: 'https://app.example',
  appName: 'Example',
  validUntil: NOW + 3600,
  maxCalls: 10,
  maxFeePerTx: '0x0',
  calls: [{ to: '0x1', entrypoint: 'transfer' }],
  limits: [{ token: '0x2', maxPerCall: '0x10', maxPerWindow: '0x100', windowSeconds: 3600 }],
  ...over,
});

let nonces = 0;
/** A signed request. Each has a new nonce, as a client's would. For a `put`, `record` is the session the signature covers. */
function signed(action: RegistryAction, subject: string | undefined, over: { timestamp?: number; account?: string; key?: string; nonce?: string; record?: any } = {}) {
  const timestamp = over.timestamp ?? NOW;
  const account = over.account ?? ACCOUNT;
  const nonce = over.nonce ?? '0x' + (++nonces).toString(16);
  const record = action === 'put' ? (over.record ?? session(subject)) : undefined;
  // A record too malformed to hash cannot be signed; the server refuses it before it looks at the signature.
  let signature: string[] = ['0x1', '0x2'];
  try {
    signature = signRegistryRequest({ chainId: CHAIN_ID, account, action, timestamp, nonce, subject, session: record, ownerPrivateKey: over.key ?? OWNER });
  } catch {}
  return { account, timestamp, nonce, signature };
}
const put = (ctx: RegistryContext, s: any = session(), over = {}) => putSession({ ...signed('put', s.publicKey, { ...over, record: s }), session: s }, ctx);
const list = async (ctx: RegistryContext, over = {}) => (await listSessions(signed('list', undefined, over), ctx)).sessions;
const status = (p: Promise<unknown>) => p.then(() => 'ok', (e: HttpError) => `${e.status} ${e.message}`);

describe('authorisation', () => {
  test('the signature covers the record: a changed field is refused', async () => {
    const { ctx } = context();
    const approved = session('0xabc');
    const request = signed('put', '0xabc', { record: approved });
    const changes: Record<string, unknown>[] = [
      { origin: 'https://evil.example' },
      { appName: 'Evil' },
      { appName: undefined },
      { validUntil: NOW + 7200 },
      { maxCalls: 11 },
      { maxFeePerTx: '0x1' },
      { calls: [] },
      { calls: [{ to: '0x1', entrypoint: 'approve' }] },
      { calls: [{ to: '0x9', entrypoint: 'transfer' }] },
      { limits: [] },
      { limits: [{ token: '0x2', maxPerCall: '0x10', maxPerWindow: '0x100', windowSeconds: 7200 }] },
      { limits: [{ token: '0x2', maxPerCall: '0x11', maxPerWindow: '0x100', windowSeconds: 3600 }] },
      { limits: [{ token: '0x2', maxPerCall: '0x10', maxPerWindow: '0x101', windowSeconds: 3600 }] },
      { limits: [{ token: '0x3', maxPerCall: '0x10', maxPerWindow: '0x100', windowSeconds: 3600 }] },
    ];
    for (const change of changes) {
      const tampered = JSON.parse(JSON.stringify({ ...approved, ...change }));
      expect(await status(putSession({ ...request, session: tampered }, ctx))).toBe('401 BAD_SIGNATURE');
    }
    expect(await list(ctx)).toEqual([]);
    // Untouched, the same request is accepted.
    expect(await status(putSession({ ...request, session: approved }, ctx))).toBe('ok');
  });

  test('a signed request is accepted once', async () => {
    const { ctx, state } = context();
    const s = session('0xabc');
    const putRequest = { ...signed('put', '0xabc', { record: s }), session: s };
    const removeRequest = { ...signed('remove', '0xabc'), publicKey: '0xabc' };
    const listRequest = signed('list', undefined);
    expect(await status(putSession(putRequest, ctx))).toBe('ok');
    expect(await status(removeSession(removeRequest, ctx))).toBe('ok');
    expect(await status(listSessions(listRequest, ctx))).toBe('ok');
    // A captured put cannot bring a removed record back, and so on for the others.
    expect(await status(putSession(putRequest, ctx))).toBe('401 REPLAYED');
    expect(await status(removeSession(removeRequest, ctx))).toBe('401 REPLAYED');
    expect(await status(listSessions(listRequest, ctx))).toBe('401 REPLAYED');
    expect(await list(ctx)).toEqual([]);
    // The other valid signature for the same message, (r, n - s), is the same message.
    const ORDER = 0x800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
    const flipped = [listRequest.signature[0], '0x' + (ORDER - BigInt(listRequest.signature[1])).toString(16)];
    expect(await status(listSessions({ ...listRequest, signature: flipped }, ctx))).toBe('401 REPLAYED');
    // Still refused at the last second the timestamp is accepted; after that the timestamp refuses it.
    state.now = NOW + 300;
    expect(await status(listSessions(listRequest, ctx))).toBe('401 REPLAYED');
    state.now = NOW + 301;
    expect(await status(listSessions(listRequest, ctx))).toBe('401 STALE_TIMESTAMP');
    // A refused request does not use up its message: a bad signature first, then the real one.
    state.now = NOW;
    const fresh = signed('list', undefined);
    expect(await status(listSessions({ ...fresh, signature: ['0x1', '0x2'] }, ctx))).toBe('401 BAD_SIGNATURE');
    expect(await status(listSessions(fresh, ctx))).toBe('ok');
    for (const nonce of [undefined, 'x', 7, '0x' + 'f'.repeat(64)]) {
      expect(await status(listSessions({ ...fresh, nonce } as any, ctx))).toBe('400 BAD_NONCE');
    }
  });

  test('the server hashes the message as the SDK does', () => {
    const timestamp = NOW;
    // A record with an amount above 128 bits and no app name, to cover both halves and the absent name.
    const { appName, ...record } = session('0xabc', { limits: [{ token: '0x2', maxPerCall: '0x1' + '0'.repeat(40), maxPerWindow: '0x' + 'f'.repeat(64), windowSeconds: 60 }] }) as any;
    for (const each of [session('0xabc'), record]) {
      expect(sessionContentHash(each as any)).toBe(registryContentHash(each as any));
    }
    const mine = registryMessageHash(CHAIN_ID, ACCOUNT, 'put', timestamp, '0x7', '0xabc', sessionContentHash(record));
    const [r, s] = signRegistryRequest({ chainId: CHAIN_ID, account: ACCOUNT, action: 'put', timestamp, nonce: '0x7', subject: '0xabc', session: record, ownerPrivateKey: OWNER });
    expect(ec.starkCurve.verify(new ec.starkCurve.Signature(BigInt(r), BigInt(s)), BigInt(mine).toString(16).padStart(64, '0'), ec.starkCurve.getPublicKey(OWNER))).toBe(true);
  });

  test('a valid owner signature is accepted', async () => {
    const { ctx } = context();
    expect(await put(ctx)).toEqual({ ok: true });
    expect(await list(ctx)).toEqual([{ ...session(), createdAt: NOW }]);
  });

  test('a signature by a key that is not an owner is refused', async () => {
    const { ctx } = context();
    expect(await status(put(ctx, session(), { key: STRANGER }))).toBe('401 BAD_SIGNATURE');
    expect(await status(list(ctx, { key: STRANGER }))).toBe('401 BAD_SIGNATURE');
  });

  test('a four-element signature is refused without asking the account', async () => {
    const { ctx, state } = context();
    const request = signed('list', undefined);
    const sessionSignature = [...request.signature, '0x1', '0x2'];
    expect(await status(listSessions({ ...request, signature: sessionSignature }, ctx))).toBe('400 BAD_SIGNATURE_FORMAT');
    expect(await status(putSession({ ...signed('put', '0xabc'), signature: sessionSignature, session: session() }, ctx))).toBe('400 BAD_SIGNATURE_FORMAT');
    expect(await status(removeSession({ ...signed('remove', '0xabc'), signature: sessionSignature, publicKey: '0xabc' }, ctx))).toBe('400 BAD_SIGNATURE_FORMAT');
    for (const signature of [[], ['0x1'], ['0x1', 'nope'], 'x', undefined]) {
      expect(await status(listSessions({ ...request, signature } as any, ctx))).toBe('400 BAD_SIGNATURE_FORMAT');
    }
    expect(state.calls).toBe(0);
  });

  test('a stale or future timestamp is refused', async () => {
    const { ctx, state } = context();
    expect(await status(list(ctx, { timestamp: NOW - 301 }))).toBe('401 STALE_TIMESTAMP');
    expect(await status(list(ctx, { timestamp: NOW + 301 }))).toBe('401 STALE_TIMESTAMP');
    expect(await status(list(ctx, { timestamp: NOW - 300 }))).toBe('ok');
    expect(await status(list(ctx, { timestamp: NOW + 300 }))).toBe('ok');
    // A captured request stops working once the clock has moved on.
    const captured = signed('list', undefined);
    state.now = NOW + 301;
    expect(await status(listSessions(captured, ctx))).toBe('401 STALE_TIMESTAMP');
    expect(await status(listSessions({ ...captured, timestamp: 'now' } as any, ctx))).toBe('400 BAD_TIMESTAMP');
    // Moving the timestamp without re-signing breaks the signature.
    expect(await status(listSessions({ ...captured, timestamp: NOW + 301 }, ctx))).toBe('401 BAD_SIGNATURE');
  });

  test('a signature for one action or subject cannot be used for another', async () => {
    const { ctx } = context();
    await put(ctx, session('0xabc'));
    const forList = signed('list', undefined);
    const forPut = signed('put', '0xabc');
    const forRemove = signed('remove', '0xabc');
    expect(await status(removeSession({ ...forList, publicKey: '0xabc' }, ctx))).toBe('401 BAD_SIGNATURE');
    expect(await status(removeSession({ ...forPut, publicKey: '0xabc' }, ctx))).toBe('401 BAD_SIGNATURE');
    expect(await status(listSessions(forPut, ctx))).toBe('401 BAD_SIGNATURE');
    expect(await status(listSessions(forRemove, ctx))).toBe('401 BAD_SIGNATURE');
    expect(await status(putSession({ ...forRemove, session: session('0xabc') }, ctx))).toBe('401 BAD_SIGNATURE');
    // Another subject: a put for one session key does not write, or remove, another.
    expect(await status(putSession({ ...forPut, session: session('0xdef') }, ctx))).toBe('401 BAD_SIGNATURE');
    expect(await status(removeSession({ ...signed('remove', '0xdef'), publicKey: '0xabc' }, ctx))).toBe('401 BAD_SIGNATURE');
    // Another account.
    expect(await status(listSessions({ ...forList, account: OTHER_ACCOUNT }, ctx))).toBe('401 BAD_SIGNATURE');
    expect((await list(ctx)).map((s) => s.publicKey)).toEqual(['0xabc']);
  });

  test('an account of another class is refused', async () => {
    const { ctx, state } = context({ classHash: '0x1' });
    expect(await status(put(ctx))).toBe('400 WRONG_CLASS');
    expect(await status(list(ctx))).toBe('400 WRONG_CLASS');
    expect(state.calls).toBe(0);
  });
});

describe('storage', () => {
  test('the journal mode is explicit: a rollback journal by default, never WAL unless asked', () => {
    const path = `${import.meta.dir}/../../../data/test-${process.pid}.sqlite`;
    const store = new RegistryStore(path);
    expect(store.journalMode).toBe('delete');
    store.close();
    const wal = new RegistryStore(path, undefined, 'wal');
    expect(wal.journalMode).toBe('wal');
    wal.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
    expect(() => new RegistryStore(':memory:', undefined, 'off')).toThrow('REGISTRY_JOURNAL_MODE');
  });

  test('WAL is refused on a network volume; DELETE is fine there, and WAL is fine on a local disk', () => {
    const path = `${import.meta.dir}/../../../data/test-net-${process.pid}.sqlite`;
    const network = { isNetworkVolume: () => true };
    try {
      expect(() => new RegistryStore(path, undefined, 'WAL', network)).toThrow('network volume');
      expect(() => new RegistryStore(path, undefined, 'wal', network)).toThrow('network volume');
      const rollback = new RegistryStore(path, undefined, 'DELETE', network);
      expect(rollback.journalMode).toBe('delete');
      rollback.close();
      const local = new RegistryStore(path, undefined, 'WAL', { isNetworkVolume: () => false });
      expect(local.journalMode).toBe('wal');
      local.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
    }
  });
});

describe('entries', () => {
  test('writing the same session key again replaces the entry', async () => {
    const { ctx, state } = context();
    await put(ctx, session('0xabc', { appName: 'First' }));
    state.now += 10;
    // The same key with other padding and case is the same entry.
    await put(ctx, session('0x0ABC', { appName: 'Second', origin: 'https://other.example' }));
    const sessions = await list(ctx);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ publicKey: '0xabc', appName: 'Second', origin: 'https://other.example', createdAt: NOW + 10 });
  });

  test('lists newest first, and only the signing account\'s entries', async () => {
    const { ctx, state } = context();
    await put(ctx, session('0x1'));
    state.now += 5;
    await put(ctx, session('0x2'));
    await put(ctx, session('0x3'));
    state.now += 5;
    await put(ctx, session('0x1'));
    expect((await list(ctx)).map((s) => s.publicKey)).toEqual(['0x1', '0x3', '0x2']);
    expect(ctx.store.list('0x' + BigInt(OTHER_ACCOUNT).toString(16), state.now)).toEqual([]);
  });

  test('remove deletes the entry, and succeeds when there is nothing to remove', async () => {
    const { ctx } = context();
    await put(ctx, session('0xabc'));
    await put(ctx, session('0xdef'));
    expect(await removeSession({ ...signed('remove', '0xabc'), publicKey: '0xabc' }, ctx)).toEqual({ ok: true });
    expect((await list(ctx)).map((s) => s.publicKey)).toEqual(['0xdef']);
    expect(await removeSession({ ...signed('remove', '0xabc'), publicKey: '0xabc' }, ctx)).toEqual({ ok: true });
  });

  test('an account holds a bounded number of entries; replacing still works when full', async () => {
    const { ctx } = context({ maxPerAccount: 3 });
    for (const key of ['0x1', '0x2', '0x3']) await put(ctx, session(key));
    expect(await status(put(ctx, session('0x4')))).toBe('409 REGISTRY_FULL');
    expect(await status(put(ctx, session('0x2', { appName: 'Again' })))).toBe('ok');
    expect(await list(ctx)).toHaveLength(3);
    await removeSession({ ...signed('remove', '0x1'), publicKey: '0x1' }, ctx);
    expect(await status(put(ctx, session('0x4')))).toBe('ok');
  });

  test('a refused put writes nothing, even after the limit is lowered', () => {
    const path = `${import.meta.dir}/../../../data/test-lowered-${process.pid}.sqlite`;
    try {
      const before = new RegistryStore(path, 3);
      expect(before.put(ACCOUNT, session('0x1', { validUntil: NOW + 100 }), NOW)).toBe(true);
      expect(before.put(ACCOUNT, session('0x2'), NOW)).toBe(true);
      expect(before.put(ACCOUNT, session('0x3'), NOW)).toBe(true);
      before.close();
      // Reopened with a lower limit, the account is over it: 0x2 and 0x3 are live, 0x1 has expired.
      const after = new RegistryStore(path, 1);
      const later = NOW + 100;
      expect(after.put(ACCOUNT, session('0x4'), later)).toBe(false);
      expect(after.put(ACCOUNT, session('0x2', { appName: 'Again' }), later)).toBe(false);
      // Neither refusal deleted the expired entry or the entry being replaced.
      expect(after.dropExpired(later)).toBe(1);
      after.close();
      const reopened = new RegistryStore(path, 3);
      expect(reopened.list(ACCOUNT, later).map((s) => [s.publicKey, s.appName])).toEqual([['0x3', 'Example'], ['0x2', 'Example']]);
      reopened.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
    }
  });

  test('expired entries are dropped, and make room', async () => {
    const { ctx, state } = context({ maxPerAccount: 2 });
    await put(ctx, session('0x1', { validUntil: NOW + 100 }));
    await put(ctx, session('0x2', { validUntil: NOW + 5000 }));
    expect(await status(put(ctx, session('0x9', { validUntil: NOW - 1 })))).toBe('400 SESSION_EXPIRED');
    state.now = NOW + 100;
    expect((await list(ctx, { timestamp: state.now })).map((s) => s.publicKey)).toEqual(['0x2']);
    expect(await status(put(ctx, session('0x3', { validUntil: NOW + 5000 }), { timestamp: state.now }))).toBe('ok');
    state.now = NOW + 5000;
    expect(ctx.store.dropExpired(state.now)).toBe(2);
  });

  test('every field is validated', async () => {
    const { ctx } = context();
    const refused = async (over: Record<string, unknown>) => status(put(ctx, session('0xabc', over) as any));
    expect(await refused({ origin: 'http://app.example' })).toBe('400 BAD_ORIGIN');
    expect(await refused({ origin: 'https://app.example/path' })).toBe('400 BAD_ORIGIN');
    expect(await refused({ origin: 'javascript:alert(1)' })).toBe('400 BAD_ORIGIN');
    expect(await refused({ origin: 'https://user@app.example' })).toBe('400 BAD_ORIGIN');
    expect(await refused({ origin: `https://${'a'.repeat(200)}.example` })).toBe('400 BAD_ORIGIN');
    expect(await refused({ origin: 'http://localhost:5173' })).toBe('ok');
    expect(await refused({ appName: 'x'.repeat(61) })).toBe('400 BAD_APP_NAME');
    expect(await refused({ appName: 'two\nlines' })).toBe('400 BAD_APP_NAME');
    expect(await refused({ appName: 7 })).toBe('400 BAD_APP_NAME');
    expect(await refused({ appName: undefined })).toBe('ok');
    expect(await refused({ validUntil: '1900000000' })).toBe('400 BAD_VALID_UNTIL');
    expect(await refused({ maxCalls: 1.5 })).toBe('400 BAD_MAX_CALLS');
    expect(await refused({ maxFeePerTx: '12' })).toBe('400 BAD_MAX_FEE');
    expect(await refused({ calls: Array.from({ length: 65 }, () => ({ to: '0x1', entrypoint: 'a' })) })).toBe('400 BAD_CALLS');
    expect(await refused({ calls: [{ to: 'x', entrypoint: 'a' }] })).toBe('400 BAD_CALLS');
    expect(await refused({ calls: [{ to: '0x1', entrypoint: '<script>' }] })).toBe('400 BAD_CALLS');
    expect(await refused({ limits: Array.from({ length: 33 }, () => ({ token: '0x2', maxPerCall: '0x1', maxPerWindow: '0x1', windowSeconds: 1 })) })).toBe('400 BAD_LIMITS');
    expect(await refused({ limits: [{ token: '0x2', maxPerCall: '0x1', maxPerWindow: 5, windowSeconds: 1 }] })).toBe('400 BAD_LIMITS');
    expect(await status(putSession({ ...signed('put', '0x0'), session: session('0x0') }, ctx))).toBe('400 BAD_PUBLIC_KEY');
    expect(await status(putSession({ ...signed('put', '0xabc') }, ctx))).toBe('400 BAD_SESSION');
    // Fields the protocol does not know are not stored.
    await put(ctx, { ...session('0xabc'), extra: 'x'.repeat(1000) } as any);
    expect(Object.keys((await list(ctx))[0]!)).not.toContain('extra');
  });
});
