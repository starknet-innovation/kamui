// The login demo page: the SDK's login flow, step by step, with timings.
// Development only: the device key is kept in sessionStorage so it survives the redirect.
import { RpcProvider } from 'starknet';
import {
  KamuiReader,
  authUrl,
  beginLogin,
  completeLogin,
  exportPepper,
  fetchPepper,
  httpRecoverBackend,
  newKeyPair,
  parseLoginRedirect,
  serializePepperFile,
  type KeyPair,
  type LoginAttempt,
} from '../../sdk/src';

type Config = { googleClientId: string; rpcUrl: string; classHash: string; pepperUrl: string; apiUrl: string; redirectUri: string };

const STORE = 'kamui-login-demo';
const $ = (id: string) => document.getElementById(id)!;
const started = performance.now();
const log = (text: string) => {
  const seconds = ((performance.now() - started) / 1000).toFixed(1).padStart(6);
  $('log').textContent += `${seconds}s  ${text}\n`;
};
const row = (name: string, value: string) => {
  const tr = document.createElement('tr');
  for (const text of [name, value]) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.append(td);
  }
  $('result').append(tr);
};
const button = (label: string, onClick: () => void) => {
  const el = document.createElement('button');
  el.textContent = label;
  el.onclick = onClick;
  $('actions').append(el);
};
async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const value = await work();
    log(`${label}: done in ${((performance.now() - start) / 1000).toFixed(1)} s`);
    return value;
  } catch (error) {
    log(`${label}: FAILED after ${((performance.now() - start) / 1000).toFixed(1)} s: ${(error as Error).message}`);
    throw error;
  }
}

const config = (await (await fetch('/config.json')).json()) as Config;
const provider = new RpcProvider({ nodeUrl: config.rpcUrl });

/** Starts a login. With `device`, as a device that already has a key; without, as a new device. */
function start(device: KeyPair = newKeyPair()) {
  const attempt = beginLogin('google', device.publicKey);
  sessionStorage.setItem(STORE, JSON.stringify({ device, attempt }));
  location.assign(authUrl(attempt, config.googleClientId, config.redirectUri));
}

async function finish(device: KeyPair, attempt: LoginAttempt) {
  const answer = parseLoginRedirect(location.hash, attempt);
  history.replaceState(null, '', '/');
  if (!answer) return;
  const chainId = await provider.getChainId();
  log(`token received for device key ${device.publicKey.slice(0, 12)}…`);

  const pepper = await timed('pepper service (with key proof)', () =>
    fetchPepper({ serviceUrl: config.pepperUrl, idToken: answer.idToken, attempt, device }),
  );
  log(`pepper is non-zero: ${BigInt(pepper.pepper) !== 0n}, key version ${pepper.keyVersion}`);

  const login = await timed('complete login (deploy if needed, prove, recover)', () =>
    completeLogin({
      provider,
      backend: httpRecoverBackend(config.apiUrl),
      chainId,
      classHash: config.classHash,
      idToken: answer.idToken,
      attempt,
      device,
      pepper,
    }),
  );

  const reader = new KamuiReader(provider, login.account);
  const owners = await reader.owners();
  row('account', login.account);
  row('status', login.status);
  row('account existed before', String(login.existed));
  row('recover transaction', login.transactionHash ?? '(none: nothing was sent)');
  row('owners', String(owners.length));
  row('this device is an owner', String(await reader.isOwner(device.publicKey)));
  row('session epoch', String(await reader.sessionEpoch()));

  button('Download pepper recovery file', () => {
    const file = exportPepper({ chainId, classHash: config.classHash, claims: answer.claims, pepper: pepper.pepper, keyVersion: pepper.keyVersion });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([serializePepperFile(file)], { type: 'application/json' }));
    link.download = 'kamui-pepper.json';
    link.click();
  });
  button('Sign in again with this device (should send nothing)', () => start(device));
}

button('Continue with Google (as a new device)', () => start());
const stored = sessionStorage.getItem(STORE);
if (stored) {
  const { device, attempt } = JSON.parse(stored) as { device: KeyPair; attempt: LoginAttempt };
  if (location.hash) {
    finish(device, attempt).catch((error) => log(`login failed: ${(error as Error).message}`));
  } else {
    // This tab already has a device key from an earlier login.
    button('Sign in again with this device (should send nothing)', () => start(device));
  }
}
