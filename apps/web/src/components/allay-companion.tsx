"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Check,
  CircleAlert,
  Copy,
  HelpCircle,
  Power,
  RefreshCw,
  Send,
  Server,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type AllayCreateIntent,
  type AllayIntent,
  type AllayPowerAction,
  createTemplateLabel,
  findMentionedServer,
  parseAllayIntent,
} from "@/lib/allay-intent";
import { api, joinAddress, type LiveServer } from "@/lib/api";

type ConnectorState = "checking" | "connected" | "unavailable";
type TargetIntent = Extract<AllayIntent, { kind: "status" | "copy" | "power" }>;

type AllayMessage = {
  id: number;
  from: "allay" | "operator";
  text: string;
  tone?: "normal" | "success" | "error";
};

type PowerActionResponse = {
  success: boolean;
  data: {
    success: boolean;
    action: AllayPowerAction;
    status: string;
  };
};

type CreateServerResponse = {
  success: boolean;
  message?: string;
  data?: {
    id?: string;
  };
};

type PendingConfirmation = {
  action: "stop" | "restart";
  serverId: string;
};

type AllayCompanionProps = {
  connectorState: ConnectorState;
  operatorName: string;
  refreshServers: () => Promise<unknown>;
  servers: LiveServer[] | undefined;
  serversLoading: boolean;
};

const TRANSITIONAL_STATES = new Set(["provisioning", "starting", "stopping", "restarting"]);

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function actionLabel(action: AllayPowerAction) {
  if (action === "start") return "start";
  if (action === "stop") return "stop";
  return "restart";
}

function actionProgress(action: AllayPowerAction) {
  if (action === "start") return "Starting";
  if (action === "stop") return "Stopping";
  return "Restarting";
}

function workloadNoun(server: LiveServer): "realm" | "server" | "site" {
  const game = server.game.toLocaleLowerCase();
  if (game === "node") return "site";
  if (game === "minecraft" || game === "minecraft_bedrock") return "realm";
  return "server";
}

function accessNoun(server: LiveServer): string {
  if (workloadNoun(server) === "site") return "site URL";
  if (workloadNoun(server) === "realm") return "join address";
  return "server address";
}

function copiedAccessMessage(server: LiveServer): string {
  const address = joinAddress(server);
  const game = server.game.toLocaleLowerCase();
  if (game === "node") return `${address} is copied. Open ${server.name} in a browser.`;
  if (game === "minecraft" || game === "minecraft_bedrock") {
    return `${address} is copied. Paste it into Minecraft to join ${server.name}.`;
  }
  return `${address} is copied. Use it to connect to ${server.name}.`;
}

function createSummary(intent: AllayCreateIntent): string {
  const { body } = intent;
  const defaultFile = intent.template === "node_static" ? " It includes a default index.html." : "";
  return `${createTemplateLabel(intent.template)} named ${body.name}: ${body.game}/${body.type}, version ${body.version}, ${body.cpuCores} CPU, ${body.ramMb} MB memory, ${body.storageGb} GB storage.${defaultFile}`;
}

function stateSummary(server: LiveServer, connectorState: ConnectorState) {
  const address = server.hostname
    ? ` Its ${accessNoun(server)} is ${joinAddress(server)}.`
    : ` Its ${accessNoun(server)} is pending.`;
  const freshness =
    connectorState === "unavailable"
      ? " The connector is offline, so this is the last loaded state."
      : "";
  return `${server.name} is ${humanize(server.currentState).toLocaleLowerCase()}.${address}${freshness}`;
}

function listSummary(servers: LiveServer[], connectorState: ConnectorState) {
  const summary = servers
    .map((server, index) => `${index + 1}. ${server.name}: ${humanize(server.currentState)}`)
    .join("\n");
  const freshness =
    connectorState === "unavailable"
      ? "\nThese are the last loaded states because the connector is offline."
      : "";
  return `${summary}${freshness}`;
}

function controlErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "The control plane did not accept that command.";
  const raw = error.message.replace(/^\d{3}\s+/, "");

  try {
    const parsed = JSON.parse(raw) as { error?: string; message?: string };
    return parsed.message ?? parsed.error ?? "The control plane did not accept that command.";
  } catch {
    if (/^\d{3}\b/.test(error.message)) {
      return "The control plane did not accept that command.";
    }
    return raw || "The control plane did not accept that command.";
  }
}

function AllaySprite({ busy }: { busy: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={busy ? "allay-sprite is-busy" : "allay-sprite"}
      shapeRendering="crispEdges"
      viewBox="0 0 88 92"
    >
      <g className="allay-wing allay-wing-left">
        <path d="M28 24H16v7H9v28h7v8h15V52h5V31h-8z" />
        <path className="allay-wing-light" d="M18 34h10v22H18z" />
      </g>
      <g className="allay-wing allay-wing-right">
        <path d="M60 24h12v7h7v28h-7v8H57V52h-5V31h8z" />
        <path className="allay-wing-light" d="M60 34h10v22H60z" />
      </g>
      <path className="allay-body-shadow" d="M31 48h26v31h-7v9H38v-9h-7z" />
      <path className="allay-body" d="M35 47h18v30h-5v8h-8v-8h-5z" />
      <path className="allay-head-shadow" d="M24 12h40v37H24z" />
      <path className="allay-head" d="M28 9h35v36H28z" />
      <path className="allay-face" d="M31 24h29v17H31z" />
      <path className="allay-eye" d="M34 27h8v8h-8zm16 0h8v8h-8z" />
      <path className="allay-eye-shine" d="M35 28h3v3h-3zm16 0h3v3h-3z" />
      <path className="allay-mouth" d="M43 37h7v2h-7z" />
      <path className="allay-arm" d="M27 52h8v22h-8zm26 0h8v22h-8z" />
    </svg>
  );
}

