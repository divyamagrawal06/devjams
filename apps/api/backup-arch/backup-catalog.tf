data "aws_iam_policy_document" "backup_catalog_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole", "sts:TagSession"]

    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "backup_catalog_access" {
  statement {
    sid       = "ListBackupCatalog"
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
    sid       = "DownloadBackupObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::${var.backup_s3_bucket}/${trim(var.backup_s3_prefix, "/")}/*"]
  }
}

resource "aws_iam_role" "backup_catalog" {
  count = var.manage_backup_catalog_identity ? 1 : 0

  name               = var.backup_catalog_role_name
  assume_role_policy = data.aws_iam_policy_document.backup_catalog_assume_role.json

  tags = {
    "app.kubernetes.io/part-of"   = "farlands"
    "app.kubernetes.io/component" = "backup"
  }
}

resource "aws_iam_role_policy" "backup_catalog" {
  count = var.manage_backup_catalog_identity ? 1 : 0

  name   = "backup-catalog-read"
  role   = aws_iam_role.backup_catalog[0].id
  policy = data.aws_iam_policy_document.backup_catalog_access.json
}

resource "aws_eks_pod_identity_association" "backup_catalog" {
  count = var.manage_backup_catalog_identity ? 1 : 0

  cluster_name    = var.eks_cluster_name
  namespace       = var.backup_catalog_namespace
  service_account = var.backup_catalog_service_account
  role_arn        = aws_iam_role.backup_catalog[0].arn
}
