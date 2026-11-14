// The wallet-standard adapter: the wallet contract on its own, then mounted under Starknet
// Start's real <StarknetConfig> so `useAccount`, `useSendTransaction` and `useSignTypedData`
// are the ones an app would call. The page, the keychain and the node are faked in memory
// (./wallet-helpers).
import { describe, expect, test } from 'bun:test';
import { StrictMode, createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { hash, WalletAccountV6 } from 'starknet';
import { isStarknetWallet } from '@starknet-io/get-starknet-core';
import { sepolia } from '@starknetfoundation/starknet-start-chains';
import {
  StarknetConfig,
  useAccount,
  useConnect,
  useDeclareContract,
  useDisconnect,
  useSendTransaction,
  useSignTypedData,
  useSwitchChain,
} from '@starknetfoundation/starknet-start-react';
import { sessionSignTypedData } from '../src';
import { KamuiStandardWallet, KamuiWallet, KamuiWalletError, useKamuiReconnect, type KamuiReconnect } from '../src/starknet-start';
import { ACCOUNT, GAME, KEYCHAIN, SEPOLIA, TOKEN, TX, keychainAnswers, signInMessage, world } from './wallet-helpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const move = { contractAddress: GAME, entrypoint: 'move', calldata: [] };
const transfer = { contractAddress: TOKEN, entrypoint: 'transfer', calldata: [ACCOUNT, '0x1', '0x0'] };
const settle = () => act(() => Bun.sleep(20));
const CHAIN = `starknet:${SEPOLIA}`;
/** The watcher reads the fake node every 5 ms, so a test sees a session end without waiting. */
const WATCH = { watch: { pollIntervalMs: 5 } };

const connectOf = (wallet: KamuiStandardWallet) => wallet.features['standard:connect'].connect;
const requestOf = (wallet: KamuiStandardWallet) => wallet.features['starknet:walletApi'].request;

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol();
  return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), 10))])) === marker;
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

/** A world whose user has already been to the keychain and is back, answer in the URL. */
async function backFromKeychain(answer: Parameters<typeof keychainAnswers>[1] = 'approve') {
  const w = world();
  void new KamuiWallet(w.options).connect();
  await Bun.sleep(0);
  w.tab.fragment = keychainAnswers(w.tab.navigatedTo[0]!, answer);
  return w;
}

