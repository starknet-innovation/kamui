// The Kamui keychain, version 1: full-page redirects (see sdk/src/keychain.ts).
//
// Pages:
//   /connect   an app asks to connect; the request is in the URL fragment
//   /execute   an app asks for one transaction to be approved
//   /callback  the issuer returns here after a sign-in
//   /          this device's account: owners, sessions, recovery file
//
// Everything a site or a token supplies is written with textContent, never as HTML.
import { RpcProvider } from 'starknet';
import {
  KamuiReader,
  SPENDING_ENTRYPOINTS,
  authUrl,
  beginLogin,
  callsFromWire,
  completeLogin,
  createSessionCalls,
  describeAmount,
  describeCall,
  executeProblems,
  exportPepper,
  fetchPepper,
  httpRecoverBackend,
  newKeyPair,
  ownerOutsideExecution,
  parseConnectRequest,
  parseExecuteRequest,
  parseLoginRedirect,
  parsePepperFile,
  pepperFromFile,
  readTokenInfo,
  registryClient,
  removeOwnerCall,
  resultUrl,
  revokeAllSessionsCall,
  revokeSessionCall,
  serializePepperFile,
  sessionFromWire,
  sessionProblems,
  sponsor,
  type ConnectRequest,
  type ExecuteRequest,
  type KeyPair,
  type LoginAttempt,
  type LoginProvider,
  type Pepper,
  type PepperFile,
  type RegistryEntry,
  type RegistrySession,
  type ScopedCall,
  type TokenInfo,
} from '../../sdk/src';
import {
  forget,
  loadLogin,
  loadPendingDevice,
  loadUnrecordedSessions,
  saveLogin,
  savePendingDevice,
  savePendingPepperFile,
  saveUnrecordedSessions,
  takePendingPepperFile,
  type AccountRecord,
} from './vault';

type Config = { googleClientId: string; appleClientId?: string; rpcUrl: string; classHash: string; pepperUrl: string; apiUrl: string; redirectUri: string; pollMs: number };

const REQUEST = 'kamui.keychain.request';
const ATTEMPT = 'kamui.keychain.attempt';
/** How long the keychain waits for the session registry before going on without it. */
const REGISTRY_TIMEOUT_MS = 5000;
/** A recovery file is a few hundred bytes. Anything much larger is not one. */
const MAX_RECOVERY_FILE_BYTES = 16_384;

const view = document.getElementById('view')!;
const statusLine = document.getElementById('status')!;
const config = (await (await fetch('/config.json')).json()) as Config;
const provider = new RpcProvider({ nodeUrl: config.rpcUrl, transactionRetryIntervalFallback: config.pollMs });

//
// Small DOM helpers
//

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function show(...nodes: Node[]) {
  view.replaceChildren(...nodes);
}

const status = (text: string) => (statusLine.textContent = text);

/**
 * A button that disables every button on the page while its action runs. An action normally
 * ends by drawing another page or leaving this one. One that does neither (a declined
 * confirmation, a download) returns false, and the buttons work again.
 */
function button(label: string, onClick: () => void | false | Promise<void | false>, primary = false): HTMLButtonElement {
  const node = el('button', label, primary ? 'primary' : '');
  node.onclick = async () => {
    for (const b of view.querySelectorAll('button')) b.disabled = true;
    try {
      if ((await onClick()) === false) {
        for (const b of view.querySelectorAll('button')) b.disabled = false;
      }
    } catch (error) {
      status('');
      view.append(el('p', (error as Error).message, 'error'));
      for (const b of view.querySelectorAll('button')) b.disabled = false;
    }
  };
  return node;
}

/**
 * Asks the user to confirm, inside the page. Not `window.confirm`: embedded browsers and webviews
 * often suppress native dialogs and answer "cancel" without showing anything, which made these
 * buttons do nothing there. Shown under the button that asked; resolves when one is chosen.
 */
function ask(question: string, yes: string): Promise<boolean> {
  const asker = document.activeElement instanceof HTMLButtonElement && view.contains(document.activeElement) ? document.activeElement : null;
  const box = el('div', '', 'confirm');
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-label', 'Confirm');
  const text = el('p', question);
  text.id = 'confirm-question';
  box.setAttribute('aria-describedby', text.id);
  const accept = el('button', yes, 'primary');
  const cancel = el('button', 'Cancel');
  box.append(text, accept, cancel);
  if (asker) asker.after(box);
  else view.append(box);
  cancel.focus();
  return new Promise((resolve) => {
    const answer = (value: boolean) => {
      box.remove();
      resolve(value);
    };
    accept.onclick = () => answer(true);
    cancel.onclick = () => answer(false);
  });
}

