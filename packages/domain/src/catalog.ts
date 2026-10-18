import type {
  AuthOverride,
  Entity,
  Group,
  Host,
  HostProxy,
  Id,
  Identity,
  KeyMetadata,
  MetadataSnapshot,
  PortOverride,
  SecretRef,
  StoreResult,
  Tag,
} from "./index.ts";
import { hostChainProblem } from "./index.ts";

export type ConfigSource =
  | { kind: "default" }
  | { kind: "host" | "group"; id: Id; revision: number };
export interface ResolvedHostConfig {
  hostRef: { id: Id; revision: number; label: string; groupId: Id | null };
  address: string;
  environment: Host["environment"];
  port: { value: number; source: ConfigSource };
  auth: {
    selection: "identity" | "clear" | "none";
    identity: Readonly<Identity> | null;
    key: Readonly<KeyMetadata> | null;
    source: ConfigSource;
  };
  ancestry: readonly { id: Id; revision: number; label: string }[];
  catalogRevision: number;
  /**
   * SST-030: jump hosts to pass through, outermost first; each is resolved on its own (address, port, identity) and
   * has no `jumps` of its own. Absent for a direct connection (so direct configurations are unchanged).
   */
  jumps?: readonly ResolvedHostConfig[];
  /** The proxy used for the outermost hop (the first jump host, or this host when direct); absent when none. */
  proxy?: Readonly<HostProxy>;
}
export interface CatalogHostView {
  host: Readonly<Host>;
  tags: readonly Readonly<Tag>[];
  config: ResolvedHostConfig;
}
export interface CatalogGroupNode {
  group: Readonly<Group>;
  children: readonly CatalogGroupNode[];
}
export interface CatalogHostQuery {
  scope:
    | { kind: "all" }
    | { kind: "ungrouped" }
    | { kind: "group"; groupId: Id; includeDescendants: boolean };
  search?: string;
  tagIds?: Id[];
}

type FailureCode = "constraint" | "invalid-request";
class CatalogFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}
function requireValue(
  condition: unknown,
  code: FailureCode = "constraint",
): asserts condition {
  if (!condition) throw new CatalogFailure(code);
}
function result<T>(read: () => T): StoreResult<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    const code = error instanceof CatalogFailure ? error.code : "constraint";
    return {
      ok: false,
      error: {
        code,
        message:
          code === "invalid-request"
            ? "Invalid catalog request."
            : "Catalog metadata is inconsistent.",
      },
    };
  }
}
const isId = (value: unknown): value is Id =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value,
  );
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  Object.getPrototypeOf(value) === Object.prototype;
const validText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const normalized = (value: string): string =>
  value.trim().normalize("NFC").toLowerCase();
const compareText = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;
const compareLabel = (
  a: { label: string; id: Id },
  b: { label: string; id: Id },
): number =>
  compareText(normalized(a.label), normalized(b.label)) ||
  compareText(a.id, b.id);
function exact(
  value: unknown,
  fields: string[],
  required = fields,
): asserts value is Record<string, unknown> {
  requireValue(
    isRecord(value) &&
      Object.keys(value).every((key) => fields.includes(key)) &&
      required.every((key) => Object.hasOwn(value, key)),
    "invalid-request",
  );
}
function portValid(value: PortOverride): boolean {
  return (
    isRecord(value) &&
    ((value.mode === "inherit" && Object.keys(value).length === 1) ||
      (value.mode === "value" &&
        Object.keys(value).length === 2 &&
        Number.isInteger(value.port) &&
        value.port >= 1 &&
        value.port <= 65535))
  );
}
function authValid(value: AuthOverride): boolean {
  return (
    isRecord(value) &&
    (((value.mode === "inherit" || value.mode === "clear") &&
      Object.keys(value).length === 1) ||
      (value.mode === "value" &&
        Object.keys(value).length === 2 &&
        isId(value.identityId)))
  );
}
function copyEntity(value: Entity): Entity {
  return {
    id: value.id,
    vaultId: value.vaultId,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
function copyPort(value: PortOverride): PortOverride {
  return value.mode === "value"
    ? { mode: "value", port: value.port }
    : { mode: "inherit" };
}
function copyAuth(value: AuthOverride): AuthOverride {
  return value.mode === "value"
    ? { mode: "value", identityId: value.identityId }
    : { mode: value.mode };
}
function copyHost(value: Host): Host {
  return {
    ...copyEntity(value),
    label: value.label,
    address: value.address,
    groupId: value.groupId,
    environment: value.environment,
    port: copyPort(value.port),
    auth: copyAuth(value.auth),
    jumpHostId: value.jumpHostId ?? null,
    proxy: value.proxy ? { type: value.proxy.type, host: value.proxy.host, port: value.proxy.port } : null,
  };
}
function copyGroup(value: Group): Group {
  return {
    ...copyEntity(value),
    label: value.label,
    parentId: value.parentId,
    port: copyPort(value.port),
    auth: copyAuth(value.auth),
  };
}
function copyIdentity(value: Identity): Identity {
  return {
    ...copyEntity(value),
    label: value.label,
    username: value.username,
    method: value.method,
    passwordRef: value.passwordRef,
    keyId: value.keyId,
  };
}
function copyKey(value: KeyMetadata): KeyMetadata {
  return {
    ...copyEntity(value),
    label: value.label,
    algorithm: value.algorithm,
    publicKey: value.publicKey,
    fingerprint: value.fingerprint,
    privateKeyRef: value.privateKeyRef,
    passphraseRef: value.passphraseRef,
  };
}
function copyTag(value: Tag): Tag {
  return {
    ...copyEntity(value),
    label: value.label,
    normalizedName: value.normalizedName,
  };
}
/** Iterative traversal also supports deeply nested group trees without a call-stack limit. */
function freeze<T>(value: T): T {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const child of Object.values(item)) pending.push(child);
    Object.freeze(item);
  }
  return value;
}

