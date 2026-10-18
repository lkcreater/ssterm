import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  channels, failure, isApplyCatalogChangeRequest, isCatalogPrepareResponse, isCatalogState, isCatalogStateRequest,
  isPrepareCatalogChangeRequest, isKeyAlgorithm, validateCatalogLabel, validateIdentityUsername, validatePort, MAX_CATALOG_ADDRESS, MAX_CATALOG_ITEMS,
  type ApplyCatalogChangeRequest, type CatalogApplyResponse, type CatalogChangeIntent, type CatalogEffective,
  type CatalogFieldError, type CatalogKey, type CatalogPrepareResponse, type CatalogSource, type CatalogState, type Owner,
  type PrepareCatalogChangeRequest, type Result,
} from "@ssterm/contracts";
import {
  hostChainProblem, normalizeEndpoint, normalizeTag, queryCatalogHosts, resolveGroupDefaults,
  type ConfigSource, type GroupDefaults, type MetadataRepository, type MetadataSnapshot, type SecretOperation,
} from "@ssterm/domain";
import type { CatalogModule } from "@ssterm/services";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";

type Body = Omit<CatalogState, "owner" | "sequence">;
interface Registration {
  owner: Owner;
  sequence: number;
  send(state: CatalogState): void;
}
const unavailable: Body = {
  availability: "unavailable", revision: 0, truncated: false, hosts: [], groups: [], tags: [], identities: [], keys: [], snippets: [], tunnelRules: [],
  secrets: { availability: "unavailable", cleanupPending: false }, lockEpoch: 0,
};
const rootDefaults: CatalogEffective = {
  port: 22, portSource: { kind: "default" }, authSelection: "none", identityId: null, authSource: { kind: "default" },
};
const source = (value: ConfigSource): CatalogSource =>
  value.kind === "default" ? { kind: "default" } : value.kind === "host" ? { kind: "host" } : { kind: "group", id: value.id };
const effective = (value: GroupDefaults): CatalogEffective => ({
  port: value.port.value, portSource: source(value.port.source), authSelection: value.auth.selection,
  identityId: value.auth.identity?.id ?? null, authSource: source(value.auth.source),
});
const port = (value: { mode: "inherit" } | { mode: "value"; port: number }) =>
  value.mode === "value" ? { mode: "value" as const, port: value.port } : { mode: "inherit" as const };
const auth = (value: { mode: "inherit" | "clear" } | { mode: "value"; identityId: string }) =>
  value.mode === "value" ? { mode: "value" as const, identityId: value.identityId } : { mode: value.mode };