function table(headers: string[], rows: (string | Node)[][]): HTMLTableElement {
  const node = el('table');
  if (headers.length) {
    const head = el('tr');
    for (const header of headers) head.append(el('th', header));
    node.append(head);
  }
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      td.append(typeof cell === 'string' ? document.createTextNode(cell) : cell);
      tr.append(td);
    }
    node.append(tr);
  }
  return node;
}

const short = (felt: string) => (felt.length > 20 ? `${felt.slice(0, 10)}…${felt.slice(-6)}` : felt);
const code = (text: string) => el('code', text);
const sameFelt = (a: string, b: string) => BigInt(a) === BigInt(b);

/** Fails if `work` has not settled after `ms`. The work itself is not stopped. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}

/** Sends calls from the account, signed by this device's key and sponsored, and waits for them. */
async function sendAsOwner(device: KeyPair, record: AccountRecord, calls: Parameters<typeof ownerOutsideExecution>[0]['calls']): Promise<string> {
  const call = ownerOutsideExecution({
    chainId: record.chainId,
    account: record.account,
    calls,
    ownerPrivateKey: device.privateKey,
    window: { executeBefore: Math.floor(Date.now() / 1000) + 600 },
  });
  const transaction = await sponsor(`${config.apiUrl}/sponsor`, call);
  status('Waiting for the network…');
  await provider.waitForTransaction(transaction);
  return transaction;
}

//
// Tokens: what an amount means
//

/** Looks up every token an approval screen will mention, once. */
async function lookUpTokens(addresses: string[]): Promise<(address: string) => TokenInfo> {
  const unique = [...new Set(addresses.map((address) => BigInt(address)))];
  const infos = await Promise.all(unique.map((address) => readTokenInfo(provider, `0x${address.toString(16)}`)));
  return (address) => infos[unique.indexOf(BigInt(address))] ?? { status: 'unknown', address };
}

/** A token as a table cell: its name if Kamui recognises it, otherwise what it claims, and always its address. */
function tokenCell(info: TokenInfo): Node {
  const cell = el('span');
  const name = info.status === 'known' ? info.symbol : info.status === 'unverified' ? `says it is "${info.symbol}"` : 'unidentified';
  cell.append(document.createTextNode(`${name} `), code(short(info.address)));
  return cell;
}

/** What to say about a token Kamui cannot vouch for. Nothing for a known one. */
function tokenCaution(info: TokenInfo): Node | null {
  if (info.status === 'known') return null;
  const text =
    info.status === 'unverified'
      ? `Kamui does not recognise this token. It says it is "${info.symbol}", but anyone can make a token with that name. Check the contract address before you approve.`
      : 'Kamui could not identify this token, so the amount is shown in its smallest unit and may be much larger or smaller than it looks.';
  return el('p', text, 'warn');
}

type Limit = { token: string; maxPerCall: bigint; maxPerWindow: bigint; windowSeconds: number };

/** A session's expiry, transaction count and fee cap, as table rows. */
function limitRows(validUntil: number, maxCalls: number, maxFeePerTx: bigint): (string | Node)[][] {
  return [
    ['Until', new Date(validUntil * 1000).toLocaleString()],
    ['Transactions', `at most ${maxCalls} sponsored, and ${maxCalls} paid by your account`],
    ['Fees from your account', maxFeePerTx === 0n ? 'none: every transaction must be sponsored' : `at most ${Number(maxFeePerTx) / 1e18} STRK per transaction`],
  ];
}

/** Spending limits as a table, followed by a caution for each token Kamui cannot vouch for. */
function spendingLimits(limits: Limit[], tokenOf: (address: string) => TokenInfo): Node[] {
  const nodes: Node[] = [
    table(
      ['Token', 'Per call', 'Per period'],
      limits.map((limit) => {
        const info = tokenOf(limit.token);
        return [tokenCell(info), describeAmount(limit.maxPerCall, info), `${describeAmount(limit.maxPerWindow, info)} every ${Math.round(limit.windowSeconds / 60)} min`];
      }),
    ),
  ];
  for (const limit of limits) {
    const caution = tokenCaution(tokenOf(limit.token));
    if (caution) nodes.push(caution);
  }
  return nodes;
}

