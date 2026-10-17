import { randomUUID } from "node:crypto";
import { previewMetadataChanges } from "@ssterm/adapters";
import {
  resolveHostConfig,
  resolveHostConfigs,
  queryCatalogHosts,
  type CatalogHostQuery,
  type ResolvedHostConfig,
  type Entity,
  type GroupInput,
  type HostInput,
  type Id,
  type Identity,
  type MetadataChange,
  type MetadataRepository,
  type MetadataSnapshot,
  type StoreResult,
  type TagInput,
  type TunnelRuleInput,
} from "@ssterm/domain";

type IdentityData = Pick<Identity, "label" | "username" | "method"> &
  Partial<Pick<Identity, "keyId">>;
type IntentCrud<K extends string, T> =
  | { type: `create-${K}`; data: T }
  | { type: `update-${K}`; id: Id; expectedRevision: number; data: Partial<T> };
export type CatalogIntent =
  | IntentCrud<"host", HostInput>
  | IntentCrud<"group", GroupInput>
  | IntentCrud<"tag", TagInput>
  | IntentCrud<"tunnel-rule", TunnelRuleInput>
  | { type: "delete-tunnel-rule"; id: Id; expectedRevision: number }
  | { type: "create-identity"; data: IdentityData }
  | {
      type: "update-identity";
      id: Id;
      expectedRevision: number;
      data: Partial<IdentityData>;
      forgetPassword?: boolean;
    }
  | { type: "delete-host" | "delete-tag"; id: Id; expectedRevision: number }
  | {
      type: "delete-group";
      id: Id;
      expectedRevision: number;
      disposition:
        | { mode: "reparent"; parentId: Id | null }
        | { mode: "subtree" };
    }
  | {
      type: "delete-identity";
      id: Id;
      expectedRevision: number;
      disposition: { mode: "detach" } | { mode: "reassign"; identityId: Id };
    }
  | {
      type: "set-host-tag";
      hostId: Id;
      tagId: Id;
      present: boolean;
      expectedHostRevision: number;
    };
