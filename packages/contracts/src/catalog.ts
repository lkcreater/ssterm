import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";

/** Per kind; `truncated` says a list was cut. */
export const MAX_CATALOG_ITEMS = 10_000;
export const MAX_CATALOG_LABEL = 200;
export const MAX_CATALOG_ADDRESS = 1024;
/** UTF-16 units, matching the credential prompt bound. */
export const MAX_IDENTITY_USERNAME = 256;

export type CatalogEnvironment = "DEV" | "STAGING" | "PROD" | null;
export type CatalogPort = { mode: "inherit" } | { mode: "value"; port: number };
export type CatalogAuth = { mode: "inherit" } | { mode: "clear" } | { mode: "value"; identityId: string };
export type CatalogSource = { kind: "default" } | { kind: "host" } | { kind: "group"; id: string };
export interface CatalogEffective {
  port: number;
  portSource: CatalogSource;
  authSelection: "identity" | "clear" | "none";
  identityId: string | null;
  authSource: CatalogSource;
}
export interface CatalogHost {
  id: string;
  revision: number;
  label: string;
  address: string;
  groupId: string | null;
  environment: CatalogEnvironment;
  port: CatalogPort;
  auth: CatalogAuth;
  /** Sorted by tag label. */
  tagIds: string[];
  /** Root first. */
  ancestry: { id: string; label: string }[];
  effective: CatalogEffective;
}
export interface CatalogGroup {
  id: string;
  revision: number;
  label: string;
  parentId: string | null;
  port: CatalogPort;
  auth: CatalogAuth;
  /** What this group receives from its ancestors (excluding itself); its own `inherit` fields resolve to these. */
  inherited: CatalogEffective;
}
export interface CatalogTag { id: string; revision: number; label: string }
export type IdentityMethod = "password" | "key" | "keyboard-interactive";
export type KeyAlgorithm = "ssh-ed25519" | "ssh-rsa";
/** `pending`: a Keychain change for this owner is unresolved (retry with `retrySecrets`). */
export interface CatalogIdentity {
  id: string;
  revision: number;
  label: string;
  username: string;
  method: IdentityMethod;
  passwordSaved: boolean;
  keyId: string | null;
  pending: boolean;
}
export interface CatalogKey {
  id: string;
  revision: number;
  label: string;
  algorithm: KeyAlgorithm;
  /** `SHA256:` + unpadded base64. */
  fingerprint: string;
  /** OpenSSH public key line without comment; public, safe to copy. */
  publicKey: string;
  passphraseSaved: boolean;
  pending: boolean;
}
export type TunnelBindAddress = "127.0.0.1" | "::1";
/** A saved local forwarding rule. Saving never starts it; the destination is resolved by the SSH server. */
export interface CatalogTunnelRule {
  id: string;
  revision: number;
  label: string;
  hostId: string;
  bindAddress: TunnelBindAddress;
  bindPort: number;
  destinationHost: string;
  destinationPort: number;
}
/** Metadata only: the body, its ciphertext and the key reference never cross IPC. */
export interface CatalogSnippet {
  id: string;
  revision: number;
  label: string;
  /** Sorted by tag label. */
  tagIds: string[];
}
export interface CatalogSecrets {
  availability: "ready" | "unavailable";
  /** A removed Keychain item still awaits deletion. */
  cleanupPending: boolean;
}
export interface CatalogState {
  owner: Owner;
  sequence: number;
  availability: "ready" | "unavailable";
  revision: number;
  truncated: boolean;
  hosts: CatalogHost[];
  groups: CatalogGroup[];
  tags: CatalogTag[];
  identities: CatalogIdentity[];
  keys: CatalogKey[];
  snippets: CatalogSnippet[];
  tunnelRules: CatalogTunnelRule[];
  secrets: CatalogSecrets;
  /** Counts workspace locks; an increase means decrypted editor content must be dropped. */
  lockEpoch: number;
}

