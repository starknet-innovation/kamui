// Native apps: connecting through a bounce page on the app's own HTTPS domain.
//
// A native app cannot ask the keychain directly. The keychain binds a request to the site that
// sent it with the browser's referrer, and a page opened by an app (ASWebAuthenticationSession,
// a Custom Tab) has none. A custom URL scheme cannot stand in for that: any app on the device
// can claim `mygame://`. So the app opens a page on its own domain, and that page asks:
//
//   app            opens  https://mygame.example/kamui/start#kamui-native-start=<state, key>
//   start page     creates the session key, sends the browser to the keychain (referrer: the
//                  app's origin, redirectUri: the return page on the same origin)
//   return page    reads the keychain's answer, seals the connection to the app's handoff key,
//                  and navigates to the app link  https://mygame.example/kamui/app#kamui-native=…
//   app            receives the app link (universal link / App Link / https callback), opens it
//                  with the handoff key it kept, and stores the session key
//
// Why the session key is made in the page and not in the app: a page that forwarded a session
// public key taken from its URL would let anyone link to it with *their* key, and the keychain
// would show the app's origin for a session the attacker holds. That is exactly what the
// referrer check exists to stop. Here the URL carries only a transport key and a state value:
// a stranger's link yields a connection sealed to a key the app never made, delivered to the
// real app (the app link is verified by the OS), which drops it.
//
// Why the handoff is sealed: the app link carries the session's private key, and URLs end up in
// browser history. Sealed, the fragment is useless without the private key in the app.
//
// The handoff is ECDH P-256 + HKDF-SHA256 + AES-256-GCM, all available in WebCrypto, CryptoKit
// and the Android Keystore/JCA. The exact layout is in docs/native/bounce-page.md.
import { beginConnect, finishConnect, forgetConnection, pendingRequestKind, type ConnectOptions, type Connection, type KeyValueStore } from './keychain';

export const NATIVE_HANDOFF_VERSION = 1;

const START_KEY = 'kamui-native-start';
const HANDOFF_KEY = 'kamui-native';
const PENDING_START = 'kamui.native.start';
const HKDF_INFO = 'kamui-native-handoff-v1';
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** What the app keeps while the user is in the browser. `privateKey` is PKCS#8, base64url. */
export type NativeHandoffSecret = { state: string; publicKey: string; privateKey: string };

/** What the app puts in the start page's URL: the state, and the public half of the handoff key. */
export type NativeStart = { v: 1; state: string; key: string };

/** The sealed answer in the app link. `epk`, `iv` and `ct` are base64url. */
export type NativeHandoff = { v: 1; state: string; epk: string; iv: string; ct: string };

type HandoffBody = { ok: true; connection: Connection } | { ok: false; error: string };

const isState = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
const isBase64Url = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const utf8 = (text: string) => new TextEncoder().encode(text);
// Typed arrays here are always backed by a plain ArrayBuffer; the cast keeps that true across
// TypeScript versions, which disagree on how to say it.
const source = (bytes: Uint8Array) => bytes as unknown as BufferSource;
const encodeJson = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)));

function fragmentValue(fragment: string, key: string): unknown | null {
  const hash = fragment.includes('#') ? fragment.slice(fragment.indexOf('#') + 1) : fragment;
  const payload = new URLSearchParams(hash).get(key);
  if (payload === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    throw new Error('native: the link cannot be read');
  }
}

/** An uncompressed P-256 point: 0x04, x, y. */
function publicKeyBytes(text: string): Uint8Array {
  const bytes = fromBase64Url(text);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('native: bad handoff key');
  return bytes;
}

/** The AES-256-GCM key both sides derive: HKDF-SHA256(ECDH, salt = epk || app key, info). */
async function handoffKey(privateKey: CryptoKey, peer: Uint8Array, epk: Uint8Array, appKey: Uint8Array): Promise<CryptoKey> {
  let peerKey: CryptoKey;
  try {
    peerKey = await crypto.subtle.importKey('raw', source(peer), P256, false, []);
  } catch {
    throw new Error('native: bad handoff key');
  }
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256);
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array(epk.length + appKey.length);
  salt.set(epk);
  salt.set(appKey, epk.length);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: source(salt), info: source(utf8(HKDF_INFO)) }, material, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

//
// App side (React Native or any TypeScript runtime with WebCrypto; other languages follow the
// layout in docs/native/bounce-page.md)
//

/**
 * App side, step 1: a fresh state and handoff key for one connect. Keep the result (in memory or
 * in the platform's secure storage) until the app link comes back; use it once.
 */
export async function newNativeHandoff(): Promise<NativeHandoffSecret> {
  const pair = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  return {
    state: toBase64Url(crypto.getRandomValues(new Uint8Array(24))),
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  };
}

/** App side: the address of the start page to open in the system browser. */
export function nativeStartUrl(startPage: string, secret: Pick<NativeHandoffSecret, 'state' | 'publicKey'>): string {
  const url = new URL(startPage);
  if (url.protocol !== 'https:') throw new Error('native: the start page must be https');
  if (url.hash !== '') throw new Error('native: the start page must not have a fragment');
  const start: NativeStart = { v: 1, state: secret.state, key: secret.publicKey };
  return `${url.toString()}#${START_KEY}=${encodeJson(start)}`;
}

