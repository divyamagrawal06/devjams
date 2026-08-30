# Weekly Minecraft backups

This stack runs one backup window every Sunday at 03:00 UTC. The orchestrator
discovers every Minecraft PVC labelled
`app.kubernetes.io/name=farlands-game-server,farlands.dev/backup-strategy=minecraft-rcon`
across the cluster, creates the worker Job in the PVC's own namespace, and
waits for at most `backup_max_concurrency` workers at a time. New Minecraft
PVCs receive that capability label from the provisioner. Reconcile older
workloads with the command below before enabling this selector; non-Minecraft
workloads are intentionally excluded until they have a runtime-specific
consistency strategy.

Each worker writes one idempotent object per ISO week:

```text
<backup_s3_prefix>/<server-id>/weekly/<server-id>-weekly-<iso-week>.tar.gz
```

The worker validates the gzip/tar archive before upload, asks S3 for AES-256
server-side encryption and a SHA-256 checksum, verifies that S3 returns the
checksum, and then deletes all but the newest `backup_retention_count` weekly
keys for that server. The lifecycle rule is a backstop for abandoned objects;
it is not the primary count-based retention mechanism.

## Worker identity in tenant namespaces

Kubernetes PVCs and ServiceAccounts are namespaced, while EKS Pod Identity
associations require an exact namespace and cannot match `fl-*`. Tenant workers
therefore use IRSA instead. Terraform creates an EKS IAM OIDC provider and a
dedicated worker role whose trust is limited to this exact subject pattern:

```text
system:serviceaccount:fl-*:backup-orchestrator
```

The role can list only `backup_s3_prefix` and manage objects only below that
prefix. Terraform injects its ARN as `BACKUP_WORKER_ROLE_ARN` in the scheduler
and as `FARLANDS_BACKUP_WORKER_ROLE_ARN` through the
`farlands-backup-worker-identity` API ConfigMap. That ConfigMap also carries the
exact bucket, region, prefix, and enabled catalog-sync settings used by the
weekly scheduler, so uploaded archives are reconciled into the console without
configuration drift. During Minecraft namespace setup, the API creates an
annotated, non-token-mounted worker ServiceAccount before it creates any realm
PVC or Deployment. Missing configuration, a mismatched role, or a drifted token
setting stops provisioning. The weekly orchestrator repeats the same identity
check before it launches a Job. Its cluster-wide RBAC is read-only discovery;
Job creation, worker-identity reads, and Lease mutation are granted only by a
RoleBinding inside each managed `fl-*` namespace. Terraform installs the
binding for migration namespaces, and the API installs it for newly provisioned
tenants. The orchestrator cannot launch workloads in `kube-system` or another
unmanaged namespace.

`backup_worker_namespaces = ["fl-liveoperator"]` remains only as a migration
bridge: Terraform annotates the current live namespace before the old exact Pod
Identity association is removed. Do not add newly provisioned namespaces to
this list; the API onboards them automatically. If another stack already owns
the cluster's IAM OIDC provider, set `manage_eks_oidc_provider = false` and pass
its ARN in `eks_oidc_provider_arn`.

The orchestrator only talks to Kubernetes and does not need S3 credentials.
The existing out-of-band `infra-team` Pod Identity association is not part of
this stack and can be removed separately after the worker IRSA rollout is
verified.

Roll out the feature in this order:

1. Explicitly suspend the existing six-hour CronJob before quiescing anything;
   scaling the backend does not stop that independent controller:

   ```bash
   kubectl --namespace infra-team patch cronjob server-backup-orchestrator \
     --type=merge --patch '{"spec":{"suspend":true}}'
   kubectl --namespace infra-team get cronjob server-backup-orchestrator \
     --output=jsonpath='{.spec.suspend}{"\n"}'
   kubectl get jobs --all-namespaces \
     --output=jsonpath='{range .items[*]}{.metadata.namespace}{"/"}{.metadata.name}{"\t"}{range .status.conditions[*]}{.type}{"="}{.status}{" "}{end}{"\n"}{end}'
   ```

   The suspend readback must print `true`. Keep this CronJob suspended through
   the migration, rollout, workload reconciliation, and restore drill. Block
   backup-changing API traffic and scale the existing backend/controller
   Deployment to zero. Keep the old image stopped for the entire migration and
   new-image rollout; this is intentionally a quiesced upgrade, not a rolling
   overlap between old and new controllers. Every
   `server-backup-orchestrator-*` Job and create/delete/restore backup worker
   Job must show a terminal `Complete=True` or `Failed=True` condition before
   continuing. An empty condition or `status.active=0` is not terminal: a Job
   in backoff can create another Pod. If an operator deliberately abandons a
   nonterminal Job, delete that exact Job with `--wait=true` and confirm it is
   absent from the readback before continuing. The new controller checks
   durable backup claims after taking each server Lease, but a pre-migration
   Job did not hold that Lease.
2. Apply database migrations `0013_backup_console_weekly.sql`,
   `0014_backup_operation_started_at.sql`, and
   `0015_backup_operation_attempt_id.sql` through the normal migration runner.
3. Build and push the immutable orchestrator image.
4. Review and apply this Terraform stack. It creates OIDC/IRSA, the backend
   ConfigMap, annotates the migration namespaces, and installs their namespaced
   orchestrator RoleBindings.
