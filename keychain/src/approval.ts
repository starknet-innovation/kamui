// The two requests a site can make: a session (connect) and one transaction (execute).
import {
  KamuiReader,
  callsFromWire,
  createSessionCalls,
  describeAmount,
  describeCall,
  executeProblems,
  ownerOutsideExecution,
  sessionFromWire,
  sessionProblems,
  sponsor,
  type ConnectRequest,
  type ExecuteRequest,
  type KeyPair,
} from '../../sdk/src';
import type { AccountRecord } from './vault';
import { config, provider } from './context';
import { answer } from './request';
import { recordSession } from './sessions';
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
