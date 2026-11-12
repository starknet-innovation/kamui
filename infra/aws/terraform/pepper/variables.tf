# None of these is a secret. The pepper key stays in AWS KMS; the service has no other secret.

# --- Where ---------------------------------------------------------------------------------

variable "aws_account_id" {
  description = "Id of the pepper account (kamui-pepper-test). Terraform refuses to run against any other account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "aws_region" {
  description = "Region to deploy in. Must be the Region of the key in kms_key_arn."
  type        = string
}

variable "environment" {
  type    = string
  default = "test"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "kamui-pepper"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

# --- Rollout -------------------------------------------------------------------------------

variable "deploy_service" {
  description = "false on the first apply (creates the repository, network, roles, audit trail); true once an image has been pushed and image_tag is set."
  type        = bool
  default     = false
}

variable "image_tag" {
  description = "Tag of the image in the ECR repository this module creates. Tags are immutable; use a commit hash."
  type        = string
  default     = "unset"
}

variable "desired_count" {
  description = "Number of tasks. Rate limits and the JWKS cache are per process, so more than one weakens the per-user limit."
  type        = number
  default     = 1
}

variable "cpu" {
  type    = number
  default = 256
}

variable "memory" {
  type    = number
  default = 512
}

variable "cpu_architecture" {
  description = "Must match the platform the image was built for."
  type        = string
  default     = "X86_64"
}

variable "certificate_arn" {
  description = "ARN of an issued ACM certificate in this account and Region for the service's host name."
  type        = string
}

variable "ingress_cidrs" {
  description = "Who may reach the load balancer. Browsers (the keychain) and the backend's NAT address must be covered."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "log_retention_days" {
  description = "Retention of the service's own logs. How long logs may be kept is an open question in DESIGN.md."
  type        = number
  default     = 30
}

# --- The key -------------------------------------------------------------------------------

variable "kms_key_arn" {
  description = "ARN of the existing HMAC_256 pepper key, in aws_region. Not created or destroyed by Terraform."
  type        = string
  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN (not an alias)."
  }
}

variable "pepper_key_check" {
  description = "The key check value recorded when the key was created: 16 hex characters. Not a secret."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{16}$", var.pepper_key_check))
    error_message = "pepper_key_check must be 16 lowercase hex characters."
  }
}

variable "pepper_key_version" {
  type    = number
  default = 1
}

variable "manage_key_policy" {
  description = "true makes Terraform REPLACE the key's policy with the one in kms.tf. Read the README section on the key policy first; leave false to only output the policy for review."
  type        = bool
  default     = false
}

variable "key_admin_role_arns" {
  description = "IAM role ARNs that may administer the key (change its policy, tags, replicas). Empty means the account itself, which lets any IAM principal with the matching IAM permission do so, including OrganizationAccountAccessRole."
  type        = list(string)
  default     = []
}

# --- Service settings (services/pepper/.env.example) ---------------------------------------

variable "google_audiences" {
  description = "Google OAuth client ids whose tokens are accepted."
  type        = list(string)
  default     = []
}

variable "apple_audiences" {
  description = "Apple client ids whose tokens are accepted."
  type        = list(string)
  default     = []
}

variable "allowed_origins" {
  description = "Browser origins allowed by CORS (the keychain origin)."
  type        = list(string)
  default     = []
}

variable "require_key_proof" {
  description = "Must stay true outside development (DESIGN.md section 13)."
  type        = bool
  default     = true
}

variable "max_token_age_seconds" {
  type    = number
  default = 600
}

variable "rate_ip_burst" {
  type    = number
  default = 30
}

variable "rate_ip_per_minute" {
  type    = number
  default = 30
}

variable "rate_subject_burst" {
  type    = number
  default = 10
}

variable "rate_subject_per_hour" {
  type    = number
  default = 10
}

# --- Audit and alarms ----------------------------------------------------------------------

variable "alarm_email" {
  description = "Address subscribed to the alarm topic. Empty creates the topic with no subscriber. The address is stored in Terraform state."
  type        = string
  default     = ""
}

variable "generate_mac_alarm_threshold" {
  description = "Alarm when GenerateMac is called more than this many times in five minutes. Tune to real traffic."
  type        = number
  default     = 500
}

variable "trail_log_retention_days" {
  description = "Retention of the CloudTrail copy in CloudWatch Logs (the S3 copy has no expiry here)."
  type        = number
  default     = 365
}
