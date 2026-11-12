// The Kamui keychain, version 1: full-page redirects (see sdk/src/keychain.ts).
//
// Pages:
//   /connect   an app asks to connect; the request is in the URL fragment
//   /execute   an app asks for one transaction to be approved
//   /callback  the issuer returns here after a sign-in
//   /          this device's account: owners, recovery file
//
// Everything a site or a token supplies is written with textContent, never as HTML.
import { RpcProvider } from 'starknet';
import {
  KamuiReader,
  authUrl,
  beginLogin,
  callsFromWire,
  completeLogin,
  createSessionCalls,
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
  removeOwnerCall,
  resultUrl,
  serializePepperFile,
  sessionFromWire,
  sessionProblems,
  sponsor,
  type ConnectRequest,
  type ExecuteRequest,
  type KeyPair,
  type LoginAttempt,
} from '../../sdk/src';
import { forget, loadLogin, loadPendingDevice, saveLogin, savePendingDevice, type AccountRecord } from './vault';

type Config = { googleClientId: string; rpcUrl: string; classHash: string; pepperUrl: string; apiUrl: string; redirectUri: string; pollMs: number };

const REQUEST = 'kamui.keychain.request';
const ATTEMPT = 'kamui.keychain.attempt';

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

function button(label: string, onClick: () => void | Promise<void>, primary = false): HTMLButtonElement {
  const node = el('button', label, primary ? 'primary' : '');
  node.onclick = async () => {
    for (const b of view.querySelectorAll('button')) b.disabled = true;
    try {
      await onClick();
    } catch (error) {
      status('');
      view.append(el('p', (error as Error).message, 'error'));
      for (const b of view.querySelectorAll('button')) b.disabled = false;
    }
  };
  return node;
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

async function startLogin() {
  // This page may be stale: the user may have signed in from another tab since it was drawn.
  // A second sign-in would add a second key for the same device, so look again first.
  const existing = await loadLogin();
  if (existing && (await new KamuiReader(provider, existing.account.account).isOwner(existing.device.publicKey))) {
    return resume();
  }
  const device = newKeyPair();
  await savePendingDevice(device);
  const attempt = beginLogin('google', device.publicKey);
  sessionStorage.setItem(ATTEMPT, JSON.stringify(attempt));
  location.assign(authUrl(attempt, config.googleClientId, config.redirectUri));
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
  nodes.push(
    el('p', 'Signing in on a new device adds a key for this device to your account. It takes about a minute, and it ends every session your apps have, on all your devices.', 'warn'),
    button('Continue with Google', startLogin, true),
  );
  if (request) nodes.push(button('Cancel', () => answer(request, { ok: false, error: 'cancelled by the user' })));
  show(...nodes);
}

async function finishLogin() {
  const attemptText = sessionStorage.getItem(ATTEMPT);
  const device = await loadPendingDevice();
  const fragment = location.hash;
  history.replaceState(null, '', '/');
  if (!attemptText || !device) throw new Error('This sign-in was not started here. Please start again.');
  const attempt = JSON.parse(attemptText) as LoginAttempt;
  sessionStorage.removeItem(ATTEMPT);

  const response = parseLoginRedirect(fragment, attempt);
  if (!response) throw new Error('No sign-in answer was found.');

  show(el('h2', 'Signing in'), el('p', 'Keep this page open. A new device takes about a minute.', 'note'));
  status('Looking up your account…');
  const chainId = await provider.getChainId();
  const pepper = await fetchPepper({ serviceUrl: config.pepperUrl, idToken: response.idToken, attempt, device });

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

function showApproval(request: ConnectRequest, device: KeyPair, record: AccountRecord) {
  const origin = new URL(request.redirectUri).origin;
  const session = request.session;
  const problems = sessionProblems(record.account, session);
  const { params, limits } = sessionFromWire(session);

  const nodes: Node[] = [
    el('h2', 'Connection request'),
    el('p', origin, 'origin'),
    el('p', request.appName ? `It calls itself "${request.appName}". Trust the address above, not the name.` : 'Check that this is the site you came from.', 'note'),
    el('p', 'It asks for a session: permission to act for your account without asking you each time, within these limits.'),
    el('h2', 'What it may call'),
    table(['Contract', 'Function'], session.calls.map((call) => [code(short(call.to)), code(call.entrypoint)])),
    el('h2', 'Limits'),
    table([], [
      ['Until', new Date(session.validUntil * 1000).toLocaleString()],
      ['Transactions', `at most ${session.maxCalls} sponsored, and ${session.maxCalls} paid by your account`],
      ['Fees from your account', BigInt(session.maxFeePerTx) === 0n ? 'none: every transaction must be sponsored' : `at most ${Number(BigInt(session.maxFeePerTx)) / 1e18} STRK per transaction`],
    ]),
  ];

  if (limits.length) {
    nodes.push(
      el('h2', 'Spending limits'),
      table(
        ['Token', 'Per call', 'Per period'],
        limits.map((limit) => [code(short(limit.token)), String(limit.maxPerCall), `${limit.maxPerWindow} every ${Math.round(limit.windowSeconds / 60)} min`]),
      ),
      el('p', 'Amounts are in the token\'s smallest unit.', 'note'),
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
      answer(request, { ok: true, account: record.account, chainId: record.chainId, classHash: record.classHash });
    }, true),
    button('Deny', () => answer(request, { ok: false, error: 'denied by the user' })),
  );
  show(...nodes);
}

//
// Transaction approval
//

function showTransaction(request: ExecuteRequest, device: KeyPair, record: AccountRecord) {
  const origin = new URL(request.redirectUri).origin;
  const problems = executeProblems(record.account, request.calls);

  const nodes: Node[] = [
    el('h2', 'Transaction request'),
    el('p', origin, 'origin'),
    el('p', request.appName ? `It calls itself "${request.appName}". Trust the address above, not the name.` : 'Check that this is the site you came from.', 'note'),
    el('p', 'It asks you to approve one transaction from your account. This uses your full authority: no session limit or spending limit applies to it.', 'warn'),
  ];

  request.calls.forEach((call, index) => {
    nodes.push(el('h2', request.calls.length > 1 ? `Call ${index + 1} of ${request.calls.length}` : 'What it does'));
    const what = describeCall(call);
    if (what.kind === 'transfer') {
      nodes.push(el('p', `Sends ${what.amount} units of a token out of your account.`, 'warn'));
    } else if (what.kind === 'approve') {
      nodes.push(el('p', `Lets another address spend up to ${what.amount} units of a token from your account.`, 'warn'));
    }
    const rows: (string | Node)[][] = [
      ['Contract', code(call.to)],
      ['Function', code(call.entrypoint)],
    ];
    if (what.kind === 'transfer') rows.push(['To', code(what.recipient)], ['Amount', `${what.amount} (smallest unit)`]);
    else if (what.kind === 'approve') rows.push(['Spender', code(what.spender)], ['Amount', `${what.amount} (smallest unit)`]);
    else rows.push(['Arguments', call.calldata.length ? code(call.calldata.join(', ')) : 'none']);
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
          if (!confirm('Remove this device key? Every session on your account will end.')) return;
          status('Removing the key…');
          const call = ownerOutsideExecution({
            chainId: record.chainId,
            account: record.account,
            calls: [removeOwnerCall(record.account, owner)],
            ownerPrivateKey: device.privateKey,
            window: { executeBefore: Math.floor(Date.now() / 1000) + 600 },
          });
          await provider.waitForTransaction(await sponsor(`${config.apiUrl}/sponsor`, call));
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
    el('h2', 'Recovery file'),
    el('p', 'Keep a copy. Together with your Google sign-in, it lets you reach your account even if Kamui\'s own lookup service is ever lost. Anyone who has the file can see which account is yours, but cannot use it.', 'note'),
    button('Download recovery file', () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([serializePepperFile(record.pepperFile)], { type: 'application/json' }));
      link.download = 'kamui-recovery.json';
      link.click();
    }),
    el('h2', 'This device'),
    button('Forget this device', async () => {
      if (!confirm('Forget the key on this device? Its key stays on your account until you remove it from another device.')) return;
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
