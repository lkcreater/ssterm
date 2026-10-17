import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";
import { isCatalogId } from "./catalog.ts";

/** The protected body limit (SST-006 `MAX_BODY`), in UTF-8 bytes. */
export const MAX_SNIPPET_BODY_BYTES = 1024 * 1024;
/** Tags one snippet may carry in a single save. */
export const MAX_SNIPPET_TAGS = 256;

/** Why the vault content key could not be used; `uninitialized` never reaches the renderer (the first save creates it). */
export type SnippetKeyReason = "missing" | "locked" | "denied" | "unavailable" | "error";
/** Protection problems: no plaintext fallback, no regenerated key, the stored ciphertext is kept. */
export type SnippetProtectionProblem =
  | { status: "key-unavailable"; reason: SnippetKeyReason }
  | { status: "corrupt" }
  | { status: "unsupported" };
export type SnippetFieldError =
  | { status: "invalid"; field: "label"; code: "empty" | "too-long" | "control" }
  | { status: "invalid"; field: "body"; code: "too-large" | "invalid-text" }
  | { status: "invalid"; field: "tag"; code: "not-found" };

/** Plaintext crosses only for this explicit editor action, and only to the requesting owner. */
export interface OpenSnippetRequest { owner: Owner; snippetId: string; expectedRevision: number }
export type OpenSnippetResponse = { status: "open"; revision: number; body: string } | SnippetProtectionProblem;
/** `snippetId` and `expectedRevision` are both null to create. `tagIds` is the complete membership set. Saving never runs anything. */
export interface SaveSnippetRequest {
  owner: Owner;
  snippetId: string | null;
  expectedRevision: number | null;
  label: string;
  body: string;
  tagIds: string[];
}
export type SaveSnippetResponse =
  | { status: "saved"; snippetId: string; revision: number }
  | SnippetFieldError
  | SnippetProtectionProblem;
export interface DeleteSnippetRequest { owner: Owner; snippetId: string; expectedRevision: number }
export interface DeleteSnippetResponse { status: "deleted" }

const positive = (v: unknown): v is number => isCounter(v) && v > 0;
const reasons: readonly string[] = ["missing", "locked", "denied", "unavailable", "error"];
function isProtectionProblem(v: unknown): v is SnippetProtectionProblem {
  if (exactObject(v, ["status", "reason"])) return v.status === "key-unavailable" && reasons.includes(v.reason as string);
  return exactObject(v, ["status"]) && (v.status === "corrupt" || v.status === "unsupported");
}
const fieldCodes: Record<SnippetFieldError["field"], readonly string[]> = {
  label: ["empty", "too-long", "control"],
  body: ["too-large", "invalid-text"],
  tag: ["not-found"],
};

export function isOpenSnippetRequest(v: unknown): v is OpenSnippetRequest {
  return exactObject(v, ["owner", "snippetId", "expectedRevision"]) && isOwner(v.owner) && isCatalogId(v.snippetId) &&
    positive(v.expectedRevision);
}
export function isOpenSnippetResponse(v: unknown): v is OpenSnippetResponse {
  if (exactObject(v, ["status", "revision", "body"]))
    return v.status === "open" && positive(v.revision) && typeof v.body === "string" && v.body.length <= MAX_SNIPPET_BODY_BYTES;
  return isProtectionProblem(v);
}
/** Sizes only; main reports label/body/tag content problems as field errors. */
export function isSaveSnippetRequest(v: unknown): v is SaveSnippetRequest {
  if (!exactObject(v, ["owner", "snippetId", "expectedRevision", "label", "body", "tagIds"]) || !isOwner(v.owner)) return false;
  const creating = v.snippetId === null && v.expectedRevision === null;
  const updating = isCatalogId(v.snippetId) && positive(v.expectedRevision);
  return (creating || updating) &&
    typeof v.label === "string" && v.label.length <= 2048 &&
    typeof v.body === "string" && v.body.length <= MAX_SNIPPET_BODY_BYTES &&
    Array.isArray(v.tagIds) && v.tagIds.length <= MAX_SNIPPET_TAGS && v.tagIds.every(isCatalogId) &&
    new Set(v.tagIds).size === v.tagIds.length;
}
export function isSaveSnippetResponse(v: unknown): v is SaveSnippetResponse {
  if (exactObject(v, ["status", "snippetId", "revision"]))
    return v.status === "saved" && isCatalogId(v.snippetId) && positive(v.revision);
  if (exactObject(v, ["status", "field", "code"]))
    return v.status === "invalid" && typeof v.field === "string" && Object.hasOwn(fieldCodes, v.field) &&
      fieldCodes[v.field as SnippetFieldError["field"]].includes(v.code as string);
  return isProtectionProblem(v);
}
export function isDeleteSnippetRequest(v: unknown): v is DeleteSnippetRequest {
  return exactObject(v, ["owner", "snippetId", "expectedRevision"]) && isOwner(v.owner) && isCatalogId(v.snippetId) &&
    positive(v.expectedRevision);
}
export function isDeleteSnippetResponse(v: unknown): v is DeleteSnippetResponse {
  return exactObject(v, ["status"]) && v.status === "deleted";
}
