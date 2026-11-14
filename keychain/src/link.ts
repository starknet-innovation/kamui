// Adding a device from one that is already signed in, without a login proof. See DEVICE_LINK.md.
//
// A first sign-in proves in the browser, which only a desktop Chromium can do today. The account
// itself has a second way to gain a key: an existing owner sends `add_owner` with the new key's
// signature accepting ownership (contracts/src/owners.cairo). These pages carry that between
// two devices by hand, with a link one way and a code back. Nothing new is sent to a server:
// the only transaction is the signed-in device's own `add_owner`, sponsored like `remove_owner`.
//
//   signed-in device   showAddDevice    makes the link, takes the code, confirms, sends add_owner
//   new device         showLinkInvite   opened from the link: makes a key and the code
//                      showLinkWaiting  waits until the account lists the key, then is signed in
import type { Call } from 'starknet';
import { KamuiReader, MAX_OWNERS, addOwnerCall, newKeyPair, signNewOwner } from '../../sdk/src';
import { LINK_LIFETIME_SECONDS, checkCode, linkAnswerCode, linkAnswerSigned, linkUrl, newLinkId, parseLinkAnswer, parseLinkFragment, type LinkInvite } from './link-code';
import { loadLogin, loadPendingLink, saveLogin, savePendingLink, type AccountRecord, type PendingLink } from './vault';
import { config, provider } from './context';
import { ask, button, code, el, sameFelt, show, status, table } from './ui';

/** Shows the right page for where things stand. Passed in by main.ts, which owns routing. */
type Resume = () => Promise<void>;

const now = () => Math.floor(Date.now() / 1000);

/** A read-only box holding text to be copied to the other device, with its label and button. */
function copyable(id: string, labelText: string, text: string, buttonLabel: string): Node[] {
  const label = el('label', labelText);
  label.htmlFor = id;
  const box = el('textarea', '', 'copy');
  box.id = id;
  box.readOnly = true;
  box.rows = 3;
  box.value = text;
  box.onfocus = () => box.select();
  const copy = button(buttonLabel, async () => {
    // The clipboard can be refused (no permission, not a secure page). The text is then left
    // selected for the user to copy by hand.
    try {
      await navigator.clipboard.writeText(text);
      status('Copied.');
    } catch {
      box.focus();
      box.select();
      status('Select the text and copy it.');
    }
    return false as const;
  });
  return [label, box, copy];
}

//
// The signed-in device
//

/**
 * The "Add another device" page. `send` sends calls from the account, signed by this device;
 * `back` draws the account page again.
 */
export async function showAddDevice(record: AccountRecord, send: (calls: Call[]) => Promise<unknown>, back: () => Promise<void>) {
  const reader = new KamuiReader(provider, record.account);
  if ((await reader.owners()).length >= MAX_OWNERS) {
    return show(
      el('h2', 'Add another device'),
      el('p', `Your account already has ${MAX_OWNERS} devices, the most it can hold. Remove one you no longer use, then add the new one.`, 'warn'),
      button('Back', back),
    );
  }
  // Kept in this page only. Leaving or reloading the page ends the link.
  const invite: LinkInvite = { account: record.account, chainId: record.chainId, classHash: record.classHash, id: newLinkId(), expires: now() + LINK_LIFETIME_SECONDS };

  const label = el('label', 'Code shown by the new device');
  const input = el('textarea', '', 'copy');
  input.id = 'link-code';
  input.rows = 3;
  input.spellcheck = false;
  input.autocapitalize = 'off';
  label.htmlFor = input.id;

  show(
    el('h2', 'Add another device'),
    el('p', 'This gives another device full control of your account, the same as this one. Only do it for a device that is yours and that you are holding now. Kamui never asks you to add a device, and nobody helping you needs this link or the code. If someone asked you to do this, stop.', 'warn'),
    el('p', 'It needs no new sign-in and no proof, so it also works in browsers that cannot do a first sign-in. Adding a device ends every session your apps have.', 'note'),
    el('h2', '1. Open this link on the new device'),
    ...copyable('link-url', 'Link for the new device', linkUrl(location.origin, invite), 'Copy link'),
    el('p', `Send it to yourself in a way only you can read. It works for ${LINK_LIFETIME_SECONDS / 60} minutes, and only while this page stays open.`, 'note'),
    el('h2', '2. Paste the code the new device shows'),
    label,
    input,
    button('Continue', async () => {
      if (now() >= invite.expires) throw new Error('This link has run out. Go back and start again.');
      const answer = parseLinkAnswer(input.value);
      if (!sameFelt(answer.id, invite.id)) throw new Error('This code does not answer the link above. Open the link above on the new device and use the code it shows.');
      if (await reader.isOwner(answer.publicKey)) throw new Error('This device is already on your account.');
      // The new key signed the owner list as it was. If the list changed since, or the code was
      // made for another account, the account would refuse it: say so before paying for that.
      if (!sameFelt(answer.anchor, await reader.ownersAnchor())) throw new Error('Your account\'s devices changed after this code was made. Open the link again on the new device for a new code.');
      if (!linkAnswerSigned(record.account, answer)) throw new Error('This code is damaged or was not made for your account. Copy the whole code again.');
      const check = checkCode(answer.publicKey);
      if (!(await ask(`Add the device showing check code ${check}? It gets full control of your account, and every session your apps have ends. Continue only if you are holding that device and it shows ${check}.`, 'Yes, add this device'))) return false;
      status('Adding the device…');
      await send([addOwnerCall(record.account, answer.publicKey, answer.signature)]);
      if (!(await reader.isOwner(answer.publicKey))) throw new Error('The transaction was sent but the account does not list the new device.');
      status('');
      await back();
    }, true),
    button('Back', back),
  );
}

