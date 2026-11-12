# Run 13: native KMS k1 administrator on Sepolia

12 November 2026. **Passed.** A real dedicated AWS KMS secp256k1 key signed the raw 32-byte Starknet transaction digest. Its private key stayed in KMS. The separate immutable `KmsK1Admin` class was declared, its account funded and deployed, and one harmless `ping()` accepted. [Structured public evidence](run-13-kms-admin.json).

| Operation | Transaction | Block | Actual fee (test STRK) |
|---|---|---:|---:|
| declare | [0xa278ac2902…](https://sepolia.voyager.online/tx/0xa278ac29021ba97f3583854fb5f3d7039521df4c8b4d1a9a096af0014ab73) | 18,048,233 | 5.518200590644095168 |
| fund | [0x2ea35bf84b…](https://sepolia.voyager.online/tx/0x2ea35bf84bf02a1d440a419395aad05b06763220f98b2c9dcb380c809a24969) | 18,048,254 | 0.044396281513259536 |
| deploy | [0x20fdd07fc3…](https://sepolia.voyager.online/tx/0x20fdd07fc347ff761728f894a2a07356a5b8f6f2be3121f4ca4bbc970149306) | 18,048,268 | 0.464672067817817606 |
| ping | [0x21046afab7…](https://sepolia.voyager.online/tx/0x21046afab78c7f2ee031fce58eb18bcb57f9f2358def5d74af4cf419a4a5072) | 18,048,325 | 0.422678511980205044 |

Total actual fees: **6.449947451955377354 test STRK**. Funding transferred **2 test STRK**, rather than consuming it as a fee. The administrator retains **1.11264942020197735 STRK**; the relayer retains **2846.34030268749403032 STRK**. Both balance deltas exactly match the recorded principal and fees. All four receipts were successful, accepted on L2 and checked against the canonical block at their block number. Durable reservations retain their original maximum fees after reconciliation.

- Account: `0x67141ab3d3b99425c5ecb32cabc9b718b36ec8a5f933fc79e9601d9e23bc09`.
- Class: `0x7164c4f64b1c7608b3e88806dc7a24083e728c892f6c7488900665d634ddf79`.
- Compiled class: `0x1bf4f493f500bd6dab34c29fc9913403fa35a33a7a2258fbb507ff9755ffd75` (Starknet 0.14.4).
- Native KMS interoperability probe passed locally and subsequently on the deployed account via `is_valid_signature`.
- Deployment and Ping fee estimation both used `skipValidate: false`, signed query transactions, zero tip and 15% margins on gas amounts and prices.
- Five successful KMS signing requests: one interoperability challenge, two query estimates, deployment and Ping. No automatic signing retries.
- Read-only changed-digest and different-public-key checks returned zero; the original KMS challenge returned `VALID`.
- Full on-chain public coordinates and class match the reviewed inputs. Account nonce is **2**; Ping counter **12 → 13**.

## Submission and implementation findings

Before any paid submission, the user explicitly removed Sepolia STRK spending caps. The private run uses an explicitly authorized v2 journal with no aggregate/attempt cap; default v1 limits remain unchanged. Exact resource bounds, durable pre-send reservation, hash/nonce replay refusal and canonical receipt reconciliation remain active. Each of the four operations was submitted once; receipt polling did not resend.

A new guard caught a class-hash mismatch before submission: starknet.js hashes artifact ABIs as arrays, while RPC/declaration wire ABIs are JSON strings. Normalizing the ABI before hashing fixes both the one-run declaration check and the reusable deployment preflight; regression tests cover both representations. A subsequent free payer-signature RPC check initially rejected decimal calldata with `Missing '0x' prefix`; normalization to hexadecimal fixed it before any reservation or paid RPC. No rejected paid transaction resulted from either issue.

The declaration/funding harness used the existing backend SecretSource for the already authorized relayer; native administrator signatures came from the separate local KMS profile. No new AWS resource/security change was needed during this acceptance test. Private input files, transaction signatures, AWS identifiers, raw errors and the durable journal remain outside Git.

Validation: **86 TypeScript tests**, **39 Python setup tests**, TypeScript typecheck and `git diff --check` passed. Contract source was unchanged in this run; the earlier 179-test contract result is not a new execution here.

## Remaining scope

No registry roles were granted or renounced, and no registry upgrade was attempted. The existing Kamui user-account class and registry were not changed. No hosted deployment or mainnet test occurred. Wrong-key/digest checks were free contract calls, not rejected paid sequencer submissions. Custody/security review and independent recovery remain open: the three IAM roles share the existing bootstrap principal. Successful Sepolia acceptance does not establish production readiness or authorize a registry authority handoff.
