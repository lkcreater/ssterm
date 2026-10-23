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
  isConfigureAgentRequest, isDecideAgentRequest, isOpenAgentRequest, isSendAgentRequest, isSetAgentModeRequest,
  isCheckAgentProviderRequest, isAgentCustomProvider,
  type AgentConversation, type AgentCustomProvider, type AgentEffort, type AgentMessage, type AgentMode, type AgentPlan, type AgentProvider, type AgentProviderStatus,
  type AgentProviderView, type AgentSettings, type AgentSettingsView, type AgentState,
  type AgentStep, type AgentTask, type ConfigureAgentResponse, type DecideAgentResponse, type OpenAgentResponse, type Owner, type Result,
  type SendAgentResponse, type SetAgentModeResponse,
} from "@ssterm/contracts";
import type { ObservedTerminal, TerminalObserver } from "@ssterm/domain";
import type { SessionRegistry } from "@ssterm/services";
import type { AgentGate, AgentTerminals, AgentToolRole, ToolDefinition, ToolResult } from "./agent-mcp";
import { readOnlyRefusal, text, TOOLS } from "./agent-mcp";
import { APPROVAL_WAIT_MS, MAX_PLANS_PER_TASK, normalizeCommand, parsePlan, takePlanCommand, unshowable } from "./agent-policy";
import {
  agentInstructions, CLAUDE_ENV, claudeArgs, cleanStateResidue, CODEX_FAILURES, VERIFIED_CODEX_VERSIONS, codexArgs, codexViolation, customArgs, customEnv, isolationViolation, mcpConfig, removeRunResidue,
  resolveCustom, RUN_PROFILE_FILE, spawnCli, VERIFIED_CLAUDE_VERSIONS, type AgentTarget, type CliProcess, type CustomResolution, type ProviderResolution,
} from "./agent-cli";
import { checkCustomProvider, sanitizeReasons } from "./agent-check";
export { isolationViolation } from "./agent-cli";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";

// ---------------------------------------------------------------------------------------------------------------
// Settings: a versioned allowlist record in the profile (`agent-settings.json`, 0600), separate from the catalog
// schema like the SST-034 recording policy. No secrets: the CLI keeps its own login.

/** Ticket 06: the last isolation check of the custom provider, bound to the fingerprint it ran against. */
export interface CustomCheckRecord { fingerprint: string; status: "passed" | "passed-live-unverified-requests" | "failed" | "unverifiable"; reasons: string[]; version: string | null }
export interface StoredAgentSettings extends AgentSettings { disclosure: number; customCheck: CustomCheckRecord | null }
export const DEFAULT_AGENT_SETTINGS: Readonly<StoredAgentSettings> = Object.freeze({
  enabled: false, provider: "claude", model: effectiveDefaultModel("claude"), effort: AGENT_MODELS.claude.defaultEffort, instructions: "",
  allowFullAllowOnProd: false, custom: null, disclosure: 0, customCheck: null,
});
const isCheckRecord = (v: unknown): v is CustomCheckRecord => exactObject(v, ["fingerprint", "status", "reasons", "version"]) &&
  typeof v.fingerprint === "string" && /^[0-9a-f]{64}$/u.test(v.fingerprint) && ["passed", "passed-live-unverified-requests", "failed", "unverifiable"].includes(v.status as string) &&
  Array.isArray(v.reasons) && v.reasons.length <= 16 && v.reasons.every((reason) => typeof reason === "string" && reason.length <= 600 && !/[\u0000-\u001f\u007f]/u.test(reason)) &&
  (v.version === null || (typeof v.version === "string" && v.version.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(v.version)));
/**
 * Anything but an exact version 3 record, a version 2 record (ticket 04) or a version 1 record (ticket 03, read with
 * "Allow Full allow on PROD" off), or a consent to an older disclosure, reads as off. Versions 1 and 2 knew claude only.
 */
