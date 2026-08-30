resource "kubernetes_cron_job_v1" "server_backup_orchestrator" {
  metadata {
    name      = "server-backup-orchestrator"
    namespace = var.orchestrator_namespace
    labels = {
      "app.kubernetes.io/name"      = "server-backup-orchestrator"
      "app.kubernetes.io/part-of"   = "farlands"
      "app.kubernetes.io/component" = "backup"
    }
  }

  spec {
    schedule                      = var.backup_schedule
    timezone                      = var.backup_time_zone
    suspend                       = var.backup_cronjob_suspended
    concurrency_policy            = "Forbid"
    starting_deadline_seconds     = var.backup_starting_deadline_seconds
    successful_jobs_history_limit = 1
    failed_jobs_history_limit     = 3

    job_template {
      metadata {
        labels = {
          "app.kubernetes.io/name"      = "server-backup-orchestrator"
          "app.kubernetes.io/part-of"   = "farlands"
          "app.kubernetes.io/component" = "backup"
        }
      }

      spec {
        active_deadline_seconds    = var.backup_orchestrator_active_deadline_seconds
        backoff_limit              = 1
        ttl_seconds_after_finished = 86400

        template {
          metadata {
            labels = {
              "app.kubernetes.io/name"      = "server-backup-orchestrator"
              "app.kubernetes.io/part-of"   = "farlands"
              "app.kubernetes.io/component" = "backup"
            }
          }

          spec {
            service_account_name             = var.backup_orchestrator_service_account
            automount_service_account_token  = true
            restart_policy                   = "Never"
            termination_grace_period_seconds = 30

            security_context {
              run_as_non_root = true
              run_as_user     = 1000
              run_as_group    = 1000
              fs_group        = 1000

              seccomp_profile {
                type = "RuntimeDefault"
              }
            }

            container {
              name              = "orchestrator"
              image             = var.backup_orchestrator_image
              image_pull_policy = "Always"

              security_context {
                allow_privilege_escalation = false
                read_only_root_filesystem  = true
                run_as_non_root            = true
                run_as_user                = 1000
                run_as_group               = 1000

                capabilities {
                  drop = ["ALL"]
                }
              }

              resources {
                requests = {
                  cpu    = "50m"
                  memory = "128Mi"
                }
                limits = {
                  cpu    = "250m"
                  memory = "256Mi"
                }
              }

              env {
                name  = "PVC_LABEL_SELECTOR"
                value = var.backup_pvc_label_selector
              }

              env {
                name  = "S3_BUCKET"
                value = var.backup_s3_bucket
              }

              env {
                name  = "S3_REGION"
                value = var.aws_region
              }

              env {
                name  = "S3_PREFIX"
                value = trim(var.backup_s3_prefix, "/")
              }

              env {
                name  = "BACKUP_IMAGE_ARCHIVE"
                value = var.backup_archive_image
              }

              env {
                name  = "BACKUP_IMAGE_UPLOAD"
                value = var.backup_upload_image
              }

              env {
                name  = "BACKUP_WORKER_SERVICE_ACCOUNT"
                value = var.backup_worker_service_account
              }

              env {
                name  = "BACKUP_WORKER_ROLE_ARN"
                value = local.backup_worker_role_arn
              }

              env {
                name  = "BACKUP_RETENTION_COUNT"
                value = tostring(var.backup_retention_count)
              }

              env {
                name  = "BACKUP_MAX_CONCURRENCY"
                value = tostring(var.backup_max_concurrency)
              }

              env {
                name  = "BACKUP_WORKER_ACTIVE_DEADLINE_SECONDS"
                value = tostring(var.backup_worker_active_deadline_seconds)
              }

              env {
                name  = "BACKUP_WORKER_POLL_INTERVAL_SECONDS"
                value = tostring(var.backup_worker_poll_interval_seconds)
              }

              env {
                name  = "BACKUP_TEMP_SIZE_LIMIT"
                value = var.backup_temp_size_limit
              }

              # Pod UID is unique for every orchestrator process, including a
              # Job-controller retry, so concurrent invocations cannot share a
              # per-server Lease holder while retaining deterministic workers.
              env {
                name = "BACKUP_ORCHESTRATOR_INVOCATION_ID"
                value_from {
                  field_ref {
                    field_path = "metadata.uid"
                  }
                }
              }

              env {
                name  = "HOME"
                value = "/tmp"
              }

              volume_mount {
                name       = "runtime-temp"
                mount_path = "/tmp"
              }
            }

            volume {
              name = "runtime-temp"
              empty_dir {}
            }
          }
        }
      }
    }
  }
}
