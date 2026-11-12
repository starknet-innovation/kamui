# Kamui login demo

A small local page that runs the SDK's login flow end to end: Google sign-in, the pepper service with its key proof, and the backend's `/recover` with a real proof on Sepolia. Development only.

```sh
# with the prover, the backend api and the pepper service running locally
bun run server.ts      # http://localhost:5173
```

It reads its settings from the backend's local files (`services/backend/.env.local` and `deployments.env`), proxies `/api` to the recover API, and calls the pepper service directly. The Google OAuth client must allow `http://localhost:5173/callback` as a redirect URI, and the pepper service must allow `http://localhost:5173` as an origin.

The device key is kept in `sessionStorage` so that it survives the redirect. A real keychain must keep it in non-exportable storage instead.
