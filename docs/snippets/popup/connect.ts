// Popup mode: connect and approve without leaving the page.
import { KeychainPopupError, connectWithPopup, executeWithPopup, finishConnect, loadConnection, relayPopupResult, sponsor, type Connection } from '@kamui/sdk';

const KEYCHAIN_URL = 'https://sepolia.kamui.page';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const redirectUri = `${location.origin}/`;

/** Call this first, on the page `redirectUri` names. Null with the popup's text shown means this window is the popup: stop there. */
export function start(): Connection | null {
  if (relayPopupResult()) {
    document.body.textContent = 'Done. You can close this window.';
    return null;
  }
  // Only reached with an answer after a redirect, which is what a blocked popup falls back to.
  const connection = finishConnect(location.hash, localStorage) ?? loadConnection(localStorage);
  history.replaceState(null, '', location.pathname);
  return connection;
}

/** Call this directly from a click handler: nothing may be awaited before the popup opens. */
export async function connect(): Promise<Connection | null> {
  try {
    return await connectWithPopup(
      {
        keychainUrl: KEYCHAIN_URL,
        redirectUri,
        appName: 'My game',
        validUntil: Math.floor(Date.now() / 1000) + 24 * 3600,
        maxCalls: 200,
        calls: [{ to: GAME, entrypoint: 'move' }],
      },
      localStorage,
    );
  } catch (error) {
    // `closed`, `timeout`, `aborted`: the user did not answer. Anything else is the keychain's reason.
    if (error instanceof KeychainPopupError) return null;
    throw error;
  }
}

/**
 * One transaction outside the session, approved in a popup. The keychain signs it and sends
 * nothing: your sponsor route (see "Sponsorship") sends it. Returns the transaction hash.
 */
export async function upgrade(): Promise<string> {
  const { call } = await executeWithPopup(
    { keychainUrl: KEYCHAIN_URL, redirectUri, appName: 'My game', calls: [{ contractAddress: GAME, entrypoint: 'upgrade', calldata: [] }] },
    localStorage,
  );
  return sponsor('/api/kamui/sponsor', call);
}
