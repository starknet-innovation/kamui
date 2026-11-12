variable "name" {
  description = "Service name; also the container name, the task family and the prefix of the role names."
  type        = string
}

variable "cluster_arn" {
  type = string
}

variable "create_service" {
  description = "false registers the task definition, roles, log group and security group but starts nothing. Used for the first apply, before an image exists."
  type        = bool
  default     = true
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "image" {
  description = "Full image reference, repository URL plus an immutable tag or a digest."
  type        = string
}

variable "ecr_repository_arn" {
  description = "The one repository the execution role may pull from."
  type        = string
}

variable "cpu" {
  description = "Fargate CPU units (1024 = 1 vCPU)."
  type        = number
}

variable "memory" {
  description = "Fargate memory in MiB. Must be a combination Fargate accepts for the CPU value."
  type        = number
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64. Must match the image."
  type        = string
  default     = "X86_64"
}

variable "ephemeral_storage_gib" {
  description = "Task scratch storage in GiB (21 to 200). null keeps the Fargate default."
  type        = number
  default     = null
}

variable "container_port" {
  type = number
}

variable "environment" {
  description = "Plain environment variables. Never put a secret here."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Environment variable name => ARN of the Secrets Manager secret whose value ECS injects at start."
  type        = map(string)
  default     = {}
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets for the tasks."
  type        = list(string)
}

variable "egress_tcp_ports" {
  description = "TCP ports the tasks may connect out to (any destination)."
  type        = list(number)
  default     = [443]
}

variable "attach_load_balancer" {
  type    = bool
  default = false
}

variable "target_group_arn" {
  type    = string
  default = null
}

variable "health_check_grace_seconds" {
  type    = number
  default = 60
}

variable "discovery_namespace_id" {
  description = "Cloud Map private DNS namespace to register the tasks in, or null for none."
  type        = string
  default     = null
}

variable "discovery_name" {
  description = "Host label inside the namespace (for example `prover`)."
  type        = string
  default     = null
}

variable "efs_volume" {
  description = "Optional EFS access point mounted read-write at container_path."
  type = object({
    file_system_id  = string
    access_point_id = string
    container_path  = string
  })
  default = null
}

variable "readonly_root_filesystem" {
  type    = bool
  default = false
}

variable "deployment_minimum_healthy_percent" {
  type    = number
  default = 100
}

variable "deployment_maximum_percent" {
  type    = number
  default = 200
}

variable "log_retention_days" {
  type    = number
  default = 30
}