export function parseAgentSettings(bytes: Uint8Array | undefined): StoredAgentSettings {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const fields = ["version", "enabled", "provider", "model", "effort", "instructions", "disclosure"];
    const v1 = exactObject(parsed, fields) && parsed.version === 1;
    const v2 = exactObject(parsed, [...fields, "allowFullAllowOnProd"]) && parsed.version === 2;
    const v3 = exactObject(parsed, [...fields, "allowFullAllowOnProd", "custom", "customCheck"]) && parsed.version === 3 &&
      (parsed.custom === null || isAgentCustomProvider(parsed.custom)) && (parsed.customCheck === null || isCheckRecord(parsed.customCheck)) &&
      ["claude", "codex", "custom"].includes(parsed.provider as string);
    if (!v1 && !v2 && !v3) return { ...DEFAULT_AGENT_SETTINGS };
    const value = parsed as Record<string, unknown>;
    if (!v1 && typeof value.allowFullAllowOnProd !== "boolean") return { ...DEFAULT_AGENT_SETTINGS };
    if (typeof value.enabled !== "boolean" || (!v3 && value.provider !== "claude") || typeof value.instructions !== "string" ||
      !isAgentModelId(value.model) || !(AGENT_EFFORTS as readonly unknown[]).includes(value.effort) ||
      value.instructions.length > MAX_AGENT_INSTRUCTIONS || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value.instructions) ||
      !Number.isSafeInteger(value.disclosure)) return { ...DEFAULT_AGENT_SETTINGS };
    const disclosure = value.disclosure as number;
    // A model that is (no longer) verified for this CLI version falls back to the effective default (per built-in provider;
    // a custom provider names its model in its definition, and this field stays the claude choice).
    const builtin = value.provider === "codex" ? "codex" : "claude";
    const model = isVerifiedAgentModel(builtin, value.model as string) ? value.model as string : effectiveDefaultModel(builtin);
    return { enabled: value.enabled && disclosure === AGENT_DISCLOSURE_VERSION, provider: value.provider as AgentProvider, model, effort: value.effort as AgentEffort, instructions: value.instructions,
      allowFullAllowOnProd: value.allowFullAllowOnProd === true, custom: v3 ? value.custom as AgentCustomProvider | null : null, disclosure,
      customCheck: v3 ? value.customCheck as CustomCheckRecord | null : null };
  } catch { return { ...DEFAULT_AGENT_SETTINGS }; }
}
export const serializeAgentSettings = (settings: StoredAgentSettings): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ version: 3, enabled: settings.enabled, provider: settings.provider, model: settings.model,
    effort: settings.effort, instructions: settings.instructions, allowFullAllowOnProd: settings.allowFullAllowOnProd, custom: settings.custom,
    customCheck: settings.customCheck, disclosure: settings.disclosure }));
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
const SUB_TOOLS = ["propose_plan", "run_command", "read_output", "cancel"].map((tool) => `mcp__ssterm__${tool}`);
type Outcome = "approved" | "rejected" | "expired" | "cancelled";
const outcomeText: Record<Exclude<Outcome, "approved">, string> = {
  rejected: "The user rejected it.",
  expired: `No decision came within ${APPROVAL_WAIT_MS / 60_000} minutes, so it expired.`,
  cancelled: "The approval was withdrawn: the request was cancelled, the mode changed, the task ended or the session closed.",
};

/**
 * Ticket 06: how one provider is launched, resolved again before every spawn. `input`: a long-lived process reading
 * stream-json messages, or one process per message reading its prompt as text. `dialect`: the events it prints.
 */
