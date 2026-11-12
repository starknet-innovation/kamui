# One container as an ECS service on Fargate, in private subnets, with:
#   - its own security group (no inbound rule here: the caller adds exactly the ones it wants);
#   - its own task role (what the application may call; empty until the caller attaches a policy);
#   - its own execution role (what ECS needs to start the task: pull the image, write logs, and
#     read ONLY the secrets listed for this service);
#   - a log group that receives the container's stdout and stderr and nothing else.
#
# ECS Exec is off (enable_execute_command = false): nobody can open a shell in the task.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

data "aws_region" "current" {}

locals {
  secret_arns = values(var.secrets)

  container = {
    name      = var.name
    image     = var.image
    essential = true

    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]

    # Plain settings. Nothing secret may be put here: the task definition is readable by anyone
    # who can call ecs:DescribeTaskDefinition.
    # Settings left empty are omitted, so the application's own default applies.
    environment = [for k in sort(keys(var.environment)) : { name = k, value = var.environment[k] } if var.environment[k] != ""]

    # Secrets: ECS reads each value from Secrets Manager with the execution role when the
    # container starts and sets it as an environment variable. The task definition holds only
    # the secret's ARN.
    secrets = [for k in sort(keys(var.secrets)) : { name = k, valueFrom = var.secrets[k] }]

    mountPoints = var.efs_volume == null ? [] : [{
      sourceVolume  = "data"
      containerPath = var.efs_volume.container_path
      readOnly      = false
    }]

    readonlyRootFilesystem = var.readonly_root_filesystem

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = data.aws_region.current.region
        "awslogs-stream-prefix" = var.name
      }
    }
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/kamui/${var.name}"
  retention_in_days = var.log_retention_days
}

# --- Roles ---------------------------------------------------------------------------------

data "aws_iam_policy_document" "assume_by_tasks" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# The application's identity. No policy is attached here.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume_by_tasks.json
}

# What ECS itself uses to start the task. The application code never holds these credentials.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.assume_by_tasks.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this action does not support resource-level restriction
  }

  statement {
    sid       = "PullThisImage"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [var.ecr_repository_arn]
  }

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  dynamic "statement" {
    for_each = length(var.secrets) > 0 ? [1] : []
    content {
      sid       = "ReadOnlyThisServicesSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secret_arns
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "start-task"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# --- Network -------------------------------------------------------------------------------

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-"
  description = "Tasks of ${var.name}"
  vpc_id      = var.vpc_id

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "tcp" {
  for_each          = toset([for p in var.egress_tcp_ports : tostring(p)])
  security_group_id = aws_security_group.this.id
  description       = "Outbound TCP ${each.value}"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.value)
  to_port           = tonumber(each.value)
}

# --- Private DNS name (optional) -----------------------------------------------------------

resource "aws_service_discovery_service" "this" {
  count = var.discovery_namespace_id == null ? 0 : 1
  name  = var.discovery_name

  dns_config {
    namespace_id   = var.discovery_namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
}

# --- Task and service ----------------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  task_role_arn            = aws_iam_role.task.arn
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions    = jsonencode([local.container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  dynamic "ephemeral_storage" {
    for_each = var.ephemeral_storage_gib == null ? [] : [1]
    content {
      size_in_gib = var.ephemeral_storage_gib
    }
  }

  dynamic "volume" {
    for_each = var.efs_volume == null ? [] : [var.efs_volume]
    content {
      name = "data"
      efs_volume_configuration {
        file_system_id     = volume.value.file_system_id
        transit_encryption = "ENABLED"
        authorization_config {
          access_point_id = volume.value.access_point_id
          iam             = "DISABLED"
        }
      }
    }
  }
}

resource "aws_ecs_service" "this" {
  count = var.create_service ? 1 : 0

  name                   = var.name
  cluster                = var.cluster_arn
  task_definition        = aws_ecs_task_definition.this.arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false

  deployment_minimum_healthy_percent = var.deployment_minimum_healthy_percent
  deployment_maximum_percent         = var.deployment_maximum_percent
  health_check_grace_period_seconds  = var.attach_load_balancer ? var.health_check_grace_seconds : null

  # A deployment whose tasks do not become healthy is stopped and the previous one restored.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = var.attach_load_balancer ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = var.name
      container_port   = var.container_port
    }
  }

  dynamic "service_registries" {
    for_each = aws_service_discovery_service.this
    content {
      registry_arn = service_registries.value.arn
    }
  }
}
