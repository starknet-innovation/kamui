# Manual KMS admin operator

`operator.ts` reads a private transaction plan, checks an accepted Sepolia snapshot and requests an explicitly confirmed KMS signature. It **does not broadcast**, deploy, fund an account, change registry roles, alter AWS settings, or estimate fees. The `check` command performs RPC reads only and does not contact AWS. The `sign` command contacts KMS only after local checks and interactive confirmation.

Copy [operator-input.example.json](operator-input.example.json) outside Git, in an operator-owned directory with mode `0700`, and give the input mode `0600`. Every `FILL_...` value is deliberately invalid. Do not paste the completed file into chat or Git. KMS references and authenticated RPC URLs stay private; no private signing key, AWS credential, JWT, proof, cookie or pepper field is accepted by this schema.

Use Bun 1.4.4 from the repository, or another independently reviewed compatible installation:

```sh
KAMUI_BUN=/Users/adrienlacombe/ws/kamui/spikes/s1/tools/node_modules/.bin/bun
# Run from infra/aws/registry-admin. These commands are operator-run, not executed by preparation.
"$KAMUI_BUN" operator.ts check --input /absolute/private/operator-input.json
"$KAMUI_BUN" operator.ts sign --input /absolute/private/operator-input.json \
  --output /absolute/private/operator-signed.json
```

`sign` requires stdin and stderr to be interactive terminals. It prints the complete public transaction review (kind, transaction hash, account, chain, nonce, fee bounds/maximum and all calls or constructor data) to stderr. Type **`SIGN <exact transaction hash>`**, using the hash displayed in that review. There is no `--yes` flag. It then checks chain, account class, public coordinates and nonce again before contacting KMS. The output directory must be mode `0700` and owned by the operator. Output is exclusive mode `0600`; an existing file is never overwritten. The destination is reserved **before** a signature is requested. If anything fails, preserve the empty/partial destination as failure evidence and inspect the cause; automatic retry/overwrite is not offered.

The only success messages are `OPERATOR_PREFLIGHT_OK` or `OPERATOR_SIGNED_NOT_BROADCAST`. Errors use a fixed allowlist of status codes. KMS identifiers, RPC URLs, local paths and provider error bodies are not printed. A signed artifact is actionable authorization: retain it privately, and do not share or broadcast it without the separately reviewed operation and aggregate spending budget. Query-version signatures cannot be substituted for a real transaction signature.

## Input schema

Root fields are exact: `schema: "kamui.kms-operator.v1"`, `region`, immutable `keyId`, full uncompressed `publicKey` (`0x04` + 64 hex x + 64 hex y), `accountAddress`, reviewed `classHash`, positive `maxFeeFri`, `rpcUrl`, `transaction`. Numeric fields in the JSON input are **strings** (decimal or `0x` hexadecimal), including all resource bounds. No unknown field is accepted at the root, transaction, call, details, or resource-bound level. HTTPS is required except for loopback test RPCs. URL userinfo and fragments are rejected. Input must be an ordinary file, owned by the operator, with no group/other permissions; symlink files and oversized input are rejected.

For an invoke, `transaction` has `kind: "invoke"`, a nonempty `calls` array, and `details`. Each call has only `contractAddress`, an identifier `entrypoint`, and felt-string `calldata`. Details contain exactly:

- `walletAddress` matching the root account, `cairoVersion: "1"`, Sepolia `chainId`, `version: "0x3"` (or query `"0x100000000000000000000000000000003"`), the current `nonce`, and `tip`.
- `resourceBounds` with `l1_gas`, `l2_gas`, `l1_data_gas`; each has `max_amount` and `max_price_per_unit`. Use a fee estimate with **validation enabled**; this tool does not produce one. The signer caps the sum of all three amount-times-price bounds plus the L2 tip at `maxFeeFri`.
- Empty `paymasterData` and `accountDeploymentData`, and `nonceDataAvailabilityMode: "L1"`, `feeDataAvailabilityMode: "L1"`. This manual tool excludes paymaster/proof/deployment extensions.

For a deploy, replace the transaction with `kind: "deploy"` and `details` only. Keep the common chain/version/nonce/tip/resource-bound/data-availability fields above, with nonce `"0"`. Replace `walletAddress` and `cairoVersion` with `contractAddress` (the root predicted account), `classHash` (the root reviewed class), `addressSalt`, and `constructorCalldata` (the four felt strings from `KmsK1Signer.constructorCalldata()`). The tool requires the root predicted address to match the exact reviewed class, salt and KMS public coordinates. It accepts only the protocol's exact `CONTRACT_NOT_FOUND` code at that address as evidence of nondeployment; other errors fail closed. It fetches the declared Sierra class at that accepted block and recomputes its hash before allowing signing.

## Observation and artifact

All class/key/nonce reads within one preflight use the same accepted block hash returned by the selected RPC. Invoke preflight checks the exact full `get_public_key` coordinates, not an x-only or Ethereum-address approximation. The second preflight after confirmation can use a newer accepted block. A trusted RPC is still an assumption; this does not prove consensus, absence of pending transactions, continuing custody or freedom from a later governance/class change. Another operator/process must not write the account's nonce concurrently.

The result schema is `kamui.kms-signed.v1`: `kind`, `transactionHash`, four-limb `signature`, public `account`, `classHash`, `chainId`, complete original `transaction`, and `observation` with `blockHash`, `chainId`, `account`, `classHash`, `nonce`. It omits KMS references, AWS identity/profile, Region and RPC URL. Exported helpers are `parseOperatorInput`, `preflight`, `reviewAndSign`, `readPrivateInput`, `reservePrivateOutput`, `safeStatus`, `HttpReadRpc`, and `OperatorRpcError`; transports accept only hardcoded read methods. No invoke/deploy/broadcast RPC method is implemented.

Local tests use mocked RPC and KMS plus ephemeral synthetic keys. They are not live KMS or Sepolia acceptance and do not authorize registry role handoff.

For the separately confirmed, fee-reserved deployment/Ping submission path, see [bounded submitter](SUBMIT.md). Signing alone sends nothing.