/** Index only catalog metadata and opaque descriptors; never visits protected snippet bodies. */
function catalog(snapshot: MetadataSnapshot) {
  requireValue(
    isRecord(snapshot) &&
      isRecord(snapshot.vault) &&
      isId(snapshot.vault.id) &&
      Number.isSafeInteger(snapshot.catalogRevision) &&
      snapshot.catalogRevision >= 0,
  );
  const vaultId = snapshot.vault.id;
  const ids = new Set<Id>([vaultId]);
  function index<T extends Entity>(rows: T[]): Map<Id, T> {
    requireValue(Array.isArray(rows));
    const map = new Map<Id, T>();
    for (const row of rows) {
      requireValue(
        isRecord(row) &&
          isId(row.id) &&
          row.vaultId === vaultId &&
          Number.isSafeInteger(row.revision) &&
          row.revision > 0 &&
          validText(row.createdAt) &&
          validText(row.updatedAt) &&
          !ids.has(row.id),
      );
      ids.add(row.id);
      map.set(row.id, row);
    }
    return map;
  }
  const hosts = index(snapshot.hosts),
    groups = index(snapshot.groups),
    identities = index(snapshot.identities),
    keys = index(snapshot.keys),
    tags = index(snapshot.tags),
    refs = index(snapshot.secretRefs);
  function ref(id: Id | null, kind: SecretRef["kind"]): void {
    requireValue(id === null || (isId(id) && refs.get(id)?.kind === kind));
  }
  for (const group of groups.values()) {
    requireValue(
      validText(group.label) &&
        (group.parentId === null || groups.has(group.parentId)) &&
        portValid(group.port) &&
        authValid(group.auth),
    );
    requireValue(
      group.auth.mode !== "value" || identities.has(group.auth.identityId),
    );
  }
  // Mark completed paths once, so detecting a disconnected cycle is linear and bounded.
  const complete = new Set<Id>();
  for (const group of groups.values()) {
    const path = new Set<Id>();
    let current: Group | undefined = group;
    while (current && !complete.has(current.id)) {
      requireValue(!path.has(current.id));
      path.add(current.id);
      current =
        current.parentId === null ? undefined : groups.get(current.parentId);
    }
    for (const id of path) complete.add(id);
  }
  for (const host of hosts.values()) {
    requireValue(
      validText(host.label) &&
        validText(host.address) &&
        (host.groupId === null || groups.has(host.groupId)) &&
        [null, "DEV", "STAGING", "PROD"].includes(host.environment) &&
        portValid(host.port) &&
        authValid(host.auth),
    );
    requireValue(
      host.auth.mode !== "value" || identities.has(host.auth.identityId),
    );
    requireValue(hostChainProblem(host, hosts) === null);
  }
  for (const identity of identities.values()) {
    requireValue(
      validText(identity.label) &&
        validText(identity.username) &&
        ["password", "key", "keyboard-interactive"].includes(identity.method),
    );
    requireValue(identity.keyId === null || keys.has(identity.keyId));
    requireValue(
      identity.method === "key"
        ? identity.keyId !== null && identity.passwordRef === null
        : identity.keyId === null,
    );
    requireValue(
      identity.method !== "keyboard-interactive" ||
        identity.passwordRef === null,
    );
    ref(identity.passwordRef, "password");
  }
  for (const key of keys.values()) {
    requireValue(
      validText(key.label) &&
        validText(key.algorithm) &&
        validText(key.publicKey) &&
        validText(key.fingerprint) &&
        isId(key.privateKeyRef),
    );
    ref(key.privateKeyRef, "private-key");
    ref(key.passphraseRef, "passphrase");
  }
  for (const tag of tags.values())
    requireValue(
      validText(tag.label) &&
        typeof tag.normalizedName === "string" &&
        tag.normalizedName === normalized(tag.label),
    );
  requireValue(Array.isArray(snapshot.hostTags));
  const tagsByHost = new Map<Id, Set<Id>>();
  for (const membership of snapshot.hostTags) {
    requireValue(
      isRecord(membership) &&
        membership.vaultId === vaultId &&
        hosts.has(membership.hostId) &&
        tags.has(membership.tagId),
    );
    const assigned = tagsByHost.get(membership.hostId) ?? new Set<Id>();
    assigned.add(membership.tagId);
    tagsByHost.set(membership.hostId, assigned);
  }
  return { hosts, groups, identities, keys, tags, tagsByHost };
}
type Catalog = ReturnType<typeof catalog>;
function ancestry(index: Catalog, host: Host): Group[] {
  const parents: Group[] = [];
  let id = host.groupId;
  while (id !== null) {
    const group = index.groups.get(id)!;
    parents.push(group);
    id = group.parentId;
  }
  return parents.reverse();
}
type Candidate = { value: Host | Group; kind: "host" | "group" };
export type GroupDefaults = Pick<ResolvedHostConfig, "port" | "auth">;
/** Nearest candidate first: the first explicit port and the first non-inherit auth win. */
function effective(index: Catalog, candidates: Candidate[]): GroupDefaults {
  let port: ResolvedHostConfig["port"] = {
    value: 22,
    source: { kind: "default" },
  };
  let auth: ResolvedHostConfig["auth"] = {
    selection: "none",
    identity: null,
    key: null,
    source: { kind: "default" },
  };
  for (const candidate of candidates) {
    if (candidate.value.port.mode === "value") {
      port = {
        value: candidate.value.port.port,
        source: {
          kind: candidate.kind,
          id: candidate.value.id,
          revision: candidate.value.revision,
        },
      };
      break;
    }
  }
  for (const candidate of candidates) {
    const override = candidate.value.auth;
    if (override.mode === "inherit") continue;
    const source: ConfigSource = {
      kind: candidate.kind,
      id: candidate.value.id,
      revision: candidate.value.revision,
    };
    if (override.mode === "clear")
      auth = { selection: "clear", identity: null, key: null, source };
    else {
      const identity = index.identities.get(override.identityId)!;
      auth = {
        selection: "identity",
        identity: copyIdentity(identity),
        key:
          identity.keyId === null
            ? null
            : copyKey(index.keys.get(identity.keyId)!),
        source,
      };
    }
    break;
  }
  return { port, auth };
}
function resolve(
  snapshot: MetadataSnapshot,
  index: Catalog,
  host: Host,
): ResolvedHostConfig {
  const target = resolveHop(snapshot, index, host);
  // Bounded and acyclic: `catalog()` already checked every host with hostChainProblem.
  const jumps: ResolvedHostConfig[] = [];
  for (let id = host.jumpHostId ?? null; id !== null; ) {
    const jump = index.hosts.get(id)!;
    jumps.unshift(resolveHop(snapshot, index, jump));
    id = jump.jumpHostId ?? null;
  }
  const outermost = jumps.length ? index.hosts.get(jumps[0]!.hostRef.id)! : host;
  return {
    ...target,
    ...(jumps.length ? { jumps } : {}),
    ...(outermost.proxy ? { proxy: { type: outermost.proxy.type, host: outermost.proxy.host, port: outermost.proxy.port } } : {}),
  };
}
function resolveHop(
  snapshot: MetadataSnapshot,
  index: Catalog,
  host: Host,
): ResolvedHostConfig {
  const parents = ancestry(index, host);
  const { port, auth } = effective(index, [
    { value: host, kind: "host" },
    ...parents
      .slice()
      .reverse()
      .map((value) => ({ value, kind: "group" as const })),
  ]);
  return {
    hostRef: {
      id: host.id,
      revision: host.revision,
      label: host.label,
      groupId: host.groupId,
    },
    address: host.address,
    environment: host.environment,
    port,
    auth,
    ancestry: parents.map((group) => ({
      id: group.id,
      revision: group.revision,
      label: group.label,
    })),
    catalogRevision: snapshot.catalogRevision,
  };
}

