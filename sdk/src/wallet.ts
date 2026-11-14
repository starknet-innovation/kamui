// A Kamui session behind the standard Starknet wallet interface: an object with `request`, `on`
// and `off` (the get-starknet "window object" shape), so wallet libraries can drive a session
// without knowing about the redirect helpers in ./keychain.
//
// What is different from an extension wallet:
//
//   - Connecting leaves the page. `connect()` sends the user to the keychain and never settles;
//     the answer is picked up by `resume()` on the next page load.
//   - The app holds a session key, not the account. Calls inside the session are signed here and
//     sent without asking; anything else is refused with a `KamuiWalletError`, never silently
//     turned into a prompt.
//
// No React and no wallet library in here. The starknet-react connector is ./starknet-react.
import type { Call, ProviderInterface } from 'starknet';
import {
  beginConnect,
  beginExecute,
  finishConnect,
  finishExecute,
  forgetConnection,
  isConnectionAlive,
  loadConnection,
  pendingRequestKind,
  sessionCall,
  sponsor,
  type ConnectOptions,
  type Connection,
  type KeyValueStore,
} from './keychain';
import { SessionAccount, SessionSigner, createSessionAccount } from './sessionAccount';
import { sameFelt } from './utils';

export const KAMUI_WALLET_ID = 'kamui';

const ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#e2502f"/>' +
      '<path d="M10 7v18M22 7l-9 9 9 9" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

export type KamuiWalletErrorCode =
  /** There is no session. Call `connect()`. */
  | 'NOT_CONNECTED'
  /** A call is not one the session was approved for. `error.calls` lists them. */
  | 'OUT_OF_SCOPE'
  /** The session has used all its `maxCalls` sponsored calls. Connect again for a new one. */
  | 'SESSION_EXHAUSTED'
  /** The session is past its `validUntil`. Connect again for a new one. */
  | 'SESSION_EXPIRED'
  /** A wallet request a session cannot serve (signing messages, declaring, another chain), or a one-off approval with no `sponsor` to send it. */
  | 'UNSUPPORTED';

/** Why the wallet refused, as a `code` to branch on. `name` is always `KamuiWalletError`. */
export class KamuiWalletError extends Error {
  override readonly name = 'KamuiWalletError';

  constructor(
    readonly code: KamuiWalletErrorCode,
    message: string,
    /** For `OUT_OF_SCOPE`: the calls the session does not cover. */
    readonly calls: Call[] = [],
  ) {
    super(message);
  }
}

/** What the wallet needs from the page. The default uses `window`; tests pass their own. */
export type KamuiPage = {
  /** The URL fragment, `#…` included. */
  fragment(): string;
  /** Removes the keychain's answer from the address bar. */
  clearFragment(): void;
  /** Where the keychain sends the user back to. No fragment. */
  redirectUri(): string;
  /** Leaves the page. */
  navigate(url: string): void;
};

export function browserPage(): KamuiPage {
  const here = () => `${window.location.origin}${window.location.pathname}`;
  return {
    fragment: () => window.location.hash,
    clearFragment: () => window.history.replaceState(null, '', here() + window.location.search),
    redirectUri: here,
    navigate: (url) => window.location.assign(url),
  };
}

export type KamuiSessionRequest = Omit<ConnectOptions, 'keychainUrl' | 'redirectUri'>;

export type KamuiWalletOptions = {
  /** The keychain, e.g. `https://sepolia.kamui.page`. */
  keychainUrl: string;
  /** Reads the account: whether the session is alive, and its next sponsored nonce. */
  provider: ProviderInterface;
  /** The session to ask for. A function is called at connect time, so `validUntil` can be relative to now. */
  session: KamuiSessionRequest | (() => KamuiSessionRequest);
  /**
   * How calls are paid for. A URL is your sponsor route (`POST { account, calldata }`); a
   * function hands the signed outside execution to your own relayer and returns the transaction
   * hash. Leave it out for self-paid session transactions, which need `maxFeePerTx` above zero
   * and STRK on the account.
   *
   * A transaction approved in the keychain (`approveInKeychain`) comes back signed and unsent,
   * and goes through this too: it has no self-paid path.
   */
  sponsor?: string | ((call: Call) => Promise<string>);
  /** Where the session key and connection are kept. Defaults to `localStorage`. */
  store?: KeyValueStore;
  /** Defaults to `browserPage()`. */
  page?: KamuiPage;
};