export interface CatalogHostData {
  label: string;
  address: string;
  groupId?: string | null;
  environment?: CatalogEnvironment;
  port?: CatalogPort;
  auth?: CatalogAuth;
}
export interface CatalogGroupData {
  label: string;
  parentId?: string | null;
  port?: CatalogPort;
  auth?: CatalogAuth;
}
export interface CatalogTunnelRuleData {
  label: string;
  hostId: string;
  bindAddress?: TunnelBindAddress;
  bindPort: number;
  destinationHost: string;
  destinationPort: number;
}
export interface CatalogIdentityData {
  label: string;
  username: string;
  method: IdentityMethod;
  /** Required for `key`; must be absent or null otherwise. */
  keyId?: string | null;
}
/** The renderer subset of catalog intents; updates carry only changed fields (at least one, unless forgetting the password). */
export type CatalogChangeIntent =
  | { type: "create-host"; data: CatalogHostData }
  | { type: "update-host"; id: string; expectedRevision: number; data: Partial<CatalogHostData> }
  | { type: "delete-host"; id: string; expectedRevision: number }
  | { type: "create-group"; data: CatalogGroupData }
  | { type: "update-group"; id: string; expectedRevision: number; data: Partial<CatalogGroupData> }
  | {
      type: "delete-group";
      id: string;
      expectedRevision: number;
      disposition: { mode: "reparent"; parentId: string | null } | { mode: "subtree" };
    }
  | { type: "create-tag"; data: { label: string } }
  | { type: "delete-tag"; id: string; expectedRevision: number }
  | { type: "set-host-tag"; hostId: string; tagId: string; present: boolean; expectedHostRevision: number }
  | { type: "create-tunnel-rule"; data: CatalogTunnelRuleData }
  | { type: "update-tunnel-rule"; id: string; expectedRevision: number; data: Partial<CatalogTunnelRuleData> }
  | { type: "delete-tunnel-rule"; id: string; expectedRevision: number }
  | { type: "create-identity"; data: CatalogIdentityData }
  | {
      type: "update-identity";
      id: string;
      expectedRevision: number;
      data: Partial<CatalogIdentityData>;
      /** Also implied by switching away from `password`. */
      forgetPassword?: boolean;
    }
  | {
      type: "delete-identity";
      id: string;
      expectedRevision: number;
      disposition: { mode: "detach" } | { mode: "reassign"; identityId: string };
    };
export type CatalogFieldError =
  | { field: "label"; code: "empty" | "too-long" | "control" | "duplicate" }
  | { field: "address"; code: "invalid" | "too-long" }
  | { field: "port"; code: "invalid" }
  | { field: "parent"; code: "cycle" | "not-found" }
  | { field: "group" | "identity" | "tag"; code: "not-found" }
  | { field: "username"; code: "empty" | "too-long" | "control" }
  | { field: "keyId"; code: "not-found" | "required" }
  | { field: "bindPort" | "destinationPort"; code: "invalid" }
  | { field: "destination"; code: "invalid" | "too-long" }
  | { field: "host"; code: "not-found" }
  /** A starting, running or stopping tunnel uses this rule (or a rule of this server); stop it first. */
  | { field: "tunnel"; code: "running" };
export interface CatalogHostImpact {
  hostId: string;
  label: string;
  removed: boolean;
  effectiveConnectionChanged: boolean;
  provenanceChanged: boolean;
  pathChanged: boolean;
}
/** Identity update/delete only: what references the identity before the change. */
export interface CatalogIdentityImpact {
  directHostIds: string[];
  directGroupIds: string[];
  /** Every server whose effective identity is this one, directly or via groups. */
  effectiveHostIds: string[];
  removesSavedPassword: boolean;
}
export interface CatalogImpactSummary {
  hosts: CatalogHostImpact[];
  removedHostIds: string[];
  removedGroupIds: string[];
  removedTunnelRules: number;
  removedHostTags: number;
  removedSnippetTags: number;
  identity: CatalogIdentityImpact | null;
}
export type CatalogPrepareResponse =
  | { kind: "preview"; token: string; /** Epoch milliseconds. */ expiresAt: number; impacts: CatalogImpactSummary }
  | { kind: "invalid"; fields: CatalogFieldError[] };
