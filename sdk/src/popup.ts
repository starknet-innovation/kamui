// Popup mode: the keychain's redirects, there and back, run in a popup window instead of the app's own tab,
// so the app's page stays loaded and gets a promise.
//
//   app page                              popup
//   connectWithPopup() ── window.open ──▶ keychain /connect#kamui=<request>
//        │                                (sign-in at the issuer if needed, then approval)
//        │                                keychain sends the popup to redirectUri#kamui=<answer>
//        │                                app's own page, in the popup: relayPopupResult()
//        ◀── BroadcastChannel (same origin only) ──┘  then the popup closes
//
// The keychain does nothing different: it reads the request from the fragment, checks that the
// referrer is on the origin of `redirectUri`, and navigates to `redirectUri` with the answer.
// The answer therefore still only ever reaches a page on the origin that asked. What is new is
// the last hop, from the app's page in the popup to the app's page that opened it, and that hop
// is a BroadcastChannel, which browsers deliver to the same origin only.
//
// Nothing relies on `window.opener` surviving. A sign-in at an issuer that sets
// Cross-Origin-Opener-Policy cuts the link between the two windows for good: the popup loses
// `window.opener`, and the app's handle on the popup reports `closed` although the window is
// still open. So the answer travels by BroadcastChannel, and the keychain tells the opener when
// it is about to leave for the issuer, after which `closed` is no longer believed.
//
// A blocked popup falls back to the full-page redirect, unless the app asks otherwise.
import type { Call, TypedData } from 'starknet';
import {
  beginConnect,
  beginExecute,
  beginSignMessage,
  finishConnect,
  finishExecute,
  finishSignMessage,
  fragmentId,
  type ConnectOptions,
  type Connection,
  type KeyValueStore,
} from './keychain';

/** Added to `redirectUri` in popup mode: tells the app's page that it is the popup. */
export const POPUP_MARKER = 'kamui_popup';
/** The BroadcastChannel the popup's last page answers on. */
export const POPUP_CHANNEL = 'kamui.popup';
/** `kamui` field of the note the keychain posts to its opener before it leaves for the issuer. */
export const POPUP_LEAVING = 'leaving-for-issuer';

const POPUP_RESULT = 'popup-result';

export type PopupFailure =
  /** The browser refused to open the popup and the fallback was turned off. */
  | 'blocked'
  /** The user closed the popup before answering. */
  | 'closed'
  /** No answer within `timeoutMs`. */
  | 'timeout'
  /** The app's `signal` was aborted. */
  | 'aborted';

/** Why a popup request ended without an answer from the keychain. */
export class KeychainPopupError extends Error {
  readonly code: PopupFailure;
  constructor(code: PopupFailure, message: string) {
    super(message);
    this.name = 'KeychainPopupError';
    this.code = code;
  }
}

/** What popup mode needs from the browser. The default reads the page's globals; tests pass their own. */
export type PopupEnvironment = {
  /** This page's origin. */
  origin: string;
  /** `window.open`. Null when the browser blocked the popup. */
  open(url: string, name: string, features: string): { readonly closed: boolean; close(): void } | null;
  /** Leaves the page, for the redirect fallback. */
  navigate(url: string): void;
  /** Subscribes to this window's `message` events. Returns how to unsubscribe. */
  onWindowMessage(listener: (event: { origin: string; data: unknown }) => void): () => void;
  /** Subscribes to a BroadcastChannel. Returns how to close it, or null where there is none. */
  onBroadcast(name: string, listener: (data: unknown) => void): (() => void) | null;
};

export type PopupOptions = {
  /** How long to wait for the answer. Default: 10 minutes. */
  timeoutMs?: number;
  /** Aborting it closes the popup and rejects with `aborted`. */
  signal?: AbortSignal;
  /**
   * What to do when the browser blocks the popup. `redirect` (the default) does the full-page
   * redirect instead: the page leaves, the promise never settles, and the app finishes with
   * `finishConnect` / `finishExecute` when the user comes back. `none` rejects with `blocked`.
   */
  fallback?: 'redirect' | 'none';
  /** The popup's `window.open` features. Never include `noopener` or `noreferrer`: the keychain needs the referrer. */
  features?: string;
  /** How often the popup is checked for having been closed. Default: 500 ms. */
  pollMs?: number;
  /** How long after the popup closed an answer is still awaited. Default: 1000 ms. */
  closedGraceMs?: number;
  environment?: PopupEnvironment;
};