/** The calls of a `wallet_addInvokeTransaction` request. */
type WalletApiCall = { contract_address: string; entry_point: string; calldata?: string[] };
type WalletRequest = { type: string; params?: unknown };
type WalletEvent = 'accountsChanged' | 'networkChanged';
type WalletListener = (...args: any[]) => void;

/** The calls of `calls` that `connection`'s session was not approved for. Empty if the scope is unknown. */
export function callsOutsideSession(connection: Connection, calls: Call[]): Call[] {
  const scope = connection.session.calls;
  if (!scope) return [];
  return calls.filter((call) => !scope.some((allowed) => allowed.entrypoint === call.entrypoint && sameFelt(allowed.to, call.contractAddress)));
}

export class KamuiWallet {
  readonly id = KAMUI_WALLET_ID;
  readonly name = 'Kamui';
  readonly version = '1';
  readonly icon = ICON;

  private readonly options: KamuiWalletOptions;
  private current: Connection | null = null;
  private resuming: Promise<Connection | null> | undefined;
  private resumeError: string | null = null;
  private approved: string | null = null;
  /** Where the scan for the next sponsored nonce starts. */
  private nonceOffset = 0;
  /** Sponsored calls go one at a time, so two of them never sign the same nonce. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners: Record<WalletEvent, Set<WalletListener>> = { accountsChanged: new Set(), networkChanged: new Set() };

  constructor(options: KamuiWalletOptions) {
    this.options = options;
    // get-starknet and starknet.js call these detached from the object.
    this.request = this.request.bind(this);
    this.on = this.on.bind(this);
    this.off = this.off.bind(this);
  }

  private get store(): KeyValueStore {
    return this.options.store ?? globalThis.localStorage;
  }

  private get page(): KamuiPage {
    return this.options.page ?? browserPage();
  }

  /** False on a server, where there is no page to redirect and nowhere to keep the session. */
  available(): boolean {
    if (this.options.store && this.options.page) return true;
    return typeof window !== 'undefined' && typeof globalThis.localStorage !== 'undefined';
  }

  /** The live session, once `resume()` or `connect()` has found one. */
  get connection(): Connection | null {
    return this.current;
  }

  /** Why the last trip to the keychain did not succeed, e.g. "keychain: denied by the user". */
  get error(): string | null {
    return this.resumeError;
  }

  /**
   * Hash of the transaction the user approved in the keychain just before this page load, once
   * `resume()` has sent it through `sponsor`. Null if sending failed: the reason is in `error`.
   */
  get lastApproved(): string | null {
    return this.approved;
  }

  /**
   * Picks up where the page left off. Run once per page load (later calls return the same
   * result): reads the keychain's answer from the URL fragment if the user just came back, removes
   * it from the address bar, loads the stored connection and checks on chain that the session is
   * still alive. If the answer is a transaction the user approved (`approveInKeychain`), it is
   * sent here, once, through `sponsor`. Never redirects and never throws: a refusal, or a
   * failure to send, is in `error`.
   */
  resume(): Promise<Connection | null> {
    this.resuming ??= this.readPage().then((connection) => (this.current = connection));
    return this.resuming;
  }

