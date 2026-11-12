# KMS secp256k1 registry administrator

The administrator contract is not audited. Live Sepolia KMS signing, deployment and a harmless Ping passed on 12 November 2026; see [run 13](../../../spikes/s1/results/run-13-kms-admin.md). Role/profile/key setup was live-tested in the existing backend test account with explicit user authorization. The user selected KMS custody with a **k1 signer** on 12 November 2026. This replaces the hardware/offline-key recommendation with manual, off-server access to a KMS-held signing key. Three IAM roles/profiles and one dedicated native k1 KMS key were created and verified; the separate administrator account is deployed on Sepolia, but no registry role handoff has been performed.

## Design

`contracts/src/kms_admin.cairo` defines a **separate** immutable `KmsK1Admin` account. Its constructor fixes the full secp256k1 public key; it has no social recovery, session keys, key setter, outside execution or upgrade entrypoint. It supports V3 invoke/deploy validation and their query forms. Declaration and generic message signing are intentionally disabled in the operator adapter. This is a minimal administrative account, not a general wallet connector or full SRC-6 integration.

The account verifies the raw Starknet transaction hash as an ECDSA digest, using Cairo's corelib secp256k1 verification. The signature ABI is `[r.low, r.high, s.low, s.high]`, each limb a `u128`. `signer.ts` implements starknet.js 10.8.0's `SignerInterface` using `GetPublicKey` and `Sign` only. It requests `ECC_SECG_P256K1`, `SIGN_VERIFY`, `ECDSA_SHA_256`, and **`MessageType: DIGEST`** with a 32-byte big-endian transaction hash. No SHA-256 pass or Ethereum message prefix is added. KMS's DER signature is normalized to low-s and verified locally before being returned. The public-key parser accepts only the canonical DER SPKI for an uncompressed secp256k1 key. [AWS key specifications](https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html), [AWS Sign semantics](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)

The adapter pins the immutable KMS key ARN and full public key, the predicted/deployed account address, the reviewed new account class hash, Sepolia and a per-transaction maximum FRI fee. It validates all three resource bounds, including the L2 tip, snapshots input before awaiting approval, and requires an explicit approval callback on every signature, including fee-estimation queries. A callback returning true is an application hook, not evidence of a human review or an AWS-enforced transaction policy. Do not wire an always-approve callback into a service. KMS SDK calls have a 15-second timeout, no automatic retry and sanitized errors. A timeout may still mean KMS produced a signature; this adapter cannot broadcast it or spend STRK.

The existing registry's `DEFAULT_ADMIN_ROLE` and `REVOKER_ROLE` can be granted to the **new account address**, not to a KMS identifier or public key. The registry's address and Kamui user-account class remain unchanged. The admin role also permits registry upgrades. The backend/API, JWK watcher and hosted machine receive no KMS signing permission; manual updates continue through the operator workstation. The pepper HMAC key and transaction relayer remain separate and unchanged.

KMS custody is online availability and AWS authorization, not an air-gapped signer. A principal able to call `kms:Sign` can bypass this local review callback and sign arbitrary account transactions. A compromised authorized operator workstation can therefore exercise all registry roles. Key-policy/IAM ownership, session/MFA requirements, key deletion/disable controls, independent recovery/governance and audit-log privacy need security review. The immutable account cannot recover a lost/deleted KMS key or change curves; normal migration is grant/verify/renounce to another reviewed administrator **while the old signer still works**. Do not remove the last usable administrator without an approved recovery design.

## Operator preparation

