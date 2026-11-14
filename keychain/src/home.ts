// The account page: this device's account, its owners, its sessions and the recovery file.
import {
  KamuiReader,
  ownerOutsideExecution,
  removeOwnerCall,
  revokeAllSessionsCall,
  revokeSessionCall,
  serializePepperFile,
  sponsor,
  type KeyPair,
} from '../../sdk/src';
import { forget, loadUnrecordedSessions, saveUnrecordedSessions, type AccountRecord } from './vault';
import { config, provider } from './context';
import { REGISTRY_TIMEOUT_MS, loadSessions, registryFor } from './sessions';
import { limitRows, lookUpTokens, spendingLimits, tokenCell } from './tokens';
import { ask, button, code, el, sameFelt, short, show, status, table, within } from './ui';

/** Shows the right page for where things stand. Passed in by main.ts, which owns routing. */
type Resume = () => Promise<void>;

/** Sends calls from the account, signed by this device's key and sponsored, and waits for them. */
async function sendAsOwner(device: KeyPair, record: AccountRecord, calls: Parameters<typeof ownerOutsideExecution>[0]['calls']): Promise<string> {
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
  return transaction;
}

/** The "Sessions" part of the account page. */
async function sessionsSection(device: KeyPair, record: AccountRecord, reader: KamuiReader, resume: Resume): Promise<Node[]> {
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
        await showHome(device, record, resume);
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
      await showHome(device, record, resume);
    }),
  );
  return nodes;
}

export async function showHome(device: KeyPair, record: AccountRecord, resume: Resume) {
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
          await showHome(device, record, resume);
        });
    return [index === 0 ? 'oldest' : `#${index + 1}`, code(short(owner)), action];
  });

  show(
    el('h2', 'Your account'),
    table([], [['Address', code(record.account)]]),
    el('h2', `Devices (${owners.length} of 5)`),
    table(['', 'Key', ''], ownerRows),
    el('p', 'Each device you sign in on has its own key. Removing one ends every session on your account.', 'note'),
    ...(await sessionsSection(device, record, reader, resume)),
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
