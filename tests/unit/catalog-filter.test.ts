import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CatalogGroup, CatalogHost, CatalogState } from "../../packages/contracts/src/index.ts";
import { queryCatalogHosts, type CatalogHostQuery } from "../../packages/domain/src/catalog.ts";
import type { Entity, Group, Host, MetadataSnapshot, Tag } from "../../packages/domain/src/index.ts";
import {
  endpointText,
  filterCatalogHosts,
  groupOptions,
  groupPath,
  groupTree,
  memberDefaults,
  provenance,
  type CatalogFilter,
} from "../../apps/desktop/src/renderer/src/lib/catalog-filter.ts";
import {
  groupDraft,
  groupErrors,
  groupIntent,
  hostDraft,
  hostErrors,
  hostIntent,
  rebaseDraft,
  serverFieldErrors,
} from "../../apps/desktop/src/renderer/src/lib/catalog-validation.ts";

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const stamp = "2026-10-17T00:00:00.000Z";
const entity = (n: number, revision = 1): Entity => ({ id: id(n), vaultId: id(1), revision, createdAt: stamp, updatedAt: stamp });
const group = (n: number, label: string, parentId: string | null = null, port: Group["port"] = { mode: "inherit" }): Group =>
  ({ ...entity(n), label, parentId, port, auth: { mode: "inherit" } });
const host = (n: number, label: string, groupId: string | null, address = `host-${n}.test`, extra: Partial<Host> = {}): Host =>
  ({ ...entity(n), label, address, groupId, environment: null, port: { mode: "inherit" }, auth: { mode: "inherit" }, ...extra });
const tag = (n: number, label: string): Tag => ({ ...entity(n), label, normalizedName: label.trim().normalize("NFC").toLowerCase() });

function snapshot(): MetadataSnapshot {
  return {
    schemaVersion: 1,
    catalogRevision: 9,
    vault: { ...entity(1), label: "Owned filter fixture", contentKeyRef: null, protectionFormat: null },
    settings: {
      ...entity(2), theme: "dark", uiFont: "Inter", uiFontSize: 13, terminalFont: "JetBrains Mono", terminalFontSize: 14,
      terminalScrollback: 10000, terminalPalette: "signal-blue-dark", terminalCursor: "block", terminalCursorBlink: false,
      reducedMotion: "system",
    },
    groups: [
      { ...group(10, "Infrastructure", null, { mode: "value", port: 2222 }), auth: { mode: "value", identityId: id(40) } },
      group(11, "ประเทศไทย", id(10)),
      group(12, "Production", id(11)),
      group(13, "elsewhere"),
    ],
    hosts: [
      host(20, "Ungrouped", null, "10.0.0.20"),
      host(21, "root host", id(10)),
      host(22, "เครื่องไทย", id(12), "db.ไทย.test"),
      host(23, "Override", id(12), "override.test", { auth: { mode: "clear" } }),
      host(24, "Other tree", id(13)),
      // NFD label; same NFC text as tag "Café".
      host(25, "Café box", null, "cafe.test"),
      host(26, "ROOT HOST", id(10)),
    ],
    identities: [
      { ...entity(40), label: "Lab password", username: "Alice", method: "password", passwordRef: null, keyId: null },
    ],
    keys: [],
    secretRefs: [],
    tags: [tag(30, "Prod"), tag(31, "ฐานข้อมูล"), tag(32, "Café")],
    hostTags: [
      { vaultId: id(1), hostId: id(22), tagId: id(30) },
      { vaultId: id(1), hostId: id(22), tagId: id(31) },
      { vaultId: id(1), hostId: id(23), tagId: id(30) },
      { vaultId: id(1), hostId: id(20), tagId: id(32) },
    ],
    snippets: [],
    snippetTags: [],
    knownHosts: [],
    tunnelRules: [],
    secretOperations: [],
  };
}

const source = (s: { kind: string; id?: string }) =>
  s.kind === "group" ? { kind: "group" as const, id: s.id! } : { kind: s.kind as "default" | "host" };
/** A test projection built from the domain query, so the parity check depends only on resolved data. */
function project(meta: MetadataSnapshot): Pick<CatalogState, "hosts" | "tags" | "identities"> {
  const views = queryCatalogHosts(meta, { scope: { kind: "all" } });
  assert.ok(views.ok);
  const hosts: CatalogHost[] = views.value.map(({ host, tags, config }) => ({
    id: host.id, revision: host.revision, label: host.label, address: host.address, groupId: host.groupId,
    environment: host.environment, port: host.port, auth: host.auth, tagIds: tags.map((t) => t.id),
    ancestry: config.ancestry.map(({ id, label }) => ({ id, label })),
    effective: {
      port: config.port.value, portSource: source(config.port.source), authSelection: config.auth.selection,
      identityId: config.auth.identity?.id ?? null, authSource: source(config.auth.source),
    },
  }));
  // Shuffled input proves the renderer sorts on its own.
  hosts.reverse();
  return {
    hosts,
    tags: meta.tags.map(({ id, revision, label }) => ({ id, revision, label })),
    identities: meta.identities.map(({ id, label, username, method }) => ({ id, label, username, method })),
  };
}