interface Launcher {
  path: string;
  input: "stream-json" | "one-shot";
  dialect: "claude" | "codex";
  build(run: { config: string; promptFile: string; cwd: string; tmp: string; tools: readonly string[]; systemPrompt: string; model: string; effort: AgentEffort;
    credential: { credential: string; socketPath: string } }): { args: string[]; env: Record<string, string> };
}
/** One provider's state for Settings, and its launcher when it can run. `record`: the custom check that applies now. */
interface ProviderState { status: AgentProviderStatus; version: string | null; reasons: string[]; launcher?: Launcher; record?: CustomCheckRecord }
/** What one CLI event means, whichever dialect printed it. */
interface Reading { violation?: string; texts: string[]; result?: { error: boolean; text?: string } }
function read(dialect: Launcher["dialect"], event: Record<string, unknown>, allowed: readonly string[]): Reading {
  if (dialect === "codex") {
    const item = event.item as { type?: unknown; text?: unknown } | undefined;
    return {
      violation: codexViolation(event, allowed),
      texts: event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" && item.text.trim() ? [item.text] : [],
      ...(event.type === "turn.completed" ? { result: { error: false } } : event.type === "turn.failed" || event.type === "error" ? { result: { error: true } } : {}),
    };
  }
  const message = event.message as { content?: unknown } | undefined;
  const content = event.type === "assistant" && Array.isArray(message?.content) ? message.content : [];
  return {
    violation: isolationViolation(event, allowed),
    texts: content.flatMap((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" && (block as { text: string }).text.trim() ? [(block as { text: string }).text] : []),
    ...(event.type === "result" ? { result: { error: event.is_error === true, ...(typeof event.result === "string" ? { text: event.result } : {}) } } : {}),
  };
}
const PROVIDER_NAMES: Record<AgentProvider, string> = { claude: "The claude CLI", codex: "The codex CLI", custom: "The custom CLI provider" };
/** A one-shot provider keeps no memory between processes: each prompt carries the conversation so far (memory only). */
const ONE_SHOT_HISTORY = 49_152;
function oneShotPrompt(history: readonly AgentMessage[], latest: string): string {
  const lines: string[] = [];
  let budget = ONE_SHOT_HISTORY;
  for (const message of history.filter((entry) => entry.role !== "notice").reverse()) {
    const line = `${message.role === "user" ? "User" : "Agent"}: ${message.text}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.unshift(line);
  }
  return lines.length ? `The conversation so far (kept by ssterm):\n\n${lines.join("\n\n")}\n\nThe user's new message:\n${latest}` : latest;
}
/** The target shown to a custom provider during its isolation check: nothing is bound. */
const CHECK_TARGET: AgentTarget = { label: "isolation check", endpoint: "check@localhost:22", environment: null };

interface Run { process: CliProcess; credential: string; root: string; allowed: readonly string[]; input: Launcher["input"]; dialect: Launcher["dialect"]; answered: boolean }
interface Conversation {
  ownerId: string;
  /** How long a card waits: 5 minutes, or less when the CLI's client stops waiting for a tool call sooner (custom). */
  approvalMs: number;
  sessionId: string;
  generation: number;
  target: AgentTarget;
  /** Ticket 06: fixed at open, and resolved again (version gate, custom fingerprint) before every spawn. */
  provider: AgentProvider;
  /** A14: fixed at open; the conversation's sub agents use the same. */
  model: string;
  effort: AgentEffort;
  /** Ticket 04: Auto for every new conversation. */
  mode: AgentMode;
  /** Pending plan and command cards of this conversation, by approval id. */
  decisions: Map<string, { taskId: string; finish(outcome: Outcome): void }>;
  nextApproval: number;
  /** Part of every approval id of this conversation (L4). */
  nonce: string;
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
  return { taskId: task.id, goal: task.goal, status: task.status, limitReached: task.limitReached, subAgentReport: task.subAgentReport,
    plan: task.plan, commands };
}
export function createAgentRunner(options: {
  terminals: Pick<AgentTerminals, "issue" | "revoke">;
  registry: () => Pick<SessionRegistry, "snapshot"> | undefined;
  store: AgentSettingsStore;
  /** Absolute path of the bundled `ssterm-mcp` bridge. */
  bridge: string;
  /** The claude version gate, run before every spawn. */
  resolve(): Promise<ProviderResolution>;
  /** Ticket 06: the codex version gate (no version is verified, so it never resolves ready today). */
  resolveCodex?(): Promise<ProviderResolution>;
  /** Ticket 06: the custom binary's real path, version output and fingerprint. */
  resolveCustom?: typeof resolveCustom;
  /** Ticket 06: the custom provider's isolation check. */
  check?: typeof checkCustomProvider;
  /** Ticket 06 review M1: Claude Code run as a custom provider keeps claude's controls (install paths, managed policy). */
  claudeControls?: { candidates: readonly string[]; managed: readonly string[] };
  checkTimeoutMs?: number;
  /** The CLI's allowlisted base environment for one run's private temporary folder (claude adds its own variables). */
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
  /** How long a plan or command card waits for the user (default 5 minutes). */
  approvalMs?: number;
}) {
  const spawn = options.spawn ?? spawnCli;
  const waitMs = options.waitMs ?? 60_000;
  const approvalMs = options.approvalMs ?? APPROVAL_WAIT_MS;
  const conversations = new Map<string, Conversation>();
  const owners = new Map<string, { owner: Owner; send(state: AgentState): void; sequence: number }>();
  const exits = new Set<Promise<void>>();
  /** Opens past the limit check but not yet registered: they hold their slot across the version check. */
  const opening = new Set<string>();
  let settings: StoredAgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  let disposed = false;
  const key = (ownerId: string, sessionId: string) => `${ownerId}\n${sessionId}`;

  const ready = options.store.read().then((stored) => { settings = parseAgentSettings(stored.status === "present" ? stored.value : undefined); }, () => undefined);
  /** One isolation check at a time per fingerprint and mode. */
  const checking = new Map<string, Promise<CustomCheckRecord>>();
  /** In-flight checks: lock and quit stop their CLI process groups. */
  const checks = new Set<AbortController>();
  const stopChecks = () => { for (const controller of checks) controller.abort(); };

  // ------------------------------------------------------------------ providers (ticket 06)

  const claudeLauncher = (path: string): Launcher => ({
    path, input: "stream-json", dialect: "claude",
    build: (run) => ({
      args: claudeArgs({ mcpConfig: run.config, tools: run.tools, model: run.model, effort: run.effort, systemPrompt: run.systemPrompt }),
      env: { ...options.env(run.tmp), ...CLAUDE_ENV },
    }),
  });
  const codexLauncher = (path: string): Launcher => ({
    path, input: "one-shot", dialect: "codex",
    build: (run) => ({
      args: codexArgs({ cwd: run.cwd, bridge: options.bridge, tools: run.tools, model: run.model, effort: run.effort, systemPrompt: run.systemPrompt }),
      env: { ...options.env(run.tmp), SSTERM_MCP_SOCKET: run.credential.socketPath, SSTERM_MCP_CREDENTIAL: run.credential.credential },
    }),
  });
  const customLauncher = (definition: AgentCustomProvider, path: string, claude: boolean): Launcher => ({
    path, input: definition.input, dialect: "claude",
    build: (run) => ({
      args: customArgs(definition, { mcpConfigPath: run.config, systemPromptFile: run.promptFile, tools: run.tools }),
      env: customEnv(definition, options.env(run.tmp), claude),
    }),
  });
  const resolveDefinition = (definition: AgentCustomProvider) =>
    (options.resolveCustom ?? resolveCustom)(definition, options.env(options.tmp), options.claudeControls ?? { candidates: [], managed: [] });
  /** Runs the custom provider's isolation check and keeps its record while the definition is still the one checked. */
  function runCheck(definition: AgentCustomProvider, found: Extract<CustomResolution, { status: "found" }>, live: boolean): Promise<CustomCheckRecord> {
    const slot = `${found.fingerprint}:${live}`;
    const pending = checking.get(slot);
    if (pending) return pending;
    const controller = new AbortController();
    checks.add(controller);
    const started = (async () => {
      // The user's additional instructions are never part of a check (nothing about them is verified by it).
      const result = await (options.check ?? checkCustomProvider)({
        definition, path: found.path, bridge: options.bridge, tmp: options.tmp, home: options.home, profile: options.profile, env: options.env, live,
        claude: found.claude, signal: controller.signal,
        roles: [
          { name: "main", tools: DELEGATE_TOOLS, systemPrompt: agentInstructions("main", CHECK_TARGET, "") },
          { name: "sub", tools: TOOLS, systemPrompt: agentInstructions("sub", CHECK_TARGET, "") },
        ],
        ...(options.checkTimeoutMs ? { timeoutMs: options.checkTimeoutMs } : {}),
      }).catch(() => ({ status: "unverifiable" as const, reasons: ["The check could not run."] }));
      const record: CustomCheckRecord = { fingerprint: found.fingerprint, status: result.status, reasons: sanitizeReasons(result.reasons), version: found.version };
      if (settings.custom === definition) {
        settings = { ...settings, customCheck: record };
        await options.store.write(serializeAgentSettings(settings)).catch(() => undefined);
        // A provider that no longer passes (also on a re-check of the same binary) ends its conversations at once.
        if (record.status !== "passed" && record.status !== "passed-live-unverified-requests") await closeWhere((conversation) => conversation.provider === "custom");
      }
      return record;
    })().finally(() => { checking.delete(slot); checks.delete(controller); });
    checking.set(slot, started);
    return started;
  }
  /**
   * A provider as it is now. claude and codex: the version gate. Custom: its definition, real binary and the isolation
   * check bound to its fingerprint; with `check`, a missing or stale check runs now (never live: that needs consent).
   */
  async function providerState(provider: AgentProvider, check = false, definition = settings.custom): Promise<ProviderState> {
    if (provider === "claude") {
      const found = await options.resolve();
      return { status: found.status, version: found.version, reasons: [], ...(found.status === "ready" ? { launcher: claudeLauncher(found.path) } : {}) };
    }
    if (provider === "codex") {
      const reasons = ["No codex version has passed ssterm's isolation check.", ...CODEX_FAILURES];
      // Review L5: while no version is verified, codex is not even asked for its version.
      if (!VERIFIED_CODEX_VERSIONS.length) return { status: "disabled", version: null, reasons };
      const found: ProviderResolution = await (options.resolveCodex?.() ?? Promise.resolve({ status: "missing" as const, version: null }));
      if (found.status === "ready") return { status: "ready", version: found.version, reasons: [], launcher: codexLauncher(found.path) };
      return { status: found.status, version: found.version, reasons };
    }
    if (!definition) return { status: "not-configured", version: null, reasons: [] };
    const found = await resolveDefinition(definition);
    if (found.status !== "found") return { status: found.status, version: null, reasons: [found.reason] };
    let record = settings.customCheck?.fingerprint === found.fingerprint ? settings.customCheck : undefined;
    if (!record && check) record = await runCheck(definition, found, false);
    if (!record) return { status: "check-required", version: found.version, reasons: [settings.customCheck
      ? "Its definition, binary or version output changed since its last isolation check." : "It has not passed an isolation check yet."] };
    if (record.status === "passed") return { status: "ready", version: found.version, reasons: [], launcher: customLauncher(definition, found.path, found.claude), record };
    if (record.status === "passed-live-unverified-requests")
      return { status: "ready-live-unverified", version: found.version, reasons: [...record.reasons], launcher: customLauncher(definition, found.path, found.claude), record };
    return { status: record.status === "failed" ? "check-failed" : "unverifiable", version: found.version, reasons: [...record.reasons], record };
  }

  const view = (conversation: Conversation): AgentConversation => ({
    sessionId: conversation.sessionId, generation: conversation.generation, target: { ...conversation.target }, provider: conversation.provider,
    model: conversation.model, effort: conversation.effort, mode: conversation.mode, fullAllowAvailable: fullAllowAvailable(conversation),
    status: conversation.status, messages: conversation.messages.map((message) => ({ ...message })),
    tasks: conversation.tasks.map((task) => ({
      ...task, steps: task.steps.map((step) => tail(step, VIEW_OUTPUT, VIEW_NOTE)),
      plan: task.plan && { ...task.plan, commands: task.plan.commands.map((entry) => ({ ...entry })) }, approval: task.approval && { ...task.approval },
    })),
  });
  const production = (conversation: Conversation) => conversation.target.environment === "PROD";
  const fullAllowAvailable = (conversation: Conversation) => !production(conversation) || settings.allowFullAllowOnProd;
  const stateFor = (ownerId: string): AgentState | undefined => {
    const listener = owners.get(ownerId);
    if (!listener) return undefined;
    return {
      owner: { ...listener.owner }, sequence: listener.sequence, enabled: settings.enabled, provider: settings.provider,
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

  /**
   * Starts one CLI with its own credential, folder, MCP config and system prompt file. The folder and residue go when it
   * exits. Each event is read in the launcher's dialect; an isolation violation revokes the credential first, then the
   * whole process group is killed at once (no grace), before `onEvent` sees it.
   */
  async function launch(conversation: Conversation, role: "main" | "sub", credential: { credential: string; socketPath: string },
    launcher: Launcher, onEvent: (reading: Reading, run: Run) => void, onExit: (run: Run) => void): Promise<Run | undefined> {
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
      const systemPrompt = agentInstructions(role, conversation.target, settings.instructions);
      const promptFile = join(root, "system-prompt.txt");
      await writeFile(promptFile, systemPrompt, { mode: 0o600, flag: "wx" });
      if (conversation.closed || disposed) throw new Error("closed");
      const { args, env } = launcher.build({ config, promptFile, cwd: join(root, "cwd"), tmp: join(root, "tmp"), tools: allowed, systemPrompt,
        model: conversation.model, effort: conversation.effort, credential });
      let run: Run | undefined;
      const process = spawn({
        path: launcher.path, cwd: join(root, "cwd"), env, args,
        onEvent: (event) => {
          if (!run) return;
          const reading = read(run.dialect, event, run.allowed);
          if (reading.violation) { options.terminals.revoke(run.credential); run.process.kill(); }
          onEvent(reading, run);
        },
        ...(options.graceMs ? { graceMs: options.graceMs } : {}),
      });
      run = { process, credential: credential.credential, root, allowed, input: launcher.input, dialect: launcher.dialect, answered: false };
      const finishedRun = run;
      const launched = Date.now();
      const exit = process.exited.then(async () => {
        options.terminals.revoke(finishedRun.credential);
        await removeRunResidue({ home: options.home, root, pid: process.pid }).catch(() => undefined);
        // Review M1: a transcript or history entry naming this run is removed and reported.
        const saved = await cleanStateResidue({ home: options.home, tags: [root.slice(root.lastIndexOf("/") + 1)], since: launched }).catch(() => [] as string[]);
        if (saved.length && !conversation.closed) {
          say(conversation, "notice", `The agent CLI saved conversation state (${saved.slice(0, 2).map((path) => path.replace(options.home, "~")).join(", ")}); ssterm removed it.`);
          publish(conversation.ownerId);
        }
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

  // ------------------------------------------------------------------ the main agent

  async function startMain(conversation: Conversation): Promise<boolean> {
    const provider = await providerState(conversation.provider);
    if (conversation.closed) return false;
    if (!provider.launcher) {
      say(conversation, "notice", `${PROVIDER_NAMES[conversation.provider]} is no longer available in a verified version, so nothing was sent. Check Settings › AI Agent.`);
      return false;
    }
    const role: AgentToolRole = { tools: DELEGATE_TOOLS, call: (name, args) => delegate(conversation, name, args) };
    const issued = await options.terminals.issue(conversation.ownerId, conversation.sessionId, { role });
    if (!issued || conversation.closed) {
      if (issued) options.terminals.revoke(issued.credential);
      else say(conversation, "notice", "The session is no longer Ready, so nothing was sent.");
      return false;
    }
    const run = await launch(conversation, "main", issued, provider.launcher, (reading, current) => {
      if (conversation.closed) return;
      if (reading.violation) {
        say(conversation, "notice", `The CLI reported ${reading.violation}, outside ssterm's isolation rules, so ssterm stopped it.`);
        void close(conversation);
        return;
      }
      if (conversation.main !== current || (!reading.texts.length && !reading.result)) return;
      for (const value of reading.texts) say(conversation, "assistant", value);
      if (reading.result) {
        current.answered = true;
        // A one-shot turn ends when its process exits.
        if (current.input === "stream-json") conversation.status = "idle";
        if (reading.result.error) say(conversation, "notice", "The agent ended this turn with an error.");
      }
      publish(conversation.ownerId);
    }, (current) => {
      if (conversation.main !== current) return;
      conversation.main = undefined;
      if (conversation.closed) return;
      conversation.status = "idle";
      if (current.input === "one-shot") {
        // Tasks outlive a one-shot turn: the next turn's process asks about them.
        if (!current.answered) say(conversation, "notice", "The agent CLI ended this turn without finishing it.");
        publish(conversation.ownerId);
        return;
      }
      say(conversation, "notice", "The agent CLI stopped. Close the panel and open it again to start a new conversation.");
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
        const created: AgentTask = { id: `task-${++conversation.nextTask}`, goal: args.goal.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ").trim(), status: "queued", subAgentReport: null, limitReached: false, steps: [], plan: null, approval: null };
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

  // ------------------------------------------------------------------ approvals (ticket 04)

  /** One pending card; settled by the user, the bounded wait, a mode change, the task's end or the conversation's. */
  function ask(conversation: Conversation, task: AgentTask, id: string, signal: AbortSignal): Promise<Outcome> {
    return new Promise((resolve) => {
      const aborted = () => finish("cancelled");
      const finish = (outcome: Outcome) => {
        if (!conversation.decisions.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish("expired"), conversation.approvalMs);
      conversation.decisions.set(id, { taskId: task.id, finish });
      // The MCP request that raised the card was cancelled or its connection closed.
      if (signal.aborted) finish("cancelled");
      else signal.addEventListener("abort", aborted, { once: true });
    });
  }
  /** A card that expired because the CLI stops waiting sooner than 5 minutes says so (the agent stopped waiting). */
  const explain = (conversation: Conversation, outcome: Exclude<Outcome, "approved">) => outcome === "expired" && conversation.approvalMs < approvalMs
    ? `The agent's CLI stops waiting for a tool call after ${Math.round((conversation.approvalMs + 5_000) / 1_000)} seconds, so the card expired just before that (the agent stopped waiting).`
    : outcomeText[outcome];
  /** L4: ids carry a per-conversation nonce, so a stale renderer decision can never land on another conversation's card. */
  const approvalId = (conversation: Conversation, kind: "plan" | "command") => `${kind}-${conversation.nonce}-${++conversation.nextApproval}`;
  const withdraw = (conversation: Conversation, taskId?: string) => {
    for (const decision of [...conversation.decisions.values()]) if (taskId === undefined || decision.taskId === taskId) decision.finish("cancelled");
  };

  /** A1/A2 for one task's sub agent: enforced here, whatever its instructions say. */
  function gate(conversation: Conversation, task: AgentTask, gone: () => boolean): AgentGate {
    let proposals = 0;
    const ended = "This task has ended; nothing was sent to the terminal.";
    return {
      async authorize(command, verdict, signal) {
        if (gone()) return { refuse: ended };
        if (verdict.readOnly) return { run: command, via: "read-only" };
        if (conversation.mode === "read-only") return { refuse: readOnlyRefusal(verdict.reason) };
        const problem = unshowable(command);
        if (problem) return { refuse: `Refused: ${problem}. Nothing was sent to the terminal. Send one plain line.` };
        if (conversation.mode === "full-allow") return { run: normalizeCommand(command), via: "full-allow" };
        const plan = task.plan?.status === "approved" ? task.plan : undefined;
        const entry = plan && takePlanCommand(plan.commands, command);
        if (entry) {
          publish(conversation.ownerId);
          return { run: entry.command, via: "plan", undo: () => { entry.ran = false; publish(conversation.ownerId); } };
        }
        if (task.approval) return { refuse: "Another command is already waiting for the user's approval; nothing was sent. Wait for that decision first." };
        if (signal.aborted) return { refuse: outcomeText.cancelled };
        const id = approvalId(conversation, "command");
        const approval = { id, command: normalizeCommand(command) };
        task.approval = approval;
        publish(conversation.ownerId);
        const outcome = await ask(conversation, task, id, signal);
        if (task.approval === approval) task.approval = null;
        if (!conversation.closed) publish(conversation.ownerId);
        if (outcome === "approved" && !gone()) return { run: approval.command, via: "approval" };
        return { refuse: `Not run: this command is outside the approved plan and needed the user's approval. ${outcome === "approved" ? ended : explain(conversation, outcome)} Nothing was sent to the terminal. Do not work around it; continue without it or finish with your report.` };
      },
      async propose(args, signal) {
        if (gone()) return text(ended, true);
        const parsed = parsePlan(args);
        if (typeof parsed === "string") return text(parsed, true);
        if (conversation.mode === "read-only") return text("This session is in Read only mode: plans are not used and only read-only commands run. Ask the user to change the mode.", true);
        if (conversation.mode === "full-allow") return text({ planId: null, status: "not-needed", note: "Full allow mode: every command runs without approval." });
        if (task.plan?.status === "pending") return text("A plan is already waiting for the user's decision.", true);
        if (proposals >= MAX_PLANS_PER_TASK) return text(`This task already proposed ${MAX_PLANS_PER_TASK} plans; no more can be proposed.`, true);
        if (signal.aborted) return text(outcomeText.cancelled, true);
        proposals += 1;
        // The latest plan is the only one that applies.
        const plan: AgentPlan = { id: approvalId(conversation, "plan"), goal: parsed.goal, status: "pending", commands: parsed.commands.map((command) => ({ command, ran: false })) };
        task.plan = plan;
        publish(conversation.ownerId);
        const outcome = await ask(conversation, task, plan.id, signal);
        plan.status = outcome;
        if (!conversation.closed) publish(conversation.ownerId);
        return text(outcome === "approved"
          ? { planId: plan.id, status: plan.status, note: "Approved. Each listed command runs once when run_command is called with exactly that text; anything else asks the user." }
          : { planId: plan.id, status: plan.status, note: `${explain(conversation, outcome)} Commands that are not read-only will each ask the user. Do not work around the decision; stop and report.` });
      },
    };
  }

  // ------------------------------------------------------------------ sub agents, one per session at a time (A12)

  function pump(conversation: Conversation) {
    if (conversation.closed || conversation.sub) return;
    const next = conversation.tasks.find((candidate) => candidate.status === "queued");
    if (!next) return;
    next.status = "running";
    const sub: NonNullable<Conversation["sub"]> = { task: next };
    /** Step slots taken by admitted calls whose record has not arrived yet. */
    let reserved = 0;
    conversation.sub = sub;
    const settle = (status: AgentTask["status"]) => {
      if (conversation.sub !== sub) return;
      conversation.sub = undefined;
      if (!finished(next)) next.status = status;
      withdraw(conversation, next.id);
      wake(conversation);
      if (conversation.closed) return;
      pump(conversation);
      publish(conversation.ownerId);
    };
    // Cancelled or closed while starting.
    const gone = () => conversation.sub !== sub || conversation.closed || finished(next);
    void (async () => {
      const provider = await providerState(conversation.provider);
      if (gone()) return settle("cancelled");
      if (!provider.launcher) { next.subAgentReport = `${PROVIDER_NAMES[conversation.provider]} is not available in a verified version.`; return settle("failed"); }
      const issued = await options.terminals.issue(conversation.ownerId, conversation.sessionId, {
        // Every admitted call records exactly once into its slot, also after the task ended (an interrupted command).
        record: (step) => {
          reserved = Math.max(0, reserved - 1);
          if (next.steps.length < MAX_AGENT_STEPS) next.steps.push({ ...step } satisfies AgentStep);
          else next.limitReached = true;
          if (!conversation.closed) publish(conversation.ownerId);
        },
        // Checked before a command is authorized (taking a slot) and again before it is typed: past the limit or the
        // task's end nothing is typed, and the record says so.
        admit: (reserve) => {
          if (conversation.sub !== sub || finished(next)) return "This task has ended; nothing was sent to the terminal.";
          if (!reserve) return undefined;
          if (next.steps.length + reserved < MAX_AGENT_STEPS) { reserved += 1; return undefined; }
          if (!next.limitReached) { next.limitReached = true; publish(conversation.ownerId); }
          return `This task reached its limit of ${MAX_AGENT_STEPS} commands; nothing more was sent to the terminal. Finish with your report.`;
        },
        gate: gate(conversation, next, gone),
      });
      if (!issued) { next.subAgentReport = "The session is no longer Ready."; return settle("failed"); }
      if (gone()) { options.terminals.revoke(issued.credential); return settle("cancelled"); }
      /** codex reports its final message as an item, not in the result. */
      let lastText: string | undefined;
      const run = await launch(conversation, "sub", issued, provider.launcher, (reading, current) => {
        if (reading.violation) {
          next.subAgentReport = `ssterm stopped the sub agent: the CLI reported ${reading.violation}, outside ssterm's isolation rules.`;
          next.status = "failed";
          publish(conversation.ownerId);
          return;
        }
        lastText = reading.texts.at(-1) ?? lastText;
        if (!reading.result || finished(next)) return;
        const report = reading.result.text ?? lastText;
        if (report !== undefined) next.subAgentReport = clip(report);
        next.status = reading.result.error ? "failed" : "completed";
        current.process.endInput();
        publish(conversation.ownerId);
      }, () => settle("failed"));
      if (!run) { next.subAgentReport = "The sub agent could not be started."; return settle("failed"); }
      // The credential goes before the process: no call can start in between.
      if (gone()) { options.terminals.revoke(run.credential); void run.process.stop(); return; }
      sub.run = run;
      const task = `Task ${next.id}: ${next.goal}`;
      run.process.write(run.input === "stream-json" ? { type: "user", message: { role: "user", content: task } } : task);
      run.process.endInput();
    })();
  }

  function cancel(conversation: Conversation, task: AgentTask): boolean {
    if (finished(task)) return false;
    task.status = "cancelled";
    withdraw(conversation, task.id);
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
    withdraw(conversation);
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
    /** Settings › AI Agent: every provider as it is now (no isolation check runs here). */
    async settingsView(): Promise<AgentSettingsView> {
      await ready;
      const providers = await Promise.all((["claude", "codex", "custom"] as const).map(async (id): Promise<AgentProviderView> => {
        const { status, version, reasons } = await providerState(id).catch(() => ({ status: "missing" as const, version: null, reasons: [] }));
        return { id, status, version, reasons };
      }));
      return {
        settings: { enabled: settings.enabled, provider: settings.provider, model: settings.model, effort: settings.effort, instructions: settings.instructions,
          allowFullAllowOnProd: settings.allowFullAllowOnProd, custom: settings.custom },
        providers,
        verified: [...VERIFIED_CLAUDE_VERSIONS],
      };
    },
    async configure(next: AgentSettings, consent: boolean): Promise<ConfigureAgentResponse> {
      await ready;
      const customChanged = JSON.stringify(next.custom) !== JSON.stringify(settings.custom);
      // A changed custom definition in use is a different CLI: its disclosure is acknowledged again.
      const turningOn = next.enabled && !(settings.enabled && settings.provider === next.provider && settings.disclosure === AGENT_DISCLOSURE_VERSION &&
        !(next.provider === "custom" && customChanged));
      if (turningOn && !consent) return { status: "consent-required" };
      // The claude model stays the claude choice; a custom provider names its own model in its definition.
      if (!isVerifiedAgentModel(next.provider === "codex" ? "codex" : "claude", next.model)) return { status: "model-unverified" };
      // Ticket 06: a custom provider is checked before its first use (and after any change), never with a live call here.
      const provider = next.enabled ? await providerState(next.provider, true, next.custom) : undefined;
      if (provider && !provider.launcher) return { status: "provider-unavailable", view: await this.settingsView() };
      // Turning the agent off withdraws the consent; turning it on again shows the disclosure again.
      const stored: StoredAgentSettings = { ...next, disclosure: next.enabled ? AGENT_DISCLOSURE_VERSION : 0,
        customCheck: provider?.record ?? settings.customCheck };
      if (await options.store.write(serializeAgentSettings(stored)) !== "confirmed") return { status: "failed" };
      settings = stored;
      if (!stored.enabled) await closeWhere(() => true);
      // A changed definition is not the one those conversations were checked with.
      else if (customChanged) await closeWhere((conversation) => conversation.provider === "custom");
      // Turning the PROD option off ends Full allow on PROD conversations at once.
      for (const conversation of conversations.values()) if (conversation.mode === "full-allow" && !fullAllowAvailable(conversation)) {
        conversation.mode = "auto";
        say(conversation, "notice", "Full allow on PROD was turned off in Settings, so this conversation is back in Auto.");
      }
      publishAll();
      return { status: "saved", view: await this.settingsView() };
    },
    /**
     * Ticket 06: runs the custom provider's isolation check now and keeps the result. `live` is the user's consent, for
     * this run only, to send synthetic test prompts to the CLI's own provider.
     */
    async checkProvider(live: boolean): Promise<AgentSettingsView> {
      await ready;
      const definition = settings.custom;
      if (definition) {
        const found = await resolveDefinition(definition);
        // A CLI with a test endpoint is always checked locally.
        if (found.status === "found") await runCheck(definition, found, live && !definition.endpointEnv);
      }
      return this.settingsView();
    },
    register(owner: Owner, send: (state: AgentState) => void) {
      const ownerId = sessionOwnerId(owner);
      owners.set(ownerId, { owner: { ...owner }, send, sequence: owners.get(ownerId)?.sequence ?? 0 });
    },
    async state(owner: Owner): Promise<AgentState> {
      await ready;
      const ownerId = sessionOwnerId(owner);
      return stateFor(ownerId) ?? { owner: { ...owner }, sequence: 0, enabled: settings.enabled, provider: settings.provider,
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
        const provider = settings.provider;
        const definition = settings.custom;
        // Before the first use (or after a change) a custom provider's isolation check runs here.
        if (!(await providerState(provider, true, definition)).launcher) return { status: "refused", reason: "provider" };
        // The session may have ended or the agent been turned off during the version check.
        if (disposed || !settings.enabled || !bindable(ownerId, sessionId, generation) || conversations.has(slot)) return { status: "refused", reason: "session" };
        if (settings.provider !== provider || settings.custom !== definition) return { status: "refused", reason: "provider" };
        const { label, address, port, username, environment } = snapshot.target;
        conversations.set(slot, {
          ownerId, sessionId, generation, status: "idle", messages: [], tasks: [], nextMessage: 1, nextTask: 0, waiters: new Set(), closed: false,
          target: { label, environment, endpoint: `${username ? `${username}@` : ""}${address}:${port}` },
          approvalMs: provider === "custom" && definition ? Math.min(approvalMs, (definition.toolTimeoutSec - 5) * 1_000) : approvalMs,
          provider, model: provider === "custom" && definition ? definition.model : settings.model,
          effort: provider === "custom" && definition ? definition.effort : settings.effort,
          mode: "auto", decisions: new Map(), nextApproval: 0, nonce: randomBytes(4).toString("hex"),
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
      const main = conversation.main;
      const written = main?.input === "one-shot"
        ? main.process.write(oneShotPrompt(conversation.messages.slice(0, -1), message)) && (main.process.endInput(), true)
        : main?.process.write({ type: "user", message: { role: "user", content: message } });
      if (!written) {
        conversation.status = "idle";
        publish(conversation.ownerId);
      }
      return { status: "sent" };
    },
    /** Ticket 04: Full allow needs the warning acknowledged, and on PROD the Settings option; a change withdraws pending cards. */
    setMode(owner: Owner, sessionId: string, generation: number, mode: AgentMode, acknowledged: boolean): SetAgentModeResponse {
      const conversation = conversations.get(key(sessionOwnerId(owner), sessionId));
      if (!conversation || conversation.closed || conversation.generation !== generation) return { status: "refused", reason: "ended" };
      if (mode === "full-allow" && !fullAllowAvailable(conversation)) return { status: "refused", reason: "production" };
      if (mode === "full-allow" && !acknowledged) return { status: "refused", reason: "acknowledge" };
      if (conversation.mode !== mode) {
        conversation.mode = mode;
        withdraw(conversation);
        publish(conversation.ownerId);
      }
      return { status: "set" };
    },
    /** Ticket 04: one pending card of this exact conversation generation; approving on PROD needs the confirmation step. */
    decide(owner: Owner, sessionId: string, generation: number, approvalId: string, decision: "approve" | "reject", confirmedProduction: boolean): DecideAgentResponse {
      const conversation = conversations.get(key(sessionOwnerId(owner), sessionId));
      const pending = conversation && !conversation.closed && conversation.generation === generation ? conversation.decisions.get(approvalId) : undefined;
      if (!conversation || !pending) return { status: "refused", reason: "stale" };
      if (decision === "approve" && production(conversation) && !confirmedProduction) return { status: "refused", reason: "production" };
      pending.finish(decision === "approve" ? "approved" : "rejected");
      return { status: "applied" };
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
    lock(): Promise<void> { stopChecks(); return closeWhere(() => true); },
    /** Quit: every CLI group gets SIGTERM, then SIGKILL; resolves when they and their cleanup are done. */
    async dispose(): Promise<void> {
      disposed = true;
      stopChecks();
      await Promise.all([...checking.values()].map((check) => check.catch(() => undefined)));
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
  channels.agentSettings, channels.configureAgent, channels.checkAgentProvider, channels.agentState, channels.openAgent, channels.closeAgent,
  channels.sendAgent, channels.cancelAgentTask, channels.setAgentMode, channels.decideAgent,
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
  handle(channels.checkAgentProvider, isCheckAgentProviderRequest, async (runner, request) => ok(await runner.checkProvider(request.live)));
  handle(channels.agentState, isAgentStateRequest, async (runner, _request, owner) => ok(await runner.state(owner)));
  handle(channels.openAgent, isOpenAgentRequest, async (runner, request, owner) => ok(await runner.open(owner, request.sessionId, request.generation)));
  handle(channels.closeAgent, isAgentConversationRequest, async (runner, request, owner) => {
    await runner.close(owner, request.sessionId);
    return ok({ accepted: true as const });
  });
  handle(channels.sendAgent, isSendAgentRequest, async (runner, request, owner) => ok(await runner.send(owner, request.sessionId, request.text)));
  handle(channels.cancelAgentTask, isCancelAgentTaskRequest, async (runner, request, owner) =>
    ok({ cancelled: runner.cancelTask(owner, request.sessionId, request.taskId) }));
  handle(channels.setAgentMode, isSetAgentModeRequest, async (runner, request, owner) =>
    ok(runner.setMode(owner, request.sessionId, request.generation, request.mode, request.acknowledged)));
  handle(channels.decideAgent, isDecideAgentRequest, async (runner, request, owner) =>
    ok(runner.decide(owner, request.sessionId, request.generation, request.approvalId, request.decision, request.production)));
  return () => { for (const channel of agentChannels) options.ipc.removeHandler(channel); };
}
