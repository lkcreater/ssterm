import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { openSyncRepository } from "../../packages/adapters/src/sync-repository.ts";
import {
  SecretService,
  TransientSecrets,
} from "../../packages/services/src/index.ts";
import { MemorySecretProvider } from "../fixtures/secrets/memory-provider.ts";
import {
  emptySyncSnapshot,
  encodeSyncSnapshot,
  exportSyncSnapshot,
  mergeSyncSnapshots,
  parseSyncSnapshot,
  prepareSyncCatalogImport,
  syncCanonical,
  syncGraphConflicts,
  type SyncPortableRecord,
  type SyncSnapshot,
} from "../../packages/services/src/sync-catalog.ts";
import type {
  MetadataChange,
  StoreResult,
} from "../../packages/domain/src/index.ts";
const value = <T>(r: StoreResult<T>): T => {
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const record = (
  label: string,
  id: string = randomUUID(),
): SyncPortableRecord => ({ id, type: "tag", data: { label } });
const snapshot = (
  records: SyncPortableRecord[] = [],
  tombstones: SyncSnapshot["tombstones"] = [],
): SyncSnapshot => ({
  format: "ssterm-catalog-sync-v1",
  records: records.sort((a, b) =>
    `${a.type}/${a.id}`.localeCompare(`${b.type}/${b.id}`),
  ),
  tombstones,
});
async function fixture(t: TestContext) {
  const dir = mkdtempSync("/private/tmp/ssterm-sync-catalog-");
  const catalog = value(
    await openMetadata({ path: join(dir, "catalog.sqlite") }),
  );
  const repository = openSyncRepository(join(dir, "sync.sqlite"));
  const provider = new MemorySecretProvider(),
    transient = new TransientSecrets(),
    secrets = new SecretService({ repository: catalog, provider, transient });
  const seam = {
    initialize: async () => {
      const r = await secrets.initializeContentKey();
      return r.status === "ready" || r.status === "published";
    },
    exportBodies: async (ids: string[]) => {
      const r = await secrets.exportSnippetBodies(ids);
      assert.equal(r.status, "ready");
      return r.status === "ready" ? r.bodies : [];
    },
    prepare: secrets.prepareSnippetImport.bind(secrets),
  };
  const current = () => value(catalog.snapshot());
  const commit = (changes: MetadataChange[]) =>
    value(
      catalog.commit({
        expectedCatalogRevision: current().catalogRevision,
        changes,
      }),
    );
  t.after(() => {
    transient.purgeAll();
    catalog.close();
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, catalog, repository, provider, secrets, seam, current, commit };
}

test("three-way independent changes, divergent edits, delete/edit and tombstone anti-resurrection", () => {
  const row = record("Base"),
    base = snapshot([row]),
    changed = { ...row, data: { label: "Remote changed" } },
    local = snapshot([{ ...row, data: { label: "Local changed" } }]),
    remote = snapshot([changed]);
  assert.equal(
    mergeSyncSnapshots(base, local, remote).conflicts[0].reason,
    "different-edits",
  );
  assert.equal(
    mergeSyncSnapshots(base, local, remote, [
      { key: `tag/${row.id}`, choice: "remote" },
    ]).snapshot.records[0].data.label,
    "Remote changed",
  );
  const deleted = snapshot([], [{ id: row.id, type: "tag" }]);
  assert.equal(
    mergeSyncSnapshots(base, deleted, remote).conflicts[0].reason,
    "delete-edit",
  );
  assert.deepEqual(mergeSyncSnapshots(base, deleted, base).snapshot, deleted);
  assert.deepEqual(
    mergeSyncSnapshots(base, deleted, deleted).snapshot,
    deleted,
  );
  const restored = mergeSyncSnapshots(base, deleted, remote, [
    { key: `tag/${row.id}`, choice: "restore" },
  ]).snapshot;
  assert.equal(restored.tombstones[0].id, row.id);
  assert.notEqual(restored.records[0].id, row.id);
  assert.equal(restored.records[0].data.label, "Remote changed");
  const unrelated = record("Independent");
  assert.equal(
    mergeSyncSnapshots(base, snapshot([row, unrelated]), remote).conflicts
      .length,
    0,
  );
  // Absence is never a tombstone.
  assert.equal(
    mergeSyncSnapshots(base, local, emptySyncSnapshot()).snapshot.records[0]
      .data.label,
    "Local changed",
  );
});

test("portable parser rejects refs, duplicate fields, noncanonical UTF-8/order, unsupported formats and oversize", () => {
  const r = record("Owned");
  assert.deepEqual(
    parseSyncSnapshot(encodeSyncSnapshot(snapshot([r]))),
    snapshot([r]),
  );
  for (const bad of [
    { ...snapshot([r]), extra: true },
    { ...snapshot([r]), format: "unknown" },
    snapshot([{ ...r, data: { label: "Owned", passwordRef: randomUUID() } }]),
    snapshot([r, r]),
  ])
    assert.throws(() => parseSyncSnapshot(Buffer.from(syncCanonical(bad))));
  assert.throws(() =>
    parseSyncSnapshot(
      Buffer.from(
        '{"format":"ssterm-catalog-sync-v1","format":"ssterm-catalog-sync-v1","records":[],"tombstones":[]}',
      ),
    ),
  );
  assert.throws(() => parseSyncSnapshot(Buffer.from([0xff])));
  assert.throws(() => parseSyncSnapshot(Buffer.alloc(1024 * 1024 + 1)));
});

test("portable export uses stable separate sync IDs; excludes credentials/keys/trust; key auth becomes clear", async (t) => {
  const f = await fixture(t),
    id = randomUUID();
  const result = await f.secrets.storeSecret({
    kind: "password",
    owner: { type: "identity", id, expectedRevision: null },
    value: Buffer.from("owned-password-never-sync"),
    publish: (ref) => [
      {
        type: "create-identity",
        id,
        data: {
          label: "Portable login",
          username: "alice",
          method: "password",
          passwordRef: ref,
        },
      },
    ],
  });
  assert.equal(result.status, "published");
  const host = randomUUID();
  f.commit([
    {
      type: "create-host",
      id: host,
      data: {
        label: "Portable",
        address: "fixture.invalid",
        auth: { mode: "value", identityId: id },
      },
    },
  ]);
  const first = await exportSyncSnapshot(f.catalog, f.repository, f.seam);
  const encoded = encodeSyncSnapshot(first.snapshot).toString();
  assert.equal(encoded.includes(id), false);
  assert.equal(encoded.includes(host), false);
  assert.equal(encoded.includes("passwordRef"), false);
  assert.equal(encoded.includes("owned-password-never-sync"), false);
  assert.deepEqual(
    (await exportSyncSnapshot(f.catalog, f.repository, f.seam)).snapshot,
    first.snapshot,
  );
  const local = f.current().identities[0];
  const data = structuredClone(first.snapshot);
  data.records.find((r) => r.type === "identity")!.data.label =
    "Metadata update";
  const prepared = await prepareSyncCatalogImport(
    data,
    f.current(),
    f.repository,
    f.seam,
    () => true,
  );
  f.commit(prepared.changes);
  assert.equal(f.current().identities[0].passwordRef, local.passwordRef);
  assert.equal(f.provider.items.size, 1);
  data.records.find((r) => r.type === "identity")!.data.username = "bob";
  const detached = await prepareSyncCatalogImport(
    data,
    f.current(),
    f.repository,
    f.seam,
    () => true,
  );
  assert.ok(detached.warnings.some((w) => w.includes("password")));
  f.commit(detached.changes);
  assert.equal(f.current().identities[0].passwordRef, null);
  assert.equal(f.provider.items.size, 1);
  assert.ok(f.current().secretOperations.some((o) => o.state === "cleanup"));
});

test("import reserves stable mappings, validates full graph and uses fresh local UUID after explicit restore", async (t) => {
  const f = await fixture(t);
  const tag = record("Restored");
  let target = snapshot([tag]);
  const prepared = await prepareSyncCatalogImport(
    target,
    f.current(),
    f.repository,
    f.seam,
    () => true,
  );
  assert.equal(f.current().tags.length, 0);
  assert.equal(
    (await exportSyncSnapshot(f.catalog, f.repository, f.seam)).snapshot
      .tombstones.length,
    0,
  );
  f.commit(prepared.changes);
  const old = f.current().tags[0];
  await exportSyncSnapshot(f.catalog, f.repository, f.seam);
  target = snapshot([], [{ id: tag.id, type: "tag" }]);
  f.commit(
    (
      await prepareSyncCatalogImport(
        target,
        f.current(),
        f.repository,
        f.seam,
        () => true,
      )
    ).changes,
  );
  assert.equal(f.current().tags.length, 0);
  const tombstones = (
    await exportSyncSnapshot(f.catalog, f.repository, f.seam, target.tombstones)
  ).snapshot.tombstones;
  assert.equal(tombstones[0].id, tag.id);
  // Explicit selected restore may preserve logical identity but must not reuse permanently reserved catalog IDs.
  f.commit(
    (
      await prepareSyncCatalogImport(
        snapshot([tag]),
        f.current(),
        f.repository,
        f.seam,
        () => true,
      )
    ).changes,
  );
  assert.notEqual(f.current().tags[0].id, old.id);
  assert.notEqual(f.current().tags[0].id, tag.id);
  const duplicate = snapshot([record("Same"), record("same")]);
  assert.ok(
    syncGraphConflicts(duplicate).some(
      (c) => c.reason === "duplicate-tag-label",
    ),
  );
  const one = record("Same");
  const other = record("same");
  const conflict = snapshot([one, other]);
  const kept = mergeSyncSnapshots(
    emptySyncSnapshot(),
    snapshot([one]),
    snapshot([other]),
    [{ key: `tag/${other.id}`, choice: "local" }],
  );
  assert.equal(syncGraphConflicts(kept.snapshot).length, 0);
});

test("sync store cold restart preserves immutable bytes/salts and cancels pending enrollment; foreign files fail closed", async (t) => {
  const dir = mkdtempSync("/private/tmp/ssterm-sync-store-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "sync.sqlite");
  let repo = openSyncRepository(path);
  const row = {
    hash: "a".repeat(64),
    operationId: randomUUID(),
    epoch: 1,
    salt: "b".repeat(64),
    wire: "owned-immutable-ciphertext",
    parents: [],
    sequence: null,
    direction: "out" as const,
    verdict: "pending" as const,
  };
  repo.addOperation(row);
  repo.markEnrollment("owned-request", "pending");
  repo.close();
  repo = openSyncRepository(path);
  assert.deepEqual(repo.operations(), [row]);
  assert.equal(repo.enrollment("owned-request"), "cancelled");
  repo.addOperation(row);
  assert.throws(() => repo.addOperation({ ...row, hash: "c".repeat(64) }));
  assert.throws(() =>
    repo.addOperation({
      ...row,
      hash: "d".repeat(64),
      operationId: randomUUID(),
    }),
  );
  repo.close();
  const foreign = join(dir, "foreign.sqlite");
  writeFileSync(foreign, "not sqlite", { mode: 0o600 });
  assert.throws(() => openSyncRepository(foreign));
  chmodSync(path, 0o644);
  assert.throws(() => openSyncRepository(path));
});
