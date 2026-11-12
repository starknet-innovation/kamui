# The pepper service in the pepper account: one small Fargate task behind an HTTPS load
# balancer. The key is NOT here: it already exists in KMS and is passed in by ARN (kms.tf).

module "network" {
  source = "../modules/network"
  name   = var.name
  cidr   = var.vpc_cidr
}

resource "aws_ecr_repository" "pepper" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
}

module "alb" {
  source            = "../modules/https-alb"
  name              = var.name
  vpc_id            = module.network.vpc_id
  vpc_cidr          = module.network.vpc_cidr
  public_subnet_ids = module.network.public_subnet_ids
  certificate_arn   = var.certificate_arn
  ingress_cidrs     = var.ingress_cidrs
  target_port       = 8787
  health_check_path = "/health"
}

module "service" {
  source = "../modules/fargate-service"

  name               = var.name
  cluster_arn        = aws_ecs_cluster.this.arn
  create_service     = var.deploy_service
  desired_count      = var.desired_count
  image              = "${aws_ecr_repository.pepper.repository_url}:${var.image_tag}"
  ecr_repository_arn = aws_ecr_repository.pepper.arn
  cpu                = var.cpu
  memory             = var.memory
  cpu_architecture   = var.cpu_architecture
  container_port     = 8787
  log_retention_days = var.log_retention_days

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  # Outbound HTTPS only: KMS, the issuers' JWKS endpoints, ECR and CloudWatch Logs.
  egress_tcp_ports = [443]

  attach_load_balancer = true
  target_group_arn     = module.alb.target_group_arn

  # The service writes nothing to disk. A read-only root file system would be a cheap extra,
  # but it was not tested with Bun (which may want a writable temp directory), so it is off.
  readonly_root_filesystem = false

  # Every setting of the service (services/pepper/.env.example). None is a secret, and there is
  # no `secrets` entry: the service has none. PEPPER_KEY_HEX must never appear here.
  environment = {
    PORT                  = "8787"
    PEPPER_KEY_SOURCE     = "kms"
    KMS_KEY_ID            = var.kms_key_arn
    AWS_REGION            = var.aws_region
    PEPPER_KEY_CHECK      = var.pepper_key_check
    PEPPER_KEY_VERSION    = tostring(var.pepper_key_version)
    GOOGLE_AUDIENCES      = join(",", var.google_audiences)
    APPLE_AUDIENCES       = join(",", var.apple_audiences)
    ALLOWED_ORIGINS       = join(",", var.allowed_origins)
    REQUIRE_KEY_PROOF     = tostring(var.require_key_proof)
    MAX_TOKEN_AGE_SECONDS = tostring(var.max_token_age_seconds)
    RATE_IP_BURST         = tostring(var.rate_ip_burst)
    RATE_IP_PER_MINUTE    = tostring(var.rate_ip_per_minute)
    RATE_SUBJECT_BURST    = tostring(var.rate_subject_burst)
    RATE_SUBJECT_PER_HOUR = tostring(var.rate_subject_per_hour)
    # Exactly one proxy we control sits in front (the load balancer), which appends the client
    # address as the last X-Forwarded-For entry. That is the case TRUST_PROXY is written for.
    TRUST_PROXY = "true"
  }
}

# Only the load balancer may connect to the task.
resource "aws_vpc_security_group_ingress_rule" "alb_to_service" {
  security_group_id            = module.service.security_group_id
  description                  = "From the load balancer"
  referenced_security_group_id = module.alb.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 8787
  to_port                      = 8787
}

check "key_region" {
  assert {
    condition     = split(":", var.kms_key_arn)[3] == var.aws_region
    error_message = "kms_key_arn is in another Region than aws_region. Deploy the service in the key's Region (or pass the ARN of the replica in this Region)."
  }
}

check "key_account" {
  assert {
    condition     = split(":", var.kms_key_arn)[4] == var.aws_account_id
    error_message = "kms_key_arn belongs to another account than aws_account_id."
  }
}
