// Kamui: audit finding #2. The rotator compares key material, read from the registry's
// storage, and not key ids.
import { describe, expect, test } from 'bun:test';
import { CallData, byteArray, hash } from 'starknet';
import { modulusHash, modulusLimbs } from '../../jwk/modulus';
import { setLogSink } from '../../log';
import { TEST_JWK } from '../../test-fixtures';
import { planSync, storedKey, syncOnce, type Ctx } from './jwk-rotator';

const GOOGLE = 'https://accounts.google.com';
const REGISTRY = '0x654508b46a551c5b3dd8425e0ec4f06af316d28c68500bb83f9b815ba3fb3db';
const KEY_SET = hash.getSelectorFromName('KeySet');
const KEY_REMOVED = hash.getSelectorFromName('KeyRemoved');

const jwk = (kid: string, n = TEST_JWK.n) => ({ kid, kty: 'RSA', alg: 'RS256', use: 'sig', e: 'AQAB', n });
/** Another valid 2048-bit modulus: the fixture's with its low bytes changed. */
const OTHER_N = Buffer.concat([Buffer.from(TEST_JWK.n, 'base64url').subarray(0, 250), Buffer.from([1, 2, 3, 4, 5, 7])]).toString('base64url');
const LIMBS = modulusLimbs(TEST_JWK.n);
const OTHER_LIMBS = modulusLimbs(OTHER_N);
const names = (iss: string, kid: string) => CallData.compile([byteArray.byteArrayFromString(iss), byteArray.byteArrayFromString(kid)]) as string[];

/** A registry in memory: storage, and the events its writes would have emitted. */
function chain(initial: Record<string, bigint[]> = {}) {
  const storage = new Map<string, bigint[]>(Object.entries(initial));
  const events: any[] = Object.entries(initial).map(([kid, limbs]) => ({ keys: [KEY_SET, '0x' + modulusHash(limbs).toString(16)], data: names(GOOGLE, kid), block_number: 1, transaction_hash: '0x1' }));
  const sent: { entrypoint: string; kid: string; limbs?: bigint[] }[][] = [];
  const ctx: Ctx = {
    registryContractAddress: REGISTRY,
    fromBlock: 0,
    provider: {
      getEvents: async () => ({ events }),
      callContract: async ({ calldata }) => {
        const kid = byteArray.stringFromByteArray({ data: [], pending_word: calldata[calldata.length - 2]!, pending_word_len: Number(calldata[calldata.length - 1]) });
        const key = storage.get(kid);
        if (!key) throw new Error(`RPC: starknet_call: 40: Contract error: ${JSON.stringify({ revert_error: "0x554e4b4e4f574e5f4b4944 ('UNKNOWN_KID')" })}`);
        return key.map((limb) => '0x' + limb.toString(16));
      },
      waitForTransaction: async () => ({}),
    },
    registryOwner: {
      execute: async (calls) => {
        sent.push(calls.map((call) => {
          const data = call.calldata as string[];
          // [issuer variant, kid ByteArray (0 words, pending word, length), ...24 limbs]
          const kid = byteArray.stringFromByteArray({ data: [], pending_word: data[2]!, pending_word_len: Number(data[3]) });
          const limbs = call.entrypoint === 'set_key' ? data.slice(4).map(BigInt) : undefined;
          if (limbs) storage.set(kid, limbs);
          else storage.delete(kid);
          events.push(limbs
            ? { keys: [KEY_SET, '0x' + modulusHash(limbs).toString(16)], data: names(GOOGLE, kid), block_number: 2, transaction_hash: '0x2' }
            : { keys: [KEY_REMOVED], data: names(GOOGLE, kid), block_number: 2, transaction_hash: '0x2' });
          return { entrypoint: call.entrypoint, kid, limbs };
        }));
        return { transaction_hash: '0x2' };
      },
    },
  };
  const publish = (keys: ReturnType<typeof jwk>[]) => {
    ctx.fetchJwks = async (iss) => ({ iss, keys, headers: new Headers({ 'cache-control': 'max-age=600' }) });
  };
  return { ctx, storage, sent, publish, events };
}

/** Runs `work` and returns the log lines it wrote. */
async function logged(work: () => Promise<unknown>): Promise<any[]> {
  const lines: any[] = [];
  const previous = setLogSink((line) => lines.push(JSON.parse(line)));
  try {
    await work();
  } finally {
    setLogSink(previous);
  }
  return lines;
}

