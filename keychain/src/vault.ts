// Where the keychain keeps this device's key: IndexedDB in the keychain's own origin.
//
// A Stark-curve key cannot be a non-extractable WebCrypto key (WebCrypto has no such curve).
// So the private key is encrypted with an AES-GCM key that IS non-extractable and lives in the
// same database: the bytes on disk are useless without the browser's key store, and no page
// script can read the wrapping key's bytes. Code running in the keychain's origin can still
// ask the browser to decrypt, which is why the keychain needs a strict content security policy
// and no third-party scripts.
//
// The account record (address, pepper, recovery file) is sealed the same way.
import type { KeyPair, PepperFile } from '../../sdk/src';

const DATABASE = 'kamui-keychain';
const STORE = 'vault';

type Sealed = { iv: Uint8Array; data: ArrayBuffer };

export type AccountRecord = {
  account: string;
  chainId: string;
  classHash: string;
  pepper: string;
  keyVersion: number;
  /** Built at login, when the token's claims were at hand. Holds no user id. */
  pepperFile: PepperFile;
};

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

const get = <T>(key: string) => run<T | undefined>('readonly', (store) => store.get(key));
const put = (key: string, value: unknown) => run('readwrite', (store) => store.put(value, key));
const remove = (key: string) => run('readwrite', (store) => store.delete(key));

/** The non-extractable wrapping key, created on first use. */
async function wrappingKey(): Promise<CryptoKey> {
  const existing = await get<CryptoKey>('wrapping-key');
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await put('wrapping-key', key);
  return key;
}

async function seal(value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrappingKey(), bytes) };
}

async function unseal<T>(sealed: Sealed | undefined): Promise<T | null> {
  if (!sealed) return null;
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv as BufferSource }, await wrappingKey(), sealed.data);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** A key waiting for its login to finish. It replaces any earlier pending key. */
export async function savePendingDevice(device: KeyPair): Promise<void> {
  await put('pending-device', await seal(device));
}

export async function loadPendingDevice(): Promise<KeyPair | null> {
  return unseal<KeyPair>(await get<Sealed>('pending-device'));
}

/** After a login: the pending key becomes this device's key, with its account. */
export async function saveLogin(device: KeyPair, account: AccountRecord): Promise<void> {
  await put('device', await seal(device));
  await put('account', await seal(account));
  await remove('pending-device');
}

export async function loadLogin(): Promise<{ device: KeyPair; account: AccountRecord } | null> {
  const device = await unseal<KeyPair>(await get<Sealed>('device'));
  const account = await unseal<AccountRecord>(await get<Sealed>('account'));
  return device && account ? { device, account } : null;
}

/** Forgets this device's key and account. The key stays an owner on chain until it is removed. */
export async function forget(): Promise<void> {
  await remove('device');
  await remove('account');
  await remove('pending-device');
}