//
// The new device
//

/** Opened from a link (`/link`). `fragment` has already been taken out of the address bar. */
export async function showLinkInvite(fragment: string, resume: Resume) {
  const invite = parseLinkFragment(fragment);
  if (!sameFelt(invite.chainId, await provider.getChainId())) throw new Error('This link is for another network and cannot be used here.');
  if (!sameFelt(invite.classHash, config.classHash)) throw new Error('This link is for another version of the Kamui account and cannot be used here.');
  if (now() >= invite.expires) throw new Error('This link has run out. Make a new one on the device you are signed in on.');
  let classHash: string;
  try {
    classHash = await provider.getClassHashAt(invite.account);
  } catch {
    throw new Error('This link names an account that does not exist on this network.');
  }
  if (!sameFelt(classHash, config.classHash)) throw new Error('This link names something that is not a Kamui account.');

  const reader = new KamuiReader(provider, invite.account);
  const login = await loadLogin();
  if (login && (await new KamuiReader(provider, login.account.account).isOwner(login.device.publicKey))) {
    if (sameFelt(login.account.account, invite.account)) return resume();
    throw new Error('This browser is already signed in to another account. Forget this device on its account page first if you want to use the link.');
  }

  show(
    el('h2', 'Add this device to an account'),
    table([], [['Account', code(invite.account)]]),
    el('p', 'This link was made on a device that is signed in to the account above. Continue only if you made it yourself, just now, on your own device. If someone sent it to you, do not continue: nothing here can give you their account, and they may be trying to get you to do something else.', 'warn'),
    el('p', 'A key for this device is made and kept in this browser. It is not signed in until the other device confirms it. This device will not hold a recovery file: keep the one from the device you first signed in on.', 'note'),
    button('Create a key for this device', async () => {
      const device = newKeyPair();
      const anchor = await reader.ownersAnchor();
      const link: PendingLink = {
        device,
        account: invite.account,
        chainId: invite.chainId,
        classHash: invite.classHash,
        anchor,
        code: linkAnswerCode({ id: invite.id, publicKey: device.publicKey, anchor, signature: signNewOwner(invite.account, anchor, device.privateKey) }),
        expires: invite.expires,
      };
      await savePendingLink(link);
      await showLinkWaiting(link, resume);
    }, true),
    button('Cancel', () => location.assign('/')),
  );
}

/** The new device, after it made its key: shows the code and waits for the account to list the key. */
export async function showLinkWaiting(link: PendingLink, resume: Resume) {
  const reader = new KamuiReader(provider, link.account);
  const marker = el('h2', 'Finish on your other device');

  /** Looks once. True when the page has moved on and there is nothing left to wait for. */
  const lookOnce = async (): Promise<boolean> => {
    // The key may have been replaced since this page was drawn (another tab, a sign-in).
    const current = await loadPendingLink();
    if (!current || !sameFelt(current.device.publicKey, link.device.publicKey)) return true;
    if (await reader.isOwner(link.device.publicKey)) {
      await saveLogin(link.device, { account: link.account, chainId: link.chainId, classHash: link.classHash });
      await resume();
      return true;
    }
    const moved = !sameFelt(await reader.ownersAnchor(), link.anchor);
    if (moved || now() >= link.expires) {
      await savePendingLink(null);
      show(
        el('h2', 'This device was not added'),
        el('p', moved ? 'The account\'s devices changed before this one was added, so its code no longer works.' : 'The code ran out before the other device used it.', 'error'),
        el('p', 'Nothing was changed by this device. Make a new link on the device you are signed in on.', 'note'),
        button('Start again', resume, true),
      );
      return true;
    }
    return false;
  };

  // The button and the timer share one look, so the device is never signed in twice.
  let looking: Promise<boolean> | null = null;
  const look = () => (looking ??= lookOnce().finally(() => { looking = null; }));

  show(
    marker,
    table([], [['Account', code(link.account)]]),
    el('p', 'On the device you are signed in on, paste this code under "Paste the code the new device shows", then confirm.'),
    ...copyable('link-answer', 'Code for your other device', link.code, 'Copy code'),
    el('p', `Check code: ${checkCode(link.device.publicKey)}`, 'origin'),
    el('p', 'Your other device shows a check code before it adds this one. Confirm there only if it is the same as here.', 'note'),
    el('p', 'Keep this page open. It continues by itself once this device is added. Adding it ends every session your apps have.', 'note'),
    button('Check now', async () => {
      if (!(await look())) {
        status('Not added yet.');
        return false;
      }
    }),
    button('Cancel', async () => {
      await savePendingLink(null);
      await resume();
    }),
  );

  // Looks again until the page is replaced. A failed look (the network) is tried again.
  const wait = async () => {
    if (!marker.isConnected) return;
    if (!(await look().catch(() => false))) setTimeout(wait, config.pollMs * 2);
  };
  setTimeout(wait, config.pollMs * 2);
}
