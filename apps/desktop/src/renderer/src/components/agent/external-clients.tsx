import { useEffect, useId, useRef, useState } from "react";
import { AlertCircleIcon, BanIcon, CopyIcon, PlugIcon, XIcon } from "lucide-react";
import {
  AGENT_MODES, EXTERNAL_TIMEOUT_MAX, EXTERNAL_TIMEOUT_MIN, type AgentMode, type ExternalBindingView, type ExternalClientsAction, type ExternalClientsView,
  type ExternalRequestView, type Owner, type TerminalSession, type UpdateExternalClientsResponse,
} from "@ssterm/contracts";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import { Drawer, useDrawerClose } from "@/components/drawer";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { modeLabels, modeNotes, TargetLine, TaskCard } from "./agent-panel";

const refusals: Record<Extract<UpdateExternalClientsResponse, { status: "refused" }>["reason"], string> = {
  disabled: "Turn on external MCP clients first.",
  unavailable: "External MCP clients need the macOS Keychain, which is unavailable.",
  "rate-limited": "Too many pairing tokens were issued recently. Wait a few minutes.",
  limit: "The maximum number of paired clients is reached. Revoke one first.",
  "unknown-client": "That client is no longer paired.",
  failed: "The change could not be saved.",
};
const when = (at: number | null) => at === null ? "never" : new Date(at).toLocaleString();
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "client";

/**
 * The stdio configuration a client such as Claude Desktop reads (`mcpServers`); secrets only in its environment. `suffix`
 * is per pairing (review L1), so pairing again never reuses an old credential file.
 */
export function clientConfig(view: ExternalClientsView, name: string, token: string, suffix: string): string {
  return JSON.stringify({
    mcpServers: {
      ssterm: {
        command: "/bin/sh",
        args: [view.bridgePath],
        env: {
          SSTERM_MCP_SOCKET: view.socketPath,
          SSTERM_MCP_CREDENTIAL_FILE: `${view.credentialFolder}/${slug(name)}-${suffix}.credential`,
          SSTERM_MCP_PAIRING_TOKEN: token,
          SSTERM_MCP_CLIENT_NAME: name,
        },
      },
    },
  }, null, 2);
}

