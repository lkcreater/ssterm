import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  channels, failure, isApplyCatalogChangeRequest, isCatalogPrepareResponse, isCatalogState, isCatalogStateRequest,
  isPrepareCatalogChangeRequest, validateCatalogLabel, validatePort, MAX_CATALOG_ADDRESS, MAX_CATALOG_ITEMS,
  type ApplyCatalogChangeRequest, type CatalogApplyResponse, type CatalogChangeIntent, type CatalogEffective,
  type CatalogFieldError, type CatalogPrepareResponse, type CatalogSource, type CatalogState, type Owner,
  type PrepareCatalogChangeRequest, type Result,
} from "@ssterm/contracts";
import {
  normalizeEndpoint, normalizeTag, queryCatalogHosts, resolveGroupDefaults,
  type ConfigSource, type GroupDefaults, type MetadataRepository, type MetadataSnapshot,
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
const unavailable: Body = { availability: "unavailable", revision: 0, truncated: false, hosts: [], groups: [], tags: [], identities: [] };
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

/** Builds the renderer projection. Only the fields named here cross IPC; secret references never do. */
function project(snapshot: MetadataSnapshot): Body {
  const views = queryCatalogHosts(snapshot, { scope: { kind: "all" } });
  const defaults = resolveGroupDefaults(snapshot);
  if (!views.ok || !defaults.ok) return unavailable;
  const counts = [views.value.length, snapshot.groups.length, snapshot.tags.length, snapshot.identities.length];
  return {
    availability: "ready",
    revision: snapshot.catalogRevision,
    truncated: counts.some((count) => count > MAX_CATALOG_ITEMS),
    hosts: views.value.slice(0, MAX_CATALOG_ITEMS).map(({ host, tags, config }) => ({
      id: host.id, revision: host.revision, label: host.label, address: host.address, groupId: host.groupId,
      environment: host.environment, port: port(host.port), auth: auth(host.auth), tagIds: tags.map((tag) => tag.id),
      ancestry: config.ancestry.map((group) => ({ id: group.id, label: group.label })), effective: effective(config),
    })),
    groups: byLabel(snapshot.groups.map((group) => ({
      id: group.id, revision: group.revision, label: group.label, parentId: group.parentId, port: port(group.port),
      auth: auth(group.auth),
      inherited: group.parentId === null ? { ...rootDefaults } : effective(defaults.value.get(group.parentId)!),
    }))).slice(0, MAX_CATALOG_ITEMS),
    tags: byLabel(snapshot.tags.map((tag) => ({ id: tag.id, revision: tag.revision, label: tag.label }))).slice(0, MAX_CATALOG_ITEMS),
    identities: byLabel(snapshot.identities.map((identity) => ({
      id: identity.id, label: identity.label, username: identity.username, method: identity.method,
    }))).slice(0, MAX_CATALOG_ITEMS),
  };
}

/** Stale targets are `conflict`; field problems the user can fix are returned as field errors. */
function check(snapshot: MetadataSnapshot, intent: CatalogChangeIntent): "conflict" | CatalogFieldError[] {
  const current = (rows: { id: string; revision: number }[], id: string, revision: number) =>
    rows.some((row) => row.id === id && row.revision === revision);
  if (intent.type === "set-host-tag") {
    if (!current(snapshot.hosts, intent.hostId, intent.expectedHostRevision)) return "conflict";
    return snapshot.tags.some((tag) => tag.id === intent.tagId) ? [] : [{ field: "tag", code: "not-found" }];
  }
  if ("expectedRevision" in intent) {
    const rows = intent.type.endsWith("-host") ? snapshot.hosts : intent.type.endsWith("-group") ? snapshot.groups : snapshot.tags;
    if (!current(rows, intent.id, intent.expectedRevision)) return "conflict";
  }
  const fields: CatalogFieldError[] = [];
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
  if (typeof data.groupId === "string" && !snapshot.groups.some((row) => row.id === data.groupId))
    fields.push({ field: "group", code: "not-found" });
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
}) {
  const registrations = new Map<string, Registration>();
  const previews = new Map<string, string>();
  let disposed = false;
  const body = (): Body => {
    try {
      const snapshot = options.repository.snapshot();
      return snapshot.ok ? project(snapshot.value) : unavailable;
    } catch { return unavailable; }
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
        const checked = check(snapshot.value, request.intent);
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
          },
        };
        if (!isCatalogPrepareResponse(value)) {
          options.catalog.discard(token);
          return failure("unavailable");
        }
        previews.set(key, token);
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
      try {
        const applied = options.catalog.apply(request.token);
        if (!applied.ok)
          // The module consumes the plan on every attempt, so each refusal needs a fresh preview.
          return failure(["conflict", "invalid-request", "constraint", "busy"].includes(applied.error.code) ? "conflict" : "unavailable");
        publishAll();
        return { ok: true, value: { revision: applied.value.catalogRevision, createdIds: [...applied.value.createdIds] } };
      } catch { return failure("unavailable"); }
    },
    revokeOwner,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const registration of [...registrations.values()]) revokeOwner(registration.owner);
    },
  };
}
export type CatalogController = ReturnType<typeof createCatalogController>;

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
