// Sign-in: the sign-in page, the trip to the issuer, and adding this device to the account on return.
import { browserProver, assertBrowserProvingSupported, provingSupported } from './proving';
import {
  KamuiReader,
  authUrl,
  beginLogin,
  browserRecoverBackend,
  completeLogin,
  exportPepper,
  fetchPepper,
  newKeyPair,
  parseLoginRedirect,
  parsePepperFile,
  pepperFromFile,
  type LoginAttempt,
  type LoginProvider,
  type Pepper,
  type PepperFile,
} from '../../sdk/src';
import { loadLogin, loadPendingDevice, saveLogin, savePendingDevice, savePendingPepperFile, takePendingPepperFile } from './vault';
import { config, provider, view } from './context';
import { answer, pendingRequest } from './request';
import { button, el, sameFelt, short, show, status } from './ui';

const ATTEMPT = 'kamui.keychain.attempt';
/** A recovery file is a few hundred bytes. Anything much larger is not one. */
const MAX_RECOVERY_FILE_BYTES = 16_384;

/** Shows the right page for where things stand. Passed in by main.ts, which owns routing. */
type Resume = () => Promise<void>;

function assertProvingAvailable() {
  assertBrowserProvingSupported(config.proverRpcUrl);
  if (!config.proverReady) throw new Error('Browser prover assets are unavailable. The wallet operator must install the pinned release before recovery.');
  if (![config.proverExecutor, config.jwkRegistry].every(v => /^0x[0-9a-f]+$/i.test(v) && BigInt(v) !== 0n)) throw new Error('Browser proving is not configured for this network.');
}

const ISSUERS: Record<LoginProvider, { name: string; iss: string }> = {
  google: { name: 'Google', iss: 'https://accounts.google.com' },
  apple: { name: 'Apple', iss: 'https://appleid.apple.com' },
};

const clientIdOf = (provider: LoginProvider) => (provider === 'google' ? config.googleClientId : config.appleClientId ?? '');

/** What the tab keeps while the user is at the issuer. The recovery file itself is in the vault. */
type StoredAttempt = { attempt: LoginAttempt; fromFile: boolean };

/**
 * Reads a recovery file the user chose and checks what can be checked before the sign-in: that
 * it is a recovery file, for this network and this version of the account. Whether it is this
 * user's can only be told once the issuer has answered (`finishLogin`).
 */
async function readRecoveryFile(chosen: File): Promise<PepperFile> {
  if (chosen.size > MAX_RECOVERY_FILE_BYTES) throw new Error('This is not a Kamui recovery file: it is too large.');
  let file: PepperFile;
  try {
    file = parsePepperFile(await chosen.text());
  } catch (error) {
    throw new Error(`This is not a Kamui recovery file (${(error as Error).message.replace(/^pepper file: /, '')}).`);
  }
  if (!sameFelt(file.chainId, await provider.getChainId())) throw new Error('This recovery file is for another network and cannot be used here.');
  if (!sameFelt(file.classHash, config.classHash)) throw new Error('This recovery file is for another version of the Kamui account and cannot be used here.');
  return file;
}

async function startLogin(via: LoginProvider, file: PepperFile | null, resume: Resume) {
  // This page may be stale: the user may have signed in from another tab since it was drawn.
  // A second sign-in would add a second key for the same device, so look again first.
  const existing = await loadLogin();
  if (existing && (await new KamuiReader(provider, existing.account.account).isOwner(existing.device.publicKey))) {
    return resume();
  }
  assertProvingAvailable();
  if (file) {
    const issuer = ISSUERS[via];
    if (file.iss !== issuer.iss) {
      const other = Object.values(ISSUERS).find((known) => known.iss === file.iss);
      throw new Error(`This recovery file is for a sign-in with ${other ? other.name : 'another service'}, not with ${issuer.name}.`);
    }
    if (file.aud !== clientIdOf(via)) throw new Error('This recovery file was made for another application and cannot be used here.');
  }
  const device = newKeyPair();
  await savePendingDevice(device);
  // The file waits in the vault, sealed like the keys, and is taken out again by `finishLogin`.
  // Without a file, this also removes one left by a sign-in that was never finished.
  await savePendingPepperFile(file);
  const attempt = beginLogin(via, device.publicKey);
  sessionStorage.setItem(ATTEMPT, JSON.stringify({ attempt, fromFile: file !== null } satisfies StoredAttempt));
  location.assign(authUrl(attempt, clientIdOf(via), config.redirectUri));
}

