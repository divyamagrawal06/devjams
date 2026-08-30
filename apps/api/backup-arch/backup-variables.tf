variable "aws_region" {
  description = "AWS region containing the EKS cluster and backup bucket."
  type        = string
  default     = "ap-south-1"
}

variable "eks_cluster_name" {
  description = "EKS cluster whose OIDC issuer is trusted by the tenant backup-worker IRSA role."
  type        = string
  default     = "farlands-dev"
}

variable "kubeconfig_path" {
  description = "Path to the kubeconfig used by the Kubernetes provider."
  type        = string
  default     = "~/.kube/config"
}

variable "kubeconfig_context" {
  description = "Kubeconfig context for the target cluster."
  type        = string
  default     = "farlands-dev"
}

variable "orchestrator_namespace" {
  description = "Namespace that hosts the weekly backup CronJob."
  type        = string
  default     = "infra-team"
}

variable "backup_orchestrator_service_account" {
  description = "Kubernetes ServiceAccount used by the cross-namespace orchestrator."
  type        = string
  default     = "backup-orchestrator"
}

variable "backup_worker_service_account" {
  description = "ServiceAccount used by archive/upload Jobs in each PVC namespace."
  type        = string
  default     = "backup-orchestrator"
}

variable "backup_worker_namespaces" {
  description = <<-EOT
    Existing tenant namespaces where Terraform should pre-create the IRSA backup
    worker ServiceAccount during migration. New fl-* namespaces are onboarded
    automatically and fail closed in the API provisioning path, so they do not
    need to be added here. The orchestrator namespace is handled separately.
  EOT
  type        = set(string)
  default     = ["fl-liveoperator"]
}

variable "manage_eks_oidc_provider" {
  description = "Create the IAM OIDC provider required by EKS IRSA. Set false only when the provider already exists and eks_oidc_provider_arn is supplied."
  type        = bool
  default     = true
}

variable "eks_oidc_provider_arn" {
  description = "Existing IAM OIDC provider ARN for the EKS issuer when manage_eks_oidc_provider is false."
  type        = string
  default     = null
  nullable    = true
}

variable "backup_worker_irsa_role_name" {
  description = "IAM role assumed only by backup worker ServiceAccounts in fl-* tenant namespaces."
  type        = string
  default     = "farlands-backup-worker-irsa"
}

variable "manage_backup_catalog_identity" {
  description = "Create the least-privilege IAM role and EKS Pod Identity association used by the live API to list backup metadata and sign downloads."
  type        = bool
  default     = true
}

variable "backup_catalog_namespace" {
  description = "Namespace containing the API that reconciles the S3 backup catalog."
  type        = string
  default     = "dev-deployment"
}

variable "backup_catalog_service_account" {
  description = "Existing Kubernetes ServiceAccount used by the backup catalog API."
  type        = string
  default     = "farlands-backend"
}

variable "backup_catalog_role_name" {
  description = "IAM role created for read-only backup catalog and download access."
  type        = string
  default     = "farlands-backup-catalog-read"
}

variable "backup_orchestrator_image" {
  description = "Required immutable image digest for the PVC-discovery orchestrator."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.backup_orchestrator_image))
    error_message = "backup_orchestrator_image must be pinned by sha256 digest."
  }
}

variable "backup_archive_image" {
  description = "Image containing tar/gzip used to build and validate an archive."
  type        = string
  default     = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.backup_archive_image))
    error_message = "backup_archive_image must be pinned by sha256 digest."
  }
}

variable "backup_upload_image" {
  description = "Image containing AWS CLI v2 for checksum-protected S3 upload and retention pruning."
  type        = string
  default     = "amazon/aws-cli:2.15.0@sha256:e2a778146a45cb7cdcc55e3051c0de38ea9f180ed88383447f7ead6b0ba5e9a4"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.backup_upload_image))
    error_message = "backup_upload_image must be pinned by sha256 digest."
  }
}

variable "backup_s3_bucket" {
  description = "Existing S3 bucket where server backups are stored. This stack never creates or deletes the bucket."
  type        = string
  default     = "farlands-eks-backups-963957629631-ap-south-1"
}

