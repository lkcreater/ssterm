import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCatalogController } from "../../apps/desktop/src/main/catalog-controller.ts";
import { CatalogModule } from "../../packages/services/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { hostChainProblem, resolveHostConfig, type MetadataRepository, type StoreResult } from "../../packages/domain/src/index.ts";
import type { CatalogChangeIntent, Result } from "../../packages/contracts/src/index.ts";
import { downgradeToSchemaV2 } from "../fixtures/storage/schema-v1.ts";

const owner = { windowId: 1, generation: 1 };
function value<T>(result: StoreResult<T> | Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync("/private/tmp/ssterm-host-chain-");
  const path = join(dir, "catalog.sqlite");
  const repo = value(await openMetadata({ path })) as MetadataRepository;
  const controller = createCatalogController({ repository: repo, catalog: new CatalogModule({ repository: repo }) });
  controller.register(owner, () => {});
  t.after(() => { controller.dispose(); repo.close(); rmSync(dir, { recursive: true, force: true }); });
  const apply = (intent: CatalogChangeIntent) => {
    const prepared = value(controller.prepareCatalogChange({ owner, intent }));
    if (prepared.kind !== "preview") return prepared.fields;
    return value(controller.applyCatalogChange({ owner, token: prepared.token })).createdIds;
  };
  const create = (label: string, extra: Record<string, unknown> = {}) =>
    (apply({ type: "create-host", data: { label, address: `${label.toLowerCase()}.example`, ...extra } }) as string[])[0]!;
  const state = () => value(controller.catalogState(owner));
  const rev = (id: string) => state().hosts.find((row) => row.id === id)!.revision;
  return { dir, path, repo, apply, create, state, rev };
}

test("jump hosts: chains resolve outermost first; cycles, depth > 3, self, missing and jump+proxy are field errors; a used jump host cannot be deleted", async (t) => {
  const s = await fixture(t);
  const a = s.create("A", { proxy: { type: "socks5", host: "Proxy.Example.", port: 1080 } });
  const b = s.create("B", { jumpHostId: a });
  const c = s.create("C", { jumpHostId: b });
  const d = s.create("D", { jumpHostId: c });
  const resolved = value(resolveHostConfig(value(s.repo.snapshot()), d));
  assert.deepEqual(resolved.jumps?.map((row) => row.hostRef.label), ["A", "B", "C"]);
  assert.deepEqual(resolved.proxy, { type: "socks5", host: "proxy.example", port: 1080 }, "the outermost hop's proxy, normalized");
  assert.equal(resolved.jumps?.[0]?.jumps, undefined, "hops carry no nested chain");
  assert.deepEqual(s.state().hosts.find((row) => row.id === b)?.jumpHostId, a);
  // A fourth jump host in front of the target is refused.
  assert.deepEqual(s.apply({ type: "create-host", data: { label: "E", address: "e.example", jumpHostId: d } }), [{ field: "jump", code: "too-deep" }]);
  const upstream = s.create("Upstream");
  assert.deepEqual(s.apply({ type: "update-host", id: a, expectedRevision: s.rev(a), data: { jumpHostId: upstream, proxy: null } }), [{ field: "jump", code: "too-deep" }], "extending A would make D's route too deep");
  assert.deepEqual(s.apply({ type: "update-host", id: a, expectedRevision: s.rev(a), data: { jumpHostId: c, proxy: null } }), [{ field: "jump", code: "cycle" }]);
  assert.deepEqual(s.apply({ type: "update-host", id: b, expectedRevision: s.rev(b), data: { jumpHostId: b } }), [{ field: "jump", code: "cycle" }]);
  assert.deepEqual(s.apply({ type: "update-host", id: b, expectedRevision: s.rev(b), data: { jumpHostId: "00000000-0000-4000-8000-0000000000ff" } }), [{ field: "jump", code: "not-found" }]);
  assert.deepEqual(s.apply({ type: "update-host", id: b, expectedRevision: s.rev(b), data: { proxy: { type: "http", host: "p.example", port: 3128 } } }), [{ field: "proxy", code: "with-jump" }]);
  assert.deepEqual(s.apply({ type: "update-host", id: a, expectedRevision: s.rev(a), data: { proxy: { type: "http", host: "a b", port: 3128 } } }), [{ field: "proxy", code: "invalid" }]);
  assert.deepEqual(s.apply({ type: "delete-host", id: a, expectedRevision: s.rev(a) }), [{ field: "jump", code: "in-use" }]);
  // The end of the chain can go; then its jump host can.
  assert.deepEqual(s.apply({ type: "delete-host", id: d, expectedRevision: s.rev(d) }), []);
  assert.deepEqual(s.apply({ type: "update-host", id: c, expectedRevision: s.rev(c), data: { jumpHostId: null } }), []);
  assert.deepEqual(s.apply({ type: "delete-host", id: b, expectedRevision: s.rev(b) }), []);
  // Domain check directly.
  const hosts = new Map([["x", { id: "x", jumpHostId: "y", proxy: null }], ["y", { id: "y", jumpHostId: "x", proxy: null }]]);
  assert.equal(hostChainProblem(hosts.get("x")!, hosts), "jump-cycle");
  // The database refuses a jump host together with a proxy even if every check above were bypassed.
  s.repo.close();
  const db = new DatabaseSync(s.path);
  t.after(() => db.close());
  assert.throws(() => db.prepare("UPDATE host SET jumpHostId=?, proxyType='http', proxyHost='p.example', proxyPort=1 WHERE id=?").run(a, c), /CHECK/u);
  assert.throws(() => db.prepare("UPDATE host SET jumpHostId=id WHERE id=?").run(c), /CHECK/u);
  assert.throws(() => db.prepare("UPDATE host SET proxyType='http', proxyHost=NULL, proxyPort=3128 WHERE id=?").run(c), /CHECK/u);
  assert.throws(() => db.prepare("UPDATE host SET proxyType='http', proxyHost='p.example', proxyPort=NULL WHERE id=?").run(c), /CHECK/u);
});

test("schema 2 → 3 adds the jump/proxy columns (existing hosts stay direct) after one backup", async (t) => {
  const s = await fixture(t);
  const a = s.create("A");
  s.repo.close();
  const db = new DatabaseSync(s.path);
  downgradeToSchemaV2(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_info('host') WHERE name='jumpHostId'").get()?.n, 0);
  db.close();
  const repo = value(await openMetadata({ path: s.path }));
  t.after(() => repo.close());
  const snapshot = value(repo.snapshot());
  assert.equal(snapshot.schemaVersion, 4);
  assert.deepEqual(snapshot.hosts.map((row) => [row.id, row.jumpHostId, row.proxy]), [[a, null, null]]);
  assert.equal(readdirSync(s.dir).filter((name) => /\.v2-.*\.backup$/u.test(name)).length, 1);
  // A migrated store accepts chains like a fresh one.
  const b = "00000000-0000-4000-8000-0000000000b1";
  value(repo.commit({ expectedCatalogRevision: snapshot.catalogRevision, changes: [{ type: "create-host", id: b, data: { label: "B", address: "b.example", jumpHostId: a } }] }));
  assert.equal(value(repo.snapshot()).hosts.find((row) => row.id === b)?.jumpHostId, a);
});
