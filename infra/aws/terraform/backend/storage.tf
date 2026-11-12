# Persistent storage for the api's SQLite session registry (REGISTRY_DB).
#
# A Fargate task's own disk disappears with the task, and every deployment replaces the task.
# The registry therefore lives on an EFS file system mounted at /data. EFS is a network file
# system (NFS), which SQLite tolerates only under these conditions, all enforced here or noted
# in the README:
#   - exactly ONE api task has the file open (api_desired_count <= 1, and deployments stop the
#     old task before starting the new one: minimum healthy 0 %, maximum 100 %);
#   - the database does not use WAL mode (WAL needs shared memory, which NFS does not give).
# Production should use a database service instead.

resource "aws_efs_file_system" "registry" {
  creation_token = "${var.name}-registry"
  encrypted      = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_security_group" "efs" {
  name_prefix = "${var.name}-efs-"
  description = "NFS to the registry file system"
  vpc_id      = module.network.vpc_id

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "api_to_efs" {
  security_group_id            = aws_security_group.efs.id
  description                  = "NFS from the api tasks only"
  referenced_security_group_id = module.api.security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

resource "aws_efs_mount_target" "registry" {
  count           = 2
  file_system_id  = aws_efs_file_system.registry.id
  subnet_id       = module.network.private_subnet_ids[count.index]
  security_groups = [aws_security_group.efs.id]
}

# The access point pins every file operation to one unprivileged user and one directory,
# whatever user the container runs as.
resource "aws_efs_access_point" "registry" {
  file_system_id = aws_efs_file_system.registry.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/registry"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "0750"
    }
  }
}

resource "aws_efs_backup_policy" "registry" {
  file_system_id = aws_efs_file_system.registry.id
  backup_policy {
    status = "ENABLED"
  }
}
