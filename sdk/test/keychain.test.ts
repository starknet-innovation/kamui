// The keychain protocol: what an app may ask, what the keychain refuses, and that an answer
// only reaches the request it belongs to.
import { describe, expect, test } from 'bun:test';
import { ec, outsideExecution, OutsideExecutionVersion, shortString, type TypedData } from 'starknet';
import {
  MAX_EXECUTE_CALLDATA,
  MAX_EXECUTE_CALLS,
  MAX_EXECUTE_RESULT_CALLDATA,
  MAX_SIGN_MESSAGE_BYTES,
  MAX_SIGN_MESSAGE_FIELDS,
  beginConnect,
  beginExecute,
  beginSignMessage,
  finishSignMessage,
  newKeyPair,
  outsideExecutionHash,
  ownerSignTypedData,
  parseSignMessageRequest,
  sessionSignTypedData,
  signMessageProblems,
  typedDataFields,
  typedDataHash,
  callsFromWire,
  describeCall,
  executeProblems,
  finishConnect,
  finishExecute,
  parseExecuteRequest,
  pendingRequestKind,
  forgetConnection,
  loadConnection,
  ownerOutsideExecution,
  parseConnectRequest,
  resultUrl,
  sessionFromWire,
  sessionProblems,
  sponsor,
  toFragment,
  type ConnectOptions,
  type ConnectRequest,
  type KeyValueStore,
} from '../src';

const APP = 'https://game.example';
const KEYCHAIN = 'https://keychain.example';
const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const options = (over: Partial<ConnectOptions> = {}): ConnectOptions => ({
  keychainUrl: KEYCHAIN,
  redirectUri: `${APP}/play`,
  appName: 'Example Game',
  validUntil: FUTURE,
  maxCalls: 50,
  calls: [{ to: GAME, entrypoint: 'move' }],
  ...over,
});

/** What the keychain receives when an app on `APP` starts a connection. */
function requestFrom(store: KeyValueStore, over: Partial<ConnectOptions> = {}) {
  const url = new URL(beginConnect(options(over), store));
  return { url, request: parseConnectRequest(url.hash, `${APP}/lobby`)! };
}

describe('app to keychain', () => {
  test('the request reaches the keychain intact, without the session private key', () => {
    const store = memoryStore();
    const { url, request } = requestFrom(store, { limits: [{ token: TOKEN, maxPerCall: 100n, maxPerWindow: 150n, windowSeconds: 3600 }], calls: [{ to: GAME, entrypoint: 'move' }, { to: TOKEN, entrypoint: 'transfer' }] });
    expect(url.origin + url.pathname).toBe(`${KEYCHAIN}/connect`);
    expect(request.redirectUri).toBe(`${APP}/play`);
    expect(request.appName).toBe('Example Game');
    expect(request.session.maxCalls).toBe(50);
    expect(request.session.calls).toHaveLength(2);
    const { params, limits } = sessionFromWire(request.session);
    expect(params.scope).toEqual({ kind: 'contracts', calls: request.session.calls });
    expect(limits[0]).toMatchObject({ token: TOKEN, maxPerCall: 100n, maxPerWindow: 150n });

    const pending = JSON.parse(store.data.get('kamui.pending')!);
    expect(pending.key.publicKey).toBe(request.session.publicKey);
    expect(decodeURIComponent(url.hash)).not.toContain(pending.key.privateKey.slice(2));
  });

  test('each connection gets a fresh session key and id', () => {
    const a = requestFrom(memoryStore()).request;
    const b = requestFrom(memoryStore()).request;
    expect(a.id).not.toBe(b.id);
    expect(a.session.publicKey).not.toBe(b.session.publicKey);
  });
});

