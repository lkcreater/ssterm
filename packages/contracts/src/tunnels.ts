import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";
import { isCatalogId } from "./catalog.ts";

/** A rule with no entry is stopped. `failed` never counts as running. */
export type TunnelPhase = "starting" | "running" | "stopping" | "failed";
/** Fixed codes only: bind problems, the rule, or the tunnel session's typed failure. */
export type TunnelErrorCode =
  | "address-in-use"
  | "permission-denied"
  | "address-unavailable"
  | "bind-failed"
  | "remote-bind-refused"
  | "rule-not-found"
  | "already-active"
  | "resource-limit"
  | "locked"
  | "invalid-config"
  | "host-key-untrusted"
  | "host-key-changed"
  | "auth-denied"
  | "credentials-required"
  | "credentials-unavailable"
  | "invalid-private-key"
  | "unsupported-private-key"
  | "key-mismatch"
  | "prompt-cancelled"
  | "timeout"
  | "dns"
  | "network"
  | "channel-open-failed"
  | "jump-refused"
  | "proxy-failed"
  | "other";
export const TUNNEL_ERROR_CODES: readonly TunnelErrorCode[] = [
  "address-in-use", "permission-denied", "address-unavailable", "bind-failed", "remote-bind-refused", "rule-not-found", "already-active",
  "resource-limit", "locked", "invalid-config", "host-key-untrusted", "host-key-changed", "auth-denied", "credentials-required",
  "credentials-unavailable", "invalid-private-key", "unsupported-private-key", "key-mismatch", "prompt-cancelled", "timeout",
  "dns", "network", "channel-open-failed", "jump-refused", "proxy-failed", "other",
];
export interface TunnelStatus {
  ruleId: string;
  phase: TunnelPhase;
  /** Set only when `failed`. */
  error: TunnelErrorCode | null;
  activeConnections: number;
  totalConnections: number;
  failedConnections: number;
  /** Remote rules: the port the server actually listens on (assigned when the rule asks for 0). */
  remotePort: number | null;
}
export interface TunnelState {
  owner: Owner;
  sequence: number;
  tunnels: TunnelStatus[];
}
export interface TunnelStateRequest { owner: Owner }
export interface TunnelRuleRequest { owner: Owner; ruleId: string }
export type StartTunnelResponse = { status: "starting" } | { status: "failed"; code: TunnelErrorCode };
export interface StopTunnelResponse { status: "stopped" }

const phases: readonly string[] = ["starting", "running", "stopping", "failed"];
const code = (v: unknown): v is TunnelErrorCode => typeof v === "string" && TUNNEL_ERROR_CODES.includes(v as TunnelErrorCode);
function isTunnelStatus(v: unknown): v is TunnelStatus {
  return exactObject(v, ["ruleId", "phase", "error", "activeConnections", "totalConnections", "failedConnections", "remotePort"]) &&
    (v.remotePort === null || (isCounter(v.remotePort) && v.remotePort >= 1 && v.remotePort <= 65_535)) &&
    isCatalogId(v.ruleId) && phases.includes(v.phase as string) &&
    (v.phase === "failed" ? code(v.error) : v.error === null) &&
    isCounter(v.activeConnections) && isCounter(v.totalConnections) && isCounter(v.failedConnections);
}
export function isTunnelState(v: unknown): v is TunnelState {
  return exactObject(v, ["owner", "sequence", "tunnels"]) && isOwner(v.owner) && isCounter(v.sequence) &&
    Array.isArray(v.tunnels) && v.tunnels.length <= 64 && v.tunnels.every(isTunnelStatus);
}
export function isTunnelStateRequest(v: unknown): v is TunnelStateRequest {
  return exactObject(v, ["owner"]) && isOwner(v.owner);
}
export function isTunnelRuleRequest(v: unknown): v is TunnelRuleRequest {
  return exactObject(v, ["owner", "ruleId"]) && isOwner(v.owner) && isCatalogId(v.ruleId);
}
export function isStartTunnelResponse(v: unknown): v is StartTunnelResponse {
  if (exactObject(v, ["status"])) return v.status === "starting";
  return exactObject(v, ["status", "code"]) && v.status === "failed" && code(v.code);
}
export function isStopTunnelResponse(v: unknown): v is StopTunnelResponse {
  return exactObject(v, ["status"]) && v.status === "stopped";
}
