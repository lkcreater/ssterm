/**
 * SST-041 ticket 03: the agent runner (ADR 0009 A5, A11, A12). Per Ready SSH session it keeps one in-memory
 * conversation with a main "DevOps Engineer" CLI that only has the delegate tools, and runs delegated tasks one at a
 * time through sub agent CLIs that only have the terminal tools of that session. ssterm's task record is what
 * `get_task_status` and the task cards show. Nothing conversation-related is written to disk except each run's
 * private MCP config, which is deleted with the run.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  AGENT_DISCLOSURE_VERSION, AGENT_EFFORTS, AGENT_MODELS, effectiveDefaultModel, isAgentModelId, isVerifiedAgentModel, MAX_AGENT_INSTRUCTIONS, MAX_AGENT_MESSAGES, MAX_AGENT_STEPS, MAX_AGENT_TASKS, channels, exactObject,
  failure, isAgentConversationRequest, isAgentSettingsRequest, isAgentStateRequest, isCancelAgentTaskRequest,
  isConfigureAgentRequest, isOpenAgentRequest, isSendAgentRequest,
  type AgentConversation, type AgentEffort, type AgentMessage, type AgentSettings, type AgentSettingsView, type AgentState, type AgentStep, type AgentTask,
  type ConfigureAgentResponse, type OpenAgentResponse, type Owner, type Result, type SendAgentResponse,
} from "@ssterm/contracts";
import type { ObservedTerminal, TerminalObserver } from "@ssterm/domain";
import type { SessionRegistry } from "@ssterm/services";
import type { AgentTerminals, AgentToolRole, ToolDefinition, ToolResult } from "./agent-mcp";
import { text } from "./agent-mcp";
import {
  agentInstructions, claudeArgs, mcpConfig, removeRunResidue, RUN_PROFILE_FILE, spawnCli, VERIFIED_CLAUDE_VERSIONS,
  type AgentTarget, type CliProcess, type ProviderResolution,
} from "./agent-cli";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";

// ---------------------------------------------------------------------------------------------------------------
// Settings: a versioned allowlist record in the profile (`agent-settings.json`, 0600), separate from the catalog
// schema like the SST-034 recording policy. No secrets: the CLI keeps its own login.

export interface StoredAgentSettings extends AgentSettings { disclosure: number }
export const DEFAULT_AGENT_SETTINGS: Readonly<StoredAgentSettings> = Object.freeze({
  enabled: false, provider: "claude", model: effectiveDefaultModel("claude"), effort: AGENT_MODELS.claude.defaultEffort, instructions: "", disclosure: 0,
});
/** Anything but an exact version 1 record (or a consent to an older disclosure) reads as off. */
export function parseAgentSettings(bytes: Uint8Array | undefined): StoredAgentSettings {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!exactObject(value, ["version", "enabled", "provider", "model", "effort", "instructions", "disclosure"]) || value.version !== 1) return { ...DEFAULT_AGENT_SETTINGS };
    if (typeof value.enabled !== "boolean" || value.provider !== "claude" || typeof value.instructions !== "string" ||
      !isAgentModelId(value.model) || !(AGENT_EFFORTS as readonly unknown[]).includes(value.effort) ||
      value.instructions.length > MAX_AGENT_INSTRUCTIONS || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value.instructions) ||
      !Number.isSafeInteger(value.disclosure)) return { ...DEFAULT_AGENT_SETTINGS };
    const disclosure = value.disclosure as number;
    // A model that is (no longer) verified for this CLI version falls back to the effective default.
    const model = isVerifiedAgentModel("claude", value.model) ? value.model : effectiveDefaultModel("claude");
    return { enabled: value.enabled && disclosure === AGENT_DISCLOSURE_VERSION, provider: "claude", model, effort: value.effort as AgentEffort, instructions: value.instructions, disclosure };
  } catch { return { ...DEFAULT_AGENT_SETTINGS }; }
}
export const serializeAgentSettings = (settings: StoredAgentSettings): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ version: 1, enabled: settings.enabled, provider: settings.provider, model: settings.model,
    effort: settings.effort, instructions: settings.instructions, disclosure: settings.disclosure }));
export interface AgentSettingsStore {
  read(): Promise<{ status: "present"; value: Uint8Array } | { status: "missing" } | { status: "error" }>;
  write(value: Uint8Array): Promise<"confirmed" | "unknown" | "invalid">;
}

