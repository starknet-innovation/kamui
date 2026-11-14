// Popup mode: the answer reaches only the request it belongs to and only from the app's own
// origin, a blocked popup falls back to the redirect, and a popup that goes away ends the wait.
import { describe, expect, test } from 'bun:test';
import {
  KeychainPopupError,
  POPUP_CHANNEL,
  POPUP_LEAVING,
  POPUP_MARKER,
  connectWithPopup,
  executeWithPopup,
  signMessageWithPopup,
  parseSignMessageRequest,
  finishConnect,
  fragmentId,
  loadConnection,
  parseConnectRequest,
  parseExecuteRequest,
  pendingRequestKind,
  popupRedirectUri,
  relayPopupResult,
  toFragment,
  type ConnectOptions,
  type ConnectResult,
  type ExecuteResult,
  type KeyValueStore,
  type PopupEnvironment,
  type RelayEnvironment,
} from '../src';

const APP = 'https://game.example';
const KEYCHAIN = 'https://keychain.example';
const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const options: ConnectOptions = {
  keychainUrl: KEYCHAIN,
  redirectUri: `${APP}/play`,
  appName: 'Example Game',
  validUntil: FUTURE,
  maxCalls: 20,
  calls: [{ to: GAME, entrypoint: 'move' }],
};

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** A browser as popup mode sees it: one popup at most, and the two ways a message can arrive. */
function fakeBrowser({ blocked = false } = {}) {
  const windowListeners = new Set<(event: { origin: string; data: unknown }) => void>();
  const broadcastListeners = new Set<(data: unknown) => void>();
  const opened: { url: string; name: string; features: string }[] = [];
  const navigated: string[] = [];
  const popup = { closed: false, closes: 0, close() { this.closed = true; this.closes += 1; } };
  /** A message on the app origin's BroadcastChannel. */
  const broadcast = (data: unknown) => {
    for (const listener of [...broadcastListeners]) listener(data);
  };
  const environment: PopupEnvironment = {
    origin: APP,
    open(url, name, features) {
      if (blocked) return null;
      opened.push({ url, name, features });
      return popup;
    },
    navigate: (url) => void navigated.push(url),
    onWindowMessage(listener) {
      windowListeners.add(listener);
      return () => void windowListeners.delete(listener);
    },
    onBroadcast(name, listener) {
      if (name !== POPUP_CHANNEL) throw new Error(`unexpected channel ${name}`);
      broadcastListeners.add(listener);
      return () => void broadcastListeners.delete(listener);
    },
  };
  return {
    opened,
    navigated,
    popup,
    windowListeners,
    broadcastListeners,
    broadcast,
    environment,
    /** A `message` event on the app's window. */
    post(origin: string, data: unknown) {
      for (const listener of [...windowListeners]) listener({ origin, data });
    },
    /** The app's page in the popup, at `redirectUri` with the keychain's answer. */
    relay(url: string, opener: RelayEnvironment['opener'] = null) {
      const at = new URL(url);
      return relayPopupResult({
        search: at.search,
        fragment: at.hash,
        origin: at.origin,
        broadcast: (name, data) => void (name === POPUP_CHANNEL && broadcast(data)),
        opener,
        clearFragment() {},
        close: () => void (popup.closed = true),
      });
    },
  };
}

