import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";
import { isCatalogId, isKeyAlgorithm, isKeyFingerprint, type KeyAlgorithm } from "./catalog.ts";

/** Passwords and passphrases, in UTF-8 bytes. */
export const MIN_CREDENTIAL_BYTES = 1;
export const MAX_CREDENTIAL_BYTES = 16 * 1024;
/** Private key files read by main. */
export const MAX_KEY_FILE_BYTES = 64 * 1024;

/** The real Keychain reports failures as `unavailable` (reads) or `unknown` (writes); `denied`/`locked` exist for other providers. */
export type SecretStoreReason = "unavailable" | "denied" | "locked" | "unknown";
export interface SecretStoreProblem { status: "secret-store"; reason: SecretStoreReason }
/** `unsupported`: not OpenSSH Ed25519 or PEM RSA (`ssh-keygen -p -m PEM` converts an OpenSSH RSA key). */
export type KeyFileProblem = "unreadable" | "too-large" | "unsupported" | "invalid";

export interface SetIdentityPasswordRequest { owner: Owner; identityId: string; expectedRevision: number; value: Uint8Array }
export type SetIdentityPasswordResponse = { status: "saved" } | SecretStoreProblem;

export interface ChooseKeyFileRequest { owner: Owner }
/** The file path and bytes stay in main; `importId` is bound to the owner, single use, and expires after 5 minutes or on lock. */
export type ChooseKeyFileResponse =
  | { status: "cancelled" }
  | {
      status: "chosen";
      importId: string;
      suggestedLabel: string;
      encrypted: boolean;
      /** Known before import only for an unencrypted key. */
      algorithm: KeyAlgorithm | null;
      fingerprint: string | null;
    }
  | { status: "rejected"; problem: KeyFileProblem };

/** `passphrase` is required exactly when the chosen key is encrypted. */
export interface ImportKeyRequest { owner: Owner; importId: string; label: string; passphrase: Uint8Array | null; savePassphrase: boolean }
export type ImportKeyResponse =
  | {
      status: "imported";
      keyId: string;
      fingerprint: string;
      passphrase: { status: "saved" } | { status: "not-saved" } | SecretStoreProblem;
    }
  /** The import is kept; ask again. */
  | { status: "wrong-passphrase" }
  | { status: "expired" }
  /** An encrypted key whose decrypted contents are not a supported key. */
  | { status: "rejected"; problem: "unsupported" | "invalid" }
  | SecretStoreProblem;

export interface DiscardKeyImportRequest { owner: Owner; importId: string }
export interface DiscardKeyImportResponse { status: "discarded" }
export interface KeyTargetRequest { owner: Owner; keyId: string; expectedRevision: number }
export interface RenameKeyRequest extends KeyTargetRequest { label: string }
export interface RenameKeyResponse { status: "renamed" }
export type ForgetKeyPassphraseRequest = KeyTargetRequest;
/** `cleanup: "pending"`: the Keychain item is queued for deletion; `retrySecrets` retries. */
export type ForgetKeyPassphraseResponse = { status: "forgotten"; cleanup: "cleaned" | "pending" } | SecretStoreProblem;
export type DeleteKeyRequest = KeyTargetRequest;
export type DeleteKeyResponse =
  | { status: "deleted"; cleanup: "cleaned" | "pending" }
  | { status: "in-use"; identityIds: string[] }
  | SecretStoreProblem;
export interface RetrySecretsRequest { owner: Owner }
export type RetrySecretsResponse = { status: "retried" } | SecretStoreProblem;

const positive = (v: unknown): v is number => isCounter(v) && v > 0;
const bytes = (v: unknown): v is Uint8Array =>
  v instanceof Uint8Array && v.byteLength >= MIN_CREDENTIAL_BYTES && v.byteLength <= MAX_CREDENTIAL_BYTES;
/** Content is checked by main with `validateCatalogLabel`; the guard only bounds size. */
const rawLabel = (v: unknown): v is string => typeof v === "string" && v.length <= 2048;
const storeReasons: readonly unknown[] = ["unavailable", "denied", "locked", "unknown"];
const isStoreProblem = (v: unknown): v is SecretStoreProblem =>
  exactObject(v, ["status", "reason"]) && v.status === "secret-store" && storeReasons.includes(v.reason);
const status = (v: unknown, value: string) => exactObject(v, ["status"]) && v.status === value;
const cleaned = (v: Record<string, unknown>, value: string) =>
  exactObject(v, ["status", "cleanup"]) && v.status === value && (v.cleanup === "cleaned" || v.cleanup === "pending");

