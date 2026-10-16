/** Identity/key usage counts and fixed user-facing copy. Pure and unit-tested. */
import type {
  CatalogAuth,
  CatalogEffective,
  CatalogIdentity,
  CatalogIdentityData,
  IdentityMethod,
  KeyFileProblem,
  SecretStoreReason,
} from "@ssterm/contracts";
import { labelError, usernameError, type FieldErrors } from "./catalog-validation.ts";

interface Bound { auth: CatalogAuth }
interface HostLike extends Bound { id: string; effective: Pick<CatalogEffective, "authSelection" | "identityId"> }
interface GroupLike extends Bound { id: string }
type IdentityLike = Pick<CatalogIdentity, "method" | "passwordSaved" | "keyId" | "pending">;
interface KeyLike { id: string; label: string }

export interface IdentityUsage {
  /** Servers that connect with this identity. */
  servers: number;
  /** Of those, servers that select it themselves. */
  direct: number;
  /** Groups that select it. */
  groups: number;
}
const none: IdentityUsage = Object.freeze({ servers: 0, direct: 0, groups: 0 });

const bound = (row: Bound): string | undefined =>
  row.auth.mode === "value" ? row.auth.identityId : undefined;

export function identityUsages(
  hosts: readonly HostLike[],
  groups: readonly GroupLike[],
): ReadonlyMap<string, IdentityUsage> {
  const usage = new Map<string, IdentityUsage>();
  const bump = (id: string | null | undefined, key: keyof IdentityUsage) => {
    if (!id) return;
    const row = usage.get(id) ?? { ...none };
    row[key] += 1;
    usage.set(id, row);
  };
  for (const host of hosts) {
    if (host.effective.authSelection === "identity") bump(host.effective.identityId, "servers");
    bump(bound(host), "direct");
  }
  for (const group of groups) bump(bound(group), "groups");
  return usage;
}
export const usageOf = (usages: ReadonlyMap<string, IdentityUsage>, id: string): IdentityUsage =>
  usages.get(id) ?? none;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function usageText({ servers, direct, groups }: IdentityUsage): string {
  if (servers === 0)
    return groups ? `Not used by any servers (set on ${count(groups, "group")})` : "Not used by any servers";
  // A host's own selection always wins over its group, so direct ≤ servers.
  return `Used by ${count(servers, "server")} (${direct} direct, ${servers - direct} via groups)`;
}

export function keyUsers<T extends { keyId: string | null }>(identities: readonly T[], keyId: string): T[] {
  return identities.filter((identity) => identity.keyId === keyId);
}
/** Why Delete is unavailable, naming up to three of the identities that use the key. */
export function keyInUseReason(labels: readonly string[]): string | undefined {
  if (!labels.length) return undefined;
  const named = labels.slice(0, 3).join(", ") + (labels.length > 3 ? ` and ${labels.length - 3} more` : "");
  return `Can't delete: used by ${named}. Choose another key for ${labels.length === 1 ? "it" : "them"} first.`;
}

export type CredentialTone = "saved" | "asks" | "key" | "unresolved" | "missing";
export function credentialStatus(
  identity: IdentityLike,
  keys: ReadonlyMap<string, KeyLike>,
): { tone: CredentialTone; text: string } {
  if (identity.pending) return { tone: "unresolved", text: "Keychain change unresolved" };
  if (identity.method === "key") {
    const key = identity.keyId ? keys.get(identity.keyId) : undefined;
    return key ? { tone: "key", text: key.label } : { tone: "missing", text: "Key unavailable" };
  }
  if (identity.method === "password" && identity.passwordSaved) return { tone: "saved", text: "Saved in Keychain" };
  return { tone: "asks", text: "Asks when connecting" };
}

export const methodLabels = {
  password: "Password",
  key: "SSH key",
  "keyboard-interactive": "Keyboard-interactive",
} as const;
export const algorithmLabel = (algorithm: string): string =>
  algorithm === "ssh-ed25519" ? "Ed25519" : algorithm === "ssh-rsa" ? "RSA" : algorithm;

export const importProblemText: Record<KeyFileProblem | "wrong-passphrase" | "expired", string> = {
  unreadable: "The file could not be read. Check that it still exists and that your account can open it.",
  "too-large": "Key files must be 64 KiB or smaller. Choose a private key file.",
  unsupported:
    "This key type, format or protection is not supported. ssterm imports OpenSSH Ed25519 keys and PEM RSA keys whose passphrase uses at most 256 rounds. To convert an OpenSSH RSA key, run ssh-keygen -p -m PEM -f <key file> on a copy; to lower the rounds, run ssh-keygen -p -a 100 -f <key file> on a copy. Then import the copy.",
  invalid: "This file is not a private key ssterm can read. Choose the private key, not the .pub file.",
  "wrong-passphrase": "That passphrase does not unlock this key. Check it and try again.",
  expired: "The chosen file is no longer held. Choose the file again.",
};
export const secretStoreText: Record<SecretStoreReason, string> = {
  unavailable: "The macOS Keychain is unavailable, so nothing was saved there.",
  denied: "Keychain access was denied. Allow ssterm in Keychain Access, then try again.",
  locked: "ssterm or the Keychain locked before the change finished. Try again.",
  unknown: "The Keychain did not confirm the change. Try again; if it keeps failing, check ssterm in Keychain Access.",
};

export interface IdentityDraft { label: string; username: string; method: IdentityMethod; keyId: string | null }
type IdentityBase = Pick<CatalogIdentity, "id" | "revision" | "label" | "username" | "method" | "keyId">;

export const identityDraft = (identity?: IdentityBase): IdentityDraft => ({
  label: identity?.label ?? "",
  username: identity?.username ?? "",
  method: identity?.method ?? "password",
  keyId: identity?.keyId ?? null,
});

/** Same field names as main's `CatalogFieldError`, so server errors merge over these. */
export function identityErrors(draft: IdentityDraft): FieldErrors {
  const errors: FieldErrors = {
    label: labelError(draft.label),
    username: usernameError(draft.username),
    keyId: draft.method === "key" && !draft.keyId ? "Choose a key, or import one." : undefined,
  };
  return Object.fromEntries(Object.entries(errors).filter(([, v]) => v)) as FieldErrors;
}

/**
 * Only changed fields; `undefined` when nothing changes. Main forgets a saved password itself when the method
 * leaves `password` and clears the key when it leaves `key`, so neither needs to be sent.
 */
export function identityIntent(draft: IdentityDraft, base: IdentityBase | undefined, forgetPassword: boolean) {
  const data: CatalogIdentityData = {
    label: draft.label.trim(),
    username: draft.username.trim(),
    method: draft.method,
    ...(draft.method === "key" ? { keyId: draft.keyId } : {}),
  };
  if (!base) return { type: "create-identity" as const, data };
  const changed: Partial<CatalogIdentityData> = Object.fromEntries(
    Object.entries(data).filter(([key, value]) => value !== base[key as keyof CatalogIdentityData]),
  );
  const forget = forgetPassword && draft.method === "password" && base.method === "password";
  if (!Object.keys(changed).length && !forget) return undefined;
  return {
    type: "update-identity" as const,
    id: base.id,
    expectedRevision: base.revision,
    data: changed,
    ...(forget ? { forgetPassword: true } : {}),
  };
}
