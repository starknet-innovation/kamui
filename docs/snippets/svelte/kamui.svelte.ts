// Kamui state for a Svelte 5 app, as a module of runes. Import `kamui` anywhere.
// Call `kamui.init()` once, in the root layout's onMount (it needs the browser).
import { RpcProvider, type Call } from 'starknet';
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
  type Connection,
} from '@kamui/sdk';

export const KEYCHAIN_URL = 'https://sepolia.kamui.page';
export const SPONSOR_URL = '/api/kamui/sponsor'; // your server route, see "Sponsorship"
export const RPC_URL = 'https://YOUR-SEPOLIA-RPC';
export const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
export const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

export const provider = new RpcProvider({ nodeUrl: RPC_URL });
const here = () => `${location.origin}${location.pathname}`;

class Kamui {
  status = $state<'loading' | 'disconnected' | 'connected'>('loading');
  connection = $state<Connection | null>(null);
  error = $state<string | null>(null);
  lastExecuted = $state<string | null>(null);
  #initialised = false;

  /** Reads the keychain's answer, if the user just came back, then checks the session. */
  async init() {
    if (this.#initialised) return;
    this.#initialised = true;
    let fresh: Connection | null = null;
    let approved: Call | null = null;
    try {
      if (pendingRequestKind(localStorage) === 'execute') {
        approved = finishExecute(location.hash, localStorage)?.call ?? null;
      } else {
        fresh = finishConnect(location.hash, localStorage);
      }
    } catch (error) {
      this.error = (error as Error).message;
    }
    if (location.hash.includes('kamui=')) history.replaceState(history.state, '', here() + location.search);
    // The keychain signed the one-off transaction and sent nothing: your sponsor route sends it.
    if (approved) {
      sponsor(SPONSOR_URL, approved).then(
        (hash) => (this.lastExecuted = hash),
        (error) => (this.error = (error as Error).message),
      );
    }

    const current = fresh ?? loadConnection(localStorage);
    if (current && (await isConnectionAlive(current, provider))) {
      this.connection = current;
      this.status = 'connected';
    } else {
      forgetConnection(localStorage);
      this.status = 'disconnected';
    }
  }

  connect() {
    location.assign(
      beginConnect(
        {
          keychainUrl: KEYCHAIN_URL,
          redirectUri: here(),
          appName: 'My game',
          validUntil: Math.floor(Date.now() / 1000) + 24 * 3600,
          maxCalls: 200,
          calls: [
            { to: GAME, entrypoint: 'ping' },
            { to: STRK, entrypoint: 'transfer' },
          ],
          limits: [{ token: STRK, maxPerCall: 10n ** 18n, maxPerWindow: 5n * 10n ** 18n, windowSeconds: 86_400 }],
        },
        localStorage,
      ),
    );
  }

  disconnect() {
    forgetConnection(localStorage);
    this.connection = null;
    this.status = 'disconnected';
  }

  /** Inside the session: signed here, paid for by your sponsor route. Returns the transaction hash. */
  async send(calls: Call[]): Promise<string> {
    if (!this.connection) throw new Error('not connected');
    const prepared = await sessionCall(this.connection, calls, provider);
    if (!prepared) throw new Error('this session has used all its calls: connect again');
    return sponsor(SPONSOR_URL, prepared.call);
  }

  /** Outside the session: the user approves these calls in the keychain. Leaves the page; `init()` sends them on return. */
  execute(calls: Call[]) {
    location.assign(beginExecute({ keychainUrl: KEYCHAIN_URL, redirectUri: here(), appName: 'My game', calls }, localStorage));
  }
}

export const kamui = new Kamui();
