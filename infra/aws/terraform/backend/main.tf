# The backend in the backend account: API and rotator services in private subnets.
#
#   internet --HTTPS--> load balancer --> api (3000)
#                                                      +--> rotator (3001, api only, /health)
#
# Outbound, through one NAT gateway: the Starknet RPC, the issuers' JWKS endpoints, the pepper
# service in the other account (by its public HTTPS name), ECR, CloudWatch Logs, Secrets Manager.

module "network" {
  source = "../modules/network"
  name   = var.name
  cidr   = var.vpc_cidr
}

resource "aws_ecs_cluster" "this" {
  name = var.name
}

# Names that resolve only inside the VPC: rotator.<internal_domain>.
resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = var.internal_domain
  vpc  = module.network.vpc_id
}

resource "aws_ecr_repository" "this" {
  for_each             = toset(["api", "rotator"])
  name                 = "${var.name}-${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

locals {
  egress_ports = concat([443], var.extra_egress_tcp_ports)
  rotator_url  = "http://rotator.${var.internal_domain}:3001"
  secret_arn   = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

# --- api: public, behind HTTPS -------------------------------------------------------------

module "alb" {
  source               = "../modules/https-alb"
  name                 = "${var.name}-api"
  vpc_id               = module.network.vpc_id
  vpc_cidr             = module.network.vpc_cidr
  public_subnet_ids    = module.network.public_subnet_ids
  certificate_arn      = var.certificate_arn
  ingress_cidrs        = var.ingress_cidrs
  target_port          = 3000
  health_check_path    = "/health/api"
  idle_timeout_seconds = var.api_idle_timeout_seconds
  blocked_paths        = var.api_blocked_paths
}

module "api" {
  source = "../modules/fargate-service"

  name               = "${var.name}-api"
  cluster_arn        = aws_ecs_cluster.this.arn
  create_service     = var.deploy_services
  desired_count      = var.api_desired_count
  image              = "${aws_ecr_repository.this["api"].repository_url}:${var.image_tags.api}"
  ecr_repository_arn = aws_ecr_repository.this["api"].arn
  cpu                = var.api_cpu
  memory             = var.api_memory
  cpu_architecture   = var.cpu_architecture
  container_port     = 3000
  log_retention_days = var.log_retention_days

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  # 443 out (RPC, JWKS, pepper service, AWS APIs), plus the rotator and NFS inside.
  egress_tcp_ports = concat(local.egress_ports, [3001, 2049])

  attach_load_balancer = true
  target_group_arn     = module.alb.target_group_arn
  # The api reads the chain id from the RPC before it listens.
  health_check_grace_seconds = 120

  # One task at a time, also during a deployment: stop the old one, then start the new one.
  # Needed because the registry is one SQLite file (storage.tf). It means a short outage on
  # every deployment.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  efs_volume = {
    file_system_id  = aws_efs_file_system.registry.id
    access_point_id = aws_efs_access_point.registry.id
    container_path  = dirname(var.registry_db_path)
  }

  environment = merge({
    PORT                                 = "3000"
    RELAYER_ADDRESS                      = var.relayer_address
    ROTATOR_URL                          = local.rotator_url
    AUTHORIZED_GOOGLE_RECOVERY_CLIENT_ID = var.google_recovery_client_id
    AUTHORIZED_APPLE_RECOVERY_CLIENT_ID  = var.apple_recovery_client_id
    PEPPER_SERVICE_URL                   = var.pepper_service_url
    DEPLOYS_PER_HOUR                     = tostring(var.deploys_per_hour)
    SPONSORED_PER_HOUR                   = var.sponsored_per_hour
    REGISTRY_DB                          = var.registry_db_path
  }, var.api_extra_environment)

  # Injected by ECS at container start as environment variables, which is where the backend
  # reads them today (its `env` secret source). The task definition holds only the ARNs.
  secrets = {
    RPC_URL             = local.secret_arn["rpc-url"]
    RELAYER_PRIVATE_KEY = local.secret_arn["relayer-private-key"]
  }

  depends_on = [aws_efs_mount_target.registry]
}

resource "aws_vpc_security_group_ingress_rule" "alb_to_api" {
  security_group_id            = module.api.security_group_id
  description                  = "From the load balancer"
  referenced_security_group_id = module.alb.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

# --- rotator: private, reachable by the api only (for /health/rotator) ---------------------

module "rotator" {
  source = "../modules/fargate-service"

  name               = "${var.name}-rotator"
  cluster_arn        = aws_ecs_cluster.this.arn
  create_service     = var.deploy_services
  desired_count      = 1
  image              = "${aws_ecr_repository.this["rotator"].repository_url}:${var.image_tags.rotator}"
  ecr_repository_arn = aws_ecr_repository.this["rotator"].arn
  cpu                = 256
  memory             = 512
  cpu_architecture   = var.cpu_architecture
  container_port     = 3001
  log_retention_days = var.log_retention_days

  vpc_id           = module.network.vpc_id
  subnet_ids       = module.network.private_subnet_ids
  egress_tcp_ports = local.egress_ports

  discovery_namespace_id = aws_service_discovery_private_dns_namespace.internal.id
  discovery_name         = "rotator"

  # Two rotators at once would both submit the same key update. Stop, then start.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  environment = merge({
    ROTATOR_PORT  = "3001"
    OWNER_ADDRESS = var.owner_address
  }, var.rotator_extra_environment)

  secrets = {
    RPC_URL           = local.secret_arn["rpc-url"]
    OWNER_PRIVATE_KEY = local.secret_arn["owner-private-key"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "api_to_rotator" {
  security_group_id            = module.rotator.security_group_id
  description                  = "Health check from the api"
  referenced_security_group_id = module.api.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 3001
  to_port                      = 3001
}
