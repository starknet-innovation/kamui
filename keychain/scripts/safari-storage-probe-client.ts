import { loadPendingDevice, savePendingDevice } from '../src/vault';

// This string is deliberately not a valid private key. The probe never signs anything.
const MARKER = 'disposable-storage-probe-not-a-wallet-key';
const PREFIX = 'kamui-safari-probe';
const result = document.getElementById('result')!;
async function read() {
  const pending = await loadPendingDevice();
  const wrapping = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const opened = indexedDB.open('kamui-keychain', 1);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result;
      const request = db.transaction('vault').objectStore('vault').get('wrapping-key');
      request.onsuccess = () => { resolve(request.result); db.close(); };
      request.onerror = () => { reject(request.error); db.close(); };
    };
  });
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : 'unsupported';
  result.textContent = JSON.stringify({
    checkedAt: new Date().toISOString(),
    vaultMarkerRecovered: pending?.privateKey === MARKER,
    wrappingKeyPresent: Boolean(wrapping),
    wrappingKeyExtractable: wrapping?.extractable ?? null,
    localMarkerPresent: localStorage.getItem(PREFIX) !== null,
    sessionMarkerPresent: sessionStorage.getItem(PREFIX) !== null,
    writtenAt: localStorage.getItem(`${PREFIX}-written-at`),
    storagePersisted: persisted,
  }, null, 2);
}
function action(id: string, work: () => Promise<void>) {
  document.getElementById(id)!.onclick = async () => {
    try { await work(); } catch { result.textContent = 'Probe failed. Record the visible browser error; do not use wallet keys here.'; }
  };
}
action('write', async () => {
  await savePendingDevice({ privateKey: MARKER, publicKey: 'disposable-marker' });
  localStorage.setItem(PREFIX, MARKER);
  localStorage.setItem(`${PREFIX}-written-at`, new Date().toISOString());
  sessionStorage.setItem(PREFIX, MARKER);
  await read();
});
action('read', read);
action('clear', async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('kamui-keychain');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other probe tabs first'));
  });
  localStorage.removeItem(PREFIX);
  localStorage.removeItem(`${PREFIX}-written-at`);
  sessionStorage.removeItem(PREFIX);
  await read();
});
void read();