variable "backup_s3_prefix" {
  description = "Root S3 key prefix. Weekly objects use <prefix>/<server-id>/weekly/<filename>."
  type        = string
  default     = "infra-team"

  validation {
    condition     = length(trim(var.backup_s3_prefix, "/")) > 0
    error_message = "backup_s3_prefix must not be empty."
  }
}

variable "backup_schedule" {
  description = "Kubernetes cron expression. Default is Sunday at 03:00 UTC."
  type        = string
  default     = "0 3 * * 0"

  validation {
    condition     = can(regex("^([0-5]?[0-9]) ([01]?[0-9]|2[0-3]) \\* \\* ([0-6])$", trimspace(var.backup_schedule)))
    error_message = "backup_schedule must be one weekly numeric UTC schedule such as '0 3 * * 0'."
  }
}

variable "backup_time_zone" {
  description = "IANA time zone interpreted by Kubernetes for backup_schedule."
  type        = string
  default     = "Etc/UTC"

  validation {
    condition     = contains(["Etc/UTC", "UTC"], var.backup_time_zone)
    error_message = "backup_time_zone must remain UTC so the API console and CronJob report one schedule."
  }
}

variable "backup_cronjob_suspended" {
  description = "Keep the weekly CronJob paused during first rollout until existing Minecraft workloads pass non-destructive backup reconciliation. Set false after verification."
  type        = bool
  default     = true
}

variable "backup_starting_deadline_seconds" {
  description = "Maximum delay after the weekly schedule during which Kubernetes may still start the run."
  type        = number
  default     = 3600
}

variable "backup_orchestrator_active_deadline_seconds" {
  description = "Optional hard deadline for the full orchestrator run. Null lets its bounded per-worker waits cover every discovered PVC regardless of batch count."
  type        = number
  default     = null
  nullable    = true

  validation {
    condition = var.backup_orchestrator_active_deadline_seconds == null ? true : (
      var.backup_orchestrator_active_deadline_seconds >= var.backup_worker_active_deadline_seconds + 300
    )
    error_message = "backup_orchestrator_active_deadline_seconds must cover at least one complete worker wait or be null."
  }
}

variable "backup_worker_active_deadline_seconds" {
  description = "Hard deadline for one archive/upload worker Job."
  type        = number
  default     = 7200
}

variable "backup_worker_poll_interval_seconds" {
  description = "How frequently the orchestrator checks worker Job completion."
  type        = number
  default     = 10
}

variable "backup_max_concurrency" {
  description = "Maximum number of server backup Jobs allowed to run at once."
  type        = number
  default     = 3

  validation {
    condition     = var.backup_max_concurrency >= 1
    error_message = "backup_max_concurrency must be at least 1."
  }
}

variable "backup_retention_count" {
  description = "Newest weekly archives retained per server after a successful verified upload."
  type        = number
  default     = 3

  validation {
    condition     = var.backup_retention_count >= 1
    error_message = "backup_retention_count must be at least 1."
  }
}

variable "backup_temp_size_limit" {
  description = "emptyDir and ephemeral-storage limit available for one compressed archive."
  type        = string
  default     = "25Gi"
}

variable "backup_pvc_label_selector" {
  description = "Label selector used to discover backup-capable Minecraft PVCs across every namespace."
  type        = string
  default     = "app.kubernetes.io/name=farlands-game-server,farlands.dev/backup-strategy=minecraft-rcon"
}

variable "manage_backup_bucket_controls" {
  description = <<-EOT
    Whether this stack owns versioning, default SSE, public-access
    blocking, and the entire S3 lifecycle configuration on backup_s3_bucket.
    Enabling this replaces any existing lifecycle rules, including the live 14-day
    infra-team rule. Review the plan before apply; the bucket itself is not recreated.
  EOT
  type        = bool
  default     = true
}

variable "backup_lifecycle_retention_days" {
  description = "S3 expiration backstop for current objects under backup_s3_prefix."
  type        = number
  default     = 35

  validation {
    condition     = var.backup_lifecycle_retention_days >= 35
    error_message = "Weekly backup lifecycle retention must be at least 35 days."
  }
}

variable "backup_noncurrent_version_retention_days" {
  description = "Days to retain noncurrent versions after S3 versioning is enabled."
  type        = number
  default     = 35

  validation {
    condition     = var.backup_noncurrent_version_retention_days >= 35
    error_message = "Noncurrent weekly backup versions must be retained for at least 35 days."
  }
}