function browserEnvironment(): PopupEnvironment {
  return {
    origin: location.origin,
    open: (url, name, features) => window.open(url, name, features),
    navigate: (url) => location.assign(url),
    onWindowMessage(listener) {
      const handler = (event: MessageEvent) => listener({ origin: event.origin, data: event.data });
      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    },
    onBroadcast(name, listener) {
      if (typeof BroadcastChannel === 'undefined') return null;
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event) => listener(event.data);
      return () => channel.close();
    },
  };
}

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** `redirectUri` with the marker that makes the app's page relay the answer instead of using it. */
export function popupRedirectUri(redirectUri: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set(POPUP_MARKER, '1');
  return url.toString();
}

/**
 * Opens `url` in a popup and waits for the answer to request `id`. Resolves with the answer's
 * fragment. Returns null, having opened nothing, when the browser blocked the popup.
 *
 * Must be called synchronously from a click or key handler, or the browser blocks the popup.
 */
function awaitPopup(url: string, id: string, options: PopupOptions, environment: PopupEnvironment): Promise<string> | null {
  const keychainOrigin = new URL(url).origin;
  let popup: { readonly closed: boolean; close(): void } | null;
  try {
    popup = environment.open(url, `kamui-${id}`, options.features ?? 'popup,width=480,height=720');
  } catch {
    popup = null;
  }
  // Some blockers hand back a window that is already closed.
  if (!popup || popup.closed) return null;
  const opened = popup;

  return new Promise<string>((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    let settled = false;
    let closedIsReliable = true;
    const settle = (act: () => void) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      try {
        opened.close();
      } catch { /* already gone, or no longer ours to close */ }
      act();
    };
    const fail = (code: PopupFailure, message: string) => settle(() => reject(new KeychainPopupError(code, message)));

    /** An answer relayed by the app's own page in the popup. Anything else, or for another request, is ignored. */
    const onRelay = (data: unknown) => {
      const message = data as { kamui?: unknown; fragment?: unknown } | null;
      if (typeof message !== 'object' || message === null || message.kamui !== POPUP_RESULT || typeof message.fragment !== 'string') return;
      if (fragmentId(message.fragment) !== id) return;
      const fragment = message.fragment;
      settle(() => resolve(fragment));
    };

    const closeChannel = environment.onBroadcast(POPUP_CHANNEL, onRelay);
    if (closeChannel) cleanups.push(closeChannel);
    cleanups.push(
      environment.onWindowMessage((event) => {
        // From this origin: the relay, by `window.opener` where that still exists.
        if (event.origin === environment.origin) return onRelay(event.data);
        // From the keychain: it is leaving for the issuer, which may cut the link to the popup.
        const note = event.data as { kamui?: unknown; id?: unknown } | null;
        if (event.origin === keychainOrigin && typeof note === 'object' && note !== null && note.kamui === POPUP_LEAVING && note.id === id) {
          closedIsReliable = false;
        }
      }),
    );

    const timeout = setTimeout(() => fail('timeout', 'keychain: no answer from the popup in time'), options.timeoutMs ?? 10 * 60_000);
    cleanups.push(() => clearTimeout(timeout));

    let grace: ReturnType<typeof setTimeout> | undefined;
    const poll = setInterval(() => {
      if (!closedIsReliable || grace !== undefined || !opened.closed) return;
      // The relay closes the popup right after answering: give its answer time to arrive.
      grace = setTimeout(() => {
        if (closedIsReliable) fail('closed', 'keychain: the popup was closed before answering');
      }, options.closedGraceMs ?? 1000);
    }, options.pollMs ?? 500);
    cleanups.push(() => clearInterval(poll), () => clearTimeout(grace));

    const signal = options.signal;
    if (signal) {
      const onAbort = () => fail('aborted', 'keychain: the request was cancelled');
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
      cleanups.push(() => signal.removeEventListener('abort', onAbort));
    }
  });
}

/**
 * One request in a popup. `begin` builds the request for a redirect address and notes it in a
 * store; `finish` reads the answer against that note. In the popup the note stays in memory;
 * for the redirect fallback it goes to the app's store, as without popup mode.
 */
function viaPopup<T>(
  begin: (redirectUri: string, store: KeyValueStore) => string,
  finish: (fragment: string, pending: KeyValueStore) => T | null,
  redirectUri: string,
  store: KeyValueStore,
  popup: PopupOptions,
): Promise<T> {
  const environment = popup.environment ?? browserEnvironment();
  const pending = memoryStore();
  const url = begin(popupRedirectUri(redirectUri), pending);
  const answer = awaitPopup(url, fragmentId(new URL(url).hash)!, popup, environment);
  if (answer) return answer.then((fragment) => finish(fragment, pending)!);
  if (popup.fallback === 'none') return Promise.reject(new KeychainPopupError('blocked', 'keychain: the browser blocked the popup'));
  environment.navigate(begin(redirectUri, store));
  return new Promise(() => {});
}

