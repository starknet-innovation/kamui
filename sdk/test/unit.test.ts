// Pure functions: no network.
import { describe, expect, test } from 'bun:test';
import { ec, hash } from 'starknet';
import {
  ANY_CALLER,
  BLOCKED_ENTRYPOINTS,
  NO_PEPPER,
  accountAddress,
  accountAddressFromLogin,
  addOwnerCall,
  addSessionCall,
  assertValidSession,
  constructorCalldata,
  createSessionCalls,
  exportPepper,
  identity,
  newKeyPair,
  newOwnerMessageHash,
  outsideExecutionCall,
  outsideExecutionHash,
  ownerOutsideExecution,
  parsePepperFile,
  pepperFileMatchesLogin,
  serializePepperFile,
  sessionOutsideExecution,
  sessionSignature,
  setSpendingPolicyCall,
  signNewOwner,
  unlimitedTokenCalls,
  type SessionParams,
  type SessionScope,
} from '../src';

const ACCOUNT = '0x222c6332e5b184b8b0ff1016ca6d7cb54a169221b65700cff35ff637e055b3e';
const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const GAME = '0x18dfa96d4e22b303f9496d37a8ff24d5927df856ef0dbda5f6efdda877cb35d';
const SEPOLIA = '0x534e5f5345504f4c4941';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const baseSession = (scope: SessionParams['scope']): SessionParams => ({
  sessionPublicKey: '0x123',
  validUntil: FUTURE,
  maxCalls: 10,
  maxFeePerTx: 10n ** 18n,
  scope,
});

describe('address', () => {
  test('identity matches the Cairo reference value', () => {
    // Printed by the `identity_reference` test in contracts/src/jwt/types.cairo.
    const claims = { iss: 'https://accounts.google.com', aud: '123-abc.apps.googleusercontent.com', sub: '123456789012345678901' };
    expect(BigInt(identity(claims, NO_PEPPER))).toBe(
      3390181075934669139936153450168116728521076354543506169098880721240937364581n,
    );
    expect(identity(claims, '0x1')).not.toBe(identity(claims, NO_PEPPER));
  });

  test('the pepper, the aud and the class hash each move the address', () => {
    const claims = { iss: 'https://accounts.google.com', aud: 'aud-a', sub: '42' };
    const base = accountAddressFromLogin('0x1', claims, NO_PEPPER);
    expect(accountAddressFromLogin('0x1', claims, '0x5')).not.toBe(base);
    expect(accountAddressFromLogin('0x1', { ...claims, aud: 'aud-b' }, NO_PEPPER)).not.toBe(base);
    expect(accountAddressFromLogin('0x2', claims, NO_PEPPER)).not.toBe(base);
    expect(accountAddress('0x1', 'aud-a', identity(claims, NO_PEPPER))).toBe(base);
  });

  test('constructor calldata is the aud byte array then the identity', () => {
    // "aud" fits one pending word: [0 full words, 'aud', 3 bytes].
    expect(constructorCalldata('aud', '0xabc').map(BigInt)).toEqual([0n, 0x617564n, 3n, 0xabcn]);
  });
});

describe('owners', () => {
  test('a new-owner signature verifies and is bound to the anchor', () => {
    const key = newKeyPair();
    const [r, s] = signNewOwner(ACCOUNT, '0x77', key.privateKey);
    const message = newOwnerMessageHash(ACCOUNT, '0x77');
    const signature = new ec.starkCurve.Signature(BigInt(r), BigInt(s));
    expect(ec.starkCurve.verify(signature, message, ec.starkCurve.getPublicKey(key.privateKey))).toBe(true);
    expect(newOwnerMessageHash(ACCOUNT, '0x78')).not.toBe(message);
    expect(newOwnerMessageHash(GAME, '0x77')).not.toBe(message);
  });

  test('add_owner calldata carries the key and a 2-element signature', () => {
    const call = addOwnerCall(ACCOUNT, '0x9', ['0x1', '0x2']);
    expect(call.entrypoint).toBe('add_owner');
    expect(call.calldata).toEqual(['0x9', '0x2', '0x1', '0x2']);
  });
});

