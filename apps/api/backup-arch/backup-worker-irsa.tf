data "aws_eks_cluster" "backup" {
  name = var.eks_cluster_name
}

data "tls_certificate" "eks_oidc" {
  url = data.aws_eks_cluster.backup.identity[0].oidc[0].issuer
}

locals {
  eks_oidc_issuer        = data.aws_eks_cluster.backup.identity[0].oidc[0].issuer
  eks_oidc_provider_path = replace(local.eks_oidc_issuer, "https://", "")
  eks_oidc_provider_arn  = var.manage_eks_oidc_provider ? aws_iam_openid_connect_provider.eks[0].arn : var.eks_oidc_provider_arn
  backup_worker_role_arn = aws_iam_role.backup_worker_irsa.arn
  backup_worker_subject  = "system:serviceaccount:fl-*:${var.backup_worker_service_account}"
}

check "existing_eks_oidc_provider_is_configured" {
  assert {
    condition = (
      var.manage_eks_oidc_provider ||
      (var.eks_oidc_provider_arn != null && length(trimspace(var.eks_oidc_provider_arn)) > 0)
    )
    error_message = "eks_oidc_provider_arn is required when manage_eks_oidc_provider is false."
  }
}

resource "aws_iam_openid_connect_provider" "eks" {
  count = var.manage_eks_oidc_provider ? 1 : 0

  url             = local.eks_oidc_issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks_oidc.certificates[length(data.tls_certificate.eks_oidc.certificates) - 1].sha1_fingerprint]

  tags = {
    "app.kubernetes.io/part-of"   = "farlands"
    "app.kubernetes.io/component" = "backup"
  }
}

data "aws_iam_policy_document" "backup_worker_irsa_assume" {
  statement {
    sid     = "TenantBackupWorkersOnly"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.eks_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.eks_oidc_provider_path}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "${local.eks_oidc_provider_path}:sub"
      values   = [local.backup_worker_subject]
    }
  }
}

data "aws_iam_policy_document" "backup_worker_s3" {
  statement {
    sid       = "ListManagedBackupPrefix"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${var.backup_s3_bucket}"]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${trim(var.backup_s3_prefix, "/")}/*"]
    }
  }

  statement {
    sid    = "ManageBackupObjects"
    effect = "Allow"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:GetObjectAttributes",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]
    resources = ["arn:aws:s3:::${var.backup_s3_bucket}/${trim(var.backup_s3_prefix, "/")}/*"]
  }
}

resource "aws_iam_role" "backup_worker_irsa" {
  name               = var.backup_worker_irsa_role_name
  assume_role_policy = data.aws_iam_policy_document.backup_worker_irsa_assume.json

  tags = {
    "app.kubernetes.io/part-of"   = "farlands"
    "app.kubernetes.io/component" = "backup"
  }
}

resource "aws_iam_role_policy" "backup_worker_s3" {
  name   = "backup-worker-s3"
  role   = aws_iam_role.backup_worker_irsa.id
  policy = data.aws_iam_policy_document.backup_worker_s3.json
}

# The backend Deployment consumes this ConfigMap. It carries both the worker
# identity used for manual operations and the exact catalog coordinates used by
# the weekly scheduler, preventing upload, RBAC, and console policy from drifting.
locals {
  backup_schedule_fields = split(" ", trimspace(var.backup_schedule))
}

resource "kubernetes_config_map_v1" "backup_worker_identity" {
  metadata {
    name      = "farlands-backup-worker-identity"
    namespace = var.backup_catalog_namespace
    labels = {
      "app.kubernetes.io/part-of"   = "farlands"
      "app.kubernetes.io/component" = "backup"
    }
  }

  data = {
    FARLANDS_BACKUP_WORKER_ROLE_ARN        = local.backup_worker_role_arn
    FARLANDS_BACKUP_WORKER_SERVICE_ACCOUNT = var.backup_worker_service_account
    AWS_REGION                             = var.aws_region
    BACKUP_BUCKET                          = var.backup_s3_bucket
    BACKUP_S3_PREFIX                       = trim(var.backup_s3_prefix, "/")
    BACKUP_SYNC_ENABLED                    = "true"
    BACKUP_SYNC_INTERVAL_MS                = "300000"
    BACKUP_NAMESPACE                       = var.orchestrator_namespace
    BACKUP_ORCHESTRATOR_SERVICE_ACCOUNT    = var.backup_orchestrator_service_account
    BACKUP_CRONJOB_NAME                    = kubernetes_cron_job_v1.server_backup_orchestrator.metadata[0].name
    BACKUP_SCHEDULE_ENABLED                = "true"
    BACKUP_SCHEDULE_MINUTE_UTC             = local.backup_schedule_fields[0]
    BACKUP_SCHEDULE_HOUR_UTC               = local.backup_schedule_fields[1]
    BACKUP_SCHEDULE_DAY_OF_WEEK            = local.backup_schedule_fields[4]
    BACKUP_RETENTION_COUNT                 = tostring(var.backup_retention_count)
  }
}

output "backup_worker_irsa_role_arn" {
  description = "IRSA role automatically used by backup workers in fl-* tenant namespaces."
  value       = local.backup_worker_role_arn
}
