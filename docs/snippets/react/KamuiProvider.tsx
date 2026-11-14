import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Call } from 'starknet';
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
import { KEYCHAIN_URL, SPONSOR_URL, provider, sessionRequest } from './kamui';

type Status = 'loading' | 'disconnected' | 'connected';

type KamuiState = {
  status: Status;
  connection: Connection | null;
  /** The last keychain answer that was not a success, e.g. "denied by the user" or "cancelled by the user". */
  error: string | null;
  /** Hash of a one-off transaction the user just approved in the keychain. */
  lastExecuted: string | null;
  connect(): void;
  disconnect(): void;
  /** Sends calls inside the session, signed here and paid for by your sponsor route. */
  send(calls: Call[]): Promise<string>;
  /** Sends the user to the keychain to approve calls outside the session. Leaves the page. */
  execute(calls: Call[]): void;
};

const KamuiContext = createContext<KamuiState | null>(null);

// localStorage keeps the session across tabs and reloads. sessionStorage forgets it with the tab.
const store = () => window.localStorage;
const here = () => `${window.location.origin}${window.location.pathname}`;

/**
 * Reads the keychain's answer from the URL fragment, once per page load, and removes it from the
 * address bar. Kept outside React so StrictMode's double effects cannot read it twice.
 */
let answer: { connection: Connection | null; executed: string | null; error: string | null } | undefined;
function readAnswer() {
  if (answer) return answer;
  answer = { connection: null, executed: null, error: null };
  const fragment = window.location.hash;
  try {
    if (pendingRequestKind(store()) === 'execute') {
      answer.executed = finishExecute(fragment, store())?.transactionHash ?? null;
    } else {
      answer.connection = finishConnect(fragment, store());
    }
  } catch (error) {
    answer.error = (error as Error).message;
  }
  if (fragment.includes('kamui=')) window.history.replaceState(null, '', here() + window.location.search);
  return answer;
}

export function KamuiProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastExecuted, setLastExecuted] = useState<string | null>(null);

  useEffect(() => {
    const { connection: fresh, executed, error } = readAnswer();
    setError(error);
    setLastExecuted(executed);
    const current = fresh ?? loadConnection(store());
    if (!current) return setStatus('disconnected');
    // A session ends when it expires, when it is revoked, and when the user adds or removes a device.
    isConnectionAlive(current, provider).then((alive) => {
      if (!alive) forgetConnection(store());
      setConnection(alive ? current : null);
      setStatus(alive ? 'connected' : 'disconnected');
    });
  }, []);

  const connect = useCallback(() => {
    window.location.assign(beginConnect({ ...sessionRequest(), keychainUrl: KEYCHAIN_URL, redirectUri: here() }, store()));
  }, []);

  const disconnect = useCallback(() => {
    forgetConnection(store());
    setConnection(null);
    setStatus('disconnected');
  }, []);

  const send = useCallback(
    async (calls: Call[]) => {
      if (!connection) throw new Error('not connected');
      const prepared = await sessionCall(connection, calls, provider);
      if (!prepared) throw new Error('this session has used all its calls: connect again');
      return sponsor(SPONSOR_URL, prepared.call);
    },
    [connection],
  );

  const execute = useCallback((calls: Call[]) => {
    window.location.assign(beginExecute({ keychainUrl: KEYCHAIN_URL, redirectUri: here(), appName: 'My game', calls }, store()));
  }, []);

  return (
    <KamuiContext.Provider value={{ status, connection, error, lastExecuted, connect, disconnect, send, execute }}>
      {children}
    </KamuiContext.Provider>
  );
}

export function useKamui(): KamuiState {
  const value = useContext(KamuiContext);
  if (!value) throw new Error('useKamui must be used inside <KamuiProvider>');
  return value;
}
