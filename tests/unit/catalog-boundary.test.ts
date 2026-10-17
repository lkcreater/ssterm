import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createCatalogController, registerCatalogHandlers, catalogChannels } from "../../apps/desktop/src/main/catalog-controller.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { CatalogModule, SecretService, TransientSecrets } from "../../packages/services/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import type { MetadataChange, StoreResult } from "../../packages/domain/src/index.ts";
import {
  channels, failure, isCatalogChangeIntent, isCatalogPrepareResponse, isCatalogState, isPrepareCatalogChangeRequest,
  isApplyCatalogChangeRequest, isConnectHostRequest, validateCatalogLabel, validatePort, MAX_CATALOG_ITEMS,
  type CatalogChangeIntent, type CatalogPrepareResponse, type CatalogState, type Owner, type Result,
} from "../../packages/contracts/src/index.ts";
import { MemorySecretProvider } from "../fixtures/secrets/memory-provider.ts";

const owner = { windowId: 1, generation: 1 };
const other = { windowId: 2, generation: 1 };
const id = () => randomUUID();
function value<T>(result: StoreResult<T> | Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync("/private/tmp/ssterm-catalog-boundary-");
  const repo = value(await openMetadata({ path: join(dir, "catalog.sqlite") }));
  const transient = new TransientSecrets();
  const secrets = new SecretService({ repository: repo, provider: new MemorySecretProvider(), transient });
  let now = 1_000;
  const catalog = new CatalogModule({ repository: repo, now: () => now });
  const controller = createCatalogController({ repository: repo, catalog });
  const sent = new Map<string, CatalogState[]>([["owner", []], ["other", []]]);
  controller.register(owner, (state) => sent.get("owner")!.push(state));
  controller.register(other, (state) => sent.get("other")!.push(state));
  t.after(() => {
    controller.dispose();
    transient.purgeAll();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const snapshot = () => value(repo.snapshot());
  const commit = (changes: MetadataChange[]) =>
    value(repo.commit({ expectedCatalogRevision: snapshot().catalogRevision, changes }));
  const prepare = (intent: CatalogChangeIntent, who: Owner = owner) => value(controller.prepareCatalogChange({ owner: who, intent }));
  const preview = (intent: CatalogChangeIntent, who: Owner = owner) => {
    const result = prepare(intent, who);
    assert.ok(isCatalogPrepareResponse(result));
    if (result.kind !== "preview") assert.fail(JSON.stringify(result));
    return result;
  };
  const apply = (intent: CatalogChangeIntent, who: Owner = owner) =>
    value(controller.applyCatalogChange({ owner: who, token: preview(intent, who).token }));
  const create = (intent: CatalogChangeIntent) => apply(intent).createdIds[0]!;
  const state = (who: Owner = owner) => value(controller.catalogState(who));
  return { repo, secrets, catalog, controller, sent, snapshot, commit, prepare, preview, apply, create, state, advance: (ms: number) => { now += ms; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const invalid = (result: CatalogPrepareResponse) => {
  assert.ok(isCatalogPrepareResponse(result));
  return result.kind === "invalid" ? result.fields : assert.fail(JSON.stringify(result));
};

test("catalog contracts: shared validators, exact intent subset, caps and request shapes", () => {
  for (const [text, code] of [
    ["", "empty"], ["   ", "empty"], [" Lab ", null], ["ก".repeat(200), null], ["😀".repeat(200), null], ["a".repeat(201), "too-long"],
    ["a\u0007b", "control"], ["a\u007fb", "control"], [" ห้องแล็บ\n", null],
  ] as const) assert.equal(validateCatalogLabel(text), code, JSON.stringify(text));
  for (const port of [1, 22, 65_535]) assert.ok(validatePort(port));
  for (const port of [0, 65_536, 1.5, "22", Number.NaN, null]) assert.equal(validatePort(port), false, String(port));

  const host = id(), group = id(), tag = id(), identity = id();
  const valid: CatalogChangeIntent[] = [
    { type: "create-host", data: { label: "Web", address: "web.example" } },
    { type: "create-host", data: { label: "Web", address: "x", groupId: null, environment: "PROD", port: { mode: "value", port: 0.5 }, auth: { mode: "value", identityId: identity } } },
    { type: "update-host", id: host, expectedRevision: 1, data: { port: { mode: "inherit" } } },
    { type: "delete-host", id: host, expectedRevision: 1 },
    { type: "create-group", data: { label: "G", parentId: group, auth: { mode: "clear" } } },
    { type: "update-group", id: group, expectedRevision: 2, data: { parentId: null } },
    { type: "delete-group", id: group, expectedRevision: 1, disposition: { mode: "subtree" } },
    { type: "delete-group", id: group, expectedRevision: 1, disposition: { mode: "reparent", parentId: null } },
    { type: "create-tag", data: { label: "prod" } },
    { type: "delete-tag", id: tag, expectedRevision: 1 },
    { type: "set-host-tag", hostId: host, tagId: tag, present: true, expectedHostRevision: 1 },
  ];
  for (const intent of valid) assert.ok(isCatalogChangeIntent(intent), JSON.stringify(intent));
  for (const intent of [
    { type: "create-identity", data: { label: "L", username: "u", method: "password" } },
    { type: "create-identity", data: { label: "L", username: "u", method: "key", keyId: id() } },
    { type: "update-identity", id: identity, expectedRevision: 1, data: { label: "L" } },
    { type: "update-identity", id: identity, expectedRevision: 1, data: {}, forgetPassword: true },
    { type: "update-identity", id: identity, expectedRevision: 1, data: { method: "keyboard-interactive" }, forgetPassword: false },
    { type: "delete-identity", id: identity, expectedRevision: 1, disposition: { mode: "detach" } },
    { type: "delete-identity", id: identity, expectedRevision: 1, disposition: { mode: "reassign", identityId: id() } },
  ] as CatalogChangeIntent[]) assert.ok(isCatalogChangeIntent(intent), JSON.stringify(intent));
  for (const intent of [
    { type: "create-identity", data: { label: "L", username: "u" } },
    { type: "create-identity", data: { label: "L", username: "u", method: "password", passwordRef: id() } },
    { type: "create-identity", data: { label: "L", username: "u", method: "agent" } },
    { type: "update-identity", id: identity, expectedRevision: 1, data: {} },
    { type: "update-identity", id: identity, expectedRevision: 1, data: {}, forgetPassword: false },
    { type: "update-identity", id: identity, expectedRevision: 1, data: { label: "L" }, forgetPassword: "yes" },
    { type: "delete-identity", id: identity, expectedRevision: 1 },
    { type: "delete-identity", id: identity, expectedRevision: 1, disposition: { mode: "reassign" } },
    { type: "delete-identity", id: identity, expectedRevision: 1, disposition: { mode: "detach", identityId: id() } },
    { type: "update-tag", id: tag, expectedRevision: 1, data: { label: "x" } },
    { type: "create-host", data: { label: "Web" } },
    { type: "create-host", data: { label: "Web", address: "a", passwordRef: id() } },
    { type: "create-host", data: { label: "Web", address: "a" }, id: host },
    { type: "create-host", data: { label: "Web", address: "a", port: { mode: "value", port: "22" } } },
    { type: "create-host", data: { label: "Web", address: "a", port: { mode: "value" } } },
    { type: "create-host", data: { label: "Web", address: "a", auth: { mode: "value", identityId: "nope" } } },
    { type: "create-host", data: { label: "Web", address: "a", environment: "prod" } },
    { type: "create-host", data: { label: "x".repeat(2049), address: "a" } },
    { type: "update-host", id: host, expectedRevision: 1, data: {} },
    { type: "update-host", id: "host-1", expectedRevision: 1, data: { label: "x" } },
    { type: "update-host", id: host, expectedRevision: 0, data: { label: "x" } },
    { type: "delete-host", id: host, expectedRevision: 1, disposition: { mode: "subtree" } },
    { type: "delete-group", id: group, expectedRevision: 1 },
    { type: "delete-group", id: group, expectedRevision: 1, disposition: { mode: "reparent" } },
    { type: "delete-group", id: group, expectedRevision: 1, disposition: { mode: "subtree", parentId: null } },
    { type: "set-host-tag", hostId: host, tagId: tag, present: "yes", expectedHostRevision: 1 },
    { type: "set-host-tag", hostId: host, tagId: tag, present: true },
    { type: "move-host" }, null, [], "create-host",
  ]) assert.equal(isCatalogChangeIntent(intent), false, JSON.stringify(intent));
  assert.ok(isPrepareCatalogChangeRequest({ owner, intent: valid[0] }));
  assert.equal(isPrepareCatalogChangeRequest({ owner, intent: valid[0], extra: 1 }), false);
  assert.ok(isApplyCatalogChangeRequest({ owner, token: id() }));
  assert.equal(isApplyCatalogChangeRequest({ owner, token: "token" }), false);
  assert.ok(isConnectHostRequest({ owner, hostId: host }));
  for (const request of [{ owner, hostId: "host-1" }, { owner, hostId: host, extra: 1 }, { hostId: host }])
    assert.equal(isConnectHostRequest(request), false);

  const effective = { port: 22, portSource: { kind: "default" }, authSelection: "none", identityId: null, authSource: { kind: "default" } };
  const row = { id: host, revision: 1, label: "Web", address: "web.example", groupId: null, environment: null, port: { mode: "inherit" },
    auth: { mode: "inherit" }, tagIds: [], ancestry: [], effective };
  const secretStatus = { availability: "ready", cleanupPending: false };
  const identityRow = { id: identity, revision: 1, label: "L", username: "u", method: "password", passwordSaved: true, keyId: null, pending: false };
  const keyRow = { id: id(), revision: 1, label: "K", algorithm: "ssh-ed25519", fingerprint: `SHA256:${"a".repeat(43)}`,
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA==", passphraseSaved: false, pending: false };
  const base = { owner, sequence: 0, availability: "ready", revision: 1, truncated: false, hosts: [row], groups: [], tags: [],
    identities: [identityRow], keys: [keyRow], snippets: [{ id: id(), revision: 1, label: "Deploy", tagIds: [] }], tunnelRules: [], secrets: secretStatus, lockEpoch: 0 };
  assert.ok(isCatalogState(base));
  for (const broken of [
    { ...base, hosts: Array(MAX_CATALOG_ITEMS + 1).fill(row) },
    { ...base, hosts: [{ ...row, passwordRef: id() }] },
    { ...base, hosts: [{ ...row, effective: { ...effective, authSelection: "identity" } }] },
    { ...base, hosts: [{ ...row, port: { mode: "value", port: 70_000 } }] },
    { ...base, identities: [{ ...identityRow, passwordRef: null }] },
    { ...base, identities: [{ ...identityRow, method: "key" }] },
    { ...base, identities: [{ ...identityRow, method: "keyboard-interactive", passwordSaved: true }] },
    { ...base, keys: [{ ...keyRow, algorithm: "ecdsa-sha2-nistp256" }] },
    { ...base, keys: [{ ...keyRow, publicKey: "ssh-rsa AAAA" }] },
    { ...base, keys: [{ ...keyRow, privateKeyRef: id() }] },
    { ...base, keys: [{ ...keyRow, fingerprint: "MD5:aa" }] },
    { ...base, secrets: { availability: "ready" } },
    { ...base, secrets: undefined },
    { ...base, snippets: [{ id: id(), revision: 1, label: "Deploy", tagIds: [], body: "echo" }] },
    { ...base, snippets: [{ id: id(), revision: 1, label: "Deploy", tagIds: [], bodyEnvelope: "x" }] },
    { ...base, snippets: [{ id: id(), revision: 0, label: "Deploy", tagIds: [] }] },
    { ...base, lockEpoch: -1 },
    { ...base, lockEpoch: undefined },
    { ...base, extra: true },
  ]) assert.equal(isCatalogState(broken), false);
});

async function seed(s: Fixture) {
  const savedId = id();
  const stored = await s.secrets.storeSecret({
    kind: "password",
    owner: { type: "identity", id: savedId, expectedRevision: null },
    value: new TextEncoder().encode("fixture-boundary-password"),
    publish: (ref) => [{ type: "create-identity", id: savedId, data: { label: "Lab login", username: "alice", method: "password", passwordRef: ref } }],
  });
  assert.equal(stored.status, "published");
  const root = s.create({ type: "create-group", data: { label: "ราก Root", port: { mode: "value", port: 2222 }, auth: { mode: "value", identityId: savedId } } });
  const child = s.create({ type: "create-group", data: { label: "Child", parentId: root } });
  const inherited = s.create({ type: "create-host", data: { label: "Inherits", address: "inherit.example", groupId: child, environment: "PROD" } });
  const overridden = s.create({ type: "create-host", data: { label: "Overrides", address: "override.example", groupId: child, port: { mode: "value", port: 2200 }, auth: { mode: "clear" } } });
  const loose = s.create({ type: "create-host", data: { label: "Alone", address: "10.0.0.5" } });
  const tag = s.create({ type: "create-tag", data: { label: "prod" } });
  s.apply({ type: "set-host-tag", hostId: inherited, tagId: tag, present: true, expectedHostRevision: 1 });
  return { savedId, root, child, inherited, overridden, loose, tag };
}

test("state maps effective port and auth with provenance, group inherited values and summaries; no reference leaves main", async (t) => {
  const s = await fixture(t);
  const ids = await seed(s);
  const state = s.state();
  assert.ok(isCatalogState(state));
  assert.equal(state.availability, "ready");
  assert.equal(state.revision, s.snapshot().catalogRevision);
  assert.deepEqual(state.hosts.map((host) => host.label), ["Alone", "Inherits", "Overrides"]);
  const [alone, inherits, overrides] = state.hosts;
  assert.deepEqual(inherits, {
    id: ids.inherited, revision: 2, label: "Inherits", address: "inherit.example", groupId: ids.child, environment: "PROD",
    port: { mode: "inherit" }, auth: { mode: "inherit" }, tagIds: [ids.tag],
    ancestry: [{ id: ids.root, label: "ราก Root" }, { id: ids.child, label: "Child" }],
    effective: { port: 2222, portSource: { kind: "group", id: ids.root }, authSelection: "identity", identityId: ids.savedId,
      authSource: { kind: "group", id: ids.root } },
  });
  assert.deepEqual(overrides!.effective, { port: 2200, portSource: { kind: "host" }, authSelection: "clear", identityId: null, authSource: { kind: "host" } });
  assert.deepEqual(alone!.effective, { port: 22, portSource: { kind: "default" }, authSelection: "none", identityId: null, authSource: { kind: "default" } });
  assert.deepEqual(state.groups.map((group) => [group.label, group.inherited]), [
    ["Child", { port: 2222, portSource: { kind: "group", id: ids.root }, authSelection: "identity", identityId: ids.savedId, authSource: { kind: "group", id: ids.root } }],
    ["ราก Root", { port: 22, portSource: { kind: "default" }, authSelection: "none", identityId: null, authSource: { kind: "default" } }],
  ]);
  assert.deepEqual(state.groups[1]!.port, { mode: "value", port: 2222 });
  assert.deepEqual(state.tags, [{ id: ids.tag, revision: 1, label: "prod" }]);
  assert.deepEqual(state.identities, [{
    id: ids.savedId, revision: 1, label: "Lab login", username: "alice", method: "password", passwordSaved: true, keyId: null, pending: false,
  }]);
  assert.deepEqual(state.keys, []);
  assert.deepEqual(state.secrets, { availability: "unavailable", cleanupPending: false }, "no secret store was given to the controller");

  const preview = s.preview({ type: "update-group", id: ids.root, expectedRevision: 1, data: { port: { mode: "value", port: 2022 } } });
  assert.deepEqual(preview.impacts.hosts.map((row) => [row.label, row.effectiveConnectionChanged, row.provenanceChanged, row.removed]).sort(),
    [["Inherits", true, false, false], ["Overrides", false, false, false]]);
  const snapshot = s.snapshot();
  const secrets = [snapshot.vault.id, ...snapshot.secretRefs.map((ref) => ref.id), ...snapshot.secretOperations.map((op) => op.operationId)];
  assert.ok(secrets.length >= 2);
  for (const json of [JSON.stringify(state), JSON.stringify(preview)]) {
    for (const secret of secrets) assert.equal(json.includes(secret), false, "a reference crossed the boundary");
    for (const field of ["passwordRef", "privateKeyRef", "passphraseRef", "vaultId", "operationId", "cleanupRefIds", "before", "after", "createdAt"])
      assert.equal(json.includes(`"${field}"`), false, field);
  }
});

test("previews are bound to one owner, one at a time, and discarded on revoke", async (t) => {
  const s = await fixture(t);
  const intent: CatalogChangeIntent = { type: "create-tag", data: { label: "a" } };
  const first = s.preview(intent);
  assert.deepEqual(s.controller.applyCatalogChange({ owner: other, token: first.token }), failure("conflict"), "another owner cannot apply it");
  const second = s.preview({ type: "create-tag", data: { label: "b" } });
  assert.deepEqual(s.controller.applyCatalogChange({ owner, token: first.token }), failure("conflict"), "a newer prepare supersedes it");
  assert.equal(s.catalog.apply(first.token).ok, false, "the superseded plan is gone from the module too");
  assert.ok(s.controller.applyCatalogChange({ owner, token: second.token }).ok);
  assert.deepEqual(s.state().tags.map((tag) => tag.label), ["b"]);

  const replaced = s.preview({ type: "create-tag", data: { label: "c" } });
  invalid(s.prepare({ type: "create-tag", data: { label: "" } }));
  assert.deepEqual(s.controller.applyCatalogChange({ owner, token: replaced.token }), failure("conflict"), "a refused prepare also drops the old preview");

  const pending = s.preview({ type: "create-tag", data: { label: "d" } });
  s.controller.revokeOwner(owner);
  assert.equal(s.catalog.apply(pending.token).ok, false);
  assert.deepEqual(s.controller.catalogState(owner), failure("stale-owner"));
  assert.deepEqual(s.controller.prepareCatalogChange({ owner, intent }), failure("stale-owner"));
  assert.deepEqual(s.controller.applyCatalogChange({ owner, token: pending.token }), failure("stale-owner"));
  assert.ok(s.controller.catalogState(other).ok, "other owners are unaffected");
});

test("main reports fixable field errors and refuses stale targets as conflicts", async (t) => {
  const s = await fixture(t);
  const ids = await seed(s);
  const fields = (intent: CatalogChangeIntent) => invalid(s.prepare(intent));
  assert.deepEqual(fields({ type: "create-host", data: { label: " ", address: "bad host" } }), [{ field: "label", code: "empty" }, { field: "address", code: "invalid" }]);
  assert.deepEqual(fields({ type: "create-host", data: { label: "x\u0001", address: "a".repeat(1025) } }), [{ field: "label", code: "control" }, { field: "address", code: "too-long" }]);
  for (const address of ["user@host", "host/path", "[::1", "1.2.3", "a..b"])
    assert.deepEqual(fields({ type: "create-host", data: { label: "x", address } }), [{ field: "address", code: "invalid" }], address);
  assert.deepEqual(fields({ type: "create-host", data: { label: "x".repeat(201), address: "ok.example", port: { mode: "value", port: 0 } } }),
    [{ field: "label", code: "too-long" }, { field: "port", code: "invalid" }]);
  assert.deepEqual(fields({ type: "update-host", id: ids.loose, expectedRevision: 1, data: { port: { mode: "value", port: 22.5 } } }), [{ field: "port", code: "invalid" }]);
  assert.deepEqual(fields({ type: "update-host", id: ids.loose, expectedRevision: 1, data: { groupId: id(), auth: { mode: "value", identityId: id() } } }),
    [{ field: "identity", code: "not-found" }, { field: "group", code: "not-found" }]);
  assert.deepEqual(fields({ type: "create-tag", data: { label: " PROD " } }), [{ field: "label", code: "duplicate" }]);
  s.apply({ type: "create-tag", data: { label: "e\u0301" } });
  assert.deepEqual(fields({ type: "create-tag", data: { label: "\u00e9" } }), [{ field: "label", code: "duplicate" }], "NFC-equal labels are duplicates");
  assert.deepEqual(fields({ type: "update-group", id: ids.root, expectedRevision: 1, data: { parentId: ids.child } }), [{ field: "parent", code: "cycle" }]);
  assert.deepEqual(fields({ type: "update-group", id: ids.root, expectedRevision: 1, data: { parentId: ids.root } }), [{ field: "parent", code: "cycle" }]);
  assert.deepEqual(fields({ type: "create-group", data: { label: "G", parentId: id() } }), [{ field: "parent", code: "not-found" }]);
  assert.deepEqual(fields({ type: "delete-group", id: ids.root, expectedRevision: 1, disposition: { mode: "reparent", parentId: ids.child } }), [{ field: "parent", code: "cycle" }]);
  assert.deepEqual(fields({ type: "set-host-tag", hostId: ids.loose, tagId: id(), present: true, expectedHostRevision: 1 }), [{ field: "tag", code: "not-found" }]);

  for (const intent of [
    { type: "update-host", id: ids.loose, expectedRevision: 9, data: { label: "x" } },
    { type: "delete-host", id: id(), expectedRevision: 1 },
    { type: "delete-tag", id: ids.tag, expectedRevision: 2 },
    { type: "set-host-tag", hostId: ids.loose, tagId: ids.tag, present: true, expectedHostRevision: 2 },
  ] as CatalogChangeIntent[]) assert.deepEqual(s.controller.prepareCatalogChange({ owner, intent }), failure("conflict"), intent.type);
  assert.deepEqual(s.controller.prepareCatalogChange({ owner, intent: { type: "create-identity" } as never }), failure("invalid-request"));
  assert.deepEqual(s.controller.prepareCatalogChange({ owner, intent: { type: "update-identity", id: ids.savedId, expectedRevision: 2, data: { label: "x" } } }),
    failure("conflict"));
  assert.equal(s.snapshot().hosts.length, 3, "nothing was applied");
});

test("apply refuses stale revisions, expired and consumed tokens as conflict; group deletes report counts", async (t) => {
  const s = await fixture(t);
  const ids = await seed(s);
  const stale = s.preview({ type: "update-host", id: ids.loose, expectedRevision: 1, data: { label: "Renamed" } });
  s.commit([{ type: "update-host", id: ids.loose, expectedRevision: 1, data: { label: "Elsewhere" } }]);
  assert.deepEqual(s.controller.applyCatalogChange({ owner, token: stale.token }), failure("conflict"));

  const expired = s.preview({ type: "create-tag", data: { label: "later" } });
  s.advance(5 * 60_000);
  assert.deepEqual(s.controller.applyCatalogChange({ owner, token: expired.token }), failure("conflict"));

  const once = s.preview({ type: "create-tag", data: { label: "once" } });
  assert.ok(s.controller.applyCatalogChange({ owner, token: once.token }).ok);
  assert.deepEqual(s.controller.applyCatalogChange({ owner, token: once.token }), failure("conflict"));

  const subtree = s.preview({ type: "delete-group", id: ids.root, expectedRevision: 1, disposition: { mode: "subtree" } });
  assert.deepEqual(subtree.impacts.removedGroupIds.sort(), [ids.root, ids.child].sort());
  assert.deepEqual(subtree.impacts.removedHostIds.sort(), [ids.inherited, ids.overridden].sort());
  assert.equal(subtree.impacts.removedHostTags, 1);
  assert.ok(subtree.impacts.hosts.filter((row) => row.removed).length === 2);
  const applied = value(s.controller.applyCatalogChange({ owner, token: subtree.token }));
  assert.deepEqual(applied.createdIds, []);
  assert.equal(applied.revision, s.snapshot().catalogRevision);
  assert.deepEqual(s.state().hosts.map((host) => host.label), ["Elsewhere"]);
});

test("every registered owner receives the new state after an apply, in increasing sequence", async (t) => {
  const s = await fixture(t);
  assert.equal(s.state().sequence, 0);
  s.preview({ type: "create-tag", data: { label: "not yet" } });
  assert.deepEqual([s.sent.get("owner")!.length, s.sent.get("other")!.length], [0, 0], "a preview publishes nothing");
  const first = s.apply({ type: "create-tag", data: { label: "one" } });
  const second = s.apply({ type: "create-tag", data: { label: "two" } }, other);
  assert.ok(second.revision > first.revision);
  for (const [name, who] of [["owner", owner], ["other", other]] as const) {
    const states = s.sent.get(name)!;
    assert.deepEqual(states.map((state) => state.sequence), [1, 2]);
    assert.deepEqual(states.map((state) => state.revision), [first.revision, second.revision]);
    assert.deepEqual(states.map((state) => state.owner), [who, who]);
    assert.ok(states.every(isCatalogState));
  }
  assert.deepEqual(s.sent.get("owner")!.at(-1)!.tags.map((tag) => tag.label), ["one", "two"]);
  const stale = s.preview({ type: "create-tag", data: { label: "four" } });
  s.commit([{ type: "create-tag", id: id(), data: { label: "three" } }]);
  assert.deepEqual(s.controller.applyCatalogChange({ owner, token: stale.token }), failure("conflict"));
  assert.equal(s.sent.get("owner")!.length, 2, "a refused apply publishes nothing");
  assert.equal(s.state().sequence, 2);
});

test("an unreadable repository yields an unavailable state and no previews; truncation is flagged per kind", async (t) => {
  for (const snapshot of [() => ({ ok: false as const, error: { code: "io" as const, message: "x" } }), () => { throw new Error("/private/path"); }]) {
    const controller = createCatalogController({ repository: { snapshot }, catalog: { prepare: () => assert.fail(), apply: () => assert.fail(), discard() {} } });
    controller.register(owner, () => {});
    assert.deepEqual(value(controller.catalogState(owner)),
      { owner, sequence: 0, availability: "unavailable", revision: 0, truncated: false, hosts: [], groups: [], tags: [], identities: [], keys: [], snippets: [], tunnelRules: [],
        secrets: { availability: "unavailable", cleanupPending: false }, lockEpoch: 0 });
    assert.deepEqual(controller.prepareCatalogChange({ owner, intent: { type: "create-tag", data: { label: "x" } } }), failure("unavailable"));
  }
  const s = await fixture(t);
  for (let batch = 0; batch * 1000 <= MAX_CATALOG_ITEMS; batch++)
    s.commit(Array.from({ length: 1000 }, (_, i) => ({ type: "create-tag" as const, id: id(), data: { label: `t${batch * 1000 + i}` } })));
  const state = s.state();
  assert.equal(state.truncated, true);
  assert.equal(state.tags.length, MAX_CATALOG_ITEMS);
});

test("catalog IPC requires the owning main frame, one argument and a valid request, and pushes to the sender", async (t) => {
  const s = await fixture(t);
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const pushed: { channel: string; value: unknown }[] = [];
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send: (channel: string, value: unknown) => pushed.push({ channel, value }) };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  const window = owner;
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  let current: typeof s.controller | undefined = s.controller;
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } } satisfies Pick<IpcMain, "handle" | "removeHandler">;
  const unregister = registerCatalogHandlers({ ipc, boundary, controller: () => current });
  const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event as IpcMainInvokeEvent, ...args) as Result<unknown>;
  const event = { sender, senderFrame: mainFrame };
  const intent: CatalogChangeIntent = { type: "create-tag", data: { label: "ipc" } };
  try {
    assert.deepEqual([...handlers.keys()].sort(), [...catalogChannels].sort());
    assert.deepEqual([...catalogChannels].sort(), [channels.applyCatalogChange, channels.catalogState, channels.prepareCatalogChange].sort());
    for (const channel of catalogChannels) {
      const request: Record<string, unknown> = channel === channels.catalogState ? { owner: window } : channel === channels.prepareCatalogChange ? { owner: window, intent } : { owner: window, token: id() };
      assert.deepEqual(invoke(channel, { sender: { ...sender }, senderFrame: mainFrame }, request), failure("unauthorized"));
      assert.deepEqual(invoke(channel, { sender, senderFrame: { url: mainFrame.url } }, request), failure("unauthorized"));
      assert.deepEqual(invoke(channel, event, { ...request, owner: { windowId: 2, generation: 1 } }), failure("unauthorized"));
      assert.deepEqual(invoke(channel, event, { ...request, owner: { ...window, generation: 99 } }), failure("stale-owner"));
      assert.deepEqual(invoke(channel, event, request, request), failure("invalid-request"));
      assert.deepEqual(invoke(channel, event, { ...request, extra: 1 }), failure("invalid-request"));
    }
    assert.deepEqual(invoke(channels.catalogState, event), failure("invalid-request"));
    const state = value(invoke(channels.catalogState, event, { owner: window }) as Result<CatalogState>);
    assert.equal(state.availability, "ready");
    const prepared = value(invoke(channels.prepareCatalogChange, event, { owner: window, intent }) as Result<CatalogPrepareResponse>);
    assert.equal(prepared.kind, "preview");
    if (prepared.kind !== "preview") return;
    assert.ok(invoke(channels.applyCatalogChange, event, { owner: window, token: prepared.token }).ok);
    const changes = pushed.filter((entry) => entry.channel === channels.catalogStateChanged).map((entry) => entry.value as CatalogState);
    assert.deepEqual(changes.map((change) => change.tags.map((tag) => tag.label)), [["ipc"]]);
    current = undefined;
    assert.deepEqual(invoke(channels.catalogState, event, { owner: window }), failure("unavailable"));
  } finally {
    unregister();
    assert.equal(handlers.size, 0);
    boundary.dispose();
  }
});
