import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";

/** One maximum paste (256 KiB) plus its 12 bracket bytes fits one write, so it is accepted or refused whole. */
export const MAX_TERMINAL_WRITE = 294_912;
export const MAX_TERMINAL_CHUNK = 1_048_576;
export const MAX_TERMINAL_SIZE = 1_000;
/** Mirrors the domain `TerminalEnd`; main assigns one to the other, so drift fails compilation. */
export type TerminalEnd =
  | { kind: "exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "eof" };
export type TerminalPhase = "connecting" | "ready" | "closed" | "failed";
/** App-authored failure reasons; the renderer owns their wording. */
export const TERMINAL_ERROR_CODES = [
  "invalid-config", "host-key-untrusted", "host-key-changed", "auth-denied", "credentials-required",
  "credentials-unavailable", "invalid-private-key", "unsupported-private-key", "key-mismatch", "prompt-cancelled",
  "timeout", "dns", "network", "channel-open-failed", "subsystem-unavailable", "resource-limit", "locked",
  "jump-refused", "proxy-failed",
] as const;
export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];
export interface TerminalSession {
  sessionId: string;
  generation: number;
  /** The saved host this session connects to. */
  hostId: string;
  phase: TerminalPhase;
  target: {
    label: string;
    environment: "DEV" | "STAGING" | "PROD" | null;
    endpointHost: string;
    endpointPort: number;
    username: string | null;
  } | null;
  /** Present only when the remote side ended this generation. */
  end: TerminalEnd | null;
  /** Why this generation failed or was closed by ssterm (e.g. `locked`); null for a plain local close. */
  error: TerminalErrorCode | null;
}
export interface TerminalState { owner: Owner; sequence: number; sessions: TerminalSession[] }
export interface TerminalStateRequest { owner: Owner }
export interface TerminalTarget { owner: Owner; sessionId: string; generation: number }
/** Operation cancellation may close a captured generation only while it is still connecting. */
export interface CloseTerminalRequest extends TerminalTarget { onlyConnecting?: true }
export interface TerminalOutput extends TerminalTarget { sequence: number; bytes: Uint8Array }
export interface WriteTerminalRequest extends TerminalTarget { bytes: Uint8Array }
export interface ResizeTerminalRequest extends TerminalTarget { columns: number; rows: number }
export interface AckTerminalRequest extends TerminalTarget { bytes: number }
export interface TerminalActionResponse { accepted: true }

const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(v);
const positive = (v: unknown): v is number => isCounter(v) && v > 0;
const between = (v: unknown, max: number): v is number => positive(v) && v <= max;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const bytes = (v: unknown, max: number): v is Uint8Array => v instanceof Uint8Array && v.byteLength > 0 && v.byteLength <= max;
const target = (v: Record<string, unknown>): boolean => isOwner(v.owner) && identifier(v.sessionId) && positive(v.generation);

export function isTerminalEnd(v: unknown): v is TerminalEnd {
  if (exactObject(v, ["kind", "code"])) return v.kind === "exit" && isCounter(v.code) && v.code <= 0xffff_ffff;
  if (exactObject(v, ["kind", "signal"])) return v.kind === "signal" && typeof v.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(v.signal);
  return exactObject(v, ["kind"]) && v.kind === "eof";
}
function isTerminalSessionTarget(v: unknown): v is NonNullable<TerminalSession["target"]> {
  return exactObject(v, ["label", "environment", "endpointHost", "endpointPort", "username"]) && text(v.label, 400) &&
    ["DEV", "STAGING", "PROD", null].includes(v.environment as string | null) && text(v.endpointHost, 253) &&
    between(v.endpointPort, 65_535) && (v.username === null || text(v.username, 1024));
}
export function isTerminalSession(v: unknown): v is TerminalSession {
  return exactObject(v, ["sessionId", "generation", "hostId", "phase", "target", "end", "error"]) && identifier(v.sessionId) && positive(v.generation) &&
    identifier(v.hostId) &&
    ["connecting", "ready", "closed", "failed"].includes(v.phase as string) &&
    (v.target === null || isTerminalSessionTarget(v.target)) && (v.end === null || isTerminalEnd(v.end)) &&
    (v.error === null || (TERMINAL_ERROR_CODES as readonly unknown[]).includes(v.error));
}
export function isTerminalState(v: unknown): v is TerminalState {
  return exactObject(v, ["owner", "sequence", "sessions"]) && isOwner(v.owner) && isCounter(v.sequence) &&
    Array.isArray(v.sessions) && v.sessions.length <= 32 && v.sessions.every(isTerminalSession);
}
export function isTerminalStateRequest(v: unknown): v is TerminalStateRequest { return exactObject(v, ["owner"]) && isOwner(v.owner); }
export function isTerminalTarget(v: unknown): v is TerminalTarget {
  return exactObject(v, ["owner", "sessionId", "generation"]) && target(v);
}
export function isCloseTerminalRequest(v: unknown): v is CloseTerminalRequest {
  return isTerminalTarget(v) || (exactObject(v, ["owner", "sessionId", "generation", "onlyConnecting"]) && target(v) && v.onlyConnecting === true);
}
export function isTerminalOutput(v: unknown): v is TerminalOutput {
  return exactObject(v, ["owner", "sessionId", "generation", "sequence", "bytes"]) && target(v) && isCounter(v.sequence) && bytes(v.bytes, MAX_TERMINAL_CHUNK);
}
export function isWriteTerminalRequest(v: unknown): v is WriteTerminalRequest {
  return exactObject(v, ["owner", "sessionId", "generation", "bytes"]) && target(v) && bytes(v.bytes, MAX_TERMINAL_WRITE);
}
export function isResizeTerminalRequest(v: unknown): v is ResizeTerminalRequest {
  return exactObject(v, ["owner", "sessionId", "generation", "columns", "rows"]) && target(v) &&
    between(v.columns, MAX_TERMINAL_SIZE) && between(v.rows, MAX_TERMINAL_SIZE);
}
export function isAckTerminalRequest(v: unknown): v is AckTerminalRequest {
  return exactObject(v, ["owner", "sessionId", "generation", "bytes"]) && target(v) && between(v.bytes, MAX_TERMINAL_CHUNK);
}
export function isTerminalActionResponse(v: unknown): v is TerminalActionResponse { return exactObject(v, ["accepted"]) && v.accepted === true; }