const fast = { pollMs: 5, closedGraceMs: 20 };
const approved = (id: string): ConnectResult => ({ v: 1, id, ok: true, account: ACCOUNT, chainId: '0x534e5f5345504f4c4941', classHash: '0x123' });
/** The request the keychain reads from the popup's address, sent from a page of the app. */
const requestIn = (url: string) => parseConnectRequest(new URL(url).hash, `${APP}/play`)!;
const failure = async (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a rejection'); }, (error) => error as KeychainPopupError);

describe('popup mode: connecting', () => {
  test('the keychain accepts the popup request and its answer comes back as a connection', async () => {
    const browser = fakeBrowser();
    const store = memoryStore();
    const connecting = connectWithPopup(options, store, { environment: browser.environment });

    expect(browser.opened).toHaveLength(1);
    const { url, features } = browser.opened[0]!;
    expect(url.startsWith(`${KEYCHAIN}/connect#kamui=`)).toBe(true);
    expect(features).not.toContain('noopener');
    expect(features).not.toContain('noreferrer');
    // The same checks as a redirect: the request names the app's origin and came from it.
    const request = requestIn(url);
    expect(request.redirectUri).toBe(`${APP}/play?${POPUP_MARKER}=1`);
    expect(() => parseConnectRequest(new URL(url).hash, 'https://evil.example/')).toThrow('not sent by the site it names');
    // Nothing about the pending request, and so no session key, is written to the app's store.
    expect(store.data.size).toBe(0);

    expect(browser.relay(request.redirectUri + toFragment(approved(request.id)))).toBe(true);
    const connection = await connecting;
    expect(connection.account).toBe(ACCOUNT);
    expect(connection.session.publicKey).toBe(request.session.publicKey);
    expect(loadConnection(store)).toEqual(connection);
    expect(pendingRequestKind(store)).toBeNull();
    expect(browser.popup.closed).toBe(true);
    expect(browser.navigated).toEqual([]);
    // Nothing is left listening.
    expect(browser.windowListeners.size).toBe(0);
    expect(browser.broadcastListeners.size).toBe(0);
  });

  test('a refusal rejects with the keychain\'s reason', async () => {
    const browser = fakeBrowser();
    const store = memoryStore();
    const connecting = connectWithPopup(options, store, { environment: browser.environment });
    const request = requestIn(browser.opened[0]!.url);
    browser.relay(request.redirectUri + toFragment({ v: 1, id: request.id, ok: false, error: 'the user refused' }));
    const error = await failure(connecting);
    expect(error.message).toBe('keychain: the user refused');
    expect(error).not.toBeInstanceOf(KeychainPopupError);
    expect(loadConnection(store)).toBeNull();
  });

  test('an answer to another request is ignored, and the right one still arrives', async () => {
    const browser = fakeBrowser();
    const connecting = connectWithPopup(options, memoryStore(), { environment: browser.environment });
    const request = requestIn(browser.opened[0]!.url);
    let settled = false;
    void connecting.then(() => (settled = true), () => (settled = true));

    browser.relay(request.redirectUri + toFragment(approved('0xbad')));
    browser.broadcast({ kamui: 'popup-result', fragment: '#kamui=not-base64-json' });
    browser.broadcast({ kamui: 'something-else', fragment: toFragment(approved(request.id)) });
    browser.broadcast('nonsense');
    browser.broadcast(null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    browser.popup.closed = false;
    browser.relay(request.redirectUri + toFragment(approved(request.id)));
    expect((await connecting).account).toBe(ACCOUNT);
  });

  test('an answer posted to the window from another origin is ignored; from the app\'s own origin it counts', async () => {
    const browser = fakeBrowser();
    const connecting = connectWithPopup(options, memoryStore(), { environment: browser.environment });
    const request = requestIn(browser.opened[0]!.url);
    const message = { kamui: 'popup-result', fragment: toFragment(approved(request.id)) };
    let settled = false;
    void connecting.then(() => (settled = true), () => (settled = true));

    browser.post('https://evil.example', message);
    browser.post(KEYCHAIN, message);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    browser.post(APP, message);
    expect((await connecting).account).toBe(ACCOUNT);
  });
});

describe('popup mode: when the popup does not open', () => {
  test('a blocked popup falls back to the redirect, with the request pending in the store', async () => {
    const browser = fakeBrowser({ blocked: true });
    const store = memoryStore();
    void connectWithPopup(options, store, { environment: browser.environment });

    expect(browser.navigated).toHaveLength(1);
    const url = browser.navigated[0]!;
    const request = requestIn(url);
    // The redirect goes to the plain address: the page is not a popup this time.
    expect(request.redirectUri).toBe(`${APP}/play`);
    expect(pendingRequestKind(store)).toBe('connect');
    expect(browser.windowListeners.size).toBe(0);
    // The app finishes as it does after any redirect.
    const connection = finishConnect(toFragment(approved(request.id)), store)!;
    expect(connection.session.publicKey).toBe(request.session.publicKey);
    // And that page is not taken for a popup.
    expect(browser.relay(request.redirectUri + toFragment(approved(request.id)))).toBe(false);
  });

  test('a window handed back already closed counts as blocked', () => {
    const browser = fakeBrowser();
    browser.popup.closed = true;
    void connectWithPopup(options, memoryStore(), { environment: browser.environment });
    expect(browser.navigated).toHaveLength(1);
  });

  test('with the fallback off, a blocked popup rejects and the page stays', async () => {
    const browser = fakeBrowser({ blocked: true });
    const store = memoryStore();
    const error = await failure(connectWithPopup(options, store, { environment: browser.environment, fallback: 'none' }));
    expect(error).toBeInstanceOf(KeychainPopupError);
    expect(error.code).toBe('blocked');
    expect(browser.navigated).toEqual([]);
    expect(store.data.size).toBe(0);
  });

  test('a blocked execute falls back to the redirect too', () => {
    const browser = fakeBrowser({ blocked: true });
    const store = memoryStore();
    void executeWithPopup({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/play`, calls: [{ contractAddress: GAME, entrypoint: 'move', calldata: [] }] }, store, { environment: browser.environment });
    expect(browser.navigated[0]!.startsWith(`${KEYCHAIN}/execute#kamui=`)).toBe(true);
    expect(pendingRequestKind(store)).toBe('execute');
  });
});

describe('popup mode: when the popup goes away', () => {
  test('closing the popup rejects with `closed`', async () => {
    const browser = fakeBrowser();
    const connecting = connectWithPopup(options, memoryStore(), { environment: browser.environment, ...fast });
    browser.popup.closed = true;
    const error = await failure(connecting);
    expect(error).toBeInstanceOf(KeychainPopupError);
    expect(error.code).toBe('closed');
    expect(browser.windowListeners.size).toBe(0);
    expect(browser.broadcastListeners.size).toBe(0);
  });

  test('an answer that arrives just as the popup closes wins over `closed`', async () => {
    const browser = fakeBrowser();
    const connecting = connectWithPopup(options, memoryStore(), { environment: browser.environment, pollMs: 1, closedGraceMs: 50 });
    const request = requestIn(browser.opened[0]!.url);
    browser.popup.closed = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    browser.broadcast({ kamui: 'popup-result', fragment: toFragment(approved(request.id)) });
    expect((await connecting).account).toBe(ACCOUNT);
  });

  test('after the keychain says it is leaving for the issuer, a handle that reports closed is not believed', async () => {
    const browser = fakeBrowser();
    const connecting = connectWithPopup(options, memoryStore(), { environment: browser.environment, ...fast });
    const request = requestIn(browser.opened[0]!.url);
    let settled = false;
    void connecting.then(() => (settled = true), () => (settled = true));

    browser.post(KEYCHAIN, { kamui: POPUP_LEAVING, id: request.id });
    // What the opener sees once the issuer's Cross-Origin-Opener-Policy has cut the link.
    browser.popup.closed = true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);

    // The popup comes back to the app's page with no opener: the channel still delivers.
    browser.relay(request.redirectUri + toFragment(approved(request.id)), null);
    expect((await connecting).account).toBe(ACCOUNT);
  });

  test('only the keychain, naming this request, can say so', async () => {
    const browser = fakeBrowser();
    const connecting = connectWithPopup(options, memoryStore(), { environment: browser.environment, ...fast });
    const request = requestIn(browser.opened[0]!.url);
    browser.post('https://evil.example', { kamui: POPUP_LEAVING, id: request.id });
    browser.post(KEYCHAIN, { kamui: POPUP_LEAVING, id: '0xbad' });
    browser.popup.closed = true;
    expect((await failure(connecting)).code).toBe('closed');
  });

  test('no answer in time rejects with `timeout` and closes the popup', async () => {
    const browser = fakeBrowser();
    const error = await failure(connectWithPopup(options, memoryStore(), { environment: browser.environment, timeoutMs: 10 }));
    expect(error.code).toBe('timeout');
    expect(browser.popup.closes).toBe(1);
  });

  test('the timeout still ends a wait whose popup left for the issuer and never came back', async () => {
    const browser = fakeBrowser();
    const connecting = connectWithPopup(options, memoryStore(), { environment: browser.environment, ...fast, timeoutMs: 60 });
    browser.post(KEYCHAIN, { kamui: POPUP_LEAVING, id: requestIn(browser.opened[0]!.url).id });
    browser.popup.closed = true;
    expect((await failure(connecting)).code).toBe('timeout');
  });

  test('aborting rejects with `aborted` and closes the popup', async () => {
    const browser = fakeBrowser();
    const controller = new AbortController();
    const connecting = connectWithPopup(options, memoryStore(), { environment: browser.environment, signal: controller.signal });
    controller.abort();
    expect((await failure(connecting)).code).toBe('aborted');
    expect(browser.popup.closes).toBe(1);

    const again = fakeBrowser();
    expect((await failure(connectWithPopup(options, memoryStore(), { environment: again.environment, signal: controller.signal }))).code).toBe('aborted');
  });

  test('a late answer after the wait ended changes nothing', async () => {
    const browser = fakeBrowser();
    const store = memoryStore();
    const connecting = connectWithPopup(options, store, { environment: browser.environment, timeoutMs: 5 });
    const request = requestIn(browser.opened[0]!.url);
    await failure(connecting);
    browser.broadcast({ kamui: 'popup-result', fragment: toFragment(approved(request.id)) });
    expect(loadConnection(store)).toBeNull();
  });
});

describe('popup mode: one transaction', () => {
  const calls = [{ contractAddress: GAME, entrypoint: 'move', calldata: ['0x1'] }];
  const sent = (id: string): ExecuteResult => ({ v: 1, id, ok: true, account: ACCOUNT, calldata: ['0x1', '0x2'] });

  test('the answer comes back as the signed transaction, unsent, and the store is not touched', async () => {
    const browser = fakeBrowser();
    const store = memoryStore();
    const executing = executeWithPopup({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/play`, calls }, store, { environment: browser.environment });
    const url = browser.opened[0]!.url;
    expect(url.startsWith(`${KEYCHAIN}/execute#kamui=`)).toBe(true);
    const request = parseExecuteRequest(new URL(url).hash, `${APP}/`)!;
    expect(request.redirectUri).toBe(`${APP}/play?${POPUP_MARKER}=1`);
    browser.relay(request.redirectUri + toFragment(sent(request.id)));
    // The app sends it through its own sponsor route: `sponsor(url, call)`.
    expect(await executing).toEqual({ account: ACCOUNT, call: { contractAddress: ACCOUNT, entrypoint: 'execute_from_outside_v2', calldata: ['0x1', '0x2'] } });
    expect(store.data.size).toBe(0);
  });

  test('a refusal rejects with the keychain\'s reason', async () => {
    const browser = fakeBrowser();
    const executing = executeWithPopup({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/play`, calls }, memoryStore(), { environment: browser.environment });
    const request = parseExecuteRequest(new URL(browser.opened[0]!.url).hash, `${APP}/`)!;
    browser.relay(request.redirectUri + toFragment({ v: 1, id: request.id, ok: false, error: 'the user refused' }));
    expect((await failure(executing)).message).toBe('keychain: the user refused');
  });
});

describe('popup mode: one signed message', () => {
  const typedData = {
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      SignIn: [{ name: 'nonce', type: 'felt' }],
    },
    primaryType: 'SignIn',
    domain: { name: 'Example Game', version: '1', chainId: 'SN_SEPOLIA', revision: '1' },
    message: { nonce: '0x1234' },
  };

  test('the answer comes back as the signature, and a blocked popup falls back to the redirect', async () => {
    const browser = fakeBrowser();
    const store = memoryStore();
    const signing = signMessageWithPopup({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/play`, typedData }, store, { environment: browser.environment });
    const url = browser.opened[0]!.url;
    expect(url.startsWith(`${KEYCHAIN}/sign#kamui=`)).toBe(true);
    const request = parseSignMessageRequest(new URL(url).hash, `${APP}/`)!;
    expect(request.redirectUri).toBe(`${APP}/play?${POPUP_MARKER}=1`);
    browser.relay(request.redirectUri + toFragment({ v: 1, id: request.id, ok: true, account: ACCOUNT, chainId: '0x534e5f5345504f4c4941', signature: ['0x1', '0x2'] }));
    expect(await signing).toEqual({ account: ACCOUNT, chainId: '0x534e5f5345504f4c4941', signature: ['0x1', '0x2'] });
    expect(store.data.size).toBe(0);

    const blocked = fakeBrowser({ blocked: true });
    void signMessageWithPopup({ keychainUrl: KEYCHAIN, redirectUri: `${APP}/play`, typedData }, store, { environment: blocked.environment });
    expect(blocked.navigated[0]!.startsWith(`${KEYCHAIN}/sign#kamui=`)).toBe(true);
    expect(pendingRequestKind(store)).toBe('signMessage');
  });
});

describe('popup mode: the relay page', () => {
  const answer = toFragment(approved('0x1'));
  function page(search: string, fragment: string) {
    const seen = { broadcasts: [] as { name: string; data: unknown }[], toOpener: [] as { data: unknown; targetOrigin: string }[], cleared: 0, closed: 0 };
    const environment: RelayEnvironment = {
      search,
      fragment,
      origin: APP,
      broadcast: (name, data) => void seen.broadcasts.push({ name, data }),
      opener: { postMessage: (data, targetOrigin) => void seen.toOpener.push({ data, targetOrigin }) },
      clearFragment: () => void (seen.cleared += 1),
      close: () => void (seen.closed += 1),
    };
    return { seen, environment };
  }

  test('relays the answer to its own origin only, clears the address and closes', () => {
    const { seen, environment } = page(`?${POPUP_MARKER}=1`, answer);
    expect(relayPopupResult(environment)).toBe(true);
    expect(seen.broadcasts).toEqual([{ name: POPUP_CHANNEL, data: { kamui: 'popup-result', fragment: answer } }]);
    expect(seen.toOpener).toEqual([{ data: { kamui: 'popup-result', fragment: answer }, targetOrigin: APP }]);
    expect(seen.cleared).toBe(1);
    expect(seen.closed).toBe(1);
  });

  test('works without an opener, and with one that throws', () => {
    const none = page(`?${POPUP_MARKER}=1`, answer);
    none.environment.opener = null;
    expect(relayPopupResult(none.environment)).toBe(true);
    expect(none.seen.broadcasts).toHaveLength(1);

    const broken = page(`?${POPUP_MARKER}=1`, answer);
    broken.environment.opener = { postMessage() { throw new Error('gone'); } };
    expect(relayPopupResult(broken.environment)).toBe(true);
    expect(broken.seen.closed).toBe(1);
  });

  test('does nothing on an ordinary visit or an ordinary redirect answer', () => {
    for (const [search, fragment] of [['', ''], ['', answer], [`?${POPUP_MARKER}=1`, ''], [`?${POPUP_MARKER}=1`, '#section'], [`?${POPUP_MARKER}=1`, '#kamui=garbage']] as const) {
      const { seen, environment } = page(search, fragment);
      expect(relayPopupResult(environment)).toBe(false);
      expect(seen).toEqual({ broadcasts: [], toOpener: [], cleared: 0, closed: 0 });
    }
  });

  test('the marker keeps the rest of the redirect address', () => {
    expect(popupRedirectUri(`${APP}/play?room=7`)).toBe(`${APP}/play?room=7&${POPUP_MARKER}=1`);
    expect(popupRedirectUri(popupRedirectUri(`${APP}/`))).toBe(`${APP}/?${POPUP_MARKER}=1`);
  });

  test('fragmentId reads the id of a request or an answer and nothing else', () => {
    expect(fragmentId(answer)).toBe('0x1');
    expect(fragmentId('')).toBeNull();
    expect(fragmentId('#kamui=garbage')).toBeNull();
    expect(fragmentId(toFragment({ v: 1, id: 7 } as never))).toBeNull();
  });
});
