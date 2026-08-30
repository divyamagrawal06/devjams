"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CalendarClock,
  CircleAlert,
  Download,
  Power,
  RefreshCw,
  RotateCcw,
  Server,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  api,
  type Backup,
  type BackupListResponse,
  type BackupScheduleResponse,
  farlandsApiPath,
  type LiveServer,
} from "@/lib/api";
import {
  backupIsBusy,
  backupRestoreAllowed,
  backupStatusLabel,
  backupStatusTone,
  formatBytes,
  formatUtcDateTime,
  weeklyScheduleLabel,
} from "@/lib/backups";
import { type OperatorReceiptStatus, operatorReceiptOutcome } from "@/lib/operator-receipts";

const RESTORE_CONFIRMATION = "RESTORE_BACKUP_DISCARDS_NEWER_DATA";

type BackupsWindowProps = {
  controlMessage: string;
  controlsAvailable: boolean;
  onRetryServers: () => void;
  onSelectServer: (serverId: string) => void;
  selectedServerId: string | null;
  servers: LiveServer[];
  serversError: boolean;
  serversPending: boolean;
};

type BackupMutationResponse = {
  success: boolean;
  data: Backup;
};

type StopActionResponse = {
  success: boolean;
  data: {
    success: boolean;
    action: "stop";
    status: string;
    receipt: {
      receiptId: string;
      status: OperatorReceiptStatus;
    };
  };
};

function humanizeState(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The backup action could not be completed.";
}