Run `./infra/aws/registry-admin/00-setup-registry-k1.sh` from the repository for the ordered role → profile → key workflow. Select one existing operator administrator profile; the scripts create the three purpose-specific roles/profiles, then run guarded key creation. See [numbered steps and trust/recovery limits](KEY_SETUP.md#start-here--create-roles-profiles-then-the-key). The standalone `setup-k1-key.sh` remains available when those roles already exist. The user subsequently authorized live execution of these scripts: the three roles/profiles and native k1 key were created and verified. See [sanitized setup results](SETUP_VALIDATION-2026-11-12.json).

After AWS/security review, the operator creates a **new**, dedicated, AWS-generated asymmetric signing key in the approved account/Region. Do not reuse the pepper HMAC key, import a Stark key, or mount a signing key on a server. The operator's narrowly scoped signing identity needs `kms:GetPublicKey` and `kms:Sign` for this exact key; key administration should be separately reviewed. No broad/default IAM policy is generated here.

Example key creation, to be run only by the operator after filling private paths/profile and reviewing the key policy. The private directory must already exist with mode `0700`; preserve command output/errors privately, and do not paste account identifiers into chat or Git:

```sh
KAMUI_BUN=/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun
umask 077
aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY \
  --origin AWS_KMS --region eu-west-1 --profile "$AWS_PROFILE" \
  --policy "file://$KAMUI_REVIEWED_KEY_POLICY_FILE" \
  > "$KAMUI_PRIVATE_DIRECTORY/admin-key.json" \
  2> "$KAMUI_PRIVATE_DIRECTORY/admin-key.log"
```

Do not run this example with an unreviewed policy. Obtain the key's public SPKI with `kms:GetPublicKey`, retain the immutable key reference privately, and independently check the full public key. Review/build/declare `KmsK1Admin` using the existing approved declaration signer. Use `constructorCalldata()` to serialize its public coordinates; derive the new address with the reviewed class, salt and those exact constructor arguments. Fund/deploy only after a separate Sepolia test budget is approved.

For manual signing, instantiate `KmsK1Signer(awsKmsPort(region), config)` on the operator machine. `config` contains `keyId`, uncompressed SEC1 `publicKey`, `accountAddress`, `classHash`, positive bigint `maxFeeFri`, and an `approve(review)` callback. Use temporary, reviewed AWS credentials through the SDK's default credential chain. The callback must display and explicitly approve the complete immutable call/deployment data, hash, chain, nonce and maximum fee. `constructorCalldata()` does not contact AWS. `getPubKey()` checks the KMS metadata and exact key; it returns `0x` followed by x and y, without the SEC1 `04` prefix. The [manual operator CLI](OPERATOR.md) now performs these preflight checks and exact-hash confirmation; it writes a private signed artifact and has no broadcasting method. The [separate paid-test sender](SUBMIT.md) freshly checks actual RPC chain, account class, nonce and on-chain public coordinates before submission; config pins alone do not verify live state. The signer permits arbitrary calls after review and is not a target-selector policy engine.

KMS signing, account validation, a harmless transaction and validation-enabled estimation are now verified live, including read-only wrong-key rejection. After custody/recovery review, use the existing [unsigned registry handoff workflow](../lean/readiness/README.md#3-prepare-the-registry-role-handoff-then-let-its-owner-sign) to grant both roles, confirm the new controller, and only then renounce the old roles. Independently check receipts, both role sets, pinned registry/account classes and watcher health. No registry replacement or Kamui user-account migration is needed.

## Prepared operator and live workflow

1. The [ordered setup scripts](KEY_SETUP.md) create the role/profile/key chain. Their live run was explicitly authorized by the user and completed; this is not blanket authorization for other AWS changes. Keep all real AWS identifiers in private local files; provide only the metadata file path and signing-profile name.
2. Use the [live preparation and interoperability check](LIVE_TEST.md) to convert the private AWS CLI metadata and verify one real KMS signature. This check has no transaction-sending method. The user subsequently removed Sepolia STRK spending caps explicitly. The live run uses an uncapped v2 journal that still preserves exact hash/nonce reservations and actual-fee reconciliation; the default v1 journal retains its original caps. No allowance from run 12 is reused.
3. Use [operator check/sign](OPERATOR.md) to check an accepted chain/class/key/nonce snapshot, review the complete transaction and type its exact hash. Signing produces exclusive private artifacts and does not broadcast. The separate [bounded submitter](SUBMIT.md) verifies those artifacts, rechecks live state, requires exact-hash SEND confirmation and reserves the exact fee in the original durable journal before one deployment or test Ping submission. It cannot mutate the registry or send declaration/funding transactions.
4. After actual accepted live results and custody/recovery review, prepare the [registry handoff](../lean/readiness/README.md#3-prepare-the-registry-role-handoff-then-let-its-owner-sign). It now pins the admin class and full k1 key and requires accepted controller-transaction evidence before old roles can be renounced. Registry handoff fees and hosted deployment remain separate approvals. The hosting readiness record explicitly checks off-server KMS permission isolation; the legacy `REQUIRE_OFFLINE_REGISTRY_ADMIN` flag checks the relayer's on-chain roles only.

The key exists and its policy/public metadata are verified. The native signing probe and live KMS/Sepolia acceptance passed; the registry role handoff remains pending. These results do not complete custody/security or independent-recovery review.

## Local verification

Use the repository's Bun 1.4.4 executable:

```sh
cd infra/aws/registry-admin
"$KAMUI_BUN" install --frozen-lockfile
"$KAMUI_BUN" test
./node_modules/.bin/tsc --noEmit
```

The signer and operator tests use ephemeral synthetic keys and fake KMS/RPC transports; the shared public vector is locally generated, **not a live KMS result**. The Cairo suite includes real secp256k1 verification, malformed/wrong/high-s rejection, caller/version guards, deploy/query validation, the shared TypeScript DER vector and local registry role calls through the new account. These checks do not prove live KMS interoperability, sequencer validation limits, custody, key-policy safety or production readiness. Verify those before role handoff.

Dependencies are pinned separately from the backend: AWS SDK v3 (Apache-2.0), noble-curves (MIT), starknet.js (MIT), TypeScript (Apache-2.0) and Bun types (MIT). Keep their distributed license notices. No Cartridge source was used.
