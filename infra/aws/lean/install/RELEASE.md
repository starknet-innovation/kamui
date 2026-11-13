# Immutable Sepolia release publication

`release.py` is called by the operator's numbered installation wrapper. It is not an application startup command. It never runs during an assistant test, creates accounts, changes the pepper/k1 key or grants registry authority.

## Resources and permissions

The additional `release-resources.json` CloudFormation stack is created in each existing account. Existing core/network/IAM stacks are not updated. The backend account receives five private ECR repositories (`kamui-sepolia/keychain`, `backend`, `pepper`, `postgres`, `caddy`) and a versioned private artifact bucket. Repositories use immutable tags, AES256 encryption, scan-on-push, and retained resources. The artifact bucket uses SSE-S3, all public-access blocks, bucket-owner-enforced ownership, HTTPS-only access and retain policies. No lifecycle silently deletes a rollback artifact. Storage can incur charges.

An additive policy on each existing host role permits `ecr:GetAuthorizationToken` (necessarily resource `*`) and repository-scoped layer/image reads. The backend can pull all five repositories; pepper can pull only pepper and Caddy. Only those two repositories grant the exact existing pepper role cross-account read access. No push, IAM, KMS or role-assumption action is granted. The bucket and role policies permit only `GetObject` under `installation/*` and bucket-location reads; this bucket is for public code/artifacts, never runtime secrets or database state. Runtime secrets must not enter image layers, S3 objects, CloudFormation/SSM command parameters or their logs.

The existing host-role explicit IAM/KMS/STS denials remain in their core stack. These generated policies and role matches are not a full effective IAM/SCP/resource-policy audit, per-container metadata isolation, vulnerability sign-off or mainnet custody approval. Existing operator credentials need permission to create the new named IAM policies and ECR/bucket resources. Host identities receive no publishing permission.

Parameters are `HostRole`, `HostRoleName`, `BackendAccount`, `PepperRoleArn` and `ReleaseBucketArn`. Backend uses an unused syntactically valid bucket placeholder; the conditional branch uses its actual new bucket. Pepper's rule refuses that placeholder. Real values remain in private request/result files. Backend outputs the five `*RepositoryUri` values plus `ReleaseRegistry`, `ReleaseBucketName` and `ReleaseBucketArn`; pepper outputs the registry. The parent stack driver supplies durable intents and never retries an uncertain create.

## Source, bases and artifacts

The publisher requires a clean **committed** tracked source revision. It stages `git archive` regular files only, refusing symlinks, traversal and private env filenames. Existing `.dockerignore` files remain in their respective contexts. Gitignored prover binaries are the only untracked additions: each is copied by its exact committed manifest path and must match its byte count and SHA-256. Missing assets stop; run the existing keychain asset installer beforehand.

The fixed upstream inputs are Bun `1.4.4`/`1.4.4-slim`, PostgreSQL `16` and Caddy `2-alpine`. Before a build, their unique `linux/amd64` child-manifest digests are resolved and durably pinned. Staged Dockerfiles use those exact pins; original Dockerfiles are not edited. The recorded source and base pins make the inputs reviewable, but dependency repositories and the PostgreSQL apt transaction are not a promise of byte-identical rebuilds. The final pushed image digest is the deployment authority.

All four application/database builds run for `linux/amd64` on the workstation, not the small EC2 hosts. Caddy is mirrored from its pinned upstream image. For the keychain, `/app/dist/main.js` is read from the built image without networking and its SHA-256 is recorded for hosted acceptance.

Each image is published using one invocation under a unique immutable release tag. A private built-config record and push intent are fsynced first. An existing intent is reconciled only by observing ECR: its manifest SHA-256 and image-config digest must match the local built record. A missing remote image after an uncertain push stops; no automatic second push occurs. Docker may perform its own content-addressed protocol retries within an invocation; this wrapper does not run the process again. Do not delete state or select another directory to bypass uncertainty.

ECR login retrieves the short-lived password into memory, passes it through stdin, and uses an ephemeral private `DOCKER_CONFIG`. Password stdout/stdin and login output are never logged; the config directory is removed even on failure. Other tool diagnostics remain private. No token, AWS account identifier or ARN is printed. The publisher does not change the user's normal Docker auth file.

## Parent integration

`Release(root, aws, run=None, repo=REPO)` uses `root/installation/release`:

1. `prepare_resources(callback)` verifies both expected accounts and exact instance-profile roles, then invokes `callback(role, 'release', template, parameters)` for backend and pepper. It saves `resources.json`.
2. `build_publish()` creates/preserves `plan.json`, staged source, per-image build/push records and the final `release.env`/`release.json`.

The manifest schema is `kamui.release.v1`: `sourceRevision` and `sourceCommit` are equal; `images` contains the five `*_IMAGE` keys with ECR `@sha256:` references; `mainJsSha256`, `baseImages`, `architecture`, artifact bucket values and `requiresVulnerabilityAndLicenseReview` are recorded. Raw manifests and identifiers stay private. No hosted install or approval is implied by publication. Retain source/base-image notices and perform the requested license/vulnerability review before public launch.

`aws.request` needs STS identity, IAM profile reads, ECR `describe-images` and `batch-get-image`; the latter pair bind the remote manifest/config. Image absence is classified only by `ImageNotFoundException` or `ECR_IMAGE_NOT_FOUND`. Other failures stop. ECR login intentionally bypasses the ordinary response logger to keep its credential out of diagnostic files.

## Verification

Nine fake-transport tests cover full five-image publication, private login handling, base pinning, source/credential exclusion, wrong-account refusal and both outcomes of a lost push response. The template passes `cfn-lint 1.60.1` without suppressions. No AWS operation, image build/push or registry configuration was executed during implementation. CloudFormation service validation, effective permission checks, actual image scans and real cross-account pulls remain operator acceptance.

Primary references: [ECR authentication](https://docs.aws.amazon.com/AmazonECR/latest/userguide/registry_auth.html), [repository policies](https://docs.aws.amazon.com/AmazonECR/latest/userguide/repository-policies.html), [ECR IAM actions/resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerregistry.html), [ECR basic scanning](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-basic.html), [S3 policy action mapping](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-with-s3-policy-actions.html).
