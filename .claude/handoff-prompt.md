You are picking up work on **Kamui**, the Starknet Foundation's embedded Starknet wallet: social login (Google, Apple), device keys, session keys with scopes and spending limits (SNIP-41), sponsored transactions and a keychain. It is built from scratch on permissive components. **No Cartridge code, ever** (not copied, not adapted, not consulted for implementation).

Repository: `/Users/adrienlacombe/ws/kamui`, remote `https://github.com/starknet-innovation/kamui` (internal), branch `main`, in sync with the remote at `224c411`. Read these first:
- `PLAN.md`: goals, decisions D1 to D9, phases with dated status notes.
- `spikes/s1/results/RESULTS.md`: live Sepolia runs 1 to 8. Run 8 is the latest and covers everything below.
- The README in each of `contracts/`, `sdk/`, `services/pepper/`, `services/backend/`, `keychain/`, `apps/demo-dapp/`, `infra/aws/terraform/`. Each has a "Not done" or "Not here yet" list.

## Layout
- `contracts/`: Cairo. `KamuiAccount` (owner set of at most 5 device keys, sessions, spending policies, social recovery via SNIP-36 proofs, `execute_from_outside_v2`), `JwkRegistry`, mocks. 168 snforge tests.
- `sdk/`: TypeScript on starknet.js 10: address derivation, login, sessions, outside execution, keychain protocol, tokens, session registry client.
- `services/pepper/`: pepper service, HMAC in AWS KMS (key never leaves KMS, no backup; users can export their pepper as a recovery file).
- `services/backend/`: recover API, prover (Docker), relayer, JWK rotator, key watcher, `/sponsor` (a stand-in for a paymaster), session registry (SQLite).
- `keychain/`: the wallet's pages (full-page redirects, not an iframe). Playwright tests in Chrome, Firefox and WebKit.
- `apps/demo-dapp/` ("Ping") and `apps/login-demo/`.
- `infra/aws/`: scripts and Terraform templates for two test AWS accounts. Not applied.

## Tooling
- Scarb 2.20.1 and Starknet Foundry 0.64.0 via asdf. Prefix PATH, or the system scarb 2.18 in `~/.local/bin` causes "cache corrupt" errors:
  `export PATH="$(asdf where scarb 2.20.1)/bin:$(asdf where starknet-foundry 0.64.0)/bin:$PATH"`
- Bun: the system bun is too old. Use `/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun` (1.4.4).
- Test commands:
  - Contracts: `cd contracts && snforge test` (168).
  - SDK: `cd sdk && <bun> test test/unit.test.ts test/login.test.ts test/keychain.test.ts test/tokens.test.ts test/registry.test.ts` (91), and `./node_modules/.bin/tsc --noEmit`.
  - Backend: `cd services/backend && <bun> test` (118).
  - Pepper: `cd services/pepper && <bun> test` (53).
  - Keychain: `cd keychain && BUN=<bun> ./node_modules/.bin/playwright test` (63 tests × 3 browsers = 189), and `./node_modules/.bin/tsc --noEmit`.
- Local services are configured in `.claude/launch.json`: `kamui-pepper` (8787, AWS profile `kamui-pepper-test`), `kamui-api` (3000), `kamui-keychain` (5173), `kamui-dapp` (5175). Start the prover with `cd services/backend && docker compose --env-file .env.local up -d prover`; it needs up to 20 GB of memory. The keychain and demo app bundle their scripts at start, so restart them after edits.
- Secrets are in the gitignored `services/backend/.env.local` and `services/pepper/.env.local`. Public addresses are in `services/backend/deployments.env`. The repository refuses files named `.env`.

## Sepolia state (run 8)
- RPC: `https://api.zan.top/public/starknet-sepolia/rpc/v0_10`.
- Key registry: `0x4bc2b2afcce053e788511a851e6aeb004d18adb243df4fe852e1b727bd09808` (owned by the relayer account), pinned in `contracts/src/social/component.cairo`.
- Account class: `0x1e128dae2cb709cac9263afa1c6fdb33f7f1f5c2d969547d9739326d08399f6`. Accounts are not upgradeable (D1), so a new class means new addresses.
- Test account: `0x133739e82cd76b5a6446848ae0cbbbb8cc4762fbb8e0eb5ebc417209423e0e9` (2 device keys).
- Target mock: `0x2f8ce9fcc5f6e165ab5dcccf865c4c08e7d752d6b930938195683eef9f43dfc`. About 2,860 STRK was left on the relayer.

## Gotchas
- Session transactions must be fee-estimated with `skipValidate: false`; the default estimate comes out too low.
- The app's built-in browser pane silently answers native `confirm()` with "cancel". The keychain confirms inside the page; keep it that way.
- Session registry protocol `kamui.registry.v2`: the owner signs `poseidon(domain, chainId, account, action, timestamp, nonce, subject, contentHash)`, and the server accepts each signed message once. Both sides implement it: `sdk/src/registry.ts` and `services/backend/src/services/registry/`. The registry is untrusted display data; the account is the authority.

## Open work, in rough priority
1. Audit issues 1 to 5 on GitHub have fix replies posted and are waiting for the auditor's confirmation. Do not close them without the user.
2. AVNU's paymaster in place of `/sponsor`. It is GPL-3.0, so run it unmodified as a separate service.
3. `/recover` as a job the client polls: a proof can outlive the HTTP connection.
4. Safari: it deletes script-written storage after 7 days without a visit, which would lose the device key. Test it and decide what to do.
5. Live checks not yet done: Apple sign-in, "Revoke all sessions", removing a device, a sign-in with the pepper service actually down.
6. Hosting: the Terraform in `infra/aws/terraform/` needs review by whoever owns SNF's AWS setup before anyone applies it.
7. Later phases (see `PLAN.md`): indexer, wallet-standard connector, override recovery in the UI, audit 2, production domain.

## How the user works
- Goes step by step: asks "what is next?", then "go ahead with X". Give a short ranked list with a recommendation.
- Commit and push only when asked; the usual request is "commit this and push". End commit messages with the attribution line your harness gives.
- Live Sepolia runs need the user for Google sign-ins and for funding. Tell them exactly what to click.
- Writing style: plain, direct, concise; say what was verified and what was not.

## Rules (Starknet Foundation)
- Do not create cloud accounts or change AWS security settings yourself: give the user the commands. Never print secrets, AWS account ids or ARNs, and never enter private keys anywhere.
- Treat security architecture (key handling, hosting design) as sensitive, and flag security, regulatory and legal claims for review by the right people.
- Ask before posting to GitHub (comments, issues, closing anything) or sending anything on the user's behalf.
- Never use or consult Cartridge code.
