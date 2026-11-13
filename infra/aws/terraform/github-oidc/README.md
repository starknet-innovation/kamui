# GitHub Actions access to AWS

**Written for review; not applied.** This module lets workflows in one GitHub repository get
short-lived AWS credentials through OIDC. No AWS access key is created, stored in GitHub, or held
in Terraform state. Nothing here was applied to an account while it was written.

Apply it once per account with an administrative session. Do not apply it from CI: it is what
defines CI's access, so letting CI apply it would let CI widen its own permissions.

## What it creates

| Role | Who may assume it | What it may do |
|---|---|---|
| `kamui-<service>-gha-terraform-plan` | any ref of the repository, pull requests included | Read the account, read and write Terraform state. Cannot read secret values or object contents outside the state bucket. |
| `kamui-<service>-gha-terraform-apply` | the apply branch only, or a named GitHub Environment | Change what the modules in this tree manage. |
| `kamui-<service>-gha-ecr-publish` | the apply branch only, or a named GitHub Environment | Push images to the listed ECR repositories. Backend account only. |

Trust is matched on the full `sub` claim, so another repository, another branch, or a fork's pull
request cannot assume the write roles. Setting `apply_environment` makes GitHub's reviewers gate
the credential itself rather than only the workflow step; prefer it.

## What no role may do

A guardrail policy is attached to all three, and a deny beats any allow — including one added by a
later change to this module:

- create IAM users, access keys or login profiles, or add identity providers;
- edit the CI roles themselves;
- touch CloudFormation, run `ssm:SendCommand`, open a session to a host, or stop or terminate an
  instance. **The live Sepolia deployment is driven by the operator-run lean scripts over
  CloudFormation and SSM, with crash-safe private state on the operator's machine. CI has no part
  in it;**
- delete a repository or an image, or make image tags mutable;
- change the policy or lifecycle of a key listed in `protected_kms_key_arns`. **`pepper/kms.tf`
  manages the policy of the live pepper HMAC key. An apply that would change it must be run by an
  operator, not by CI**, so list that key when applying this in the pepper account;
- delete a bucket, or change organisation or account settings.

## What the apply role is scoped to

The allow list covers the services the committed modules use: VPC and networking, ECS, load
balancing, service discovery, EFS, logs, CloudWatch, SNS, CloudTrail, S3, ECR repository
settings, secret containers (never their values), and IAM roles and policies whose names start
with the `name` prefix. Adding a resource type to a module means adding its actions here. The
apply then fails on a missing permission, which is the intended direction: CI holds no standing
access it does not need.

## Before you apply

1. The state bucket for the account exists (`../bootstrap`).
2. Decide whether this account already has a provider for `token.actions.githubusercontent.com`.
   An account may hold only one; set `create_oidc_provider = false` in the second one if another
   stack already created it.
3. In the pepper account, put the live pepper key's ARN in `protected_kms_key_arns`.

```sh
cd infra/aws/terraform/github-oidc
cp backend.hcl.example backend.hcl            # fill in; both are ignored by git
cp terraform.tfvars.example terraform.tfvars
terraform init -backend-config=backend.hcl
terraform plan    # review every statement before applying
terraform apply
```

Then set these as repository **variables** (not secrets; none is sensitive, and a variable is
visible in the log, which is what you want for an ARN):

| Variable | From |
|---|---|
| `AWS_BACKEND_ACCOUNT_ID`, `AWS_PEPPER_ACCOUNT_ID` | the two accounts |
| `AWS_BACKEND_STATE_BUCKET`, `AWS_PEPPER_STATE_BUCKET` | `../bootstrap` |
| `AWS_BACKEND_PLAN_ROLE_ARN`, `AWS_PEPPER_PLAN_ROLE_ARN` | `plan_role_arn` |
| `AWS_BACKEND_APPLY_ROLE_ARN`, `AWS_PEPPER_APPLY_ROLE_ARN` | `apply_role_arn` |
| `AWS_BACKEND_PUBLISH_ROLE_ARN` | `publish_role_arn` |

Create the GitHub Environments `aws-backend-apply` and `aws-pepper-apply` with required
reviewers, since the apply and publish workflows wait on them.

## The workflows

- `.github/workflows/terraform.yml` — plans every root module on a pull request. Applying is a
  manual run, not something a merge does: **this tree still describes the retired Fargate design,
  while the live Sepolia deployment is the lean package.** Applying `backend/` or `pepper/` would
  create or change real infrastructure the lean deployment does not use. Point apply at a root
  module only when you mean it.
- `.github/workflows/images.yml` — builds the images on a pull request and, on a manual run,
  pushes them as `ci-<sha>`. **This is not a release.** `infra/aws/lean/setup/07-build-release.sh`
  remains the only thing that produces an installable one; it pins base images by digest, verifies
  the prover assets, records the keychain's `main.js` hash and writes the private release record
  that scripts 08 to 10 read. No host will install a `ci-` image.

## Not covered here

Runtime secret delivery to the hosts. The lean design keeps database passwords and the relayer
signing key in private local files and never uploads them, so moving them into AWS is a separate
change to both the host package and the host roles, and needs its own review.
