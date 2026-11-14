// The Kamui wallet object: connecting across a full-page redirect, resuming on the next page
// load, and what it refuses to send. The page, the keychain and the node are faked in memory.
import { describe, expect, test } from 'bun:test';
import { KamuiWallet, KamuiWalletError, callsOutsideSession, injectKamuiWallet, loadConnection, type KamuiWalletOptions } from '../src';
import { ACCOUNT, APPROVAL_NONCE, GAME, KEYCHAIN, SEPOLIA, TOKEN, TX, fakeNode, keychainAnswers, sessionRequest, world } from './wallet-helpers';

const move = { contractAddress: GAME, entrypoint: 'move', calldata: [] };

/** A promise that is still pending after the event loop has turned. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol();
  const first = await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), 10))]);
  return first === marker;
}

/** Connects through the fake keychain and returns the wallet of the page load after the redirect. */
async function connected(over: Partial<KamuiWalletOptions> = {}, node = fakeNode()) {
  const w = world(over, node);
  void new KamuiWallet(w.options).connect();
  await Bun.sleep(0);
  w.tab.fragment = keychainAnswers(w.tab.navigatedTo[0]!);
  const wallet = new KamuiWallet(w.options);
  await wallet.resume();
  return { ...w, wallet };
}

async function refusal(run: () => Promise<unknown>): Promise<KamuiWalletError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(KamuiWalletError);
    return error as KamuiWalletError;
  }
  throw new Error('expected a refusal');
}

describe('connecting', () => {
  test('connect sends the user to the keychain and does not settle', async () => {
    const w = world();
    const wallet = new KamuiWallet(w.options);
    const connecting = wallet.connect();
    expect(await isPending(connecting)).toBe(true);
    expect(w.tab.navigatedTo).toHaveLength(1);
    expect(w.tab.navigatedTo[0]).toStartWith(`${KEYCHAIN}/connect#kamui=`);
    expect(wallet.connection).toBeNull();
  });

  test('the next page load picks up the approved session and cleans the address bar', async () => {
    const { wallet, tab, store } = await connected();
    expect(wallet.connection?.account).toBe(ACCOUNT);
    expect(wallet.connection?.chainId).toBe(SEPOLIA);
    expect(wallet.connection?.session.calls).toEqual([{ to: GAME, entrypoint: 'move' }]);
    expect(wallet.error).toBeNull();
    expect(tab.fragment).toBe('');
    expect(loadConnection(store)?.account).toBe(ACCOUNT);
  });

  test('a later page load resumes from storage, and connect settles without a redirect', async () => {
    const w = await connected();
    const later = new KamuiWallet(w.options);
    expect((await later.connect()).account).toBe(ACCOUNT);
    expect(w.tab.navigatedTo).toHaveLength(1);
  });

  test('resume reads the page once, however often it is called', async () => {
    const w = world();
    void new KamuiWallet(w.options).connect();
    await Bun.sleep(0);
    w.tab.fragment = keychainAnswers(w.tab.navigatedTo[0]!);
    const wallet = new KamuiWallet(w.options);
    const [a, b] = await Promise.all([wallet.resume(), wallet.resume()]);
    expect(a).toBe(b);
    expect(w.tab.cleared).toBe(1);
    expect(w.node.state.reads.filter((r) => r === 'get_session_data')).toHaveLength(1);
  });

  test('a refusal is reported, not thrown, and leaves the wallet disconnected', async () => {
    const w = world();
    void new KamuiWallet(w.options).connect();
    await Bun.sleep(0);
    w.tab.fragment = keychainAnswers(w.tab.navigatedTo[0]!, { error: 'denied by the user' });
    const wallet = new KamuiWallet(w.options);
    expect(await wallet.resume()).toBeNull();
    expect(wallet.error).toBe('keychain: denied by the user');
    expect(w.tab.fragment).toBe('');
    expect(w.tab.navigatedTo).toHaveLength(1);
  });

  test('an answer nobody asked for is reported and does not connect', async () => {
    const other = world();
    void new KamuiWallet(other.options).connect();
    await Bun.sleep(0);
    const w = world();
    w.tab.fragment = keychainAnswers(other.tab.navigatedTo[0]!);
    const wallet = new KamuiWallet(w.options);
    expect(await wallet.resume()).toBeNull();
    expect(wallet.error).toBe('keychain: an answer arrived but nothing was asked');
  });

  test('a session that died on chain is forgotten', async () => {
    const w = await connected();
    w.node.state.alive = false;
    const later = new KamuiWallet(w.options);
    expect(await later.resume()).toBeNull();
    expect(loadConnection(w.store)).toBeNull();
  });

  test('an unreachable node does not connect, and does not throw the session away', async () => {
    const w = await connected();
    w.node.state.down = true;
    const later = new KamuiWallet(w.options);
    expect(await later.resume()).toBeNull();
    expect(later.error).toBe('could not check the session: node unreachable');
    expect(loadConnection(w.store)?.account).toBe(ACCOUNT);
  });

  test('the session request can be a function, read when connecting', async () => {
    let asked = 0;
    const w = world({ session: () => (asked++, sessionRequest()) });
    const wallet = new KamuiWallet(w.options);
    await wallet.resume();
    expect(asked).toBe(0);
    void wallet.connect();
    await Bun.sleep(0);
    expect(asked).toBe(1);
  });

  test('disconnect forgets the session and tells listeners', async () => {
    const { wallet, store, tab } = await connected();
    const seen: unknown[] = [];
    const listener = (accounts: string[]) => seen.push(accounts);
    wallet.on('accountsChanged', listener);
    wallet.disconnect();
    expect(seen).toEqual([[]]);
    expect(wallet.connection).toBeNull();
    expect(loadConnection(store)).toBeNull();
    wallet.off('accountsChanged', listener);
    wallet.disconnect();
    expect(seen).toHaveLength(1);

    // Connecting again asks the keychain again.
    void wallet.connect();
    await Bun.sleep(0);
    expect(tab.navigatedTo).toHaveLength(2);
  });

  test('without a page or storage (a server) the wallet is unavailable and stays quiet', async () => {
    const { store: _s, page: _p, ...rest } = world().options;
    const wallet = new KamuiWallet(rest);
    expect(wallet.available()).toBe(false);
    expect(await wallet.resume()).toBeNull();
  });
});

