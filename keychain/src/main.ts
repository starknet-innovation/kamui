// The Kamui keychain, version 1: full-page redirects (see sdk/src/keychain.ts).
//
// Pages:
//   /connect   an app asks to connect; the request is in the URL fragment
//   /execute   an app asks for one transaction to be approved
//   /callback  the issuer returns here after a sign-in
//   /          this device's account: owners, sessions, recovery file
//
// Everything a site or a token supplies is written with textContent, never as HTML.
//
// Modules:
//   context.ts   the page's fixed elements, the configuration and the RPC provider
//   ui.ts        small DOM helpers
//   request.ts   the pending request from a site, and the answer sent back
//   tokens.ts    tokens and limits as the pages show them
//   login.ts     sign-in
//   sessions.ts  the session registry, and what the account says
//   approval.ts  the connect and execute approval pages
//   refusal.ts   a request refused because of who sent it (no referrer, or another site's)
//   home.ts      the account page
//   main.ts      routing (this file)
import { finishLogin, showSignIn } from './login';
import { KamuiReader, KeychainRequestError, parseConnectRequest, parseExecuteRequest } from '../../sdk/src';
import { loadLogin } from './vault';
import { provider } from './context';
import { REQUEST, answer, pendingRequest, type Pending } from './request';
import { showApproval, showTransaction } from './approval';
import { showHome } from './home';
import { showRequestRefusal } from './refusal';
import { button, el, show, status } from './ui';

//
// Routing
//

/** Shows the right page for where things stand: sign in, a pending request, or home. */
async function resume() {
  status('');
  const login = await loadLogin();
  if (!login) return showSignIn(resume);
  // The key may have been removed from another device since the last visit.
  if (!(await new KamuiReader(provider, login.account.account).isOwner(login.device.publicKey))) {
    return showSignIn(resume, 'This device no longer has access to your account. Sign in again to add it back.');
  }
  const pending = pendingRequest();
  if (pending?.kind === 'connect') return showApproval(pending.request, login.device, login.account);
  if (pending?.kind === 'execute') return showTransaction(pending.request, login.device, login.account);
  return showHome(login.device, login.account, resume);
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
  if (error instanceof KeychainRequestError) return showRequestRefusal(error);
  const nodes: Node[] = [el('h2', 'Something went wrong'), el('p', (error as Error).message, 'error')];
  const pending = pendingRequest();
  if (pending) nodes.push(button('Go back to the site', () => answer(pending.request, { ok: false, error: 'the keychain could not complete the request' }), true));
  nodes.push(button('Start again', () => location.assign('/')));
  show(...nodes);
});