test("renderer host filter matches the domain query for scope, AND tags, NFC/case/Thai search and order", () => {
  const meta = snapshot();
  const state = project(meta);
  const cases: CatalogFilter[] = [];
  const scopes: CatalogFilter["scope"][] = [
    { kind: "all" }, { kind: "ungrouped" }, { kind: "group", groupId: id(10) }, { kind: "group", groupId: id(11) },
    { kind: "group", groupId: id(12) }, { kind: "group", groupId: id(13) },
  ];
  const searches = ["", "  ROOT ", "ไทย", "ประเทศ", "café", "café", "CAFÉ", "alice", "10.0.0", "ฐาน", "prod", "nothing-matches"];
  const tagSets = [[], [id(30)], [id(30), id(31)], [id(32)]];
  for (const scope of scopes) for (const search of searches) for (const tagIds of tagSets) cases.push({ scope, search, tagIds });
  let nonEmpty = 0;
  for (const filter of cases) {
    const query: CatalogHostQuery = {
      scope: filter.scope.kind === "group" ? { ...filter.scope, includeDescendants: true } : filter.scope,
      search: filter.search,
      tagIds: [...filter.tagIds],
    };
    const expected = queryCatalogHosts(meta, query);
    assert.ok(expected.ok);
    const actual = filterCatalogHosts(state, filter).map((h) => h.id);
    assert.deepEqual(actual, expected.value.map((v) => v.host.id), JSON.stringify(filter));
    if (actual.length) nonEmpty++;
  }
  assert.ok(nonEmpty > 40);
  // Spot checks of the behaviours the parity covers.
  const ids = (filter: Partial<CatalogFilter>) =>
    filterCatalogHosts(state, { scope: { kind: "all" }, search: "", tagIds: [], ...filter }).map((h) => h.label);
  assert.deepEqual(ids({ search: "café" }), ["Café box", "Ungrouped"]);
  assert.deepEqual(ids({ search: "alice" }), ["root host", "ROOT HOST", "เครื่องไทย"]);
  assert.deepEqual(ids({ tagIds: [id(30), id(31)] }), ["เครื่องไทย"]);
  assert.deepEqual(ids({ scope: { kind: "group", groupId: id(11) } }), ["Override", "เครื่องไทย"]);
});

const catalogGroup = (n: number, label: string, parentId: string | null, extra: Partial<CatalogGroup> = {}): CatalogGroup => ({
  id: id(n), revision: 1, label, parentId, port: { mode: "inherit" }, auth: { mode: "inherit" },
  inherited: { port: 22, portSource: { kind: "default" }, authSelection: "none", identityId: null, authSource: { kind: "default" } },
  ...extra,
});

test("group tree orders by normalized label, excludes a moved subtree and builds paths", () => {
  const groups = [
    catalogGroup(13, "beta", null), catalogGroup(10, "Alpha", null), catalogGroup(11, "ไทย", id(10)),
    catalogGroup(12, "child", id(11)), catalogGroup(14, "alpha", null),
  ];
  const tree = groupTree(groups);
  assert.deepEqual(groupOptions(tree).map((o) => [o.label, o.depth]), [
    ["Alpha", 0], ["ไทย", 1], ["child", 2], ["alpha", 0], ["beta", 0],
  ]);
  assert.deepEqual(groupOptions(tree, id(11)).map((o) => o.label), ["Alpha", "alpha", "beta"]);
  assert.deepEqual(groupOptions(tree).map((o) => o.path), ["Alpha", "Alpha / ไทย", "Alpha / ไทย / child", "alpha", "beta"]);
  assert.deepEqual(groupPath(new Map(groups.map((g) => [g.id, g])), id(12)), ["Alpha", "ไทย", "child"]);
  assert.deepEqual(groupPath(new Map(), null), []);
});

test("provenance text and member defaults", () => {
  const parent = catalogGroup(10, "ราก", null, { port: { mode: "value", port: 2222 } });
  const child = catalogGroup(11, "Child", id(10), {
    auth: { mode: "clear" },
    inherited: { port: 2222, portSource: { kind: "group", id: id(10) }, authSelection: "none", identityId: null, authSource: { kind: "default" } },
  });
  const groups = new Map([parent, child].map((g) => [g.id, g]));
  assert.equal(provenance({ kind: "host" }, groups), "set on this server");
  assert.equal(provenance({ kind: "group", id: id(10) }, groups), "from group ราก");
  assert.equal(provenance({ kind: "group", id: id(10) }, groups, id(10)), "set on this group");
  assert.equal(provenance({ kind: "default" }, groups), "default");
  assert.deepEqual(memberDefaults(undefined).port, 22);
  const member = memberDefaults(child);
  assert.deepEqual([member.port, member.portSource, member.authSelection, member.authSource], [
    2222, { kind: "group", id: id(10) }, "clear", { kind: "group", id: id(11) },
  ]);
  assert.deepEqual(memberDefaults(parent).portSource, { kind: "group", id: id(10) });
});

