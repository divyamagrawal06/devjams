# These controls attach to an existing bucket by name; there is deliberately no
# aws_s3_bucket resource, so this stack cannot recreate or delete the bucket.
# Lifecycle ownership is opt-in because S3 exposes one lifecycle configuration
# per bucket and applying this resource replaces all existing rules.

resource "aws_s3_bucket_versioning" "backup" {
  count = var.manage_backup_bucket_controls ? 1 : 0

  bucket = var.backup_s3_bucket

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backup" {
  count = var.manage_backup_bucket_controls ? 1 : 0

  bucket = var.backup_s3_bucket

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backup" {
  count = var.manage_backup_bucket_controls ? 1 : 0

  bucket = var.backup_s3_bucket

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backup" {
  count = var.manage_backup_bucket_controls ? 1 : 0

  bucket = var.backup_s3_bucket

  # Ensure versioning is active before lifecycle begins expiring current keys.
  depends_on = [aws_s3_bucket_versioning.backup]

  rule {
    id     = "ExpireFarlandsBackupPrefix"
    status = "Enabled"

    filter {
      prefix = "${trim(var.backup_s3_prefix, "/")}/"
    }

    expiration {
      days = var.backup_lifecycle_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.backup_noncurrent_version_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