describe('plan', () => {
  test('compares limbs, not ids', () => {
    const issuer = new Map([['same', LIMBS], ['changed', OTHER_LIMBS], ['new', LIMBS]]);
    const stored = new Map<string, bigint[] | null>([['same', LIMBS], ['changed', LIMBS], ['new', null], ['retired', LIMBS], ['gone', null]]);
    expect(planSync(issuer, stored)).toEqual({ add: ['new'], replace: ['changed'], remove: ['retired'] });
  });
});

describe('finding #2: the rotator', () => {
  test('an unchanged kid and modulus causes no transaction', async () => {
    const { ctx, sent, publish } = chain({ 'kid-1': LIMBS });
    publish([jwk('kid-1')]);
    const lines = await logged(() => syncOnce(ctx, GOOGLE));
    expect(sent).toHaveLength(0);
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(0);
  });

  test('a key the registry lacks is set', async () => {
    const { ctx, sent, storage, publish } = chain({ 'kid-1': LIMBS });
    publish([jwk('kid-1'), jwk('kid-2', OTHER_N)]);
    await logged(() => syncOnce(ctx, GOOGLE));
    expect(sent).toEqual([[{ entrypoint: 'set_key', kid: 'kid-2', limbs: OTHER_LIMBS }]]);
    expect(storage.get('kid-2')).toEqual(OTHER_LIMBS);
  });

  test('a key the issuer retired is removed', async () => {
    const { ctx, sent, publish } = chain({ 'kid-1': LIMBS, 'kid-old': OTHER_LIMBS });
    publish([jwk('kid-1')]);
    await logged(() => syncOnce(ctx, GOOGLE));
    expect(sent).toEqual([[{ entrypoint: 'remove_key', kid: 'kid-old', limbs: undefined }]]);
  });

  test('the same kid with a changed modulus is replaced, with an error-level log, and only once', async () => {
    const { ctx, sent, storage, publish } = chain({ 'kid-1': LIMBS });
    publish([jwk('kid-1', OTHER_N)]);
    const lines = await logged(() => syncOnce(ctx, GOOGLE));
    // Upstream skipped this kid because its id was already on chain: no transaction, old key still trusted.
    expect(sent).toEqual([[{ entrypoint: 'remove_key', kid: 'kid-1', limbs: undefined }, { entrypoint: 'set_key', kid: 'kid-1', limbs: OTHER_LIMBS }]]);
    expect(storage.get('kid-1')).toEqual(OTHER_LIMBS);
    const alert = lines.find((l) => l.event === 'key_material_changed');
    expect(alert).toMatchObject({ level: 'error', iss: GOOGLE, kid: 'kid-1', old_hash: '0x' + modulusHash(LIMBS).toString(16), new_hash: '0x' + modulusHash(OTHER_LIMBS).toString(16) });

    const again = await logged(() => syncOnce(ctx, GOOGLE));
    expect(sent).toHaveLength(1);
    expect(again.filter((l) => l.level === 'error')).toHaveLength(0);
  });

  test('storage decides, not the event history: a key the events call current but storage lacks is set again', async () => {
    const { ctx, sent, storage, publish } = chain({ 'kid-1': LIMBS });
    storage.delete('kid-1');
    publish([jwk('kid-1')]);
    const lines = await logged(() => syncOnce(ctx, GOOGLE));
    expect(sent).toEqual([[{ entrypoint: 'set_key', kid: 'kid-1', limbs: LIMBS }]]);
    expect(lines.some((l) => l.event === 'registry_history_mismatch' && l.level === 'error')).toBe(true);
  });

  test('a key in storage that differs from the events is corrected too', async () => {
    const { ctx, sent, storage, publish } = chain({ 'kid-1': LIMBS });
    storage.set('kid-1', OTHER_LIMBS);
    publish([jwk('kid-1')]);
    await logged(() => syncOnce(ctx, GOOGLE));
    expect(sent[0]!.map((c) => c.entrypoint)).toEqual(['remove_key', 'set_key']);
    expect(storage.get('kid-1')).toEqual(LIMBS);
  });

  test('a node error while reading a key stops the sync; it is never read as "no key"', async () => {
    const { ctx, sent, publish } = chain({ 'kid-1': LIMBS });
    publish([jwk('kid-1')]);
    ctx.provider.callContract = async () => { throw new Error('socket hang up'); };
    await expect(syncOnce(ctx, GOOGLE)).rejects.toThrow('socket hang up');
    expect(sent).toHaveLength(0);
    expect(await storedKey({ ...ctx, provider: { ...ctx.provider, callContract: async () => { throw new Error("execution failed: 'UNKNOWN_KID'"); } } }, GOOGLE, 'k')).toBeNull();
  });
});
