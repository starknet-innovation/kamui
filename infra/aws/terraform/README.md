# Kamui test deployment on AWS (Terraform)

Infrastructure as code to host the pepper service and the backend in the two dedicated **test** accounts, `kamui-pepper-test` and `kamui-backend-test`.

**Status: written, never applied.** Formatting passes after the client-proving removal. Earlier templates passed offline validation (Terraform 1.15.5, AWS provider 6.x, `init -backend=false`); validation of the revised backend is currently blocked by missing installed module metadata. No init was run for this revision. No plan was run against an account and nothing here has contacted AWS. Expect to fix things on the first real plan. Statements about AWS carry a link to the AWS page they were checked against, or are listed under [Not verified](#not-verified).

This is for testing only. Read [Not for production as is](#not-for-production-as-is) before reusing any of it.

**Current Google-only hosting proposal:** [HOSTING_REVIEW.md](HOSTING_REVIEW.md) inventories the missing keychain/watcher/AVNU wiring, proposes private API routing, and records storage, architecture, cost and ownership gates. [HOSTING_ACCEPTANCE.md](HOSTING_ACCEPTANCE.md) is the unapproved operator checklist. These are a review package, not implemented Terraform changes or permission to apply the current templates.

**Client-side proving (12 November 2026):** the keychain now prepares browser execution/proving with pinned `snip-36-prover-wasm` v1.0.1 and no automatic backend fallback. [CLIENT_PROVING.md](../../../keychain/CLIENT_PROVING.md) records installation, privacy boundaries and pending live V2 Kamui validation. The templates no longer create a hosted prover, its service discovery/port, ECR repository or account credential. They still omit the keychain, watcher and AVNU wiring described in the review packet. No resource was applied or modified in AWS.

**Selected lean beta direction (12 November 2026):** two EC2 servers in the existing separate test accounts, with PostgreSQL on the backend server and pepper's existing key kept in KMS. This supersedes the earlier Fargate/RDS/ALB/WAF proposal for the initial open Google-only Sepolia beta. Cloudflare remains DNS-only; HTTPS terminates on each server, with API/database local-only. Replacement edge controls need review.

[COST_ESTIMATE.md](COST_ESTIMATE.md) models about $56/month with a proposed $75 planning target, subject to workload validation and user budget decision. [HOSTING_REVIEW.md](HOSTING_REVIEW.md) records implementation, backups/restore and review gates. **The Terraform below still implements Fargate/SQLite/EFS; EC2 provisioning remains unimplemented. PostgreSQL application stores and an explicit offline import are now implemented and locally tested; see [POSTGRESQL.md](../../../services/backend/POSTGRESQL.md). No existing data was migrated and no hosted cutover occurred. Do not apply these templates as the selected target.** Earlier comparisons remain in [FARGATE_HOSTING_REVIEW.md](FARGATE_HOSTING_REVIEW.md) and [FARGATE_COST_ESTIMATE.md](FARGATE_COST_ESTIMATE.md).

## Layout

| Path | What it is |
|---|---|
| `bootstrap/` | Creates the S3 bucket for Terraform state. Applied once in each account, with local state. |
| `pepper/` | Root module for `kamui-pepper-test`: the pepper service, its role, the key policy, the audit trail and alarms. |
| `backend/` | Root module for `kamui-backend-test`: api, rotator, secrets, storage. |
| `modules/network` | VPC with two public and two private subnets and one NAT gateway. |
| `modules/https-alb` | Public load balancer, HTTPS only, one target group. |
| `modules/fargate-service` | One container as an ECS Fargate service with its own roles, security group and log group. |
| `policies/` | Service control policies, as JSON, for the organisation's owner to attach. Not applied by Terraform. |

Related: `../setup-test-access.sh` and `../create-test-pepper-key.sh` (CLI access and the existing test key), `../../../services/pepper/Dockerfile` (added with this work).

## Hosting choices

### Pepper service: ECS on Fargate behind an Application Load Balancer

One task, 0.25 vCPU and 512 MB, in a private subnet. The load balancer terminates HTTPS and is the only thing that can reach the task.

Why not the other two:

- **App Runner** would be the least to run, but AWS states it "is no longer open to new customers" ([App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)). The test accounts are new.
- **Lambda with a function URL** gives HTTPS with no load balancer and nothing running while idle. But Lambda hands the function an event object, not a socket ([invoking function URLs](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html)), and the service is a `Bun.serve` HTTP server: it would need an adapter layer and a Bun runtime image. Its rate limits and JWKS cache live in process memory, and Lambda runs as many copies as there are concurrent requests and freezes them in between, so the per-user limit would not hold. The service would have to change first.
- **Fargate + ALB** runs the container as it is, keeps one long-lived process (so the in-memory limits mean something), and puts exactly one proxy in front, which is the case `TRUST_PROXY=true` is written for: the load balancer appends the client address as the last `X-Forwarded-For` entry by default ([X-Forwarded headers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/x-forwarded-headers.html)).

Costs of this choice: it runs all the time, it needs a NAT gateway (the task must reach the issuers' JWKS endpoints), and HTTPS needs a certificate and therefore a host name you control ([create an HTTPS listener](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html)). For a service called a few times per user per year that is a lot of fixed infrastructure; Lambda is worth revisiting once the rate limits are moved out of the process.

### Backend: API and rotator in one cluster

| Service | Size | Reachable from | State |
|---|---|---|---|
| api | 0.5 vCPU / 1 GiB, exactly one task | HTTPS ALB in current templates; proposed private routing is not implemented | Session registry and durable deployment/recovery journal on the reviewed persistent volume |
| rotator | 0.25 vCPU / 0.5 GiB, one task | API only, port 3001 for health | Registry-owner signer, no browser witness |

Proving consumes browser resources rather than a cloud task. The keychain needs the complete verified Worker/Wasm bundle, about 108 MiB before compression/glue, and supported memory64-capable desktop Chromium. Actual Kamui JWT proof size, memory and latency remain unverified.

The keychain and independent key watcher are not yet in Terraform. Adding them and making the API private are review gates in [HOSTING_REVIEW.md](HOSTING_REVIEW.md). The target pilot sizing is five small services across both accounts, not the two backend tasks alone.

## Network

Both accounts use the same layout.

- **Public subnets:** the load balancer and the NAT gateway. The load balancer listens on 443 only; port 80 is not open.
- **Private subnets:** every task. No task has a public address. Security groups allow in only: load balancer to pepper (8787), load balancer to api (3000), api to rotator (3001), api to the registry file system (2049).
- **Outbound,** through one NAT gateway per account, TCP 443 by default:
  - pepper service: AWS KMS, the Google and Apple JWKS endpoints, ECR, CloudWatch Logs;
  - api: the Starknet RPC, the pepper service in the other account (by its public HTTPS name, `pepper_service_url`), ECR, CloudWatch Logs, Secrets Manager;
  - rotator: the JWKS endpoints and the Starknet RPC;
  If the RPC is not on 443, add its port to `extra_egress_tcp_ports`.
- The rotator is found by its private DNS name (`rotator.kamui.internal`) through ECS service discovery, which registers an A record per task ([service discovery](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-discovery.html)).
- The two accounts are not connected privately. The backend calls the pepper service over the internet like any client. All of the backend's calls arrive at the pepper service from one address (the backend's NAT gateway, output `nat_public_ip`), so they share one per-address rate-limit bucket there. See [Observations](#observations-about-the-services).

The NAT gateway is billed per hour and per gigabyte ([NAT gateway pricing](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-pricing.html)); with the load balancer it is the fixed cost of each account.

## The pepper key and who can use it

The key is not a Terraform resource. It exists already (`alias/kamui-pepper-test`, created by `../create-test-pepper-key.sh`), is passed in as `kms_key_arn`, and `terraform destroy` cannot delete it.

### The service's role

The task role has one policy with two actions, `kms:GenerateMac` and `kms:DescribeKey`, on that one key ARN (`pepper/kms.tf`). The execution role, which ECS uses to pull the image and write logs, has no KMS permission. The service has no secret, so there is no `secrets` block and no Secrets Manager in this account.

### The key policy

`pepper/kms.tf` holds the key policy as a separate, commented document. It is rendered as the output `key_policy_json` and is applied only when `manage_key_policy = true` (default `false`), because it replaces the policy on a key that already exists.

How it works, and how it interacts with the account's root and with `OrganizationAccountAccessRole`:

- A KMS key policy "does not automatically give permission to the account or any of its identities". Only a statement naming the account lets IAM policies grant access; without it, "IAM policies that allow access to the key are ineffective" ([default key policy](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html)).
- The key today has KMS's default policy, which gives the account `kms:*`. `OrganizationAccountAccessRole` has administrator permissions ([the role Organizations creates](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_accounts_create-cross-account-role.html)), so anyone who can assume it can call `GenerateMac` today. So can any other role in the account with a broad IAM policy.
- The policy here gives the account **administration actions only** (describe, read and write the key policy, tags, replicas, re-enable, cancel deletion). It does not give the account `GenerateMac`, `VerifyMac` or `CreateGrant`, so no IAM policy can grant them, administrator or not. It allows `GenerateMac` and `DescribeKey` to the service's task role by name, and adds explicit denies: `GenerateMac` for every principal except that role (`aws:PrincipalArn` is the role's ARN for a session of that role, [condition keys](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html)), `VerifyMac` and `CreateGrant` for everyone, and `ScheduleKeyDeletion` and `DisableKey` for everyone.

What this does **not** stop. The policy keeps everyone else out in normal operation, not against a determined administrator:

1. **Whoever holds `kms:PutKeyPolicy` can rewrite the policy** and give themselves `GenerateMac`. Someone has to hold it: a key whose policy nobody can change is unmanageable and needs AWS Support (same page as above). By default that is the account, so `OrganizationAccountAccessRole` can do it. It takes a deliberate, logged step, and the `key-tampering-attempt` alarm fires on every `PutKeyPolicy`. To narrow it, set `key_admin_role_arns` to a dedicated role and attach `policies/scp-restrict-key-policy-changes.template.json`.
2. **Whoever can run code as the task role can call `GenerateMac`**: an administrator can register a task definition with another image under the same role, or change the role's trust policy. This is ordinary IAM administration in the account. The defence is who has administrator access to the account at all (DESIGN.md: "very few administrators"), plus the `mac-volume` alarm.
3. **The account's root user.** The intent is that the denies and the missing allow bind the root user like anyone else, since KMS gives the account nothing automatically. This was not confirmed for the root user specifically ([Not verified](#not-verified)). A service control policy does restrict a member account's root user ([SCPs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)).
4. **The management account.** It can assume `OrganizationAccountAccessRole`, detach service control policies, and close the member account. Nothing in the member account can prevent that. Whoever controls the management account controls the key's fate.

Things to know before turning `manage_key_policy` on:

- Terraform's caller must be allowed `kms:PutKeyPolicy` by the new policy, or KMS refuses it ([PutKeyPolicy](https://docs.aws.amazon.com/kms/latest/APIReference/API_PutKeyPolicy.html), the lockout safety check). With the default `key_admin_role_arns = []` any administrator of the account qualifies.
- After it is on, a person can no longer run `--print-key-check` or `scripts/kms-live-check.ts` against the key: `GenerateMac` is denied to them. Record the key check value first (the test key's was recorded when it was created).
- The policy applies to this one key in this one Region. Each replica of a multi-Region key has its own key policy ([multi-Region keys](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html)); put the same policy on every replica.
- If the task role is ever deleted and created again, re-apply the key policy ([Not verified](#not-verified), item on role identifiers).

### Guardrails from DESIGN.md section 13

| Guardrail | Where | State |
|---|---|---|
| Key policy denies deletion and disabling | `pepper/kms.tf`, statement `NobodyDeletesOrDisables` | Written. Applied only with `manage_key_policy = true`. |
| Organisation-level deny | `policies/scp-protect-pepper-key.json` | Written. To be attached by the organisation's owner (below). |
| Alarm on any attempt | `pepper/audit.tf`, alarm `key-tampering-attempt` | Written. Notifies an SNS topic; set `alarm_email` or subscribe something to it. |
| CloudTrail logging of key use | `pepper/audit.tf` | Written. A multi-Region trail with all management events and log file validation. |
| Alerts on unusual volume | `pepper/audit.tf`, alarms `mac-volume` and `mac-by-other-principal` | Written. The threshold is a guess; tune it. |
| Multi-Region replicas | Not in Terraform | The test key is multi-Region; no replica is created here. |
| Maximum waiting period if deletion is scheduled | Not enforceable from here | The waiting period is 7 to 30 days, default 30 ([deleting keys](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html)); the denies make scheduling itself fail. |
| Account protection (root MFA, few admins, break-glass, billing) | Not in Terraform | Organisational. See "Not for production as is". |

On the audit trail: CloudTrail "logs all AWS KMS operations, including read-only operations", `GenerateMac` included, as management events ([logging KMS with CloudTrail](https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html), [GenerateMac example](https://docs.aws.amazon.com/kms/latest/developerguide/ct-generatemac.html)). The same page says failed calls are logged "in some scenarios ... such as when the caller is denied access", so the alarm on denied attempts should fire, but that is to be tested, not assumed (runbook step 9). The alarms follow AWS's documented pattern of a trail delivering to CloudWatch Logs with metric filters ([CloudWatch alarms for CloudTrail](https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudwatch-alarms-for-cloudtrail.html)). A CloudTrail record of `GenerateMac` holds the caller and the key, not the message or the MAC, per the linked example.

### The service control policies

Service control policies are attached from the management account, so they are JSON files here and not Terraform: this Terraform never needs management-account credentials.

- `policies/scp-protect-pepper-key.json` denies, to every principal in the account it is attached to: `kms:ScheduleKeyDeletion`, `kms:DisableKey`, `kms:DeleteImportedKeyMaterial` (does not apply to a KMS-generated key; included so the policy stays right if that ever changes), `organizations:LeaveOrganization`, and stopping or deleting CloudTrail trails. `Resource` is `*`: the account exists only for this key, and a wildcard also covers every replica Region.
- `policies/scp-restrict-key-policy-changes.template.json` (optional, needs two placeholders filled in) denies `kms:PutKeyPolicy`, `kms:CreateGrant` and `kms:UpdatePrimaryRegion` to everyone except one named break-glass role. Attach it only once that role exists and has been tested, and note that it also stops Terraform from managing the key policy unless Terraform runs as that role.

What a service control policy does and does not do ([SCPs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)): it restricts users and roles in member accounts "including the member account's root user"; it does not affect the management account; it does not affect service-linked roles; it grants nothing. `OrganizationAccountAccessRole` is a role in the member account, so the denies bind it.

For the organisation's owner, from the management account (commands shown for review; they were not run):

```sh
aws organizations create-policy --type SERVICE_CONTROL_POLICY \
  --name kamui-protect-pepper-key \
  --description "Deny deleting or disabling KMS keys in the pepper account" \
  --content file://policies/scp-protect-pepper-key.json
aws organizations attach-policy --policy-id <policy id from the previous command> \
  --target-id <id of the pepper account>
```

Service control policies must be enabled as a policy type in the organisation first. Attach to the pepper account only, not to an organisational unit that holds other accounts: the policy would stop key deletion there too. On the test account, attaching it is the rehearsal of the production guardrail; it also means the test key and the test trail cannot be deleted until it is detached.

## Logging

**The pepper service's own logs** go from the container's stdout to one CloudWatch Logs group (`/kamui/kamui-pepper`, 30 days by default). The service's log entry type is closed (`services/pepper/src/log.ts`): time, request id, outcome code, status, duration, issuer name, audience position, key version. There is no field for a body, a token, a `sub`, a pepper or a client address, and the service's tests check that. Nothing in this Terraform adds another log source for request content: no access logs, no tracing, no request logging at the load balancer, no ECS Exec.

**What the platform records regardless:**

- **Load balancer access logs: off.** They are "disabled by default" ([ALB access logs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html)) and the module has no `access_logs` block. If someone turns them on, each entry holds the client address and port, the request line (method, full URL including any query string), the user agent, TLS details and byte counts. None of the documented fields holds a request or response body. The pepper service's only useful URL is `POST /v1/pepper` with no query string, so the URL carries nothing private, but the client address next to a timestamp is personal data, and DESIGN.md question 8 (may client addresses be logged?) is still open. Leave them off until it is answered.
- **Load balancer metrics** in CloudWatch: request counts, status code counts, latencies. No addresses, no content.
- **CloudTrail:** API calls made in the account, including one record per `GenerateMac` (caller, key, time). Not the message or the result.
- **VPC flow logs: off.** Not configured. They would record addresses and ports.
- **ECS:** task start and stop events and the task definition, which holds the service's settings (audiences, allowed origins, the key ARN, the key check value). None is secret.
- **In transit:** TLS ends at the load balancer, inside the account. Between the load balancer and the task the request travels as plain HTTP inside the VPC. That is inside the trust boundary DESIGN.md asks for (AWS and the account's administrators), and it is stated here so nobody assumes end-to-end TLS to the process.

**The backend's logs** are not as tight. See [Observations](#observations-about-the-services).

## Secrets (backend)

Three Secrets Manager references (`backend/secrets.tf`): the relayer key, registry-owner key (used by the rotator), and RPC URL. The prover-account secret has been removed. API-only AVNU secret injection is still a hosting implementation gap; never pass it in plain Terraform environment variables.

- **Why Secrets Manager and not Parameter Store.** ECS can inject from either ([Secrets Manager](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html), [Parameter Store](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-ssm-paramstore.html)). Secrets Manager is the service built for this: a per-secret resource policy ([resource policies](https://docs.aws.amazon.com/secretsmanager/latest/userguide/auth-and-access_resource-policies.html)), a recovery window on deletion, and a rotation mechanism if one is wanted later. Parameter Store's standard tier would cost less; for this small set of secrets the difference is small, but check it.
- **How the value reaches the process.** The task definition names the secret's ARN under `secrets`. When the container starts, ECS reads the value with the service's **execution role** and sets it as an environment variable, which is where the backend reads it today. The value is not in the task definition, in Terraform variables or in Terraform state: Terraform creates the secrets empty and the values are put in by hand (runbook step 6).
- **Least privilege.** Each service has its own execution role, allowed `secretsmanager:GetSecretValue` on its own secrets only ([task execution role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html)). The rotator cannot read the relayer key. The task roles (the applications' own identities) have no permission at all.
- **Changing a secret.** A running container does not see a new value; "you must either launch a new task or ... force new deployment" (Secrets Manager page above).
- **Limits of this.** The key is still an environment variable inside the container and in the process's memory. Administrators of the account can read the secret. An environment variable is also visible to anything that can inspect the process.
- **The coming secret-source interface.** `services/backend/src/secrets.ts` now has a `SecretSource` interface with only an `env` implementation. This Terraform depends on none of it: it sets environment variables, which is the `env` source. If the backend later fetches secrets itself, the change here is to move `secretsmanager:GetSecretValue` from the execution role to the **task** role of that service and drop the `secrets` entries; `api_extra_environment` is there to pass whatever setting selects the source.

## Persistent storage (backend)

The backend stores a SQLite session registry and durable recovery journal at the path in `REGISTRY_DB`. On a container platform that means:

- A Fargate task's disk is gone when the task stops, and every deployment replaces the task. A registry on the task's own disk is emptied by every deployment.
- An EBS volume does not help on Fargate: volumes attached to a service's tasks "are always deleted upon task termination" ([EBS volumes with ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html)).
- What does persist is an EFS file system, supported on Fargate ([EFS volumes with ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/efs-volumes.html)).

**Proposed for the test deployment** (`backend/storage.tf`): one encrypted EFS file system, mounted in the api at `/data` through an access point that pins a user and a directory, reachable from the api's security group only, with AWS Backup's automatic backups turned on. `REGISTRY_DB=/data/registry.db`.

EFS support by Fargate does not establish SQLite locking or backup correctness. Single-writer/no-WAL is a prerequisite for the proposed bounded test, not a durability guarantee. Storage-owner review and crash/restore drills are required. The candidate settings are:

- the api runs as exactly one task (`api_desired_count` is validated to be at most 1);
- deployments stop the old task before starting the new one (minimum healthy 0 %, maximum 100 %), which means a short outage at every deployment;
- **the backend must not open the database in WAL mode.** This is a requirement on the code, not something Terraform can enforce.

Do not make recovery metadata ephemeral merely because session display data can be rebuilt: losing an unresolved paid intent loses the duplicate-send safeguard. Persist and restore both databases consistently. A production database migration needs a separate review, including writer fencing and reconciliation after stale restores.

## Container images

- **Stored in ECR,** one repository per image, in the account that runs it: `kamui-pepper` in the pepper account; `kamui-backend-api`, `-rotator` in the backend account. Tags are immutable ([tag immutability](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-tag-mutability.html)) and images are scanned on push. Each execution role can pull from its own repository only.
- **Built** on the operator's machine for now (or in CI once there is one), for `linux/amd64` unless `cpu_architecture` is changed, tagged with the commit hash.
- **Pepper:** `services/pepper/Dockerfile` was added with this work: two stages, base image pinned to `oven/bun:1.4.4-slim` (the version the service is developed on), runs as the unprivileged `bun` user, copies only `package.json`, the production dependencies and `src/`. A `.dockerignore` keeps `.env*` files out of the build context. **The image has not been built**; build it once before relying on it.
- **Backend:** the existing Dockerfiles under `services/backend/src/services/` are used unchanged, with `services/backend` as build context. The api and rotator images currently run as root and use the floating tag `oven/bun:1.4`; review non-root execution and pin the base digest. The immutable ECR tag fixes what runs; record the upstream digest next to it.

## State and credentials

**State.** One S3 bucket per account, created by `bootstrap/`, versioned, encrypted, private, TLS only. Each root module keeps its state there with S3's own lock file (`use_lockfile = true`, [Terraform S3 backend](https://developer.hashicorp.com/terraform/language/backend/s3); DynamoDB locking is deprecated there). Bucket names, account ids and ARNs go in `backend.hcl` and `terraform.tfvars`, which `.gitignore` here keeps out of git. The state holds no private key (the secrets are created empty) but does hold account ids, ARNs and, if set, the alarm e-mail address.

**Who applies.** Today the test accounts are reached with the CLI profiles that `../setup-test-access.sh` writes: an IAM user in the management account, with a long-lived access key, that can only assume `OrganizationAccountAccessRole` in the two test accounts; and that user was created with root access keys on the management account. Terraform would run as `OrganizationAccountAccessRole`, an administrator of the account, with for example `AWS_PROFILE=kamui-pepper-test`.

Plainly: **this is acceptable for a test and nothing else.** Root access keys on a management account are the most powerful credential the organisation has, and a long-lived user key on a laptop is the kind that leaks. What should replace it:

1. Delete the management account's root access keys; put hardware MFA on that root user and use it only for the tasks that need root.
2. Give people access through IAM Identity Center (or an equivalent federation) with short-lived credentials and MFA, and delete the `kamui-test-admin` user and its key.
3. Apply Terraform from a dedicated deployment role in each account, assumed through that federation or from CI by OIDC, with permissions scoped to what these modules manage, not `OrganizationAccountAccessRole`.
4. Keep `OrganizationAccountAccessRole` for break-glass only, or remove it from the pepper account once another administrative path exists, and alarm on its use.

Each provider block sets `allowed_account_ids`, so applying `pepper/` with the backend profile, or the reverse, stops before doing anything.

## Runbook

Commands are for the operator. None was run while writing this.

### Prerequisites

- Terraform 1.10 or later, Docker, the AWS CLI, and the two CLI profiles.
- The pepper key's ARN and its key check value.
- Two host names you control (one for the pepper service, one for the api) and an **issued** ACM certificate for each, in the account and Region of its load balancer. Requesting and validating them is not in this Terraform, because the domain is not something this repository should name.
- The existing Google client ID (Apple is optional and deferred), public relayer/registry-owner addresses, operator-supplied signing credentials through the approved secret mechanism, and an RPC URL. No prover-account key.
- A reviewer who owns AWS for the organisation has read this file and the plan output.

### Order

Pepper account first, because the backend needs the pepper service's URL.

1. **State bucket, each account.** In `bootstrap/`: `terraform init`, then `terraform apply` with the account id, Region and a bucket name. Do it once per account, keeping the two local states apart.
2. **Pepper, first apply.** In `pepper/`: copy the two `.example` files, fill them in, `terraform init -backend-config=backend.hcl`, `terraform plan`, read the plan, `terraform apply` with `deploy_service = false`. This creates the network, repository, load balancer, roles, trail and alarms, and starts nothing.
3. **DNS.** Point the pepper host name at the output `load_balancer_dns_name`.
4. **Image.** From the repository root:
   ```sh
   docker build --platform linux/amd64 -t <ecr_repository_url>:<commit> services/pepper
   aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <registry host>
   docker push <ecr_repository_url>:<commit>
   ```
5. **Pepper, second apply.** Set `deploy_service = true` and `image_tag = "<commit>"`, plan, apply. Verify (below).
6. **Backend, first apply,** the same way in `backend/` with `deploy_services = false`. Then put the four secret values in, without passing them on a command line or through shell history, for example:
   ```sh
   read -rs VALUE && aws secretsmanager put-secret-value --secret-id kamui-backend/relayer-private-key --secret-string "$VALUE"; unset VALUE
   ```
   and the same for `owner-private-key` and `rpc-url`. Build and push the API and rotator images (context `services/backend`, the Dockerfile of each service). Point the api host name at the load balancer.
7. **Backend, second apply** with `deploy_services = true`, the image tags and `pepper_service_url`. Verify.
8. **Key policy.** Review the output `key_policy_json` with the AWS owner. Then set `manage_key_policy = true` and apply. Verify the pepper service again: it must still start and answer.
9. **Test the guardrails.** As an administrator, try a `GenerateMac` on the key: it must be denied, and `mac-by-other-principal` must go into alarm within a few minutes. Try `DisableKey`: denied, and `key-tampering-attempt` alarms. If a denied call does not raise the alarm, the trail is not recording denials for that call; find out before relying on it.
10. **Service control policy.** Hand `policies/scp-protect-pepper-key.json` and the instructions above to the organisation's owner. After it is attached, repeat the `DisableKey` attempt.

### Verify

- **Pepper:** `curl -s https://<pepper host>/health` returns `{"status":"ok"}`. The log group shows a `kms_key` line and a `start` line at start-up and no error. If the task keeps restarting, the usual causes are a wrong `pepper_key_check` (the service refuses to start, by design), a key ARN in another Region, or no route to KMS.
- **api:** `curl -s https://<api host>/health/api` returns `{"ok":true,"chain":"SN_SEPOLIA",...,"pepper_service":true}`.
- **proving:** no cloud prover health check. Validate the pinned browser bundle and run an actual Kamui V2 proof/recovery as part of the Google pilot acceptance.
- **rotator:** `https://<api host>/health/rotator` returns `ok: true` once each issuer has synced.
- **End to end:** one login through the demo app against these URLs. A first login took about 60 s on a laptop. Recovery now uses short job-submission and status requests; the template's 600 s idle timeout is unchanged.
- `https://<api host>/metrics` must return 404 from the load balancer.

### Roll back

- **A bad image:** set the image tag back to the previous one and apply. Tags are immutable, so the old tag is the old image. A deployment whose tasks never become healthy is rolled back by ECS itself ([deployment circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html)); it "does nothing" on the very first deployment, which has nothing to return to.
- **A bad setting:** revert the variable and apply.
- **The key policy:** setting `manage_key_policy = false` removes the policy from Terraform. What the provider then leaves on the key was not checked ([Not verified](#not-verified)); read the plan, and afterwards read the key's policy. A wrong policy can also be corrected directly with `kms:PutKeyPolicy` by a key administrator.
- **Stop everything without deleting anything:** `deploy_service(s) = false` and apply.

### Tear down

1. `deploy_services = false`, plan and apply only through the approved operator process.
2. `terraform destroy` in `backend/`, then `pepper/`. It will stop on things that are protected on purpose, and each needs a deliberate step:
   - the registry file system and the state bucket have `prevent_destroy`;
   - ECR repositories that still hold images, and the trail bucket while it holds logs, are not deleted;
   - if the service control policy is attached, the trail cannot be deleted until it is detached;
   - secrets stay recoverable for 7 days and their names cannot be reused until then.
3. With `manage_key_policy = true`, destroying `pepper/` also removes the key policy resource; see the roll-back note. Check the key's policy afterwards.

### What must not be torn down casually

**The KMS key.** `terraform destroy` cannot delete it and nothing in this directory can. For the test key, deletion only loses the test accounts that were created with it. For a production key it ends social recovery for every account, permanently, and cannot be undone (DESIGN.md section 13). Also:

- **The pepper account itself.** Closing the account makes its keys inaccessible ([deleting keys](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html)); after the 90-day post-closure period AWS deletes the account's resources ([closing an account](https://docs.aws.amazon.com/accounts/latest/reference/manage-acct-closing.html)). A service control policy cannot stop the management account from closing it.
- **The key's replicas** in other Regions.
- **The task role,** once the key policy names it.
- **The audit trail and its bucket,** which are the record of who used the key.

## Cost

No prices are given here: they change and differ by Region. The things that are billed, to price with the AWS calculator before applying, and again afterwards against the first bill:

| Item | Quantity | Billed by |
|---|---|---|
| Prover task | 8 vCPU, 24 GB, every hour it runs | vCPU-hours and GB-hours |
| api, rotator, pepper tasks | 0.5 + 0.25 + 0.25 vCPU; 1 + 0.5 + 0.5 GB, always on | the same |
| NAT gateway | 2 (one per account) | hours, plus GB processed (image pulls go through it) |
| Load balancer | 2 | hours, plus capacity units |
| Public IPv4 addresses | NAT and load balancer addresses | per address-hour |
| Secrets | 4 | per secret-month, plus API calls |
| KMS key | 1 (plus replicas) | per key-month, plus requests |
| CloudWatch Logs, CloudTrail copy, S3, EFS, ECR | small volumes | GB ingested and stored |

There is no hosted proving compute charge. Price the remaining fixed ALB/NAT/service overhead and the browser bundle transfer separately using the revised worksheet in [HOSTING_REVIEW.md](HOSTING_REVIEW.md).

## Observations about the services

For the engineers who own them. None was changed.

**Pepper service**

- All of the backend's confirmations arrive from one address (the backend's NAT gateway) and share one per-address bucket (`RATE_IP_*`, 30 a minute by default). Fine for a test; under load the backend would be rate limited as one client. An internal authenticated path for the backend, as DESIGN.md section 8 suggests, would remove it.
- The process does not handle `SIGTERM`. ECS stops tasks with `SIGTERM` and then kills them; an in-flight request during a deployment may be cut. Not checked whether Bun exits on `SIGTERM` by default.
- `/health` does not touch KMS, so a task whose KMS access broke after start-up still looks healthy. The start-up check does catch a wrong key or policy at deploy time.
- With more than one task, the per-user limit multiplies by the number of tasks.
- Configuration by environment variables and a closed log type made this the easy one to host.

**Backend**

- Client-address handling supports `TRUSTED_PROXY_HOPS`; the target keychain/ALB chain must be implemented and spoof-tested before choosing its value.
- Logs are closed JSON codes; request bodies, client IPs, JWTs, pepper, signatures and proof bytes must remain absent. Review deployed samples and edge logs rather than assuming every failure path is safe.
- `/metrics` is on a separate internal listener by default. Public path denials and internal scraper routing need acceptance in the final topology.
- Public `/recover` server proving and legacy `/deploy` are disabled. `/deploy/authenticated` and `/relay` return durable jobs polled through `/recover/status`. No API prover account or prover URL is loaded.
- Persist `registry.db` and `recovery.sqlite`; journaled unknown submissions stay locked. See [RECOVERY-JOBS.md](../../../services/backend/RECOVERY-JOBS.md). Use explicit stop/wait/start to avoid overlapping API writers, including during rollback.
- `CHAIN_ID` can permit startup before RPC confirmation; the current template must supply it and verify background wrong-chain behavior before a pilot.
- Class/registry/executor addresses in `deployments.env` are public build inputs; explicit environment values override them. Keychain packaging must use public-only config rather than reading backend env files.
- One relayer account instance in one API process coordinates local nonces. Separate processes using the same key need additional coordination; there is no shared distributed lock.

## Not for production as is

A production deployment needs at least the following beyond what is here.

- **Separate production accounts and a separate key.** A new pepper key per network, created with the guardrails in place before any account depends on it, with replicas in other Regions, the key policy on every replica, and a rehearsed failover. Never the test key, never the test accounts.
- **The guardrails actually attached and tested:** the service control policy on the pepper account, the key policy applied, the alarms delivered to people who are on call, and a test that each one fires.
- **No root keys, no long-lived user keys.** See "State and credentials". Hardware MFA on every root user, break-glass access written down and tested, billing and contact details that cannot lapse.
- **A narrower key administrator.** `key_admin_role_arns` set to a dedicated role, the second service control policy attached, and a decision on whether `OrganizationAccountAccessRole` stays in the pepper account.
- **Audit that the account's own administrators cannot switch off:** an organisation trail delivered to a separate log-archive account, with retention decided. The backend account has no trail at all in this Terraform.
- **The relayer key out of process memory.** Secrets Manager keeps it out of files, not out of the process. `services/backend/src/secrets.ts` describes the stronger option (a signer service). Also a spending limit and balance alarm on the relayer account.
- **WAF or an equivalent** in front of both load balancers, and rate limiting at the edge, since both services limit per process.
- **Backups and alarms:** alarms on service health, task restarts, 5xx rates, submission age/error counts, rotator sync failures, relayer balance; a tested restore of the registry.
- **A database service** for the session registry, which also lifts the one-task limit on the api.
- **High availability:** more than one task per service, more than one NAT gateway, and verified browser proving availability/resource behavior. All of this is single-instance today.
- **A permanent domain for the keychain** and for both services, owned and renewed by the organisation, with certificates managed in code. The pepper service's allowed origin and the OAuth client configuration depend on it, and it cannot change casually afterwards.
- **Private connectivity or authentication** between the backend and the pepper service, instead of the backend calling it as an anonymous internet client.
- **Narrower outbound rules:** tasks can connect to any address on port 443. VPC endpoints for AWS services and an egress allow-list would narrow it.
- **A deployment pipeline** that builds images from a commit, records digests, and applies Terraform with a scoped role after review; base images pinned by digest; the complete Worker/Wasm bundle pinned to a reviewed compatible profile.
- **Decisions still open in DESIGN.md:** log retention and whether client addresses may be logged, who administers the pepper account, who approves changes to the audience list.
- **Review by whoever owns AWS for the organisation,** of every file here, before anything is applied, and a legal and privacy review of the logging and data-location choices before production.

## Not verified

AWS facts this work relies on that were **not** checked against documentation, or only partly.

- That a `Deny` in a key policy, and the absence of an allow, bind the account's **root user**. The documentation checked says the account and its identities get nothing automatically; it was not checked for the root user by name.
- That removing the `aws_kms_key_policy` resource leaves or resets the key policy in any particular way.
- That a key policy naming a role as principal stops matching if the role is deleted and recreated (IAM stores the role's internal id). From memory.
- That **denied** KMS calls reach CloudTrail in every case the alarms care about. The documentation says "in some scenarios".
- The CloudWatch Logs filter syntax in `pepper/audit.tf`, in particular how `!=` behaves when the field is absent from a record (it may make `mac-by-other-principal` miss or over-match some callers). Test it in step 9.
- That `kms:DeleteImportedKeyMaterial`, `kms:UpdatePrimaryRegion` and the other action names in the policies are spelled as IAM expects, and that every action listed in the key policy's administration statement is valid there. A wrong name makes `PutKeyPolicy` fail, not silently pass.
- The CloudTrail bucket policy and the `aws:SourceArn` conditions on it. Written from memory of the documented pattern.
- The load balancer's **default idle timeout** (60 s, from memory) and that 600 s is an accepted value.
- That the TLS policy name `ELBSecurityPolicy-TLS13-1-2-2021-06` is current.
- That an ALB **never** logs request bodies: no documented access-log field holds one, but no sentence says so. That an ALB has no default HTTPS certificate: implied by the certificate requirement, not stated.
- That ECS Exec is off by default; the service sets it to `false` explicitly either way.
- That the Terraform version that introduced `use_lockfile` is 1.10 (`required_version` assumes it).
- SQLite/EFS crash, locking and application-consistent backup/restore behavior under the proposed runtime; single-writer/no-WAL settings do not prove durability.
- That Bun in the container picks up the task role's credentials through the AWS SDK's default chain, and that Bun exits cleanly on `SIGTERM`. The KMS path has only run from a laptop with a profile.
- That an EFS access point's user (uid 1000) works with the api image running as root, and that the task can mount it with the security group rules given.
- That Secrets Manager secrets encrypted with the AWS managed key need no KMS permission on the execution role. The documentation checked lists `kms:Decrypt` only for customer managed keys, under a neighbouring heading.
- That a task definition accepts the `secrets` and `environment` combination used here with the same variable name absent from both (it should; untested).
- Everything about **cost**. No price was looked up.
- App Runner: the page says it is closed to new customers but gives no date, and whether an account in an organisation with an existing customer counts as new was not checked.
- The whole configuration against a real account: `terraform validate` checks syntax and types, not whether AWS accepts the values.

This document describes security controls. Have the person who owns AWS for the organisation verify it before relying on it, and have legal and privacy review the logging and data-handling statements before production.