export interface CatalogHostImpact {
  hostId: Id;
  before: ResolvedHostConfig | null;
  after: ResolvedHostConfig | null;
  effectiveConnectionChanged: boolean;
  provenanceChanged: boolean;
  pathChanged: boolean;
}
export interface CatalogImpacts {
  hosts: CatalogHostImpact[];
  directIdentityHostIds: Id[];
  directIdentityGroupIds: Id[];
  effectiveIdentityHostIds: Id[];
  removedHostIds: Id[];
  removedGroupIds: Id[];
  removedTunnelRuleIds: Id[];
  removedHostTags: { hostId: Id; tagId: Id }[];
  removedSnippetTags: { snippetId: Id; tagId: Id }[];
  cleanupRefIds: Id[];
}
export interface CatalogPreview {
  token: string;
  catalogRevision: number;
  expiresAt: number;
  createdIds: Id[];
  impacts: CatalogImpacts;
}
export interface CatalogApplied {
  catalogRevision: number;
  createdIds: Id[];
  pendingSecretCleanupOperationIds: Id[];
}
interface Plan {
  catalogRevision: number;
  expiresAt: number;
  createdIds: Id[];
  changes: MetadataChange[];
}
const messages = {
  "invalid-request": "The catalog request is invalid.",
  conflict: "Metadata changed; prepare the change again.",
  constraint: "The change violates catalog relationships.",
  busy: "The catalog is busy; retry the operation.",
};
class CatalogFault {
  constructor(readonly code: keyof typeof messages) {}
}
const fail = (code: keyof typeof messages): never => {
  throw new CatalogFault(code);
};
const ok = <T>(value: T): StoreResult<T> => ({ ok: true, value });
const errorResult = <T>(error: unknown): StoreResult<T> => {
  const code = error instanceof CatalogFault ? error.code : "invalid-request";
  return { ok: false, error: { code, message: messages[code] } };
};
function record(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail("invalid-request");
}
const validId = (value: unknown): value is Id =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
const id = (value: unknown): void => {
  if (!validId(value)) fail("invalid-request");
};
const revision = (value: unknown): void => {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail("invalid-request");
};
const fields = {
  host: ["label", "address", "groupId", "environment", "port", "auth"],
  group: ["label", "parentId", "port", "auth"],
  identity: ["label", "username", "method", "keyId"],
  tag: ["label"],
  "tunnel-rule": ["label", "hostId", "type", "bindAddress", "bindPort", "destinationHost", "destinationPort"],
} as const;
function intent(value: unknown): CatalogIntent {
  record(
    value,
    [
      "type",
      "id",
      "data",
      "expectedRevision",
      "disposition",
      "forgetPassword",
      "hostId",
      "tagId",
      "present",
      "expectedHostRevision",
    ],
    ["type"],
  );
  if (value.type === "set-host-tag") {
    record(
      value,
      ["type", "hostId", "tagId", "present", "expectedHostRevision"],
      ["hostId", "tagId", "present", "expectedHostRevision"],
    );
    id(value.hostId);
    id(value.tagId);
    revision(value.expectedHostRevision);
    if (typeof value.present !== "boolean") fail("invalid-request");
  } else {
    const match =
      typeof value.type === "string" &&
      /^(create|update|delete)-(host|group|identity|tag|tunnel-rule)$/u.exec(value.type);
    if (!match) return fail("invalid-request");
    const action = match[1]!;
    const kind = match[2] as keyof typeof fields;
    const allowed =
      action === "create"
        ? ["type", "data"]
        : action === "update"
          ? [
              "type",
              "id",
              "expectedRevision",
              "data",
              ...(kind === "identity" ? ["forgetPassword"] : []),
            ]
          : [
              "type",
              "id",
              "expectedRevision",
              ...(["group", "identity"].includes(kind) ? ["disposition"] : []),
            ];
    record(
      value,
      allowed,
      allowed.filter((key) => key !== "forgetPassword"),
    );
    if (action !== "create") {
      id(value.id);
      revision(value.expectedRevision);
    }
    if (action !== "delete") {
      record(value.data, fields[kind]);
      if (
        value.forgetPassword !== undefined &&
        typeof value.forgetPassword !== "boolean"
      )
        fail("invalid-request");
    } else if (kind === "group") {
      record(value.disposition, ["mode", "parentId"], ["mode"]);
      if (value.disposition.mode === "reparent") {
        record(value.disposition, ["mode", "parentId"], ["parentId"]);
        if (value.disposition.parentId !== null) id(value.disposition.parentId);
      } else if (value.disposition.mode === "subtree")
        record(value.disposition, ["mode"]);
      else fail("invalid-request");
    } else if (kind === "identity") {
      record(value.disposition, ["mode", "identityId"], ["mode"]);
      if (value.disposition.mode === "reassign") {
        record(value.disposition, ["mode", "identityId"], ["identityId"]);
        id(value.disposition.identityId);
      } else if (value.disposition.mode === "detach")
        record(value.disposition, ["mode"]);
      else fail("invalid-request");
    }
  }
  return structuredClone(value) as unknown as CatalogIntent;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const source = (value: ResolvedHostConfig["port"]["source"]) =>
  value.kind === "default" ? value : { kind: value.kind, id: value.id };
function connection(config: ResolvedHostConfig | null): unknown {
  if (!config) return null;
  const identity = config.auth.identity;
  const key = config.auth.key;
  return {
    address: config.address,
    port: config.port.value,
    auth: {
      selection: config.auth.selection,
      identity: identity && {
        id: identity.id,
        revision: identity.revision,
        username: identity.username,
        method: identity.method,
        passwordRef: identity.passwordRef,
        keyId: identity.keyId,
      },
      key: key && {
        id: key.id,
        revision: key.revision,
        privateKeyRef: key.privateKeyRef,
        passphraseRef: key.passphraseRef,
        algorithm: key.algorithm,
        publicKey: key.publicKey,
        fingerprint: key.fingerprint,
      },
    },
  };
}
function provenance(config: ResolvedHostConfig | null): unknown {
  return (
    config && {
      port: source(config.port.source),
      auth: source(config.auth.source),
    }
  );
}
function path(config: ResolvedHostConfig | null): unknown {
  return (
    config && config.ancestry.map((row) => ({ id: row.id, label: row.label }))
  );
}
function resolvedAll(
  snapshot: MetadataSnapshot,
): ReadonlyMap<Id, ResolvedHostConfig> {
  const result = resolveHostConfigs(snapshot);
  if (!result.ok) return fail("constraint");
  return result.value;
}
function groupBy<T>(rows: readonly T[], key: (row: T) => Id): Map<Id, T[]> {
  const map = new Map<Id, T[]>();
  for (const row of rows) {
    const list = map.get(key(row));
    if (list) list.push(row);
    else map.set(key(row), [row]);
  }
  return map;
}
function descendants(snapshot: MetadataSnapshot, groupId: Id): Set<Id> {
  const ids = new Set([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of snapshot.groups)
      if (group.parentId && ids.has(group.parentId) && !ids.has(group.id)) {
        ids.add(group.id);
        changed = true;
      }
  }
  return ids;
}
function impacts(
  before: MetadataSnapshot,
  after: MetadataSnapshot,
  request: CatalogIntent,
  cleanupRefIds: Id[],
): CatalogImpacts {
  const identityId =
    "id" in request && request.type.endsWith("-identity") ? request.id : null;
  const groupIds =
    "id" in request && request.type.endsWith("-group")
      ? descendants(before, request.id)
      : new Set<Id>();
  const candidates = new Set(
    [...before.hosts, ...after.hosts]
      .filter((host) => groupIds.has(host.groupId ?? ""))
      .map((host) => host.id),
  );
  if ("id" in request && request.type.endsWith("-tag"))
    for (const row of before.hostTags)
      if (row.tagId === request.id) candidates.add(row.hostId);
  const hosts: CatalogHostImpact[] = [];
  const effectiveIdentityHostIds: Id[] = [];
  const beforeConfigs = resolvedAll(before);
  const afterConfigs = resolvedAll(after);
  const beforeHosts = new Map(before.hosts.map((row) => [row.id, row]));
  const afterHosts = new Map(after.hosts.map((row) => [row.id, row]));
  const beforeTags = groupBy(before.hostTags, (row) => row.hostId);
  const afterTags = groupBy(after.hostTags, (row) => row.hostId);
  for (const hostId of new Set([...beforeHosts.keys(), ...afterHosts.keys()])) {
    const previous = beforeConfigs.get(hostId) ?? null;
    const next = afterConfigs.get(hostId) ?? null;
    if (identityId && previous?.auth.identity?.id === identityId)
      effectiveIdentityHostIds.push(hostId);
    const effectiveConnectionChanged = !same(
      connection(previous),
      connection(next),
    );
    const provenanceChanged = !same(provenance(previous), provenance(next));
    const pathChanged = !same(path(previous), path(next));
    if (
      candidates.has(hostId) ||
      effectiveConnectionChanged ||
      provenanceChanged ||
      pathChanged ||
      !same(beforeHosts.get(hostId), afterHosts.get(hostId)) ||
      !same(beforeTags.get(hostId) ?? [], afterTags.get(hostId) ?? [])
    )
      hosts.push({
        hostId,
        before: previous,
        after: next,
        effectiveConnectionChanged,
        provenanceChanged,
        pathChanged,
      });
  }
  const removed = <T extends { id: Id }>(old: T[], next: T[]) => {
    const kept = new Set(next.map((row) => row.id));
    return old.filter((row) => !kept.has(row.id)).map((row) => row.id);
  };
  const pairs = <T>(rows: T[], key: (row: T) => string) => {
    const kept = new Set(rows.map(key));
    return (row: T) => !kept.has(key(row));
  };
  const hostTagKey = (row: { hostId: Id; tagId: Id }) => `${row.hostId}/${row.tagId}`;
  const snippetTagKey = (row: { snippetId: Id; tagId: Id }) =>
    `${row.snippetId}/${row.tagId}`;
  return {
    hosts,
    directIdentityHostIds: before.hosts
      .filter(
        (row) =>
          identityId &&
          row.auth.mode === "value" &&
          row.auth.identityId === identityId,
      )
      .map((row) => row.id),
    directIdentityGroupIds: before.groups
      .filter(
        (row) =>
          identityId &&
          row.auth.mode === "value" &&
          row.auth.identityId === identityId,
      )
      .map((row) => row.id),
    effectiveIdentityHostIds,
    removedHostIds: removed(before.hosts, after.hosts),
    removedGroupIds: removed(before.groups, after.groups),
    removedTunnelRuleIds: removed(before.tunnelRules, after.tunnelRules),
    removedHostTags: before.hostTags
      .filter(pairs(after.hostTags, hostTagKey))
      .map(({ hostId, tagId }) => ({ hostId, tagId })),
    removedSnippetTags: before.snippetTags
      .filter(pairs(after.snippetTags, snippetTagKey))
      .map(({ snippetId, tagId }) => ({ snippetId, tagId })),
    cleanupRefIds,
  };
}

/** Main-only catalog edits: bounded immutable previews, one revision-checked SQL commit, no OS secret access. */
export class CatalogModule {
  readonly #plans = new Map<string, Plan>();
  readonly #now: () => number;
  readonly #createId: () => Id;
  constructor(
    private readonly options: {
      repository: MetadataRepository;
      now?: () => number;
      createId?: () => Id;
    },
  ) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
  }
  query(query: CatalogHostQuery) {
    const result = this.options.repository.snapshot();
    return result.ok ? queryCatalogHosts(result.value, query) : result;
  }
  resolve(hostId: Id) {
    const result = this.options.repository.snapshot();
    return result.ok ? resolveHostConfig(result.value, hostId) : result;
  }
  prepare(input: CatalogIntent): StoreResult<CatalogPreview> {
    try {
      const request = intent(input);
      const now = this.#now();
      for (const [token, plan] of this.#plans)
        if (plan.expiresAt <= now) this.#plans.delete(token);
      if (this.#plans.size >= 64) fail("busy");
      const snapshot = this.options.repository.snapshot();
      if (!snapshot.ok) return snapshot;
      const before = snapshot.value;
      const changes: MetadataChange[] = [];
      const createdIds: Id[] = [];
      const cleanupRefIds: Id[] = [];
      const newId = () => {
        const value = this.#createId();
        id(value);
        return value;
      };
      const current = <T extends Entity>(
        rows: T[],
        rowId: Id,
        expectedRevision: number,
      ): T => {
        const row = rows.find((row) => row.id === rowId);
        if (!row || row.revision !== expectedRevision) return fail("conflict");
        return row;
      };
      const cleanup = (ref: Id | null) => {
        if (ref) {
          cleanupRefIds.push(ref);
          changes.push({
            type: "queue-secret-cleanup",
            operationId: newId(),
            ref,
          });
        }
      };
      const tagsByHost = groupBy(before.hostTags, (row) => row.hostId);
      const rulesByHost = groupBy(before.tunnelRules, (row) => row.hostId);
      const deleteHost = (host: MetadataSnapshot["hosts"][number]) => {
        for (const membership of tagsByHost.get(host.id) ?? [])
          changes.push({
            type: "set-host-tag",
            hostId: host.id,
            tagId: membership.tagId,
            present: false,
            expectedHostRevision: host.revision,
          });
        for (const rule of rulesByHost.get(host.id) ?? [])
          changes.push({
            type: "delete-tunnel-rule",
            id: rule.id,
            expectedRevision: rule.revision,
          });
        changes.push({
          type: "delete-host",
          id: host.id,
          expectedRevision: host.revision,
        });
      };
      if (request.type === "set-host-tag") changes.push(request);
      else if (
        request.type === "create-host" ||
        request.type === "create-group" ||
        request.type === "create-tag" ||
        request.type === "create-identity" ||
        request.type === "create-tunnel-rule"
      ) {
        const generated = newId();
        createdIds.push(generated);
        changes.push({ ...request, id: generated } as MetadataChange);
      } else if (
        request.type === "update-host" ||
        request.type === "update-group" ||
        request.type === "update-tag" ||
        request.type === "update-tunnel-rule"
      )
        changes.push(request);
      else if (request.type === "delete-tunnel-rule") {
        current(before.tunnelRules, request.id, request.expectedRevision);
        changes.push(request);
      }
      else if (request.type === "delete-host")
        deleteHost(current(before.hosts, request.id, request.expectedRevision));
      else if (request.type === "delete-group") {
        const group = current(
          before.groups,
          request.id,
          request.expectedRevision,
        );
        const subtree = descendants(before, group.id);
        if (request.disposition.mode === "reparent") {
          const parentId = request.disposition.parentId;
          if (
            parentId !== null &&
            (subtree.has(parentId) ||
              !before.groups.some((row) => row.id === parentId))
          )
            fail("constraint");
          for (const row of before.groups.filter(
            (row) => row.parentId === group.id,
          ))
            changes.push({
              type: "update-group",
              id: row.id,
              expectedRevision: row.revision,
              data: { parentId },
            });
          for (const row of before.hosts.filter(
            (row) => row.groupId === group.id,
          ))
            changes.push({
              type: "update-host",
              id: row.id,
              expectedRevision: row.revision,
              data: { groupId: parentId },
            });
          changes.push({
            type: "delete-group",
            id: group.id,
            expectedRevision: group.revision,
          });
        } else {
          for (const row of before.hosts.filter(
            (row) => row.groupId && subtree.has(row.groupId),
          ))
            deleteHost(row);
          for (const row of before.groups.filter((row) => subtree.has(row.id)))
            changes.push({
              type: "delete-group",
              id: row.id,
              expectedRevision: row.revision,
            });
        }
      } else if (request.type === "delete-tag") {
        current(before.tags, request.id, request.expectedRevision);
        const hostRevisions = new Map(
          before.hosts.map((host) => [host.id, host.revision]),
        );
        const snippetRevisions = new Map(
          before.snippets.map((snippet) => [snippet.id, snippet.revision]),
        );
        for (const row of before.hostTags.filter(
          (row) => row.tagId === request.id,
        ))
          changes.push({
            type: "set-host-tag",
            hostId: row.hostId,
            tagId: row.tagId,
            present: false,
            expectedHostRevision: hostRevisions.get(row.hostId)!,
          });
        for (const row of before.snippetTags.filter(
          (row) => row.tagId === request.id,
        ))
          changes.push({
            type: "set-snippet-tag",
            snippetId: row.snippetId,
            tagId: row.tagId,
            present: false,
            expectedSnippetRevision: snippetRevisions.get(row.snippetId)!,
          });
        changes.push(request);
      } else if (
        request.type === "update-identity" ||
        request.type === "delete-identity"
      ) {
        const identity = current(
          before.identities,
          request.id,
          request.expectedRevision,
        );
        if (
          before.secretOperations.some(
            (op) =>
              op.ownerType === "identity" &&
              op.ownerId === identity.id &&
              op.action !== "delete" &&
              ["staged", "reconcile", "needs-input"].includes(op.state),
          )
        )
          fail("busy");
        if (request.type === "delete-identity") {
          if (
            request.disposition.mode === "reassign" &&
            (request.disposition.identityId === identity.id ||
              !before.identities.some(
                (row) =>
                  request.disposition.mode === "reassign" &&
                  row.id === request.disposition.identityId,
              ))
          )
            fail("constraint");
          const auth =
            request.disposition.mode === "detach"
              ? { mode: "clear" as const }
              : {
                  mode: "value" as const,
                  identityId: request.disposition.identityId,
                };
          for (const row of before.hosts)
            if (
              row.auth.mode === "value" &&
              row.auth.identityId === identity.id
            )
              changes.push({
                type: "update-host",
                id: row.id,
                expectedRevision: row.revision,
                data: { auth },
              });
          for (const row of before.groups)
            if (
              row.auth.mode === "value" &&
              row.auth.identityId === identity.id
            )
              changes.push({
                type: "update-group",
                id: row.id,
                expectedRevision: row.revision,
                data: { auth },
              });
          changes.push({
            type: "delete-identity",
            id: identity.id,
            expectedRevision: identity.revision,
          });
          cleanup(identity.passwordRef);
        } else {
          const method = request.data.method ?? identity.method;
          if (Object.hasOwn(request.data, "keyId")) {
            if (request.data.keyId !== null) id(request.data.keyId);
            if (method !== "key" && request.data.keyId !== null)
              fail("constraint");
          }
          const forget =
            request.forgetPassword === true || method !== "password";
          changes.push({
            type: "update-identity",
            id: identity.id,
            expectedRevision: identity.revision,
            data: {
              ...request.data,
              ...(forget ? { passwordRef: null } : {}),
              ...(method !== "key" ? { keyId: null } : {}),
            },
          });
          if (forget) cleanup(identity.passwordRef);
        }
      }
      const projected = previewMetadataChanges(before, changes);
      if (!projected.ok) return projected;
      const token = randomUUID();
      const expiresAt = now + 5 * 60_000;
      const preview = structuredClone({
        token,
        catalogRevision: before.catalogRevision,
        expiresAt,
        createdIds,
        impacts: impacts(before, projected.value, request, cleanupRefIds),
      });
      this.#plans.set(token, {
        catalogRevision: before.catalogRevision,
        expiresAt,
        createdIds: [...createdIds],
        changes: structuredClone(changes),
      });
      return ok(preview);
    } catch (error) {
      return errorResult(error);
    }
  }
  /** Drops an unapplied preview; unknown tokens are ignored. */
  discard(token: string): void {
    this.#plans.delete(token);
  }
  apply(token: string): StoreResult<CatalogApplied> {
    if (typeof token !== "string")
      return errorResult(new CatalogFault("invalid-request"));
    const plan = this.#plans.get(token);
    this.#plans.delete(token);
    if (!plan || plan.expiresAt <= this.#now())
      return errorResult(new CatalogFault("invalid-request"));
    const result = this.options.repository.commit({
      expectedCatalogRevision: plan.catalogRevision,
      changes: structuredClone(plan.changes),
    });
    if (!result.ok) return result;
    return ok({
      catalogRevision: result.value.catalogRevision,
      createdIds: [...plan.createdIds],
      pendingSecretCleanupOperationIds: plan.changes
        .filter((change) => change.type === "queue-secret-cleanup")
        .map((change) => change.operationId),
    });
  }
}