describe('sending calls', () => {
  test('a call inside the session is signed here and handed to the sponsor', async () => {
    const { wallet, relayed, node } = await connected();
    expect(await wallet.execute(move)).toEqual({ transaction_hash: TX });
    expect(relayed).toEqual([{ contractAddress: ACCOUNT, entrypoint: 'execute_from_outside_v2', nonce: node.nonce(0) }]);
  });

  test('each call takes the next reserved nonce, also when sent at the same time', async () => {
    const { wallet, relayed, node } = await connected();
    await Promise.all([wallet.execute(move), wallet.execute(move)]);
    await wallet.execute(move);
    expect(relayed.map((r) => r.nonce)).toEqual([node.nonce(0), node.nonce(1), node.nonce(2)]);
  });

  test('a nonce is not burned when the sponsor fails', async () => {
    const { wallet, relayed, relayer, node } = await connected();
    relayer.fail = true;
    expect(wallet.execute(move)).rejects.toThrow('relayer down');
    await Bun.sleep(5);
    relayer.fail = false;
    await wallet.execute(move);
    expect(relayed.map((r) => r.nonce)).toEqual([node.nonce(0)]);
  });

  test('a call outside the session is refused before anything is signed or sent', async () => {
    const { wallet, relayed, node } = await connected();
    const transfer = { contractAddress: TOKEN, entrypoint: 'transfer', calldata: [ACCOUNT, '0x1', '0x0'] };
    const reads = node.state.reads.length;
    const error = await refusal(() => wallet.execute([move, transfer]));
    expect(error.code).toBe('OUT_OF_SCOPE');
    expect(error.name).toBe('KamuiWalletError');
    expect(error.calls).toEqual([transfer]);
    expect(error.message).toContain(`transfer on ${TOKEN}`);
    expect(relayed).toHaveLength(0);
    expect(node.state.reads).toHaveLength(reads);
  });

  test('the same entry point on another contract is outside the session', async () => {
    const { wallet } = await connected();
    const error = await refusal(() => wallet.execute({ contractAddress: TOKEN, entrypoint: 'move', calldata: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  test('an address is matched by value, not by spelling', async () => {
    const { wallet } = await connected();
    const padded = `0x0${GAME.slice(2).toUpperCase()}`;
    expect(await wallet.execute({ contractAddress: padded, entrypoint: 'move', calldata: [] })).toEqual({ transaction_hash: TX });
  });

  test('a session with all its calls used says so', async () => {
    const { wallet, relayed } = await connected();
    for (let i = 0; i < 3; i++) await wallet.execute(move);
    const error = await refusal(() => wallet.execute(move));
    expect(error.code).toBe('SESSION_EXHAUSTED');
    expect(error.message).toContain('used all its 3 calls');
    expect(relayed).toHaveLength(3);
  });

  test('nonces used before this page load are skipped', async () => {
    const node = fakeNode();
    node.state.used.add(node.nonce(0)).add(node.nonce(1));
    const { wallet, relayed } = await connected({}, node);
    await wallet.execute(move);
    expect(relayed.map((r) => r.nonce)).toEqual([node.nonce(2)]);
    expect((await refusal(() => wallet.execute(move))).code).toBe('SESSION_EXHAUSTED');
  });

  test('the place in the nonce range is kept in the store, so the next page load reads it once', async () => {
    const { wallet, options, store, node } = await connected({ session: sessionRequest({ maxCalls: 50 }) }, fakeNode({ maxCalls: 50 }));
    for (let i = 0; i < 5; i++) await wallet.execute(move);
    expect(loadConnection(store)!.session.nonces).toEqual({ base: '0x3e8', next: 5 });

    const reloaded = new KamuiWallet(options);
    await reloaded.resume();
    const reads = node.state.reads.length;
    await reloaded.execute(move);
    expect(node.state.reads.slice(reads)).toEqual(['get_session_nonce_base', 'is_valid_outside_execution_nonce']);
  });

  test('renew asks the keychain for the same key; the renewed session starts at its own first nonce', async () => {
    const { wallet, options, store, tab, node, relayed } = await connected();
    for (let i = 0; i < 3; i++) await wallet.execute(move);
    expect((await refusal(() => wallet.execute(move))).code).toBe('SESSION_EXHAUSTED');
    const before = loadConnection(store)!;
    expect(before.session.nonces).toMatchObject({ exhausted: true });

    // Connecting again would do nothing: the session is alive. Renewing goes to the keychain.
    expect(await isPending(wallet.renew())).toBe(true);
    expect(tab.navigatedTo).toHaveLength(2);
    const asked = new URL(tab.navigatedTo[1]!);
    expect(asked.pathname).toBe('/connect');
    expect(JSON.parse(atob(new URLSearchParams(asked.hash.slice(1)).get('kamui')!.replace(/-/g, '+').replace(/_/g, '/'))).session.publicKey).toBe(before.session.publicKey);

    // Approved: the account gives the key a new nonce base, and nothing of it is used.
    tab.fragment = keychainAnswers(tab.navigatedTo[1]!);
    node.state.base = 5000n;
    const renewed = new KamuiWallet(options);
    const connection = (await renewed.resume())!;
    expect(connection.session.publicKey).toBe(before.session.publicKey);
    expect(connection.session.nonces).toBeUndefined();
    await renewed.execute(move);
    await renewed.execute(move);
    expect(relayed.slice(3).map((r) => r.nonce)).toEqual([5000n, 5001n]);

    // The wallet object from before the renewal still remembers the old range as used up. The
    // new base makes it start over; it never signs a nonce of the old range again.
    await wallet.execute(move);
    expect(relayed.at(-1)!.nonce).toBe(5002n);
    expect(relayed.filter((r) => r.nonce < 5000n)).toHaveLength(3);
    // And it does not write its old connection over the renewed one.
    expect(loadConnection(store)!.session.nonces).toEqual({ base: '0x1388', next: 3 });
  });

  test('renew needs a session', async () => {
    const w = world();
    const error = await refusal(() => new KamuiWallet(w.options).renew());
    expect(error.code).toBe('NOT_CONNECTED');
  });

  test('an expired session is refused locally', async () => {
    const w = await connected();
    const stored = loadConnection(w.store)!;
    stored.session.validUntil = Math.floor(Date.now() / 1000) - 1;
    w.store.setItem('kamui.connection', JSON.stringify(stored));
    const later = new KamuiWallet(w.options);
    await later.resume();
    expect((await refusal(() => later.execute(move))).code).toBe('SESSION_EXPIRED');
    expect(w.relayed).toHaveLength(0);
  });

  test('nothing is sent without a session', async () => {
    const w = world();
    const wallet = new KamuiWallet(w.options);
    await wallet.resume();
    expect((await refusal(() => wallet.execute(move))).code).toBe('NOT_CONNECTED');
    expect(() => wallet.account()).toThrow(KamuiWalletError);
  });

  test('a connection stored without its scope is not checked locally', async () => {
    const w = await connected();
    const stored = loadConnection(w.store)!;
    delete stored.session.calls;
    expect(callsOutsideSession(stored, [{ contractAddress: TOKEN, entrypoint: 'transfer' }])).toEqual([]);
  });

  test('a URL sponsor posts the outside execution to that route', async () => {
    const posted: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ transaction_hash: TX }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const { wallet } = await connected({ sponsor: '/api/kamui/sponsor' });
      expect(await wallet.execute(move)).toEqual({ transaction_hash: TX });
      expect(posted).toHaveLength(1);
      expect(posted[0]!.url).toBe('/api/kamui/sponsor');
      expect(posted[0]!.body.account).toBe(ACCOUNT);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('the account object sends through the wallet, with the same refusals', async () => {
    const { wallet, relayed } = await connected();
    const account = wallet.account();
    expect(account.address).toBe(ACCOUNT);
    expect(await account.execute(move)).toEqual({ transaction_hash: TX });
    expect(relayed).toHaveLength(1);
    const error = await refusal(() => account.execute({ contractAddress: TOKEN, entrypoint: 'transfer', calldata: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });
});

describe('one-off approvals', () => {
  const approve = { contractAddress: TOKEN, entrypoint: 'approve', calldata: [GAME, '0x1', '0x0'] };

  test('approveInKeychain leaves the page; the next load sends the signed transaction through the sponsor', async () => {
    const w = await connected();
    const leaving = w.wallet.approveInKeychain([approve], 'Example Game');
    expect(await isPending(leaving)).toBe(true);
    expect(w.tab.navigatedTo[1]).toStartWith(`${KEYCHAIN}/execute#kamui=`);
    expect(w.relayed).toHaveLength(0);

    w.tab.fragment = keychainAnswers(w.tab.navigatedTo[1]!);
    const back = new KamuiWallet(w.options);
    expect((await back.resume())?.account).toBe(ACCOUNT);
    // The keychain sent nothing: the wallet's sponsor got the owner-signed call, once.
    expect(w.relayed).toEqual([{ contractAddress: ACCOUNT, entrypoint: 'execute_from_outside_v2', nonce: APPROVAL_NONCE }]);
    expect(back.lastApproved).toBe(TX);
    expect(back.error).toBeNull();
    expect(w.tab.fragment).toBe('');

    // Another page load finds no approval left to send.
    const later = new KamuiWallet(w.options);
    await later.resume();
    expect(later.lastApproved).toBeNull();
    expect(w.relayed).toHaveLength(1);
  });

  test('a sponsor URL gets the approved transaction as { account, calldata }', async () => {
    const posted: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      posted.push({ url, body: JSON.parse(init.body) });
      return Response.json({ transaction_hash: TX });
    }) as unknown as typeof fetch;
    try {
      const w = await connected({ sponsor: 'https://game.example/api/sponsor' });
      void w.wallet.approveInKeychain([approve]);
      w.tab.fragment = keychainAnswers(w.tab.navigatedTo[1]!);
      const back = new KamuiWallet(w.options);
      await back.resume();
      expect(back.lastApproved).toBe(TX);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.url).toBe('https://game.example/api/sponsor');
      expect(posted[0]!.body.account).toBe(ACCOUNT);
      expect(BigInt(posted[0]!.body.calldata[1])).toBe(APPROVAL_NONCE);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('an approval the sponsor refuses is reported, and the session stays', async () => {
    const w = await connected();
    void w.wallet.approveInKeychain([approve]);
    w.tab.fragment = keychainAnswers(w.tab.navigatedTo[1]!);
    w.relayer.fail = true;
    const back = new KamuiWallet(w.options);
    expect((await back.resume())?.account).toBe(ACCOUNT);
    expect(back.lastApproved).toBeNull();
    expect(back.error).toBe('could not send the approved transaction: relayer down');
    expect(w.tab.fragment).toBe('');
  });

  test('without a sponsor nothing could send an approval: refused before leaving the page', async () => {
    const w = await connected({ sponsor: undefined });
    const error = await refusal(async () => w.wallet.approveInKeychain([approve]));
    expect(error.code).toBe('UNSUPPORTED');
    expect(w.tab.navigatedTo).toHaveLength(1);
  });

  test('a refused approval is reported and the session stays', async () => {
    const w = await connected();
    void w.wallet.approveInKeychain([approve]);
    w.tab.fragment = keychainAnswers(w.tab.navigatedTo[1]!, { error: 'cancelled by the user' });
    const back = new KamuiWallet(w.options);
    expect((await back.resume())?.account).toBe(ACCOUNT);
    expect(back.lastApproved).toBeNull();
    expect(back.error).toBe('keychain: cancelled by the user');
  });
});

describe('wallet API', () => {
  test('silent requests never redirect', async () => {
    const w = world();
    const wallet = new KamuiWallet(w.options);
    expect(await wallet.request({ type: 'wallet_getPermissions' })).toEqual([]);
    expect(await wallet.request({ type: 'wallet_requestAccounts', params: { silent_mode: true } })).toEqual([]);
    expect(w.tab.navigatedTo).toHaveLength(0);
  });

  test('asking for accounts without a session goes to the keychain', async () => {
    const w = world();
    const { request } = new KamuiWallet(w.options); // detached, as get-starknet calls it
    expect(await isPending(request({ type: 'wallet_requestAccounts' }))).toBe(true);
    expect(w.tab.navigatedTo).toHaveLength(1);
  });

  test('with a session: accounts, permissions, chain and invoke', async () => {
    const { wallet, relayed } = await connected();
    expect(await wallet.request({ type: 'wallet_getPermissions' })).toEqual(['accounts']);
    expect(await wallet.request({ type: 'wallet_requestAccounts' })).toEqual([ACCOUNT]);
    expect(await wallet.request({ type: 'wallet_requestChainId' })).toBe(SEPOLIA);
    expect(await wallet.request({ type: 'wallet_switchStarknetChain', params: { chainId: SEPOLIA } })).toBe(true);
    const sent = await wallet.request({
      type: 'wallet_addInvokeTransaction',
      params: { calls: [{ contract_address: GAME, entry_point: 'move', calldata: [] }] },
    });
    expect(sent).toEqual({ transaction_hash: TX });
    expect(relayed).toHaveLength(1);
  });

  test('what a session cannot do is refused by name', async () => {
    const { wallet } = await connected();
    for (const type of ['wallet_signTypedData', 'wallet_addDeclareTransaction', 'wallet_watchAsset']) {
      const error = await refusal(() => wallet.request({ type }));
      expect(error.code).toBe('UNSUPPORTED');
      expect(error.message).toContain(type);
    }
    expect((await refusal(() => wallet.request({ type: 'wallet_switchStarknetChain', params: { chainId: '0x534e5f4d41494e' } }))).code).toBe('UNSUPPORTED');
    expect((await refusal(() => wallet.request({ type: 'wallet_addInvokeTransaction', params: { calls: [{ contract_address: TOKEN, entry_point: 'transfer' }] } }))).code).toBe('OUT_OF_SCOPE');
  });

  test("starknet.js's WalletAccount drives the session through the wallet API", async () => {
    const { WalletAccount } = await import('starknet');
    const { wallet, relayed, node } = await connected();
    const account = await WalletAccount.connectSilent(node.provider, wallet);
    expect(BigInt(account.address)).toBe(BigInt(ACCOUNT));
    expect(await account.execute(move)).toEqual({ transaction_hash: TX });
    expect(relayed).toHaveLength(1);
    expect(account.execute({ contractAddress: TOKEN, entrypoint: 'transfer', calldata: [] })).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
  });

  test('injectKamuiWallet exposes it where wallet discovery looks', () => {
    const target: Record<string, unknown> = {};
    const wallet = new KamuiWallet(world().options);
    injectKamuiWallet(wallet, target);
    expect(target.starknet_kamui).toBe(wallet);
    expect(wallet).toMatchObject({ id: 'kamui', name: 'Kamui', version: '1' });
    expect(wallet.icon).toStartWith('data:image/svg+xml;base64,');
  });
});