  private async readPage(): Promise<Connection | null> {
    if (!this.available()) return null;
    const { store, page } = this;
    const fragment = page.fragment();
    let fresh: Connection | null = null;
    let approved: Call | null = null;
    try {
      if (pendingRequestKind(store) === 'execute') {
        approved = finishExecute(fragment, store)?.call ?? null;
      } else {
        fresh = finishConnect(fragment, store);
      }
    } catch (error) {
      this.resumeError = (error as Error).message;
    }
    // Before sending: a reload must not find the approval again.
    if (fragment.includes('kamui=')) page.clearFragment();
    // The keychain signed the transaction and sent nothing: the app that asked pays for it.
    if (approved) {
      const { sponsor: route } = this.options;
      try {
        if (route === undefined) throw new Error('no sponsor is configured');
        this.approved = typeof route === 'string' ? await sponsor(route, approved) : await route(approved);
      } catch (error) {
        this.resumeError = `could not send the approved transaction: ${(error as Error).message}`;
      }
    }

    const connection = fresh ?? loadConnection(store);
    if (!connection) return null;
    try {
      // A session ends when it expires, when it is revoked, and when the user adds or removes a device.
      if (await isConnectionAlive(connection, this.options.provider)) return connection;
      forgetConnection(store);
      return null;
    } catch (error) {
      // The node could not be asked. Keep the stored session: it may well be alive.
      this.resumeError = `could not check the session: ${(error as Error).message}`;
      return null;
    }
  }

  /**
   * The session, asking the user for one if there is none. With a live session this settles at
   * once. Without one it sends the user to the keychain and never settles: the page is going
   * away, and `resume()` finishes the job when the user is back.
   */
  async connect(): Promise<Connection> {
    const existing = await this.resume();
    if (existing) return existing;
    if (this.current) return this.current;
    const { session } = this.options;
    const request = typeof session === 'function' ? session() : session;
    const url = beginConnect({ ...request, keychainUrl: this.options.keychainUrl, redirectUri: this.page.redirectUri() }, this.store);
    this.page.navigate(url);
    return new Promise<never>(() => {});
  }

  /** Forgets the session key. The session itself stays on the account until it expires or the user revokes it. */
  disconnect(): void {
    if (this.available()) forgetConnection(this.store);
    this.current = null;
    this.nonceOffset = 0;
    this.resuming = Promise.resolve(null);
    this.emit('accountsChanged', []);
  }

  private connected(): Connection {
    if (!this.current) throw new KamuiWalletError('NOT_CONNECTED', 'kamui: not connected');
    return this.current;
  }

  /**
   * Sends calls inside the session: signed here with the session key, no prompt. Throws a
   * `KamuiWalletError` before anything is sent when a call is outside the session
   * (`OUT_OF_SCOPE`), when the session has expired (`SESSION_EXPIRED`) or when it has used all
   * its sponsored calls (`SESSION_EXHAUSTED`).
   */
  async execute(calls: Call | Call[]): Promise<{ transaction_hash: string }> {
    const connection = this.connected();
    const list = Array.isArray(calls) ? calls : [calls];
    if (connection.session.validUntil <= Math.floor(Date.now() / 1000)) {
      throw new KamuiWalletError('SESSION_EXPIRED', 'kamui: this session has expired: connect again');
    }
    const outside = callsOutsideSession(connection, list);
    if (outside.length > 0) {
      const names = outside.map((call) => `${call.entrypoint} on ${call.contractAddress}`).join(', ');
      throw new KamuiWalletError(
        'OUT_OF_SCOPE',
        `kamui: the session does not cover ${names}. Ask for it when connecting, or have it approved in the keychain (approveInKeychain).`,
        outside,
      );
    }

    const { sponsor: route, provider } = this.options;
    if (route === undefined) {
      const account = createSessionAccount({
        provider,
        address: connection.account,
        sessionPrivateKey: connection.session.privateKey,
        validUntil: connection.session.validUntil,
      });
      const { transaction_hash } = await account.execute(list);
      return { transaction_hash };
    }

    const send = async () => {
      const prepared = await sessionCall(connection, list, provider, this.nonceOffset);
      if (!prepared) {
        throw new KamuiWalletError(
          'SESSION_EXHAUSTED',
          `kamui: this session has used all its ${connection.session.maxCalls} calls: connect again`,
        );
      }
      // If sending fails the nonce is still free: the next scan starts on it again.
      this.nonceOffset = prepared.offset;
      const transaction_hash = typeof route === 'string' ? await sponsor(route, prepared.call) : await route(prepared.call);
      this.nonceOffset = prepared.offset + 1;
      return { transaction_hash };
    };
    const result = this.queue.then(send, send);
    this.queue = result.catch(() => {});
    return result;
  }

