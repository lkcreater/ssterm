import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";

/**
 * SST-041 ticket 03: the AI Agent panel (ADR 0009). The renderer never talks to a CLI or the MCP socket; it opens,
 * closes and sends to a conversation that main owns, and receives the whole conversation view pushed per owner.
 */

/** Raised whenever the disclosure text changes; a stored consent for an older text does not enable the agent. */
export const AGENT_DISCLOSURE_VERSION = 1;
export const MAX_AGENT_INSTRUCTIONS = 4_000;
export const MAX_AGENT_MESSAGE = 8_000;
/** Kept in memory per conversation; older entries are dropped. */
export const MAX_AGENT_MESSAGES = 200;
export const MAX_AGENT_TASKS = 16;
export const MAX_AGENT_STEPS = 64;
const MAX_TEXT = 65_536 + 128;

export type AgentProviderId = "claude" | "codex";
/** Verified providers only (ticket 01): codex stays disabled. */
export type AgentProvider = "claude";
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export interface AgentModelEntry { id: string; alias: string | null; label: string; verified: boolean }
/**
 * A14: no CLI lists its models, so each provider's list is bundled and versioned with the CLI version it was checked
 * against. Only a model that passed the ticket 01 isolation check with that CLI version (`verified`) can run; a custom
 * model ID (a strict token, one argv element) is never verified. The user's default (`defaultModel`) applies once it is
 * verified; until then the first verified model is the effective default.
 */
export const AGENT_MODELS: Readonly<Record<AgentProviderId, { cliVersion: string; defaultModel: string; defaultEffort: AgentEffort; models: readonly AgentModelEntry[] }>> = Object.freeze({
  claude: {
    cliVersion: "2.1.309",
    defaultModel: "claude-opus-5-5",
    defaultEffort: "xhigh",
    models: [
      // 2026-10-23 live set at effort xhigh: inconclusive (the provider's safeguards declined two synthetic attack prompts).
      { id: "claude-opus-5-5", alias: "opus", label: "Claude Opus 5.5", verified: false },
      { id: "claude-fable-5-1", alias: "fable", label: "Claude Fable 5.1", verified: false },
      { id: "claude-sonnet-5-5", alias: "sonnet", label: "Claude Sonnet 5.5", verified: false },
      // Verified through the `haiku` alias (ticket 01 live set, effort low).
      { id: "claude-haiku-5-5", alias: "haiku", label: "Claude Haiku 5.5", verified: true },
    ],
  },
  // Listed for completeness; the provider stays disabled (ticket 01).
  codex: {
    cliVersion: "0.163.0",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    models: [{ id: "gpt-5.6-luna", alias: null, label: "GPT-5.6 Luna", verified: false }],
  },
});
export const isVerifiedAgentModel = (provider: AgentProviderId, model: string): boolean =>
  AGENT_MODELS[provider].models.some((entry) => entry.verified && (entry.id === model || entry.alias === model));
/** The user's default model when it is verified, otherwise the first verified one. */
export function effectiveDefaultModel(provider: AgentProviderId): string {
  const list = AGENT_MODELS[provider];
  return isVerifiedAgentModel(provider, list.defaultModel) ? list.defaultModel : list.models.find((entry) => entry.verified)?.id ?? list.defaultModel;
}
/** A custom model ID: one token that can never be read as a flag. */
export const AGENT_MODEL_TOKEN = /^(?!-)[A-Za-z0-9._:-]{1,64}$/u;
export const isAgentModelId = (value: unknown): value is string => typeof value === "string" && AGENT_MODEL_TOKEN.test(value);
/** `allowFullAllowOnProd` (ticket 04, off by default): Full allow can be chosen for a PROD session, still behind its warning step. */
export interface AgentSettings { enabled: boolean; provider: AgentProvider; model: string; effort: AgentEffort; instructions: string; allowFullAllowOnProd: boolean }
export type AgentProviderStatus = "ready" | "missing" | "unsupported-version" | "not-native" | "managed-policy" | "disabled";
export interface AgentProviderView { id: AgentProviderId; status: AgentProviderStatus; version: string | null }
export interface AgentSettingsView { settings: AgentSettings; providers: AgentProviderView[]; verified: string[] }

export interface AgentSettingsRequest { owner: Owner }
/** `consent` is the explicit acknowledgement of the disclosure, required to turn the agent on. */
export interface ConfigureAgentRequest { owner: Owner; settings: AgentSettings; consent: boolean }
export type ConfigureAgentResponse =
  | { status: "saved"; view: AgentSettingsView }
  | { status: "consent-required" }
  /** The model has not passed the isolation check with this CLI version (custom IDs never have). */
  | { status: "model-unverified" }
  | { status: "provider-unavailable"; view: AgentSettingsView }
  | { status: "failed" };