5. Apply `infra/k8s/system/rbac.yaml`, configure the backend Deployment to
   consume the required `farlands-backup-worker-identity` ConfigMap with
   `envFrom`, replace the stopped backend with the new image, and only then
   scale it back up. Do not let an old-image pod become ready again, and do not
   duplicate its bucket, region, prefix, sync, or worker-identity keys in
   another environment source.
6. Before enabling the CronJob, reconcile every existing Minecraft workload:

   ```bash
   cd apps/api
   bun run reconcile:backups --dry-run
   bun run reconcile:backups
   ```

   The command acquires each server's backup Lease, rejects an unfinished
   deployment cutover or durable legacy backup operation, repairs the tenant
   backup identity and world-sync ConfigMap, and updates the existing
   Deployment, Service, RCON configuration, and NetworkPolicy in place. It
   preserves the PVC and desired replica count. The dry-run exits nonzero and
   identifies any realm whose earlier backup/restore/delete must finish first.
   The PVC discovery labels are written only after the replacement rollout is
   healthy, so the weekly orchestrator cannot select a partially migrated realm.
   Re-running the command is safe. Use `--server=<server-id>` to retry one realm.
   Do not enable or unpause the CronJob until the command exits successfully for
   every active realm.
7. Confirm the existing worker ServiceAccount has the expected annotation and
   run one manual backup plus a disposable restore drill before relying on the
   weekly schedule.
8. Set `backup_cronjob_suspended = false`, review and apply the Terraform plan,
   then verify that `server-backup-weekly` reports the next Sunday 03:00 UTC run.

## Console catalog identity

The live API needs read-only S3 access to discover scheduled archives and sign
short-lived downloads. By default this stack creates
`farlands-backup-catalog-read` and associates it with
`dev-deployment/farlands-backend`. Its inline policy is limited to
`ListBucket` on the configured prefix and `GetObject` below that prefix; it
cannot create, overwrite, or delete archives. Set
`manage_backup_catalog_identity = false` only when an equivalent association is
managed elsewhere.

The backend Deployment must consume the Terraform-managed catalog coordinates
and sync switch as one unit:

```yaml
envFrom:
  - configMapRef:
      name: farlands-backup-worker-identity
      optional: false
```

This supplies `AWS_REGION`, `BACKUP_BUCKET`, `BACKUP_S3_PREFIX`,
`BACKUP_SYNC_ENABLED=true`, `BACKUP_SYNC_INTERVAL_MS`, the exact orchestrator
namespace and ServiceAccount, and the weekly schedule/retention policy alongside
the worker identity. The generic `S3_PREFIX` used by other artifact paths is not
the backup catalog contract and may differ safely.

## Existing S3 bucket controls

The stack references the bucket by name and never declares an `aws_s3_bucket`
resource, so it cannot recreate or delete the bucket. Bucket controls are
enabled for the current backup bucket by default:

```hcl
manage_backup_bucket_controls = true
```

This stack owns versioning, AES-256 default encryption, public-access blocking,
and the bucket's **entire** lifecycle configuration. S3 has one lifecycle
configuration per bucket, so the plan replaces the inspected 14-day
`infra-team/` rule with the configured rule. Review the plan before apply. Both
current and noncurrent versions default to at least 35 days, preventing the old
rule from expiring a three-point weekly series too early. Set the flag to
`false` only when those controls are managed in another stack.

No Terraform apply is performed by repository tests.

## Build and verification

The orchestrator image is a required Terraform input and must use an immutable
`@sha256:` digest. Build and push it first, then pass that digest as
`backup_orchestrator_image`. The archive, upload, world-sync, and Docker build
base images are digest-pinned in this implementation as well.

```bash
bun test apps/api/backup-arch/index.test.ts
bun node_modules/typescript/bin/tsc -p apps/api/backup-arch/tsconfig.json --noEmit
```

Run `terraform fmt`, `terraform init`, and `terraform validate` from this
directory on a host with Terraform/OpenTofu installed before planning changes.
Worker Jobs each have a hard deadline. The orchestrator deadline defaults to
unset because it processes an arbitrary number of discovered PVCs in bounded
batches; a fixed whole-run deadline could kill a later batch before its archive
finishes. `concurrencyPolicy = "Forbid"` prevents overlapping weekly runs.
Each orchestrator Pod also uses its downward-API Pod UID as a unique Lease
holder, so an operator-started overlapping invocation cannot release another
process's Lease. Worker Job names and S3 keys remain deterministic per ISO week.
A rerun reuses an active or successful Job; if that Job is terminally Failed,
the Lease owner foreground-deletes it and waits for deletion before safely
recreating the same weekly Job.

## Consistency and recovery verification

For a running Minecraft Java realm, the worker calls the restricted world-sync
sidecar. It issues RCON `save-off` and `save-all flush`, streams the archive,
and restores `save-on` in a `finally` path. For a stopped realm, the worker
mounts the PVC read-only and archives it directly. Restore extracts to staging,
validates Minecraft markers, then swaps data while retaining a rollback copy
whenever automatic rollback is incomplete. A periodic test restore to a
disposable PVC is still required to prove end-to-end recoverability; an
uploaded archive alone is not proof of a working backup.

S3 remains the primary target because workers use short-lived IRSA credentials.
R2 is a useful off-account secondary copy, but it needs an
S3-compatible endpoint, region `auto`, and a scoped R2 API token stored outside
the repository; those credentials must not be embedded in this CronJob.
