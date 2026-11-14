# Native integration

Kamui is built for the web first. This page sets out how native apps (iOS, Android, React Native, Capacitor, game engines) will connect, and **what is missing today**. None of these flows is supported yet. Two pieces exist: the [bounce page](/native/bounce-page) pattern, with SDK helpers, and the [session signing](/reference/session-signing) specification with test vectors.

::: danger Not supported yet
The blocker is sign-in on phones: a user's first sign-in on a device makes a zero-knowledge proof in the browser, and that prover needs a recent **desktop Chromium** with memory64 and several GB of memory. Mobile Safari and mobile Chrome cannot do it today, and there is no server fallback. A user who has never signed in on that phone cannot complete the flow.
:::

## Connection flows

### Browser-based sessions

The same flow as on the web, through the system browser:

1. The app makes a one-time state and transport key.
2. It opens a page **on the app's own HTTPS domain** in an `ASWebAuthenticationSession` (iOS) or a Custom Tab (Android). That page creates the session key, builds the [connect request](/reference/protocol) and navigates to the keychain, so the keychain sees the app's origin as referrer.
3. The user signs in and approves the session.
4. The keychain redirects to a return page on the same HTTPS domain. That page seals the session to a key the app made and navigates to a **universal link** (iOS 17.4+ `ASWebAuthenticationSession` HTTPS callbacks) or an **App Link** (Android).
5. The app opens the sealed answer, stores the session key in the Keychain (iOS) or Keystore-backed storage (Android), then signs session calls itself and sends them to your [sponsor route](/guide/sponsorship).

The page, the app side and the reasons for each step are in [Bounce page](/native/bounce-page). The session key is made in the page and not in the app on purpose: a page that forwarded a key from its URL would let anyone ask in your app's name.

Status and gaps:

| Need | Today |
|---|---|
| Sign-in on a phone the user has not used before | **Blocked**: browser prover is desktop Chromium only |
| Custom URL schemes (`mygame://kamui`) as `redirectUri` | **Refused**, and staying so: any app can claim a scheme. Only `https:` (or `http://localhost`) |
| Opening the keychain URL directly from the app | **Refused**: no referrer. Use a [bounce page](/native/bounce-page) on your domain: SDK helpers and tests exist, **not run on devices** |
| Apps without an HTTPS domain | **No way to connect.** A registered app id verified without a referrer is not designed |
| Native session signing (Swift, Kotlin, Rust, C#) | **No SDK**. You implement Stark ECDSA, the SNIP-12 outside-execution hash and Kamui's session signature yourself, against the [specification and test vectors](/reference/session-signing) |
| React Native | The TypeScript SDK may work with `starknet` polyfills (`crypto.getRandomValues`); **untested** |

### Web wrapper (Capacitor)

An existing Kamui web app packaged in a native shell, using the browser-based flow above with deep-link return. Same blockers: phone sign-in, and HTTPS-only redirects (Capacitor's `capacitor://localhost` or `https://localhost` origins are not your domain, so the return must go through a universal or App Link).

### Headless (app-managed keys)

**Not planned for Kamui accounts.** Every Kamui account is owned by a person who signed in with Google, and a session needs that person's approval. A server acting for a user should use a session approved once in a browser: see [Node.js](/examples/node).

## Choosing a flow

| Use case | Flow | Today |
|---|---|---|
| Web game or dapp | Web redirects | Supported: [React](/examples/react), [Svelte](/examples/svelte) |
| Game backend, bot, script acting for a user | Session approved in a browser, used from a server | Supported: [Node.js](/examples/node) |
| Mobile game | Browser-based session | Not yet |
| Existing web app in a native shell | Web wrapper (Capacitor) | Not yet |
| Desktop game (Unity, Godot, native) | Browser-based session with a localhost callback | Possible with the [Node.js pattern](/examples/node) on desktop, but no SDK in those languages |

## Desktop apps today

A desktop app can use the same localhost round trip as the [Node.js example](/examples/node): serve `/start` and `/callback` on `http://localhost:<port>`, open `/start` in the system browser, and read the answer posted back. The user's desktop browser handles sign-in, so the prover requirement is met on desktop Chromium. You still need session signing in your language, see [Session signing](/reference/session-signing).