export type AgentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AgentStepStatus = "completed" | "interrupted" | "timeout" | "alternate-screen" | "ended" | "not-at-prompt" | "not-started" | "password-handoff" | "password-prompt-refused" | "refused";
/** ssterm's own record of one command the sub agent asked for (run or refused); `get_task_status` returns the same. */
export interface AgentStep { command: string; status: AgentStepStatus; exitCode: number | null; output: string; truncated: boolean; via: AgentStepVia | null }
/**
 * Ticket 04 (A1, A2): Read only runs only read-only commands; Auto (every new conversation) also runs commands of an
 * approved plan and asks for anything else; Full allow (a per-conversation opt-in) runs everything.
 */
export const AGENT_MODES = ["read-only", "auto", "full-allow"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];
/** Why ssterm let a command run; null when it was refused. */
export type AgentStepVia = "read-only" | "plan" | "approval" | "full-allow";
export type AgentPlanStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";
/** The task's latest proposed plan: exact commands, each run at most once per listing (`ran`). */
export interface AgentPlan { id: string; goal: string; status: AgentPlanStatus; commands: { command: string; ran: boolean }[] }
/** A command outside the plan waiting for the user's Run or Reject. */
export interface AgentApproval { id: string; command: string }
/**
 * `subAgentReport` is the sub agent's own, unverified text; the steps are ssterm's record. `limitReached`: the task hit
 * the per-task command limit and later commands were refused unrun.
 */
export interface AgentTask {
  id: string; goal: string; status: AgentTaskStatus; subAgentReport: string | null; limitReached: boolean; steps: AgentStep[];
  plan: AgentPlan | null; approval: AgentApproval | null;
}
export interface AgentMessage { id: number; role: "user" | "assistant" | "notice"; text: string }
export type AgentConversationStatus = "idle" | "starting" | "thinking";
export interface AgentConversation {
  sessionId: string;
  generation: number;
  target: { label: string; endpoint: string; environment: "DEV" | "STAGING" | "PROD" | null };
  provider: AgentProvider;
  /** Fixed when the conversation opens; its sub agents use the same. */
  model: string;
  effort: AgentEffort;
  mode: AgentMode;
  /** False on PROD while Settings › AI Agent › "Allow Full allow on PROD" is off. */
  fullAllowAvailable: boolean;
  status: AgentConversationStatus;
  messages: AgentMessage[];
  tasks: AgentTask[];
}
export interface AgentState { owner: Owner; sequence: number; enabled: boolean; provider: AgentProvider; conversations: AgentConversation[] }
export interface AgentStateRequest { owner: Owner }
export interface OpenAgentRequest { owner: Owner; sessionId: string; generation: number }
export type OpenAgentResponse = { status: "opened" } | { status: "refused"; reason: "disabled" | "session" | "provider" | "limit" };
export interface AgentConversationRequest { owner: Owner; sessionId: string }
export interface SendAgentRequest { owner: Owner; sessionId: string; text: string }
export type SendAgentResponse = { status: "sent" } | { status: "refused"; reason: "busy" | "ended" };
export interface CancelAgentTaskRequest { owner: Owner; sessionId: string; taskId: string }
export interface CancelAgentTaskResponse { cancelled: boolean }
/** `acknowledged`: the panel's Full allow warning step was confirmed (required for Full allow). */
export interface SetAgentModeRequest { owner: Owner; sessionId: string; generation: number; mode: AgentMode; acknowledged: boolean }
export type SetAgentModeResponse = { status: "set" } | { status: "refused"; reason: "ended" | "acknowledge" | "production" };
/** `production`: the PROD confirmation step was passed (required to approve on a PROD target). */
export interface DecideAgentRequest { owner: Owner; sessionId: string; generation: number; approvalId: string; decision: "approve" | "reject"; production: boolean }
export type DecideAgentResponse = { status: "applied" } | { status: "refused"; reason: "stale" | "production" };

const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:_-]{1,160}$/u.test(v);
const TASK_ID = /^task-[1-9][0-9]{0,5}$/u;
const bounded = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
/** One visible line or paragraph: no C0 controls besides tab and newline. */
const prose = (v: unknown, max: number): v is string => bounded(v, max) && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(v);
const ENVIRONMENTS: readonly unknown[] = ["DEV", "STAGING", "PROD", null];
const STEP_STATUS: readonly unknown[] = ["completed", "interrupted", "timeout", "alternate-screen", "ended", "not-at-prompt", "not-started", "password-handoff", "password-prompt-refused", "refused"];
const TASK_STATUS: readonly unknown[] = ["queued", "running", "completed", "failed", "cancelled"];
const VIA: readonly unknown[] = ["read-only", "plan", "approval", "full-allow", null];
const PLAN_STATUS: readonly unknown[] = ["pending", "approved", "rejected", "expired", "cancelled"];
/** `<kind>-<conversation nonce>-<counter>`. */
const APPROVAL_ID = /^(?:plan|command)-[0-9a-f]{8}-[1-9][0-9]{0,5}$/u;
const isMode = (v: unknown): v is AgentMode => (AGENT_MODES as readonly unknown[]).includes(v);

