// The three requests a site can make: a session (connect), one transaction (execute) and one
// signed message (sign).
import { shortString } from 'starknet';
import {
  KamuiReader,
  callsFromWire,
  createSessionCalls,
  describeAmount,
  describeCall,
  executeProblems,
  ownerOutsideExecution,
  ownerSignTypedData,
  sessionFromWire,
  sessionProblems,
  signMessageProblems,
  sponsor,
  typedDataFields,
  typedDataHash,
  verifyMessageSignature,
  type ConnectRequest,
  type ExecuteRequest,
  type KeyPair,
  type SignMessageRequest,
} from '../../sdk/src';
import type { AccountRecord } from './vault';
import { config, provider } from './context';
import { answer } from './request';
import { recordSession, recordedOrigin } from './sessions';
import { limitRows, lookUpTokens, spendingLimits, tokenCaution, tokenCell } from './tokens';
import { button, code, el, short, show, status, table } from './ui';

//
// Session approval
//

export async function showApproval(request: ConnectRequest, device: KeyPair, record: AccountRecord) {
  const origin = new URL(request.redirectUri).origin;
  const session = request.session;
  const problems = sessionProblems(record.account, session);
  const { params, limits } = sessionFromWire(session);
  const tokenOf = await lookUpTokens(limits.map((limit) => limit.token));

  // A request for a key the account already has a session for is a renewal: approving it
  // replaces that session. Only the site the session was approved for may ask for that; the
  // flag is read from the account, not from the request.
  const renewal = (await new KamuiReader(provider, record.account).session(session.publicKey)).exists;
  const approvedFor = renewal ? await recordedOrigin(device, record, session.publicKey) : null;
  if (approvedFor !== null && approvedFor !== origin) {
    problems.push(`this session key already belongs to a session approved for ${approvedFor}`);
  }

  const nodes: Node[] = [
    el('h2', renewal ? 'Session renewal' : 'Connection request'),
    el('p', origin, 'origin'),
    el('p', request.appName ? `It calls itself "${request.appName}". Trust the address above, not the name.` : 'Check that this is the site you came from.', 'note'),
    el(
      'p',
      renewal
        ? 'It asks to renew a session your account already has: permission to act for your account without asking you each time. Approving replaces that session with the limits below; its count of transactions and its spending periods start again.'
        : 'It asks for a session: permission to act for your account without asking you each time, within these limits.',
    ),
    ...(renewal && approvedFor === null
      ? [el('p', 'Kamui could not check which site this session was first approved for. Approve only if you came from the site above.', 'warn')]
      : []),
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
      const transaction = await sponsor(`${config.apiUrl}/wallet/sponsor`, call);
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

export async function showTransaction(request: ExecuteRequest, device: KeyPair, record: AccountRecord) {
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
// Message approval
//

/** A domain value as the user should read it: the text a felt spells, if it spells one. */
function domainText(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return JSON.stringify(value) ?? '';
  if (!/^0x[0-9a-fA-F]+$/.test(value)) return value;
  try {
    const text = shortString.decodeShortString(value);
    return /^[\x20-\x7e]+$/.test(text) ? `${text} (${value})` : value;
  } catch {
    return value;
  }
}

export async function showMessage(request: SignMessageRequest, device: KeyPair, record: AccountRecord) {
  const origin = new URL(request.redirectUri).origin;
  const data = request.typedData;
  const problems = signMessageProblems(record.chainId, data);
  const domain = data.domain as Record<string, unknown>;

  const nodes: Node[] = [
    el('h2', 'Signature request'),
    el('p', origin, 'origin'),
    el('p', request.appName ? `It calls itself "${request.appName}". Trust the address above, not the name.` : 'Check that this is the site you came from.', 'note'),
    el('p', 'It asks you to sign one message as your account. Nothing is sent to the network and no fee is paid, but a signature can commit you to what the message says. Sign only what you understand, for a site you trust.', 'warn'),
    el('h2', 'Who the message is for'),
    el('p', 'These values are written by the site. Kamui cannot check them.', 'note'),
    table([], Object.keys(domain).map((key) => [key, code(domainText(domain[key]))])),
    el('h2', `Message (${data.primaryType})`),
    table(['Field', 'Type', 'Value'], typedDataFields(data).map((field) => [code(field.path), field.type, code(field.value)])),
    el('h2', 'Signed as'),
    table([], [
      ['Account', code(record.account)],
      ['Message hash', code(typedDataHash(data, record.account))],
    ]),
  ];

  // Everything that goes into the hash, as the site wrote it, for anyone who wants to check.
  const raw = el('details');
  raw.append(el('summary', 'Full typed data'), el('pre', JSON.stringify(data, null, 2)));
  nodes.push(raw);

  if (problems.length) {
    const list = el('ul');
    for (const problem of problems) list.append(el('li', problem));
    const box = el('div', '', 'error');
    box.append(el('p', 'Kamui will not sign this message:'), list);
    nodes.push(box, button('Go back', () => answer(request, { ok: false, error: `refused by the keychain: ${problems[0]}` }), true));
    show(...nodes);
    return;
  }

  nodes.push(
    button('Sign', async () => {
      status('Signing…');
      const signature = ownerSignTypedData(data, record.account, device.privateKey);
      // What the site's verifier will ask the account. If it says no, do not hand the site a
      // signature that will not verify.
      if (!(await verifyMessageSignature(provider, record.account, data, signature))) {
        throw new Error('Your account does not accept this device\'s signature. Sign in again and retry.');
      }
      answer(request, { ok: true, account: record.account, chainId: record.chainId, signature });
    }, true),
    button('Deny', () => answer(request, { ok: false, error: 'denied by the user' })),
  );
  show(...nodes);
}
