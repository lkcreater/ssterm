import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { BotIcon, ChevronDownIcon, ChevronRightIcon, CircleHelpIcon, KeyRoundIcon, SendIcon, ShieldAlertIcon, SparklesIcon, SquareIcon, XIcon } from "lucide-react";
import type { AgentConversation, AgentEffort, AgentMode, AgentPlan, AgentStep, AgentTask, Owner } from "@ssterm/contracts";
import { AGENT_EFFORTS, AGENT_MODELS, AGENT_MODES, MAX_AGENT_MESSAGE } from "@ssterm/contracts";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "@/components/ui/toast";
import { chatItems } from "@/lib/agent-chat";
import { ChatMarkdown } from "./chat-markdown";

const taskStatus: Record<AgentTask["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};
const stepStatus = (step: AgentStep): string => {
  switch (step.status) {
    case "refused": return "Refused, not run";
    case "completed": return `Exit ${step.exitCode ?? "?"}`;
    case "interrupted": return "Interrupted";
    case "timeout": return "Timed out";
    case "alternate-screen": return "Stopped: full-screen program";
    case "ended": return "Session ended";
    case "not-at-prompt": return "Not run: terminal busy";
    case "not-started": return "Typed, not started";
    case "password-handoff": return "Password prompt ended";
    case "password-prompt-refused": return "Stopped: password prompt";
  }
};

const via: Record<NonNullable<AgentStep["via"]>, string> = {
  "read-only": "read-only",
  plan: "from the approved plan",
  approval: "you approved it",
  "full-allow": "Full allow",
};
const planStatus: Record<AgentPlan["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  cancelled: "Withdrawn",
};
export const modeLabels: Record<AgentMode, string> = { "read-only": "Read only", auto: "Auto", "full-allow": "Full allow" };
export const modeNotes: Record<AgentMode, string> = {
  "read-only": "Only commands classified read-only run; everything else is refused.",
  auto: "Read-only commands run. Anything else runs only from a plan you approve, or after you approve that command.",
  "full-allow": "Every command the agent asks for runs without approval in this conversation.",
};
type Target = AgentConversation["target"];
/** SST-043: the cards waiting for a decision, oldest task first (its plan before its command). */
const pendingCards = (tasks: readonly AgentTask[]) => tasks.flatMap((task) => [
  ...(task.plan?.status === "pending" ? [{ task, kind: "plan" as const }] : []),
  ...(task.approval ? [{ task, kind: "command" as const }] : []),
]);
const taskNumber = (task: AgentTask) => task.id.slice(5);
/** SST-043: what the busy turn is doing now. */
function progress(conversation: AgentConversation): string {
  if (conversation.status === "starting") return "Starting the agent…";
  if (conversation.status === "stopping") return "Stopping…";
  const waiting = conversation.tasks.find((task) => task.plan?.status === "pending" || task.approval);
  if (waiting) return `Task ${taskNumber(waiting)} is waiting for your decision`;
  const running = conversation.tasks.find((task) => task.status === "running");
  if (running) return `Waiting for task ${taskNumber(running)}: ${running.goal}`;
  const queued = conversation.tasks.find((task) => task.status === "queued");
  return queued ? `Task ${taskNumber(queued)} is queued` : "Thinking…";
}
const modelLabel = (conversation: AgentConversation) =>
  AGENT_MODELS.claude.models.find((entry) => entry.id === conversation.model || entry.alias === conversation.model)?.label ?? conversation.model;
export type Decide = (approvalId: string, decision: "approve" | "reject", production: boolean) => void;

export function TargetLine({ target }: { target: Target }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 type-caption text-muted-foreground">
      <span className="truncate text-foreground" title={target.label}>{target.label}</span>
      <span className="truncate" title={target.endpoint}>{target.endpoint}</span>
      <EnvironmentBadge environment={target.environment} />
    </span>
  );
}

/**
 * SST-041 ticket 03: the non-modal AI Agent panel on the Terminals page (ADR 0009 exception to the drawer contract).
 * Bound to the session it was opened from; tab switches never move it. The conversation lives in main, in memory.
 */
