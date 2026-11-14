// The bounce page of a native app: one script, served on the app's own HTTPS domain at
//
//   /kamui/start    opened by the app in the system browser; sends the user to the keychain
//   /kamui/return   where the keychain sends the user back; hands the answer to the app
//
// and one path the site does not need to serve a script on:
//
//   /kamui/app      the app link. The OS gives it to the app (universal link, App Link, or the
//                   https callback of ASWebAuthenticationSession). Serve a plain "open the app"
//                   page there for the case where the app is not installed.
//
// Everything about the session is decided here, in code your domain serves. The link the app
// opens carries only a state value and a transport key. Do not read a session key, a scope, a
// limit or a return address from the URL: anyone can link to this page.
import { beginNativeConnect, finishNativeConnect } from '@kamui/sdk';

const KEYCHAIN_URL = 'https://sepolia.kamui.page';
const GAME = '0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc';
const APP_LINK = `${location.origin}/kamui/app`;

const say = (text: string) => {
  document.body.textContent = text;
};

async function main() {
  if (location.pathname === '/kamui/start') {
    const url = beginNativeConnect(
      location.hash,
      {
        keychainUrl: KEYCHAIN_URL,
        redirectUri: `${location.origin}/kamui/return`,
        appName: 'My game',
        validUntil: Math.floor(Date.now() / 1000) + 24 * 3600,
        maxCalls: 200,
        calls: [{ to: GAME, entrypoint: 'move' }],
      },
      sessionStorage,
    );
    if (!url) return say('Open this page from the app.');
    // Take the app's state and key out of the address bar and the history entry.
    history.replaceState(null, '', location.pathname);
    location.assign(url);
    return;
  }

  if (location.pathname === '/kamui/return') {
    const link = await finishNativeConnect(location.hash, APP_LINK, sessionStorage);
    history.replaceState(null, '', location.pathname);
    if (!link) return say('Nothing to finish. Start again from the app.');

    // Some browsers only hand a link to an app after a tap, so offer one as well.
    const button = document.createElement('a');
    button.href = link;
    button.textContent = 'Return to the app';
    document.body.replaceChildren(button);
    location.assign(link);
  }
}

main().catch((error: Error) => say(`Could not connect: ${error.message}`));
