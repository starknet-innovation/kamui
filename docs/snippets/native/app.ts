// The app's half of a native connect, for a TypeScript runtime with WebCrypto (React Native
// needs a `crypto.subtle` and `crypto.getRandomValues` polyfill; untested). Swift and Kotlin
// follow the same steps with the layout in the bounce page guide.
import { isConnectionAlive, nativeStartUrl, newNativeHandoff, openNativeHandoff, type Connection, type NativeHandoffSecret } from '@kamui/sdk';
import type { ProviderInterface } from 'starknet';

const START_PAGE = 'https://mygame.example/kamui/start';

/** What the platform gives you: open a URL in the system browser, and receive the app link. */
export type Platform = {
  /** ASWebAuthenticationSession with an https callback, or a Custom Tab plus an App Link. */
  openInSystemBrowser(url: string): Promise<void>;
  /** Resolves with the full app link, fragment included, when the OS hands it to the app. */
  nextAppLink(): Promise<string>;
  /** Keychain (iOS) or Keystore-backed storage (Android). */
  secureStore: { set(key: string, value: string): Promise<void> };
};

export async function connect(platform: Platform, provider: ProviderInterface): Promise<Connection> {
  // One state and one handoff key per connect, kept until the app link comes back.
  const secret: NativeHandoffSecret = await newNativeHandoff();
  await platform.openInSystemBrowser(nativeStartUrl(START_PAGE, secret));

  const link = await platform.nextAppLink();
  // Throws unless the link answers this connect: same state, sealed to this key.
  const connection = await openNativeHandoff(link, secret);
  if (!connection) throw new Error('the link holds no answer');

  // The handoff says what the keychain answered. The chain says whether it is true.
  if (!(await isConnectionAlive(connection, provider))) throw new Error('the session is not on the account');

  await platform.secureStore.set('kamui.connection', JSON.stringify(connection));
  return connection;
}
