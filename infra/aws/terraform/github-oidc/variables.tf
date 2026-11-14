# No variable here holds a secret. GitHub authenticates with a short-lived OIDC token; no AWS
# access key is created, stored in GitHub, or held in Terraform state.

# --- Where ---------------------------------------------------------------------------------

variable "aws_account_id" {
  description = "Id of the account this is applied in. Terraform refuses to run against any other account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "aws_region" {
  type = string
}

variable "environment" {
  type    = string
  default = "test"
}

variable "service" {
  description = "Which account this is: backend or pepper. Only the backend account holds the release registry."
  type        = string
  validation {
    condition     = contains(["backend", "pepper"], var.service)
    error_message = "service must be backend or pepper."
  }
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "kamui"
}

# --- Who may assume these roles --------------------------------------------------------------

variable "github_repository" {
  description = "The only repository whose workflows may assume these roles, as owner/name."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be owner/name."
  }
}

variable "github_immutable_subject_prefix" {
  description = <<-EOT
    The subject prefix GitHub sends when the repository uses immutable OIDC subjects, as
    repo:owner@<owner id>/name@<repository id> (gh api repos/<owner>/<name>/actions/oidc/customization/sub
    shows it as sub_claim_prefix). Empty when the repository uses the default subject.
  EOT
  type        = string
  default     = ""
  validation {
    condition     = var.github_immutable_subject_prefix == "" || can(regex("^repo:[A-Za-z0-9._-]+@[0-9]+/[A-Za-z0-9._-]+@[0-9]+$", var.github_immutable_subject_prefix))
    error_message = "github_immutable_subject_prefix must be repo:owner@<id>/name@<id>, or empty."
  }
}

variable "apply_branch" {
  description = "The only branch whose workflows may assume the apply and publish roles."
  type        = string
  default     = "main"
}

variable "apply_environment" {
  description = <<-TEXT
    Optional GitHub Environment name. When set, the apply and publish roles additionally require
    the job to run in that environment, so GitHub's own reviewers gate the credential itself and
    not merely the workflow step. Leave empty to trust the branch alone.
  TEXT
  type        = string
  default     = ""
}

variable "create_oidc_provider" {
  description = <<-TEXT
    An account may hold only one provider for token.actions.githubusercontent.com. Set false when
    the account already has one, and it is read instead of created. Terraform then never changes
    a provider another stack owns.
  TEXT
  type        = bool
  default     = true
}

# --- What the roles may reach ----------------------------------------------------------------

variable "state_bucket_name" {
  description = "State bucket created by ../bootstrap in this account. CI reads and writes only the state keys below."
  type        = string
}

variable "state_key_prefixes" {
  description = "State object keys CI may read and write, as prefixes (S3 native locking writes a lock object beside them)."
  type        = list(string)
  default     = ["backend/", "pepper/", "github-oidc/"]
}

variable "release_repository_names" {
  description = <<-TEXT
    ECR repositories the publish role may push to. These are created and owned by the lean
    release CloudFormation stack, not by Terraform; this only grants access to them. Empty in the
    pepper account, which holds no registry.
  TEXT
  type        = list(string)
  default     = []
}

variable "protected_kms_key_arns" {
  description = <<-TEXT
    Keys whose policy and lifecycle CI may never change, even though a Terraform module in this
    tree manages one of them (pepper/kms.tf manages the live pepper HMAC key's policy). An apply
    that would touch these must be run by an operator, not by CI.
  TEXT
  type        = list(string)
  default     = []
}