// ---------------------------------------------------------------------------------------------------------------
// The main agent's tools (A5).

const MAX_GOAL = 4_000;
const MAX_OPEN_TASKS = 8;
const MAX_CONVERSATIONS = 8;
const MAX_TEXT = 16_384;
export const DELEGATE_TOOLS: readonly ToolDefinition[] = [
  {
    name: "delegate_task",
    description: "Starts a sub agent on the bound server with one self-contained goal. It runs commands in the user's visible " +
      "terminal under ssterm's rules. One task runs at a time; later tasks are queued. Returns the task id.",
    inputSchema: { type: "object", additionalProperties: false, required: ["goal"],
      properties: { goal: { type: "string", minLength: 1, maxLength: MAX_GOAL, description: "What the sub agent should find out or do." } } },
  },
  {
    name: "get_task_status",
    description: "Returns ssterm's own record of a task: its status, every command that ran or was refused, exit codes, " +
      "output (each command's last 64 KiB; older commands' output is shortened when the record is large) and subAgentReport, " +
      "the sub agent's own unverified text. With wait true, waits up to 60 seconds for the task to finish.",
    inputSchema: { type: "object", additionalProperties: false, required: ["taskId"],
      properties: { taskId: { type: "string" }, wait: { type: "boolean" } } },
  },
  {
    name: "cancel_task",
    description: "Cancels a queued or running task. A running command is interrupted with Ctrl+C.",
    inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string" } } },
  },
];
const MAIN_TOOLS = DELEGATE_TOOLS.map((tool) => `mcp__ssterm__${tool.name}`);
const SUB_TOOLS = ["run_command", "read_output", "cancel"].map((tool) => `mcp__ssterm__${tool}`);

interface Run { process: CliProcess; credential: string; root: string; allowed: readonly string[] }
interface Conversation {
  ownerId: string;
  sessionId: string;
  generation: number;
  target: AgentTarget;
  /** A14: fixed at open; the conversation's sub agents use the same. */
  model: string;
  effort: AgentEffort;
  status: AgentConversation["status"];
  messages: AgentMessage[];
  tasks: AgentTask[];
  nextMessage: number;
  nextTask: number;
  main?: Run;
  /** The main CLI is being started; one start at a time. */
  starting?: Promise<boolean>;
  sub?: { task: AgentTask; run?: Run };
  waiters: Set<() => void>;
  closed: boolean;
}
const finished = (task: AgentTask) => task.status !== "queued" && task.status !== "running";
const clip = (value: string, max = MAX_TEXT) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
/** Keeps the end of an output (the part a command's result is in), marked. */
const tail = (step: AgentStep, max: number, note: string): AgentStep =>
  step.output.length <= max ? { ...step } : { ...step, output: `${note}${step.output.slice(-max)}`, truncated: true };
/** Pushed task cards show each command's last 4 KiB; the full 64 KiB tail is in the record get_task_status returns. */
const VIEW_OUTPUT = 4_096;
const VIEW_NOTE = "[ssterm: earlier output not shown here]\n";
/** One get_task_status reply (sent as text and as structured content) stays well under the endpoint's 1 MiB per-connection buffer. */
const RECORD_BUDGET = 196_608;
const RECORD_NOTE = "[ssterm: output shortened to keep this record small; newer commands are complete]\n";
export function taskRecord(task: AgentTask) {
  let budget = RECORD_BUDGET;
  const commands = [...task.steps].reverse().map((step) => {
    const kept = budget >= step.output.length ? { ...step } : tail(step, Math.max(512, budget), RECORD_NOTE);
    budget = Math.max(0, budget - kept.output.length);
    return kept;
  }).reverse();
  return { taskId: task.id, goal: task.goal, status: task.status, limitReached: task.limitReached, subAgentReport: task.subAgentReport, commands };
}
/** Built-in agent definitions reported by the verified claude 2.1.309 run (inert: the Agent tool is not offered). */
const BUILTIN_AGENTS = ["claude", "Explore", "general-purpose", "Plan", "statusline-setup"];
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
/**
 * A2/A6 defence in depth, mirroring the ticket 01 detector: hook events, or an init that reports anything beyond ssterm's
 * server and the allowed tools, built-in plugins, no skills or slash commands and only the built-in agent definitions,
 * fail closed. An init without those fields fails too.
 */