export function AllayCompanion({
  connectorState,
  operatorName,
  refreshServers,
  servers,
  serversLoading,
}: AllayCompanionProps) {
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<AllayMessage[]>([
    {
      id: 1,
      from: "allay",
      text: `Hi ${operatorName}. I can create game servers and Node sites, then check, start, stop, restart, or copy access details for your workloads.`,
    },
  ]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<TargetIntent | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingCreate, setPendingCreate] = useState<AllayCreateIntent | null>(null);
  const [busyAction, setBusyAction] = useState<{
    action: AllayPowerAction;
    serverId: string;
  } | null>(null);
  const [busyCreate, setBusyCreate] = useState<AllayCreateIntent | null>(null);
  const messageId = useRef(2);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const availableServers = servers ?? [];
  const busyServer = busyAction
    ? availableServers.find((server) => server.id === busyAction.serverId)
    : null;
  const busy = Boolean(busyAction || busyCreate);

  const connectionLabel =
    connectorState === "connected"
      ? "Control plane connected"
      : connectorState === "unavailable"
        ? "Connector unavailable"
        : "Checking connection";
  const transcriptRevision =
    messages.length +
    Number(Boolean(pendingSelection)) +
    Number(Boolean(pendingConfirmation)) +
    Number(Boolean(pendingCreate)) +
    Number(busy);

  const quickCommands = useMemo(() => {
    const commands: Array<{ label: string; prompt: string; icon: typeof Server }> = [];
    const stopped = availableServers.find((server) =>
      ["stopped", "ready", "failed"].includes(server.currentState.toLocaleLowerCase()),
    );
    const running = availableServers.find(
      (server) => server.currentState.toLocaleLowerCase() === "running",
    );

    if (stopped) {
      commands.push({ label: `Wake ${stopped.name}`, prompt: `Wake ${stopped.name}`, icon: Power });
    }
    if (running) {
      commands.push({
        label: `Copy ${running.name}`,
        prompt: `Copy the ${accessNoun(running)} for ${running.name}`,
        icon: Copy,
      });
    }
    commands.push({ label: "Workload status", prompt: "Show my workloads", icon: Server });
    if (!running && !stopped) {
      commands.push({
        label: "New Valheim server",
        prompt: "Create a Valheim server named vikings",
        icon: Power,
      });
      commands.push({
        label: "Host a Node site",
        prompt: "Host a Node website called portfolio",
        icon: HelpCircle,
      });
    }
    return commands.slice(0, 3);
  }, [availableServers]);

  useEffect(() => {
    void transcriptRevision;
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [transcriptRevision, reducedMotion]);

  function appendMessage(from: AllayMessage["from"], text: string, tone?: AllayMessage["tone"]) {
    setMessages((items) => [...items, { id: messageId.current++, from, text, tone }]);
  }

  function selectedServer(serverId: string) {
    return availableServers.find((server) => server.id === serverId) ?? null;
  }

  function explainNoServers() {
    if (serversLoading) {
      appendMessage("allay", "I’m still checking which workloads belong to this account.");
      return;
    }
    if (connectorState === "unavailable") {
      appendMessage(
        "allay",
        "I can’t reach the control plane right now, so I can’t safely inspect or change a workload.",
        "error",
      );
      return;
    }
    appendMessage(
      "allay",
      "I don’t see any workloads assigned to this account yet. I can create one when you are ready.",
    );
  }

  function validatePowerAction(server: LiveServer, action: AllayPowerAction) {
    const state = server.currentState.toLocaleLowerCase();

    if (action === "start" && ["running", "starting", "restarting"].includes(state)) {
      appendMessage("allay", `${server.name} is already ${humanize(state).toLocaleLowerCase()}.`);
      return false;
    }
    if (action === "stop" && ["stopped", "ready", "stopping"].includes(state)) {
      appendMessage("allay", `${server.name} is already ${humanize(state).toLocaleLowerCase()}.`);
      return false;
    }
    if (action === "restart" && state !== "running") {
      appendMessage(
        "allay",
        `${server.name} is ${humanize(state).toLocaleLowerCase()}, so the control plane will not restart it.`,
      );
      return false;
    }
    if (TRANSITIONAL_STATES.has(state)) {
      appendMessage(
        "allay",
        `${server.name} is ${humanize(state).toLocaleLowerCase()}. Let that finish before sending another power command.`,
      );
      return false;
    }
    return true;
  }

  function requestCreate(intent: AllayCreateIntent) {
    setPendingSelection(null);
    setPendingConfirmation(null);
    setPendingCreate(intent);
    appendMessage(
      "allay",
      `Please confirm this create request before I send it. ${createSummary(intent)}`,
    );
  }

  async function runCreate(intent: AllayCreateIntent) {
    if (connectorState === "unavailable") {
      appendMessage(
        "allay",
        "I can’t create that workload while the control-plane connector is unavailable.",
        "error",
      );
      return;
    }

    setBusyCreate(intent);
    appendMessage("allay", `Creating ${intent.body.name}. I’ll wait for the control plane.`);

    try {
      const result = await api<CreateServerResponse>("/api/servers/create", {
        method: "POST",
        body: JSON.stringify(intent.body),
      });
      await refreshServers().catch(() => undefined);
      const reference = result.data?.id ? ` Its workload ID is ${result.data.id}.` : "";
      appendMessage(
        "allay",
        `${intent.body.name} was accepted and is provisioning.${reference}`,
        "success",
      );
    } catch (error) {
      appendMessage(
        "allay",
        `I couldn’t create ${intent.body.name}. ${controlErrorMessage(error)}`,
        "error",
      );
      await refreshServers().catch(() => undefined);
    } finally {
      setBusyCreate(null);
    }
  }

  async function runPowerAction(server: LiveServer, action: AllayPowerAction) {
    if (connectorState === "unavailable") {
      appendMessage(
        "allay",
        "I can’t send that command while the control-plane connector is unavailable.",
        "error",
      );
      return;
    }
    if (!validatePowerAction(server, action)) return;

    setBusyAction({ action, serverId: server.id });
    setActiveServerId(server.id);
    appendMessage(
      "allay",
      `${actionProgress(action)} ${server.name}. I’ll wait for the live result.`,
    );

    try {
      const result = await api<PowerActionResponse>(
        `/api/servers/${encodeURIComponent(server.id)}/action`,
        {
          method: "POST",
          body: JSON.stringify({ action }),
        },
      );
      await refreshServers();
      const finalState = humanize(result.data.status).toLocaleLowerCase();
      const address =
        action === "start" && server.hostname
          ? ` Its ${accessNoun(server)} is ${joinAddress(server)}.`
          : "";
      appendMessage(
        "allay",
        `${server.name} is ${finalState}. The control plane confirmed the change.${address}`,
        "success",
      );
    } catch (error) {
      appendMessage(
        "allay",
        `I couldn’t ${actionLabel(action)} ${server.name}. ${controlErrorMessage(error)}`,
        "error",
      );
      await refreshServers().catch(() => undefined);
    } finally {
      setBusyAction(null);
    }
  }

  async function copyServerAddress(server: LiveServer) {
    setActiveServerId(server.id);
    if (!server.hostname) {
      appendMessage("allay", `${server.name} does not have a ${accessNoun(server)} yet.`);
      return;
    }

    try {
      await navigator.clipboard.writeText(joinAddress(server));
      appendMessage("allay", copiedAccessMessage(server), "success");
    } catch {
      appendMessage(
        "allay",
        `I couldn’t access the clipboard. The ${accessNoun(server)} is ${joinAddress(server)}.`,
        "error",
      );
    }
  }

  function targetIntent(intent: TargetIntent, server: LiveServer) {
    setActiveServerId(server.id);
    setPendingSelection(null);

    if (intent.kind === "status") {
      appendMessage("allay", stateSummary(server, connectorState));
      return;
    }
    if (intent.kind === "copy") {
      void copyServerAddress(server);
      return;
    }

    if (!validatePowerAction(server, intent.action)) return;
    if (intent.action === "stop" || intent.action === "restart") {
      setPendingConfirmation({ action: intent.action, serverId: server.id });
      appendMessage(
        "allay",
        intent.action === "stop"
          ? `Stopping ${server.name} will make the ${workloadNoun(server)} unavailable. Should I continue?`
          : `Restarting ${server.name} will briefly make the ${workloadNoun(server)} unavailable. Should I continue?`,
      );
      return;
    }

    void runPowerAction(server, intent.action);
  }

  function resolveTarget(intent: TargetIntent, value: string) {
    if (availableServers.length === 0) {
      explainNoServers();
      return;
    }

    const server = findMentionedServer(availableServers, value, activeServerId);
    if (!server) {
      setPendingSelection(intent);
      appendMessage(
        "allay",
        `Which workload should I ${intent.kind === "power" ? actionLabel(intent.action) : intent.kind}?`,
      );
      return;
    }
    targetIntent(intent, server);
  }

  function respond(value: string) {
    const normalized = value.trim().toLocaleLowerCase();

    if (pendingCreate) {
      if (/^(yes|yep|confirm|continue|create it|do it|please do)\b/.test(normalized)) {
        const intent = pendingCreate;
        setPendingCreate(null);
        void runCreate(intent);
        return;
      }
      if (/^(no|nope|cancel|never mind|nevermind|leave it)\b/.test(normalized)) {
        const name = pendingCreate.body.name;
        setPendingCreate(null);
        appendMessage("allay", `${name} will not be created.`);
        return;
      }
      appendMessage("allay", "Please confirm or cancel the pending create request first.");
      return;
    }

    if (pendingConfirmation) {
      if (/^(yes|yep|confirm|continue|do it|please do)\b/.test(normalized)) {
        const server = selectedServer(pendingConfirmation.serverId);
        const action = pendingConfirmation.action;
        setPendingConfirmation(null);
        if (server) void runPowerAction(server, action);
        else explainNoServers();
        return;
      }
      if (/^(no|nope|cancel|never mind|nevermind|leave it)\b/.test(normalized)) {
        const server = selectedServer(pendingConfirmation.serverId);
        setPendingConfirmation(null);
        appendMessage("allay", `${server?.name ?? "The workload"} will stay as it is.`);
        return;
      }
    }

    if (pendingSelection) {
      const server = findMentionedServer(availableServers, value, activeServerId);
      if (server) {
        targetIntent(pendingSelection, server);
        return;
      }
    }

    const intent = parseAllayIntent(value);
    if (intent.kind === "greeting") {
      appendMessage("allay", `Hi ${operatorName}. Tell me what you want to create or manage.`);
      return;
    }
    if (intent.kind === "help") {
      appendMessage(
        "allay",
        "I can create Minecraft Paper, Vanilla, or Bedrock realms; Rust, CS2, Valheim, Terraria, Factorio, or Project Zomboid servers; and Node static sites. I can also list workloads, report state, start, stop, restart, and copy an address or site URL. Try “create a Valheim server named vikings” or “host a Node website called portfolio”.",
      );
      return;
    }
    if (intent.kind === "create") {
      requestCreate(intent);
      return;
    }
    if (intent.kind === "list") {
      if (availableServers.length === 0) explainNoServers();
      else appendMessage("allay", listSummary(availableServers, connectorState));
      return;
    }
    if (intent.kind === "status") {
      if (availableServers.length === 0) {
        explainNoServers();
        return;
      }
      const server = findMentionedServer(availableServers, value, activeServerId);
      appendMessage(
        "allay",
        server
          ? stateSummary(server, connectorState)
          : listSummary(availableServers, connectorState),
      );
      if (server) setActiveServerId(server.id);
      return;
    }
    if (intent.kind === "copy" || intent.kind === "power") {
      resolveTarget(intent, value);
      return;
    }

    appendMessage(
      "allay",
      "I didn’t catch a workload command there. Ask me to create a supported game server or Node site, or to list, inspect, start, stop, restart, or copy access details for a workload.",
    );
  }

  function submit(value: string) {
    const message = value.trim();
    if (!message || busy) return;
    appendMessage("operator", message);
    setDraft("");
    respond(message);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(draft);
  }

  function chooseServer(server: LiveServer) {
    if (!pendingSelection) return;
    appendMessage("operator", server.name);
    targetIntent(pendingSelection, server);
  }

  function confirmAction() {
    if (!pendingConfirmation) return;
    const server = selectedServer(pendingConfirmation.serverId);
    const action = pendingConfirmation.action;
    setPendingConfirmation(null);
    appendMessage("operator", `Yes, ${actionLabel(action)} ${server?.name ?? "the workload"}.`);
    if (server) void runPowerAction(server, action);
    else explainNoServers();
  }

  function cancelAction() {
    if (!pendingConfirmation) return;
    const server = selectedServer(pendingConfirmation.serverId);
    setPendingConfirmation(null);
    appendMessage("operator", "Leave it as it is.");
    appendMessage("allay", `${server?.name ?? "The workload"} will stay as it is.`);
  }

  function confirmCreate() {
    if (!pendingCreate) return;
    const intent = pendingCreate;
    setPendingCreate(null);
    appendMessage("operator", `Create ${intent.body.name} with those settings.`);
    void runCreate(intent);
  }

  function cancelCreate() {
    if (!pendingCreate) return;
    const name = pendingCreate.body.name;
    setPendingCreate(null);
    appendMessage("operator", "Cancel that create request.");
    appendMessage("allay", `${name} will not be created.`);
  }

  return (
    <aside className={open ? "allay-companion is-open" : "allay-companion"}>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.section
            animate={{ opacity: 1, scale: 1, y: 0 }}
            aria-label="Allay manual control chat"
            className="allay-chat pixel-border"
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 8 }}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 8 }}
            transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="allay-chat-header">
              <div>
                <span className="allay-chat-title">Allay</span>
                <span className={`allay-connection ${connectorState}`}>
                  <span aria-hidden="true" /> {connectionLabel}
                </span>
              </div>
              <button aria-label="Close Allay chat" onClick={() => setOpen(false)} type="button">
                <X aria-hidden="true" size={16} />
              </button>
            </header>

            <div className="allay-transcript" ref={transcriptRef} role="log">
              {messages.map((message) => (
                <div
                  className={`allay-message ${message.from} ${message.tone ?? "normal"}`}
                  key={message.id}
                  role={message.tone === "error" ? "alert" : undefined}
                >
                  <span>{message.from === "allay" ? "Allay" : "You"}</span>
                  <p>{message.text}</p>
                </div>
              ))}

              {pendingSelection ? (
                <fieldset className="allay-server-choices">
                  <legend className="sr-only">Choose a workload</legend>
                  {availableServers.map((server, index) => (
                    <button key={server.id} onClick={() => chooseServer(server)} type="button">
                      <span>{index + 1}</span>
                      <strong>{server.name}</strong>
                      <small>{humanize(server.currentState)}</small>
                    </button>
                  ))}
                </fieldset>
              ) : null}

              {pendingCreate ? (
                <div className="allay-confirmation">
                  <CircleAlert aria-hidden="true" size={17} />
                  <div>
                    <strong>Confirm workload creation</strong>
                    <span>{createSummary(pendingCreate)}</span>
                  </div>
                  <div className="allay-confirmation-actions">
                    <button className="confirm" onClick={confirmCreate} type="button">
                      <Check aria-hidden="true" size={15} /> Create
                    </button>
                    <button onClick={cancelCreate} type="button">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              {pendingConfirmation ? (
                <div className="allay-confirmation">
                  <CircleAlert aria-hidden="true" size={17} />
                  <div>
                    <strong>Availability-impacting command</strong>
                    <span>The workload may be briefly unavailable.</span>
                  </div>
                  <div className="allay-confirmation-actions">
                    <button className="confirm" onClick={confirmAction} type="button">
                      <Check aria-hidden="true" size={15} /> Continue
                    </button>
                    <button onClick={cancelAction} type="button">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

              {busyAction ? (
                <div className="allay-working" role="status">
                  <RefreshCw aria-hidden="true" size={15} />
                  {actionProgress(busyAction.action)} {busyServer?.name ?? "the workload"}…
                </div>
              ) : null}

              {busyCreate ? (
                <div className="allay-working" role="status">
                  <RefreshCw aria-hidden="true" size={15} />
                  Creating {busyCreate.body.name}…
                </div>
              ) : null}
            </div>

            <fieldset className="allay-quick-actions">
              <legend className="sr-only">Suggested commands</legend>
              {quickCommands.map(({ label, prompt, icon: Icon }) => (
                <button disabled={busy} key={prompt} onClick={() => submit(prompt)} type="button">
                  <Icon aria-hidden="true" size={14} /> {label}
                </button>
              ))}
            </fieldset>

            <form className="allay-composer" onSubmit={handleSubmit}>
              <label className="sr-only" htmlFor="allay-command">
                Tell Allay what to do
              </label>
              <input
                autoComplete="off"
                disabled={busy}
                id="allay-command"
                maxLength={180}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  busy
                    ? "Waiting for the control plane…"
                    : "Try “create a Valheim server named vikings”"
                }
                value={draft}
              />
              <button aria-label="Send command" disabled={!draft.trim() || busy} type="submit">
                <Send aria-hidden="true" size={17} />
              </button>
            </form>
          </motion.section>
        ) : null}
      </AnimatePresence>

      <div className="allay-anchor">
        {!open ? (
          <motion.span
            animate={{ opacity: 1, x: 0 }}
            className="allay-nudge"
            initial={reducedMotion ? false : { opacity: 0, x: 6 }}
          >
            Need a hand?
          </motion.span>
        ) : null}
        <button
          aria-expanded={open}
          aria-label={open ? "Close Allay chat" : "Open Allay manual control chat"}
          className="allay-pet-button"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <AllaySprite busy={busy} />
          <span className="allay-pet-state" aria-hidden="true">
            {busy ? (
              <RefreshCw size={12} />
            ) : connectorState === "unavailable" ? (
              <CircleAlert size={12} />
            ) : (
              <Power size={12} />
            )}
          </span>
        </button>
      </div>
    </aside>
  );
}
