# Ping, a Kamui demo app

A small app that connects through the Kamui keychain. It asks for a session limited to `ping()` on one test contract, then pings with sponsored calls, and shows that a call outside the session is refused. Development only.

```sh
# with the keychain, the backend api, the pepper service and the prover running locally
bun install
bun run server.ts      # http://localhost:5175
```

It uses the app-side helpers in `../../sdk/src/keychain.ts`. The session key is kept in the tab's `sessionStorage`, which is fine for a demo. The target is a `Target` test contract on Sepolia; set `TARGET` to use another.