export interface CatalogStateRequest { owner: Owner }
export interface PrepareCatalogChangeRequest { owner: Owner; intent: CatalogChangeIntent }
export interface ApplyCatalogChangeRequest { owner: Owner; token: string }
export interface CatalogApplyResponse { revision: number; createdIds: string[] }
export interface ConnectHostRequest { owner: Owner; hostId: string }
export interface ConnectHostResponse { sessionId: string; generation: number }

/** Shared with the renderer: what main reports as a `label` field error, before the duplicate check. */
export function validateCatalogLabel(text: string): "empty" | "too-long" | "control" | null {
  const label = text.trim();
  const length = [...label].length;
  if (length < 1) return "empty";
  if (length > MAX_CATALOG_LABEL) return "too-long";
  return /[\u0000-\u001f\u007f]/u.test(label) ? "control" : null;
}
export function validateIdentityUsername(text: string): "empty" | "too-long" | "control" | null {
  if (!text.trim()) return "empty";
  if (text.length > MAX_IDENTITY_USERNAME) return "too-long";
  return /[\u0000-\u001f\u007f]/u.test(text) ? "control" : null;
}
export function validatePort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

export const isCatalogId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const positive = (v: unknown): v is number => isCounter(v) && v > 0;
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
/** Content is checked by main as field errors, so the guard only bounds size. */
const raw = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const nullableId = (v: unknown) => v === null || isCatalogId(v);
const environment = (v: unknown) => v === null || v === "DEV" || v === "STAGING" || v === "PROD";
const port = (v: unknown, strict: boolean) =>
  (exactObject(v, ["mode"]) && v.mode === "inherit") ||
  (exactObject(v, ["mode", "port"]) && v.mode === "value" && (strict ? validatePort(v.port) : typeof v.port === "number"));
const auth = (v: unknown) =>
  (exactObject(v, ["mode"]) && (v.mode === "inherit" || v.mode === "clear")) ||
  (exactObject(v, ["mode", "identityId"]) && v.mode === "value" && isCatalogId(v.identityId));
const source = (v: unknown) =>
  (exactObject(v, ["kind"]) && (v.kind === "default" || v.kind === "host")) ||
  (exactObject(v, ["kind", "id"]) && v.kind === "group" && isCatalogId(v.id));
const list = <T>(v: unknown, item: (value: unknown) => value is T, max = MAX_CATALOG_ITEMS): v is T[] =>
  Array.isArray(v) && v.length <= max && v.every(item);
const ids = (v: unknown): v is string[] => list(v, isCatalogId);
const label = (v: unknown): v is string => text(v, 4 * MAX_CATALOG_LABEL);