test("drafts validate trivial rules the way main does", () => {
  assert.deepEqual(hostErrors(hostDraft()), {
    label: "Enter a name.",
    address: "Enter a host name or IP address.",
  });
  const draft = { ...hostDraft(), label: "  เซิร์ฟเวอร์  ", address: "db.test", portMode: "value" as const, port: "0" };
  assert.deepEqual(Object.keys(hostErrors(draft)), ["port"]);
  assert.deepEqual(hostErrors({ ...draft, port: "65535" }), {});
  assert.ok(hostErrors({ ...draft, port: "65536" }).port);
  assert.ok(hostErrors({ ...draft, port: "22.5" }).port);
  assert.ok(hostErrors({ ...draft, address: "root@db.test" }).address);
  assert.ok(hostErrors({ ...draft, address: "db test" }).address);
  assert.ok(hostErrors({ ...draft, label: "a\u0007" }).label);
  assert.deepEqual(hostErrors({ ...draft, label: "ก".repeat(200) }), { port: hostErrors(draft).port });
  assert.ok(hostErrors({ ...draft, label: "😀".repeat(201) }).label);
  // Inherit ignores a stale custom value.
  assert.deepEqual(groupErrors({ ...groupDraft(), label: "G", portMode: "inherit", port: "x" }), {});
  assert.deepEqual(
    serverFieldErrors([{ field: "label", code: "duplicate" }, { field: "label", code: "empty" }, { field: "parent", code: "cycle" }]),
    { label: "That name is already used.", parent: "A group cannot move inside itself or its subgroups." },
  );
});

test("draft → intent sends trimmed creates and only changed fields on update", () => {
  const created = hostIntent({ ...hostDraft(undefined, id(10)), label: " web ", address: " web.test ", environment: "PROD", auth: id(40) });
  assert.deepEqual(created, {
    type: "create-host",
    data: {
      label: "web", address: "web.test", groupId: id(10), environment: "PROD",
      port: { mode: "inherit" }, auth: { mode: "value", identityId: id(40) },
    },
  });
  const base: CatalogHost = {
    id: id(20), revision: 4, label: "web", address: "web.test", groupId: null, environment: null,
    port: { mode: "value", port: 2022 }, auth: { mode: "clear" }, tagIds: [], ancestry: [],
    effective: { port: 2022, portSource: { kind: "host" }, authSelection: "clear", identityId: null, authSource: { kind: "host" } },
  };
  const unchanged = hostDraft(base);
  assert.equal(unchanged.port, "2022");
  assert.equal(hostIntent(unchanged, base), undefined);
  assert.deepEqual(hostIntent({ ...unchanged, portMode: "inherit", auth: "inherit", label: "web " }, base), {
    type: "update-host", id: id(20), expectedRevision: 4,
    data: { port: { mode: "inherit" }, auth: { mode: "inherit" } },
  });
  const g = catalogGroup(11, "Child", id(10));
  assert.equal(groupIntent(groupDraft(g), g), undefined);
  assert.deepEqual(groupIntent({ ...groupDraft(g), parentId: null }, g), {
    type: "update-group", id: id(11), expectedRevision: 1, data: { parentId: null },
  });
  assert.deepEqual(groupIntent({ ...groupDraft(undefined, id(10)), label: "New", portMode: "value", port: "2200" }), {
    type: "create-group",
    data: { label: "New", parentId: id(10), port: { mode: "value", port: 2200 }, auth: { mode: "inherit" } },
  });
});

test("a conflict reload keeps edited fields and takes the rest from the latest entity", () => {
  const opened = { label: "web", address: "a.test", port: "" };
  const edited = { ...opened, label: "web-1" };
  const latest = { label: "web", address: "b.test", port: "2200" };
  assert.deepEqual(rebaseDraft(edited, opened, latest), { label: "web-1", address: "b.test", port: "2200" });
});

test("endpoint text brackets IPv6 addresses only", () => {
  assert.equal(endpointText("::1", 22), "[::1]:22");
  assert.equal(endpointText("fd00::10", 2222, "deploy"), "deploy@[fd00::10]:2222");
  assert.equal(endpointText("10.0.0.5", 22, null), "10.0.0.5:22");
  assert.equal(endpointText("web-1.example.test", 22, "root"), "root@web-1.example.test:22");
});
