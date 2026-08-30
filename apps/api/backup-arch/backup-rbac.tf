locals {
  tenant_backup_worker_namespaces = setsubtract(
    var.backup_worker_namespaces,
    toset([var.orchestrator_namespace]),
  )
}

resource "kubernetes_service_account_v1" "backup_orchestrator" {
  metadata {
    name      = var.backup_orchestrator_service_account
    namespace = var.orchestrator_namespace
    labels = {
      "app.kubernetes.io/name"      = "server-backup-orchestrator"
      "app.kubernetes.io/part-of"   = "farlands"
      "app.kubernetes.io/component" = "backup"
    }
  }
}

resource "kubernetes_cluster_role_v1" "backup_orchestrator_discovery" {
  metadata {
    name = "farlands-backup-orchestrator-discovery"
  }

  rule {
    api_groups = [""]
    resources  = ["persistentvolumeclaims"]
    verbs      = ["get", "list", "watch"]
  }

  rule {
    api_groups = [""]
    resources  = ["pods"]
    verbs      = ["get", "list", "watch"]
  }

  rule {
    api_groups = ["apps"]
    resources  = ["deployments"]
    verbs      = ["get", "list", "watch"]
  }
}

# This role is intentionally not bound cluster-wide. Each managed fl-* tenant
# namespace gets a namespaced RoleBinding below or during API provisioning.
resource "kubernetes_cluster_role_v1" "backup_tenant_worker" {
  metadata {
    name = "farlands-backup-tenant-worker"
  }

  # The orchestrator verifies this identity seam before creating a worker Job.
  rule {
    api_groups = [""]
    resources  = ["serviceaccounts"]
    verbs      = ["get"]
  }

  rule {
    api_groups = ["batch"]
    resources  = ["jobs"]
    # Delete is limited to Jobs in an onboarded tenant namespace and is used
    # only to replace a terminal Failed deterministic weekly Job under Lease.
    verbs = ["create", "get", "list", "watch", "delete"]
  }

  rule {
    api_groups = ["coordination.k8s.io"]
    resources  = ["leases"]
    verbs      = ["create", "get", "update", "delete"]
  }
}

resource "kubernetes_cluster_role_binding_v1" "backup_orchestrator" {
  metadata {
    name = "farlands-backup-orchestrator"
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role_v1.backup_orchestrator_discovery.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.backup_orchestrator.metadata[0].name
    namespace = kubernetes_service_account_v1.backup_orchestrator.metadata[0].namespace
  }
}

# PVCs are namespaced, so each worker Job must run in the PVC's own namespace.
# These resources bridge existing namespaces onto the wildcard-scoped IRSA role.
# New fl-* namespaces receive the same ServiceAccount from API provisioning and
# do not need a Terraform entry.
resource "kubernetes_service_account_v1" "backup_worker" {
  for_each = local.tenant_backup_worker_namespaces

  metadata {
    name      = var.backup_worker_service_account
    namespace = each.value
    labels = {
      "app.kubernetes.io/name"      = "server-backup-worker"
      "app.kubernetes.io/part-of"   = "farlands"
      "app.kubernetes.io/component" = "backup"
    }
    annotations = {
      "eks.amazonaws.com/role-arn" = local.backup_worker_role_arn
    }
  }

  automount_service_account_token = false
}

resource "kubernetes_role_binding_v1" "backup_orchestrator_tenant" {
  for_each = local.tenant_backup_worker_namespaces

  metadata {
    name      = "farlands-backup-orchestrator"
    namespace = kubernetes_service_account_v1.backup_worker[each.key].metadata[0].namespace
    labels = {
      "app.kubernetes.io/name"      = "server-backup-orchestrator"
      "app.kubernetes.io/part-of"   = "farlands"
      "app.kubernetes.io/component" = "backup"
    }
  }

  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role_v1.backup_tenant_worker.metadata[0].name
  }

  subject {
    kind      = "ServiceAccount"
    name      = kubernetes_service_account_v1.backup_orchestrator.metadata[0].name
    namespace = kubernetes_service_account_v1.backup_orchestrator.metadata[0].namespace
  }
}
