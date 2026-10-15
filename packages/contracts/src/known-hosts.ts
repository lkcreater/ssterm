import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";

/** Renderer-safe copy of the domain list (domain imports Node built-ins); a unit test keeps them equal. */
export const HOST_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
] as const;
export type HostKeyAlgorithm = (typeof HOST_KEY_ALGORITHMS)[number];
/** Bounds one trust event; prompts are delivered even when the list is truncated. */
export const MAX_KNOWN_HOSTS = 10_000;
export type HostTrustDecision =
  | "accept-once"
  | "remember"
  | "replace"
  | "reject";
export interface KnownHostEntry {
  id: string;
  revision: number;
  endpointHost: string;
  endpointPort: number;
  algorithm: HostKeyAlgorithm;
  fingerprint: string;
  firstAcceptedAt: string;
  lastVerifiedAt: string;
}
interface PromptTarget {
  sessionId: string;
  generation: number;
  promptId: string;
  targetLabel: string;
  environment: "DEV" | "STAGING" | "PROD" | null;
  endpointHost: string;
  endpointPort: number;
  algorithm: HostKeyAlgorithm;
  fingerprint: string;
}
export type HostTrustPrompt = PromptTarget &
  (
    | { status: "unknown" }
    | {
        status: "changed";
        previousAlgorithm: HostKeyAlgorithm;
        previousFingerprint: string;
      }
  );
export interface TrustState {
  owner: Owner;
  sequence: number;
  availability: "ready" | "unavailable";
  knownHosts: KnownHostEntry[];
  /** More entries exist than `knownHosts` carries. */
  truncated: boolean;
  prompts: HostTrustPrompt[];
}
export interface TrustStateRequest {
  owner: Owner;
}
export interface AnswerHostTrustRequest {
  owner: Owner;
  sessionId: string;
  generation: number;
  promptId: string;
  decision: HostTrustDecision;
}
export interface PrepareKnownHostRevokeRequest {
  owner: Owner;
  id: string;
  expectedRevision: number;
}
export interface RevokeKnownHostRequest {
  owner: Owner;
  token: string;
}
export interface KnownHostRevokePreview {
  token: string;
  entry: KnownHostEntry;
  expiresAt: string;
}
export interface TrustActionResponse {
  accepted: true;
}

const algorithms = new Set<string>(HOST_KEY_ALGORITHMS);
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(v);
const positive = (v: unknown): v is number => isCounter(v) && v > 0;
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(v);
const algorithm = (v: unknown): v is HostKeyAlgorithm =>
  typeof v === "string" && algorithms.has(v);
const fingerprint = (v: unknown): v is string =>
  typeof v === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(v);
const date = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
const endpoint = (v: Record<string, unknown>): boolean =>
  text(v.endpointHost, 253) &&
  positive(v.endpointPort) &&
  v.endpointPort <= 65535 &&
  algorithm(v.algorithm) &&
  fingerprint(v.fingerprint);
export function isKnownHostEntry(v: unknown): v is KnownHostEntry {
  return (
    exactObject(v, [
      "id",
      "revision",
      "endpointHost",
      "endpointPort",
      "algorithm",
      "fingerprint",
      "firstAcceptedAt",
      "lastVerifiedAt",
    ]) &&
    identifier(v.id) &&
    positive(v.revision) &&
    endpoint(v) &&
    date(v.firstAcceptedAt) &&
    date(v.lastVerifiedAt)
  );
}
export function isHostTrustPrompt(v: unknown): v is HostTrustPrompt {
  const keys = [
    "sessionId",
    "generation",
    "promptId",
    "targetLabel",
    "environment",
    "endpointHost",
    "endpointPort",
    "algorithm",
    "fingerprint",
    "status",
  ];
  if (
    v !== null &&
    typeof v === "object" &&
    "status" in v &&
    v.status === "changed"
  )
    keys.push("previousAlgorithm", "previousFingerprint");
  return (
    exactObject(v, keys) &&
    identifier(v.sessionId) &&
    positive(v.generation) &&
    identifier(v.promptId) &&
    text(v.targetLabel, 400) &&
    ["DEV", "STAGING", "PROD", null].includes(v.environment as string | null) &&
    endpoint(v) &&
    (v.status === "unknown" ||
      (v.status === "changed" &&
        algorithm(v.previousAlgorithm) &&
        fingerprint(v.previousFingerprint)))
  );
}
export function isTrustState(v: unknown): v is TrustState {
  return (
    exactObject(v, [
      "owner",
      "sequence",
      "availability",
      "knownHosts",
      "truncated",
      "prompts",
    ]) &&
    (v.availability === "ready" || v.availability === "unavailable") &&
    isOwner(v.owner) &&
    isCounter(v.sequence) &&
    Array.isArray(v.knownHosts) &&
    v.knownHosts.length <= MAX_KNOWN_HOSTS &&
    typeof v.truncated === "boolean" &&
    v.knownHosts.every(isKnownHostEntry) &&
    Array.isArray(v.prompts) &&
    v.prompts.length <= 32 &&
    v.prompts.every(isHostTrustPrompt)
  );
}
export function isTrustStateRequest(v: unknown): v is TrustStateRequest {
  return exactObject(v, ["owner"]) && isOwner(v.owner);
}
export function isAnswerHostTrustRequest(
  v: unknown,
): v is AnswerHostTrustRequest {
  return (
    exactObject(v, [
      "owner",
      "sessionId",
      "generation",
      "promptId",
      "decision",
    ]) &&
    isOwner(v.owner) &&
    identifier(v.sessionId) &&
    positive(v.generation) &&
    identifier(v.promptId) &&
    ["accept-once", "remember", "replace", "reject"].includes(
      v.decision as string,
    )
  );
}
export function isPrepareKnownHostRevokeRequest(
  v: unknown,
): v is PrepareKnownHostRevokeRequest {
  return (
    exactObject(v, ["owner", "id", "expectedRevision"]) &&
    isOwner(v.owner) &&
    identifier(v.id) &&
    positive(v.expectedRevision)
  );
}
export function isRevokeKnownHostRequest(
  v: unknown,
): v is RevokeKnownHostRequest {
  return (
    exactObject(v, ["owner", "token"]) &&
    isOwner(v.owner) &&
    identifier(v.token)
  );
}
export function isKnownHostRevokePreview(
  v: unknown,
): v is KnownHostRevokePreview {
  return (
    exactObject(v, ["token", "entry", "expiresAt"]) &&
    identifier(v.token) &&
    isKnownHostEntry(v.entry) &&
    date(v.expiresAt)
  );
}
export function isTrustActionResponse(v: unknown): v is TrustActionResponse {
  return exactObject(v, ["accepted"]) && v.accepted === true;
}