function BackupLoadingRows() {
  return (
    <div className="backup-list backup-loading-list" role="status">
      <span className="sr-only">Loading backups</span>
      {[0, 1, 2].map((item) => (
        <div className="backup-skeleton" key={item}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

export function BackupsWindow({
  controlMessage,
  controlsAvailable,
  onRetryServers,
  onSelectServer,
  selectedServerId,
  servers,
  serversError,
  serversPending,
}: BackupsWindowProps) {
  const queryClient = useQueryClient();
  const [restoreBackupId, setRestoreBackupId] = useState<string | null>(null);
  const [deleteBackupId, setDeleteBackupId] = useState<string | null>(null);
  const [restoreAcknowledged, setRestoreAcknowledged] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, []);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedServerId) ?? servers[0] ?? null,
    [selectedServerId, servers],
  );
  const serverId = selectedServer?.id ?? null;

  useEffect(() => {
    if (selectedServer && selectedServer.id !== selectedServerId) {
      onSelectServer(selectedServer.id);
    }
  }, [onSelectServer, selectedServer, selectedServerId]);

  useEffect(() => {
    if (serverId === null) return;
    setRestoreBackupId(null);
    setDeleteBackupId(null);
    setRestoreAcknowledged(false);
    setAnnouncement("");
  }, [serverId]);

  const backups = useQuery<BackupListResponse>({
    queryKey: ["backups", serverId, "list"],
    queryFn: () =>
      api<BackupListResponse>(`/api/servers/${encodeURIComponent(serverId ?? "")}/backups/`),
    enabled: Boolean(serverId),
    refetchInterval: (query) =>
      query.state.data?.data.some((backup) => backupIsBusy(backup)) ? 3_000 : 30_000,
    retry: 1,
  });

  const schedule = useQuery<BackupScheduleResponse>({
    queryKey: ["backups", serverId, "schedule"],
    queryFn: () =>
      api<BackupScheduleResponse>(
        `/api/servers/${encodeURIComponent(serverId ?? "")}/backups/schedule`,
      ),
    enabled: Boolean(serverId),
    refetchInterval: 60_000,
    retry: 1,
  });
  const backupListFresh = backups.dataUpdatedAt > 0 && now - backups.dataUpdatedAt <= 35_000;
  const recoveryControlsAvailable = controlsAvailable && backupListFresh;
  const recoveryControlMessage = controlsAvailable
    ? "Backup history is stale — refresh it before using recovery controls."
    : controlMessage;

  const refreshBackups = async (changedServerId: string) => {
    await queryClient.invalidateQueries({ queryKey: ["backups", changedServerId] });
  };

  const createBackup = useMutation({
    mutationFn: (changedServerId: string) =>
      api<BackupMutationResponse>(`/api/servers/${encodeURIComponent(changedServerId)}/backups/`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: async (_result, changedServerId) => {
      setAnnouncement("Manual backup started. This list will update as the archive is created.");
      await refreshBackups(changedServerId);
    },
  });

  const stopRealm = useMutation({
    mutationFn: (changedServerId: string) => {
      const storageKey = `indexd:recovery-stop:${changedServerId}`;
      const requestKey =
        window.sessionStorage.getItem(storageKey) ?? `recovery-stop:${crypto.randomUUID()}`;
      window.sessionStorage.setItem(storageKey, requestKey);
      return api<StopActionResponse>(`/api/servers/${encodeURIComponent(changedServerId)}/action`, {
        method: "POST",
        body: JSON.stringify({ action: "stop", requestKey }),
      });
    },
    onSuccess: async (result, changedServerId) => {
      const receiptStatus = result.data.receipt.status;
      const outcome = operatorReceiptOutcome(receiptStatus);
      if (outcome.clearRequestKey) {
        window.sessionStorage.removeItem(`indexd:recovery-stop:${changedServerId}`);
      }
      setAnnouncement(
        outcome.completed
          ? "Stop completed with a durable receipt. Restore remains paused until stopped state is freshly observed."
          : outcome.pending
            ? "Stop accepted with a durable receipt. Completion has not been observed yet, so restore remains paused and the same request key is retained."
            : `Stop ${receiptStatus}. Completion was not observed, and the same request key is retained for a safe retry.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["servers"] });
    },
  });

  const restoreBackup = useMutation({
    mutationFn: ({ backupId, changedServerId }: { backupId: string; changedServerId: string }) =>
      api<BackupMutationResponse>(
        `/api/servers/${encodeURIComponent(changedServerId)}/backups/${encodeURIComponent(backupId)}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ confirmation: RESTORE_CONFIRMATION }),
        },
      ),
    onSuccess: async (_result, { changedServerId }) => {
      setAnnouncement(
        "Restore started. The realm will stay stopped while its world data is replaced.",
      );
      setRestoreBackupId(null);
      setRestoreAcknowledged(false);
      await Promise.all([
        refreshBackups(changedServerId),
        queryClient.invalidateQueries({ queryKey: ["servers"] }),
      ]);
    },
  });

  const deleteBackup = useMutation({
    mutationFn: ({ backupId, changedServerId }: { backupId: string; changedServerId: string }) =>
      api<BackupMutationResponse>(
        `/api/servers/${encodeURIComponent(changedServerId)}/backups/${encodeURIComponent(backupId)}`,
        { method: "DELETE" },
      ),
    onSuccess: async (_result, { changedServerId }) => {
      setAnnouncement("Backup deletion started. The archive will disappear when removal finishes.");
      setDeleteBackupId(null);
      await refreshBackups(changedServerId);
    },
  });

  function resetActionFeedback() {
    createBackup.reset();
    stopRealm.reset();
    restoreBackup.reset();
    deleteBackup.reset();
    setAnnouncement("");
  }

  if (serversPending) {
    return (
      <div className="backups-view">
        <div className="window-hero">
          <p className="eyebrow">Recovery Center</p>
          <h2>Loading snapshot history</h2>
          <p>Checking which backup history belongs to this account.</p>
        </div>
        <BackupLoadingRows />
      </div>
    );
  }

  if (serversError && servers.length === 0) {
    return (
      <div className="query-state error-state" role="alert">
        <CircleAlert aria-hidden="true" size={25} />
        <div>
          <h3>Recovery access could not be loaded</h3>
          <p>Your session is still active. Retry the connector without signing in again.</p>
        </div>
        <button className="inline-action" onClick={onRetryServers} type="button">
          <RefreshCw aria-hidden="true" size={15} /> Retry
        </button>
      </div>
    );
  }

  if (!selectedServer) {
    return (
      <div className="empty-state">
        <Server aria-hidden="true" size={29} />
        <h3>No workloads available for recovery</h3>
        <p>Snapshot recovery appears here after a compatible workload is provisioned.</p>
      </div>
    );
  }

  const backupRows = backups.data?.data ?? [];
  const busyBackup = backupRows.find((backup) => backupIsBusy(backup));
  const serverRunning = selectedServer.currentState === "running";
  const serverStopped = backupRestoreAllowed(selectedServer.currentState);
  const serverCanStop = selectedServer.currentState === "running";
  const stopReceiptStatus = stopRealm.data?.data.receipt.status;
  const stopReceiptOutcome = stopReceiptStatus ? operatorReceiptOutcome(stopReceiptStatus) : null;
  const stopWasRequested =
    stopRealm.isSuccess &&
    stopRealm.variables === selectedServer.id &&
    Boolean(stopReceiptOutcome?.pending || stopReceiptOutcome?.completed);
  const createDisabled =
    !recoveryControlsAvailable ||
    !serverRunning ||
    Boolean(busyBackup) ||
    createBackup.isPending ||
    stopRealm.isPending;
  const actionError =
    createBackup.error ?? stopRealm.error ?? restoreBackup.error ?? deleteBackup.error;
  const scheduleData = schedule.data?.data;

  return (
    <div className="backups-view">
      <div className="window-hero backups-hero">
        <p className="eyebrow">Recovery Center</p>
        <h2>Recovery for {selectedServer.name}</h2>
        <p>
          Automatic and manual snapshots share one recovery history. This connector manages world
          data only; live-rule rollback is a separate operation in the Trust Ledger.
        </p>
      </div>

      {!recoveryControlsAvailable ? (
        <div className="control-truth-banner" role="status">
          <CircleAlert aria-hidden="true" size={17} /> {recoveryControlMessage}
        </div>
      ) : null}

      <div className="recovery-scope-grid">
        <article>
          <Archive aria-hidden="true" size={18} />
          <div>
            <strong>Snapshot restore</strong>
            <span>
              Replaces world data and permanently discards newer world changes after explicit
              confirmation.
            </span>
          </div>
        </article>
        <article>
          <ShieldAlert aria-hidden="true" size={18} />
          <div>
            <strong>Rule rollback</strong>
            <span>Uses the reviewed deployment ledger; it never restores a world snapshot.</span>
          </div>
        </article>
      </div>

      <div className="backups-toolbar">
        <label className="backup-realm-picker">
          <span>Workload</span>
          <select
            onChange={(event) => onSelectServer(event.target.value)}
            value={selectedServer.id}
          >
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name} ({humanizeState(server.currentState)})
              </option>
            ))}
          </select>
        </label>

        <div className="backup-create-control">
          <button
            className="backup-primary-action"
            disabled={createDisabled}
            onClick={() => {
              resetActionFeedback();
              createBackup.mutate(selectedServer.id);
            }}
            title={
              !serverRunning
                ? "The workload must be running before a manual snapshot can start."
                : busyBackup
                  ? "Wait for the current backup operation to finish."
                  : undefined
            }
            type="button"
          >
            <Archive aria-hidden="true" size={16} />
            {createBackup.isPending ? "Starting backup…" : "Back up now"}
          </button>
          <p>
            {!serverRunning
              ? `Manual snapshots require a running workload. Current state: ${humanizeState(selectedServer.currentState)}.`
              : busyBackup
                ? `${backupStatusLabel(busyBackup)} ${busyBackup.name}.`
                : "Create an additional recovery point now."}
          </p>
        </div>
      </div>

      <section className="backup-schedule-section" aria-labelledby="backup-schedule-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Automatic protection</p>
            <h3 id="backup-schedule-title">Weekly schedule</h3>
          </div>
          {schedule.isFetching && !schedule.isPending ? (
            <RefreshCw className="refreshing" aria-label="Refreshing backup schedule" size={16} />
          ) : null}
        </div>

        {schedule.isPending ? (
          <div className="backup-schedule-skeleton" role="status">
            <span className="sr-only">Loading weekly backup schedule</span>
            <span />
            <span />
          </div>
        ) : null}

        {schedule.isError ? (
          <div className="backup-schedule-unavailable" role="alert">
            <CircleAlert aria-hidden="true" size={18} />
            <div>
              <strong>Schedule unavailable</strong>
              <span>Automatic backup timing could not be verified.</span>
            </div>
            <button onClick={() => void schedule.refetch()} type="button">
              Retry
            </button>
          </div>
        ) : null}

        {scheduleData ? (
          <div className={`backup-schedule-panel ${scheduleData.enabled ? "enabled" : "disabled"}`}>
            <div className="backup-schedule-primary">
              <span className="backup-schedule-icon" aria-hidden="true">
                <CalendarClock size={22} />
              </span>
              <div>
                <strong>
                  {scheduleData.enabled ? "Weekly backups are on" : "Weekly backups are off"}
                </strong>
                <span className="backup-schedule-description">
                  {scheduleData.enabled
                    ? weeklyScheduleLabel(scheduleData)
                    : "No automatic snapshot will be created for this workload."}
                </span>
              </div>
            </div>
            <dl className="backup-schedule-facts">
              <div>
                <dt>Next backup</dt>
                <dd>
                  {scheduleData.enabled
                    ? formatUtcDateTime(scheduleData.nextRunAt)
                    : "Not scheduled"}
                </dd>
              </div>
              <div>
                <dt>Last successful</dt>
                <dd>{formatUtcDateTime(scheduleData.lastSuccessfulAt)}</dd>
              </div>
              <div>
                <dt>Retention</dt>
                <dd>
                  {scheduleData.retentionCount} most recent{" "}
                  {scheduleData.retentionCount === 1 ? "backup" : "backups"}
                </dd>
              </div>
            </dl>
          </div>
        ) : null}
      </section>

      <section className="backup-history-section" aria-labelledby="backup-history-title">
        <div className="section-heading backup-history-heading">
          <div>
            <p className="eyebrow">Recovery points</p>
            <h3 id="backup-history-title">Backup history</h3>
          </div>
          <button
            aria-label={`Refresh backups for ${selectedServer.name}`}
            className="backup-refresh-button"
            disabled={backups.isFetching}
            onClick={() => void backups.refetch()}
            type="button"
          >
            <RefreshCw className={backups.isFetching ? "refreshing" : ""} size={16} />
          </button>
        </div>

        {backups.isPending ? <BackupLoadingRows /> : null}

        {backups.isError ? (
          <div className="query-state error-state backup-query-state" role="alert">
            <CircleAlert aria-hidden="true" size={24} />
            <div>
              <h3>Backup history could not be loaded</h3>
              <p>No archive actions were sent. Retry when the connector is available.</p>
            </div>
            <button className="inline-action" onClick={() => void backups.refetch()} type="button">
              <RefreshCw aria-hidden="true" size={15} /> Retry
            </button>
          </div>
        ) : null}

        {backups.isSuccess && backupRows.length === 0 ? (
          <div className="empty-state backup-empty-state">
            <Archive aria-hidden="true" size={29} />
            <h3>No backups yet</h3>
            <p>
              {scheduleData?.enabled
                ? "The first weekly archive will appear after its scheduled run. "
                : scheduleData
                  ? "Automatic backups are currently off. "
                  : "No automatic backup run has been verified yet. "}
              You can create a manual backup while the realm is running.
            </p>
          </div>
        ) : null}

        {backupRows.length > 0 ? (
          <div className="backup-list">
            {backupRows.map((backup) => {
              const busy = backupIsBusy(backup);
              const completed = backup.status === "completed" && !busy;
              const restoringThis = restoreBackupId === backup.id;
              const deletingThis = deleteBackupId === backup.id;
              const restorePending =
                restoreBackup.isPending && restoreBackup.variables?.backupId === backup.id;
              const deletePending =
                deleteBackup.isPending && deleteBackup.variables?.backupId === backup.id;

              return (
                <article className="backup-row" key={backup.id}>
                  <div className="backup-row-heading">
                    <div className="backup-name-block">
                      <span
                        className={`status-dot ${backupStatusTone(backup)}`}
                        aria-hidden="true"
                      />
                      <div>
                        <h4>{backup.name}</h4>
                        <div className="backup-tags">
                          <span>{backup.source === "scheduled" ? "Weekly" : "Manual"}</span>
                          <span>{formatBytes(backup.sizeBytes)}</span>
                        </div>
                      </div>
                    </div>
                    <span className={`state-label ${backupStatusTone(backup)}`}>
                      {backupStatusLabel(backup)}
                    </span>
                  </div>

                  <dl className="backup-meta-list">
                    <div>
                      <dt>Created</dt>
                      <dd>
                        <time dateTime={backup.createdAt}>
                          {formatUtcDateTime(backup.createdAt)}
                        </time>
                      </dd>
                    </div>
                    {backup.completedAt ? (
                      <div>
                        <dt>Completed</dt>
                        <dd>
                          <time dateTime={backup.completedAt}>
                            {formatUtcDateTime(backup.completedAt)}
                          </time>
                        </dd>
                      </div>
                    ) : null}
                    {backup.expiresAt ? (
                      <div>
                        <dt>Retained until</dt>
                        <dd>
                          <time dateTime={backup.expiresAt}>
                            {formatUtcDateTime(backup.expiresAt)}
                          </time>
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  <div className="backup-row-actions">
                    {completed ? (
                      <a
                        aria-label={`Download ${backup.name}`}
                        className="backup-secondary-action"
                        href={farlandsApiPath(
                          `/api/servers/${encodeURIComponent(selectedServer.id)}/backups/${encodeURIComponent(backup.id)}/download`,
                        )}
                      >
                        <Download aria-hidden="true" size={15} /> Download
                      </a>
                    ) : (
                      <span className="backup-secondary-action disabled" aria-disabled="true">
                        <Download aria-hidden="true" size={15} /> Download
                      </span>
                    )}
                    <button
                      aria-label={`Restore ${backup.name}`}
                      className="backup-secondary-action"
                      disabled={
                        !recoveryControlsAvailable ||
                        !completed ||
                        restoreMutationBusy(restoreBackup, deleteBackup)
                      }
                      onClick={() => {
                        resetActionFeedback();
                        setDeleteBackupId(null);
                        setRestoreAcknowledged(false);
                        setRestoreBackupId(backup.id);
                      }}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" size={15} /> Restore
                    </button>
                    <button
                      aria-label={`Delete ${backup.name}`}
                      className="backup-secondary-action danger"
                      disabled={
                        !recoveryControlsAvailable ||
                        busy ||
                        restoreMutationBusy(restoreBackup, deleteBackup)
                      }
                      onClick={() => {
                        resetActionFeedback();
                        setRestoreBackupId(null);
                        setRestoreAcknowledged(false);
                        setDeleteBackupId(backup.id);
                      }}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={15} /> Delete
                    </button>
                  </div>

                  {restoringThis ? (
                    <div className="backup-confirmation restore-confirmation">
                      <div className="backup-confirmation-copy">
                        <ShieldAlert aria-hidden="true" size={20} />
                        <div>
                          <h5>Restore {backup.name}?</h5>
                          <p>
                            This replaces the workload&apos;s current world with this archive. Every
                            block, item, and player change made after this backup will be
                            permanently discarded.
                          </p>
                        </div>
                      </div>

                      {!serverStopped ? (
                        <div className="restore-prerequisite">
                          <p>
                            {selectedServer.currentState === "ready" ? (
                              <>
                                <strong>Start, then stop the workload first.</strong> Restore stays
                                locked until the control plane has observed the exact stopped state
                                required by the backend.
                              </>
                            ) : (
                              <>
                                <strong>Stop the workload first.</strong> Stopping disconnects
                                current players. It does not begin the restore.
                              </>
                            )}
                          </p>
                          <button
                            className="backup-stop-action"
                            disabled={
                              !recoveryControlsAvailable ||
                              !serverCanStop ||
                              stopRealm.isPending ||
                              stopWasRequested
                            }
                            onClick={() => {
                              resetActionFeedback();
                              setRestoreBackupId(backup.id);
                              stopRealm.mutate(selectedServer.id);
                            }}
                            type="button"
                          >
                            <Power aria-hidden="true" size={15} />
                            {stopRealm.isPending
                              ? "Requesting stop…"
                              : stopReceiptOutcome?.pending ||
                                  selectedServer.currentState === "stopping"
                                ? "Stop accepted"
                                : stopReceiptOutcome?.completed
                                  ? "Stop completed; refreshing"
                                  : serverCanStop
                                    ? `Stop ${selectedServer.name}`
                                    : selectedServer.currentState === "ready"
                                      ? "Start in Operator Home first"
                                      : `Wait for ${humanizeState(selectedServer.currentState)}`}
                          </button>
                        </div>
                      ) : (
                        <>
                          <label className="restore-acknowledgement">
                            <input
                              checked={restoreAcknowledged}
                              onChange={(event) => setRestoreAcknowledged(event.target.checked)}
                              type="checkbox"
                            />
                            <span>
                              I understand that newer world data will be permanently lost.
                            </span>
                          </label>
                          <div className="backup-confirmation-actions">
                            <button
                              className="backup-danger-action"
                              disabled={
                                !recoveryControlsAvailable || !restoreAcknowledged || restorePending
                              }
                              onClick={() =>
                                restoreBackup.mutate({
                                  backupId: backup.id,
                                  changedServerId: selectedServer.id,
                                })
                              }
                              type="button"
                            >
                              <RotateCcw aria-hidden="true" size={15} />
                              {restorePending
                                ? "Starting restore…"
                                : "Restore and discard newer data"}
                            </button>
                            <button
                              className="backup-cancel-action"
                              disabled={restorePending}
                              onClick={() => {
                                setRestoreBackupId(null);
                                setRestoreAcknowledged(false);
                              }}
                              type="button"
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}

                  {deletingThis ? (
                    <div className="backup-confirmation delete-confirmation">
                      <div className="backup-confirmation-copy">
                        <CircleAlert aria-hidden="true" size={20} />
                        <div>
                          <h5>Delete {backup.name}?</h5>
                          <p>
                            This permanently removes the archive. It cannot be downloaded or used to
                            restore this realm afterward.
                          </p>
                        </div>
                      </div>
                      <div className="backup-confirmation-actions">
                        <button
                          className="backup-danger-action"
                          disabled={!recoveryControlsAvailable || deletePending}
                          onClick={() =>
                            deleteBackup.mutate({
                              backupId: backup.id,
                              changedServerId: selectedServer.id,
                            })
                          }
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={15} />
                          {deletePending ? "Deleting…" : "Delete backup permanently"}
                        </button>
                        <button
                          className="backup-cancel-action"
                          disabled={deletePending}
                          onClick={() => setDeleteBackupId(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : null}
      </section>

      {actionError ? (
        <div className="backup-feedback error" role="alert">
          <CircleAlert aria-hidden="true" size={18} />
          <span>{actionErrorMessage(actionError)}</span>
        </div>
      ) : null}

      {announcement ? (
        <div className="backup-feedback success" role="status">
          <Archive aria-hidden="true" size={18} />
          <span>{announcement}</span>
        </div>
      ) : null}
    </div>
  );
}

function restoreMutationBusy(
  restoreMutation: { isPending: boolean },
  deleteMutation: { isPending: boolean },
): boolean {
  return restoreMutation.isPending || deleteMutation.isPending;
}
