# Status and limitations

Kamui is a **development preview**. Read this page before you plan a launch on it.

## Status

| | |
|---|---|
| Network | Starknet **Sepolia only**. No mainnet deployment. |
| Audit | **None**. Contracts, keychain, SDK and services are unaudited. Do not hold real funds. |
| Sign-in | **Google only**. Apple is implemented but not set up or tested live. |
| Hosted keychain | `https://sepolia.kamui.page` (beta). |
| API stability | Protocol version 1. Breaking changes are possible before a stable release. |

## Known limitations

### Integration

- **The SDK is not published to npm.** Vendor `sdk/` from the repository, see [Quickstart](/guide/quickstart#_1-add-the-sdk).
- **Wallet connectors are partial.** There is a [`starknet-react` connector](/examples/starknet-react) and a get-starknet-style wallet object (`KamuiWallet`), both limited to what a session can do: no message signing, no declare, one chain. Kamui does not register with the wallet standard that get-starknet v5 and later use for discovery. The connector is tested against `@starknet-react/core` 5.0.3 with mocked redirects, not yet against the hosted keychain.
- **Redirects by default.** Your page reloads on every connect and one-off approval unless you opt in to [popup mode](/guide/popup), which has been tested in Chromium only and has [limits of its own](/guide/popup#limits). There is no iframe mode.
- **One-off approvals are paid for by your app.** The keychain's `/execute` page signs the user's transaction and returns it unsent; your server sends it with your sponsorship credential. Not yet run against the hosted Sepolia backend. A request near the size limit (10 calls of 100 felts) is larger than the 600 felts the sponsor endpoint accepts.
- **Message signing is not on hosted Sepolia yet.** `sessionSignTypedData` works against any deployed account. The keychain's `/sign` page (`beginSignMessage`) is in the code but only reaches the hosted keychain with its next release.
- **No native SDKs** and no mobile support. See [Native](/native/overview).

### Sponsorship

- **Approval is manual.** Ask the Kamui team for an app key and token. There is no dashboard, usage view or self-serve rotation.
- **Every sponsored call needs your server**, because the credential cannot be in the browser.

### Users

- **First sign-in on a device needs desktop Chromium.** The login proof is made in the browser and needs memory64 and several GB of memory. Firefox, Safari and mobile browsers cannot complete it today; there is no server fallback. Returning users on a device that already owns the account need no proof.
- **The first sign-in takes tens of seconds** while the proof runs.
- **Adding a device ends every session.** Your app is told by [`watchSession`](/guide/sessions#being-told-when-it-ends) (reason `owners-changed`), or sees `isConnectionAlive` turn false, and must ask again.
- **Safari may clear the keychain's storage** after seven days of Safari use without visiting it. The user then signs in as on a new device.
- **Referrer settings.** Browsers or extensions that strip referrers make the keychain refuse every request.
- **Only STRK and ETH are recognised** by name on approval screens. Other tokens are shown as unverified.