/** SST-041 ticket 07: Settings › AI Agent › External MCP clients. Off by default. */
export function ExternalClientsSettings({ owner }: { owner: Owner }) {
  const id = useId();
  const { windowId, generation } = owner;
  const [view, setView] = useState<ExternalClientsView>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** The one-time token, kept only while this step is shown. */
  const [pairing, setPairing] = useState<{ token: string; expiresAt: number; suffix: string }>();
  const [name, setName] = useState("Claude Desktop");
  const [revoking, setRevoking] = useState<string>();
  useEffect(() => {
    let current = true;
    const load = () => void window.ssterm?.externalClients({ owner: { windowId, generation } }).then((result) => {
      if (current && result.ok) setView(result.value);
      else if (current) setProblem("External MCP clients are unavailable.");
    }, () => undefined);
    load();
    // A client was paired, revoked or changed (also in another window): the list is read again.
    let revision: number | undefined;
    const unsubscribe = window.ssterm?.onAgentState((state) => {
      if (revision !== undefined && state.external.clients !== revision) load();
      revision = state.external.clients;
    });
    return () => { current = false; unsubscribe?.(); };
  }, [windowId, generation]);
  const update = async (action: ExternalClientsAction) => {
    setBusy(true);
    setProblem(undefined);
    const result = await window.ssterm?.updateExternalClients({ owner: { windowId, generation }, action }).catch(() => undefined);
    setBusy(false);
    if (!result?.ok) { setProblem(refusals.failed); return; }
    if (result.value.status === "refused") { setProblem(refusals[result.value.reason]); return; }
    setView(result.value.view);
    if (result.value.pairing) setPairing({ ...result.value.pairing, suffix: [...crypto.getRandomValues(new Uint8Array(3))].map((byte) => byte.toString(16).padStart(2, "0")).join("") });
    if (action.type === "enable" && !action.enabled) setPairing(undefined);
  };
  const validName = /^[A-Za-z0-9._()+@ -]{1,64}$/u.test(name) && name.trim() === name;

  return (
    <FieldSet data-testid="external-clients">
      <FieldLegend>External MCP clients</FieldLegend>
      <FieldDescription>
        Lets an AI app on this Mac (for example Claude Desktop or an IDE) use ssterm's terminal tools through a private socket
        in your profile, readable only by your user; no network port is opened. Each client is paired once and can act only in
        a session you bind for it, under the same mode, plan, PROD and password rules. A client receives the commands it runs
        and their output, and sends them wherever it is set up to; ssterm cannot see or limit that.
      </FieldDescription>
      {problem ? (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      {view ? (
        <>
          <Field orientation="horizontal" data-disabled={busy || !view.available || undefined}>
            <Switch id={`${id}-enabled`} disabled={busy || !view.available} checked={view.enabled}
              onCheckedChange={(enabled) => void update({ type: "enable", enabled })} />
            <FieldContent>
              <FieldLabel htmlFor={`${id}-enabled`}>Allow external MCP clients</FieldLabel>
              <FieldDescription>
                {!view.available ? "Unavailable: the macOS Keychain cannot be used." : view.enabled
                  ? "On. Turning it off disconnects every client and ends their bindings; paired clients stay paired."
                  : "Off. No client can connect."}
              </FieldDescription>
            </FieldContent>
          </Field>
          {view.enabled ? (
            pairing ? (
              <div className="grid gap-2 rounded-lg border border-border p-3" role="group" aria-label="Pair a new client" data-testid="external-pairing">
                <p className="text-sm">
                  This one-time token works once, until {new Date(pairing.expiresAt).toLocaleTimeString()}. It is shown only now.
                </p>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all" data-testid="external-pairing-token">{pairing.token}</code>
                <Field>
                  <FieldLabel htmlFor={`${id}-name`}>Client name</FieldLabel>
                  <Input id={`${id}-name`} value={name} maxLength={64} aria-invalid={!validName || undefined} onChange={(event) => setName(event.target.value)} />
                  <FieldDescription>Shown in ssterm when the client asks to pair; it must differ from your other clients' names. Letters, digits, spaces and . _ ( ) + @ - only.</FieldDescription>
                </Field>
                <p className="text-sm">
                  Add this to the client's MCP configuration (for Claude Desktop: <code className="font-mono text-xs">claude_desktop_config.json</code>;
                  any stdio MCP client takes the same command, arguments and environment), then restart the client:
                </p>
                <pre className="max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all" data-testid="external-config">
                  {clientConfig(view, validName ? name : "MCP client", pairing.token, pairing.suffix)}
                </pre>
                <p className="type-caption text-muted-foreground">
                  On its first start the client presents the token and ssterm asks you to approve its name. ssterm then gives the
                  client its own credential once; the bridge saves it in the credential file (mode 0600). That file is the
                  client's secret and its responsibility: keep it private. Revoke here invalidates it. The pairing token can stay
                  in the configuration; it cannot be used again.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={!validName}
                    onClick={() => toast.add({ title: copyText(clientConfig(view, name, pairing.token, pairing.suffix)) ? "Configuration copied" : "Copy failed", type: "info" })}>
                    <CopyIcon data-icon="inline-start" aria-hidden="true" />
                    Copy configuration
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPairing(undefined)}>Done</Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="justify-self-start" disabled={busy} onClick={() => void update({ type: "pair" })}>
                Pair new client
              </Button>
            )
          ) : null}
          {view.clients.length ? (
            <ul className="grid gap-2" aria-label="Paired clients" data-testid="external-client-list">
              {view.clients.map((client) => (
                <li key={client.id} className="grid gap-1.5 rounded-lg border border-border p-2" data-client-id={client.id}>
                  <div className="flex items-center gap-2">
                    <PlugIcon aria-hidden="true" className="size-4 text-primary" />
                    <span className="min-w-0 flex-1 truncate font-medium">{client.name}</span>
                    {revoking === client.id ? (
                      <>
                        <Button size="xs" variant="destructive" disabled={busy} onClick={() => { setRevoking(undefined); void update({ type: "revoke", clientId: client.id }); }}>
                          Revoke {client.name}
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => setRevoking(undefined)}>Cancel</Button>
                      </>
                    ) : (
                      <Button size="xs" variant="outline" disabled={busy} onClick={() => setRevoking(client.id)}>Revoke</Button>
                    )}
                  </div>
                  <p className="type-caption text-muted-foreground">Paired {when(client.createdAt)} · Last used {when(client.lastUsedAt)}</p>
                  <TimeoutField id={`${id}-${client.id}`} seconds={client.timeoutSec} disabled={busy}
                    onSave={(seconds) => void update({ type: "timeout", clientId: client.id, seconds })} />
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </FieldSet>
  );
}

function TimeoutField({ id, seconds, disabled, onSave }: { id: string; seconds: number; disabled: boolean; onSave(seconds: number): void }) {
  const [draft, setDraft] = useState(String(seconds));
  const value = Number(draft);
  const valid = Number.isSafeInteger(value) && value >= EXTERNAL_TIMEOUT_MIN && value <= EXTERNAL_TIMEOUT_MAX;
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={id} className="font-normal">Tool timeout (seconds)</FieldLabel>
      <Input id={id} className="w-24" inputMode="numeric" value={draft} aria-invalid={!valid || undefined} onChange={(event) => setDraft(event.target.value)} />
      <Button size="xs" variant="outline" disabled={disabled || !valid || value === seconds} onClick={() => onSave(value)}>Save</Button>
      <FieldDescription className="sr-only">How long this client waits for one tool call; its cards expire 5 seconds before it, after 5 minutes at most.</FieldDescription>
    </Field>
  );
}

/**
 * A Ready SSH session of this window that a client may be bound to: not local, not Team, not bound already, and without
 * an ssterm agent conversation (review M1: a session has one or the other).
 */
export const bindableSession = (session: TerminalSession, bindings: readonly ExternalBindingView[], conversations: readonly string[]) =>
  session.phase === "ready" && !session.local && !!session.target && session.target.source !== "team" &&
  !bindings.some((binding) => binding.sessionId === session.sessionId) && !conversations.includes(session.sessionId);

/**
 * A client asks to pair, or a paired client asks for a terminal. Closing the drawer denies; the user picks the session
 * (the client can never list them).
 */
export function ExternalRequestDrawer({ owner, request, sessions, onDone }: {
  owner: Owner; request: ExternalRequestView; sessions: TerminalSession[]; onDone(): void;
}) {
  const close = useDrawerClose();
  const answered = useRef(false);
  const [choice, setChoice] = useState<string>();
  const chosen = sessions.find((session) => session.sessionId === choice);
  const answer = (approve: boolean) => {
    if (answered.current) return;
    answered.current = true;
    const bridge = window.ssterm;
    const base = { owner, requestId: request.id };
    void (approve
      ? bridge?.answerExternalRequest(chosen ? { ...base, decision: "approve", sessionId: chosen.sessionId, generation: chosen.generation } : { ...base, decision: "approve" })
      : bridge?.answerExternalRequest({ ...base, decision: "deny" }))?.then((result) => {
      if (approve && (!result.ok || result.value.status !== "applied"))
        toast.add({ title: "Not applied", description: "The request ended, or the session is no longer available.", type: "error" });
    }, () => undefined);
    close.discard();
  };
  const pair = request.kind === "pair";
  return (
    <Drawer
      close={close}
      onClose={() => { if (!answered.current) answer(false); onDone(); }}
      dismissOnScrim={false}
      data-testid="external-request"
      data-kind={request.kind}
      title={pair ? `Pair ${request.clientName}?` : `${request.clientName} wants to control a terminal`}
      description={pair
        ? "An app on this Mac presented the pairing token from Settings › AI Agent. Approve only if you just set it up."
        : "Choose the session it may use. It cannot see your other sessions or saved servers."}
      footer={
        <>
          <Button variant="outline" onClick={() => answer(false)}>Deny</Button>
          <Button disabled={!pair && !chosen} onClick={(event) => { if (event.detail <= 1) answer(true); }}>
            {pair ? "Approve" : "Allow this session"}
          </Button>
        </>
      }
    >
      {pair ? (
        <div className="grid gap-2 text-sm">
          <p>Name it gives: <strong>{request.clientName}</strong></p>
          <p className="text-muted-foreground">
            Once paired it gets its own credential and can ask to control a terminal; each time, you choose the session here.
            Revoke it in Settings › AI Agent at any time.
          </p>
        </div>
      ) : sessions.length ? (
        <>
          <RadioGroup aria-label="Session" value={choice ?? null} onValueChange={(value) => setChoice(String(value))}>
            {sessions.map((session) => (
              <Field key={session.sessionId} orientation="horizontal">
                <RadioGroupItem value={session.sessionId} id={`external-${request.id}-${session.sessionId}`} />
                <FieldLabel htmlFor={`external-${request.id}-${session.sessionId}`} className="min-w-0 font-normal">
                  <span className="truncate">{session.target!.label}</span>
                  <span className="truncate text-muted-foreground">
                    {session.target!.username ? `${session.target!.username}@` : ""}{session.target!.endpointHost}:{session.target!.endpointPort}
                  </span>
                  <EnvironmentBadge environment={session.target!.environment} />
                </FieldLabel>
              </Field>
            ))}
          </RadioGroup>
          {chosen?.target?.environment === "PROD" ? <p className="text-sm text-environment-production">This is a PROD server: plans still need the PROD confirmation.</p> : null}
          <p className="type-caption text-muted-foreground">
            It starts in Auto: read-only commands run, anything else only from a plan you approve or after you approve that
            command. The binding lasts until the session ends, you press Stop, lock the workspace or revoke the client.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No connected SSH session can be chosen. Sessions with an open AI Agent conversation or another client's binding are
          not offered. Connect a server or close that conversation first, or deny.
        </p>
      )}
    </Drawer>
  );
}

/** The pane banner of a bound session: which client controls it, in which mode, with Stop. */
export function ExternalBanner({ owner, binding, onShow }: { owner: Owner; binding: ExternalBindingView; onShow(): void }) {
  const pending = binding.task.plan?.status === "pending" || !!binding.task.approval;
  return (
    <div className="live-terminal-agent live-terminal-external" role="status" data-testid="external-banner" data-client-id={binding.clientId}>
      <PlugIcon aria-hidden="true" />
      <span className="live-terminal-agent-text">
        Controlled by <strong>{binding.clientName}</strong>
        <span className="text-muted-foreground"> · {modeLabels[binding.mode]}{pending ? " · waiting for you" : ""}</span>
      </span>
      <Button size="sm" variant="ghost" onClick={onShow}>Show</Button>
      <Button size="sm" variant="outline" onClick={() => void window.ssterm?.stopExternalBinding({ owner, sessionId: binding.sessionId }).catch(() => undefined)}>
        <BanIcon data-icon="inline-start" aria-hidden="true" />
        Stop
      </Button>
    </div>
  );
}

/** One binding's mode, pending cards and ssterm's record (in the agent panel, or the compact external panel). */
export function ExternalBindingSection({ owner, binding }: { owner: Owner; binding: ExternalBindingView }) {
  const [fullAllowStep, setFullAllowStep] = useState(false);
  if (fullAllowStep && (binding.mode === "full-allow" || !binding.fullAllowAvailable)) setFullAllowStep(false);
  const { sessionId, generation, target } = binding;
  const setMode = async (mode: AgentMode, acknowledged: boolean) => {
    const result = await window.ssterm?.setExternalMode({ owner, sessionId, generation, mode, acknowledged }).catch(() => undefined);
    setFullAllowStep(false);
    if (!result?.ok || result.value.status !== "set") toast.add({ title: "The mode was not changed", description: "The binding has ended, or Full allow on PROD is off in Settings.", type: "error" });
  };
  return (
    <section className="grid gap-2" aria-label={`External client ${binding.clientName}`} data-testid="external-binding" data-client-id={binding.clientId} data-mode={binding.mode}>
      <div className="flex items-center gap-2">
        <PlugIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="type-label truncate">{binding.clientName} <span className="type-caption text-muted-foreground">external MCP client</span></p>
          <TargetLine target={target} />
        </div>
        <Button size="xs" variant="outline" onClick={() => void window.ssterm?.stopExternalBinding({ owner, sessionId }).catch(() => undefined)}>Stop</Button>
      </div>
      <ToggleGroup aria-label={`Mode for ${binding.clientName}`} variant="outline" size="sm" spacing={0} value={[binding.mode]}
        onValueChange={(value) => {
          const next = value[0] as AgentMode | undefined;
          if (!next || next === binding.mode) return;
          if (next === "full-allow") setFullAllowStep(true);
          else void setMode(next, false);
        }}>
        {AGENT_MODES.map((option) => (
          <ToggleGroupItem key={option} value={option} className="aria-pressed:bg-primary/15 aria-pressed:text-primary" disabled={option === "full-allow" && !binding.fullAllowAvailable}>
            {modeLabels[option]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <p className="type-caption text-muted-foreground">{modeNotes[binding.mode]} Read-only classification is best effort.</p>
      {fullAllowStep ? (
        <section role="alert" className="grid gap-2 rounded-md border border-border p-2 text-sm" data-testid="external-full-allow-step">
          <p className="font-medium">Allow every command from {binding.clientName} on {target.label}?</p>
          {target.environment === "PROD" ? <p className="text-environment-production">This is a PROD server.</p> : null}
          <p className="type-caption text-muted-foreground">Its commands run without asking you, until the binding ends. A new binding starts in Auto.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" autoFocus onClick={() => setFullAllowStep(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" onClick={(event) => { if (event.detail <= 1) void setMode("full-allow", true); }}>Allow every command</Button>
          </div>
        </section>
      ) : null}
      <ol className="flex flex-col gap-2">
        <TaskCard task={binding.task} target={target}
          onDecide={(approvalId, decision, production) => void window.ssterm?.decideAgent({ owner, sessionId, generation, approvalId, decision, production }).then((result) => {
            if (!result.ok || result.value.status !== "applied") toast.add({ title: "The decision was not applied", description: "That request is no longer waiting.", type: "error" });
          }, () => undefined)} />
      </ol>
    </section>
  );
}

/** The compact, non-modal panel for external bindings whose session has no agent panel open. */
export function ExternalAgentPanel({ owner, bindings, onClose }: { owner: Owner; bindings: ExternalBindingView[]; onClose(): void }) {
  return (
    <aside className="flex h-full min-w-0 flex-col border-l border-border bg-card" aria-label="External MCP clients" data-testid="external-panel">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <PlugIcon aria-hidden="true" className="size-4 text-primary" />
        <h2 className="type-label flex-1">External MCP clients</h2>
        <Button size="icon-sm" variant="ghost" aria-label="Close external clients panel" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </header>
      <p role="note" className="shrink-0 border-b border-border px-3 py-2 type-caption text-muted-foreground">
        These clients receive the commands they run and their full output; ssterm cannot see where they send it.
      </p>
      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-3 py-2">
        {bindings.map((binding) => <ExternalBindingSection key={`${binding.clientId}:${binding.generation}`} owner={owner} binding={binding} />)}
      </div>
    </aside>
  );
}