describe('wallet-standard wallet', () => {
  test('is a Starknet wallet-standard wallet named Kamui', () => {
    const wallet = new KamuiStandardWallet(world().options);
    expect(isStarknetWallet(wallet)).toBe(true);
    expect(wallet.name).toBe('Kamui');
    expect(wallet.version).toBe('1.0.0');
    expect(wallet.icon).toStartWith('data:image/svg+xml;base64,');
    expect(wallet.features['starknet:walletApi']).toMatchObject({ id: 'kamui', version: '1.0.0' });
    expect(wallet.accounts).toEqual([]);
    expect(wallet.chains).toEqual([]);
  });

  test('a silent connect without a session returns no accounts and stays on the page', async () => {
    const w = world();
    const wallet = new KamuiStandardWallet(w.options);
    expect(await connectOf(wallet)({ silent: true })).toEqual({ accounts: [] });
    expect(await requestOf(wallet)({ type: 'wallet_getPermissions' })).toEqual([]);
    expect(await requestOf(wallet)({ type: 'wallet_requestAccounts', params: { silent_mode: true } })).toEqual([]);
    expect(w.tab.navigatedTo).toHaveLength(0);
  });

  test('connect without a session sends the user to the keychain and does not settle', async () => {
    const w = world();
    const wallet = new KamuiStandardWallet(w.options);
    const changes: unknown[] = [];
    wallet.features['standard:events'].on('change', (change) => changes.push(change));
    expect(await isPending(connectOf(wallet)())).toBe(true);
    expect(w.tab.navigatedTo).toHaveLength(1);
    expect(w.tab.navigatedTo[0]).toStartWith(`${KEYCHAIN}/connect#kamui=`);
    expect(wallet.accounts).toEqual([]);
    expect(changes).toEqual([]);
  });

  test('after the redirect a silent connect resumes the session and announces the account', async () => {
    const w = await backFromKeychain();
    const wallet = new KamuiStandardWallet(w.options, { watch: false });
    const changes: any[] = [];
    wallet.features['standard:events'].on('change', (change) => changes.push(change));
    // Accounts are not listed before the app connects.
    await wallet.wallet.resume();
    expect(wallet.accounts).toEqual([]);

    const { accounts } = await connectOf(wallet)({ silent: true });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ address: ACCOUNT, chains: [CHAIN], features: [] });
    expect(wallet.accounts).toEqual([...accounts]);
    expect(wallet.chains).toEqual([CHAIN]);
    expect(changes).toHaveLength(1);
    expect(changes[0].accounts[0].address).toBe(ACCOUNT);
    expect(changes[0].chains).toEqual([CHAIN]);

    // Connecting again, as Starknet Start does, neither redirects nor announces twice.
    expect((await connectOf(wallet)()).accounts[0]!.address).toBe(ACCOUNT);
    expect(changes).toHaveLength(1);
    expect(w.tab.navigatedTo).toHaveLength(1);
    expect(w.tab.fragment).toBe('');
  });

  test('disconnect forgets the session and announces no accounts; listeners can leave', async () => {
    const w = await backFromKeychain();
    const wallet = new KamuiStandardWallet(w.options, { watch: false });
    const changes: any[] = [];
    const off = wallet.features['standard:events'].on('change', (change) => changes.push(change));
    await connectOf(wallet)();
    await wallet.features['standard:disconnect'].disconnect();
    expect(changes.map((change) => change.accounts.length)).toEqual([1, 0]);
    expect(wallet.accounts).toEqual([]);
    expect(await new KamuiWallet(w.options).resume()).toBeNull();

    off();
    void connectOf(wallet)();
    await Bun.sleep(0);
    expect(w.tab.navigatedTo).toHaveLength(2);
    expect(changes).toHaveLength(2);
  });

  test('a session that ends while watched announces no accounts and keeps the reason', async () => {
    const w = await backFromKeychain();
    const wallet = new KamuiStandardWallet(w.options, WATCH);
    const changes: any[] = [];
    wallet.features['standard:events'].on('change', (change) => changes.push(change));
    await connectOf(wallet)();
    await Bun.sleep(20);
    expect(wallet.lastEnd).toBeNull();

    w.node.state.events.push({ keys: [hash.getSelectorFromName('AllSessionsRevoked')], data: ['0x2'], block_number: 101 });
    w.node.state.block = 101;
    await Bun.sleep(30);
    expect(changes.map((change) => change.accounts.length)).toEqual([1, 0]);
    expect(wallet.accounts).toEqual([]);
    expect(wallet.lastEnd?.reason).toBe('all-revoked');
    expect((await refusal(() => requestOf(wallet)({ type: 'wallet_requestChainId' }))).code).toBe('NOT_CONNECTED');
  });

  test('the wallet API is served from the session', async () => {
    const w = await backFromKeychain();
    const wallet = new KamuiStandardWallet(w.options, { watch: false });
    const request = requestOf(wallet);
    expect(await request({ type: 'wallet_requestAccounts' })).toEqual([ACCOUNT]);
    expect(await request({ type: 'wallet_getPermissions' })).toEqual(['accounts']);
    expect(await request({ type: 'wallet_requestChainId' })).toBe(SEPOLIA);
    expect(await request({ type: 'wallet_switchStarknetChain', params: { chainId: SEPOLIA } })).toBe(true);
    expect(await request({ type: 'wallet_addInvokeTransaction', params: { calls: [{ contract_address: GAME, entry_point: 'move', calldata: [] }] } })).toEqual({
      transaction_hash: TX,
    });
    expect(w.relayed).toHaveLength(1);
    expect(await request({ type: 'wallet_signTypedData', params: signInMessage() })).toEqual(sessionSignTypedData(wallet.wallet.connection!, signInMessage()));
  });

  test('what a session cannot do is refused with a typed error', async () => {
    const w = await backFromKeychain();
    const wallet = new KamuiStandardWallet(w.options, { watch: false });
    const request = requestOf(wallet) as (call: { type: string; params?: unknown }) => Promise<unknown>;
    await connectOf(wallet)();
    for (const type of [
      'wallet_addDeclareTransaction',
      'wallet_deploymentData',
      'wallet_watchAsset',
      'wallet_addStarknetChain',
      'wallet_strk20Balances',
      'wallet_strk20PrepareInvoke',
      'wallet_strk20InvokeTransaction',
    ]) {
      const error = await refusal(() => request({ type }));
      expect(error.code).toBe('UNSUPPORTED');
      expect(error.message).toContain(type);
    }
    expect((await refusal(() => request({ type: 'wallet_switchStarknetChain', params: { chainId: '0x534e5f4d41494e' } }))).code).toBe('UNSUPPORTED');
    const outside = await refusal(() => request({ type: 'wallet_addInvokeTransaction', params: { calls: [{ contract_address: TOKEN, entry_point: 'transfer' }] } }));
    expect(outside.code).toBe('OUT_OF_SCOPE');
    expect((await refusal(() => request({ type: 'wallet_signTypedData', params: signInMessage('SN_MAIN') }))).code).toBe('UNSUPPORTED');
    expect(w.relayed).toHaveLength(0);
  });

  test("starknet.js's WalletAccountV6 drives the session through the wallet", async () => {
    const w = await backFromKeychain();
    const wallet = new KamuiStandardWallet(w.options, { watch: false });
    await connectOf(wallet)();
    const account = new WalletAccountV6({ address: ACCOUNT, provider: w.node.provider, walletProvider: wallet });
    expect(await account.execute(move)).toEqual({ transaction_hash: TX });
    expect(await account.signMessage(signInMessage())).toEqual(sessionSignTypedData(wallet.wallet.connection!, signInMessage()));
    expect(account.execute(transfer)).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
  });
});

