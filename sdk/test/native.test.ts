// Native apps through a bounce page: the keychain still sees a request from the app's own
// origin, the link that starts it decides nothing about the session, and only the app that
// started a connect can open what comes back.
import { describe, expect, test } from 'bun:test';
import {
  beginNativeConnect,
  finishNativeConnect,
  loadConnection,
  nativeStartUrl,
  newNativeHandoff,
  openNativeHandoff,
  parseConnectRequest,
  pendingRequestKind,
  toFragment,
  type ConnectOptions,
  type ConnectResult,
  type KeyValueStore,
} from '../src';

const APP = 'https://game.example';
const KEYCHAIN = 'https://keychain.example';
const APP_LINK = `${APP}/kamui/app`;
const ACCOUNT = '0x3ec3b3ead6762ecf0172e0d5e3f9df472e66608e3f483f300a784dc9652d193';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

/** What the page on the app's domain asks for. Fixed in the page, not taken from the link. */
const pageOptions: ConnectOptions = {
  keychainUrl: KEYCHAIN,
  redirectUri: `${APP}/kamui/return`,
  appName: 'Example Game',
  validUntil: FUTURE,
  maxCalls: 50,
  calls: [{ to: GAME, entrypoint: 'move' }],
};

const fragmentOf = (url: string) => new URL(url).hash;
const approved = (id: string): ConnectResult => ({ v: 1, id, ok: true, account: ACCOUNT, chainId: '0x534e5f5345504f4c4941', classHash: '0x1e12' });
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const unb64 = (text: string) => JSON.parse(Buffer.from(text, 'base64url').toString());

/** The page's half of a connect: start, the keychain's answer, the app link. */
async function throughThePage(startUrl: string, answer: (id: string) => ConnectResult = approved) {
  const store = memoryStore();
  const keychainUrl = beginNativeConnect(fragmentOf(startUrl), pageOptions, store)!;
  const request = parseConnectRequest(fragmentOf(keychainUrl), `${APP}/kamui/start`)!;
  const link = await finishNativeConnect(toFragment(answer(request.id)), APP_LINK, store);
  return { store, request, link: link! };
}