/**
 * App side: connects through the keychain in a popup. Resolves with the connection, which is
 * also saved in `store` as `finishConnect` would. The page is not reloaded.
 *
 * Call it directly from a click handler, with nothing awaited before it, or the browser blocks
 * the popup. `options.redirectUri` must be a page of this app that calls `relayPopupResult()`
 * when it loads.
 *
 * Rejects with the keychain's reason if the user refused, and with a `KeychainPopupError` if
 * the popup was closed, timed out, was cancelled, or was blocked with the fallback turned off.
 * With the default fallback a blocked popup becomes the usual redirect: the page leaves and the
 * promise never settles.
 */
export function connectWithPopup(options: ConnectOptions, store: KeyValueStore, popup: PopupOptions = {}): Promise<Connection> {
  return viaPopup(
    (redirectUri, pending) => beginConnect({ ...options, redirectUri }, pending),
    // The pending request, with the session's private key, is read from this page's memory;
    // only the connection is written to the app's store.
    (fragment, pending) =>
      finishConnect(fragment, { getItem: (key) => pending.getItem(key), setItem: (key, value) => store.setItem(key, value), removeItem: (key) => pending.removeItem(key) }),
    options.redirectUri,
    store,
    popup,
  );
}

/**
 * App side: asks the user to approve one transaction in a popup. Resolves with the transaction
 * hash once the network has accepted it. Same rules and failures as `connectWithPopup`; with
 * the redirect fallback the app finishes with `finishExecute` when the user comes back.
 */
export function executeWithPopup(
  options: { keychainUrl: string; redirectUri: string; appName?: string; calls: Call[] },
  store: KeyValueStore,
  popup: PopupOptions = {},
): Promise<{ transactionHash: string }> {
  return viaPopup((redirectUri, pending) => beginExecute({ ...options, redirectUri }, pending), finishExecute, options.redirectUri, store, popup);
}

/**
 * App side: asks the user to sign one message in a popup. Resolves with the account, its
 * network and the owner's signature; verify it as after `finishSignMessage`. Same rules and
 * failures as `connectWithPopup`; with the redirect fallback the app finishes with
 * `finishSignMessage` when the user comes back.
 */
export function signMessageWithPopup(
  options: { keychainUrl: string; redirectUri: string; appName?: string; typedData: TypedData },
  store: KeyValueStore,
  popup: PopupOptions = {},
): Promise<{ account: string; chainId: string; signature: string[] }> {
  return viaPopup((redirectUri, pending) => beginSignMessage({ ...options, redirectUri }, pending), finishSignMessage, options.redirectUri, store, popup);
}

/** What `relayPopupResult` needs from the browser. The default reads the page's globals. */
export type RelayEnvironment = {
  /** `location.search`, `location.hash` and `location.origin` of this page. */
  search: string;
  fragment: string;
  origin: string;
  /** Posts on a BroadcastChannel. Does nothing where there is none. */
  broadcast(name: string, data: unknown): void;
  /** `window.opener`, when the browser kept it. */
  opener: { postMessage(data: unknown, targetOrigin: string): void } | null;
  /** Takes the answer out of the address bar. */
  clearFragment(): void;
  /** Closes this window, shortly after the answer has been posted. */
  close(): void;
};

function browserRelayEnvironment(): RelayEnvironment {
  return {
    search: location.search,
    fragment: location.hash,
    origin: location.origin,
    broadcast(name, data) {
      if (typeof BroadcastChannel === 'undefined') return;
      const channel = new BroadcastChannel(name);
      channel.postMessage(data);
      channel.close();
    },
    opener: window.opener,
    clearFragment: () => history.replaceState(null, '', location.pathname + location.search),
    close: () => void setTimeout(() => window.close(), 100),
  };
}

/**
 * App side, in the popup: call this first thing on the page `redirectUri` names. When the page
 * is the end of a popup request, it hands the keychain's answer to the page that opened the
 * popup, closes the window and returns true: the app should then draw nothing else. Returns
 * false on any other visit, and the page carries on as usual.
 *
 * The answer is only posted to this page's own origin, and the page that asked checks it
 * against its pending request, as `finishConnect` does after a redirect. If the browser will
 * not let the window close itself, it stays open: show a line asking the user to close it.
 */
export function relayPopupResult(environment: RelayEnvironment = browserRelayEnvironment()): boolean {
  if (!new URLSearchParams(environment.search).has(POPUP_MARKER)) return false;
  if (fragmentId(environment.fragment) === null) return false;
  const message = { kamui: POPUP_RESULT, fragment: environment.fragment };
  environment.broadcast(POPUP_CHANNEL, message);
  // A second road for an app that is itself framed, where its BroadcastChannel is partitioned
  // away from the popup's. Only works while the popup still has its opener.
  try {
    environment.opener?.postMessage(message, environment.origin);
  } catch { /* the opener is gone */ }
  environment.clearFragment();
  environment.close();
  return true;
}