describe('under <StarknetConfig>', () => {
  type Seen = {
    reconnect: KamuiReconnect;
    account: ReturnType<typeof useAccount>;
    connect: ReturnType<typeof useConnect>;
    disconnect: ReturnType<typeof useDisconnect>;
    send: ReturnType<typeof useSendTransaction>;
    sign: ReturnType<typeof useSignTypedData>;
    switchChain: ReturnType<typeof useSwitchChain>;
    declare: ReturnType<typeof useDeclareContract>;
  };

  /** Mounts an app with Kamui as an extra wallet and returns what its hooks last returned. */
  async function mount(w: ReturnType<typeof world>, wrap: (app: ReactNode) => ReactNode = (app) => app, options = WATCH) {
    const wallet = new KamuiStandardWallet(w.options, options);
    const seen = {} as Seen;
    function Probe() {
      seen.reconnect = useKamuiReconnect(wallet);
      seen.account = useAccount();
      seen.connect = useConnect();
      seen.disconnect = useDisconnect();
      seen.send = useSendTransaction({});
      seen.sign = useSignTypedData({});
      seen.switchChain = useSwitchChain({});
      seen.declare = useDeclareContract({});
      return null;
    }
    const app = createElement(StarknetConfig, {
      chains: [sepolia],
      provider: () => w.node.provider,
      extraWallets: [wallet],
      queryClient: new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
      children: createElement(Probe),
    });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(wrap(app) as Parameters<typeof create>[0]);
    });
    await settle();
    return { seen, wallet, unmount: () => act(() => root.unmount()) };
  }

  test('Kamui is listed among the connectors', async () => {
    const w = world();
    const { seen, wallet, unmount } = await mount(w);
    expect(seen.connect.connectors).toContain(wallet);
    await unmount();
  });

  test('a first visit stays disconnected and does not redirect', async () => {
    const w = world();
    const { seen, unmount } = await mount(w);
    expect(seen.reconnect).toEqual({ isResuming: false, error: null, lastApproved: null });
    expect(seen.account.status).toBe('disconnected');
    expect(w.tab.navigatedTo).toHaveLength(0);
    await unmount();
  });

  test('useConnect sends the user to the keychain', async () => {
    const w = world();
    const { seen, wallet, unmount } = await mount(w);
    act(() => seen.connect.connect({ connector: wallet }));
    await settle();
    expect(w.tab.navigatedTo).toHaveLength(1);
    expect(w.tab.navigatedTo[0]).toStartWith(`${KEYCHAIN}/connect#kamui=`);
    expect(seen.account.status).toBe('disconnected');
    expect(seen.connect.isPending).toBe(true);
    await unmount();
  });

  test('back from the keychain, useAccount sees the session without a click', async () => {
    const w = await backFromKeychain();
    const { seen, wallet, unmount } = await mount(w);
    expect(seen.account.status).toBe('connected');
    expect(BigInt(seen.account.address!)).toBe(BigInt(ACCOUNT));
    expect(seen.account.connector).toBe(wallet);
    expect(seen.account.chainId).toBe(BigInt(SEPOLIA));
    expect(seen.reconnect).toEqual({ isResuming: false, error: null, lastApproved: null });
    expect(w.tab.fragment).toBe('');
    expect(w.tab.navigatedTo).toHaveLength(1);
    await unmount();
  });

  test('a later visit reconnects from storage, also under StrictMode', async () => {
    const w = await backFromKeychain();
    await new KamuiWallet(w.options).resume(); // the page load that consumed the answer
    const { seen, unmount } = await mount(w, (app) => createElement(StrictMode, null, app));
    expect(seen.account.status).toBe('connected');
    expect(BigInt(seen.account.address!)).toBe(BigInt(ACCOUNT));
    expect(w.tab.navigatedTo).toHaveLength(1);
    await unmount();
  });

  test('a denial is reported by the hook and the app stays disconnected', async () => {
    const w = await backFromKeychain({ error: 'denied by the user' });
    const { seen, unmount } = await mount(w);
    expect(seen.account.status).toBe('disconnected');
    expect(seen.reconnect.error).toBe('keychain: denied by the user');
    expect(w.tab.navigatedTo).toHaveLength(1);
    await unmount();
  });

  test('useSendTransaction sends a call inside the session through the sponsor', async () => {
    const w = await backFromKeychain();
    const { seen, unmount } = await mount(w);
    let result: unknown;
    await act(async () => {
      result = await seen.send.sendAsync([move]);
    });
    expect(result).toEqual({ transaction_hash: TX });
    expect(w.relayed).toEqual([{ contractAddress: ACCOUNT, entrypoint: 'execute_from_outside_v2', nonce: w.node.nonce(0) }]);
    await unmount();
  });

  test('useSendTransaction surfaces a call outside the session as a KamuiWalletError', async () => {
    const w = await backFromKeychain();
    const { seen, unmount } = await mount(w);
    let error: unknown;
    await act(async () => {
      error = await seen.send.sendAsync([transfer]).catch((e) => e);
    });
    expect(error).toBeInstanceOf(KamuiWalletError);
    expect((error as KamuiWalletError).code).toBe('OUT_OF_SCOPE');
    expect((error as KamuiWalletError).calls).toHaveLength(1);
    expect(w.relayed).toHaveLength(0);
    await settle();
    expect(seen.send.error).toBe(error as Error);
    await unmount();
  });

  test('useSendTransaction surfaces an exhausted session', async () => {
    const w = await backFromKeychain();
    for (let i = 0; i < 3; i++) w.node.state.used.add(w.node.nonce(i));
    const { seen, unmount } = await mount(w);
    let error: unknown;
    await act(async () => {
      error = await seen.send.sendAsync([move]).catch((e) => e);
    });
    expect((error as KamuiWalletError).code).toBe('SESSION_EXHAUSTED');
    await unmount();
  });

  test('useSignTypedData signs with the session key, and refuses a message for another chain', async () => {
    const w = await backFromKeychain();
    const { seen, wallet, unmount } = await mount(w);
    let signature: unknown;
    await act(async () => {
      signature = await seen.sign.signTypedDataAsync(signInMessage());
    });
    expect(signature).toEqual(sessionSignTypedData(wallet.wallet.connection!, signInMessage()));

    let error: unknown;
    await act(async () => {
      error = await seen.sign.signTypedDataAsync(signInMessage('SN_MAIN')).catch((e) => e);
    });
    expect((error as KamuiWalletError).code).toBe('UNSUPPORTED');
    await unmount();
  });

  test('switching to another chain and declaring are refused', async () => {
    const w = await backFromKeychain();
    const { seen, unmount } = await mount(w);
    let switched: unknown;
    let declared: unknown;
    await act(async () => {
      switched = await seen.switchChain.switchChainAsync({ chainId: '0x534e5f4d41494e' }).catch((e) => e);
      declared = await seen.declare.declareAsync({ compiled_class_hash: '0x1', contract_class: {} as never }).catch((e) => e);
    });
    expect((switched as KamuiWalletError).code).toBe('UNSUPPORTED');
    expect((declared as KamuiWalletError).code).toBe('UNSUPPORTED');
    await settle();
    expect(seen.account.status).toBe('connected');
    await unmount();
  });

  test('useDisconnect forgets the session', async () => {
    const w = await backFromKeychain();
    const { seen, unmount } = await mount(w);
    await act(async () => {
      await seen.disconnect.disconnectAsync();
    });
    await settle();
    expect(seen.account.status).toBe('disconnected');
    expect(await new KamuiWallet(w.options).resume()).toBeNull();
    await unmount();
  });

  test('a session revoked while the app is open shows as disconnected', async () => {
    const w = await backFromKeychain();
    const { seen, wallet, unmount } = await mount(w);
    expect(seen.account.status).toBe('connected');
    w.node.state.events.push({ keys: [hash.getSelectorFromName('SessionKeyRevoked'), wallet.wallet.connection!.session.publicKey], data: [], block_number: 101 });
    w.node.state.block = 101;
    await act(() => Bun.sleep(40));
    expect(seen.account.status).toBe('disconnected');
    expect(seen.account.address).toBeUndefined();
    expect(wallet.lastEnd?.reason).toBe('revoked');
    await unmount();
  });
});