describe('what the keychain refuses to read', () => {
  const store = memoryStore();
  const fragment = new URL(beginConnect(options(), store)).hash;
  const base = parseConnectRequest(fragment, `${APP}/`)!;
  const withRequest = (change: (r: any) => void) => {
    const copy = JSON.parse(JSON.stringify(base));
    change(copy);
    return toFragment(copy as ConnectRequest);
  };

  test('a fragment with no request is not an error', () => {
    expect(parseConnectRequest('', `${APP}/`)).toBeNull();
    expect(parseConnectRequest('#other=1', `${APP}/`)).toBeNull();
  });

  test('a request that did not come from the site it names', () => {
    expect(() => parseConnectRequest(fragment, 'https://evil.example/')).toThrow(/not sent by the site/);
    expect(() => parseConnectRequest(fragment, '')).toThrow(/cannot tell which site/);
    // Same site, other port: a different origin.
    expect(() => parseConnectRequest(fragment, 'https://game.example:8443/')).toThrow(/not sent by the site/);
  });

  test('redirect addresses that are not https, or carry a fragment', () => {
    expect(() => parseConnectRequest(withRequest((r) => (r.redirectUri = 'http://game.example/play')), 'http://game.example/')).toThrow(/https/);
    expect(() => parseConnectRequest(withRequest((r) => (r.redirectUri = 'javascript:alert(1)')), `${APP}/`)).toThrow();
    expect(() => parseConnectRequest(withRequest((r) => (r.redirectUri = `${APP}/play#x`)), `${APP}/`)).toThrow(/fragment/);
    // http is allowed for localhost only, for development.
    expect(parseConnectRequest(withRequest((r) => (r.redirectUri = 'http://localhost:5175/')), 'http://localhost:5175/')).not.toBeNull();
  });

  test('malformed requests', () => {
    const bad = (change: (r: any) => void, reason: RegExp) => expect(() => parseConnectRequest(withRequest(change), `${APP}/`)).toThrow(reason);
    bad((r) => (r.v = 2), /version/);
    bad((r) => (r.id = 'abc'), /request id/);
    bad((r) => (r.session.publicKey = 'key'), /session key/);
    bad((r) => (r.session.maxCalls = 0), /limits/);
    bad((r) => (r.session.validUntil = -1), /limits/);
    bad((r) => (r.session.calls = []), /names no contract/);
    bad((r) => (r.session.calls[0].entrypoint = 'bad name!'), /scope entry/);
    bad((r) => (r.session.calls[0].to = 'x'), /scope entry/);
    bad((r) => (r.session.limits = [{ token: TOKEN }]), /spending limit/);
    bad((r) => (r.appName = 'x'.repeat(61)), /app name/);
    expect(() => parseConnectRequest('#kamui=%%%', `${APP}/`)).toThrow(/cannot be read/);
  });

  test('unknown fields are dropped, not passed on', () => {
    const parsed = parseConnectRequest(withRequest((r) => { r.extra = 'x'; r.session.extra = 'y'; }), `${APP}/`)!;
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed.session).not.toHaveProperty('extra');
  });
});

