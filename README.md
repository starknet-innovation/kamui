# Kamui

An embedded wallet for Starknet: social login, session keys, sponsored transactions, and one keychain page shared by every app that uses it.

**Status: development, Sepolia only.** Nothing here is audited. Do not hold real funds with it. The current rollout covers Google sign-in only. Apple support is in the code, but its setup and live testing are deferred.

Kamui is built from public standards (SNIP-5, SNIP-6, SNIP-9, SNIP-12, SNIP-41) and permissively licensed components, with no Cartridge code. [PLAN.md](PLAN.md) explains why and records the design decisions. [SPIKES.md](SPIKES.md) has the research behind them.

## How it fits together

1. An app sends the user to the **keychain** with a session request: what the session may call and how much it may spend.
2. The keychain signs the user in with Google. The **pepper service** turns that login into the account's identity, and the keychain proves the login in the browser (SNIP-36) to install the user's device key as an owner of their **account contract**.
3. Once the user approves, the account registers the app's session key. The app then signs its own calls, and the **backend** sponsors them.

## Repository layout

| Path | What it is |
|---|---|
| [contracts](contracts/README.md) | Cairo contracts: the `KamuiAccount` (social recovery, owner set, SNIP-41 sessions, SNIP-9 outside execution), the JWK registry, and the registry administrator. |
| [sdk](sdk/README.md) | TypeScript helpers on starknet.js 10: account addresses, owner keys, sessions, and sponsored calls. |
| [keychain](keychain/README.md) | The sign-in and approval page that holds the device key, with the pinned [browser prover](keychain/prover/README.md). |
| [services/backend](services/backend/README.md) | API that authenticates deployments, relays browser-made proofs, sponsors transactions, and keeps the session registry. |
| [services/pepper](services/pepper/README.md) | Reference pepper service. Not for mainnet accounts. |
| [apps/demo-dapp](apps/demo-dapp/README.md) | "Ping", a demo app that connects through the keychain with a scoped session. |
| [apps/login-demo](apps/login-demo/README.md) | Runs the SDK's login flow end to end on one page. |
| [infra/aws](infra/aws) | Hosting for the Sepolia beta: [lean EC2 package](infra/aws/lean/README.md), [Terraform](infra/aws/terraform/README.md), and the [KMS registry administrator](infra/aws/registry-admin/README.md). |
| [spikes](spikes) | Experiments and recorded runs that informed the plan. |
| [docs](docs) | Developer docs for apps that use Kamui (VitePress), published to GitHub Pages. `cd docs && bun install && bun run dev`. |
| [docs/legal](docs/legal) | Terms of use and privacy notice for the Sepolia beta. |

Each component's README covers how to run and test it.

## Toolchains

| Tool | Version | Pinned in |
|---|---|---|
| Bun | 1.4.4 | [.prototools](.prototools) |
| Scarb | 2.20.1 | [contracts/.tool-versions](contracts/.tool-versions) |
| Starknet Foundry | 0.64.0 | [contracts/.tool-versions](contracts/.tool-versions) |

Run the contract checks from `contracts/`:

```sh
scarb fmt --check
snforge test
```

## CI

| Workflow | Runs on | What it checks |
|---|---|---|
| [contracts](.github/workflows/contracts.yml) | PRs touching `contracts/` | `scarb fmt --check` |
| [keychain-tests](.github/workflows/keychain-tests.yml) | PRs touching `keychain/` or `sdk/` | Type checks and Chromium browser tests |
| [images](.github/workflows/images.yml) | PRs touching the keychain, SDK, services or backup image | Container builds (not a release) |
| [docs](.github/workflows/docs.yml) | PRs touching `docs/` or `sdk/src/`; pushes to `main` | Type-checks the docs' code snippets against the SDK, builds the site, and deploys it to GitHub Pages from `main` |
| [terraform](.github/workflows/terraform.yml) | PRs touching `infra/aws/terraform/` | `terraform fmt`, and a read-only plan of `github-oidc` in both test accounts |

## Licence

[MIT](LICENSE). Third-party code keeps its own licence: see `THIRD_PARTY.md` in [contracts](contracts/THIRD_PARTY.md), [services/backend](services/backend/THIRD_PARTY.md) and [services/pepper](services/pepper/THIRD_PARTY.md), and the [browser prover's notices](keychain/prover/THIRD_PARTY_NOTICES.md).
