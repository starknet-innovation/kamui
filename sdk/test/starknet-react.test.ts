// The starknet-react connector: the Connector contract on its own, then mounted under the real
// <StarknetConfig> so `useAccount` and `useSendTransaction` are the ones an app would call.
// The page, the keychain and the node are faked in memory (./wallet-helpers).
import { describe, expect, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { QueryClient } from '@tanstack/react-query';
import { sepolia } from '@starknet-react/chains';
import { Connector, StarknetConfig, useAccount, useConnect, useDisconnect, useSendTransaction } from '@starknet-react/core';
import { KamuiConnector, KamuiWalletError, useKamuiReconnect, type KamuiReconnect } from '../src/starknet-react';
import { ACCOUNT, GAME, KEYCHAIN, SEPOLIA, TOKEN, TX, keychainAnswers, world } from './wallet-helpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const move = { contractAddress: GAME, entrypoint: 'move', calldata: [] };
const settle = () => act(() => Bun.sleep(20));

/** A world whose user has already been to the keychain and is back, answer in the URL. */
async function backFromKeychain(answer: Parameters<typeof keychainAnswers>[1] = 'approve') {
  const w = world();
  void new KamuiConnector(w.options).connect();
  await Bun.sleep(0);
  w.tab.fragment = keychainAnswers(w.tab.navigatedTo[0]!, answer);
  return w;
}

describe('connector', () => {
  test('is a starknet-react Connector named kamui', () => {
    const connector = new KamuiConnector(world().options);
    expect(connector).toBeInstanceOf(Connector);
    expect(connector.id).toBe('kamui');
    expect(connector.name).toBe('Kamui');
    expect(connector.icon.dark).toStartWith('data:image/svg+xml;base64,');
    expect(connector.available()).toBe(true);
  });

  test('not ready, and nothing leaves the page, until connect is called', async () => {
    const w = world();
    const connector = new KamuiConnector(w.options);
    expect(await connector.ready()).toBe(false);
    expect(w.tab.navigatedTo).toHaveLength(0);
    expect(connector.chainId()).rejects.toThrow(KamuiWalletError);
    expect(connector.account(w.node.provider)).rejects.toThrow(KamuiWalletError);

    void connector.connect();
    await Bun.sleep(0);
    expect(w.tab.navigatedTo[0]).toStartWith(`${KEYCHAIN}/connect#kamui=`);
  });

  test('after the redirect it is ready, and connect settles with the account and chain', async () => {
    const w = await backFromKeychain();
    const connector = new KamuiConnector(w.options);
    const events: unknown[] = [];
    connector.on('connect', (data) => events.push(data));
    expect(await connector.ready()).toBe(true);
    const data = await connector.connect();
    expect(data).toEqual({ account: ACCOUNT, chainId: BigInt(SEPOLIA) });
    expect(events).toEqual([data]);
    expect(await connector.chainId()).toBe(BigInt(SEPOLIA));
    expect(w.tab.navigatedTo).toHaveLength(1);
  });

  test('requests and the account object go through the session', async () => {
    const w = await backFromKeychain();
    const connector = new KamuiConnector(w.options);
    await connector.connect();
    expect(await connector.request({ type: 'wallet_requestAccounts' })).toEqual([ACCOUNT]);
    const account = await connector.account(w.node.provider);
    expect(account.address).toBe(ACCOUNT);
    expect(await account.execute(move)).toEqual({ transaction_hash: TX });
    expect(w.relayed).toHaveLength(1);
  });

  test('disconnect forgets the session and emits disconnect', async () => {
    const w = await backFromKeychain();
    const connector = new KamuiConnector(w.options);
    await connector.connect();
    let disconnected = 0;
    connector.on('disconnect', () => disconnected++);
    await connector.disconnect();
    expect(disconnected).toBe(1);
    expect(await new KamuiConnector(w.options).ready()).toBe(false);
  });
});

describe('under <StarknetConfig>', () => {
  type Seen = {
    reconnect: KamuiReconnect;
    account: ReturnType<typeof useAccount>;
    connect: ReturnType<typeof useConnect>;
    disconnect: ReturnType<typeof useDisconnect>;
    send: ReturnType<typeof useSendTransaction>;
  };

  /** Mounts an app with one Kamui connector and returns what its hooks last returned. */
  async function mount(w: ReturnType<typeof world>, wrap: (app: ReactNode) => ReactNode = (app) => app) {
    const connector = new KamuiConnector(w.options);
    const seen = {} as Seen;
    function Probe() {
      seen.reconnect = useKamuiReconnect(connector);
      seen.account = useAccount();
      seen.connect = useConnect();
      seen.disconnect = useDisconnect();
      seen.send = useSendTransaction({});
      return null;
    }
    const app = createElement(StarknetConfig, {
      chains: [sepolia],
      provider: () => w.node.provider,
      connectors: [connector],
      queryClient: new QueryClient({ defaultOptions: { mutations: { retry: false } } }),
      children: createElement(Probe),
    });
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(wrap(app) as Parameters<typeof create>[0]);
    });
    await settle();
    return { seen, connector, unmount: () => act(() => root.unmount()) };
  }

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
    const { seen, connector, unmount } = await mount(w);
    act(() => seen.connect.connect({ connector }));
    await settle();
    expect(w.tab.navigatedTo).toHaveLength(1);
    expect(w.tab.navigatedTo[0]).toStartWith(`${KEYCHAIN}/connect#kamui=`);
    expect(seen.account.status).toBe('disconnected');
    await unmount();
  });

  test('back from the keychain, useAccount sees the session without a click', async () => {
    const w = await backFromKeychain();
    const { seen, connector, unmount } = await mount(w);
    expect(seen.account.status).toBe('connected');
    expect(BigInt(seen.account.address!)).toBe(BigInt(ACCOUNT));
    expect(seen.account.connector).toBe(connector);
    expect(seen.account.chainId).toBe(BigInt(SEPOLIA));
    expect(seen.account.account?.address).toBe(ACCOUNT);
    expect(seen.reconnect.error).toBeNull();
    expect(w.tab.fragment).toBe('');
    expect(w.tab.navigatedTo).toHaveLength(1);
    await unmount();
  });

  test('a later visit reconnects from storage, also under StrictMode', async () => {
    const w = await backFromKeychain();
    await new KamuiConnector(w.options).ready(); // the page load that consumed the answer
    const { StrictMode } = await import('react');
    const { seen, unmount } = await mount(w, (app) => createElement(StrictMode, null, app));
    expect(seen.account.status).toBe('connected');
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
      error = await seen.send.sendAsync([{ contractAddress: TOKEN, entrypoint: 'transfer', calldata: [ACCOUNT, '0x1', '0x0'] }]).catch((e) => e);
    });
    expect(error).toBeInstanceOf(KamuiWalletError);
    expect((error as KamuiWalletError).code).toBe('OUT_OF_SCOPE');
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

  test('useDisconnect forgets the session', async () => {
    const w = await backFromKeychain();
    const { seen, unmount } = await mount(w);
    await act(async () => {
      await seen.disconnect.disconnectAsync();
    });
    await settle();
    expect(seen.account.status).toBe('disconnected');
    expect(await new KamuiConnector(w.options).ready()).toBe(false);
    await unmount();
  });
});
