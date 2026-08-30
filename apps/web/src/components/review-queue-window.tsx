"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  ClipboardCheck,
  FileJson2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  api,
  type ChangeDetailResponse,
  type ChangeEnvelope,
  type ChangeListResponse,
} from "@/lib/api";
import { shortDigest } from "@/lib/control-events";

function reviewStatusLabel(status: ChangeEnvelope["status"]) {
  if (status === "pending_review") return "Needs review";
  return status === "approved" ? "Approved" : "Rejected";
}

function timestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ReviewQueueWindow({
  controlMessage,
  controlsAvailable,
  onSelectChange,
  selectedChangeId,
}: {
  controlMessage: string;
  controlsAvailable: boolean;
  onSelectChange: (id: string) => void;
  selectedChangeId: string | null;
}) {
  const queryClient = useQueryClient();
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(interval);
  }, []);

  const changes = useQuery<ChangeListResponse>({
    queryKey: ["changes"],
    queryFn: () => api<ChangeListResponse>("/api/changes"),
    refetchInterval: 10_000,
    retry: 1,
  });
  const ordered = useMemo(() => {
    const rows = changes.data?.data ?? [];
    return [...rows].sort((left, right) => {
      if (left.status === "pending_review" && right.status !== "pending_review") return -1;
      if (right.status === "pending_review" && left.status !== "pending_review") return 1;
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    });
  }, [changes.data?.data]);

  useEffect(() => {
    if (selectedChangeId || !ordered[0]) return;
    onSelectChange(ordered[0].id);
  }, [onSelectChange, ordered, selectedChangeId]);

  const detail = useQuery<ChangeDetailResponse>({
    queryKey: ["changes", selectedChangeId],
    queryFn: () => {
      if (!selectedChangeId) throw new Error("No change is selected");
      return api<ChangeDetailResponse>(`/api/changes/${encodeURIComponent(selectedChangeId)}`);
    },
    enabled: Boolean(selectedChangeId),
    refetchInterval: (query) =>
      query.state.data?.data.deploymentId &&
      !["idle", "failed", "aborted"].includes(query.state.data.data.deploymentState ?? "")
        ? 2_000
        : 15_000,
    retry: 1,
  });
  const detailFresh = detail.dataUpdatedAt > 0 && now - detail.dataUpdatedAt <= 30_000;
  const reviewControlsAvailable = controlsAvailable && detailFresh;
  const reviewControlMessage = controlsAvailable
    ? "Review evidence is stale — refresh the exact envelope before deciding."
    : controlMessage;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["changes"] });
  };

  const approve = useMutation({
    mutationFn: ({ id, digest }: { id: string; digest: string }) =>
      api<ChangeDetailResponse>(`/api/changes/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        headers: { "if-match": `"${digest}"` },
      }),
    onSuccess: async () => {
      setReviewConfirmed(false);
      await refresh();
    },
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<ChangeDetailResponse>(`/api/changes/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onSuccess: async () => {
      setRejecting(false);
      setRejectionReason("");
      await refresh();
    },
  });

  useEffect(() => {
    if (selectedChangeId === null) return;
    setReviewConfirmed(false);
    setRejecting(false);
    setRejectionReason("");
  }, [selectedChangeId]);

  if (changes.isPending) {
    return (
      <div className="query-state" role="status">
        <ClipboardCheck aria-hidden="true" size={27} />
        <div>
          <h3>Loading the durable review queue</h3>
          <p>Resolving immutable artifacts and deployment receipts for this account.</p>
        </div>
      </div>
    );
  }

  if (changes.isError) {
    return (
      <div className="query-state error-state" role="alert">
        <CircleAlert aria-hidden="true" size={27} />
        <div>
          <h3>The review queue is unavailable</h3>
          <p>No approval controls are shown while the durable queue cannot be verified.</p>
        </div>
        <button className="inline-action" onClick={() => void changes.refetch()} type="button">
          <RefreshCw aria-hidden="true" size={15} /> Retry
        </button>
      </div>
    );
  }

  if (ordered.length === 0) {
    return (
      <div className="query-state">
        <ClipboardCheck aria-hidden="true" size={27} />
        <div>
          <h3>No changes are waiting</h3>
          <p>Rule Forge drafts appear here only after the exact artifact has been built.</p>
        </div>
      </div>
    );
  }

  const selected = detail.data?.data;
  const mutationError =
    approve.variables?.id === selected?.id
      ? approve.error
      : reject.variables?.id === selected?.id
        ? reject.error
        : null;

  return (
    <div className="review-layout">
      <aside className="review-list" aria-label="Change envelopes">
        <div className="review-list-heading">
          <div>
            <p className="eyebrow">Human gate</p>
            <h2>Review Queue</h2>
          </div>
          <button aria-label="Refresh review queue" onClick={() => void refresh()} type="button">
            <RefreshCw aria-hidden="true" size={16} />
          </button>
        </div>
        {ordered.map((change) => (
          <button
            aria-current={selectedChangeId === change.id ? "true" : undefined}
            className={`review-list-item ${selectedChangeId === change.id ? "selected" : ""}`}
            key={change.id}
            onClick={() => onSelectChange(change.id)}
            type="button"
          >
            <span className={`review-status ${change.status}`}>
              {reviewStatusLabel(change.status)}
            </span>
            <strong>{change.title}</strong>
            <span>{change.serverName}</span>
            <small>
              v{change.ruleVersion} · {shortDigest(change.artifactDigest)}
            </small>
          </button>
        ))}
      </aside>

      <section className="review-detail" aria-live="polite">
        {!reviewControlsAvailable && selected ? (
          <div className="control-truth-banner" role="status">
            <CircleAlert aria-hidden="true" size={17} /> {reviewControlMessage}
          </div>
        ) : null}
        {detail.isPending ? (
          <div className="query-state" role="status">
            <FileJson2 aria-hidden="true" size={25} />
            <p>Loading exact review evidence…</p>
          </div>
        ) : null}
        {detail.isError ? (
          <div className="query-state error-state" role="alert">
            <CircleAlert aria-hidden="true" size={25} />
            <p>The selected envelope could not be verified. Approval remains disabled.</p>
          </div>
        ) : null}
        {selected ? (
          <>
            <header className="review-detail-heading">
              <div>
                <span className={`review-status ${selected.status}`}>
                  {reviewStatusLabel(selected.status)}
                </span>
                <h2>{selected.title}</h2>
                <p>{selected.rationale}</p>
              </div>
              <dl>
                <div>
                  <dt>Workload</dt>
                  <dd>{selected.serverName}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{selected.source}</dd>
                </div>
                <div>
                  <dt>Runtime</dt>
                  <dd>Minecraft {selected.runtimeMinecraftVersion}</dd>
                </div>
              </dl>
            </header>

            <div className="review-digests">
              <div>
                <span>Deployable artifact — approval binds this exact digest</span>
                <code>{selected.artifactDigest}</code>
              </div>
              <div>
                <span>Canonical JSON content</span>
                <code>{selected.contentDigest}</code>
              </div>
              <div>
                <span>Reviewed runtime</span>
                <code>{selected.runtimeDigest}</code>
              </div>
            </div>

            <section className="review-section" aria-labelledby="semantic-diff-heading">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Semantic preview</p>
                  <h3 id="semantic-diff-heading">What will change</h3>
                </div>
              </div>
              {selected.diff.length ? (
                <ul className="review-diff">
                  {selected.diff.map((entry) => (
                    <li className={entry.kind} key={`${entry.kind}-${entry.path}`}>
                      <span>{entry.kind}</span>
                      {entry.summary}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="review-empty-note">
                  No prior approved artifact exists; every field is new.
                </p>
              )}
              <details className="review-document">
                <summary>Inspect effective JSON</summary>
                <pre>{JSON.stringify(selected.document, null, 2)}</pre>
              </details>
            </section>

            {selected.status === "pending_review" ? (
              <section className="review-decision" aria-labelledby="review-decision-heading">
                <div>
                  <p className="eyebrow">Explicit human decision</p>
                  <h3 id="review-decision-heading">Approve or reject this envelope</h3>
                </div>
                <label className="review-acknowledgement">
                  <input
                    checked={reviewConfirmed}
                    onChange={(event) => setReviewConfirmed(event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    I reviewed the effective JSON and artifact digest above. Approval starts a
                    candidate deployment; it does not skip health checks or cutover safeguards.
                  </span>
                </label>

                {rejecting ? (
                  <div className="review-reject-form">
                    <label>
                      Rejection reason
                      <textarea
                        maxLength={1000}
                        onChange={(event) => setRejectionReason(event.target.value)}
                        placeholder="Explain what should change before this is reconsidered."
                        value={rejectionReason}
                      />
                    </label>
                    <div>
                      <button
                        className="operation-secondary-action"
                        onClick={() => setRejecting(false)}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="operation-danger-action"
                        disabled={
                          !reviewControlsAvailable || !rejectionReason.trim() || reject.isPending
                        }
                        onClick={() =>
                          reject.mutate({ id: selected.id, reason: rejectionReason.trim() })
                        }
                        type="button"
                      >
                        <X aria-hidden="true" size={16} />
                        {reject.isPending ? "Recording…" : "Record rejection"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="review-actions">
                    <button
                      className="operation-danger-action"
                      disabled={!reviewControlsAvailable || approve.isPending}
                      onClick={() => setRejecting(true)}
                      type="button"
                    >
                      <X aria-hidden="true" size={16} /> Reject with reason
                    </button>
                    <button
                      className="operation-primary-action"
                      disabled={!reviewControlsAvailable || !reviewConfirmed || approve.isPending}
                      onClick={() =>
                        approve.mutate({ id: selected.id, digest: selected.artifactDigest })
                      }
                      type="button"
                    >
                      <ShieldCheck aria-hidden="true" size={16} />
                      {approve.isPending ? "Issuing exact approval…" : "Approve & start candidate"}
                    </button>
                  </div>
                )}
              </section>
            ) : (
              <div
                className={`operation-feedback ${selected.status === "approved" ? "success" : "error"}`}
              >
                {selected.status === "approved" ? (
                  <Check aria-hidden="true" size={18} />
                ) : (
                  <X aria-hidden="true" size={18} />
                )}
                <div>
                  <strong>
                    {selected.status === "approved"
                      ? `Approved ${selected.reviewedAt ? timestamp(selected.reviewedAt) : ""}`
                      : "Rejected by a human reviewer"}
                  </strong>
                  <span>
                    {selected.status === "approved"
                      ? `Deployment ${selected.deploymentId} is ${selected.deploymentState ?? "queued"}.`
                      : selected.rejectionReason}
                  </span>
                </div>
              </div>
            )}

            {mutationError ? (
              <div className="operation-feedback error" role="alert">
                <CircleAlert aria-hidden="true" size={18} />
                <span>{(mutationError as Error).message}</span>
              </div>
            ) : null}

            <section className="review-section" aria-labelledby="timeline-heading">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Trust ledger</p>
                  <h3 id="timeline-heading">Durable receipts</h3>
                </div>
              </div>
              <ol className="change-timeline">
                {selected.timeline.map((event) => (
                  <li key={event.id}>
                    <span className="timeline-marker" aria-hidden="true" />
                    <div>
                      <strong>{event.type.replaceAll("_", " ")}</strong>
                      <span>
                        {typeof event.data.detail === "string"
                          ? event.data.detail
                          : "Receipt recorded"}
                      </span>
                      <time dateTime={event.createdAt}>{timestamp(event.createdAt)}</time>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </>
        ) : null}
      </section>
    </div>
  );
}