//
// Pending connect request (survives the trip to the issuer)
//

type Pending = { kind: 'connect'; request: ConnectRequest } | { kind: 'execute'; request: ExecuteRequest };

function pendingRequest(): Pending | null {
  const text = sessionStorage.getItem(REQUEST);
  return text ? (JSON.parse(text) as Pending) : null;
}

type Answer =
  | { ok: true; account: string; chainId: string; classHash: string }
  | { ok: true; transactionHash: string }
  | { ok: false; error: string };

function answer(request: { id: string; redirectUri: string }, result: Answer) {
  sessionStorage.removeItem(REQUEST);
  location.assign(resultUrl(request, { v: 1, id: request.id, ...result }));
}

//
// Sign-in
//

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

async function startLogin(via: LoginProvider, file: PepperFile | null) {
  // This page may be stale: the user may have signed in from another tab since it was drawn.
  // A second sign-in would add a second key for the same device, so look again first.
  const existing = await loadLogin();
  if (existing && (await new KamuiReader(provider, existing.account.account).isOwner(existing.device.publicKey))) {
    return resume();
  }
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

function showSignIn(reason = '') {
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
    await startLogin(via, file);
  };

  nodes.push(
    el('p', 'Signing in on a new device adds a key for this device to your account. It takes about a minute, and it ends every session your apps have, on all your devices.', 'warn'),
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
  );
  show(...nodes);
}