export function showSignIn(resume: Resume, reason = '') {
  const pending = pendingRequest();
  const request = pending?.request;
  const nodes: Node[] = [el('h2', 'Sign in')];
  if (pending) {
    const origin = new URL(pending.request.redirectUri).origin;
    nodes.push(el('p', pending.kind === 'connect' ? `${origin} wants to connect. Sign in first.` : `${origin} asks you to approve a transaction. Sign in first.`));
  }
  if (reason) nodes.push(el('p', reason, 'note'));

  // The recovery file, if the user chooses one. It stays in this page until a sign-in starts.
  let file: PepperFile | null = null;
  let reading: Promise<void> = Promise.resolve();
  const input = el('input');
  input.type = 'file';
  input.id = 'recovery-file';
  input.accept = '.json,application/json';
  const label = el('label', 'Recovery file (optional)');
  label.htmlFor = input.id;
  const fileNote = el('p', '', 'note');
  fileNote.id = 'recovery-file-note';
  input.onchange = () => {
    reading = (async () => {
      file = null;
      fileNote.className = 'note';
      fileNote.textContent = '';
      const chosen = input.files?.[0];
      if (!chosen) return;
      try {
        file = await readRecoveryFile(chosen);
        fileNote.textContent = `Recovery file for the account ${short(file.account)}. Your account will be taken from this file, and Kamui's lookup service will not be asked.`;
      } catch (error) {
        input.value = '';
        fileNote.className = 'error';
        fileNote.textContent = (error as Error).message;
      }
    })();
  };
  const signIn = (via: LoginProvider) => async () => {
    await reading;
    await startLogin(via, file, resume);
  };

  const fromAnotherDevice = [
    el('h2', 'Already use Kamui on another device?'),
    el('p', 'Open Kamui there, choose "Add another device" on your account page, and open the link it gives you in this browser. That needs no sign-in here and no proof.', 'note'),
  ];
  if (!provingSupported()) {
    // Said before the trip to the issuer, not after it. Nothing is sent to a server to prove instead.
    nodes.push(
      el('p', 'This browser cannot do a first sign-in. Signing in on a new device makes a proof inside the browser, and that needs a recent desktop Chromium browser such as Chrome, with WebAssembly memory64 and about 8 GB of memory. Kamui does not send your sign-in to a server to make the proof for you.', 'warn'),
      ...fromAnotherDevice,
      el('h2', 'New to Kamui?'),
      el('p', 'Open this page in Chrome on a desktop computer and sign in there first. From its account page you can then add other devices without a proof.', 'note'),
    );
    if (request) nodes.push(button('Cancel', () => answer(request, { ok: false, error: 'cancelled by the user' })));
    return show(...nodes);
  }

  nodes.push(
    el('p', 'Signing in on a new device adds a key for this device to your account. Proving runs in this browser and may take several minutes; it ends every session your apps have, on all your devices.', 'warn'),
    el('p', 'New-device recovery currently requires a recent desktop Chromium browser with WebAssembly memory64 and at least 8 GB of device RAM recommended.', 'note'),
    el('p', 'Browser storage can disappear. Safari may clear it after inactivity; private browsing and clearing website data can also remove this device’s key. If a key is lost, you will need another sign-in. A recovery file replaces the account lookup; it does not restore the lost device key or keep sessions alive.', 'note'),
    button('Continue with Google', signIn('google'), true),
  );
  if (config.appleClientId) nodes.push(button('Continue with Apple', signIn('apple'), true));
  if (request) nodes.push(button('Cancel', () => answer(request, { ok: false, error: 'cancelled by the user' })));
  nodes.push(
    el('h2', 'Using a recovery file'),
    el('p', 'If you kept a recovery file, you can choose it here before you continue. You still sign in as usual; the file only replaces Kamui\'s lookup service, in case it cannot be reached.', 'note'),
    label,
    input,
    fileNote,
    ...fromAnotherDevice,
  );
  show(...nodes);
}

export async function finishLogin() {
  // Take the token out of the address bar, and the recovery file out of storage, before
  // anything can fail.
  const fragment = location.hash;
  history.replaceState(null, '', '/');
  const stored = sessionStorage.getItem(ATTEMPT);
  sessionStorage.removeItem(ATTEMPT);
  const device = await loadPendingDevice();
  const file = await takePendingPepperFile();
  if (!stored || !device) throw new Error('This sign-in was not started here. Please start again.');
  const { attempt, fromFile } = JSON.parse(stored) as StoredAttempt;

  const response = parseLoginRedirect(fragment, attempt);
  if (!response) throw new Error('No sign-in answer was found.');

  show(el('h2', 'Signing in'), el('p', 'Keep this page open. A new device proves in this browser and may take several minutes.', 'note'));
  status('Looking up your account…');
  const chainId = await provider.getChainId();
  let pepper: Pepper;
  if (fromFile) {
    // The sign-in was started with a recovery file. The lookup service is not asked, and is
    // not fallen back to: if the file is gone or is someone else's, the sign-in stops.
    if (!file) throw new Error('The recovery file you chose is no longer here. Please start again.');
    try {
      pepper = pepperFromFile(file, response.claims, chainId, config.classHash);
    } catch {
      throw new Error('This recovery file does not belong to the account you signed in with. Nothing was changed. Start again with the right file, or without one.');
    }
  } else {
    pepper = await fetchPepper({ serviceUrl: config.pepperUrl, idToken: response.idToken, attempt, device });
  }

  status('Adding this device to your account. This is the slow step…');
  const proving = new AbortController();
  const cancel = button('Cancel proving', () => proving.abort());
  view.append(cancel);
  const login = await completeLogin({
    provider,
    backend: browserRecoverBackend({
      apiUrl: config.apiUrl, provider, classHash: config.classHash,
      assertSupported: assertProvingAvailable,
      onStatus: status,
      onSubmitting: () => cancel.remove(), // A broadcast cannot be cancelled by closing a Worker.
      prove: browserProver({ rpcUrl: config.proverRpcUrl, executor: config.proverExecutor, registry: config.jwkRegistry, onStatus: status, signal: proving.signal }),
    }),
    chainId,
    classHash: config.classHash,
    idToken: response.idToken,
    attempt,
    device,
    pepper,
  });

  cancel.remove();
  await saveLogin(device, {
    account: login.account,
    chainId,
    classHash: config.classHash,
    pepper: pepper.pepper,
    keyVersion: pepper.keyVersion,
    pepperFile: exportPepper({ chainId, classHash: config.classHash, claims: response.claims, pepper: pepper.pepper, keyVersion: pepper.keyVersion }),
  });
  status('');
}
