# Access to the pepper key. Two documents:
#
#   1. the IAM policy of the service's task role: GenerateMac and DescribeKey on the one key;
#   2. the KEY POLICY, which decides who can use the key at all.
#
# The key itself is not a Terraform resource. It already exists, Terraform never creates or
# deletes it, and `terraform destroy` here cannot remove it.

# --- 1. What the service may do ------------------------------------------------------------

data "aws_iam_policy_document" "service_kms" {
  statement {
    sid       = "UseThePepperKey"
    actions   = ["kms:GenerateMac", "kms:DescribeKey"]
    resources = [var.kms_key_arn]
  }
}

# The only policy on the task role. The execution role (image pull, logs) has no KMS permission.
resource "aws_iam_role_policy" "service_kms" {
  name   = "use-pepper-key"
  role   = module.service.task_role_name
  policy = data.aws_iam_policy_document.service_kms.json
}

# --- 2. The key policy ---------------------------------------------------------------------
#
# How KMS decides: a principal can use a key only if the KEY POLICY allows it, either directly
# or by naming the account ("arn:aws:iam::<account>:root"), which hands the decision to IAM
# policies in the account. The policy KMS writes by default gives the account kms:*, so any
# role with a broad IAM policy (OrganizationAccountAccessRole has administrator permissions)
# can call GenerateMac. This policy does not do that.
#
# Read with the README section "The key policy" before setting manage_key_policy = true.

locals {
  account_root = "arn:aws:iam::${var.aws_account_id}:root"
  key_admins   = length(var.key_admin_role_arns) > 0 ? var.key_admin_role_arns : [local.account_root]
}

data "aws_iam_policy_document" "pepper_key" {
  # Administration only: look at the key, change its policy and tags, manage replicas, undo a
  # disable or a scheduled deletion. Deliberately absent: kms:GenerateMac, kms:VerifyMac,
  # kms:CreateGrant, kms:ScheduleKeyDeletion, kms:DisableKey.
  #
  # When the principal is the account (the default), IAM policies in the account decide who
  # gets these actions, and nobody gets more than is listed here whatever their IAM policy
  # says. kms:PutKeyPolicy must stay with someone, or the key becomes unmanageable; whoever has
  # it can rewrite this policy, which is why changes to it raise an alarm (audit.tf).
  statement {
    sid    = "AdministerWithoutUse"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = local.key_admins
    }
    actions = [
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:ListKeyPolicies",
      "kms:ListGrants",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateKeyDescription",
      "kms:EnableKey",
      "kms:CancelKeyDeletion",
      "kms:ReplicateKey",
      "kms:UpdatePrimaryRegion",
      "kms:RevokeGrant",
      "kms:RetireGrant",
    ]
    resources = ["*"]
  }

  # The one principal that may use the key: the service's task role.
  statement {
    sid    = "ServiceComputesMacs"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [module.service.task_role_arn]
    }
    actions   = ["kms:GenerateMac", "kms:DescribeKey"]
    resources = ["*"]
  }

  # Belt and braces. Nothing above allows anyone else to compute a MAC, but an explicit Deny
  # also wins over any Allow added later by mistake (in this policy or through a grant).
  # aws:PrincipalArn is the role's ARN for a task running as that role.
  statement {
    sid    = "NobodyElseComputesMacs"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["kms:GenerateMac"]
    resources = ["*"]
    condition {
      test     = "ArnNotEquals"
      variable = "aws:PrincipalArn"
      values   = [module.service.task_role_arn]
    }
  }

  # Not needed by anyone: verifying a MAC is a way to test guesses against the key, and a
  # grant is a way to hand out use of the key without touching this policy.
  statement {
    sid    = "NoVerifyNoGrants"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["kms:VerifyMac", "kms:CreateGrant"]
    resources = ["*"]
  }

  # DESIGN.md section 13: deletion and disabling are denied to everyone at the key itself.
  # The organisation's service control policy (../policies/) denies the same from above.
  # To delete a TEST key, this statement has to be removed first (a kms:PutKeyPolicy call,
  # which is logged and raises the alarm). That is intended.
  statement {
    sid    = "NobodyDeletesOrDisables"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["kms:ScheduleKeyDeletion", "kms:DisableKey"]
    resources = ["*"]
  }
}

# Off by default. When on, this REPLACES the key's current policy. Terraform's caller must be
# one of the key administrators above, or KMS refuses the change (its lockout safety check).
resource "aws_kms_key_policy" "pepper" {
  count  = var.manage_key_policy ? 1 : 0
  key_id = var.kms_key_arn
  policy = data.aws_iam_policy_document.pepper_key.json
}