async function finishLogin() {
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

  show(el('h2', 'Signing in'), el('p', 'Keep this page open. A new device takes about a minute.', 'note'));
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
  const login = await completeLogin({
    provider,
    backend: httpRecoverBackend(config.apiUrl),
    chainId,
    classHash: config.classHash,
    idToken: response.idToken,
    attempt,
    device,
    pepper,
  });

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

//
// Session approval
//

async function showApproval(request: ConnectRequest, device: KeyPair, record: AccountRecord) {
  const origin = new URL(request.redirectUri).origin;
  const session = request.session;
  const problems = sessionProblems(record.account, session);
  const { params, limits } = sessionFromWire(session);
  const tokenOf = await lookUpTokens(limits.map((limit) => limit.token));

  const nodes: Node[] = [
    el('h2', 'Connection request'),
    el('p', origin, 'origin'),
    el('p', request.appName ? `It calls itself "${request.appName}". Trust the address above, not the name.` : 'Check that this is the site you came from.', 'note'),
    el('p', 'It asks for a session: permission to act for your account without asking you each time, within these limits.'),
    el('h2', 'What it may call'),
    table(['Contract', 'Function'], session.calls.map((call) => [code(short(call.to)), code(call.entrypoint)])),
    el('h2', 'Limits'),
    table([], limitRows(session.validUntil, session.maxCalls, BigInt(session.maxFeePerTx))),
  ];

  if (limits.length) {
    nodes.push(
      el('h2', 'Spending limits'),
      ...spendingLimits(
        limits.map((limit) => ({ token: limit.token, maxPerCall: BigInt(limit.maxPerCall), maxPerWindow: BigInt(limit.maxPerWindow), windowSeconds: limit.windowSeconds })),
        tokenOf,
      ),
    );
  }

  nodes.push(
    el('p', 'While the session lasts, this site can also sign messages as your account. It ends when it expires, when you add or remove a device, or when you revoke it.', 'note'),
  );

  if (problems.length) {
    const list = el('ul');
    for (const problem of problems) list.append(el('li', problem));
    const box = el('div', '', 'error');
    box.append(el('p', 'Kamui will not approve this request:'), list);
    nodes.push(box, button('Go back', () => answer(request, { ok: false, error: `refused by the keychain: ${problems[0]}` }), true));
    show(...nodes);
    return;
  }

  nodes.push(
    button('Approve', async () => {
      status('Approving the session…');
      const calls = createSessionCalls(record.account, params, limits);
      const call = ownerOutsideExecution({
        chainId: record.chainId,
        account: record.account,
        calls,
        ownerPrivateKey: device.privateKey,
        window: { executeBefore: Math.floor(Date.now() / 1000) + 600 },
      });
      const transaction = await sponsor(`${config.apiUrl}/sponsor`, call);
      status('Waiting for the network…');
      await provider.waitForTransaction(transaction);
      const stored = await new KamuiReader(provider, record.account).session(session.publicKey);
      if (!stored.exists) throw new Error('The session was sent but the account does not show it.');
      await recordSession(device, record, { ...session, origin, ...(request.appName ? { appName: request.appName } : {}) });
      answer(request, { ok: true, account: record.account, chainId: record.chainId, classHash: record.classHash });
    }, true),
    button('Deny', () => answer(request, { ok: false, error: 'denied by the user' })),
  );
  show(...nodes);
}

//
// Transaction approval
//

async function showTransaction(request: ExecuteRequest, device: KeyPair, record: AccountRecord) {
  const origin = new URL(request.redirectUri).origin;
  const problems = executeProblems(record.account, request.calls);
  const described = request.calls.map(describeCall);
  const tokenOf = await lookUpTokens(described.flatMap((what) => (what.kind === 'other' ? [] : [what.token])));

  const nodes: Node[] = [
    el('h2', 'Transaction request'),
    el('p', origin, 'origin'),
    el('p', request.appName ? `It calls itself "${request.appName}". Trust the address above, not the name.` : 'Check that this is the site you came from.', 'note'),
    el('p', 'It asks you to approve one transaction from your account. This uses your full authority: no session limit or spending limit applies to it.', 'warn'),
  ];

  request.calls.forEach((call, index) => {
    nodes.push(el('h2', request.calls.length > 1 ? `Call ${index + 1} of ${request.calls.length}` : 'What it does'));
    const what = described[index]!;
    const rows: (string | Node)[][] = [
      ['Contract', code(call.to)],
      ['Function', code(call.entrypoint)],
    ];
    if (what.kind === 'other') {
      rows.push(['Arguments', call.calldata.length ? code(call.calldata.join(', ')) : 'none']);
    } else {
      const info = tokenOf(what.token);
      const amount = describeAmount(what.amount, info);
      const of = info.status === 'unknown' ? ' of an unidentified token' : '';
      nodes.push(
        el(
          'p',
          what.kind === 'transfer' ? `Sends ${amount}${of} out of your account.` : `Lets another address spend up to ${amount}${of} from your account.`,
          'warn',
        ),
      );
      const caution = tokenCaution(info);
      if (caution) nodes.push(caution);
      rows.push(
        ['Token', tokenCell(info)],
        [what.kind === 'transfer' ? 'To' : 'Spender', code(what.kind === 'transfer' ? what.recipient : what.spender)],
        ['Amount', `${amount} (${what.amount} in the smallest unit)`],
      );
    }
    nodes.push(table([], rows));
  });

  if (problems.length) {
    const list = el('ul');
    for (const problem of problems) list.append(el('li', problem));
    const box = el('div', '', 'error');
    box.append(el('p', 'Kamui will not approve this request. Device keys, sessions and limits can only be changed here in Kamui, never by a site.'), list);
    nodes.push(box, button('Go back', () => answer(request, { ok: false, error: `refused by the keychain: ${problems[0]}` }), true));
    show(...nodes);
    return;
  }

  nodes.push(
    button('Approve', async () => {
      status('Sending the transaction…');
      const call = ownerOutsideExecution({
        chainId: record.chainId,
        account: record.account,
        calls: callsFromWire(request.calls),
        ownerPrivateKey: device.privateKey,
        window: { executeBefore: Math.floor(Date.now() / 1000) + 600 },
      });
      const transactionHash = await sponsor(`${config.apiUrl}/sponsor`, call);
      status('Waiting for the network…');
      await provider.waitForTransaction(transactionHash);
      answer(request, { ok: true, transactionHash });
    }, true),
    button('Deny', () => answer(request, { ok: false, error: 'denied by the user' })),
  );
  show(...nodes);
}

//
// Sessions: the registry, and what the account says
//

const registryFor = (device: KeyPair, record: AccountRecord) =>
  registryClient({ apiUrl: config.apiUrl, chainId: record.chainId, account: record.account, ownerPrivateKey: device.privateKey });

/**
 * Records an approved session in the registry, so it can be listed and revoked later. It never
 * throws and never takes long: the session exists on chain either way, and the user is on the
 * way back to the app. The session is written to this device's storage first and taken out
 * once the registry has it, so a registry that is down loses nothing: the account page shows
 * the session from here and sends it again.
 */
async function recordSession(device: KeyPair, record: AccountRecord, session: RegistrySession): Promise<void> {
  try {
    const others = (await loadUnrecordedSessions()).filter((other) => !sameFelt(other.publicKey, session.publicKey));
    await saveUnrecordedSessions([...others, session]);
    await within(REGISTRY_TIMEOUT_MS, registryFor(device, record).put(session));
    await saveUnrecordedSessions((await loadUnrecordedSessions()).filter((other) => !sameFelt(other.publicKey, session.publicKey)));
  } catch {
    // Still in this device's storage, unless storing it is what failed.
  }
}

/** A session as the account page shows it. Everything but the site's names is read from the account. */
type LiveSession = {
  publicKey: string;
  /** From the registry or this device's storage. The account does not know them. */
  origin: string;
  appName?: string;
  validUntil: number;
  maxCalls: number;
  maxFeePerTx: bigint;
  /** The calls the registry lists that the account confirms. */
  calls: ScopedCall[];
  /** How many permissions the account holds for the session. */
  scopeEntries: number;
  limits: Limit[];
  /** Tokens the session may spend with no limit. */
  unlimited: string[];
};

/** Reads from the account what a recorded session may really do. Null if it is dead. */
async function readLiveSession(reader: KamuiReader, claimed: RegistrySession): Promise<LiveSession | null> {
  const data = await reader.session(claimed.publicKey);
  if (!data.exists || data.validUntil < Math.floor(Date.now() / 1000)) return null;

  const allowed = await Promise.all(claimed.calls.map((call) => reader.isSessionCallAllowed(claimed.publicKey, call.to, call.entrypoint)));
  const calls = claimed.calls.filter((_, index) => allowed[index]);

  // Spending limits for every token the record names, and every token the session may spend.
  const spendable = calls.filter((call) => (SPENDING_ENTRYPOINTS as readonly string[]).includes(call.entrypoint)).map((call) => call.to);
  const tokens = [...new Set([...claimed.limits.map((limit) => limit.token), ...spendable].map((token) => BigInt(token)))].map((token) => `0x${token.toString(16)}`);
  const policies = await Promise.all(tokens.map((token) => reader.spendingPolicy(claimed.publicKey, token)));
  const limits: Limit[] = [];
  const unlimited: string[] = [];
  tokens.forEach((token, index) => {
    const policy = policies[index]!;
    if (policy.exists) limits.push({ token, maxPerCall: policy.maxPerCall, maxPerWindow: policy.maxPerWindow, windowSeconds: policy.windowSeconds });
    else if (spendable.some((other) => sameFelt(other, token))) unlimited.push(token);
  });

  return {
    publicKey: claimed.publicKey,
    origin: claimed.origin,
    appName: claimed.appName,
    validUntil: data.validUntil,
    maxCalls: data.maxCalls,
    maxFeePerTx: data.maxFeePerTx,
    calls,
    scopeEntries: data.scopeEntries,
    limits,
    unlimited,
  };
}

/**
 * The account's live sessions, as far as they can be found: those the registry lists and those
 * waiting in this device's storage, each checked against the account. Records of sessions that
 * no longer exist are removed, and waiting ones are sent to the registry again; `onFull` is
 * called, possibly after this returns, if the registry has no room for one.
 */
async function loadSessions(device: KeyPair, record: AccountRecord, reader: KamuiReader, onFull: () => void): Promise<{ sessions: LiveSession[]; registryReachable: boolean }> {
  const registry = registryFor(device, record);
  const waiting = await loadUnrecordedSessions();
  let listed: RegistryEntry[] = [];
  let registryReachable = true;
  try {
    listed = await within(REGISTRY_TIMEOUT_MS, registry.list());
  } catch {
    registryReachable = false;
  }

  // This device's own record of a session wins over the registry's.
  const isWaiting = (publicKey: string) => waiting.some((session) => sameFelt(session.publicKey, publicKey));
  const claimed: RegistrySession[] = [...waiting, ...listed.filter((entry) => !isWaiting(entry.publicKey))];
  const read = await Promise.all(claimed.map((session) => readLiveSession(reader, session)));
  const sessions = read.filter((session): session is LiveSession => session !== null);
  const isLive = (publicKey: string) => sessions.some((session) => sameFelt(session.publicKey, publicKey));

  const stillWaiting = waiting.filter((session) => isLive(session.publicKey));
  if (stillWaiting.length !== waiting.length) await saveUnrecordedSessions(stillWaiting);

  if (registryReachable) {
    // Tidy the registry without holding the page up. Whatever fails is tried on the next visit.
    void (async () => {
      for (const entry of listed) {
        if (!isLive(entry.publicKey)) await registry.remove(entry.publicKey).catch(() => {});
      }
      for (const session of stillWaiting) {
        let settled = false;
        try {
          await registry.put(session);
          settled = true;
        } catch (error) {
          // The registry will never take a session that has expired. A full registry may take
          // it later; until then it stays in this device's storage, and the page says so.
          if ((error as Error).message.includes('SESSION_EXPIRED')) settled = true;
          else if ((error as Error).message.includes('REGISTRY_FULL')) onFull();
        }
        if (settled) await saveUnrecordedSessions((await loadUnrecordedSessions()).filter((other) => !sameFelt(other.publicKey, session.publicKey))).catch(() => {});
      }
    })();
  }
  return { sessions, registryReachable };
}

/** The "Sessions" part of the account page. */
async function sessionsSection(device: KeyPair, record: AccountRecord, reader: KamuiReader): Promise<Node[]> {
  const full = el('p', '', 'warn');
  full.hidden = true;
  const { sessions, registryReachable } = await loadSessions(device, record, reader, () => {
    full.textContent = 'Kamui\'s list of your sessions is full. A session approved on this device is shown here but not on your other devices. Revoke the sessions you no longer use.';
    full.hidden = false;
  });
  const tokenOf = await lookUpTokens(sessions.flatMap((session) => [...session.limits.map((limit) => limit.token), ...session.unlimited]));

  const nodes: Node[] = [
    el('h2', `Sessions (${sessions.length})`),
    el('p', 'A session lets a site act for your account within limits, without asking you each time. The limits shown here are read from your account. The site names are what Kamui recorded when you approved each session.', 'note'),
  ];
  if (!registryReachable) {
    nodes.push(el('p', 'Kamui could not load its list of your sessions, so some may be missing here. They keep working until they expire or are revoked. "Revoke all sessions" ends every one of them, listed or not.', 'warn'));
  } else if (sessions.length === 0) {
    nodes.push(el('p', 'No site has a session on your account.'));
  }

  nodes.push(full);

  for (const session of sessions) {
    const box = el('div', '', 'session');
    box.append(el('p', session.origin, 'origin'));
    if (session.appName) box.append(el('p', `It called itself "${session.appName}".`, 'note'));
    if (session.calls.length) {
      box.append(table(['Contract', 'Function'], session.calls.map((call) => [code(short(call.to)), code(call.entrypoint)])));
    }
    if (session.scopeEntries !== session.calls.length) {
      box.append(
        el('p', `Your account holds ${session.scopeEntries} permissions for this session, and Kamui knows ${session.calls.length} of them. It may be able to call more than is shown. Revoke it if you do not recognise it.`, 'warn'),
      );
    }
    box.append(table([], limitRows(session.validUntil, session.maxCalls, session.maxFeePerTx)));
    if (session.limits.length) box.append(...spendingLimits(session.limits, tokenOf));
    for (const token of session.unlimited) {
      const cell = el('p', 'This session can spend any amount of this token: ', 'warn');
      cell.append(tokenCell(tokenOf(token)));
      box.append(cell);
    }
    box.append(
      button('Revoke', async () => {
        status('Revoking the session…');
        await sendAsOwner(device, record, [revokeSessionCall(record.account, session.publicKey)]);
        if ((await reader.session(session.publicKey)).exists) throw new Error('The revocation was sent but the account still shows the session.');
        // The session is gone. Its records are tidied here if possible, and on the next visit if not.
        await saveUnrecordedSessions((await loadUnrecordedSessions()).filter((other) => !sameFelt(other.publicKey, session.publicKey))).catch(() => {});
        await within(REGISTRY_TIMEOUT_MS, registryFor(device, record).remove(session.publicKey)).catch(() => {});
        status('');
        await showHome(device, record);
      }),
    );
    nodes.push(box);
  }

  nodes.push(
    button('Revoke all sessions', async () => {
      if (!(await ask('Revoke every session on your account? Each site will have to ask you again.', 'Yes, revoke all'))) return false;
      status('Revoking every session…');
      await sendAsOwner(device, record, [revokeAllSessionsCall(record.account)]);
      await saveUnrecordedSessions([]).catch(() => {});
      status('');
      // Drawing the page again finds the registry's records dead and removes them.
      await showHome(device, record);
    }),
  );
  return nodes;
}

//
// Home
//

async function showHome(device: KeyPair, record: AccountRecord) {
  const reader = new KamuiReader(provider, record.account);
  const owners = await reader.owners();

  const ownerRows = owners.map((owner, index): (string | Node)[] => {
    const mine = BigInt(owner) === BigInt(device.publicKey);
    const action = mine || owners.length === 1
      ? el('span', mine ? 'this device' : '', 'note')
      : button('Remove', async () => {
          if (!(await ask('Remove this device key? Every session on your account will end.', 'Yes, remove it'))) return false;
          status('Removing the key…');
          await sendAsOwner(device, record, [removeOwnerCall(record.account, owner)]);
          status('');
          await showHome(device, record);
        });
    return [index === 0 ? 'oldest' : `#${index + 1}`, code(short(owner)), action];
  });

  show(
    el('h2', 'Your account'),
    table([], [['Address', code(record.account)]]),
    el('h2', `Devices (${owners.length} of 5)`),
    table(['', 'Key', ''], ownerRows),
    el('p', 'Each device you sign in on has its own key. Removing one ends every session on your account.', 'note'),
    ...(await sessionsSection(device, record, reader)),
    el('h2', 'Recovery file'),
    el('p', 'Keep this file outside the browser. Browser storage can be cleared, including by Safari after inactivity. Losing this device’s key requires another sign-in, which ends every session; a lost key may remain in the device list until you remove it.', 'warn'),
    el('p', 'Keep a copy. Together with your sign-in, it lets you reach your account even if Kamui\'s own lookup service is ever lost: choose the file on the sign-in page. Anyone who has the file can see which account is yours, but cannot use it.', 'note'),
    button('Download recovery file', () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([serializePepperFile(record.pepperFile)], { type: 'application/json' }));
      link.download = 'kamui-recovery.json';
      link.click();
      return false;
    }),
    el('h2', 'This device'),
    button('Forget this device', async () => {
      if (!(await ask('Forget the key on this device? Its key stays on your account until you remove it from another device.', 'Yes, forget it'))) return false;
      await forget();
      await resume();
    }),
  );
}