const byLabel = <T extends { id: string; label: string }>(rows: T[]) => {
  const key = (row: T) => row.label.normalize("NFC").toLowerCase();
  return rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** A queued Keychain deletion normally retires within milliseconds; only one still queued after this needs Retry. */
export const CLEANUP_STALL_MS = 5_000;
const cleaning = (op: SecretOperation) => op.state === "cleanup";
// An unparseable timestamp counts as stalled.
const stalled = (op: SecretOperation, now: number) => cleaning(op) && !(now - Date.parse(op.updatedAt) < CLEANUP_STALL_MS);

/** Builds the renderer projection. Only the fields named here cross IPC; secret references and operation ids never do. */
function project(snapshot: MetadataSnapshot, secretStore: boolean, now: number, lockEpoch: number): Body {
  const views = queryCatalogHosts(snapshot, { scope: { kind: "all" } });
  const defaults = resolveGroupDefaults(snapshot);
  if (!views.ok || !defaults.ok) return { ...unavailable, lockEpoch };
  // `staged` is an in-flight write (startup reconciliation resolves one left by a crash); only a stalled one needs Retry.
  const pending = new Set(snapshot.secretOperations
    .filter((op) => op.action !== "delete" && (op.state === "reconcile" || op.state === "needs-input")).map((op) => op.ownerId));
  // Only main's import creates keys; any other algorithm could not be shown faithfully.
  const keys = snapshot.keys.filter((key) => isKeyAlgorithm(key.algorithm));
  const counts = [views.value.length, snapshot.groups.length, snapshot.tags.length, snapshot.identities.length, keys.length, snapshot.snippets.length, snapshot.tunnelRules.length];
  const tagLabels = new Map(snapshot.tags.map((tag) => [tag.id, tag.label.normalize("NFC").toLowerCase()]));
  const snippetTags = new Map<string, string[]>();
  for (const row of snapshot.snippetTags) snippetTags.set(row.snippetId, [...(snippetTags.get(row.snippetId) ?? []), row.tagId]);
  const byTagLabel = (a: string, b: string) => {
    const x = tagLabels.get(a) ?? "", y = tagLabels.get(b) ?? "";
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  };
  return {
    availability: "ready",
    revision: snapshot.catalogRevision,
    truncated: counts.some((count) => count > MAX_CATALOG_ITEMS),
    hosts: views.value.slice(0, MAX_CATALOG_ITEMS).map(({ host, tags, config }) => ({
      id: host.id, revision: host.revision, label: host.label, address: host.address, groupId: host.groupId,
      environment: host.environment, port: port(host.port), auth: auth(host.auth),
      jumpHostId: host.jumpHostId ?? null, proxy: host.proxy ? { ...host.proxy } : null, tagIds: tags.map((tag) => tag.id),
      ancestry: config.ancestry.map((group) => ({ id: group.id, label: group.label })), effective: effective(config),
    })),
    groups: byLabel(snapshot.groups.map((group) => ({
      id: group.id, revision: group.revision, label: group.label, parentId: group.parentId, port: port(group.port),
      auth: auth(group.auth),
      inherited: group.parentId === null ? { ...rootDefaults } : effective(defaults.value.get(group.parentId)!),
    }))).slice(0, MAX_CATALOG_ITEMS),
    tags: byLabel(snapshot.tags.map((tag) => ({ id: tag.id, revision: tag.revision, label: tag.label }))).slice(0, MAX_CATALOG_ITEMS),
    identities: byLabel(snapshot.identities.map((identity) => ({
      id: identity.id, revision: identity.revision, label: identity.label, username: identity.username, method: identity.method,
      passwordSaved: identity.passwordRef !== null, keyId: identity.keyId, pending: pending.has(identity.id),
    }))).slice(0, MAX_CATALOG_ITEMS),
    keys: byLabel(keys.map((key) => ({
      id: key.id, revision: key.revision, label: key.label, algorithm: key.algorithm as CatalogKey["algorithm"],
      fingerprint: key.fingerprint, publicKey: key.publicKey, passphraseSaved: key.passphraseRef !== null, pending: pending.has(key.id),
    }))).slice(0, MAX_CATALOG_ITEMS),
    secrets: {
      availability: secretStore ? "ready" : "unavailable",
      cleanupPending: snapshot.secretOperations.some((op) => stalled(op, now)),
    },
    // Labels and memberships only: bodies, envelopes and key references stay in main.
    snippets: byLabel(snapshot.snippets.map((snippet) => ({
      id: snippet.id, revision: snippet.revision, label: snippet.label,
      tagIds: (snippetTags.get(snippet.id) ?? []).sort(byTagLabel),
    }))).slice(0, MAX_CATALOG_ITEMS),
    tunnelRules: byLabel(snapshot.tunnelRules.map((rule) => ({
      id: rule.id, revision: rule.revision, label: rule.label, hostId: rule.hostId, type: rule.type, bindAddress: rule.bindAddress,
      bindPort: rule.bindPort, destinationHost: rule.destinationHost, destinationPort: rule.destinationPort,
    }))).slice(0, MAX_CATALOG_ITEMS),
    lockEpoch,
  };
}

/** Stale targets are `conflict`; field problems the user can fix are returned as field errors. */
/** Hosts a delete removes (directly, or as a group subtree). */
function removedHosts(snapshot: MetadataSnapshot, intent: CatalogChangeIntent): string[] {
  if (intent.type === "delete-host") return [intent.id];
  if (intent.type !== "delete-group" || intent.disposition.mode !== "subtree") return [];
  const groups = new Set([intent.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const group of snapshot.groups)
      if (group.parentId && groups.has(group.parentId) && !groups.has(group.id)) { groups.add(group.id); grew = true; }
  }
  return snapshot.hosts.filter((host) => host.groupId && groups.has(host.groupId)).map((host) => host.id);
}

function check(snapshot: MetadataSnapshot, intent: CatalogChangeIntent, active: (ruleId: string) => boolean = () => false): "conflict" | CatalogFieldError[] {
  const current = (rows: { id: string; revision: number }[], id: string, revision: number) =>
    rows.some((row) => row.id === id && row.revision === revision);
  if (intent.type === "set-host-tag") {
    if (!current(snapshot.hosts, intent.hostId, intent.expectedHostRevision)) return "conflict";
    return snapshot.tags.some((tag) => tag.id === intent.tagId) ? [] : [{ field: "tag", code: "not-found" }];
  }
  if ("expectedRevision" in intent) {
    const rows = intent.type.endsWith("-host") ? snapshot.hosts : intent.type.endsWith("-group") ? snapshot.groups
      : intent.type.endsWith("-identity") ? snapshot.identities : intent.type.endsWith("-tunnel-rule") ? snapshot.tunnelRules : snapshot.tags;
    if (!current(rows, intent.id, intent.expectedRevision)) return "conflict";
  }
  const fields: CatalogFieldError[] = [];
  // A running tunnel keeps the configuration it started with; its rule (or server) changes only after an explicit stop.
  const affected = intent.type === "update-tunnel-rule" || intent.type === "delete-tunnel-rule" ? [intent.id]
    : snapshot.tunnelRules.filter((rule) => removedHosts(snapshot, intent).includes(rule.hostId)).map((rule) => rule.id);
  if (affected.some(active)) fields.push({ field: "tunnel", code: "running" });
  if (intent.type === "create-tunnel-rule" || intent.type === "update-tunnel-rule") {
    const data = intent.data;
    // The rule as it would be stored: per-type shape (bind address, assigned port, destination) is checked whole.
    const before = intent.type === "update-tunnel-rule" ? snapshot.tunnelRules.find((rule) => rule.id === intent.id) : undefined;
    const merged = {
      type: data.type ?? before?.type ?? "local", bindAddress: data.bindAddress ?? before?.bindAddress ?? "127.0.0.1",
      bindPort: data.bindPort ?? before?.bindPort ?? -1,
      destinationHost: data.destinationHost !== undefined ? data.destinationHost : before?.destinationHost ?? null,
      destinationPort: data.destinationPort !== undefined ? data.destinationPort : before?.destinationPort ?? null,
    };
    // Every problem is reported at once (the repository check, `tunnelRuleProblem`, stops at the first).
    const remote = merged.type === "remote";
    if (!remote && (merged.bindAddress === "0.0.0.0" || merged.bindAddress === "::")) fields.push({ field: "bindAddress", code: "invalid" });
    if (!validatePort(merged.bindPort) && !(remote && merged.bindPort === 0)) fields.push({ field: "bindPort", code: "invalid" });
    if (merged.type === "dynamic") {
      if (merged.destinationHost !== null || merged.destinationPort !== null) fields.push({ field: "destination", code: "invalid" });
    } else {
      if (!validatePort(merged.destinationPort)) fields.push({ field: "destinationPort", code: "invalid" });
      if (merged.destinationHost === null) fields.push({ field: "destination", code: "invalid" });
    }
    // A dynamic rule with a destination already reported "destination"; one entry per field is enough.
    if (typeof data.destinationHost === "string" && merged.type !== "dynamic") {
      if (data.destinationHost.trim().length > MAX_CATALOG_ADDRESS) fields.push({ field: "destination", code: "too-long" });
      else {
        try { normalizeEndpoint(data.destinationHost); } catch { fields.push({ field: "destination", code: "invalid" }); }
      }
    }
    if (typeof data.hostId === "string" && !snapshot.hosts.some((host) => host.id === data.hostId))
      fields.push({ field: "host", code: "not-found" });
  }
  const data: Record<string, unknown> = "data" in intent ? intent.data : {};
  if (typeof data.label === "string") {
    const code = validateCatalogLabel(data.label);
    if (code) fields.push({ field: "label", code });
    else if (intent.type === "create-tag" && snapshot.tags.some((tag) => tag.normalizedName === normalizeTag(data.label as string)))
      fields.push({ field: "label", code: "duplicate" });
  }
  if (typeof data.address === "string") {
    if (data.address.length > MAX_CATALOG_ADDRESS) fields.push({ field: "address", code: "too-long" });
    else {
      try { normalizeEndpoint(data.address); } catch { fields.push({ field: "address", code: "invalid" }); }
    }
  }
  const portValue = data.port as { mode: string; port?: unknown } | undefined;
  if (portValue?.mode === "value" && !validatePort(portValue.port)) fields.push({ field: "port", code: "invalid" });
  const authValue = data.auth as { mode: string; identityId?: string } | undefined;
  if (authValue?.mode === "value" && !snapshot.identities.some((row) => row.id === authValue.identityId))
    fields.push({ field: "identity", code: "not-found" });
  if (typeof data.username === "string") {
    const code = validateIdentityUsername(data.username);
    if (code) fields.push({ field: "username", code });
  }
  if (intent.type === "create-identity" || intent.type === "update-identity") {
    const before = intent.type === "update-identity" ? snapshot.identities.find((row) => row.id === intent.id) : undefined;
    const method = intent.data.method ?? before?.method;
    const keyId = Object.hasOwn(intent.data, "keyId") ? intent.data.keyId : before?.keyId;
    if (method === "key") {
      if (!keyId) fields.push({ field: "keyId", code: "required" });
      else if (!snapshot.keys.some((row) => row.id === keyId)) fields.push({ field: "keyId", code: "not-found" });
    }
  }
  if (intent.type === "delete-identity" && intent.disposition.mode === "reassign") {
    const target = intent.disposition.identityId;
    if (target === intent.id || !snapshot.identities.some((row) => row.id === target)) fields.push({ field: "identity", code: "not-found" });
  }
  if (typeof data.groupId === "string" && !snapshot.groups.some((row) => row.id === data.groupId))
    fields.push({ field: "group", code: "not-found" });
  if (intent.type === "create-host" || intent.type === "update-host") {
    // The host as it would be stored, checked against the catalog with the shared chain rules.
    const before = intent.type === "update-host" ? snapshot.hosts.find((row) => row.id === intent.id) : undefined;
    const id = intent.type === "update-host" ? intent.id : "00000000-0000-4000-8000-000000000000";
    const merged = {
      id,
      jumpHostId: intent.data.jumpHostId !== undefined ? intent.data.jumpHostId : before?.jumpHostId ?? null,
      proxy: intent.data.proxy !== undefined ? intent.data.proxy : before?.proxy ?? null,
    };
    const hosts = new Map(snapshot.hosts.map((row) => [row.id, row as Pick<typeof row, "id" | "jumpHostId" | "proxy">]));
    hosts.set(id, merged);
    // An upstream edit can also lengthen the route of servers that already depend on this host.
    const problem = hostChainProblem(merged, hosts) ??
      [...hosts.values()].map((host) => hostChainProblem(host, hosts)).find((issue) => issue !== null) ?? null;
    if (problem === "jump-missing") fields.push({ field: "jump", code: "not-found" });
    if (problem === "jump-self" || problem === "jump-cycle") fields.push({ field: "jump", code: "cycle" });
    if (problem === "jump-depth") fields.push({ field: "jump", code: "too-deep" });
    if (problem === "jump-and-proxy") fields.push({ field: "proxy", code: "with-jump" });
    if (problem === "proxy") fields.push({ field: "proxy", code: "invalid" });
    if (intent.data.proxy && problem !== "jump-and-proxy") {
      try { normalizeEndpoint(intent.data.proxy.host); } catch { if (problem !== "proxy") fields.push({ field: "proxy", code: "invalid" }); }
    }
  }
  // Deleting a host another host connects through would silently change that host's network path: refuse it.
  if (intent.type === "delete-host" || intent.type === "delete-group") {
    const removed = new Set(removedHosts(snapshot, intent));
    if (snapshot.hosts.some((row) => !removed.has(row.id) && row.jumpHostId && removed.has(row.jumpHostId)))
      fields.push({ field: "jump", code: "in-use" });
  }
  const parentId = intent.type === "delete-group"
    ? (intent.disposition.mode === "reparent" ? intent.disposition.parentId : null)
    : typeof data.parentId === "string" ? data.parentId : null;
  if (parentId !== null) {
    const groups = new Map(snapshot.groups.map((group) => [group.id, group]));
    if (!groups.has(parentId)) fields.push({ field: "parent", code: "not-found" });
    else if ("id" in intent) {
      // A group cannot move under itself or any of its descendants; the snapshot graph is acyclic and bounded.
      for (let at: string | null = parentId; at !== null; at = groups.get(at)?.parentId ?? null)
        if (at === intent.id) { fields.push({ field: "parent", code: "cycle" }); break; }
    }
  }
  return fields;
}

/** Owner-bound catalog projection and revision-fenced edits; one outstanding preview per owner. */
export function createCatalogController(options: {
  repository: Pick<MetadataRepository, "snapshot">;
  catalog: Pick<CatalogModule, "prepare" | "apply" | "discard">;
  /** Whether main has a working secret service; defaults to unavailable. */
  secretStore?: () => boolean;
  /** An applied change queued Keychain deletions. */
  cleanupQueued?: () => void;
  /** Test clock for `CLEANUP_STALL_MS`. */
  now?: () => number;
  /** Whether a tunnel is starting, running or stopping for this rule; such rules (and their servers) are not edited. */
  activeTunnel?: (ruleId: string) => boolean;
  /** The workspace lock counter; absent: never locked. */
  lockEpoch?: () => number;
}) {
  const registrations = new Map<string, Registration>();
  const previews = new Map<string, string>();
  // Rules a pending preview would change or delete; a tunnel started after prepare still blocks the apply.
  const previewRules = new Map<string, string[]>();
  let disposed = false;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const body = (): Body => {
    try {
      const snapshot = options.repository.snapshot();
      if (!snapshot.ok) return { ...unavailable, lockEpoch: options.lockEpoch?.() ?? 0 };
      const now = options.now?.() ?? Date.now();
      // Nothing commits when a deletion stalls, so republish once it would count as stalled.
      if (!recheck && !disposed && snapshot.value.secretOperations.some((op) => cleaning(op) && !stalled(op, now))) {
        recheck = setTimeout(() => { recheck = undefined; if (!disposed) publishAll(); }, CLEANUP_STALL_MS);
        recheck.unref?.();
      }
      return project(snapshot.value, options.secretStore?.() === true, now, options.lockEpoch?.() ?? 0);
    } catch { return { ...unavailable, lockEpoch: options.lockEpoch?.() ?? 0 }; }
  };
  const state = (registration: Registration, value: Body): Result<CatalogState> => {
    const result = { owner: { ...registration.owner }, sequence: registration.sequence, ...value };
    return isCatalogState(result) ? { ok: true, value: result } : failure("unavailable");
  };
  const publishAll = () => {
    const value = body();
    for (const registration of registrations.values()) {
      registration.sequence += 1;
      const current = state(registration, value);
      if (!current.ok) continue;
      try { registration.send(current.value); } catch { /* A closed window cannot interrupt other owners. */ }
    }
  };
  const discard = (key: string) => {
    const token = previews.get(key);
    previews.delete(key);
    previewRules.delete(key);
    if (token) options.catalog.discard(token);
  };
  const revokeOwner = (owner: Owner) => {
    const key = sessionOwnerId(owner);
    registrations.delete(key);
    discard(key);
  };
  return {
    register(owner: Owner, send: (state: CatalogState) => void): void {
      if (disposed) return;
      const existing = registrations.get(sessionOwnerId(owner));
      if (existing) { existing.send = send; return; }
      registrations.set(sessionOwnerId(owner), { owner: { ...owner }, sequence: 0, send });
    },
    catalogState(owner: Owner): Result<CatalogState> {
      const registration = registrations.get(sessionOwnerId(owner));
      return !disposed && registration ? state(registration, body()) : failure("stale-owner");
    },
    prepareCatalogChange(request: PrepareCatalogChangeRequest): Result<CatalogPrepareResponse> {
      if (!isPrepareCatalogChangeRequest(request)) return failure("invalid-request");
      const key = sessionOwnerId(request.owner);
      if (disposed || !registrations.has(key)) return failure("stale-owner");
      try {
        discard(key);
        const snapshot = options.repository.snapshot();
        if (!snapshot.ok) return failure("unavailable");
        const checked = check(snapshot.value, request.intent, options.activeTunnel);
        if (checked === "conflict") return failure("conflict");
        if (checked.length) return { ok: true, value: { kind: "invalid", fields: checked } };
        const prepared = options.catalog.prepare(structuredClone(request.intent));
        if (!prepared.ok) {
          const code = prepared.error.code;
          return failure(code === "conflict" ? "conflict" : code === "busy" ? "busy" : code === "constraint" || code === "invalid-request" ? "invalid-request" : "unavailable");
        }
        const { token, expiresAt, impacts } = prepared.value;
        const value: CatalogPrepareResponse = {
          kind: "preview", token, expiresAt,
          impacts: {
            hosts: impacts.hosts.slice(0, MAX_CATALOG_ITEMS).map((row) => ({
              hostId: row.hostId, label: (row.after ?? row.before)!.hostRef.label, removed: row.after === null,
              effectiveConnectionChanged: row.effectiveConnectionChanged, provenanceChanged: row.provenanceChanged, pathChanged: row.pathChanged,
            })),
            removedHostIds: impacts.removedHostIds.slice(0, MAX_CATALOG_ITEMS),
            removedGroupIds: impacts.removedGroupIds.slice(0, MAX_CATALOG_ITEMS),
            removedTunnelRules: impacts.removedTunnelRuleIds.length,
            removedHostTags: impacts.removedHostTags.length,
            removedSnippetTags: impacts.removedSnippetTags.length,
            identity: request.intent.type === "update-identity" || request.intent.type === "delete-identity" ? {
              directHostIds: impacts.directIdentityHostIds.slice(0, MAX_CATALOG_ITEMS),
              directGroupIds: impacts.directIdentityGroupIds.slice(0, MAX_CATALOG_ITEMS),
              effectiveHostIds: impacts.effectiveIdentityHostIds.slice(0, MAX_CATALOG_ITEMS),
              removesSavedPassword: impacts.cleanupRefIds.length > 0,
            } : null,
          },
        };
        if (!isCatalogPrepareResponse(value)) {
          options.catalog.discard(token);
          return failure("unavailable");
        }
        previews.set(key, token);
        const intent = request.intent;
        previewRules.set(key, intent.type === "update-tunnel-rule" || intent.type === "delete-tunnel-rule" ? [intent.id]
          : snapshot.value.tunnelRules.filter((rule) => removedHosts(snapshot.value, intent).includes(rule.hostId)).map((rule) => rule.id));
        return { ok: true, value };
      } catch { return failure("unavailable"); }
    },
    applyCatalogChange(request: ApplyCatalogChangeRequest): Result<CatalogApplyResponse> {
      if (!isApplyCatalogChangeRequest(request)) return failure("invalid-request");
      const key = sessionOwnerId(request.owner);
      if (disposed || !registrations.has(key)) return failure("stale-owner");
      // Another owner's or a superseded token is indistinguishable from an expired one.
      if (previews.get(key) !== request.token) return failure("conflict");
      previews.delete(key);
      const rules = previewRules.get(key) ?? [];
      previewRules.delete(key);
      if (rules.some((rule) => options.activeTunnel?.(rule))) {
        options.catalog.discard(request.token);
        return failure("conflict");
      }
      try {
        const applied = options.catalog.apply(request.token);
        if (!applied.ok)
          // The module consumes the plan on every attempt, so each refusal needs a fresh preview.
          return failure(["conflict", "invalid-request", "constraint", "busy"].includes(applied.error.code) ? "conflict" : "unavailable");
        publishAll();
        if (applied.value.pendingSecretCleanupOperationIds.length) {
          try { options.cleanupQueued?.(); } catch { /* Startup and retry reconcile again. */ }
        }
        return { ok: true, value: { revision: applied.value.catalogRevision, createdIds: [...applied.value.createdIds] } };
      } catch { return failure("unavailable"); }
    },
    /** Pushes the current projection to every registered owner. */
    publishAll(): void { if (!disposed) publishAll(); },
    revokeOwner,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(recheck);
      for (const registration of [...registrations.values()]) revokeOwner(registration.owner);
    },
  };
}
export type CatalogController = ReturnType<typeof createCatalogController>;