const isEffort = (v: unknown): v is AgentEffort => (AGENT_EFFORTS as readonly unknown[]).includes(v);
export function isAgentSettings(v: unknown): v is AgentSettings {
  return exactObject(v, ["enabled", "provider", "model", "effort", "instructions", "allowFullAllowOnProd"]) && typeof v.enabled === "boolean" && v.provider === "claude" &&
    isAgentModelId(v.model) && isEffort(v.effort) && prose(v.instructions, MAX_AGENT_INSTRUCTIONS) && typeof v.allowFullAllowOnProd === "boolean";
}
function isProviderView(v: unknown): v is AgentProviderView {
  return exactObject(v, ["id", "status", "version"]) && (v.id === "claude" || v.id === "codex") &&
    ["ready", "missing", "unsupported-version", "not-native", "managed-policy", "disabled"].includes(v.status as string) &&
    (v.version === null || (typeof v.version === "string" && /^[0-9][0-9A-Za-z.+-]{0,40}$/u.test(v.version)));
}
export function isAgentSettingsView(v: unknown): v is AgentSettingsView {
  return exactObject(v, ["settings", "providers", "verified"]) && isAgentSettings(v.settings) && Array.isArray(v.providers) &&
    v.providers.length <= 4 && v.providers.every(isProviderView) && Array.isArray(v.verified) && v.verified.length <= 16 &&
    v.verified.every((version) => typeof version === "string" && /^[0-9][0-9A-Za-z.+-]{0,40}$/u.test(version));
}
export function isAgentSettingsRequest(v: unknown): v is AgentSettingsRequest { return exactObject(v, ["owner"]) && isOwner(v.owner); }
export function isConfigureAgentRequest(v: unknown): v is ConfigureAgentRequest {
  return exactObject(v, ["owner", "settings", "consent"]) && isOwner(v.owner) && isAgentSettings(v.settings) && typeof v.consent === "boolean";
}
export function isConfigureAgentResponse(v: unknown): v is ConfigureAgentResponse {
  if (exactObject(v, ["status", "view"])) return (v.status === "saved" || v.status === "provider-unavailable") && isAgentSettingsView(v.view);
  return exactObject(v, ["status"]) && (v.status === "consent-required" || v.status === "model-unverified" || v.status === "failed");
}
function isStep(v: unknown): v is AgentStep {
  return exactObject(v, ["command", "status", "exitCode", "output", "truncated", "via"]) && prose(v.command, 4_096) &&
    STEP_STATUS.includes(v.status) && (v.exitCode === null || (isCounter(v.exitCode) && v.exitCode <= 0xffff_ffff)) &&
    bounded(v.output, MAX_TEXT) && typeof v.truncated === "boolean" && VIA.includes(v.via);
}
function isPlan(v: unknown): v is AgentPlan {
  return exactObject(v, ["id", "goal", "status", "commands"]) && typeof v.id === "string" && APPROVAL_ID.test(v.id) && v.id.startsWith("plan-") &&
    prose(v.goal, 1_000) && PLAN_STATUS.includes(v.status) && Array.isArray(v.commands) && v.commands.length >= 1 && v.commands.length <= 32 &&
    v.commands.every((entry) => exactObject(entry, ["command", "ran"]) && prose(entry.command, 4_096) && typeof entry.ran === "boolean");
}
function isTask(v: unknown): v is AgentTask {
  return exactObject(v, ["id", "goal", "status", "subAgentReport", "limitReached", "steps", "plan", "approval"]) && typeof v.id === "string" && TASK_ID.test(v.id) &&
    prose(v.goal, 4_000) && TASK_STATUS.includes(v.status) && (v.subAgentReport === null || bounded(v.subAgentReport, 16_384)) &&
    typeof v.limitReached === "boolean" && (v.plan === null || isPlan(v.plan)) &&
    (v.approval === null || (exactObject(v.approval, ["id", "command"]) && typeof v.approval.id === "string" && APPROVAL_ID.test(v.approval.id) &&
      v.approval.id.startsWith("command-") && prose(v.approval.command, 4_096))) &&
    Array.isArray(v.steps) && v.steps.length <= MAX_AGENT_STEPS && v.steps.every(isStep);
}
function isMessage(v: unknown): v is AgentMessage {
  return exactObject(v, ["id", "role", "text"]) && isCounter(v.id) && ["user", "assistant", "notice"].includes(v.role as string) &&
    bounded(v.text, 16_384);
}
export function isAgentConversation(v: unknown): v is AgentConversation {
  return exactObject(v, ["sessionId", "generation", "target", "provider", "model", "effort", "mode", "fullAllowAvailable", "status", "messages", "tasks"]) && identifier(v.sessionId) &&
    isAgentModelId(v.model) && isEffort(v.effort) && isMode(v.mode) && typeof v.fullAllowAvailable === "boolean" &&
    isCounter(v.generation) && v.generation > 0 && exactObject(v.target, ["label", "endpoint", "environment"]) &&
    prose(v.target.label, 400) && prose(v.target.endpoint, 1_300) && ENVIRONMENTS.includes(v.target.environment) &&
    v.provider === "claude" && ["idle", "starting", "thinking"].includes(v.status as string) &&
    Array.isArray(v.messages) && v.messages.length <= MAX_AGENT_MESSAGES && v.messages.every(isMessage) &&
    Array.isArray(v.tasks) && v.tasks.length <= MAX_AGENT_TASKS && v.tasks.every(isTask);
}
export function isAgentState(v: unknown): v is AgentState {
  return exactObject(v, ["owner", "sequence", "enabled", "provider", "conversations"]) && isOwner(v.owner) && isCounter(v.sequence) &&
    typeof v.enabled === "boolean" && v.provider === "claude" && Array.isArray(v.conversations) && v.conversations.length <= 8 &&
    v.conversations.every(isAgentConversation);
}
export function isAgentStateRequest(v: unknown): v is AgentStateRequest { return exactObject(v, ["owner"]) && isOwner(v.owner); }
export function isOpenAgentRequest(v: unknown): v is OpenAgentRequest {
  return exactObject(v, ["owner", "sessionId", "generation"]) && isOwner(v.owner) && identifier(v.sessionId) && isCounter(v.generation) && v.generation > 0;
}
export function isOpenAgentResponse(v: unknown): v is OpenAgentResponse {
  if (exactObject(v, ["status", "reason"])) return v.status === "refused" && ["disabled", "session", "provider", "limit"].includes(v.reason as string);
  return exactObject(v, ["status"]) && v.status === "opened";
}
export function isAgentConversationRequest(v: unknown): v is AgentConversationRequest {
  return exactObject(v, ["owner", "sessionId"]) && isOwner(v.owner) && identifier(v.sessionId);
}
export function isSendAgentRequest(v: unknown): v is SendAgentRequest {
  return exactObject(v, ["owner", "sessionId", "text"]) && isOwner(v.owner) && identifier(v.sessionId) &&
    prose(v.text, MAX_AGENT_MESSAGE) && v.text.trim().length > 0;
}
export function isSendAgentResponse(v: unknown): v is SendAgentResponse {
  if (exactObject(v, ["status", "reason"])) return v.status === "refused" && (v.reason === "busy" || v.reason === "ended");
  return exactObject(v, ["status"]) && v.status === "sent";
}
export function isCancelAgentTaskRequest(v: unknown): v is CancelAgentTaskRequest {
  return exactObject(v, ["owner", "sessionId", "taskId"]) && isOwner(v.owner) && identifier(v.sessionId) &&
    typeof v.taskId === "string" && TASK_ID.test(v.taskId);
}
export function isCancelAgentTaskResponse(v: unknown): v is CancelAgentTaskResponse {
  return exactObject(v, ["cancelled"]) && typeof v.cancelled === "boolean";
}
export function isSetAgentModeRequest(v: unknown): v is SetAgentModeRequest {
  return exactObject(v, ["owner", "sessionId", "generation", "mode", "acknowledged"]) && isOwner(v.owner) && identifier(v.sessionId) &&
    isCounter(v.generation) && v.generation > 0 && isMode(v.mode) && typeof v.acknowledged === "boolean";
}
export function isSetAgentModeResponse(v: unknown): v is SetAgentModeResponse {
  if (exactObject(v, ["status", "reason"])) return v.status === "refused" && ["ended", "acknowledge", "production"].includes(v.reason as string);
  return exactObject(v, ["status"]) && v.status === "set";
}
export function isDecideAgentRequest(v: unknown): v is DecideAgentRequest {
  return exactObject(v, ["owner", "sessionId", "generation", "approvalId", "decision", "production"]) && isOwner(v.owner) && identifier(v.sessionId) &&
    isCounter(v.generation) && v.generation > 0 && typeof v.approvalId === "string" && APPROVAL_ID.test(v.approvalId) &&
    (v.decision === "approve" || v.decision === "reject") && typeof v.production === "boolean";
}
export function isDecideAgentResponse(v: unknown): v is DecideAgentResponse {
  if (exactObject(v, ["status", "reason"])) return v.status === "refused" && (v.reason === "stale" || v.reason === "production");
  return exactObject(v, ["status"]) && v.status === "applied";
}
