// What the user sees when a request is refused because of who sent it: the browser named no
// site (no referrer), or named a site other than the one the request wants answered.
//
// The request is unverified here. Nothing it asks for is shown, not even the app's name, and
// the keychain never sends the user anywhere by itself. With no referrer the page offers one
// link back to the address the request named: the user has to click it, its origin is shown in
// full, and it carries only the fixed error `referrer_missing` and the request's id. With a
// referrer that names another site there is no link: something sent this request in a site's
// name, and that site did not ask.
import { referrerMissingUrl, type KeychainRequestError } from '../../sdk/src';
import { button, code, el, show } from './ui';

function list(items: (string | Node[])[]): HTMLUListElement {
  const node = el('ul');
  for (const item of items) {
    const li = el('li');
    li.append(...(typeof item === 'string' ? [document.createTextNode(item)] : item));
    node.append(li);
  }
  return node;
}

const text = (value: string) => document.createTextNode(value);

function developerNote(...content: Node[]): HTMLParagraphElement {
  const note = el('p', '', 'note');
  note.append(el('strong', 'For the site\'s developers: '), ...content);
  return note;
}

function showReferrerMissing(error: KeychainRequestError) {
  const origin = new URL(error.redirectUri).origin;

  const back = el('a', `Go back to ${origin}`);
  back.href = referrerMissingUrl(error);
  back.rel = 'noreferrer noopener';
  back.className = 'back';

  show(
    el('h2', 'This request cannot be checked'),
    el('p', 'The keychain cannot tell which site sent this request, so it was refused. Nothing was approved and nothing about your account was shared.', 'error'),
    el('p', 'Your browser did not say which site you came from (the "referrer"). The keychain needs that to be sure a request really comes from the site it names.'),
    el('h2', 'What usually causes this, and what to do'),
    list([
      'A privacy or ad-blocking extension that hides the referrer. Turn it off for the site you came from, or allow referrers in its settings, and try again.',
      'A browser privacy setting that stops referrers being sent. Put it back to its default, or try another browser or a normal (not private) window.',
      'The link was opened from the address bar, a bookmark, an email or another app. Open the site itself and start from there.',
      'The site tells browsers not to send a referrer (its referrer policy). Only the site can change that: let them know.',
    ]),
    developerNote(
      text('the page that opens the keychain must send its origin as the referrer. Serve it with '),
      code('Referrer-Policy: strict-origin-when-cross-origin'),
      text(' (the browser default) instead of '),
      code('no-referrer'),
      text(' or '),
      code('same-origin'),
      text(', and remove '),
      code('<meta name="referrer">'),
      text(', '),
      code('rel="noreferrer"'),
      text(' and '),
      code('referrerpolicy="no-referrer"'),
      text(' from that page or link.'),
    ),
    el('h2', 'Go back'),
    el('p', 'The request asked for its answer to go to the site below. The keychain could not confirm that this site sent it. If it is the site you were using, you can go back: it will only be told that the request failed for this reason.'),
    el('p', origin, 'origin'),
    el('p', 'If you do not recognise this address, do not follow the link. Close this page.', 'note'),
    back,
    el('br'),
    button('Open your Kamui account', () => location.assign('/')),
  );
}

function showReferrerMismatch(error: KeychainRequestError) {
  const named = new URL(error.redirectUri).origin;
  show(
    el('h2', 'This request was refused'),
    el('p', 'This request was not sent by the site it names. Nothing was approved and nothing about your account was shared.', 'error'),
    el('p', 'It asks for its answer to go to:'),
    el('p', named, 'origin'),
    el('p', 'but you came here from:'),
    el('p', error.referrerOrigin ?? 'another site', 'origin'),
    el('p', 'A site may only ask in its own name. If you followed a link you do not trust, close this page. Otherwise open the site you wanted and start again from there.'),
    developerNote(
      code('redirectUri'),
      text(' must be on the same origin (scheme, host and port) as the page that sends the user to the keychain. A different subdomain, such as '),
      code('www'),
      text(', or a hop through another domain on the way, is a different origin.'),
    ),
    button('Open your Kamui account', () => location.assign('/')),
  );
}

/** Draws the page for a request refused because of who sent it. */
export function showRequestRefusal(error: KeychainRequestError) {
  if (error.code === 'referrer_missing') showReferrerMissing(error);
  else showReferrerMismatch(error);
}
