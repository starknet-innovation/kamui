# Ping, a Kamui demo app

A small app that connects through the Kamui keychain. It asks for a session limited to `ping()` on one test contract, then pings with sponsored calls, and shows that a call outside the session is refused. Development only.

```sh
# with the keychain, the backend api, the pepper service and the prover running locally
bun install
bun run server.ts      # http://localhost:5175
```

It uses the app-side helpers in `../../sdk/src/keychain.ts`. The session key is kept in the tab's `sessionStorage`, which is fine for a demo. The target is a `Target` test contract on Sepolia; set `TARGET` to use another.

## Approved-app sponsorship in the lean deployment

The app server may load a privately configured `SPONSOR_SERVER_TOKEN_FILE` (absolute private file) or `SPONSOR_SERVER_TOKEN`, never both, and send it only on `/api/sponsor` as `x-kamui-sponsor-token`. It is never included in public config or browser JS, and browser-supplied tokens are ignored. Register the corresponding public app key and credential hash in the reviewed backend funding policy. The server must decide which users/requests may use its budget; this example adds no end-user authentication. Do not give the public keychain a credential to inject into arbitrary requests. See [funding controls](../../services/backend/FUNDING.md).