export function isolationViolation(event: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  if (typeof event.subtype === "string" && event.subtype.startsWith("hook_")) return "a hook ran";
  if (event.type !== "system" || event.subtype !== "init") return undefined;
  const { tools, mcp_servers: servers, plugins, skills, slash_commands: commands, agents } = event;
  if (!strings(tools) || !Array.isArray(servers) || !Array.isArray(plugins) || !strings(skills) || !strings(commands) || !strings(agents))
    return "the CLI did not report its tools, servers, plugins, skills, commands and agents";
  if (tools.some((tool) => !allowed.includes(tool))) return "tools outside ssterm's allowlist";
  if (servers.some((server) => !server || typeof server !== "object" || (server as { name?: unknown }).name !== "ssterm")) return "another MCP server";
  if (plugins.some((plugin) => !plugin || typeof plugin !== "object" || (plugin as { path?: unknown }).path !== "builtin")) return "a non-builtin plugin";
  if (skills.length || commands.length) return "skills or slash commands";
  if (agents.some((agent) => !BUILTIN_AGENTS.includes(agent))) return "a non-builtin agent definition";
  return undefined;
}

export function createAgentRunner(options: {
  terminals: Pick<AgentTerminals, "issue" | "revoke">;
  registry: () => Pick<SessionRegistry, "snapshot"> | undefined;
  store: AgentSettingsStore;
  /** Absolute path of the bundled `ssterm-mcp` bridge. */
  bridge: string;
  /** The version gate, run before every spawn. */
  resolve(): Promise<ProviderResolution>;
  /** The CLI's environment (allowlisted) for one run's private temporary folder. */
  env(tmp: string): Record<string, string>;
  /** Where each run's folder is created (outside any repository). */
  tmp: string;
  /** Whose caches and session files are cleaned after a run. */
  home: string;
  /** Written into each run folder, so the startup sweep removes only this profile's leftovers. */
  profile: string;
  spawn?: typeof spawnCli;
  waitMs?: number;
  graceMs?: number;
}) {
  const spawn = options.spawn ?? spawnCli;
  const waitMs = options.waitMs ?? 60_000;
  const conversations = new Map<string, Conversation>();
  const owners = new Map<string, { owner: Owner; send(state: AgentState): void; sequence: number }>();
  const exits = new Set<Promise<void>>();
  /** Opens past the limit check but not yet registered: they hold their slot across the version check. */
  const opening = new Set<string>();
  let settings: StoredAgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  let disposed = false;
  const key = (ownerId: string, sessionId: string) => `${ownerId}\n${sessionId}`;

  const ready = options.store.read().then((stored) => { settings = parseAgentSettings(stored.status === "present" ? stored.value : undefined); }, () => undefined);

  const view = (conversation: Conversation): AgentConversation => ({
    sessionId: conversation.sessionId, generation: conversation.generation, target: { ...conversation.target }, provider: "claude",
    model: conversation.model, effort: conversation.effort,
    status: conversation.status, messages: conversation.messages.map((message) => ({ ...message })),
    tasks: conversation.tasks.map((task) => ({ ...task, steps: task.steps.map((step) => tail(step, VIEW_OUTPUT, VIEW_NOTE)) })),
  });
  const stateFor = (ownerId: string): AgentState | undefined => {
    const listener = owners.get(ownerId);
    if (!listener) return undefined;
    return {
      owner: { ...listener.owner }, sequence: listener.sequence, enabled: settings.enabled, provider: "claude",
      conversations: [...conversations.values()].filter((conversation) => conversation.ownerId === ownerId).map(view),
    };
  };
  const publish = (ownerId: string) => {
    const listener = owners.get(ownerId);
    if (!listener) return;
    listener.sequence += 1;
    try { listener.send(stateFor(ownerId)!); } catch { /* A destroyed window is revoked separately. */ }
  };
  const publishAll = () => { for (const ownerId of owners.keys()) publish(ownerId); };
  const wake = (conversation: Conversation) => { for (const waiter of [...conversation.waiters]) waiter(); };
  const say = (conversation: Conversation, role: AgentMessage["role"], value: string) => {
    conversation.messages.push({ id: conversation.nextMessage++, role, text: clip(value) });
    if (conversation.messages.length > MAX_AGENT_MESSAGES) conversation.messages.splice(0, conversation.messages.length - MAX_AGENT_MESSAGES);
  };

  /** The exact owner's live, Ready SSH terminal (not local, not Team-managed). */
  const bindable = (ownerId: string, sessionId: string, generation?: number) => {
    try {
      const snapshot = options.registry()?.snapshot(ownerId, sessionId)[0];
      if (!snapshot || snapshot.kind !== "terminal" || snapshot.state !== "Ready" || snapshot.local || !snapshot.target ||
        snapshot.target.source === "team" || (generation !== undefined && snapshot.generation !== generation)) return undefined;
      return snapshot;
    } catch { return undefined; }
  };

  /** Starts one CLI with its own credential, folder and MCP config. The folder and residue go when it exits. */
  async function launch(conversation: Conversation, role: "main" | "sub", credential: { credential: string; socketPath: string },
    path: string, onEvent: (event: Record<string, unknown>, run: Run) => void, onExit: (run: Run) => void): Promise<Run | undefined> {
    const root = join(options.tmp, `ssterm-agent-${randomBytes(8).toString("hex")}`);
    const allowed = role === "main" ? MAIN_TOOLS : SUB_TOOLS;
    try {
      await mkdir(root, { mode: 0o700 });
      await mkdir(join(root, "cwd"), { mode: 0o700 });
      await mkdir(join(root, "tmp"), { mode: 0o700 });
      // Names this profile for the startup sweep of leftovers (outside cwd, which stays empty).
      await writeFile(join(root, RUN_PROFILE_FILE), options.profile, { mode: 0o600, flag: "wx" });
      const config = join(root, "mcp.json");
      await writeFile(config, mcpConfig({ bridge: options.bridge, ...credential }), { mode: 0o600, flag: "wx" });
      if (conversation.closed || disposed) throw new Error("closed");
      let run: Run | undefined;
      const process = spawn({
        path, cwd: join(root, "cwd"), env: options.env(join(root, "tmp")),
        args: claudeArgs({ mcpConfig: config, tools: allowed, model: conversation.model, effort: conversation.effort,
          systemPrompt: agentInstructions(role, conversation.target, settings.instructions) }),
        onEvent: (event) => { if (run) onEvent(event, run); },
        ...(options.graceMs ? { graceMs: options.graceMs } : {}),
      });
      run = { process, credential: credential.credential, root, allowed };
      const finishedRun = run;
      const exit = process.exited.then(async () => {
        options.terminals.revoke(finishedRun.credential);
        await removeRunResidue({ home: options.home, root, pid: process.pid }).catch(() => undefined);
        onExit(finishedRun);
      });
      exits.add(exit);
      void exit.finally(() => exits.delete(exit));
      return run;
    } catch {
      options.terminals.revoke(credential.credential);
      await removeRunResidue({ home: options.home, root, pid: -1 }).catch(() => undefined);
      return undefined;
    }
  }
  /** An isolation violation: the credential goes first, then the whole process group is killed at once (no grace). */
  const violated = (event: Record<string, unknown>, run: Run): string | undefined => {
    const reason = isolationViolation(event, run.allowed);
    if (reason) { options.terminals.revoke(run.credential); run.process.kill(); }
    return reason;
  };
  const textOf = (event: Record<string, unknown>): string[] => {
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.flatMap((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" && (block as { text: string }).text.trim() ? [(block as { text: string }).text] : []);
  };

  // ------------------------------------------------------------------ the main agent

  async function startMain(conversation: Conversation): Promise<boolean> {
    const provider = await options.resolve();
    if (conversation.closed) return false;
    if (provider.status !== "ready") {
      say(conversation, "notice", "The claude CLI is no longer available in a verified version, so nothing was sent. Check Settings › AI Agent.");
      return false;
    }
    const role: AgentToolRole = { tools: DELEGATE_TOOLS, call: (name, args) => delegate(conversation, name, args) };
    const issued = await options.terminals.issue(conversation.ownerId, conversation.sessionId, { role });
    if (!issued || conversation.closed) {
      if (issued) options.terminals.revoke(issued.credential);
      else say(conversation, "notice", "The session is no longer Ready, so nothing was sent.");
      return false;
    }
    const run = await launch(conversation, "main", issued, provider.path, (event, current) => {
      const reason = violated(event, current);
      if (conversation.closed) return;
      if (reason) {
        say(conversation, "notice", `The CLI reported ${reason}, outside ssterm's isolation rules, so ssterm stopped it.`);
        void close(conversation);
        return;
      }
      if (conversation.main !== current) return;
      if (event.type === "assistant") for (const value of textOf(event)) say(conversation, "assistant", value);
      else if (event.type === "result") {
        conversation.status = "idle";
        if (event.is_error === true) say(conversation, "notice", "The agent ended this turn with an error.");
      } else return;
      publish(conversation.ownerId);
    }, (current) => {
      if (conversation.main !== current) return;
      conversation.main = undefined;
      if (conversation.closed) return;
      say(conversation, "notice", "The agent CLI stopped. Close the panel and open it again to start a new conversation.");
      conversation.status = "idle";
      // Without session persistence a new process would not remember this conversation.
      endTasks(conversation);
      publish(conversation.ownerId);
    });
    if (!run || conversation.closed) { void run?.process.stop(); return false; }
    conversation.main = run;
    return true;
  }

  async function delegate(conversation: Conversation, name: unknown, args: unknown): Promise<ToolResult> {
    if (conversation.closed) return text("This conversation has ended.", true);
    const task = (id: unknown) => conversation.tasks.find((candidate) => candidate.id === id);
    const record = taskRecord;
    switch (name) {
      case "delegate_task": {
        if (!exactObject(args, ["goal"]) || typeof args.goal !== "string" || !args.goal.trim() || args.goal.length > MAX_GOAL)
          return text("delegate_task takes exactly one string argument, `goal` (1–4000 characters).", true);
        if (conversation.tasks.filter((candidate) => !finished(candidate)).length >= MAX_OPEN_TASKS)
          return text(`At most ${MAX_OPEN_TASKS} tasks can wait at once. Wait for a task to finish or cancel one.`, true);
        const created: AgentTask = { id: `task-${++conversation.nextTask}`, goal: args.goal.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ").trim(), status: "queued", subAgentReport: null, limitReached: false, steps: [] };
        conversation.tasks.push(created);
        // Finished tasks are dropped oldest first; queued and running ones always stay.
        while (conversation.tasks.length > MAX_AGENT_TASKS) {
          const old = conversation.tasks.findIndex(finished);
          if (old < 0) break;
          conversation.tasks.splice(old, 1);
        }
        pump(conversation);
        publish(conversation.ownerId);
        return text({ taskId: created.id, status: created.status });
      }
      case "get_task_status": {
        const valid = exactObject(args, ["taskId"]) || (exactObject(args, ["taskId", "wait"]) && typeof args.wait === "boolean");
        const found = valid ? task((args as { taskId: unknown }).taskId) : undefined;
        if (!found) return text("Unknown task. get_task_status takes `taskId` (from delegate_task) and an optional boolean `wait`.", true);
        if ((args as { wait?: boolean }).wait && !finished(found)) {
          await new Promise<void>((resolve) => {
            const done = () => { if (finished(found) || conversation.closed) { clearTimeout(timer); conversation.waiters.delete(done); resolve(); } };
            const timer = setTimeout(() => { conversation.waiters.delete(done); resolve(); }, waitMs);
            conversation.waiters.add(done);
          });
        }
        if (conversation.closed) return text("This conversation has ended.", true);
        return text(record(found));
      }
      case "cancel_task": {
        const found = exactObject(args, ["taskId"]) ? task(args.taskId) : undefined;
        if (!found) return text("Unknown task. cancel_task takes `taskId`.", true);
        const cancelled = cancel(conversation, found);
        return text({ cancelled, status: found.status });
      }
      default:
        return text(`Unknown tool: ${typeof name === "string" ? name.slice(0, 64) : "?"}.`, true);
    }
  }

  // ------------------------------------------------------------------ sub agents, one per session at a time (A12)

  function pump(conversation: Conversation) {
    if (conversation.closed || conversation.sub) return;
    const next = conversation.tasks.find((candidate) => candidate.status === "queued");
    if (!next) return;
    next.status = "running";
    const sub: NonNullable<Conversation["sub"]> = { task: next };
    conversation.sub = sub;
    const settle = (status: AgentTask["status"]) => {
      if (conversation.sub !== sub) return;
      conversation.sub = undefined;
      if (!finished(next)) next.status = status;
      wake(conversation);
      if (conversation.closed) return;
      pump(conversation);
      publish(conversation.ownerId);
    };
    // Cancelled or closed while starting.
    const gone = () => conversation.sub !== sub || conversation.closed || finished(next);
    void (async () => {
      const provider = await options.resolve();
      if (gone()) return settle("cancelled");
      if (provider.status !== "ready") { next.subAgentReport = "The claude CLI is not available in a verified version."; return settle("failed"); }
      const issued = await options.terminals.issue(conversation.ownerId, conversation.sessionId, {
        record: (step) => {
          if (conversation.sub !== sub || next.steps.length >= MAX_AGENT_STEPS) return;
          next.steps.push({ ...step } satisfies AgentStep);
          publish(conversation.ownerId);
        },
        // Checked before a command runs: past the limit nothing is typed, and the record says so.
        admit: () => {
          if (conversation.sub !== sub || finished(next)) return "This task has ended; nothing was sent to the terminal.";
          if (next.steps.length < MAX_AGENT_STEPS) return undefined;
          if (!next.limitReached) { next.limitReached = true; publish(conversation.ownerId); }
          return `This task reached its limit of ${MAX_AGENT_STEPS} commands; nothing more was sent to the terminal. Finish with your report.`;
        },
      });
      if (!issued) { next.subAgentReport = "The session is no longer Ready."; return settle("failed"); }
      if (gone()) { options.terminals.revoke(issued.credential); return settle("cancelled"); }
      const run = await launch(conversation, "sub", issued, provider.path, (event, current) => {
        const reason = violated(event, current);
        if (reason) {
          next.subAgentReport = `ssterm stopped the sub agent: the CLI reported ${reason}, outside ssterm's isolation rules.`;
          next.status = "failed";
          publish(conversation.ownerId);
          return;
        }
        if (event.type !== "result" || finished(next)) return;
        if (typeof event.result === "string") next.subAgentReport = clip(event.result);
        next.status = event.is_error === true ? "failed" : "completed";
        current.process.endInput();
        publish(conversation.ownerId);
      }, () => settle("failed"));
      if (!run) { next.subAgentReport = "The sub agent could not be started."; return settle("failed"); }
      // The credential goes before the process: no call can start in between.
      if (gone()) { options.terminals.revoke(run.credential); void run.process.stop(); return; }
      sub.run = run;
      run.process.write({ type: "user", message: { role: "user", content: `Task ${next.id}: ${next.goal}` } });
      run.process.endInput();
    })();
  }

  function cancel(conversation: Conversation, task: AgentTask): boolean {
    if (finished(task)) return false;
    task.status = "cancelled";
    const sub = conversation.sub;
    if (sub?.task === task && sub.run) {
      // Revoking interrupts its running command first; then the CLI's process group goes.
      options.terminals.revoke(sub.run.credential);
      void sub.run.process.stop();
    }
    wake(conversation);
    publish(conversation.ownerId);
    return true;
  }
  /** Queued and running tasks end with the conversation's main agent. */
  function endTasks(conversation: Conversation) {
    for (const task of conversation.tasks) if (!finished(task)) cancel(conversation, task);
  }

  // ------------------------------------------------------------------ lifecycle (A11)

  /** Lock, session end, panel close, owner revoke and quit: processes stop, credentials go, pending calls are refused. */
  function close(conversation: Conversation): Promise<void> {
    if (conversation.closed) return Promise.resolve();
    conversation.closed = true;
    if (conversations.get(key(conversation.ownerId, conversation.sessionId)) === conversation)
      conversations.delete(key(conversation.ownerId, conversation.sessionId));
    const runs = [conversation.main, conversation.sub?.run].filter((run): run is Run => !!run);
    for (const run of runs) options.terminals.revoke(run.credential);
    for (const task of conversation.tasks) if (!finished(task)) task.status = "cancelled";
    wake(conversation);
    // Memory only: the conversation is dropped here.
    conversation.messages = [];
    conversation.tasks = [];
    publish(conversation.ownerId);
    return Promise.all(runs.map((run) => run.process.stop())).then(() => undefined);
  }
  const closeWhere = (match: (conversation: Conversation) => boolean) =>
    Promise.all([...conversations.values()].filter(match).map(close)).then(() => undefined);

  return {
    ready,
    async settingsView(resolution?: ProviderResolution): Promise<AgentSettingsView> {
      await ready;
      const provider = resolution ?? await options.resolve();
      return {
        settings: { enabled: settings.enabled, provider: settings.provider, model: settings.model, effort: settings.effort, instructions: settings.instructions },
        providers: [
          { id: "claude", status: provider.status, version: provider.version },
          { id: "codex", status: "disabled", version: null },
        ],
        verified: [...VERIFIED_CLAUDE_VERSIONS],
      };
    },
    async configure(next: AgentSettings, consent: boolean): Promise<ConfigureAgentResponse> {
      await ready;
      const turningOn = next.enabled && !(settings.enabled && settings.provider === next.provider && settings.disclosure === AGENT_DISCLOSURE_VERSION);
      if (turningOn && !consent) return { status: "consent-required" };
      if (!isVerifiedAgentModel(next.provider, next.model)) return { status: "model-unverified" };
      const provider = next.enabled ? await options.resolve() : undefined;
      if (provider && provider.status !== "ready") return { status: "provider-unavailable", view: await this.settingsView(provider) };
      // Turning the agent off withdraws the consent; turning it on again shows the disclosure again.
      const stored: StoredAgentSettings = { ...next, disclosure: next.enabled ? AGENT_DISCLOSURE_VERSION : 0 };
      if (await options.store.write(serializeAgentSettings(stored)) !== "confirmed") return { status: "failed" };
      settings = stored;
      if (!stored.enabled) await closeWhere(() => true);
      publishAll();
      return { status: "saved", view: await this.settingsView(provider) };
    },
    register(owner: Owner, send: (state: AgentState) => void) {
      const ownerId = sessionOwnerId(owner);
      owners.set(ownerId, { owner: { ...owner }, send, sequence: owners.get(ownerId)?.sequence ?? 0 });
    },
    async state(owner: Owner): Promise<AgentState> {
      await ready;
      const ownerId = sessionOwnerId(owner);
      return stateFor(ownerId) ?? { owner: { ...owner }, sequence: 0, enabled: settings.enabled, provider: "claude",
        conversations: [...conversations.values()].filter((conversation) => conversation.ownerId === ownerId).map(view) };
    },
    async open(owner: Owner, sessionId: string, generation: number): Promise<OpenAgentResponse> {
      await ready;
      if (disposed || !settings.enabled) return { status: "refused", reason: "disabled" };
      const ownerId = sessionOwnerId(owner);
      const snapshot = bindable(ownerId, sessionId, generation);
      if (!snapshot?.target) return { status: "refused", reason: "session" };
      const existing = conversations.get(key(ownerId, sessionId));
      if (existing?.generation === generation) return { status: "opened" };
      if (existing) await close(existing);
      const slot = key(ownerId, sessionId);
      if (opening.has(slot)) return { status: "refused", reason: "session" };
      const held = [...conversations.values()].filter((conversation) => conversation.ownerId === ownerId).length +
        [...opening].filter((pending) => pending.startsWith(`${ownerId}\n`)).length;
      if (held >= MAX_CONVERSATIONS) return { status: "refused", reason: "limit" };
      opening.add(slot);
      try {
        if ((await options.resolve()).status !== "ready") return { status: "refused", reason: "provider" };
        // The session may have ended or the agent been turned off during the version check.
        if (disposed || !settings.enabled || !bindable(ownerId, sessionId, generation) || conversations.has(slot)) return { status: "refused", reason: "session" };
        const { label, address, port, username, environment } = snapshot.target;
        conversations.set(slot, {
          ownerId, sessionId, generation, status: "idle", messages: [], tasks: [], nextMessage: 1, nextTask: 0, waiters: new Set(), closed: false,
          target: { label, environment, endpoint: `${username ? `${username}@` : ""}${address}:${port}` },
          model: settings.model, effort: settings.effort,
        });
      } finally { opening.delete(slot); }
      publish(ownerId);
      return { status: "opened" };
    },
    async close(owner: Owner, sessionId: string): Promise<void> {
      const conversation = conversations.get(key(sessionOwnerId(owner), sessionId));
      if (conversation) await close(conversation);
    },
    async send(owner: Owner, sessionId: string, message: string): Promise<SendAgentResponse> {
      const conversation = conversations.get(key(sessionOwnerId(owner), sessionId));
      if (!conversation || conversation.closed) return { status: "refused", reason: "ended" };
      if (conversation.status !== "idle") return { status: "refused", reason: "busy" };
      say(conversation, "user", message);
      conversation.status = conversation.main ? "thinking" : "starting";
      publish(conversation.ownerId);
      if (!conversation.main) {
        const started = await (conversation.starting ??= startMain(conversation).finally(() => { conversation.starting = undefined; }));
        if (!started || conversation.closed) {
          if (!conversation.closed) { conversation.status = "idle"; publish(conversation.ownerId); }
          return { status: "sent" };
        }
        conversation.status = "thinking";
        publish(conversation.ownerId);
      }
      if (!conversation.main?.process.write({ type: "user", message: { role: "user", content: message } })) {
        conversation.status = "idle";
        publish(conversation.ownerId);
      }
      return { status: "sent" };
    },
    cancelTask(owner: Owner, sessionId: string, taskId: string): boolean {
      const conversation = conversations.get(key(sessionOwnerId(owner), sessionId));
      const task = conversation?.tasks.find((candidate) => candidate.id === taskId);
      return !!conversation && !!task && cancel(conversation, task);
    },
    /** Registry tap: the conversation ends with its session generation. */
    observe(session: ObservedTerminal): TerminalObserver | undefined {
      if (session.local) return undefined;
      return {
        output() {},
        end: () => { void closeWhere((conversation) => conversation.ownerId === session.ownerId && conversation.sessionId === session.sessionId && conversation.generation === session.generation); },
      };
    },
    revokeOwner(owner: Owner): void {
      const ownerId = sessionOwnerId(owner);
      void closeWhere((conversation) => conversation.ownerId === ownerId);
      owners.delete(ownerId);
    },
    lock(): Promise<void> { return closeWhere(() => true); },
    /** Quit: every CLI group gets SIGTERM, then SIGKILL; resolves when they and their cleanup are done. */
    async dispose(): Promise<void> {
      disposed = true;
      await closeWhere(() => true);
      await Promise.all([...exits]);
      owners.clear();
    },
    /** Test and diagnostics: live CLI process ids. */
    pids(): number[] {
      return [...conversations.values()].flatMap((conversation) => [conversation.main?.process.pid, conversation.sub?.run?.process.pid])
        .filter((pid): pid is number => typeof pid === "number" && pid > 0);
    },
  };
}
export type AgentRunner = ReturnType<typeof createAgentRunner>;

// ---------------------------------------------------------------------------------------------------------------
// IPC: owner-authorized (the app lock answers `unauthorized` first), one validated argument each.

export const agentChannels = Object.freeze([
  channels.agentSettings, channels.configureAgent, channels.agentState, channels.openAgent, channels.closeAgent,
  channels.sendAgent, channels.cancelAgentTask,
]);
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export function registerAgentHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: Pick<WindowBoundary, "authorizeOwner">;
  runner: () => AgentRunner | undefined;
}): () => void {
  const handle = <T>(channel: string, validate: (value: unknown) => value is T, run: (runner: AgentRunner, request: T, owner: Owner) => Promise<Result<unknown>>) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const runner = options.runner();
        return runner ? await run(runner, request, authorized.value) : failure("unavailable");
      } catch { return failure("unavailable"); }
    });
  };
  handle(channels.agentSettings, isAgentSettingsRequest, async (runner) => ok(await runner.settingsView()));
  handle(channels.configureAgent, isConfigureAgentRequest, async (runner, request) => ok(await runner.configure({ ...request.settings }, request.consent)));
  handle(channels.agentState, isAgentStateRequest, async (runner, _request, owner) => ok(await runner.state(owner)));
  handle(channels.openAgent, isOpenAgentRequest, async (runner, request, owner) => ok(await runner.open(owner, request.sessionId, request.generation)));
  handle(channels.closeAgent, isAgentConversationRequest, async (runner, request, owner) => {
    await runner.close(owner, request.sessionId);
    return ok({ accepted: true as const });
  });
  handle(channels.sendAgent, isSendAgentRequest, async (runner, request, owner) => ok(await runner.send(owner, request.sessionId, request.text)));
  handle(channels.cancelAgentTask, isCancelAgentTaskRequest, async (runner, request, owner) =>
    ok({ cancelled: runner.cancelTask(owner, request.sessionId, request.taskId) }));
  return () => { for (const channel of agentChannels) options.ipc.removeHandler(channel); };
}
