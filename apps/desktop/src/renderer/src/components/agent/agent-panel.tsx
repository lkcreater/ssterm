import { useEffect, useRef, useState } from "react";
import { BotIcon, ChevronRightIcon, SendIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import type { AgentConversation, AgentStep, AgentTask, Owner } from "@ssterm/contracts";
import { AGENT_MODELS, MAX_AGENT_MESSAGE } from "@ssterm/contracts";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";

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
  }
};

/**
 * SST-041 ticket 03: the non-modal AI Agent panel on the Terminals page (ADR 0009 exception to the drawer contract).
 * Bound to the session it was opened from; tab switches never move it. The conversation lives in main, in memory.
 */
export function AgentPanel({
  owner,
  sessionId,
  conversation,
  onClose,
}: {
  owner: Owner;
  sessionId: string;
  /** Undefined until main publishes it, and again once it has ended (session end, lock, or the agent turned off). */
  conversation: AgentConversation | undefined;
  onClose(): void;
}) {
  const [seen, setSeen] = useState(false);
  if (conversation && !seen) setSeen(true);
  const ended = seen && !conversation;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const busy = sending || !conversation || conversation.status !== "idle";
  const count = (conversation?.messages.length ?? 0) + (conversation?.tasks.reduce((sum, task) => sum + task.steps.length + 1, 0) ?? 0);
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
  const target = conversation?.target;

  return (
    <aside className="agent-panel flex h-full min-w-0 flex-col border-l border-border bg-card" aria-label="AI Agent" data-testid="agent-panel" data-session-id={sessionId}>
      <header className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2">
        <BotIcon aria-hidden="true" className="mt-0.5 size-4 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="type-label">AI Agent</h2>
          {target ? (
            <p className="flex min-w-0 items-center gap-1.5 type-caption text-muted-foreground" data-testid="agent-target">
              <span className="truncate text-foreground" title={target.label}>{target.label}</span>
              <span className="truncate" title={target.endpoint}>{target.endpoint}</span>
              <EnvironmentBadge environment={target.environment} />
            </p>
          ) : null}
          {conversation ? (
            <p className="type-caption text-muted-foreground" data-testid="agent-model">
              {AGENT_MODELS.claude.models.find((entry) => entry.id === conversation.model || entry.alias === conversation.model)?.label ?? conversation.model}
              {" · "}effort {conversation.effort}
            </p>
          ) : null}
        </div>
        <Badge variant="outline" title="Read only: ssterm runs only commands its allowlist classifies as read-only (best effort) and refuses the rest.">Read only</Badge>
        <Button size="icon-sm" variant="ghost" aria-label="Close AI Agent" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </header>
      <p role="note" className="flex shrink-0 gap-2 border-b border-border px-3 py-2 type-caption text-muted-foreground" data-testid="agent-provider-banner">
        <ShieldAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-connection-connecting" />
        <span>
          Your messages, the agent's commands and their full output are sent to Anthropic through your claude CLI, under your
          account's terms. Nothing is redacted.
        </span>
      </p>
      <div ref={log} role="log" aria-live="polite" aria-label="Conversation" className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="agent-messages">
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
        <ol className="flex flex-col gap-2">
          {conversation?.messages.map((message) => (
            <li
              key={message.id}
              data-role={message.role}
              className={
                message.role === "user"
                  ? "self-end max-w-[85%] rounded-lg bg-primary/15 px-2.5 py-1.5 text-sm whitespace-pre-wrap"
                  : message.role === "notice"
                    ? "type-caption text-connection-connecting whitespace-pre-wrap"
                    : "max-w-[95%] text-sm whitespace-pre-wrap"
              }
            >
              {message.role === "user" ? <span className="sr-only">You: </span> : message.role === "assistant" ? <span className="sr-only">Agent: </span> : null}
              {message.text}
            </li>
          ))}
        </ol>
        {conversation?.tasks.length ? (
          <ol className="mt-3 flex flex-col gap-2" aria-label="Tasks">
            {conversation.tasks.map((task) => <TaskCard key={task.id} task={task} onCancel={() => cancelTask(task.id)} />)}
          </ol>
        ) : null}
        {conversation && conversation.status !== "idle" ? (
          <p className="mt-2 flex items-center gap-2 type-caption text-muted-foreground" role="status">
            <Spinner aria-hidden="true" /> {conversation.status === "starting" ? "Starting the agent…" : "Agent is working…"}
          </p>
        ) : null}
      </div>
      <form
        className="flex shrink-0 items-end gap-2 border-t border-border p-2"
        onSubmit={(event) => { event.preventDefault(); void send(); }}
      >
        <Textarea
          aria-label="Message to the agent"
          className="max-h-40 min-h-9 flex-1 resize-none"
          rows={1}
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
        <Button type="submit" size="icon" aria-label="Send" disabled={busy || ended || !draft.trim()}>
          <SendIcon aria-hidden="true" />
        </Button>
      </form>
    </aside>
  );
}

function TaskCard({ task, onCancel }: { task: AgentTask; onCancel(): void }) {
  const open = task.status === "queued" || task.status === "running";
  return (
    <li className="rounded-lg border border-border bg-background p-2" data-testid="agent-task" data-task-id={task.id} data-status={task.status}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="type-caption text-muted-foreground">Task {task.id.slice(5)}</p>
          <p className="text-sm break-words">{task.goal}</p>
        </div>
        <Badge variant={task.status === "failed" ? "destructive" : task.status === "running" ? "recording" : "outline"}>
          {task.status === "running" ? <Spinner aria-hidden="true" /> : null}
          {taskStatus[task.status]}
        </Badge>
        {open ? <Button size="xs" variant="outline" onClick={onCancel}>Cancel</Button> : null}
      </div>
      <Collapsible>
        <CollapsibleTrigger render={<Button size="xs" variant="ghost" className="mt-1 group/record" />}>
          <ChevronRightIcon aria-hidden="true" className="transition-transform group-data-[panel-open]/record:rotate-90" />
          Record ({task.steps.length} {task.steps.length === 1 ? "command" : "commands"})
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="mt-1 type-caption text-muted-foreground">ssterm's own record; the agent's summary is checked against it.</p>
          <ol className="mt-1 flex flex-col gap-1.5" data-testid="agent-task-record">
            {task.steps.map((step, index) => (
              <li key={index} className="rounded-md border border-border p-1.5" data-step-status={step.status}>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs" title={step.command}>{step.command}</code>
                  <span className={`type-caption ${step.status === "refused" || (step.exitCode ?? 0) !== 0 ? "text-destructive" : "text-muted-foreground"}`}>
                    {stepStatus(step)}
                  </span>
                </div>
                {step.output ? <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-1.5 font-mono text-xs whitespace-pre-wrap">{step.output}</pre> : null}
              </li>
            ))}
          </ol>
          {task.limitReached ? <p className="mt-1.5 type-caption text-connection-connecting">The task reached its command limit; later commands were refused unrun.</p> : null}
          {task.subAgentReport ? <p className="mt-1.5 text-xs whitespace-pre-wrap"><span className="text-muted-foreground">Sub agent report (unverified): </span>{task.subAgentReport}</p> : null}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
