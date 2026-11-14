# GitHub Actions reaches this account through OIDC: each job exchanges a short-lived GitHub
# token for short-lived AWS credentials. No AWS access key is created or stored in GitHub.
#
# Three roles, so a job holds only what it needs:
#   plan    - read-only, for pull requests from this repository
#   apply   - may change what the Terraform modules manage, from the apply branch only
#   publish - may push release images to the existing ECR repositories (backend account only)
#
# Apply this module with an administrative session. Applying it from CI would let CI widen its
# own access.

locals {
  oidc_host = "token.actions.githubusercontent.com"
  oidc_arn  = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  # GitHub's subject starts with repo:owner/name, or, with immutable subjects turned on for the
  # repository, repo:owner@<id>/name@<id>. Both name this one repository; trust whichever is set.
  subject_prefixes = compact(["repo:${var.github_repository}", var.github_immutable_subject_prefix])
  subject_any      = [for prefix in local.subject_prefixes : "${prefix}:*"]
  # A job gets the apply or publish role only from the chosen branch, and, when an environment is
  # named, only while running in it. Matching on the repository alone would let any branch or any
  # fork's pull request in.
  subject_apply = [for prefix in local.subject_prefixes : (var.apply_environment == "" ?
  "${prefix}:ref:refs/heads/${var.apply_branch}" : "${prefix}:environment:${var.apply_environment}")]
  prefix = "${var.name}-${var.service}-gha"
}

# GitHub publishes the thumbprint-free configuration AWS now verifies against its own trust
# store, so no certificate fingerprint is pinned here.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]

  lifecycle {
    prevent_destroy = true
  }
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://${local.oidc_host}"
}

data "aws_iam_policy_document" "trust_plan" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Any ref of this repository, including pull requests, may read.
    condition {
      test     = "StringLike"
      variable = "${local.oidc_host}:sub"
      values   = local.subject_any
    }
  }
}

data "aws_iam_policy_document" "trust_write" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = local.subject_apply
    }
  }
}

# --- What CI may never do --------------------------------------------------------------------

# Attached to every role, including plan. A deny here beats any allow, in this module or a later
# one, so widening a role's allow list cannot quietly reach these.
data "aws_iam_policy_document" "guardrail" {
  # Long-lived credentials and new identities. CI authenticates per job and must not mint
  # anything that outlives the job or that could re-enter the account another way.
  statement {
    effect = "Deny"
    actions = [
      "iam:CreateUser", "iam:DeleteUser", "iam:UpdateUser", "iam:CreateAccessKey",
      "iam:UpdateAccessKey", "iam:CreateLoginProfile", "iam:UpdateLoginProfile",
      "iam:CreateSAMLProvider", "iam:UpdateSAMLProvider", "iam:CreateOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint", "iam:DeleteOpenIDConnectProvider",
      "iam:AttachUserPolicy", "iam:PutUserPolicy",
    ]
    resources = ["*"]
  }

  # CI must not edit the roles that define CI's own access.
  statement {
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy",
      "iam:DeleteRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRole", "iam:UpdateRole",
    ]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/${local.prefix}-*"]
  }

  # The lean Sepolia deployment is driven by operator-run scripts over CloudFormation and SSM,
  # with crash-safe private state on the operator's machine. CI has no part in it: it must not
  # change those stacks, run commands on a host, or open a session to one.
  statement {
    effect = "Deny"
    actions = [
      "cloudformation:*", "ssm:SendCommand", "ssm:StartSession", "ssm:TerminateSession",
      "ec2:TerminateInstances", "ec2:StopInstances", "ec2:RebootInstances",
    ]
    resources = ["*"]
  }

  # Account-level and organisational settings.
  statement {
    effect    = "Deny"
    actions   = ["organizations:*", "account:*", "iam:*AccountPasswordPolicy", "s3:DeleteBucket"]
    resources = ["*"]
  }

  # Release images are immutable and auditable. CI may add them; removing one is an operator's
  # decision.
  statement {
    effect    = "Deny"
    actions   = ["ecr:DeleteRepository", "ecr:BatchDeleteImage", "ecr:DeleteRepositoryPolicy", "ecr:PutImageTagMutability"]
    resources = ["*"]
  }

  # Keys an operator owns, including the live pepper HMAC key whose policy pepper/kms.tf
  # manages. An apply that needs to change these is run by hand.
  dynamic "statement" {
    for_each = length(var.protected_kms_key_arns) > 0 ? [1] : []
    content {
      effect = "Deny"
      actions = [
        "kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:DisableKey", "kms:DeleteAlias",
        "kms:DisableKeyRotation", "kms:CreateGrant", "kms:RevokeGrant",
      ]
      resources = var.protected_kms_key_arns
    }
  }
}

