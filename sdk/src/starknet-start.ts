// A Kamui session as a wallet-standard wallet, for Starknet Start
// (`@starknetfoundation/starknet-start-react`) and anything else built on get-starknet 6. Import
// from `@kamui/sdk/starknet-start`; the rest of the SDK does not depend on React or on the
// Starknet Start and get-starknet packages.
//
//   const kamui = new KamuiStandardWallet({ keychainUrl, provider, session, sponsor: '/api/kamui/sponsor' });
//   <StarknetConfig extraWallets={[kamui]} …>
//
// `useAccount`, `useSendTransaction`, `useSignTypedData` and the other hooks then see the
// session. Connecting leaves the page (see ./wallet), so the connection has to be picked up
// again on the next page load: call `useKamuiReconnect(kamui)` once under `<StarknetConfig>`.
import { useEffect, useState } from 'react';
import type { WalletWithStarknetFeatures } from '@starknet-io/get-starknet-core';
import { useAccount, useConnect } from '@starknetfoundation/starknet-start-react';
import { KamuiWallet, KamuiWalletError, type KamuiWalletOptions } from './wallet.js';
import type { SessionEnd, WatchSessionOptions } from './watch.js';

// The wallet-standard feature names, as `@wallet-standard/features` and get-starknet export them.
const StandardConnect = 'standard:connect';
const StandardDisconnect = 'standard:disconnect';
const StandardEvents = 'standard:events';
const StarknetWalletApi = 'starknet:walletApi';

type Features = WalletWithStarknetFeatures['features'];
type StandardAccount = WalletWithStarknetFeatures['accounts'][number];
type StandardChain = WalletWithStarknetFeatures['chains'][number];
type ChangeListener = Parameters<Features[typeof StandardEvents]['on']>[1];
type Change = Parameters<ChangeListener>[0];
type ConnectInput = Parameters<Features[typeof StandardConnect]['connect']>[0];
type WalletApiRequest = Features[typeof StarknetWalletApi]['request'];

export type KamuiStandardWalletOptions = {
  /**
   * Watches the session while connected and reports its end (expired, revoked, devices changed)
   * as a `change` event with no accounts, so the app shows the user as disconnected. On by
   * default: one read of the account's events every 30 seconds. Pass `watchSession` options to
   * change the interval or use a WebSocket channel, or `false` to turn it off.
   */
  watch?: boolean | WatchSessionOptions;
};

export class KamuiStandardWallet implements WalletWithStarknetFeatures {
  readonly version = '1.0.0' as const;
  readonly name: string;
  readonly icon: WalletWithStarknetFeatures['icon'];
  /** The session behind the wallet: `error`, `lastApproved`, `approveInKeychain`, `renew`, `connection`. */
  readonly wallet: KamuiWallet;

  private readonly watchOptions: boolean | WatchSessionOptions;
  private readonly listeners = new Set<ChangeListener>();
  /** Accounts are listed only once the app has connected, as the standard asks. */
  private authorized = false;
  private stopWatching: (() => void) | undefined;

  constructor(options: KamuiWalletOptions | KamuiWallet, { watch = true }: KamuiStandardWalletOptions = {}) {
    this.wallet = options instanceof KamuiWallet ? options : new KamuiWallet(options);
    this.name = this.wallet.name;
    this.icon = this.wallet.icon as WalletWithStarknetFeatures['icon'];
    this.watchOptions = watch;
    // Disconnecting, here or on the KamuiWallet itself, and a session that ended while watched.
    this.wallet.on('accountsChanged', (accounts: string[]) => {
      if (accounts.length === 0) this.forget();
    });
  }

  /** How the watched session ended, if it did: `{ reason: 'expired' | 'revoked' | … }`. */
  get lastEnd(): SessionEnd | null {
    return this.wallet.lastEnd;
  }

  /** The session's chain as `starknet:0x…`. Empty until there is a session: its chain is the keychain's. */
  get chains(): StandardChain[] {
    const { connection } = this.wallet;
    return connection ? [`starknet:${connection.chainId}` as StandardChain] : [];
  }

  get accounts(): StandardAccount[] {
    const { connection } = this.wallet;
    if (!this.authorized || !connection) return [];
    return [{ address: connection.account, publicKey: new Uint8Array(), chains: this.chains, features: [] }];
  }