/** Captures one immutable metadata configuration; no secret provider or connection is touched. */
export function resolveHostConfig(
  snapshot: MetadataSnapshot,
  hostId: Id,
): StoreResult<ResolvedHostConfig> {
  return result(() => {
    requireValue(isId(hostId), "invalid-request");
    const index = catalog(snapshot);
    const host = index.hosts.get(hostId);
    requireValue(host, "invalid-request");
    return freeze(resolve(snapshot, index, host));
  });
}

/** Every host's configuration from one catalog index, so whole-catalog comparisons stay linear. */
export function resolveHostConfigs(
  snapshot: MetadataSnapshot,
): StoreResult<ReadonlyMap<Id, ResolvedHostConfig>> {
  return result(() => {
    const index = catalog(snapshot);
    const configs = new Map<Id, ResolvedHostConfig>();
    for (const host of index.hosts.values())
      configs.set(host.id, freeze(resolve(snapshot, index, host)));
    return configs;
  });
}

/** What a direct member that inherits everything receives from each group (the group itself, then its ancestors). */
export function resolveGroupDefaults(
  snapshot: MetadataSnapshot,
): StoreResult<ReadonlyMap<Id, GroupDefaults>> {
  return result(() => {
    const index = catalog(snapshot);
    const defaults = new Map<Id, GroupDefaults>();
    for (const group of index.groups.values()) {
      const chain: Candidate[] = [];
      for (
        let current: Group | undefined = group;
        current;
        current =
          current.parentId === null ? undefined : index.groups.get(current.parentId)
      )
        chain.push({ value: current, kind: "group" });
      defaults.set(group.id, freeze(effective(index, chain)));
    }
    return defaults;
  });
}