describe('what the keychain refuses to approve', () => {
  const session = (over = {}) => ({ ...requestFrom(memoryStore(), over).request.session });

  test('a plain scoped session is fine', () => {
    expect(sessionProblems(ACCOUNT, session())).toEqual([]);
  });

  test('token calls without a spending limit', () => {
    const problems = sessionProblems(ACCOUNT, session({ calls: [{ to: TOKEN, entrypoint: 'transfer' }] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/no spending limit for transfer/);
    const limited = session({ calls: [{ to: TOKEN, entrypoint: 'transfer' }], limits: [{ token: TOKEN, maxPerCall: 1n, maxPerWindow: 2n, windowSeconds: 60 }] });
    expect(sessionProblems(ACCOUNT, limited)).toEqual([]);
  });

  test('blocked functions, the account itself, and expired sessions', () => {
    expect(sessionProblems(ACCOUNT, session({ calls: [{ to: GAME, entrypoint: 'add_owner' }] }))[0]).toMatch(/never be called/);
    expect(sessionProblems(ACCOUNT, session({ calls: [{ to: ACCOUNT, entrypoint: 'move' }] }))[0]).toMatch(/account itself/);
    expect(sessionProblems(ACCOUNT, session({ validUntil: 1000 }))[0]).toMatch(/past/);
  });
});

describe('keychain to app', () => {
  test('an approval becomes a connection, stored for later', () => {
    const store = memoryStore();
    const { request } = requestFrom(store);
    const back = new URL(resultUrl(request, { v: 1, id: request.id, ok: true, account: ACCOUNT, chainId: '0x534e5f5345504f4c4941', classHash: '0x1' }));
    expect(back.origin + back.pathname).toBe(`${APP}/play`);

    const connection = finishConnect(back.hash, store)!;
    expect(connection.account).toBe(ACCOUNT);
    expect(connection.session.publicKey).toBe(request.session.publicKey);
    expect(connection.session.privateKey).toMatch(/^0x/);
    expect(loadConnection(store)).toEqual(connection);
    // The pending request is used up.
    expect(() => finishConnect(back.hash, store)).toThrow(/nothing was asked/);
    forgetConnection(store);
    expect(loadConnection(store)).toBeNull();
  });

  test('a refusal throws and leaves no connection', () => {
    const store = memoryStore();
    const { request } = requestFrom(store);
    const back = new URL(resultUrl(request, { v: 1, id: request.id, ok: false, error: 'denied by the user' }));
    expect(() => finishConnect(back.hash, store)).toThrow(/denied by the user/);
    expect(loadConnection(store)).toBeNull();
  });

  test('an answer for another request is refused', () => {
    const store = memoryStore();
    const { request } = requestFrom(store);
    const forged = toFragment({ v: 1, id: '0xabc', ok: true, account: ACCOUNT, chainId: '0x1', classHash: '0x1' });
    expect(() => finishConnect(forged, store)).toThrow(/not for this request/);
    // The real answer still works afterwards.
    const real = toFragment({ v: 1, id: request.id, ok: true, account: ACCOUNT, chainId: '0x1', classHash: '0x1' });
    expect(finishConnect(real, store)).not.toBeNull();
  });

  test('a fragment that is not an answer is ignored', () => {
    expect(finishConnect('#section', memoryStore())).toBeNull();
  });
});

describe('transaction requests', () => {
  const transfer = { contractAddress: TOKEN, entrypoint: 'transfer', calldata: [GAME, '0x64', '0x0'] };

  function executeFrom(store: KeyValueStore, calls = [transfer]) {
    const url = new URL(beginExecute({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/play`, appName: 'Example Game', calls }, store));
    return { url, request: parseExecuteRequest(url.hash, `${APP}/shop`)! };
  }

  test('the request reaches the keychain intact', () => {
    const store = memoryStore();
    const { url, request } = executeFrom(store);
    expect(url.origin + url.pathname).toBe(`${KEYCHAIN}/execute`);
    expect(request.kind).toBe('execute');
    expect(request.calls).toEqual([{ to: TOKEN, entrypoint: 'transfer', calldata: [GAME, '0x64', '0x0'] }]);
    expect(callsFromWire(request.calls)).toEqual([transfer]);
    expect(pendingRequestKind(store)).toBe('execute');
  });

  test('the same checks on who is asking as for a session', () => {
    const fragment = executeFrom(memoryStore()).url.hash;
    expect(() => parseExecuteRequest(fragment, 'https://evil.example/')).toThrow(/not sent by the site/);
    expect(() => parseExecuteRequest(fragment, '')).toThrow(/cannot tell which site/);
    expect(parseExecuteRequest('#other', `${APP}/`)).toBeNull();
  });

  test('malformed or oversized requests are refused', () => {
    const base = executeFrom(memoryStore()).request;
    const bad = (change: (r: any) => void, reason: RegExp) => {
      const copy = JSON.parse(JSON.stringify(base));
      change(copy);
      expect(() => parseExecuteRequest(toFragment(copy), `${APP}/`)).toThrow(reason);
    };
    bad((r) => (r.kind = 'connect'), /not a transaction request/);
    bad((r) => (r.calls = []), /no call/);
    bad((r) => (r.calls = Array.from({ length: MAX_EXECUTE_CALLS + 1 }, () => r.calls[0])), /more than/);
    bad((r) => (r.calls[0].to = 'x'), /bad call/);
    bad((r) => (r.calls[0].entrypoint = 'drop table'), /bad call/);
    bad((r) => (r.calls[0].calldata = ['1']), /arguments/);
    bad((r) => (r.calls[0].calldata = Array.from({ length: MAX_EXECUTE_CALLDATA + 1 }, () => '0x1')), /arguments/);
    // A connect request is not accepted as a transaction request, and the reverse.
    const connect = new URL(beginConnect(options(), memoryStore())).hash;
    expect(() => parseExecuteRequest(connect, `${APP}/`)).toThrow(/not a transaction request/);
    expect(() => parseConnectRequest(executeFrom(memoryStore()).url.hash, `${APP}/`)).toThrow(/no session/);
  });

  test('a site can never ask for a call to the account itself', () => {
    const toAccount = (entrypoint: string) => [{ to: ACCOUNT, entrypoint, calldata: [] }];
    for (const entrypoint of ['add_owner', 'remove_owner', 'add_or_update_session_key', 'set_spending_policy', 'anything_else']) {
      expect(executeProblems(ACCOUNT, toAccount(entrypoint))).toHaveLength(1);
    }
    // The address is compared as a number, whatever its formatting.
    expect(executeProblems(ACCOUNT, [{ to: '0x0' + ACCOUNT.slice(2), entrypoint: 'x', calldata: [] }])).toHaveLength(1);
    expect(executeProblems(ACCOUNT, [{ to: TOKEN, entrypoint: 'transfer', calldata: [] }])).toEqual([]);
  });

  test('token calls are recognised, with the full 256-bit amount', () => {
    expect(describeCall({ to: TOKEN, entrypoint: 'transfer', calldata: [GAME, '0x64', '0x0'] })).toEqual({ kind: 'transfer', token: TOKEN, recipient: GAME, amount: 100n });
    expect(describeCall({ to: TOKEN, entrypoint: 'transfer', calldata: [GAME, '0x5', '0x1'] })).toMatchObject({ amount: (1n << 128n) + 5n });
    for (const entrypoint of ['approve', 'increase_allowance', 'increaseAllowance']) {
      expect(describeCall({ to: TOKEN, entrypoint, calldata: [GAME, '0x1', '0x0'] })).toEqual({ kind: 'approve', token: TOKEN, spender: GAME, amount: 1n });
    }
    expect(describeCall({ to: TOKEN, entrypoint: 'move', calldata: [GAME, '0x1', '0x0'] })).toEqual({ kind: 'other' });
    expect(describeCall({ to: TOKEN, entrypoint: 'transfer', calldata: [GAME] })).toEqual({ kind: 'other' });
  });

  test('an approval returns the signed transaction, unsent, to the request it belongs to', async () => {
    const store = memoryStore();
    const { request } = executeFrom(store);
    const back = new URL(resultUrl(request, { v: 1, id: request.id, ok: true, account: ACCOUNT, calldata: ['0x1', '0x2'] }));
    expect(back.origin + back.pathname).toBe(`${APP}/play`);
    const approved = finishExecute(back.hash, store)!;
    expect(approved).toEqual({ account: ACCOUNT, call: { contractAddress: ACCOUNT, entrypoint: 'execute_from_outside_v2', calldata: ['0x1', '0x2'] } });
    expect(pendingRequestKind(store)).toBeNull();
    expect(() => finishExecute(back.hash, store)).toThrow(/nothing was asked/);

    // The app has it sent through its own sponsor route, where its server adds the credential.
    let sent: any;
    const hash = await sponsor(`${APP}/api/sponsor`, approved.call, async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return Response.json({ transaction_hash: '0xabc' });
    });
    expect(hash).toBe('0xabc');
    expect(sent).toEqual({ url: `${APP}/api/sponsor`, body: { account: ACCOUNT, calldata: ['0x1', '0x2'] } });
  });

  test('an approval that is not a signed transaction is refused', () => {
    const malformed = (answer: Record<string, unknown>) => {
      const store = memoryStore();
      const { request } = executeFrom(store);
      expect(() => finishExecute(toFragment({ v: 1, id: request.id, ok: true, ...answer } as any), store)).toThrow(/malformed/);
    };
    // What the keychain answered before it stopped sending the transaction itself.
    malformed({ transactionHash: '0xabc' });
    malformed({ account: ACCOUNT });
    malformed({ account: ACCOUNT, calldata: [] });
    malformed({ account: 'x', calldata: ['0x1'] });
    malformed({ account: ACCOUNT, calldata: ['0x1', 'drop table'] });
    malformed({ account: ACCOUNT, calldata: Array.from({ length: MAX_EXECUTE_RESULT_CALLDATA + 1 }, () => '0x1') });
  });

  test('the largest request the keychain accepts fits in an approval', () => {
    const store = memoryStore();
    const big = { contractAddress: GAME, entrypoint: 'move', calldata: Array.from({ length: MAX_EXECUTE_CALLDATA }, () => '0x1') };
    const { request } = executeFrom(store, Array.from({ length: MAX_EXECUTE_CALLS }, () => big));
    const call = ownerOutsideExecution({ chainId: '0x534e5f5345504f4c4941', account: ACCOUNT, calls: callsFromWire(request.calls), ownerPrivateKey: '0x1', window: { executeBefore: 1 } });
    expect(call.calldata).toHaveLength(MAX_EXECUTE_RESULT_CALLDATA);
    const back = resultUrl(request, { v: 1, id: request.id, ok: true, account: ACCOUNT, calldata: call.calldata as string[] });
    expect(finishExecute(new URL(back).hash, store)!.call).toEqual(call);
  });

  test('a refusal, and an answer for another request, both throw', () => {
    const store = memoryStore();
    const { request } = executeFrom(store);
    expect(() => finishExecute(toFragment({ v: 1, id: '0xabc', ok: true, account: ACCOUNT, calldata: ['0x1'] }), store)).toThrow(/not for this request/);
    expect(() => finishExecute(toFragment({ v: 1, id: request.id, ok: false, error: 'denied by the user' }), store)).toThrow(/denied by the user/);
  });
});

describe('message requests', () => {
  const SEPOLIA = shortString.encodeShortString('SN_SEPOLIA');
  const signIn = (): TypedData => ({
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      SignIn: [
        { name: 'statement', type: 'string' },
        { name: 'nonce', type: 'felt' },
        { name: 'issued', type: 'Stamp' },
        { name: 'scopes', type: 'shortstring*' },
      ],
      Stamp: [{ name: 'at', type: 'timestamp' }],
    },
    primaryType: 'SignIn',
    domain: { name: 'Example Game', version: '1', chainId: 'SN_SEPOLIA', revision: '1' },
    message: { statement: 'Sign in to Example Game', nonce: '0x1234', issued: { at: 1763200000 }, scopes: ['profile', 'scores'] },
  });

  function signFrom(store: KeyValueStore, typedData = signIn()) {
    const url = new URL(beginSignMessage({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/play`, appName: 'Example Game', typedData }, store));
    return { url, request: parseSignMessageRequest(url.hash, `${APP}/login`)! };
  }
  const bad = (change: (r: any) => void, reason: RegExp) => {
    const copy = JSON.parse(JSON.stringify(signFrom(memoryStore()).request));
    change(copy);
    expect(() => parseSignMessageRequest(toFragment(copy), `${APP}/`)).toThrow(reason);
  };

  test('the request reaches the keychain intact', () => {
    const store = memoryStore();
    const { url, request } = signFrom(store);
    expect(url.origin + url.pathname).toBe(`${KEYCHAIN}/sign`);
    expect(request.kind).toBe('signMessage');
    expect(request.typedData).toEqual(signIn());
    expect(typedDataHash(request.typedData, ACCOUNT)).toBe(typedDataHash(signIn(), ACCOUNT));
    expect(pendingRequestKind(store)).toBe('signMessage');
  });

  test('the same checks on who is asking as for a session', () => {
    const fragment = signFrom(memoryStore()).url.hash;
    expect(() => parseSignMessageRequest(fragment, 'https://evil.example/')).toThrow(/not sent by the site/);
    expect(() => parseSignMessageRequest(fragment, '')).toThrow(/cannot tell which site/);
    expect(parseSignMessageRequest('#other', `${APP}/`)).toBeNull();
  });

  test('malformed, oversized and unhashable messages are refused', () => {
    bad((r) => (r.kind = 'execute'), /not a message request/);
    bad((r) => delete r.typedData, /no message/);
    bad((r) => (r.typedData.message = 'hello'), /bad message/);
    bad((r) => (r.typedData.types.SignIn = 'felt'), /bad message types/);
    bad((r) => (r.typedData.types.SignIn[0] = { name: 1, type: 'felt' }), /bad message types/);
    bad((r) => (r.typedData.primaryType = 'Missing'), /bad message type/);
    bad((r) => (r.typedData.primaryType = 'StarknetDomain'), /bad message type/);
    bad((r) => (r.typedData.message.statement = 'x'.repeat(MAX_SIGN_MESSAGE_BYTES)), /too large/);
    bad((r) => (r.typedData.message.scopes = Array.from({ length: MAX_SIGN_MESSAGE_FIELDS }, () => 'a')), /more than/);
    // Revision 0 (the legacy domain) is not signed.
    bad((r) => delete r.typedData.domain.revision, /revision 1/);
    bad((r) => {
      r.typedData.types.StarkNetDomain = r.typedData.types.StarknetDomain;
      delete r.typedData.types.StarknetDomain;
    }, /revision 1/);
    // A value its type does not declare would be shown but not signed; a missing one cannot be hashed.
    bad((r) => (r.typedData.message.amount = '0x1'), /cannot be signed as written.*not declared/);
    bad((r) => (r.typedData.message.issued.extra = '0x1'), /cannot be signed as written.*not declared/);
    bad((r) => delete r.typedData.message.nonce, /cannot be signed as written/);
    bad((r) => (r.typedData.message.nonce = 'not a felt, and far too long to be a short string'), /cannot be signed as written/);
    // Other kinds of request are not accepted as a message request, and the reverse.
    expect(() => parseSignMessageRequest(new URL(beginConnect(options(), memoryStore())).hash, `${APP}/`)).toThrow(/not a message request/);
    expect(() => parseExecuteRequest(signFrom(memoryStore()).url.hash, `${APP}/`)).toThrow(/not a transaction request/);
  });

  test('unknown fields are dropped, not passed on', () => {
    const copy = JSON.parse(JSON.stringify(signFrom(memoryStore()).request));
    copy.typedData.extra = 'x';
    copy.other = 'y';
    const parsed = parseSignMessageRequest(toFragment(copy), `${APP}/`)!;
    expect(parsed.typedData).toEqual(signIn());
    expect('other' in parsed).toBe(false);
  });

  test('the message is listed by its types: every hashed value, with its type', () => {
    expect(typedDataFields(signIn())).toEqual([
      { path: 'statement', type: 'string', value: 'Sign in to Example Game' },
      { path: 'nonce', type: 'felt', value: '0x1234' },
      { path: 'issued.at', type: 'timestamp', value: '1763200000' },
      { path: 'scopes[0]', type: 'shortstring', value: 'profile' },
      { path: 'scopes[1]', type: 'shortstring', value: 'scores' },
    ]);
    const empty = signIn();
    (empty.message as any).scopes = [];
    expect(typedDataFields(empty).at(-1)).toEqual({ path: 'scopes', type: 'shortstring*', value: '(empty list)' });
  });

  test('a transaction written as a message is never signed', () => {
    const calls = [{ contractAddress: TOKEN, entrypoint: 'transfer', calldata: [GAME, '0x64', '0x0'] }];
    const window = { caller: shortString.encodeShortString('ANY_CALLER'), execute_after: 0, execute_before: FUTURE };
    const { request } = signFrom(memoryStore(), outsideExecution.getTypedData(SEPOLIA as any, window, '0x1', calls, OutsideExecutionVersion.V2));
    expect(signMessageProblems(SEPOLIA, request.typedData)).toEqual(['it is a transaction written as a message (an outside execution)']);
    // SNIP-9 v1 is a revision 0 message: not read at all (and the account does not accept v1).
    expect(() => signFrom(memoryStore(), outsideExecution.getTypedData(SEPOLIA as any, window, '0x1', calls, OutsideExecutionVersion.V1))).toThrow(/revision 1/);
    // What the SDK signs to run calls is exactly what is refused here.
    const execution = outsideExecution.getTypedData(SEPOLIA as any, window, '0x1', calls, OutsideExecutionVersion.V2);
    expect(typedDataHash(execution, ACCOUNT)).toBe(outsideExecutionHash(SEPOLIA, ACCOUNT, calls, '0x1', { executeBefore: FUTURE }));
    // The domain name is compared as the felt it hashes to, however it is written.
    const disguised = signIn();
    (disguised.domain as any).name = shortString.encodeShortString('Account.execute_from_outside');
    expect(signMessageProblems(SEPOLIA, disguised)).toHaveLength(1);
  });

  test('a message must name the account\'s network', () => {
    expect(signMessageProblems(SEPOLIA, signIn())).toEqual([]);
    const asHex = signIn();
    (asHex.domain as any).chainId = SEPOLIA;
    expect(signMessageProblems(SEPOLIA, asHex)).toEqual([]);
    const mainnet = signIn();
    (mainnet.domain as any).chainId = 'SN_MAIN';
    expect(signMessageProblems(SEPOLIA, mainnet)).toEqual(["it is for another network than your account's"]);
    const none = signIn();
    none.types.StarknetDomain = none.types.StarknetDomain!.filter((field) => field.name !== 'chainId');
    delete (none.domain as any).chainId;
    expect(signMessageProblems(SEPOLIA, none)).toEqual(['it does not name a network']);
  });

  test('owner and session signatures have the shapes the account reads, over the account-bound hash', () => {
    const verifies = (hash: string, r: string, s: string, key: { privateKey: string }) =>
      ec.starkCurve.verify(new ec.starkCurve.Signature(BigInt(r), BigInt(s)), hash, ec.starkCurve.getPublicKey(key.privateKey));
    const owner = newKeyPair();
    const hash = typedDataHash(signIn(), ACCOUNT);
    const [r, s] = ownerSignTypedData(signIn(), ACCOUNT, owner.privateKey);
    expect(verifies(hash, r, s, owner)).toBe(true);
    // The hash commits to the account: the same message signed for another account differs.
    expect(typedDataHash(signIn(), GAME)).not.toBe(hash);

    const session = { ...newKeyPair(), validUntil: FUTURE, maxCalls: 5 };
    const connection = { account: ACCOUNT, chainId: SEPOLIA, classHash: '0x1', session }; // as finishConnect returns it
    const signature = sessionSignTypedData(connection, signIn());
    expect(signature).toHaveLength(4);
    expect(signature[0]).toBe(session.publicKey);
    expect(BigInt(signature[3]!)).toBe(BigInt(FUTURE));
    expect(verifies(hash, signature[1]!, signature[2]!, session)).toBe(true);
  });

  test('an approval returns the signature to the request it belongs to', () => {
    const store = memoryStore();
    const { request } = signFrom(store);
    const back = new URL(resultUrl(request, { v: 1, id: request.id, ok: true, account: ACCOUNT, chainId: SEPOLIA, signature: ['0xa', '0xb'] }));
    expect(back.origin + back.pathname).toBe(`${APP}/play`);
    expect(finishSignMessage(back.hash, store)).toEqual({ account: ACCOUNT, chainId: SEPOLIA, signature: ['0xa', '0xb'] });
    expect(pendingRequestKind(store)).toBeNull();
    expect(() => finishSignMessage(back.hash, store)).toThrow(/nothing was asked/);
  });

  test('a refusal, a malformed answer, and an answer for another request all throw', () => {
    const answerTo = (result: (id: string) => any) => {
      const store = memoryStore();
      const { request } = signFrom(store);
      return () => finishSignMessage(toFragment(result(request.id)), store);
    };
    expect(answerTo(() => ({ v: 1, id: '0xabc', ok: true, account: ACCOUNT, chainId: SEPOLIA, signature: ['0x1', '0x2'] }))).toThrow(/not for this request/);
    expect(answerTo((id) => ({ v: 1, id, ok: false, error: 'denied by the user' }))).toThrow(/denied by the user/);
    expect(answerTo((id) => ({ v: 1, id, ok: true, account: ACCOUNT, chainId: SEPOLIA, signature: ['0x1'] }))).toThrow(/malformed/);
    expect(answerTo((id) => ({ v: 1, id, ok: true, account: ACCOUNT, chainId: SEPOLIA, signature: ['0x1', 'x'] }))).toThrow(/malformed/);
  });
});

describe('sponsoring', () => {
  const call = { contractAddress: ACCOUNT, entrypoint: 'execute_from_outside_v2', calldata: ['0x1', '0x2'] };

  test('posts the account and calldata and returns the transaction hash', async () => {
    let sent: any;
    const hash = await sponsor('https://api.example/sponsor', call, async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return Response.json({ transaction_hash: '0xabc' });
    });
    expect(hash).toBe('0xabc');
    expect(sent).toEqual({ url: 'https://api.example/sponsor', body: { account: ACCOUNT, calldata: ['0x1', '0x2'] } });
  });

  test('refuses anything that is not an outside execution, and surfaces relayer errors', async () => {
    await expect(sponsor('u', { ...call, entrypoint: 'transfer' })).rejects.toThrow(/only outside executions/);
    await expect(sponsor('u', call, async () => Response.json({ error: 'RATE_LIMITED' }, { status: 429 }))).rejects.toThrow(/RATE_LIMITED/);
    await expect(sponsor('u', call, async () => Response.json({}))).rejects.toThrow(/no transaction hash/);
  });
});