function isEffective(v: unknown): v is CatalogEffective {
  return exactObject(v, ["port", "portSource", "authSelection", "identityId", "authSource"]) && validatePort(v.port) &&
    source(v.portSource) && source(v.authSource) &&
    (v.authSelection === "identity" ? isCatalogId(v.identityId) : (v.authSelection === "clear" || v.authSelection === "none") && v.identityId === null);
}
function isCatalogHost(v: unknown): v is CatalogHost {
  return exactObject(v, ["id", "revision", "label", "address", "groupId", "environment", "port", "auth", "tagIds", "ancestry", "effective"]) &&
    isCatalogId(v.id) && positive(v.revision) && label(v.label) && text(v.address, 253) && nullableId(v.groupId) &&
    environment(v.environment) && port(v.port, true) && auth(v.auth) && ids(v.tagIds) &&
    list(v.ancestry, (row): row is { id: string; label: string } => exactObject(row, ["id", "label"]) && isCatalogId(row.id) && label(row.label)) &&
    isEffective(v.effective);
}
function isCatalogGroup(v: unknown): v is CatalogGroup {
  return exactObject(v, ["id", "revision", "label", "parentId", "port", "auth", "inherited"]) && isCatalogId(v.id) &&
    positive(v.revision) && label(v.label) && nullableId(v.parentId) && port(v.port, true) && auth(v.auth) && isEffective(v.inherited);
}
function isCatalogTag(v: unknown): v is CatalogTag {
  return exactObject(v, ["id", "revision", "label"]) && isCatalogId(v.id) && positive(v.revision) && label(v.label);
}
function isCatalogIdentity(v: unknown): v is CatalogIdentity {
  return exactObject(v, ["id", "revision", "label", "username", "method", "passwordSaved", "keyId", "pending"]) && isCatalogId(v.id) &&
    positive(v.revision) && label(v.label) && text(v.username, 1024) && typeof v.passwordSaved === "boolean" && typeof v.pending === "boolean" &&
    (v.method === "key" ? isCatalogId(v.keyId) && !v.passwordSaved
      : v.keyId === null && (v.method === "password" || (v.method === "keyboard-interactive" && !v.passwordSaved)));
}
export const isKeyAlgorithm = (v: unknown): v is KeyAlgorithm => v === "ssh-ed25519" || v === "ssh-rsa";
export const isKeyFingerprint = (v: unknown): v is string => typeof v === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/u.test(v);
function isCatalogKey(v: unknown): v is CatalogKey {
  return exactObject(v, ["id", "revision", "label", "algorithm", "fingerprint", "publicKey", "passphraseSaved", "pending"]) &&
    isCatalogId(v.id) && positive(v.revision) && label(v.label) && isKeyAlgorithm(v.algorithm) && isKeyFingerprint(v.fingerprint) &&
    typeof v.publicKey === "string" && v.publicKey.length <= 16_384 && v.publicKey.startsWith(`${v.algorithm} `) &&
    /^[a-z0-9-]+ [A-Za-z0-9+/]+={0,2}$/u.test(v.publicKey) && typeof v.passphraseSaved === "boolean" && typeof v.pending === "boolean";
}
function isCatalogTunnelRule(v: unknown): v is CatalogTunnelRule {
  return exactObject(v, ["id", "revision", "label", "hostId", "bindAddress", "bindPort", "destinationHost", "destinationPort"]) &&
    isCatalogId(v.id) && positive(v.revision) && label(v.label) && isCatalogId(v.hostId) &&
    (v.bindAddress === "127.0.0.1" || v.bindAddress === "::1") && validatePort(v.bindPort) &&
    text(v.destinationHost, MAX_CATALOG_ADDRESS) && validatePort(v.destinationPort);
}
function isCatalogSnippet(v: unknown): v is CatalogSnippet {
  return exactObject(v, ["id", "revision", "label", "tagIds"]) && isCatalogId(v.id) && positive(v.revision) && label(v.label) && ids(v.tagIds);
}
export function isCatalogState(v: unknown): v is CatalogState {
  return exactObject(v, ["owner", "sequence", "availability", "revision", "truncated", "hosts", "groups", "tags", "identities", "keys", "snippets", "tunnelRules", "secrets", "lockEpoch"]) &&
    isOwner(v.owner) && isCounter(v.sequence) && (v.availability === "ready" || v.availability === "unavailable") &&
    isCounter(v.revision) && typeof v.truncated === "boolean" && list(v.hosts, isCatalogHost) && list(v.groups, isCatalogGroup) &&
    list(v.tags, isCatalogTag) && list(v.identities, isCatalogIdentity) && list(v.keys, isCatalogKey) && list(v.snippets, isCatalogSnippet) && list(v.tunnelRules, isCatalogTunnelRule) && isCounter(v.lockEpoch) &&
    exactObject(v.secrets, ["availability", "cleanupPending"]) && (v.secrets.availability === "ready" || v.secrets.availability === "unavailable") &&
    typeof v.secrets.cleanupPending === "boolean";
}