export function AgentPanel({
  owner,
  sessionId,
  conversation,
  password,
  external,
  externalWaiting = 0,
  onClose,
}: {
  owner: Owner;
  sessionId: string;
  /** Undefined until main publishes it, and again once it has ended (session end, lock, or the agent turned off). */
  conversation: AgentConversation | undefined;
  /** A4: the agent command (text) that waits at a password prompt in the bound session; the user types it in the pane. */
  password?: string;
  /** Ticket 07: an external client's binding to this same session (its mode, cards and record). */
  external?: ReactNode;
  /** SST-043 review L5: that binding's cards waiting for a decision (counted in the tray). */
  externalWaiting?: number;
  onClose(): void;
}) {
  const [seen, setSeen] = useState(false);
  if (conversation && !seen) setSeen(true);
  const ended = seen && !conversation;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [fullAllowStep, setFullAllowStep] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const busy = sending || !conversation || conversation.status !== "idle";
  const count = (conversation?.messages.length ?? 0) + (conversation?.tasks.reduce((sum, task) =>
    sum + task.steps.length + 1 + (task.plan ? task.plan.commands.length + 1 : 0) + (task.approval ? 1 : 0), 0) ?? 0);
  const mode = conversation?.mode;
  // The warning step only stands while Full allow can still be chosen.
  if (fullAllowStep && (!conversation || mode === "full-allow" || !conversation.fullAllowAvailable)) setFullAllowStep(false);
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count, conversation?.status]);

  const send = async () => {
    const text = draft.trim();
    const bridge = window.ssterm;
    if (!text || busy || !bridge) return;
    setSending(true);
    const result = await bridge.sendAgent({ owner, sessionId, text }).catch(() => undefined);
    setSending(false);
    if (result?.ok && result.value.status === "sent") setDraft("");
    else toast.add({ title: "The message was not sent", description: result?.ok && result.value.status === "refused" && result.value.reason === "busy" ? "Wait for the agent to finish its turn." : "This conversation has ended.", type: "error" });
  };
  const cancelTask = (taskId: string) => {
    void window.ssterm?.cancelAgentTask({ owner, sessionId, taskId }).catch(() => undefined);
  };
  const setMode = async (next: AgentMode, acknowledged: boolean) => {
    const bridge = window.ssterm;
    if (!bridge || !conversation) return;
    const result = await bridge.setAgentMode({ owner, sessionId, generation: conversation.generation, mode: next, acknowledged }).catch(() => undefined);
    setFullAllowStep(false);
    if (!result?.ok || result.value.status !== "set") toast.add({ title: "The mode was not changed", description: result?.ok && result.value.status === "refused" && result.value.reason === "production" ? "Full allow on PROD is off in Settings › AI Agent." : "This conversation has ended.", type: "error" });
  };
  const decide: Decide = (approvalId, decision, production) => {
    const bridge = window.ssterm;
    if (!bridge || !conversation) return;
    void bridge.decideAgent({ owner, sessionId, generation: conversation.generation, approvalId, decision, production }).then((result) => {
      if (!result.ok || result.value.status !== "applied") toast.add({ title: "The decision was not applied", description: "That request is no longer waiting.", type: "error" });
    }, () => undefined);
  };
  const target = conversation?.target;
  const pending = conversation ? pendingCards(conversation.tasks) : [];
  const trayCount = pending.length + externalWaiting + (fullAllowStep && target ? 1 : 0) + (password !== undefined && target ? 1 : 0);
  const ids = useId();
  const disclosure = conversation?.provider === "custom"
    ? "Your messages, the agent's commands and their full output are sent through your custom CLI provider to its provider, under that account's terms. Nothing is redacted."
    : conversation?.provider === "codex"
      ? "Your messages, the agent's commands and their full output are sent to OpenAI through your codex CLI, under your account's terms. Nothing is redacted."
      : "Your messages, the agent's commands and their full output are sent to Anthropic through your claude CLI, under your account's terms. Nothing is redacted.";
  const [saveDefault, setSaveDefault] = useState(false);
  const setModel = async (model: string, effort: AgentEffort) => {
    const bridge = window.ssterm;
    if (!bridge || !conversation) return;
    const result = await bridge.setAgentModel({ owner, sessionId, generation: conversation.generation, model, effort, setDefault: saveDefault }).catch(() => undefined);
    // "Also set as default" applies to one change.
    if (result?.ok && result.value.status === "set") setSaveDefault(false);
    else toast.add({ title: "The model was not changed", type: "error",
      description: result?.ok && result.value.status === "refused" && result.value.reason === "busy" ? "Wait for the agent to finish its turn and tasks."
        : result?.ok && result.value.status === "refused" && result.value.reason === "model-unverified" ? "Only verified models of the claude CLI can be chosen here."
          : "This conversation has ended, or Settings could not be saved." });
  };

  return (
    <aside className="agent-panel flex h-full min-w-0 flex-col overflow-hidden border-l border-border bg-card" aria-label="AI Agent" data-testid="agent-panel" data-session-id={sessionId}>
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
        <BotIcon aria-hidden="true" className="mt-0.5 size-4 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <h2 className="type-label">AI Agent</h2>
            {/* SST-043: A3's disclosure, always visible as an icon; its full text on hover or keyboard focus. */}
            <InfoTip id={`${ids}-disclosure`} label="What is sent, and to whom" text={disclosure} testId="agent-provider-banner"
              icon={<ShieldAlertIcon aria-hidden="true" className="text-connection-connecting" />} />
          </div>
          {target ? (
            <p className="flex min-w-0 items-center gap-1.5 type-caption text-muted-foreground" data-testid="agent-target">
              <span className="truncate text-foreground" title={target.label}>{target.label}</span>
              <span className="truncate" title={target.endpoint}>{target.endpoint}</span>
              <EnvironmentBadge environment={target.environment} />
            </p>
          ) : null}
          {conversation ? (
            <div className="flex min-w-0 items-center gap-1 type-caption text-muted-foreground">
              <p className="min-w-0 truncate" data-testid="agent-model">
                {modelLabel(conversation)}
                {" · "}effort {conversation.effort}
              </p>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" disabled={conversation.status !== "idle" || conversation.provider !== "claude"
                  || conversation.tasks.some((task) => task.status === "queued" || task.status === "running")} />} aria-label="Change model and effort" data-testid="agent-model-menu">
                  <ChevronDownIcon aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Model (verified only)</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={AGENT_MODELS.claude.models.find((entry) => entry.id === conversation.model || entry.alias === conversation.model)?.id ?? conversation.model}
                      onValueChange={(value) => void setModel(value as string, conversation.effort)}>
                      {AGENT_MODELS.claude.models.filter((entry) => entry.verified).map((entry) => (
                        <DropdownMenuRadioItem key={entry.id} value={entry.id}>{entry.label}</DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Effort</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={conversation.effort} onValueChange={(value) => void setModel(conversation.model, value as AgentEffort)}>
                      {AGENT_EFFORTS.map((effort) => <DropdownMenuRadioItem key={effort} value={effort}>{effort}</DropdownMenuRadioItem>)}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked={saveDefault} onCheckedChange={(checked) => setSaveDefault(checked === true)} closeOnClick={false}>
                    Also set as default
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {/* SST-043: from the CLI's own usage report; nothing when it did not report a window. */}
              {conversation.context !== null ? (
                <span className="shrink-0" data-testid="agent-context" title="Share of the model's context window the main agent's latest request used, as the CLI reported it">
                  · {conversation.context}% context
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close AI Agent" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </header>
      {conversation && mode ? (
        <div className="grid shrink-0 gap-1.5 border-b border-border px-3 py-2" data-testid="agent-mode" data-mode={mode}>
          <div className="flex items-center gap-1">
          <ToggleGroup
            aria-label="Agent mode"
            variant="outline"
            size="sm"
            spacing={0}
            value={[mode]}
            onValueChange={(value) => {
              const next = value[0] as AgentMode | undefined;
              if (!next || next === mode) return;
              if (next === "full-allow") setFullAllowStep(true);
              else void setMode(next, false);
            }}
          >
            {AGENT_MODES.map((option) => (
              <ToggleGroupItem key={option} value={option} className="aria-pressed:bg-primary/15 aria-pressed:text-primary" disabled={option === "full-allow" && !conversation.fullAllowAvailable}>{modeLabels[option]}</ToggleGroupItem>
            ))}
          </ToggleGroup>
            <InfoTip id={`${ids}-mode`} label={`About ${modeLabels[mode]} mode`} testId="agent-mode-note"
              text={`${modeNotes[mode]} Read-only classification is best effort: ssterm's allowlist can be wrong.`}
              icon={<CircleHelpIcon aria-hidden="true" />} />
          </div>
          {!conversation.fullAllowAvailable ? (
            <p className="type-caption text-muted-foreground" data-testid="agent-full-allow-off">
              Full allow is off for PROD servers. It can be allowed in Settings › AI Agent.
            </p>
          ) : null}
        </div>
      ) : null}
      <div ref={log} role="log" aria-live="polite" aria-label="Conversation" className={`${trayCount ? "min-h-0" : "min-h-16"} flex-1 overflow-y-auto px-3 py-2`} data-testid="agent-messages">
        {ended ? (
          <p className="type-caption text-muted-foreground" data-testid="agent-ended">
            This conversation has ended (the session closed, the workspace locked or the agent was turned off). It was kept
            only in memory and is gone.
          </p>
        ) : !conversation ? (
          <p className="flex items-center gap-2 type-caption text-muted-foreground"><Spinner aria-hidden="true" /> Opening…</p>
        ) : conversation.messages.length === 0 && conversation.tasks.length === 0 ? (
          <p className="type-caption text-muted-foreground">
            Ask about this server. The agent delegates the work to a sub agent whose commands run visibly in the terminal.
          </p>
        ) : null}
        {conversation ? (
          <ol className="flex flex-col gap-3">
            {chatItems(conversation.messages, conversation.tasks).map((item) => item.kind === "ai" ? (
              <li key={item.key} data-role="assistant" className="flex max-w-[90%] min-w-0 flex-col gap-1">
                <p className="flex items-center gap-1.5 type-caption text-muted-foreground" data-testid="agent-ai-label">
                  <SparklesIcon aria-hidden="true" className="size-3.5 text-primary" />
                  <span className="sr-only">Assistant</span>
                  <span aria-hidden="true">{modelLabel(conversation)}</span>
                </p>
                <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2" data-testid="agent-ai-bubble">
                  {item.parts.map((part) => part.kind === "message"
                    ? <ChatMarkdown key={`m-${part.message.id}`} text={part.message.text} />
                    : (
                      <ol key={part.task.id} aria-label={`Task ${part.task.id.slice(5)}`}>
                        <TaskCard task={part.task} target={conversation.target} onDecide={decide} onCancel={() => cancelTask(part.task.id)} />
                      </ol>
                    ))}
                </div>
              </li>
            ) : (
              <li
                key={item.message.id}
                data-role={item.kind}
                className={item.kind === "user"
                  ? "self-end max-w-[85%] rounded-lg bg-primary/15 px-2.5 py-1.5 text-sm whitespace-pre-wrap break-words"
                  : "type-caption text-connection-connecting whitespace-pre-wrap"}
              >
                {item.kind === "user" ? <span className="sr-only">You: </span> : null}
                {item.message.text}
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      {/* SST-043: everything waiting for the user is pinned here, above the composer, outside the scrolling conversation. */}
      {trayCount || external ? (
        <section aria-label="Waiting for you" className="grid max-h-[45%] min-h-0 shrink content-start gap-2 overflow-y-auto border-t border-border px-3 py-2" data-testid="agent-tray">
          {trayCount ? <p className="type-caption text-connection-connecting" data-testid="agent-tray-count">{trayCount} waiting for you</p> : null}
          {conversation ? pending.map(({ task, kind }) => (
            <PendingCard key={kind === "plan" ? task.plan!.id : task.approval!.id} task={task} kind={kind} target={conversation.target} onDecide={decide} />
          )) : null}
          {fullAllowStep && target ? (
            <section role="alert" aria-labelledby="agent-full-allow-title" className="grid gap-2 rounded-md border border-border bg-background p-2 text-sm" data-testid="agent-full-allow-step">
              <h3 id="agent-full-allow-title" className="font-medium">Allow every command on {target.label}?</h3>
              <TargetLine target={target} />
              {target.environment === "PROD" ? <p className="text-environment-production">This is a PROD server.</p> : null}
              <p className="type-caption text-muted-foreground">
                The agent's commands run without asking you, including commands that change or delete data. ssterm still refuses
                full-screen programs and applies the timeout. This applies to this conversation only; a new conversation starts in Auto.
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" autoFocus onClick={() => setFullAllowStep(false)}>Cancel</Button>
                <Button size="sm" variant="destructive" onClick={(event) => { if (event.detail > 1) return; void setMode("full-allow", true); }}>
                  Allow every command
                </Button>
              </div>
            </section>
          ) : null}
          {password !== undefined && target ? (
            <section role="alert" aria-labelledby="agent-password-title" className="grid gap-1.5 rounded-md border border-border bg-background p-2 text-sm" data-testid="agent-password">
              <h3 id="agent-password-title" className="flex items-center gap-2 font-medium">
                <KeyRoundIcon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                Waiting for you to type the password in the terminal
              </h3>
              <TargetLine target={target} />
              <p className="text-connection-connecting" data-testid="agent-password-warning">
                Only type a password if you expected this prompt from <code className="font-mono text-xs break-all">{password}</code>.
              </p>
              <p className="type-caption text-muted-foreground">
                Type it in the terminal and press Return. ssterm does not pass what you type to the agent, and withholds the
                command's output if it prints your entry back; it cannot recognise every transformed copy. Stop in the terminal
                cancels the command.
              </p>
            </section>
          ) : null}
          {external}
        </section>
      ) : null}
      {conversation && conversation.status !== "idle" ? (
        <p className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 type-caption text-muted-foreground" role="status" data-testid="agent-progress">
          <Spinner aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate" title={progress(conversation)}>{progress(conversation)}</span>
        </p>
      ) : null}
      <form
        className="flex shrink-0 items-end gap-2 border-t border-border p-2"
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        <Textarea
          aria-label="Message to the agent"
          className="max-h-40 min-h-[4.875rem] flex-1 resize-none overflow-y-auto"
          rows={3}
          maxLength={MAX_AGENT_MESSAGE}
          value={draft}
          disabled={ended}
          placeholder={ended ? "Conversation ended" : "Ask the agent…"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
        />
        <div className="flex flex-col gap-1.5">
          {conversation && conversation.status !== "idle" && conversation.status !== "stopping" ? (
            <Button type="button" size="icon" variant="outline" aria-label="Stop the agent" title="Stop the agent" data-testid="agent-stop"
              onClick={() => void window.ssterm?.stopAgentTurn({ owner, sessionId }).catch(() => undefined)}>
              <SquareIcon aria-hidden="true" />
            </Button>
          ) : null}
          <Button type="submit" size="icon" aria-label="Send" disabled={busy || ended || !draft.trim()}>
            <SendIcon aria-hidden="true" />
          </Button>
        </div>
      </form>
    </aside>
  );
}

/** Approve (with the PROD confirmation step on a PROD target) or Reject one pending card. */
/**
 * SST-043: a new card takes focus on its safe action (Reject), but only when focus is in its own panel or nowhere, and
 * the agent composer holds no unsent text (review L2/L5: never taken from the terminal or another control).
 */
function Decision({ id, kind, target, onDecide }: { id: string; kind: "plan" | "command"; target: Target; onDecide: Decide }) {
  const [confirming, setConfirming] = useState(false);
  const reject = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = reject.current;
    const panel = button?.closest("aside");
    if (!button || !panel) return;
    const draft = document.querySelector<HTMLTextAreaElement>('[data-testid="agent-panel"] textarea[aria-label="Message to the agent"]')?.value.trim();
    const active = document.activeElement;
    if (!draft && (!active || active === document.body || panel.contains(active))) button.focus();
  }, []);
  const production = target.environment === "PROD";
  const approve = kind === "plan" ? "Approve plan" : "Run";
  if (confirming) {
    return (
      <section role="alert" aria-labelledby={`${id}-confirm`} className="mt-2 grid gap-1.5 rounded-md border border-environment-production p-2 text-sm" data-testid="agent-prod-confirm">
        <h4 id={`${id}-confirm`} className="font-medium">{kind === "plan" ? "Approve this plan" : "Run this command"} on {target.label}?</h4>
        <TargetLine target={target} />
        <p className="text-environment-production">This is a PROD server.</p>
        <p className="type-caption text-muted-foreground">
          {kind === "plan" ? "Each approved command then runs once without asking again." : "Running it does not confirm that it succeeded."}
        </p>
        <div className="flex gap-2">
          <Button size="xs" variant="outline" autoFocus onClick={() => setConfirming(false)}>Cancel</Button>
          <Button size="xs" variant="destructive" onClick={(event) => { if (event.detail > 1) return; onDecide(id, "approve", true); }}>
            {kind === "plan" ? "Approve plan on PROD" : "Run on PROD"}
          </Button>
        </div>
      </section>
    );
  }
  return (
    <div className="mt-2 flex gap-2">
      <Button size="xs" variant={production ? "destructive" : "default"} onClick={(event) => {
        if (event.detail > 1) return;
        if (production) setConfirming(true);
        else onDecide(id, "approve", false);
      }}>
        {approve}
      </Button>
      <Button ref={reject} size="xs" variant="outline" onClick={() => onDecide(id, "reject", false)}>Reject</Button>
    </div>
  );
}

/**
 * `onCancel` absent (an external binding): no status or Cancel; the client's own cancel tool and Stop apply, and the
 * card starts expanded (it is the binding's only content). SST-043: one summary line with an Expand toggle; a plan or
 * command waiting for a decision always shows, expanded or not.
 */
export function TaskCard({ task, target, onDecide, onCancel }: { task: AgentTask; target: Target; onDecide: Decide; onCancel?(): void }) {
  const open = !!onCancel && (task.status === "queued" || task.status === "running");
  const [expanded, setExpanded] = useState(!onCancel);
  const pendingPlan = task.plan?.status === "pending";
  // SST-043: in the panel a waiting card is pinned above the composer; an external binding shows it here.
  const inline = !onCancel;
  const waiting = pendingPlan || !!task.approval;
  const details = `${task.id}-details`;
  const commands = `${task.steps.length} ${task.steps.length === 1 ? "command" : "commands"}`;
  return (
    <li className="min-w-0 rounded-md border border-border bg-card p-1.5" data-testid="agent-task" data-task-id={task.id} data-status={task.status} data-expanded={expanded}>
      <div className="flex min-w-0 items-center gap-1.5" data-testid="agent-task-summary">
        {onCancel ? (
          <Badge variant={task.status === "failed" ? "destructive" : task.status === "running" ? "recording" : "outline"} className="shrink-0">
            {task.status === "running" ? <Spinner aria-hidden="true" /> : null}
            {taskStatus[task.status]}
          </Badge>
        ) : null}
        <p className="min-w-0 flex-1 truncate text-sm" title={task.goal}>
          {onCancel ? <span className="sr-only">Task {task.id.slice(5)}: </span> : null}
          {task.goal}
        </p>
        {waiting && !inline ? <span className="shrink-0 type-caption text-connection-connecting" data-testid="agent-task-waiting">Waiting for you ↓</span> : null}
        <span className="shrink-0 type-caption text-muted-foreground">{commands}</span>
        {open ? <Button size="xs" variant="outline" onClick={onCancel}>Cancel</Button> : null}
        <Button size="xs" variant="ghost" className="shrink-0" aria-expanded={expanded} aria-controls={details} onClick={() => setExpanded(!expanded)}>
          <ChevronRightIcon aria-hidden="true" className={`motion-safe:transition-transform ${expanded ? "rotate-90" : ""}`} />
          Expand
        </Button>
      </div>
      {task.plan && (pendingPlan ? inline : expanded) ? <PlanCard plan={task.plan} target={target} onDecide={onDecide} external={inline} /> : null}
      {task.approval && inline ? <ApprovalCard approval={task.approval} target={target} onDecide={onDecide} /> : null}
      {expanded ? (
        <div id={details} className="mt-1.5 min-w-0" data-testid="agent-task-details">
          <p className="text-sm break-words">{task.goal}</p>
          <p className="mt-1 type-caption text-muted-foreground">ssterm's own record; the agent's summary is checked against it.</p>
          <ol className="mt-1 flex flex-col gap-1.5" data-testid="agent-task-record">
            {task.steps.map((step, index) => (
              <li key={index} className="rounded-md border border-border p-1.5" data-step-status={step.status}>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs" title={step.command}>{step.command}</code>
                  <span className={`type-caption ${step.status === "refused" || (step.exitCode ?? 0) !== 0 ? "text-destructive" : "text-muted-foreground"}`}>
                    {stepStatus(step)}
                  </span>
                  {step.via ? <span className="type-caption text-muted-foreground" data-via={step.via}>· {via[step.via]}</span> : null}
                </div>
                {step.output ? <pre className="mt-1 max-h-48 overflow-auto rounded bg-background p-1.5 font-mono text-xs whitespace-pre-wrap">{step.output}</pre> : null}
              </li>
            ))}
          </ol>
          {task.limitReached ? <p className="mt-1.5 type-caption text-connection-connecting">The task reached its command limit; later commands were refused unrun.</p> : null}
          {task.subAgentReport ? (
            <Collapsible className="mt-1" data-testid="agent-task-report">
              <CollapsibleTrigger render={<Button size="xs" variant="ghost" className="group/report" />}>
                <ChevronRightIcon aria-hidden="true" className="motion-safe:transition-transform group-data-[panel-open]/report:rotate-90" />
                Sub agent report (unverified)
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1 rounded-md border border-dashed border-border p-2">
                <ChatMarkdown text={task.subAgentReport} />
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** SST-043: one waiting card in the pinned tray: which task, its target, the exact command(s) and the decision. */
function PendingCard({ task, kind, target, onDecide }: { task: AgentTask; kind: "plan" | "command"; target: Target; onDecide: Decide }) {
  return (
    <div className="min-w-0 rounded-md border border-connection-connecting bg-background p-2" data-testid="agent-pending" data-task-id={task.id} data-kind={kind}>
      <p className="flex min-w-0 items-center gap-1.5 type-caption text-muted-foreground">
        <span className="shrink-0 text-foreground">Task {taskNumber(task)}</span>
        <span className="min-w-0 truncate" title={task.goal}>{task.goal}</span>
      </p>
      {kind === "plan" ? <PlanCard plan={task.plan!} target={target} onDecide={onDecide} external={false} />
        : <ApprovalCard approval={task.approval!} target={target} onDecide={onDecide} />}
    </div>
  );
}

function ApprovalCard({ approval, target, onDecide }: { approval: NonNullable<AgentTask["approval"]>; target: Target; onDecide: Decide }) {
  return (
    <div className="mt-2 rounded-md border border-connection-connecting p-2" data-testid="agent-approval" data-approval-id={approval.id}>
      <p className="type-caption text-muted-foreground">The agent asks to run a command that is not in an approved plan:</p>
      <code className="mt-1 block rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all whitespace-pre-wrap">{approval.command}</code>
      <p className="mt-1.5"><TargetLine target={target} /></p>
      <Decision key={approval.id} id={approval.id} kind="command" target={target} onDecide={onDecide} />
    </div>
  );
}

function PlanCard({ plan, target, onDecide, external }: { plan: AgentPlan; target: Target; onDecide: Decide; external: boolean }) {
  return (
    <div className="mt-2 rounded-md border border-border p-2" data-testid="agent-plan" data-plan-id={plan.id} data-status={plan.status}>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 type-caption text-muted-foreground">{external ? "Plan proposed by the client" : "Plan proposed by the sub agent"}</p>
        <Badge variant={plan.status === "pending" ? "warning" : "outline"}>{planStatus[plan.status]}</Badge>
      </div>
      <p className="text-sm break-words">{plan.goal}</p>
      <ol className="mt-1 flex flex-col gap-1" aria-label="Plan commands">
        {plan.commands.map((entry, index) => (
          <li key={index} className="flex items-center gap-2">
            <code className="min-w-0 flex-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all whitespace-pre-wrap">{entry.command}</code>
            {entry.ran ? <span className="type-caption text-muted-foreground">used</span> : null}
          </li>
        ))}
      </ol>
      {plan.status === "pending" ? (
        <>
          <p className="mt-1.5"><TargetLine target={target} /></p>
          <p className="type-caption text-muted-foreground">
            Approved commands run without asking, each once, only when the agent sends exactly that text. Anything else asks you first.
          </p>
          <Decision key={plan.id} id={plan.id} kind="plan" target={target} onDecide={onDecide} />
        </>
      ) : null}
    </div>
  );
}

/** SST-043: an icon whose text shows on hover and on keyboard focus; the text is also the button's description. */
function InfoTip({ id, label, text, icon, testId }: { id: string; label: string; text: string; icon: ReactNode; testId: string }) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button size="icon-xs" variant="ghost" aria-label={label} aria-describedby={id} />}>{icon}</TooltipTrigger>
        <TooltipContent className="max-w-72">{text}</TooltipContent>
      </Tooltip>
      <span id={id} className="sr-only" data-testid={testId}>{text}</span>
    </>
  );
}
