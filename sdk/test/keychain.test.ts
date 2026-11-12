// The keychain protocol: what an app may ask, what the keychain refuses, and that an answer
// only reaches the request it belongs to.
import { describe, expect, test } from 'bun:test';
import {
  MAX_EXECUTE_CALLDATA,
  MAX_EXECUTE_CALLS,
  beginConnect,
  beginExecute,
  callsFromWire,
  describeCall,
  executeProblems,
  finishConnect,
  finishExecute,
  parseExecuteRequest,
  pendingRequestKind,
  forgetConnection,
  loadConnection,
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

  test('an approval returns the transaction hash to the request it belongs to', () => {
    const store = memoryStore();
    const { request } = executeFrom(store);
    const back = new URL(resultUrl(request, { v: 1, id: request.id, ok: true, transactionHash: '0xabc' }));
    expect(back.origin + back.pathname).toBe(`${APP}/play`);
    expect(finishExecute(back.hash, store)).toEqual({ transactionHash: '0xabc' });
    expect(pendingRequestKind(store)).toBeNull();
    expect(() => finishExecute(back.hash, store)).toThrow(/nothing was asked/);
  });

  test('a refusal, and an answer for another request, both throw', () => {
    const store = memoryStore();
    const { request } = executeFrom(store);
    expect(() => finishExecute(toFragment({ v: 1, id: '0xabc', ok: true, transactionHash: '0x1' }), store)).toThrow(/not for this request/);
    expect(() => finishExecute(toFragment({ v: 1, id: request.id, ok: false, error: 'denied by the user' }), store)).toThrow(/denied by the user/);
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