  /**
   * Sends the user to the keychain to approve one transaction with the account's full
   * authority: the way to make a call the session does not cover. Leaves the page and never
   * settles. The keychain signs the transaction and returns it unsent; after the user is back,
   * `resume()` sends it through `sponsor` and puts the transaction hash in `lastApproved`.
   * Refused with `UNSUPPORTED` when no `sponsor` is configured: nothing could send the approval.
   */
  approveInKeychain(calls: Call[], appName?: string): Promise<never> {
    this.connected();
    if (this.options.sponsor === undefined) {
      throw new KamuiWalletError('UNSUPPORTED', 'kamui: a transaction approved in the keychain is sent through `sponsor`, and none is configured');
    }
    const url = beginExecute({ keychainUrl: this.options.keychainUrl, redirectUri: this.page.redirectUri(), appName, calls }, this.store);
    this.page.navigate(url);
    return new Promise<never>(() => {});
  }

  /**
   * A starknet.js account for the session. `execute` goes through this wallet (sponsored if a
   * sponsor is configured, with the same refusals); everything else is the plain session account.
   */
  account(provider: ConstructorParameters<typeof SessionAccount>[0]['provider'] = this.options.provider): SessionAccount {
    const connection = this.connected();
    const wallet = this;
    class KamuiAccount extends SessionAccount {
      override execute(transactions: Call | Call[]) {
        return wallet.execute(transactions);
      }
    }
    return new KamuiAccount({
      provider,
      address: connection.account,
      signer: new SessionSigner(connection.session.privateKey, connection.session.validUntil),
    });
  }

  /**
   * The wallet API (`wallet_requestAccounts`, `wallet_addInvokeTransaction`, …). A request for
   * accounts without `silent_mode` connects, so it may leave the page.
   */
  async request(call: WalletRequest): Promise<any> {
    const params = (call.params ?? {}) as Record<string, unknown>;
    switch (call.type) {
      case 'wallet_getPermissions':
        return (await this.resume()) || this.current ? ['accounts'] : [];
      case 'wallet_requestAccounts': {
        const connection = (await this.resume()) ?? this.current;
        if (connection) return [connection.account];
        if (params.silent_mode === true) return [];
        return [(await this.connect()).account];
      }
      case 'wallet_requestChainId':
        return this.connected().chainId;
      case 'wallet_switchStarknetChain': {
        if (typeof params.chainId === 'string' && sameFelt(params.chainId, this.connected().chainId)) return true;
        throw new KamuiWalletError('UNSUPPORTED', 'kamui: a session belongs to one chain and cannot switch');
      }
      case 'wallet_addInvokeTransaction': {
        const calls = (params.calls ?? []) as WalletApiCall[];
        return this.execute(calls.map((c) => ({ contractAddress: c.contract_address, entrypoint: c.entry_point, calldata: c.calldata ?? [] })));
      }
      case 'wallet_supportedWalletApi':
        return ['0.7'];
      default:
        throw new KamuiWalletError('UNSUPPORTED', `kamui: a session cannot serve ${call.type}`);
    }
  }

  on(event: WalletEvent, handler: WalletListener): void {
    this.listeners[event]?.add(handler);
  }

  off(event: WalletEvent, handler: WalletListener): void {
    this.listeners[event]?.delete(handler);
  }

  private emit(event: WalletEvent, ...args: unknown[]): void {
    for (const handler of this.listeners[event]) handler(...args);
  }
}

/**
 * Makes the wallet discoverable the way extension wallets are (`window.starknet_kamui`), for
 * get-starknet v4 and anything else that scans for `starknet_*` objects.
 */
export function injectKamuiWallet(wallet: KamuiWallet, target: Record<string, unknown> = globalThis as Record<string, unknown>): void {
  target[`starknet_${wallet.id}`] = wallet;
}