//
// Routing
//

/** Shows the right page for where things stand: sign in, a pending request, or home. */
async function resume() {
  status('');
  const login = await loadLogin();
  if (!login) return showSignIn();
  // The key may have been removed from another device since the last visit.
  if (!(await new KamuiReader(provider, login.account.account).isOwner(login.device.publicKey))) {
    return showSignIn('This device no longer has access to your account. Sign in again to add it back.');
  }
  const pending = pendingRequest();
  if (pending?.kind === 'connect') return showApproval(pending.request, login.device, login.account);
  if (pending?.kind === 'execute') return showTransaction(pending.request, login.device, login.account);
  return showHome(login.device, login.account);
}

async function main() {
  if (location.pathname === '/connect') {
    // Read the request once, while the referrer still says who sent it, and take it out of the
    // address bar before anything else, whether or not it turns out to be acceptable.
    const fragment = location.hash;
    history.replaceState(null, '', '/connect');
    const request = parseConnectRequest(fragment, document.referrer);
    if (request) sessionStorage.setItem(REQUEST, JSON.stringify({ kind: 'connect', request } satisfies Pending));
  } else if (location.pathname === '/execute') {
    const fragment = location.hash;
    history.replaceState(null, '', '/execute');
    const request = parseExecuteRequest(fragment, document.referrer);
    if (request) sessionStorage.setItem(REQUEST, JSON.stringify({ kind: 'execute', request } satisfies Pending));
  } else if (location.pathname === '/callback') {
    await finishLogin();
  }
  await resume();
}

main().catch((error) => {
  status('');
  const nodes: Node[] = [el('h2', 'Something went wrong'), el('p', (error as Error).message, 'error')];
  const pending = pendingRequest();
  if (pending) nodes.push(button('Go back to the site', () => answer(pending.request, { ok: false, error: 'the keychain could not complete the request' }), true));
  nodes.push(button('Start again', () => location.assign('/')));
  show(...nodes);
});