resource "aws_iam_policy" "guardrail" {
  name        = "${local.prefix}-guardrail"
  description = "Actions no GitHub Actions role in this account may take, whatever else allows them."
  policy      = data.aws_iam_policy_document.guardrail.json
}

# --- State ------------------------------------------------------------------------------------

# Both plan and apply need the state object and, with S3 native locking, the lock object beside
# it. Access stops at the listed key prefixes.
data "aws_iam_policy_document" "state" {
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.state_bucket_name}"]
  }
  statement {
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = [
      for prefix in var.state_key_prefixes : "arn:aws:s3:::${var.state_bucket_name}/${prefix}*"
    ]
  }
}

resource "aws_iam_policy" "state" {
  name        = "${local.prefix}-state"
  description = "Read and write this account's Terraform state and its lock."
  policy      = data.aws_iam_policy_document.state.json
}

# --- Plan ---------------------------------------------------------------------------------------

resource "aws_iam_role" "plan" {
  name                 = "${local.prefix}-terraform-plan"
  description          = "Read-only. Any ref of ${var.github_repository} may assume it to run terraform plan."
  assume_role_policy   = data.aws_iam_policy_document.trust_plan.json
  max_session_duration = 3600
}

# A plan reads the whole surface the modules manage; it changes nothing. ReadOnlyAccess covers
# the services in this tree without listing every Describe and Get by hand, and it grants no
# write anywhere.
resource "aws_iam_role_policy_attachment" "plan_read" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy_attachment" "plan_state" {
  role       = aws_iam_role.plan.name
  policy_arn = aws_iam_policy.state.arn
}

resource "aws_iam_role_policy_attachment" "plan_guardrail" {
  role       = aws_iam_role.plan.name
  policy_arn = aws_iam_policy.guardrail.arn
}

# ReadOnlyAccess can read object and secret contents. A plan needs neither, and this account's
# secrets hold signing material, so take those back.
data "aws_iam_policy_document" "plan_no_secret_values" {
  statement {
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "kms:Decrypt"]
    resources = ["*"]
  }
  # Release artifacts and state are the only objects a plan reads.
  statement {
    effect        = "Deny"
    actions       = ["s3:GetObject"]
    not_resources = ["arn:aws:s3:::${var.state_bucket_name}/*"]
  }
}

resource "aws_iam_role_policy" "plan_no_secret_values" {
  name   = "no-secret-values"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan_no_secret_values.json
}

# --- Apply ----------------------------------------------------------------------------------------

resource "aws_iam_role" "apply" {
  name                 = "${local.prefix}-terraform-apply"
  description          = "Changes what this tree's Terraform modules manage, from ${var.apply_branch} only."
  assume_role_policy   = data.aws_iam_policy_document.trust_write.json
  max_session_duration = 3600
}

