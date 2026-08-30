"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Copy, KeyRound, RefreshCw, Terminal, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { api, type MachineTokenListResponse, type MintedMachineToken } from "@/lib/api";

function date(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

async function copyText(value: string) {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
  await navigator.clipboard.writeText(value);
}

export function AgentConnectionsPanel({
  controlMessage,
  controlsAvailable,
}: {
  controlMessage: string;
  controlsAvailable: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("My workstation");
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [minted, setMinted] = useState<MintedMachineToken | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const tokens = useQuery<MachineTokenListResponse>({
    queryKey: ["machine-tokens"],
    queryFn: () => api<MachineTokenListResponse>("/api/machine-tokens"),
    staleTime: 10_000,
    retry: 1,
  });
  const mint = useMutation({
    mutationFn: () =>
      api<MintedMachineToken>("/api/machine-tokens", {
        method: "POST",
        body: JSON.stringify({ name, expires_in_days: expiresInDays }),
      }),
    onSuccess: (credential) => {
      setMinted(credential);
      setCopyState(null);
      void queryClient.invalidateQueries({ queryKey: ["machine-tokens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<{ revoked: boolean }>(`/api/machine-tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setConfirmRevoke(null);
      void queryClient.invalidateQueries({ queryKey: ["machine-tokens"] });
    },
  });

  const apiUrl = process.env.NEXT_PUBLIC_FARLANDS_API_URL?.trim() || "<YOUR_FARLANDS_API_URL>";
  const cliSnippet = minted
    ? `export FARLANDS_API_URL="${apiUrl}"\nexport FARLANDS_TOKEN="${minted.token}"\nfarlands servers list`
    : `export FARLANDS_API_URL="${apiUrl}"\nexport FARLANDS_TOKEN="<COPY_ONCE_TOKEN>"\nfarlands servers list`;
  const mcpSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            farlands: {
              command: "bun",
              args: ["run", "--cwd", "/path/to/farlands-live/apps/mcp", "start"],
              env: {
                FARLANDS_API_URL: apiUrl,
                FARLANDS_MACHINE_TOKEN: minted?.token ?? "<COPY_ONCE_TOKEN>",
              },
            },
          },
        },
        null,
        2,
      ),
    [apiUrl, minted?.token],
  );

  const copy = async (label: string, value: string) => {
    try {
      await copyText(value);
      setCopyState(`${label} copied.`);
    } catch (error) {
      setCopyState(error instanceof Error ? error.message : "Copy failed.");
    }
  };

  return (
    <section className="agent-connections" aria-labelledby="agent-connections-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Machine access</p>
          <h3 id="agent-connections-title">CLI and MCP connections</h3>
        </div>
        <KeyRound aria-hidden="true" size={20} />
      </div>
      <p className="agent-connections-intro">
        Machine tokens authenticate one tool installation. They cannot create a human session or
        approve a deployment. Live actions still require a separate, short-lived human approval.
      </p>

      {!controlsAvailable ? (
        <div className="control-truth-banner" role="status">
          <CircleAlert aria-hidden="true" size={17} /> {controlMessage}
        </div>
      ) : null}

      <form
        className="agent-token-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (controlsAvailable) mint.mutate();
        }}
      >
        <label>
          Connection name
          <input
            autoComplete="off"
            maxLength={80}
            minLength={1}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        <label>
          Expires in days
          <input
            inputMode="numeric"
            max={365}
            min={1}
            onChange={(event) => setExpiresInDays(Number(event.target.value))}
            required
            type="number"
            value={expiresInDays}
          />
        </label>
        <button
          className="operation-primary-action"
          disabled={!controlsAvailable || mint.isPending || !name.trim()}
          type="submit"
        >
          <KeyRound aria-hidden="true" size={16} />
          {mint.isPending ? "Issuing…" : "Issue machine token"}
        </button>
      </form>
      {mint.isError ? (
        <p className="auth-error" role="alert">
          {mint.error.message}
        </p>
      ) : null}

      {minted ? (
        <div className="copy-once-token" role="status">
          <div>
            <strong>Copy this token now</strong>
            <span>It is shown once and is never stored in this browser.</span>
          </div>
          <code>{minted.token}</code>
          <div className="copy-once-actions">
            <button onClick={() => void copy("Token", minted.token)} type="button">
              <Copy aria-hidden="true" size={16} /> Copy token
            </button>
            <button
              onClick={() => {
                setMinted(null);
                setCopyState(null);
              }}
              type="button"
            >
              <X aria-hidden="true" size={16} /> I saved it
            </button>
          </div>
        </div>
      ) : null}

      <div className="agent-setup-grid">
        <article>
          <div className="agent-setup-heading">
            <span>
              <Terminal aria-hidden="true" size={17} /> CLI environment
            </span>
            <button onClick={() => void copy("CLI setup", cliSnippet)} type="button">
              <Copy aria-hidden="true" size={15} /> Copy
            </button>
          </div>
          <pre>{cliSnippet}</pre>
        </article>
        <article>
          <div className="agent-setup-heading">
            <span>
              <Terminal aria-hidden="true" size={17} /> MCP stdio
            </span>
            <button onClick={() => void copy("MCP setup", mcpSnippet)} type="button">
              <Copy aria-hidden="true" size={15} /> Copy
            </button>
          </div>
          <pre>{mcpSnippet}</pre>
          <p>Replace the repository path with the checkout that contains the MCP workspace.</p>
        </article>
      </div>
      {apiUrl.startsWith("<") ? (
        <p className="agent-setup-warning">
          <CircleAlert aria-hidden="true" size={16} /> The public API URL is not published to this
          dashboard. Replace the placeholder with the control-plane URL from your operator.
        </p>
      ) : null}
      {copyState ? <p className="copy-feedback">{copyState}</p> : null}

      <div className="agent-token-list-heading">
        <h4>Issued connections</h4>
        <button
          aria-label="Refresh machine tokens"
          disabled={tokens.isFetching}
          onClick={() => void tokens.refetch()}
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={tokens.isFetching ? "refreshing" : ""}
            size={16}
          />
          Refresh
        </button>
      </div>
      {tokens.isPending ? <p role="status">Loading issued connections…</p> : null}
      {tokens.isError ? (
        <p className="auth-error" role="alert">
          Issued connections are unavailable. No token state was assumed.
        </p>
      ) : null}
      {tokens.data?.items.length === 0 ? <p>No machine connections have been issued.</p> : null}
      {tokens.data?.items.length ? (
        <ul className="agent-token-list">
          {tokens.data.items.map((token) => (
            <li key={token.id}>
              <div>
                <strong>{token.name}</strong>
                <span>
                  {token.active ? `Expires ${date(token.expires_at)}` : "Inactive"} · issued{" "}
                  {date(token.created_at)}
                </span>
              </div>
              {token.active ? (
                confirmRevoke === token.id ? (
                  <div className="revoke-confirmation">
                    <span>Revoke this connection?</span>
                    <button
                      disabled={!controlsAvailable || revoke.isPending}
                      onClick={() => revoke.mutate(token.id)}
                      type="button"
                    >
                      Confirm revoke
                    </button>
                    <button onClick={() => setConfirmRevoke(null)} type="button">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    disabled={!controlsAvailable}
                    onClick={() => setConfirmRevoke(token.id)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={15} /> Revoke
                  </button>
                )
              ) : (
                <span className="agent-token-inactive">Revoked or expired</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {revoke.isError ? (
        <p className="auth-error" role="alert">
          {revoke.error.message}
        </p>
      ) : null}
    </section>
  );
}
