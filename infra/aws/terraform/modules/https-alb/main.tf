# A public Application Load Balancer that terminates HTTPS and forwards plain HTTP to one
# target group of Fargate tasks inside the VPC.
#
# Access logs are NOT enabled, on purpose (they would record client addresses and request URLs;
# see the README). The load balancer never logs request bodies either way.

terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

variable "name" {
  description = "Name of the load balancer and prefix for related resources (at most 24 characters)."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "vpc_cidr" {
  description = "The load balancer may only open connections to this range."
  type        = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "certificate_arn" {
  description = "ARN of an issued ACM certificate, in the same Region, for the host name that will point at this load balancer."
  type        = string
}

variable "ingress_cidrs" {
  description = "Who may connect to the load balancer."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "target_port" {
  type = number
}

variable "health_check_path" {
  type = string
}

variable "idle_timeout_seconds" {
  description = "How long the load balancer keeps a connection open with no data flowing. Must exceed the slowest response."
  type        = number
  default     = 60
}

variable "blocked_paths" {
  description = "Path patterns answered with 404 by the load balancer (at most five)."
  type        = list(string)
  default     = []
}

variable "ssl_policy" {
  type    = string
  default = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

resource "aws_security_group" "alb" {
  name_prefix = "${var.name}-alb-"
  description = "Load balancer for ${var.name}"
  vpc_id      = var.vpc_id

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  for_each          = toset(var.ingress_cidrs)
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from clients"
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "to_targets" {
  security_group_id = aws_security_group.alb.id
  description       = "To the service tasks, inside the VPC only"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = var.target_port
  to_port           = var.target_port
}

resource "aws_lb" "this" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  idle_timeout               = var.idle_timeout_seconds
  drop_invalid_header_fields = true

  # No access_logs block: access logging stays off. Do not add one without reading the README
  # section on what the load balancer would then record.
}

resource "aws_lb_target_group" "this" {
  name_prefix          = "kamui-"
  vpc_id               = var.vpc_id
  target_type          = "ip"
  protocol             = "HTTP"
  port                 = var.target_port
  deregistration_delay = 30

  health_check {
    path                = var.health_check_path
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Port 80 is not opened at all: there is no plain-HTTP listener and no redirect.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

# Paths that must not be reachable from outside (for example a metrics route) get a 404 from
# the load balancer and never reach the service.
resource "aws_lb_listener_rule" "blocked" {
  count        = length(var.blocked_paths) > 0 ? 1 : 0
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    path_pattern {
      values = var.blocked_paths
    }
  }

  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "not found"
    }
  }
}

output "dns_name" {
  description = "Point the service's host name at this (CNAME or alias record)."
  value       = aws_lb.this.dns_name
}

output "zone_id" {
  value = aws_lb.this.zone_id
}

output "security_group_id" {
  value = aws_security_group.alb.id
}

output "target_group_arn" {
  # Read through the listener so that a service using this waits for the listener to exist.
  value = aws_lb_listener.https.default_action[0].target_group_arn
}