/** Every successful commit, from any writer, schedules one coalesced `changed` call on a later turn. */
export function observeCommits(repository: MetadataRepository, changed: () => void): MetadataRepository {
  let scheduled = false;
  return {
    snapshot: () => repository.snapshot(),
    commit(request) {
      const result = repository.commit(request);
      if (result.ok && !scheduled) {
        scheduled = true;
        setImmediate(() => {
          scheduled = false;
          try { changed(); } catch { /* An observer cannot fail a committed write. */ }
        });
      }
      return result;
    },
    backup: (request) => repository.backup(request),
    close: () => repository.close(),
  };
}

/** Every IPC channel `registerCatalogHandlers` owns. */
export const catalogChannels = Object.freeze([channels.catalogState, channels.prepareCatalogChange, channels.applyCatalogChange]);

export function registerCatalogHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => CatalogController | undefined;
}): () => void {
  const handle = <T>(channel: string, validate: (value: unknown) => value is T, run: (controller: CatalogController, request: T) => unknown) => {
    options.ipc.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        controller.register(authorized.value, (state) => {
          if (!event.sender.isDestroyed()) event.sender.send(channels.catalogStateChanged, state);
        });
        return run(controller, request);
      } catch { return failure("unavailable"); }
    });
  };
  handle(channels.catalogState, isCatalogStateRequest, (controller, request) => controller.catalogState(request.owner));
  handle(channels.prepareCatalogChange, isPrepareCatalogChangeRequest, (controller, request) => controller.prepareCatalogChange(request));
  handle(channels.applyCatalogChange, isApplyCatalogChangeRequest, (controller, request) => controller.applyCatalogChange(request));
  return () => { for (const channel of catalogChannels) options.ipc.removeHandler(channel); };
}
