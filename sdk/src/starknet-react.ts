// starknet-react connector for a Kamui session. Import from `@kamui/sdk/starknet-react`; the
// rest of the SDK does not depend on React or `@starknet-react/core`.
//
//   const kamui = new KamuiConnector({ keychainUrl, provider, session, sponsor: '/api/kamui/sponsor' });
//   <StarknetConfig connectors={[kamui]} …>
//
// `useAccount`, `useSendTransaction` and the other hooks then see the session. Connecting leaves
// the page (see ./wallet), so the connection has to be picked up again on the next page load:
// call `useKamuiReconnect(kamui)` once under `<StarknetConfig>`.
import { useEffect, useState } from 'react';
import { Connector, useAccount, useConnect } from '@starknet-react/core';
import type { AccountInterface, ProviderInterface } from 'starknet';
import { KamuiWallet, KamuiWalletError, type KamuiWalletOptions } from './wallet';

type ConnectorData = Awaited<ReturnType<Connector['connect']>>;
type RequestCall = Parameters<Connector['request']>[0];

export class KamuiConnector extends Connector {
  /** The session behind the connector: `error`, `lastApproved`, `approveInKeychain`, `connection`. */
  readonly wallet: KamuiWallet;

  constructor(options: KamuiWalletOptions | KamuiWallet) {
    super();
    this.wallet = options instanceof KamuiWallet ? options : new KamuiWallet(options);
  }

  get id(): string {
    return this.wallet.id;
  }

  get name(): string {
    return this.wallet.name;
  }

  get icon() {
    return { dark: this.wallet.icon, light: this.wallet.icon };
  }

  available(): boolean {
    return this.wallet.available();
  }

  /**
   * Whether there is a live session, including one the user approved just before this page
   * load. Never redirects.
   */
  async ready(): Promise<boolean> {
    return (await this.wallet.resume()) !== null;
  }

  /**
   * With a live session, settles at once. Without one, sends the user to the keychain and stays
   * pending: the page is going away.
   */
  async connect(): Promise<ConnectorData> {
    const connection = await this.wallet.connect();
    const data = { account: connection.account, chainId: BigInt(connection.chainId) };
    this.emit('connect', data);
    return data;
  }

  async disconnect(): Promise<void> {
    this.wallet.disconnect();
    this.emit('disconnect');
  }

  async account(provider: ProviderInterface): Promise<AccountInterface> {
    await this.wallet.resume();
    return this.wallet.account(provider);
  }

  async chainId(): Promise<bigint> {
    await this.wallet.resume();
    const { connection } = this.wallet;
    if (!connection) throw new KamuiWalletError('NOT_CONNECTED', 'kamui: not connected');
    return BigInt(connection.chainId);
  }

  request(call: RequestCall): Promise<any> {
    return this.wallet.request(call);
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
 * alive, it connects `connector` without a prompt. Call it once, under `<StarknetConfig>`.
 *
 * starknet-react's own `autoConnect` cannot do this for the first connection: it remembers a
 * connector only after `connect()` has settled, and here the page is gone before that.
 */
export function useKamuiReconnect(connector: KamuiConnector): KamuiReconnect {
  const { connectAsync } = useConnect();
  const { address } = useAccount();
  const [isResuming, setResuming] = useState(true);

  useEffect(() => {
    let cancelled = false;
    connector
      .ready()
      .then((ready) => (ready && !address ? connectAsync({ connector }) : undefined))
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setResuming(false);
      });
    return () => {
      cancelled = true;
    };
    // Once per mount: the answer in the URL is read once per page load anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector]);

  return { isResuming, error: isResuming ? null : connector.wallet.error, lastApproved: isResuming ? null : connector.wallet.lastApproved };
}

export { KamuiWallet, KamuiWalletError, type KamuiWalletOptions } from './wallet';