export function isSetIdentityPasswordRequest(v: unknown): v is SetIdentityPasswordRequest {
  return exactObject(v, ["owner", "identityId", "expectedRevision", "value"]) && isOwner(v.owner) && isCatalogId(v.identityId) &&
    positive(v.expectedRevision) && bytes(v.value);
}
export function isChooseKeyFileRequest(v: unknown): v is ChooseKeyFileRequest {
  return exactObject(v, ["owner"]) && isOwner(v.owner);
}
export const isRetrySecretsRequest = isChooseKeyFileRequest as (v: unknown) => v is RetrySecretsRequest;
export function isImportKeyRequest(v: unknown): v is ImportKeyRequest {
  return exactObject(v, ["owner", "importId", "label", "passphrase", "savePassphrase"]) && isOwner(v.owner) && isCatalogId(v.importId) &&
    rawLabel(v.label) && (v.passphrase === null || bytes(v.passphrase)) && typeof v.savePassphrase === "boolean" &&
    (v.passphrase !== null || !v.savePassphrase);
}
export function isDiscardKeyImportRequest(v: unknown): v is DiscardKeyImportRequest {
  return exactObject(v, ["owner", "importId"]) && isOwner(v.owner) && isCatalogId(v.importId);
}
const isTarget = (v: Record<string, unknown>) => isOwner(v.owner) && isCatalogId(v.keyId) && positive(v.expectedRevision);
export function isRenameKeyRequest(v: unknown): v is RenameKeyRequest {
  return exactObject(v, ["owner", "keyId", "expectedRevision", "label"]) && isTarget(v) && rawLabel(v.label);
}
export function isKeyTargetRequest(v: unknown): v is KeyTargetRequest {
  return exactObject(v, ["owner", "keyId", "expectedRevision"]) && isTarget(v);
}

export function isSetIdentityPasswordResponse(v: unknown): v is SetIdentityPasswordResponse {
  return status(v, "saved") || isStoreProblem(v);
}
const keyFileProblems: readonly unknown[] = ["unreadable", "too-large", "unsupported", "invalid"];
export function isChooseKeyFileResponse(v: unknown): v is ChooseKeyFileResponse {
  if (status(v, "cancelled")) return true;
  if (exactObject(v, ["status", "problem"])) return v.status === "rejected" && keyFileProblems.includes(v.problem);
  return exactObject(v, ["status", "importId", "suggestedLabel", "encrypted", "algorithm", "fingerprint"]) && v.status === "chosen" &&
    isCatalogId(v.importId) && typeof v.suggestedLabel === "string" && v.suggestedLabel.length > 0 && v.suggestedLabel.length <= 800 &&
    !/[\u0000-\u001f\u007f]/u.test(v.suggestedLabel) && typeof v.encrypted === "boolean" &&
    (v.encrypted ? v.algorithm === null && v.fingerprint === null : isKeyAlgorithm(v.algorithm) && isKeyFingerprint(v.fingerprint));
}
export function isImportKeyResponse(v: unknown): v is ImportKeyResponse {
  if (status(v, "wrong-passphrase") || status(v, "expired") || isStoreProblem(v)) return true;
  if (exactObject(v, ["status", "problem"])) return v.status === "rejected" && (v.problem === "unsupported" || v.problem === "invalid");
  return exactObject(v, ["status", "keyId", "fingerprint", "passphrase"]) && v.status === "imported" && isCatalogId(v.keyId) &&
    isKeyFingerprint(v.fingerprint) && (status(v.passphrase, "saved") || status(v.passphrase, "not-saved") || isStoreProblem(v.passphrase));
}
export function isDiscardKeyImportResponse(v: unknown): v is DiscardKeyImportResponse {
  return status(v, "discarded");
}
export function isRenameKeyResponse(v: unknown): v is RenameKeyResponse {
  return status(v, "renamed");
}
export function isForgetKeyPassphraseResponse(v: unknown): v is ForgetKeyPassphraseResponse {
  return isStoreProblem(v) || (exactObject(v, ["status", "cleanup"]) && cleaned(v, "forgotten"));
}
export function isDeleteKeyResponse(v: unknown): v is DeleteKeyResponse {
  if (isStoreProblem(v)) return true;
  if (exactObject(v, ["status", "identityIds"]))
    return v.status === "in-use" && Array.isArray(v.identityIds) && v.identityIds.length > 0 && v.identityIds.length <= 10_000 &&
      v.identityIds.every(isCatalogId);
  return exactObject(v, ["status", "cleanup"]) && cleaned(v, "deleted");
}
export function isRetrySecretsResponse(v: unknown): v is RetrySecretsResponse {
  return status(v, "retried") || isStoreProblem(v);
}
