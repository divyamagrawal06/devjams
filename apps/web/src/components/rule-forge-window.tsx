"use client";

import { useMutation } from "@tanstack/react-query";
import { Check, CircleAlert, FileJson2, Hammer, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api, type ChangeDetailResponse, type LiveServer } from "@/lib/api";
import { shortDigest } from "@/lib/control-events";

function starterDocument(version: string | null | undefined) {
  return JSON.stringify(
    {
      metadata: {
        pluginName: "WelcomeRules",
        minecraftVersion: version || "1.20.4",
      },
      onPlayerJoin: {
        privateMessage: "Welcome to the realm.",
      },
    },
    null,
    2,
  );
}

export function RuleForgeWindow({
  onOpenReview,
  servers,
}: {
  onOpenReview: (changeId: string) => void;
  servers: LiveServer[];
}) {
  const minecraftServers = useMemo(
    () => servers.filter((server) => server.game.toLowerCase() === "minecraft"),
    [servers],
  );
  const [serverId, setServerId] = useState("");
  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [documentText, setDocumentText] = useState(starterDocument(null));
  const [parseError, setParseError] = useState<string | null>(null);

  const selectedServer = minecraftServers.find((server) => server.id === serverId) ?? null;

  useEffect(() => {
    if (!serverId && minecraftServers[0]) {
      setServerId(minecraftServers[0].id);
      setDocumentText(starterDocument(minecraftServers[0].version));
    }
  }, [minecraftServers, serverId]);

  const draft = useMutation({
    mutationFn: (document: unknown) =>
      api<ChangeDetailResponse>("/api/changes", {
        method: "POST",
        body: JSON.stringify({ serverId, title, rationale, document }),
      }),
  });
  const createdChangeId = draft.data?.data.id ?? null;

  function submitDraft() {
    draft.reset();
    setParseError(null);
    let document: unknown;
    try {
      document = JSON.parse(documentText);
    } catch (error) {
      setParseError(
        error instanceof Error ? error.message : "The rule document is not valid JSON.",
      );
      return;
    }
    draft.mutate(document);
  }

  if (minecraftServers.length === 0) {
    return (
      <div className="query-state">
        <Hammer aria-hidden="true" size={27} />
        <div>
          <h3>No Minecraft workload is available</h3>
          <p>
            Rule Forge is intentionally limited to the reviewed Minecraft rule runtime. Other
            workload types remain unchanged.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="forge-view">
      <div className="window-hero forge-hero">
        <p className="eyebrow">Bounded JSON authoring</p>
        <h2>Draft an immutable rule artifact</h2>
        <p>
          This form builds only the reviewed rule vocabulary. Saving creates a digest-pinned review
          envelope; it cannot approve or deploy the change.
        </p>
      </div>

      <form
        className="forge-form"
        onSubmit={(event) => {
          event.preventDefault();
          submitDraft();
        }}
      >
        <div className="forge-fields-row">
          <label>
            Minecraft workload
            <select
              onChange={(event) => {
                const nextId = event.target.value;
                setServerId(nextId);
                const next = minecraftServers.find((server) => server.id === nextId);
                setDocumentText(starterDocument(next?.version));
                draft.reset();
              }}
              value={serverId}
            >
              {minecraftServers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name} · {server.version || "runtime version pending"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Review title
            <input
              maxLength={120}
              minLength={3}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Welcome message for event night"
              required
              value={title}
            />
          </label>
        </div>

        <label>
          Why this change is useful
          <textarea
            className="forge-rationale"
            maxLength={2000}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Explain the operator intent and what reviewers should check."
            required
            value={rationale}
          />
        </label>

        <label>
          Effective rule document
          <span className="field-help">
            Unknown fields are removed by the validator; stateful fields are rejected. Runtime must
            match the pinned candidate runtime exactly.
          </span>
          <textarea
            aria-describedby="forge-document-note"
            className="forge-document"
            onChange={(event) => {
              setDocumentText(event.target.value);
              setParseError(null);
              draft.reset();
            }}
            spellCheck={false}
            value={documentText}
          />
        </label>

        <div className="forge-boundary" id="forge-document-note">
          <ShieldCheck aria-hidden="true" size={18} />
          <span>
            Source is recorded as a human form. This surface cannot claim Director or agent
            provenance and never generates Java, shell, or Kubernetes code.
          </span>
        </div>

        {parseError || draft.isError ? (
          <div className="operation-feedback error" role="alert">
            <CircleAlert aria-hidden="true" size={18} />
            <span>{parseError || (draft.error as Error).message}</span>
          </div>
        ) : null}

        {draft.data && createdChangeId ? (
          <div className="operation-feedback success" role="status">
            <Check aria-hidden="true" size={18} />
            <div>
              <strong>Immutable version {draft.data.data.ruleVersion} is ready for review.</strong>
              <span>
                Deployable artifact {shortDigest(draft.data.data.artifactDigest)}. Nothing has been
                deployed.
              </span>
            </div>
            <button
              className="operation-secondary-action"
              onClick={() => onOpenReview(createdChangeId)}
              type="button"
            >
              Open review
            </button>
          </div>
        ) : null}

        <div className="forge-submit-row">
          <p>
            {selectedServer
              ? `Target: ${selectedServer.name}. Saving writes a review record only.`
              : "Choose a target workload."}
          </p>
          <button
            className="operation-primary-action"
            disabled={draft.isPending || !serverId || title.trim().length < 3 || !rationale.trim()}
            type="submit"
          >
            <FileJson2 aria-hidden="true" size={17} />
            {draft.isPending ? "Building exact artifact…" : "Build review draft"}
          </button>
        </div>
      </form>
    </div>
  );
}