/**
 * App side, last step: opens the app link the return page navigated to. Returns the connection,
 * or null when the link holds no handoff. Throws when the handoff is not for this connect (wrong
 * state, or sealed to another key), or when it reports that the user refused.
 *
 * Check the connection on chain (`isConnectionAlive`) before relying on it.
 */
export async function openNativeHandoff(link: string, secret: NativeHandoffSecret): Promise<Connection | null> {
  const data = fragmentValue(link, HANDOFF_KEY) as Partial<NativeHandoff> | null;
  if (data === null) return null;
  if (typeof data !== 'object' || data.v !== NATIVE_HANDOFF_VERSION) throw new Error('native: unsupported handoff version');
  if (data.state !== secret.state) throw new Error('native: the handoff is not for this request');
  if (!isBase64Url(data.epk, 100) || !isBase64Url(data.iv, 16) || !isBase64Url(data.ct, 8192)) throw new Error('native: the handoff is malformed');
  const epk = publicKeyBytes(data.epk);
  const iv = fromBase64Url(data.iv);
  if (iv.length !== 12) throw new Error('native: the handoff is malformed');

  let body: HandoffBody;
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', source(fromBase64Url(secret.privateKey)), P256, false, ['deriveBits']);
    const key = await handoffKey(privateKey, epk, epk, publicKeyBytes(secret.publicKey));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: source(iv), additionalData: source(utf8(secret.state)) }, key, source(fromBase64Url(data.ct)));
    body = JSON.parse(new TextDecoder().decode(plain)) as HandoffBody;
  } catch {
    throw new Error('native: the handoff cannot be opened');
  }
  if (body.ok !== true) throw new Error(`keychain: ${typeof body.error === 'string' ? body.error : 'refused'}`);
  return body.connection;
}

//
// Bounce page side
//

/**
 * Start page: reads the app's state and handoff key from the page's fragment, remembers them,
 * and returns the keychain address to navigate to (`location.assign(url)`). Returns null when
 * the fragment holds no start request.
 *
 * `options` is the page's own: what the session may do is decided by the code the app's domain
 * serves, never by the link. `redirectUri` must be the return page, on this page's origin.
 */
export function beginNativeConnect(fragment: string, options: ConnectOptions, store: KeyValueStore): string | null {
  const data = fragmentValue(fragment, START_KEY) as Partial<NativeStart> | null;
  if (data === null) return null;
  if (typeof data !== 'object' || data.v !== NATIVE_HANDOFF_VERSION) throw new Error('native: unsupported start version');
  if (!isState(data.state)) throw new Error('native: bad state');
  if (!isBase64Url(data.key, 100)) throw new Error('native: bad handoff key');
  publicKeyBytes(data.key);
  const start: NativeStart = { v: 1, state: data.state, key: data.key };
  store.setItem(PENDING_START, JSON.stringify(start));
  return beginConnect(options, store);
}

/**
 * Return page: reads the keychain's answer, seals it to the app's handoff key, and returns the
 * app link to navigate to. Returns null when the fragment holds no answer. A refusal is sealed
 * and handed off too, so the app can show it.
 *
 * `appLink` is the page's own constant: an https address the OS hands to the app (universal
 * link, App Link, or an https callback). It carries the session key, so a custom scheme is
 * refused: any app can claim one. Nothing of the session stays in the page's storage.
 */
export async function finishNativeConnect(fragment: string, appLink: string, store: KeyValueStore): Promise<string | null> {
  const link = new URL(appLink);
  if (link.protocol !== 'https:') throw new Error('native: the app link must be https');
  if (link.hash !== '') throw new Error('native: the app link must not have a fragment');

  const startText = store.getItem(PENDING_START);
  const asked = pendingRequestKind(store) === 'connect';
  let body: HandoffBody;
  try {
    const connection = finishConnect(fragment, store);
    if (connection === null) return null;
    body = { ok: true, connection };
  } catch (error) {
    // `finishConnect` consumes the pending request only for an answer to it. If it is still
    // there, or was never there, this was not the keychain's answer: nothing to hand off.
    if (!asked || pendingRequestKind(store) === 'connect') throw error;
    body = { ok: false, error: (error as Error).message.replace(/^keychain: /, '') };
  }
  // The page keeps no copy of the session key.
  forgetConnection(store);
  if (!startText) throw new Error('native: no app is waiting for this answer');
  store.removeItem(PENDING_START);
  const start = JSON.parse(startText) as NativeStart;

  return `${link.toString()}#${HANDOFF_KEY}=${encodeJson(await sealHandoff(start, body))}`;
}

async function sealHandoff(start: NativeStart, body: HandoffBody): Promise<NativeHandoff> {
  const appKey = publicKeyBytes(start.key);
  const pair = await crypto.subtle.generateKey(P256, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const key = await handoffKey(pair.privateKey, appKey, epk, appKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: source(iv), additionalData: source(utf8(start.state)) }, key, source(utf8(JSON.stringify(body))));
  return { v: 1, state: start.state, epk: toBase64Url(epk), iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ct)) };
}
