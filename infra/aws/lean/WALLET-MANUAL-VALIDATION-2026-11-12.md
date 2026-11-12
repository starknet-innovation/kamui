# Wallet funding, live PostgreSQL and manual administration

Baseline `0e98583` plus this follow-up. User selected a $100/month planning budget, will act as AWS operator/security reviewer, and selected separate off-server registry administration with manual updates. These choices do not approve cloud provisioning/security changes or nonzero hosted fee limits.

## Verified implementation

- `POST /wallet/sponsor`: exact account-self management ABI, two-element current-owner signature over the real outside hash, current class/chain, unused nonce and bounded window. Arbitrary app calls and four-element session signatures cannot use this path. Wallet limits default off and share the global cap.
- PostgreSQL v3 preserves existing paid history/pause and adds wallet-kind debits. Account/nonce binding prevents repeated paid wallet attempts after retries or signature/payload variations.
- Local sponsor estimates use `skipValidate:false`, zero tip and three validated resource bounds. App backends supply their own app ID/credential; the browser holds no server token.
- Manual hosting removes the automatic rotator and administrator mount. The independent watcher detects newly published Google keys even without events. The hosted API refuses startup before reading its signer if its relayer still holds pinned-registry admin/revoker authority. This is a scoped trusted-RPC startup check, not a custody proof or continuous-role audit.
- Operator artifacts include private-input AWS read-only inspection, explicit review records and unsigned role/JWK planners. No signing key/account was created or exported, no roles changed, and the AWS inspector was not run by this work.

| Check | Result |
|---|---|
| Backend suite with disposable PostgreSQL | 243 passed, zero failures |
| Keychain Playwright matrix: bundled Chromium / Firefox / WebKit | 219 passed, 3 skipped |
| Keychain server/configuration | 6 passed |
| Demo app proxy | 2 passed |
| Host package Python | 8 passed |
| Readiness/handoff Python | 16 passed, including KMS class/key/controller-receipt gates |
| Unsigned Google JWK planner | 3 passed, including KMS administrator pins |
| KMS signer / operator / live preparation / bounded submission | 84 passed; mocked KMS/RPC, no actual AWS call |
| Backend / keychain / readiness / KMS operator TypeScript | Passed |
| Updated backend / keychain amd64 image builds | Passed locally; no publication |
| Diff and public run-12 artifact field/JWT checks | Passed |

Browser matrix services are mocked and separate from the live proof below. Local build/inspection results do not verify EC2 boot, AWS/IMDS/S3 permissions, TLS issuance, pager delivery, load sizing or public abuse resistance.

## Live Sepolia regression

[Run 12](../../../spikes/s1/results/run-12-postgres-regression.md) passed four transactions: wallet session approval, approved-app Ping, Google browser-proof recovery, wallet revoke-all. All receipts were ACCEPTED_ON_L2/SUCCEEDED. Actual fees **2.116362690347488448 test STRK**; signed maxima/debits **4.748786677424971200 STRK**, within the explicit four-attempt/12-total/5-each authorization. The payer balance delta matches the four fees.

Pause persisted through PostgreSQL/API restarts, and a fresh valid request was refused while paused and when temporarily tightening the cap, without debit. The recovery was independently accepted while its SQL row remained unfinished after API termination; the restarted API reconciled that exact hash and the original browser poll completed. Owners 4→5 retained every previous key; recovery ended the session at epoch 8 and revoke-all advanced to 9.

Final local funding is **paused**. PostgreSQL history/private backup and both device profiles are retained. Original SQLite configuration/data were untouched. Ordinary launch still uses that legacy configuration and must not be mistaken for the private PostgreSQL continuation. No additional paid attempt is authorized by this run; see the [retained-harness instructions](../../../spikes/s1/harness/run-12/README.md).

The existing local test relayer still has registry roles; this test did not enable the hosted offline-admin guard or perform a handoff. No AVNU, AWS deployment, first-account deployment, registry update or physical power-loss result is claimed.

## Operator steps still required

Provide an already independently controlled off-server controller address, review its custody/recovery, then use the unsigned grant-new → confirm-control/roles → renounce-old → verify workflow. A role must not be granted to a Kamui account whose recovery depends on this registry. No current role has been removed or granted by this work.

The [operator readiness runbook](readiness/README.md) orders private AWS inspection and technical approvals before provisioning/DNS/Google changes. Actual controller handoff, cloud resource review, retention/privacy, hosted funding thresholds/apps and real alert routing remain pending. Under the standing project rules the user runs approved cloud/security commands; the agent has prepared them and has made no AWS resource/security/DNS changes.

The later [KMS k1 operator implementation](../registry-admin/README.md) adds a separate immutable administrator account and bounded local tooling. Key creation, actual KMS/Sepolia acceptance, custody/recovery review and registry handoff remain pending; the run-12 receipts do not validate that new account.