export function queryCatalogHosts(
  snapshot: MetadataSnapshot,
  query: CatalogHostQuery,
): StoreResult<CatalogHostView[]> {
  return result(() => {
    exact(query, ["scope", "search", "tagIds"], ["scope"]);
    exact(query.scope, ["kind", "groupId", "includeDescendants"], ["kind"]);
    if (query.scope.kind === "group") {
      exact(query.scope, ["kind", "groupId", "includeDescendants"]);
      requireValue(
        isId(query.scope.groupId) &&
          typeof query.scope.includeDescendants === "boolean",
        "invalid-request",
      );
    } else {
      exact(query.scope, ["kind"]);
      requireValue(
        query.scope.kind === "all" || query.scope.kind === "ungrouped",
        "invalid-request",
      );
    }
    requireValue(
      !Object.hasOwn(query, "search") || typeof query.search === "string",
      "invalid-request",
    );
    requireValue(
      !Object.hasOwn(query, "tagIds") ||
        (Array.isArray(query.tagIds) && query.tagIds.every(isId)),
      "invalid-request",
    );
    const index = catalog(snapshot);
    const requestedTags = new Set(query.tagIds ?? []);
    for (const id of requestedTags)
      requireValue(index.tags.has(id), "invalid-request");
    const scope = query.scope;
    if (scope.kind === "group")
      requireValue(index.groups.has(scope.groupId), "invalid-request");
    const search = normalized(query.search ?? "");
    const views: CatalogHostView[] = [];
    for (const host of index.hosts.values()) {
      if (scope.kind === "ungrouped" && host.groupId !== null) continue;
      if (
        scope.kind === "group" &&
        !scope.includeDescendants &&
        host.groupId !== scope.groupId
      )
        continue;
      const config = resolve(snapshot, index, host);
      if (
        scope.kind === "group" &&
        scope.includeDescendants &&
        !config.ancestry.some((group) => group.id === scope.groupId)
      )
        continue;
      const assigned = index.tagsByHost.get(host.id) ?? new Set<Id>();
      if ([...requestedTags].some((id) => !assigned.has(id))) continue;
      const tags = [...assigned]
        .map((id) => index.tags.get(id)!)
        .sort(compareLabel);
      const fields = [
        host.label,
        host.address,
        config.auth.identity?.username ?? "",
        ...tags.map((tag) => tag.label),
        ...config.ancestry.map((group) => group.label),
      ];
      if (search && !fields.some((field) => normalized(field).includes(search)))
        continue;
      views.push({ host: copyHost(host), tags: tags.map(copyTag), config });
    }
    views.sort((a, b) => compareLabel(a.host, b.host));
    return freeze(views);
  });
}

export function catalogGroupTree(
  snapshot: MetadataSnapshot,
): StoreResult<CatalogGroupNode[]> {
  return result(() => {
    const index = catalog(snapshot);
    const nodes = new Map<Id, { group: Group; children: CatalogGroupNode[] }>();
    for (const group of index.groups.values())
      nodes.set(group.id, { group: copyGroup(group), children: [] });
    const roots: CatalogGroupNode[] = [];
    for (const group of index.groups.values()) {
      const node = nodes.get(group.id)!;
      if (group.parentId === null) roots.push(node);
      else nodes.get(group.parentId)!.children.push(node);
    }
    const compare = (a: CatalogGroupNode, b: CatalogGroupNode) =>
      compareLabel(a.group, b.group);
    roots.sort(compare);
    for (const node of nodes.values()) node.children.sort(compare);
    return freeze(roots);
  });
}
