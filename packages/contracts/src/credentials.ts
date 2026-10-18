import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";

export type CredentialFieldId = "password" | "passphrase" | `response-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}`;
export interface CredentialPrompt {
  sessionId: string;
  generation: number;
  promptId: string;
  /** The server this prompt is for: the target, or (SST-030) a jump host on the way to `jumpFor`. */
  targetLabel: string;
  environment: "DEV" | "STAGING" | "PROD" | null;
  endpointHost: string;
  endpointPort: number;
  username: string | null;
  /** SST-030: set when this prompt is for a jump host; the label of the server being connected to. */
  jumpFor: string | null;
  purpose: "password" | "passphrase" | "keyboard-interactive";
  attempt: 1 | 2 | 3;
  fields: { id: CredentialFieldId; echo: boolean }[];
}
export interface CredentialState {
  owner: Owner;
  sequence: number;
  availability: "ready" | "unavailable";
  prompts: CredentialPrompt[];
}
export interface CredentialStateRequest { owner: Owner }
export interface CancelCredentialPromptRequest {
  owner: Owner;
  sessionId: string;
  generation: number;
  promptId: string;
}
export interface AnswerCredentialsRequest extends CancelCredentialPromptRequest {
  values: { id: CredentialFieldId; value: Uint8Array }[];
}
export interface CredentialActionResponse { accepted: true }
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(v);
const positive = (v: unknown): v is number => isCounter(v) && v > 0;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
export const isCredentialFieldId = (v: unknown): v is CredentialFieldId => typeof v === "string" && /^(password|passphrase|response-[1-8])$/.test(v);
export function isCredentialPrompt(v: unknown): v is CredentialPrompt {
  return exactObject(v, ["sessionId", "generation", "promptId", "targetLabel", "environment", "endpointHost", "endpointPort", "username", "jumpFor", "purpose", "attempt", "fields"]) &&
    (v.jumpFor === null || text(v.jumpFor, 400)) &&
    identifier(v.sessionId) && positive(v.generation) && identifier(v.promptId) && text(v.targetLabel, 400) &&
    ["DEV", "STAGING", "PROD", null].includes(v.environment as string | null) && text(v.endpointHost, 253) && positive(v.endpointPort) && v.endpointPort <= 65535 &&
    (v.username === null || text(v.username, 256)) && ["password", "passphrase", "keyboard-interactive"].includes(v.purpose as string) && [1, 2, 3].includes(v.attempt as number) &&
    Array.isArray(v.fields) && v.fields.length >= 1 && v.fields.length <= 8 &&
    v.fields.every((field) => exactObject(field, ["id", "echo"]) && isCredentialFieldId(field.id) && typeof field.echo === "boolean") &&
    new Set(v.fields.map((field) => field.id)).size === v.fields.length;
}
export function isCredentialState(v: unknown): v is CredentialState {
  return exactObject(v, ["owner", "sequence", "availability", "prompts"]) && isOwner(v.owner) && isCounter(v.sequence) &&
    (v.availability === "ready" || v.availability === "unavailable") && Array.isArray(v.prompts) && v.prompts.length <= 32 && v.prompts.every(isCredentialPrompt);
}
export function isCredentialStateRequest(v: unknown): v is CredentialStateRequest { return exactObject(v, ["owner"]) && isOwner(v.owner); }
const identity = (v: Record<string, unknown>): boolean => isOwner(v.owner) && identifier(v.sessionId) && positive(v.generation) && identifier(v.promptId);
export function isCancelCredentialPromptRequest(v: unknown): v is CancelCredentialPromptRequest {
  return exactObject(v, ["owner", "sessionId", "generation", "promptId"]) && identity(v);
}
export function isAnswerCredentialsRequest(v: unknown): v is AnswerCredentialsRequest {
  if (!exactObject(v, ["owner", "sessionId", "generation", "promptId", "values"]) || !identity(v) || !Array.isArray(v.values) || v.values.length < 1 || v.values.length > 8) return false;
  let total = 0;
  const ids = new Set<string>();
  for (const field of v.values) {
    if (!exactObject(field, ["id", "value"]) || !isCredentialFieldId(field.id) || ids.has(field.id) || !(field.value instanceof Uint8Array) || field.value.byteLength > 16 * 1024) return false;
    ids.add(field.id);
    total += field.value.byteLength;
  }
  return total <= 64 * 1024;
}
export function isCredentialActionResponse(v: unknown): v is CredentialActionResponse { return exactObject(v, ["accepted"]) && v.accepted === true; }