  get features(): Features {
    return {
      [StandardConnect]: { version: '1.0.0', connect: this.connect },
      [StandardDisconnect]: { version: '1.0.0', disconnect: this.disconnect },
      [StandardEvents]: { version: '1.0.0', on: this.on },
      [StarknetWalletApi]: { id: this.wallet.id, version: '1.0.0', walletVersion: this.wallet.version, request: this.request },
    };
  }

  /**
   * With a live session, settles at once with its account. Without one: `silent` settles with
   * no accounts and never leaves the page; otherwise the user is sent to the keychain and this
   * stays pending, because the page is going away.
   */
  private connect = async (input?: ConnectInput): Promise<{ accounts: StandardAccount[] }> => {
    const connection = input?.silent ? ((await this.wallet.resume()) ?? this.wallet.connection) : await this.wallet.connect();
    if (!connection) return { accounts: [] };
    this.authorize();
    return { accounts: this.accounts };
  };

  private disconnect = async (): Promise<void> => {
    // Emits `accountsChanged`, which the constructor turns into a `change` event.
    this.wallet.disconnect();
  };

  private on = ((event: string, listener: ChangeListener) => {
    if (event !== 'change') return () => {};
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }) as Features[typeof StandardEvents]['on'];

  /**
   * The wallet API. Accounts, permissions, the chain, invoke and typed-data signing are served
   * from the session; a request a session cannot serve is refused with a `KamuiWalletError`.
   */
  private request = (async (call: { type: string; params?: unknown }) => {
    switch (call.type) {
      case 'wallet_getPermissions':
        // Silent, like the request for accounts below: asking never leaves the page.
        return (await this.wallet.resume()) || this.wallet.connection ? ['accounts'] : [];
      case 'wallet_requestAccounts': {
        const silent = (call.params as { silent_mode?: boolean } | undefined)?.silent_mode === true;
        const { accounts } = await this.connect({ silent });
        return accounts.map((account) => account.address);
      }
      case 'wallet_requestChainId':
      case 'wallet_switchStarknetChain':
      case 'wallet_addInvokeTransaction':
      case 'wallet_signTypedData':
      case 'wallet_supportedWalletApi':
        return this.wallet.request(call);
      default:
        // Declare, deploy, watch-asset, add-chain, deployment data and the STRK20 requests.
        throw new KamuiWalletError('UNSUPPORTED', `kamui: a session cannot serve ${call.type}`);
    }
  }) as WalletApiRequest;

  private authorize(): void {
    const first = !this.authorized;
    this.authorized = true;
    if (first) this.emit({ accounts: this.accounts, chains: this.chains });
    if (this.watchOptions !== false && !this.stopWatching) {
      this.stopWatching = this.wallet.watch(undefined, this.watchOptions === true ? {} : this.watchOptions);
    }
  }

  private forget(): void {
    this.stopWatching?.();
    this.stopWatching = undefined;
    if (!this.authorized) return;
    this.authorized = false;
    this.emit({ accounts: [] });
  }

  private emit(change: Change): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}

export type KamuiReconnect = {
  /** True until the page load's check for a session has finished. */
  isResuming: boolean;
  /** Why the last trip to the keychain did not succeed, e.g. "keychain: denied by the user". */
  error: string | null;
  /** Hash of a transaction the user approved in the keychain just before this page load. */
  lastApproved: string | null;
};

/**
 * Picks the session up again after a page load, which is how every Kamui connection completes:
 * if the user just came back from the keychain, or a session from an earlier visit is still
 * alive, it connects `wallet` through Starknet Start without a prompt. It never redirects by
 * itself. Call it once, under `<StarknetConfig>`.
 */
export function useKamuiReconnect(wallet: KamuiStandardWallet): KamuiReconnect {
  const { connectAsync } = useConnect();
  const { address } = useAccount();
  const [isResuming, setResuming] = useState(true);

  useEffect(() => {
    let cancelled = false;
    wallet.wallet
      .resume()
      // With a live session `connect` settles at once: nothing here can leave the page.
      .then((connection) => (connection && !address ? connectAsync({ connector: wallet }) : undefined))
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setResuming(false);
      });
    return () => {
      cancelled = true;
    };
    // Once per mount: the answer in the URL is read once per page load anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  return { isResuming, error: isResuming ? null : wallet.wallet.error, lastApproved: isResuming ? null : wallet.wallet.lastApproved };
}

export { KamuiWallet, KamuiWalletError, type KamuiWalletOptions } from './wallet.js';