describe('native connect through a bounce page', () => {
  test('the app gets the connection the page made, and the page keeps nothing', async () => {
    const secret = await newNativeHandoff();
    const { store, request, link } = await throughThePage(nativeStartUrl(`${APP}/kamui/start`, secret));

    expect(link.startsWith(`${APP_LINK}#kamui-native=`)).toBe(true);
    const connection = (await openNativeHandoff(link, secret))!;
    expect(connection.account).toBe(ACCOUNT);
    expect(connection.session.publicKey).toBe(request.session.publicKey);
    expect(connection.session.privateKey).toMatch(/^0x[0-9a-f]+$/);
    expect(connection.session.validUntil).toBe(FUTURE);

    // Nothing of the session, the pending request or the start stays in the page's storage.
    expect(store.data.size).toBe(0);
    expect(loadConnection(store)).toBeNull();
  });

  test('the keychain sees an ordinary request from the app origin, and still refuses it from anywhere else', async () => {
    const store = memoryStore();
    const secret = await newNativeHandoff();
    const keychainUrl = beginNativeConnect(fragmentOf(nativeStartUrl(`${APP}/kamui/start`, secret)), pageOptions, store)!;
    expect(keychainUrl.startsWith(`${KEYCHAIN}/connect#kamui=`)).toBe(true);

    const request = parseConnectRequest(fragmentOf(keychainUrl), `${APP}/`)!;
    expect(request.redirectUri).toBe(`${APP}/kamui/return`);
    // The app opening the keychain itself has no referrer; another site has the wrong one.
    expect(() => parseConnectRequest(fragmentOf(keychainUrl), '')).toThrow('cannot tell which site sent this request');
    expect(() => parseConnectRequest(fragmentOf(keychainUrl), 'https://evil.example/')).toThrow('not sent by the site it names');
  });

  test('custom schemes are still refused, as a redirect address and as an app link', async () => {
    const store = memoryStore();
    const secret = await newNativeHandoff();
    const start = fragmentOf(nativeStartUrl(`${APP}/kamui/start`, secret));
    const keychainUrl = beginNativeConnect(start, { ...pageOptions, redirectUri: 'mygame://kamui' }, store)!;
    expect(() => parseConnectRequest(fragmentOf(keychainUrl), 'mygame://kamui')).toThrow('must be https');

    await expect(finishNativeConnect('#kamui=x', 'mygame://kamui', store)).rejects.toThrow('the app link must be https');
    await expect(finishNativeConnect('#kamui=x', 'http://game.example/kamui/app', store)).rejects.toThrow('the app link must be https');
    await expect(finishNativeConnect('#kamui=x', `${APP_LINK}#x`, store)).rejects.toThrow('must not have a fragment');
    expect(() => nativeStartUrl('mygame://start', secret)).toThrow('the start page must be https');
  });

  test('the link decides nothing about the session: extra fields in it are ignored', async () => {
    const store = memoryStore();
    const secret = await newNativeHandoff();
    const evil = {
      v: 1,
      state: secret.state,
      key: secret.publicKey,
      // None of these exist in the protocol. A page must not grow them.
      publicKey: '0x1234',
      redirectUri: 'https://evil.example/',
      session: { publicKey: '0x1234', calls: [{ to: ACCOUNT, entrypoint: 'transfer' }] },
      calls: [{ to: ACCOUNT, entrypoint: 'transfer' }],
      maxCalls: 1_000_000,
    };
    const keychainUrl = beginNativeConnect(`#kamui-native-start=${b64(evil)}`, pageOptions, store)!;
    const request = parseConnectRequest(fragmentOf(keychainUrl), `${APP}/`)!;
    expect(request.redirectUri).toBe(pageOptions.redirectUri);
    expect(request.session.calls).toEqual(pageOptions.calls);
    expect(request.session.maxCalls).toBe(pageOptions.maxCalls);
    expect(request.session.publicKey).not.toBe('0x1234');
    expect(store.data.get('kamui.native.start')).toBe(JSON.stringify({ v: 1, state: secret.state, key: secret.publicKey }));
  });

  test("a stranger's link gives the stranger nothing: the handoff goes to the app link, sealed, and the app drops it", async () => {
    // The attacker makes their own state and key and gets a user to open the start page.
    const attacker = await newNativeHandoff();
    const { link } = await throughThePage(nativeStartUrl(`${APP}/kamui/start`, attacker));

    // The answer goes to the app's own https link, not anywhere the attacker named.
    expect(link.startsWith(`${APP_LINK}#`)).toBe(true);
    // The session key is not readable from the link (history, logs).
    const sealed = unb64(link.split('#kamui-native=')[1]!);
    expect(Object.keys(sealed).sort()).toEqual(['ct', 'epk', 'iv', 'state', 'v']);
    expect(link).not.toContain('privateKey');

    // The real app is waiting for something else (or for nothing) and refuses.
    const app = await newNativeHandoff();
    await expect(openNativeHandoff(link, app)).rejects.toThrow('not for this request');
    // Even an app tricked into the attacker's state cannot open it without the attacker's key.
    await expect(openNativeHandoff(link, { ...app, state: attacker.state })).rejects.toThrow('cannot be opened');
  });

  test('a handoff cannot be moved to another state, key or ciphertext', async () => {
    const secret = await newNativeHandoff();
    const { link } = await throughThePage(nativeStartUrl(`${APP}/kamui/start`, secret));
    const sealed = unb64(link.split('#kamui-native=')[1]!);
    const relink = (over: object) => `${APP_LINK}#kamui-native=${b64({ ...sealed, ...over })}`;

    const flipped = sealed.ct.slice(0, -2) + (sealed.ct.endsWith('AA') ? 'BB' : 'AA');
    await expect(openNativeHandoff(relink({ ct: flipped }), secret)).rejects.toThrow('cannot be opened');
    const other = await newNativeHandoff();
    await expect(openNativeHandoff(relink({ epk: other.publicKey }), secret)).rejects.toThrow('cannot be opened');
    await expect(openNativeHandoff(relink({ v: 2 }), secret)).rejects.toThrow('unsupported handoff version');
    await expect(openNativeHandoff(relink({ iv: 'AAAA' }), secret)).rejects.toThrow('malformed');
    await expect(openNativeHandoff(relink({ epk: 'AAAA' }), secret)).rejects.toThrow('bad handoff key');
    // The state is authenticated: the same ciphertext under another state does not open.
    await expect(openNativeHandoff(relink({ state: other.state }), { ...secret, state: other.state })).rejects.toThrow('cannot be opened');

    expect(await openNativeHandoff(`${APP_LINK}#other=1`, secret)).toBeNull();
    expect(await openNativeHandoff(APP_LINK, secret)).toBeNull();
  });

  test('a refusal reaches the app, sealed like an approval', async () => {
    const secret = await newNativeHandoff();
    const { store, link } = await throughThePage(nativeStartUrl(`${APP}/kamui/start`, secret), (id) => ({ v: 1, id, ok: false, error: 'denied by the user' }));
    await expect(openNativeHandoff(link, secret)).rejects.toThrow('keychain: denied by the user');
    expect(store.data.size).toBe(0);
  });

  test('an answer to another request is not handed off, and the pending request survives it', async () => {
    const store = memoryStore();
    const secret = await newNativeHandoff();
    beginNativeConnect(fragmentOf(nativeStartUrl(`${APP}/kamui/start`, secret)), pageOptions, store);
    await expect(finishNativeConnect(toFragment(approved('0xdead')), APP_LINK, store)).rejects.toThrow('not for this request');
    expect(pendingRequestKind(store)).toBe('connect');
    expect(store.data.has('kamui.native.start')).toBe(true);

    expect(await finishNativeConnect('#nothing=1', APP_LINK, store)).toBeNull();
    await expect(finishNativeConnect(toFragment(approved('0xdead')), APP_LINK, memoryStore())).rejects.toThrow('nothing was asked');
  });

  test('a bad start link is refused before anything is asked', async () => {
    const store = memoryStore();
    const secret = await newNativeHandoff();
    const start = (over: object) => `#kamui-native-start=${b64({ v: 1, state: secret.state, key: secret.publicKey, ...over })}`;

    expect(beginNativeConnect('', pageOptions, store)).toBeNull();
    expect(beginNativeConnect('#kamui=abc', pageOptions, store)).toBeNull();
    expect(() => beginNativeConnect(start({ v: 2 }), pageOptions, store)).toThrow('unsupported start version');
    expect(() => beginNativeConnect(start({ state: 'short' }), pageOptions, store)).toThrow('bad state');
    expect(() => beginNativeConnect(start({ state: 'a'.repeat(15) + '<' }), pageOptions, store)).toThrow('bad state');
    expect(() => beginNativeConnect(start({ key: 'AAAA' }), pageOptions, store)).toThrow('bad handoff key');
    expect(() => beginNativeConnect(start({ key: 5 }), pageOptions, store)).toThrow('bad handoff key');
    expect(() => beginNativeConnect('#kamui-native-start=%%%', pageOptions, store)).toThrow('cannot be read');
    expect(store.data.size).toBe(0);
  });

  test('each connect has its own state and key', async () => {
    const a = await newNativeHandoff();
    const b = await newNativeHandoff();
    expect(a.state).not.toBe(b.state);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