describe('sessions', () => {
  test('a contract scope uses the scoped entry point', () => {
    const call = addSessionCall(ACCOUNT, baseSession({ kind: 'contracts', calls: [{ to: GAME, entrypoint: 'move' }] }));
    expect(call.entrypoint).toBe('add_or_update_scoped_session_key');
    const data = call.calldata as string[];
    expect(data.slice(-3)).toEqual(['0x1', GAME, hash.getSelectorFromName('move')]);
  });

  test('an entry point scope uses the SNIP-41 entry point', () => {
    const call = addSessionCall(ACCOUNT, baseSession({ kind: 'entrypoints', entrypoints: ['move'] }));
    expect(call.entrypoint).toBe('add_or_update_session_key');
    expect((call.calldata as string[]).slice(-2)).toEqual(['0x1', hash.getSelectorFromName('move')]);
  });

  test('refuses sessions the contract would never honour', () => {
    const refuse = (params: SessionParams, reason: RegExp) => expect(() => assertValidSession(ACCOUNT, params)).toThrow(reason);
    refuse({ ...baseSession({ kind: 'any' }), validUntil: 1 }, /past/);
    refuse({ ...baseSession({ kind: 'any' }), maxCalls: 0 }, /maxCalls/);
    refuse(baseSession({ kind: 'entrypoints', entrypoints: [] }), /empty/);
    refuse(baseSession({ kind: 'contracts', calls: [{ to: ACCOUNT, entrypoint: 'ping' }] }), /account itself/);
    for (const entrypoint of BLOCKED_ENTRYPOINTS) {
      refuse(baseSession({ kind: 'contracts', calls: [{ to: GAME, entrypoint }] }), /never be called/);
    }
  });

  test('finds token calls that no spending limit covers', () => {
    const limit = { token: TOKEN, maxPerCall: 1n, maxPerWindow: 1n, windowSeconds: 60 };
    const scoped: SessionScope = { kind: 'contracts', calls: [{ to: TOKEN, entrypoint: 'transfer' }, { to: GAME, entrypoint: 'move' }] };
    expect(unlimitedTokenCalls(scoped, [limit])).toEqual([]);
    expect(unlimitedTokenCalls(scoped, [])).toEqual([{ to: TOKEN, entrypoint: 'transfer' }]);
    // A limit on another token does not help.
    expect(unlimitedTokenCalls(scoped, [{ ...limit, token: GAME }])).toHaveLength(1);
    expect(unlimitedTokenCalls({ kind: 'entrypoints', entrypoints: ['approve', 'move'] })).toEqual([{ to: '*', entrypoint: 'approve' }]);
    expect(unlimitedTokenCalls({ kind: 'any' })).toHaveLength(1);
  });

  test('createSessionCalls refuses unlimited token access unless told otherwise', () => {
    const params = baseSession({ kind: 'contracts', calls: [{ to: TOKEN, entrypoint: 'transfer' }] });
    expect(() => createSessionCalls(ACCOUNT, params)).toThrow(/no spending limit/);
    expect(createSessionCalls(ACCOUNT, params, [], { allowUnlimitedSpending: true })).toHaveLength(1);
    const calls = createSessionCalls(ACCOUNT, params, [{ token: TOKEN, maxPerCall: 100n, maxPerWindow: 150n, windowSeconds: 3600 }]);
    expect(calls.map((c) => c.entrypoint)).toEqual(['add_or_update_scoped_session_key', 'set_spending_policy']);
  });

  test('spending policy calldata encodes both u256 limits', () => {
    const call = setSpendingPolicyCall(ACCOUNT, '0x123', { token: TOKEN, maxPerCall: 100n, maxPerWindow: (1n << 128n) + 5n, windowSeconds: 3600 });
    expect(call.calldata).toEqual(['0x123', TOKEN, '0x64', '0x0', '0x5', '0x1', '0xe10']);
    expect(() => setSpendingPolicyCall(ACCOUNT, '0x123', { token: TOKEN, maxPerCall: 1n, maxPerWindow: 0n, windowSeconds: 1 })).toThrow();
  });

  test('a session signature is [pubkey, r, s, valid_until]', () => {
    const key = newKeyPair();
    const signature = sessionSignature('0xabc', { ...key, validUntil: 1234 });
    expect(signature).toHaveLength(4);
    expect(signature[0]).toBe(key.publicKey);
    expect(BigInt(signature[3]!)).toBe(1234n);
    const sig = new ec.starkCurve.Signature(BigInt(signature[1]!), BigInt(signature[2]!));
    expect(ec.starkCurve.verify(sig, '0xabc', ec.starkCurve.getPublicKey(key.privateKey))).toBe(true);
  });
});