/** Data keys allowed per kind; `create` requires the listed ones. */
const dataKeys = {
  host: { all: ["label", "address", "groupId", "environment", "port", "auth"], required: ["label", "address"] },
  group: { all: ["label", "parentId", "port", "auth"], required: ["label"] },
  tag: { all: ["label"], required: ["label"] },
  identity: { all: ["label", "username", "method", "keyId"], required: ["label", "username", "method"] },
  "tunnel-rule": {
    all: ["label", "hostId", "bindAddress", "bindPort", "destinationHost", "destinationPort"],
    required: ["label", "hostId", "bindPort", "destinationHost", "destinationPort"],
  },
} as const;
function isData(v: unknown, kind: keyof typeof dataKeys, creating: boolean): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const allowed: readonly string[] = dataKeys[kind].all;
  if (keys.some((key) => !allowed.includes(key))) return false;
  if (creating ? dataKeys[kind].required.some((key) => !keys.includes(key)) : keys.length === 0) return false;
  const d = v as Record<string, unknown>;
  return (!("label" in d) || raw(d.label, 2048)) &&
    (!("address" in d) || raw(d.address, 2048)) &&
    (!("groupId" in d) || nullableId(d.groupId)) && (!("parentId" in d) || nullableId(d.parentId)) &&
    (!("environment" in d) || environment(d.environment)) && (!("port" in d) || port(d.port, false)) &&
    (!("auth" in d) || auth(d.auth)) && (!("username" in d) || raw(d.username, 2048)) &&
    (!("method" in d) || d.method === "password" || d.method === "key" || d.method === "keyboard-interactive") &&
    (!("keyId" in d) || nullableId(d.keyId)) &&
    (!("hostId" in d) || isCatalogId(d.hostId)) &&
    (!("bindAddress" in d) || d.bindAddress === "127.0.0.1" || d.bindAddress === "::1") &&
    // Port and destination content are field errors from main; the guard bounds type and size.
    (!("bindPort" in d) || typeof d.bindPort === "number") && (!("destinationPort" in d) || typeof d.destinationPort === "number") &&
    (!("destinationHost" in d) || raw(d.destinationHost, 2048));
}
export function isCatalogChangeIntent(v: unknown): v is CatalogChangeIntent {
  if (v === null || typeof v !== "object" || !("type" in v)) return false;
  const i = v as Record<string, unknown>;
  const target = () => isCatalogId(i.id) && positive(i.expectedRevision);
  switch (i.type) {
    case "create-host": case "create-group": case "create-tag": case "create-identity": case "create-tunnel-rule":
      return exactObject(i, ["type", "data"]) && isData(i.data, i.type.slice(7) as keyof typeof dataKeys, true);
    case "update-tunnel-rule":
      return exactObject(i, ["type", "id", "expectedRevision", "data"]) && target() && isData(i.data, "tunnel-rule", false);
    case "update-identity":
      if (Object.hasOwn(i, "forgetPassword"))
        return exactObject(i, ["type", "id", "expectedRevision", "data", "forgetPassword"]) && target() &&
          typeof i.forgetPassword === "boolean" && (exactObject(i.data, []) ? i.forgetPassword : isData(i.data, "identity", false));
      return exactObject(i, ["type", "id", "expectedRevision", "data"]) && target() && isData(i.data, "identity", false);
    case "delete-identity":
      return exactObject(i, ["type", "id", "expectedRevision", "disposition"]) && target() &&
        ((exactObject(i.disposition, ["mode"]) && i.disposition.mode === "detach") ||
          (exactObject(i.disposition, ["mode", "identityId"]) && i.disposition.mode === "reassign" && isCatalogId(i.disposition.identityId)));
    case "update-host": case "update-group":
      return exactObject(i, ["type", "id", "expectedRevision", "data"]) && target() && isData(i.data, i.type.slice(7) as "host" | "group", false);
    case "delete-host": case "delete-tag": case "delete-tunnel-rule":
      return exactObject(i, ["type", "id", "expectedRevision"]) && target();
    case "delete-group":
      return exactObject(i, ["type", "id", "expectedRevision", "disposition"]) && target() &&
        ((exactObject(i.disposition, ["mode"]) && i.disposition.mode === "subtree") ||
          (exactObject(i.disposition, ["mode", "parentId"]) && i.disposition.mode === "reparent" && nullableId(i.disposition.parentId)));
    case "set-host-tag":
      return exactObject(i, ["type", "hostId", "tagId", "present", "expectedHostRevision"]) && isCatalogId(i.hostId) &&
        isCatalogId(i.tagId) && typeof i.present === "boolean" && positive(i.expectedHostRevision);
    default:
      return false;
  }
}
const fieldCodes: Record<CatalogFieldError["field"], readonly string[]> = {
  label: ["empty", "too-long", "control", "duplicate"], address: ["invalid", "too-long"], port: ["invalid"],
  parent: ["cycle", "not-found"], group: ["not-found"], identity: ["not-found"], tag: ["not-found"],
  username: ["empty", "too-long", "control"], keyId: ["not-found", "required"],
  bindPort: ["invalid"], destinationPort: ["invalid"], destination: ["invalid", "too-long"], host: ["not-found"], tunnel: ["running"],
};
function isFieldError(v: unknown): v is CatalogFieldError {
  return exactObject(v, ["field", "code"]) && typeof v.field === "string" && Object.hasOwn(fieldCodes, v.field) &&
    fieldCodes[v.field as CatalogFieldError["field"]].includes(v.code as string);
}
function isHostImpact(v: unknown): v is CatalogHostImpact {
  return exactObject(v, ["hostId", "label", "removed", "effectiveConnectionChanged", "provenanceChanged", "pathChanged"]) &&
    isCatalogId(v.hostId) && label(v.label) &&
    [v.removed, v.effectiveConnectionChanged, v.provenanceChanged, v.pathChanged].every((flag) => typeof flag === "boolean");
}
export function isCatalogPrepareResponse(v: unknown): v is CatalogPrepareResponse {
  if (exactObject(v, ["kind", "fields"]))
    return v.kind === "invalid" && Array.isArray(v.fields) && v.fields.length > 0 && v.fields.length <= 8 && v.fields.every(isFieldError);
  if (!exactObject(v, ["kind", "token", "expiresAt", "impacts"]) || v.kind !== "preview" || !isCatalogId(v.token) || !positive(v.expiresAt))
    return false;
  const m = v.impacts;
  return exactObject(m, ["hosts", "removedHostIds", "removedGroupIds", "removedTunnelRules", "removedHostTags", "removedSnippetTags", "identity"]) &&
    list(m.hosts, isHostImpact) && ids(m.removedHostIds) && ids(m.removedGroupIds) &&
    isCounter(m.removedTunnelRules) && isCounter(m.removedHostTags) && isCounter(m.removedSnippetTags) &&
    (m.identity === null || (exactObject(m.identity, ["directHostIds", "directGroupIds", "effectiveHostIds", "removesSavedPassword"]) &&
      ids(m.identity.directHostIds) && ids(m.identity.directGroupIds) && ids(m.identity.effectiveHostIds) &&
      typeof m.identity.removesSavedPassword === "boolean"));
}
export function isCatalogStateRequest(v: unknown): v is CatalogStateRequest {
  return exactObject(v, ["owner"]) && isOwner(v.owner);
}
export function isPrepareCatalogChangeRequest(v: unknown): v is PrepareCatalogChangeRequest {
  return exactObject(v, ["owner", "intent"]) && isOwner(v.owner) && isCatalogChangeIntent(v.intent);
}
export function isApplyCatalogChangeRequest(v: unknown): v is ApplyCatalogChangeRequest {
  return exactObject(v, ["owner", "token"]) && isOwner(v.owner) && isCatalogId(v.token);
}
export function isCatalogApplyResponse(v: unknown): v is CatalogApplyResponse {
  return exactObject(v, ["revision", "createdIds"]) && positive(v.revision) && list(v.createdIds, isCatalogId, 1);
}
export function isConnectHostRequest(v: unknown): v is ConnectHostRequest {
  return exactObject(v, ["owner", "hostId"]) && isOwner(v.owner) && isCatalogId(v.hostId);
}
export function isConnectHostResponse(v: unknown): v is ConnectHostResponse {
  return exactObject(v, ["sessionId", "generation"]) && typeof v.sessionId === "string" &&
    /^[A-Za-z0-9:_-]{1,160}$/.test(v.sessionId) && positive(v.generation);
}