# Scoped to the services the committed modules actually use (see the README's table). Adding a
# resource type to a module means adding its actions here; the apply then fails loudly on a
# missing permission rather than CI holding standing access it does not need.
data "aws_iam_policy_document" "apply" {
  statement {
    sid    = "NetworkComputeAndDelivery"
    effect = "Allow"
    actions = [
      "ec2:*Vpc*", "ec2:*Subnet*", "ec2:*RouteTable*", "ec2:*Route", "ec2:*InternetGateway*",
      "ec2:*NatGateway*", "ec2:*Address*", "ec2:*SecurityGroup*", "ec2:*Tags",
      "ec2:Describe*", "ecs:*", "elasticloadbalancing:*", "servicediscovery:*",
      "elasticfilesystem:*", "logs:*", "cloudwatch:*", "sns:*", "cloudtrail:*",
      "ecr:Describe*", "ecr:List*", "ecr:GetRepositoryPolicy", "ecr:CreateRepository",
      "ecr:TagResource", "ecr:PutLifecyclePolicy", "ecr:SetRepositoryPolicy",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "BucketsTheModulesManage"
    effect = "Allow"
    actions = [
      "s3:CreateBucket", "s3:Get*", "s3:List*", "s3:Put*", "s3:DeleteObject",
      "s3:DeleteBucketPolicy",
    ]
    resources = ["*"]
  }

  # Secret containers only. Setting a secret's value stays outside Terraform (see
  # backend/secrets.tf), so CI never needs to read or write one.
  statement {
    sid       = "SecretContainersNotValues"
    effect    = "Allow"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:TagResource", "secretsmanager:DeleteSecret", "secretsmanager:UpdateSecret"]
    resources = ["*"]
  }

  # Roles and policies for the services the modules deploy, under their own name prefix, never
  # the CI roles themselves (the guardrail denies those).
  statement {
    sid    = "ServiceRoles"
    effect = "Allow"
    actions = [
      "iam:CreateRole", "iam:DeleteRole", "iam:UpdateRole", "iam:GetRole", "iam:ListRole*",
      "iam:TagRole", "iam:PassRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy",
      "iam:GetRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy",
      "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy*", "iam:ListPolicy*",
      "iam:CreateServiceLinkedRole",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${var.name}-*",
      "arn:aws:iam::${var.aws_account_id}:policy/${var.name}-*",
      "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/*",
    ]
  }

  statement {
    sid       = "ReadKeyMetadata"
    effect    = "Allow"
    actions   = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListAliases", "kms:ListResourceTags"]
    resources = ["*"]
  }

  statement {
    sid       = "WhoAmI"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity", "iam:ListAccountAliases"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "apply" {
  name   = "terraform-apply"
  role   = aws_iam_role.apply.id
  policy = data.aws_iam_policy_document.apply.json
}

resource "aws_iam_role_policy_attachment" "apply_state" {
  role       = aws_iam_role.apply.name
  policy_arn = aws_iam_policy.state.arn
}

resource "aws_iam_role_policy_attachment" "apply_guardrail" {
  role       = aws_iam_role.apply.name
  policy_arn = aws_iam_policy.guardrail.arn
}

# --- Publish ------------------------------------------------------------------------------------------

# Only the backend account holds the release registry.
resource "aws_iam_role" "publish" {
  count = length(var.release_repository_names) > 0 ? 1 : 0

  name                 = "${local.prefix}-ecr-publish"
  description          = "Pushes release images to the existing ECR repositories, from ${var.apply_branch} only."
  assume_role_policy   = data.aws_iam_policy_document.trust_write.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "publish" {
  count = length(var.release_repository_names) > 0 ? 1 : 0

  # The login token is not resource-scoped in ECR's API.
  statement {
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart", "ecr:BatchGetImage", "ecr:DescribeImages",
      "ecr:DescribeRepositories", "ecr:GetDownloadUrlForLayer",
    ]
    resources = [
      for repository in var.release_repository_names :
      "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/${repository}"
    ]
  }
}

resource "aws_iam_role_policy" "publish" {
  count = length(var.release_repository_names) > 0 ? 1 : 0

  name   = "ecr-publish"
  role   = aws_iam_role.publish[0].id
  policy = data.aws_iam_policy_document.publish[0].json
}

resource "aws_iam_role_policy_attachment" "publish_guardrail" {
  count = length(var.release_repository_names) > 0 ? 1 : 0

  role       = aws_iam_role.publish[0].name
  policy_arn = aws_iam_policy.guardrail.arn
}