describe('outside execution', () => {
  const calls = [{ contractAddress: GAME, entrypoint: 'move', calldata: ['0x1', '0x2'] }];
  const window = { executeBefore: FUTURE };

  test('the hash binds the account, chain, nonce, window and calls', () => {
    const base = outsideExecutionHash(SEPOLIA, ACCOUNT, calls, '0x1', window);
    expect(outsideExecutionHash(SEPOLIA, GAME, calls, '0x1', window)).not.toBe(base);
    expect(outsideExecutionHash('0x534e5f4d41494e', ACCOUNT, calls, '0x1', window)).not.toBe(base);
    expect(outsideExecutionHash(SEPOLIA, ACCOUNT, calls, '0x2', window)).not.toBe(base);
    expect(outsideExecutionHash(SEPOLIA, ACCOUNT, calls, '0x1', { executeBefore: FUTURE + 1 })).not.toBe(base);
    expect(outsideExecutionHash(SEPOLIA, ACCOUNT, [{ ...calls[0]!, calldata: ['0x1', '0x3'] }], '0x1', window)).not.toBe(base);
  });

  test('calldata layout matches execute_from_outside_v2', () => {
    const call = outsideExecutionCall(ACCOUNT, calls, '0x7', window, ['0xa', '0xb']);
    expect(call.entrypoint).toBe('execute_from_outside_v2');
    expect(call.calldata).toEqual([
      ANY_CALLER, '0x7', '0x0', '0x' + FUTURE.toString(16),
      '0x1', GAME, hash.getSelectorFromName('move'), '0x2', '0x1', '0x2',
      '0x2', '0xa', '0xb',
    ]);
  });

  test('owner and session variants sign the same hash with their own signature shape', () => {
    const owner = newKeyPair();
    const ownerCall = ownerOutsideExecution({ chainId: SEPOLIA, account: ACCOUNT, calls, ownerPrivateKey: owner.privateKey, window, nonce: '0x7' });
    expect((ownerCall.calldata as string[]).at(-3)).toBe('0x2');

    const session = { ...newKeyPair(), validUntil: FUTURE };
    const sessionCall = sessionOutsideExecution({ chainId: SEPOLIA, account: ACCOUNT, calls, session, nonce: '0x7' });
    const data = sessionCall.calldata as string[];
    expect(data.at(-5)).toBe('0x4');
    expect(data.at(-4)).toBe(session.publicKey);
    // Without an explicit window, a session call expires with the session.
    expect(BigInt(data[3]!)).toBe(BigInt(FUTURE));
  });
});

describe('pepper export', () => {
  const claims = { iss: 'https://accounts.google.com', aud: 'aud-a', sub: '42' };
  const SEPOLIA_ID = '0x534e5f5345504f4c4941';
  const file = exportPepper({ chainId: SEPOLIA_ID, classHash: '0x1', claims, pepper: '0x1234', keyVersion: 1 });

  test('round-trips and never contains the sub', () => {
    const text = serializePepperFile(file);
    expect(parsePepperFile(text)).toEqual(file);
    expect(text).not.toContain('"sub"');
    expect(Object.keys(file)).not.toContain('sub');
    expect(file.account).toBe(accountAddressFromLogin('0x1', claims, '0x1234'));
  });

  test('matches only the user, aud, class and chain it was made for', () => {
    expect(pepperFileMatchesLogin(file, claims, SEPOLIA_ID)).toBe(true);
    expect(pepperFileMatchesLogin(file, { ...claims, sub: '43' }, SEPOLIA_ID)).toBe(false);
    expect(pepperFileMatchesLogin(file, { ...claims, aud: 'aud-b' }, SEPOLIA_ID)).toBe(false);
    expect(pepperFileMatchesLogin(file, claims, '0x534e5f4d41494e')).toBe(false);
    expect(pepperFileMatchesLogin({ ...file, classHash: '0x2' }, claims, SEPOLIA_ID)).toBe(false);
    expect(pepperFileMatchesLogin({ ...file, pepper: '0x1235' }, claims, SEPOLIA_ID)).toBe(false);
  });

  test('refuses pepper 0, oversized peppers and malformed files', () => {
    const make = (pepper: bigint) => exportPepper({ chainId: SEPOLIA_ID, classHash: '0x1', claims, pepper, keyVersion: 1 });
    expect(() => make(0n)).toThrow(/out of range/);
    expect(() => make(1n << 250n)).toThrow(/out of range/);
    expect(make((1n << 250n) - 1n).pepper).toBe('0x' + ((1n << 250n) - 1n).toString(16));
    expect(() => parsePepperFile('not json')).toThrow(/JSON/);
    expect(() => parsePepperFile('{"kind":"other"}')).toThrow(/not a Kamui/);
    expect(() => parsePepperFile(JSON.stringify({ ...file, version: 2 }))).toThrow(/version/);
    expect(() => parsePepperFile(JSON.stringify({ ...file, pepper: '0x0' }))).toThrow(/range/);
    expect(() => parsePepperFile(JSON.stringify({ ...file, account: 'nope' }))).toThrow(/account/);
    expect(() => parsePepperFile(JSON.stringify({ ...file, keyVersion: 0 }))).toThrow(/keyVersion/);
  });
});

describe('contract consistency', () => {
  test('the blocked entry points are the ones the contract blocks', async () => {
    const source = await Bun.file(`${import.meta.dir}/../../contracts/src/session/interface.cairo`).text();
    const body = source.slice(source.indexOf('pub fn is_blocked_selector'));
    const inContract = [...body.matchAll(/selector!\("([^"]+)"\)/g)].map((m) => m[1]!).sort();
    expect([...BLOCKED_ENTRYPOINTS].sort() as string[]).toEqual(inContract);
  });
});
