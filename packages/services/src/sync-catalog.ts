/** Portable whitelisted catalog snapshots. Plaintext exists only for an explicit publish/review/apply. */
import { createHash, randomUUID } from "node:crypto";
import type {
  AuthOverride,
  MetadataChange,
  MetadataRepository,
  MetadataSnapshot,
} from "@ssterm/domain";
import { previewMetadataChanges } from "@ssterm/adapters";
import type {
  SyncMapping,
  SyncRepository,
} from "../../adapters/src/sync-repository.ts";

export type SyncRecordType = "host" | "group" | "identity" | "tag" | "snippet";
export interface SyncPortableRecord {
  id: string;
  type: SyncRecordType;
  data: Record<string, unknown>;
}
export interface SyncTombstone {
  id: string;
  type: SyncRecordType;
}
export interface SyncSnapshot {
  format: "ssterm-catalog-sync-v1";
  records: SyncPortableRecord[];
  tombstones: SyncTombstone[];
}
export interface SyncConflict {
  key: string;
  type: SyncRecordType;
  id: string;
  label: string;
  reason: string;
  localPreview: string;
  remotePreview: string;
}
export function syncRecordPreview(
  row: SyncPortableRecord | null | undefined,
): string {
  if (row === undefined) return "Absent";
  if (row === null) return "Deleted";
  const full = syncCanonical(row.data);
  return full.length <= 2048 ? full : full.slice(0, 2034) + "… [truncated]";
}
export interface SyncResolution {
  key: string;
  choice: "local" | "remote" | "restore";
}
export interface SyncSnippetSeam {
  initialize(): Promise<boolean>;
  exportBodies(ids: string[]): Promise<{ id: string; body: Uint8Array }[]>;
  prepare(request: {
    expectedCatalogRevision: number;
    snippets: {
      id: string;
      label: string;
      body: Uint8Array;
      expectedRevision?: number;
    }[];
    fence?: () => boolean;
  }): Promise<
    | { status: "ready"; changes: MetadataChange[]; catalogRevision: number }
    | { status: string }
  >;
}
const types: SyncRecordType[] = ["group", "host", "identity", "snippet", "tag"];
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const key = (r: SyncTombstone) => `${r.type}/${r.id}`;
function check(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid portable catalog.");
}
export function syncCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(syncCanonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([k, v]) => `${JSON.stringify(k)}:${syncCanonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const syncDigest = (value: unknown) =>
  createHash("sha256").update(syncCanonical(value)).digest("hex");
const sortRows = <T extends SyncTombstone>(rows: T[]) =>
  rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const fields: Record<SyncRecordType, string[]> = {
  host: [
    "label",
    "address",
    "groupId",
    "environment",
    "port",
    "auth",
    "jumpHostId",
    "proxy",
    "tagIds",
  ],
  group: ["label", "parentId", "port", "auth"],
  identity: ["label", "username", "method"],
  tag: ["label"],
  snippet: ["label", "body", "tagIds"],
};
function object(
  v: unknown,
  allowed: string[],
): asserts v is Record<string, unknown> {
  check(
    !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.keys(v).length === allowed.length &&
      allowed.every((k) => Object.hasOwn(v, k)),
  );
}
/** Strict field whitelist; the local repository is the authoritative graph/value validator at apply. */
export function parseSyncSnapshot(bytes: Uint8Array): SyncSnapshot {
  check(bytes instanceof Uint8Array && bytes.length <= 1024 * 1024);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  object(parsed, ["format", "records", "tombstones"]);
  check(
    parsed.format === "ssterm-catalog-sync-v1" &&
      Array.isArray(parsed.records) &&
      Array.isArray(parsed.tombstones),
  );
  check(parsed.records.length + parsed.tombstones.length <= 2000);
  const all = new Set<string>();
  let last = "";
  for (const raw of parsed.records) {
    object(raw, ["id", "type", "data"]);
    check(
      typeof raw.id === "string" &&
        uuid.test(raw.id) &&
        types.includes(raw.type as SyncRecordType),
    );
    const r = raw as unknown as SyncPortableRecord;
    check(key(r) > last && !all.has(key(r)));
    last = key(r);
    all.add(last);
    object(r.data, fields[r.type]);
    check(typeof r.data.label === "string" && r.data.label.length <= 1024);
    if (r.type === "identity")
      check(
        (r.data.method === "password" ||
          r.data.method === "keyboard-interactive") &&
          typeof r.data.username === "string",
      );
    if (r.type === "snippet")
      check(
        typeof r.data.body === "string" &&
          Buffer.byteLength(r.data.body) <= 1024 * 1024,
      );
    if (r.type === "host" || r.type === "snippet") {
      check(Array.isArray(r.data.tagIds) && r.data.tagIds.length <= 1000);
      let p = "";
      for (const id of r.data.tagIds) {
        check(typeof id === "string" && uuid.test(id) && id > p);
        p = id;
      }
    }
    if (r.type === "host" || r.type === "group") {
      const a = r.data.auth;
      check(!!a && typeof a === "object" && !Array.isArray(a));
      const auth = a as Record<string, unknown>;
      check(
        auth.mode === "value" ||
          auth.mode === "clear" ||
          auth.mode === "inherit",
      );
      object(auth, auth.mode === "value" ? ["mode", "identityId"] : ["mode"]);
      if (auth.mode === "value")
        check(
          typeof auth.identityId === "string" && uuid.test(auth.identityId),
        );
      const p = r.data.port;
      check(!!p && typeof p === "object");
      const port = p as Record<string, unknown>;
      check(port.mode === "inherit" || port.mode === "value");
      object(port, port.mode === "value" ? ["mode", "port"] : ["mode"]);
      if (port.mode === "value")
        check(
          Number.isInteger(port.port) &&
            (port.port as number) >= 1 &&
            (port.port as number) <= 65535,
        );
    }
  }
  last = "";
  for (const raw of parsed.tombstones) {
    object(raw, ["id", "type"]);
    check(
      typeof raw.id === "string" &&
        uuid.test(raw.id) &&
        types.includes(raw.type as SyncRecordType),
    );
    const r = raw as unknown as SyncTombstone;
    check(key(r) > last && !all.has(key(r)));
    last = key(r);
    all.add(last);
  }
  // Canonical JSON also rejects duplicate properties, alternate escaping and unknown fields.
  check(syncCanonical(parsed) === text);
  return parsed as unknown as SyncSnapshot;
}
export function encodeSyncSnapshot(snapshot: SyncSnapshot): Buffer {
  const bytes = Buffer.from(syncCanonical(snapshot));
  parseSyncSnapshot(bytes);
  return bytes;
}
export const emptySyncSnapshot = (): SyncSnapshot => ({
  format: "ssterm-catalog-sync-v1",
  records: [],
  tombstones: [],
});
export async function exportSyncSnapshot(
  metadata: MetadataRepository,
  repository: SyncRepository,
  secrets: SyncSnippetSeam,
  tombstones: SyncTombstone[] = [],
  fence: () => boolean = () => true,
): Promise<{
  snapshot: SyncSnapshot;
  catalogRevision: number;
  warnings: string[];
}> {
  const read = metadata.snapshot();
  check(read.ok);
  const s = read.value;
  const includedIdentity = new Set(
    s.identities.filter((r) => r.method !== "key").map((r) => r.id),
  );
  for (const [type, rows] of [
    ["group", s.groups],
    ["host", s.hosts],
    ["identity", s.identities.filter((r) => includedIdentity.has(r.id))],
    ["tag", s.tags],
    ["snippet", s.snippets],
  ] as const)
    for (const r of rows) repository.map(type, r.id);
  const maps = repository.mappings();
  const toSync = (type: string, id: string | null): string | null =>
    id === null
      ? null
      : (maps.find((m) => m.type === type && m.localId === id)?.syncId ?? null);
  const warnings: string[] = [];
  const auth = (a: AuthOverride) => {
    if (a.mode !== "value") return a;
    const mapped = toSync("identity", a.identityId);
    if (!includedIdentity.has(a.identityId) || !mapped) {
      warnings.push(
        "SSH key identities are excluded; affected authentication must be set up locally.",
      );
      return { mode: "clear" };
    }
    return { mode: "value", identityId: mapped };
  };
  const records: SyncPortableRecord[] = [];
  for (const r of s.groups)
    records.push({
      id: toSync("group", r.id)!,
      type: "group",
      data: {
        label: r.label,
        parentId: toSync("group", r.parentId),
        port: r.port,
        auth: auth(r.auth),
      },
    });
  for (const r of s.hosts)
    records.push({
      id: toSync("host", r.id)!,
      type: "host",
      data: {
        label: r.label,
        address: r.address,
        environment: r.environment,
        groupId: toSync("group", r.groupId),
        port: r.port,
        auth: auth(r.auth),
        jumpHostId: toSync("host", r.jumpHostId),
        proxy: r.proxy,
        tagIds: s.hostTags
          .filter((t) => t.hostId === r.id)
          .map((t) => toSync("tag", t.tagId)!)
          .sort(),
      },
    });
  for (const r of s.identities.filter((r) => includedIdentity.has(r.id)))
    records.push({
      id: toSync("identity", r.id)!,
      type: "identity",
      data: { label: r.label, username: r.username, method: r.method },
    });
  for (const r of s.tags)
    records.push({
      id: toSync("tag", r.id)!,
      type: "tag",
      data: { label: r.label },
    });
  const bodies = await secrets.exportBodies(s.snippets.map((r) => r.id));
  try {
    check(fence());
    for (const r of s.snippets) {
      const body = bodies.find((b) => b.id === r.id);
      check(body);
      records.push({
        id: toSync("snippet", r.id)!,
        type: "snippet",
        data: {
          label: r.label,
          body: new TextDecoder("utf-8", { fatal: true }).decode(body.body),
          tagIds: s.snippetTags
            .filter((t) => t.snippetId === r.id)
            .map((t) => toSync("tag", t.tagId)!)
            .sort(),
        },
      });
    }
  } finally {
    for (const b of bodies) b.body.fill(0);
  }
  check(metadata.snapshot().ok);
  const fresh = metadata.snapshot();
  check(fresh.ok && fresh.value.catalogRevision === s.catalogRevision);
  const present = new Set(records.map(key));
  const dead = new Map(tombstones.map((r) => [key(r), r]));
  // A previously mapped record disappearing locally becomes an explicit durable tombstone on Publish.
  for (const m of maps)
    if (m.materialized && !present.has(`${m.type}/${m.syncId}`))
      dead.set(`${m.type}/${m.syncId}`, {
        type: m.type as SyncRecordType,
        id: m.syncId,
      });
  for (const k of present) dead.delete(k);
  const snapshot: SyncSnapshot = {
    format: "ssterm-catalog-sync-v1",
    records: sortRows(records),
    tombstones: sortRows([...dead.values()]),
  };
  encodeSyncSnapshot(snapshot).fill(0);
  return {
    snapshot,
    catalogRevision: s.catalogRevision,
    warnings: [...new Set(warnings)],
  };
}
function values(
  snapshot: SyncSnapshot,
): Map<string, SyncPortableRecord | null> {
  return new Map([
    ...snapshot.records.map((r) => [key(r), r] as const),
    ...snapshot.tombstones.map((r) => [key(r), null] as const),
  ]);
}
export function mergeSyncSnapshots(
  base: SyncSnapshot,
  local: SyncSnapshot,
  remote: SyncSnapshot,
  resolutions: SyncResolution[] = [],
): { snapshot: SyncSnapshot; conflicts: SyncConflict[] } {
  const b = values(base),
    l = values(local),
    r = values(remote);
  const result = new Map(l);
  const conflicts: SyncConflict[] = [];
  const choice = new Map(resolutions.map((r) => [r.key, r.choice]));
  check(choice.size === resolutions.length);
  for (const [k, rv] of r) {
    // Decisions also resolve graph conflicts caused by otherwise independent additions/deletions.
    const forced = choice.get(k);
    if (forced === "local") continue;
    if (forced === "remote") {
      result.set(k, rv);
      continue;
    }
    const bv = b.get(k);
    const lv = l.get(k);
    if (syncCanonical(lv) === syncCanonical(rv)) continue;
    const remoteChanged = syncCanonical(rv) !== syncCanonical(bv);
    if (!remoteChanged) continue;
    const localChanged = syncCanonical(lv) !== syncCanonical(bv);
    if (!localChanged) {
      result.set(k, rv);
      continue;
    }
    const [type, id] = k.split("/") as [SyncRecordType, string];
    const selected = choice.get(k);
    if (selected === "remote") result.set(k, rv);
    else if (selected === "restore") {
      const row = rv ?? lv;
      check(row);
      const restored = { ...structuredClone(row), id: randomUUID() };
      result.set(key(restored), restored);
      result.set(k, null);
    } else if (selected !== "local")
      conflicts.push({
        key: k,
        type,
        id,
        label: String(lv?.data.label ?? rv?.data.label ?? "Deleted record"),
        reason: lv === null || rv === null ? "delete-edit" : "different-edits",
        localPreview: syncRecordPreview(lv),
        remotePreview: syncRecordPreview(rv),
      });
  }
  const records: SyncPortableRecord[] = [],
    tombstones: SyncTombstone[] = [];
  for (const [k, v] of result)
    if (v) records.push(v);
    else {
      const [type, id] = k.split("/") as [SyncRecordType, string];
      tombstones.push({ type, id });
    }
  return {
    snapshot: {
      format: "ssterm-catalog-sync-v1",
      records: sortRows(records),
      tombstones: sortRows(tombstones),
    },
    conflicts,
  };
}
export async function prepareSyncCatalogImport(
  target: SyncSnapshot,
  current: MetadataSnapshot,
  repository: SyncRepository,
  secrets: SyncSnippetSeam,
  fence: () => boolean,
): Promise<{ changes: MetadataChange[]; warnings: string[] }> {
  const mappings = repository.mappings();
  const changes: MetadataChange[] = [];
  const warnings: string[] = [];
  const collection = (type: SyncRecordType) =>
    current[
      (
        {
          host: "hosts",
          group: "groups",
          identity: "identities",
          tag: "tags",
          snippet: "snippets",
        } as const
      )[type]
    ];
  for (const r of target.records)
    if (!mappings.some((m) => m.type === r.type && m.syncId === r.id)) {
      const localId = randomUUID();
      repository.map(r.type, localId, r.id);
      mappings.push({ type: r.type, syncId: r.id, localId });
    }
  // A previously deleted local UUID stays reserved by entity_registry. Explicit restore uses a fresh local UUID.
  for (const r of target.records) {
    const mapping = mappings.find(
      (m) => m.type === r.type && m.syncId === r.id,
    )!;
    if (
      mapping.materialized &&
      !collection(r.type).some((row) => row.id === mapping.localId)
    ) {
      mapping.localId = randomUUID();
      mapping.materialized = 0;
      repository.remap(r.type, r.id, mapping.localId);
    }
  }
  const local = (type: string, id: unknown): string | null =>
    id === null
      ? null
      : (mappings.find((m) => m.type === type && m.syncId === id)?.localId ??
        null);
  const targetByKey = values(target);
  const auth = (value: unknown): AuthOverride => {
    const a = value as AuthOverride;
    if (a.mode !== "value") return a;
    const identityId = local("identity", a.identityId);
    check(identityId);
    return { mode: "value", identityId };
  };
  const snippetImports: {
    id: string;
    label: string;
    body: Uint8Array;
    expectedRevision?: number;
  }[] = [];
  for (const r of target.records) {
    const id = local(r.type, r.id)!;
    const existing = collection(r.type).find((row) => row.id === id);
    const d = structuredClone(r.data);
    let data: Record<string, unknown>;
    if (r.type === "host")
      data = {
        label: d.label,
        address: d.address,
        environment: d.environment,
        groupId: local("group", d.groupId),
        port: d.port,
        auth: auth(d.auth),
        jumpHostId: local("host", d.jumpHostId),
        proxy: d.proxy,
      };
    else if (r.type === "group")
      data = {
        label: d.label,
        parentId: local("group", d.parentId),
        port: d.port,
        auth: auth(d.auth),
      };
    else if (r.type === "identity") {
      const old = current.identities.find((row) => row.id === id);
      const preserve = old?.username === d.username && old?.method === d.method;
      data = {
        label: d.label,
        username: d.username,
        method: d.method,
        keyId: null,
        ...(!preserve ? { passwordRef: null } : {}),
      };
      if (old?.passwordRef && !preserve) {
        warnings.push(
          "Changed login detaches the local password and queues credential cleanup after explicit Apply.",
        );
        changes.push({
          type: "queue-secret-cleanup",
          operationId: randomUUID(),
          ref: old.passwordRef,
        });
      }
    } else if (r.type === "tag") data = { label: d.label };
    else {
      snippetImports.push({
        id,
        label: d.label as string,
        body: Buffer.from(d.body as string),
        ...(existing ? { expectedRevision: existing.revision } : {}),
      });
      continue;
    }
    const portableExisting =
      existing &&
      Object.fromEntries(
        Object.keys(data).map((k) => [
          k,
          (existing as unknown as Record<string, unknown>)[k],
        ]),
      );
    if (!existing)
      changes.push({ type: `create-${r.type}`, id, data } as MetadataChange);
    else if (syncCanonical(portableExisting) !== syncCanonical(data))
      changes.push({
        type: `update-${r.type}`,
        id,
        expectedRevision: existing.revision,
        data,
      } as MetadataChange);
  }
  try {
    if (snippetImports.length) {
      const sealed = await secrets.prepare({
        expectedCatalogRevision: current.catalogRevision,
        snippets: snippetImports,
        fence,
      });
      check(sealed.status === "ready" && "changes" in sealed);
      changes.push(...sealed.changes);
    }
  } finally {
    for (const s of snippetImports) s.body.fill(0);
  }
  for (const m of mappings) {
    const k = `${m.type}/${m.syncId}`;
    if (targetByKey.get(k) !== null) continue;
    const type = m.type as SyncRecordType;
    const existing = collection(type).find((r) => r.id === m.localId);
    if (!existing) continue;
    if (type === "identity") {
      const identity = current.identities.find((r) => r.id === existing.id)!;
      if (identity.passwordRef) {
        warnings.push(
          "Deleted identity queues its local password cleanup only after explicit Apply.",
        );
        changes.push({
          type: "queue-secret-cleanup",
          operationId: randomUUID(),
          ref: identity.passwordRef,
        });
      }
    }
    if (type === "host")
      for (const rule of current.tunnelRules.filter(
        (r) => r.hostId === existing.id,
      ))
        changes.push({
          type: "delete-tunnel-rule",
          id: rule.id,
          expectedRevision: rule.revision,
        });
    changes.push({
      type: `delete-${type}`,
      id: existing.id,
      expectedRevision: existing.revision,
    } as MetadataChange);
  }
  // Memberships are reconciled in the same transaction and domain rules check all references/cycles.
  for (const type of ["host", "snippet"] as const) {
    const before =
      type === "host"
        ? current.hostTags.map((r) => ({ owner: r.hostId, tag: r.tagId }))
        : current.snippetTags.map((r) => ({
            owner: r.snippetId,
            tag: r.tagId,
          }));
    const after = new Set<string>();
    for (const r of target.records.filter((r) => r.type === type))
      for (const tag of r.data.tagIds as string[]) {
        const owner = local(type, r.id),
          tagId = local("tag", tag);
        check(owner && tagId);
        after.add(`${owner}/${tagId}`);
      }
    const prior = new Set(before.map((r) => `${r.owner}/${r.tag}`));
    for (const pair of new Set([...prior, ...after]))
      if (prior.has(pair) !== after.has(pair)) {
        const [ownerId, tagId] = pair.split("/");
        const owner = collection(type).find((r) => r.id === ownerId);
        const expected = owner?.revision ?? 1;
        changes.push(
          type === "host"
            ? {
                type: "set-host-tag",
                hostId: ownerId,
                tagId,
                present: after.has(pair),
                expectedHostRevision: expected,
              }
            : {
                type: "set-snippet-tag",
                snippetId: ownerId,
                tagId,
                present: after.has(pair),
                expectedSnippetRevision: expected,
              },
        );
      }
  }
  check(changes.length <= 1000 && fence());
  if (changes.length) {
    const preview = previewMetadataChanges(current, changes);
    check(preview.ok);
  }
  return { changes, warnings };
}

/** Relationship failures are surfaced at Review before the final authoritative domain preview. */
export function syncGraphConflicts(snapshot: SyncSnapshot): SyncConflict[] {
  const rows = new Map(snapshot.records.map((r) => [key(r), r]));
  const conflicts: SyncConflict[] = [];
  const issue = (r: SyncPortableRecord, reason: string) =>
    conflicts.push({
      key: key(r),
      type: r.type,
      id: r.id,
      label: String(r.data.label),
      reason,
      localPreview: syncRecordPreview(r),
      remotePreview: syncRecordPreview(r),
    });
  const dependency = (
    r: SyncPortableRecord,
    type: SyncRecordType,
    id: unknown,
  ) => {
    if (id !== null && (typeof id !== "string" || !rows.has(`${type}/${id}`)))
      issue(r, "missing-dependency");
  };
  const tagNames = new Map<string, SyncPortableRecord>();
  for (const r of snapshot.records) {
    const d = r.data;
    if (r.type === "host") {
      dependency(r, "group", d.groupId);
      dependency(r, "host", d.jumpHostId);
    }
    if (r.type === "group") dependency(r, "group", d.parentId);
    if (r.type === "host" || r.type === "group") {
      const a = d.auth as AuthOverride;
      if (a.mode === "value") dependency(r, "identity", a.identityId);
      const seen = new Set<string>([r.id]);
      let next = r.type === "group" ? d.parentId : d.jumpHostId;
      let depth = 0;
      while (typeof next === "string") {
        if (seen.has(next)) {
          issue(r, "relationship-cycle");
          break;
        }
        seen.add(next);
        const parent = rows.get(`${r.type}/${next}`);
        if (!parent) break;
        next =
          r.type === "group" ? parent.data.parentId : parent.data.jumpHostId;
        if (r.type === "host" && ++depth > 3) {
          issue(r, "jump-depth");
          break;
        }
      }
    }
    if (r.type === "host" || r.type === "snippet")
      for (const tag of d.tagIds as string[]) dependency(r, "tag", tag);
    if (r.type === "tag") {
      const name = String(d.label)
        .normalize("NFC")
        .trim()
        .toLocaleLowerCase("en-US");
      const previous = tagNames.get(name);
      if (previous) {
        issue(previous, "duplicate-tag-label");
        issue(r, "duplicate-tag-label");
      } else tagNames.set(name, r);
    }
  }
  return [
    ...new Map(conflicts.map((c) => [`${c.key}/${c.reason}`, c])).values(),
  ];
}
