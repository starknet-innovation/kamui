# No variable here holds a secret. Private keys and the RPC URL are Secrets Manager secrets
# whose VALUES are set outside Terraform (secrets.tf), so they never reach Terraform state.

# --- Where ---------------------------------------------------------------------------------

variable "aws_account_id" {
  description = "Id of the backend account (kamui-backend-test). Terraform refuses to run against any other account."
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

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "kamui-backend"
}

variable "vpc_cidr" {
  type    = string
  default = "10.30.0.0/16"
}

variable "internal_domain" {
  description = "Private DNS zone, visible only inside the VPC, under which the prover and rotator are named."
  type        = string
  default     = "kamui.internal"
}

# --- Rollout -------------------------------------------------------------------------------

variable "deploy_services" {
  description = "false on the first apply (repositories, network, empty secrets, storage); true once the images are pushed and the secret values are set."
  type        = bool
  default     = false
}

variable "image_tags" {
  description = "Immutable tag of each image in the ECR repositories this module creates."
  type = object({
    api     = string
    rotator = string
    prover  = string
  })
  default = { api = "unset", rotator = "unset", prover = "unset" }
}

variable "cpu_architecture" {
  description = "Architecture of the api and rotator images."
  type        = string
  default     = "X86_64"
}

variable "certificate_arn" {
  description = "ARN of an issued ACM certificate in this account and Region for the api's host name."
  type        = string
}

variable "ingress_cidrs" {
  description = "Who may reach the api's load balancer."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "extra_egress_tcp_ports" {
  description = "Outbound TCP ports besides 443, for an RPC endpoint on another port."
  type        = list(number)
  default     = []
}

# --- api -----------------------------------------------------------------------------------

variable "api_desired_count" {
  description = "Keep at 1: the session registry is one SQLite file, and the proof queue and rate limits are per process."
  type        = number
  default     = 1
  validation {
    condition     = var.api_desired_count <= 1
    error_message = "The api must not run more than one task while its registry is a SQLite file on a shared volume."
  }
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "api_idle_timeout_seconds" {
  description = "Load balancer idle timeout. /recover answers only after deployment, proof and recovery (about 60 s measured, longer when proofs queue)."
  type        = number
  default     = 600
}

variable "api_blocked_paths" {
  description = "Paths the load balancer answers with 404 instead of forwarding. The metrics route is for scraping from inside, not for the internet."
  type        = list(string)
  default     = ["/metrics", "/metrics/*"]
}

variable "relayer_address" {
  description = "Starknet address of the relayer account (public)."
  type        = string
}

variable "prover_account_address" {
  description = "Starknet address of the prover account (public)."
  type        = string
}

variable "owner_address" {
  description = "Starknet address of the registry owner the rotator signs as (public)."
  type        = string
}

variable "google_recovery_client_id" {
  type = string
}

variable "apple_recovery_client_id" {
  type = string
}

variable "pepper_service_url" {
  description = "HTTPS base URL of the pepper service in the other account. Empty disables the confirmation (testnets only)."
  type        = string
  default     = ""
}

variable "deploys_per_hour" {
  type    = number
  default = 30
}

variable "sponsored_per_hour" {
  description = "Empty keeps the backend's default for the chain."
  type        = string
  default     = ""
}

variable "registry_db_path" {
  description = "Path of the SQLite session registry inside the api container (REGISTRY_DB). It is on the persistent volume mounted at /data."
  type        = string
  default     = "/data/registry.db"
}

variable "api_extra_environment" {
  description = "Further plain settings for the api, for options the backend gains later. Never a secret."
  type        = map(string)
  default     = {}
}

variable "rotator_extra_environment" {
  type    = map(string)
  default = {}
}

# --- prover --------------------------------------------------------------------------------

variable "prover_desired_count" {
  description = "1 to run the prover, 0 to stop paying for it when nobody is testing. More than 1 is pointless today: the api's queue sends one proof at a time."
  type        = number
  default     = 1
}

variable "prover_cpu" {
  description = "Fargate CPU units. The measured run used 8 CPUs."
  type        = number
  default     = 8192
}

variable "prover_memory" {
  description = "Fargate memory in MiB. Measured: killed at 8 GB, peak 19.5 GB under a 20 GB cap. 24 GB is the smallest Fargate size above 20 GB at 8 vCPU."
  type        = number
  default     = 24576
}

variable "prover_cpu_architecture" {
  description = "Architecture of the prover image. Not checked: see the README."
  type        = string
  default     = "X86_64"
}

variable "prover_ephemeral_storage_gib" {
  description = "Scratch disk for the prover task (21 to 200). null keeps the Fargate default of 20 GiB, which must also hold the image."
  type        = number
  default     = null
}

variable "prover_chain_id" {
  type    = string
  default = "SN_SEPOLIA"
}

variable "prover_rust_log" {
  description = "RUST_LOG for the prover. The compose file's value logs each proving phase; whether debug level also logs transaction contents (which include the login token) was not checked."
  type        = string
  default     = "warn,starknet_transaction_prover=debug,privacy_prove=info,stwo_cairo_adapter=info,stwo_cairo_prover=info"
}

# --- secrets -------------------------------------------------------------------------------

variable "secret_recovery_window_days" {
  description = "Days a deleted secret can still be restored (0 deletes at once; 7 to 30 otherwise)."
  type        = number
  default     = 7
}
