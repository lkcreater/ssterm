import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  catalogGroupTree,
  queryCatalogHosts,
  resolveHostConfig,
  type CatalogHostQuery,
} from "../../packages/domain/src/catalog.ts";
import type {
  Entity,
  Group,
  Host,
  Identity,
  KeyMetadata,
  MetadataSnapshot,
  StoreResult,
  Tag,
} from "../../packages/domain/src/index.ts";

const id = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const stamp = "2026-10-15T00:00:00.000Z";
function entity(n: number, revision = 1): Entity {
  return {
    id: id(n),
    vaultId: id(1),
    revision,
    createdAt: stamp,
    updatedAt: stamp,
  };
}
function group(
  n: number,
  label: string,
  parentId: string | null = null,
): Group {
  return {
    ...entity(n),
    label,
    parentId,
    port: { mode: "inherit" },
    auth: { mode: "inherit" },
  };
}
function host(n: number, label: string, groupId: string | null = null): Host {
  return {
    ...entity(n),
    label,
    address: `host-${n}.test`,
    groupId,
    jumpHostId: null,
    proxy: null,
    environment: null,
    port: { mode: "inherit" },
    auth: { mode: "inherit" },
  };
}
function tag(n: number, label: string): Tag {
  return {
    ...entity(n),
    label,
    normalizedName: label.trim().normalize("NFC").toLowerCase(),
  };
}
function fixture(): MetadataSnapshot {
  return {
    schemaVersion: 1,
    catalogRevision: 17,
    vault: {
      ...entity(1),
      label: "Owned catalog fixture",
      contentKeyRef: null,
      protectionFormat: null,
    },
    settings: {
      ...entity(2),
      theme: "dark",
      uiFont: "Inter",
      uiFontSize: 13,
      terminalFont: "JetBrains Mono",
      terminalFontSize: 14,
      terminalScrollback: 10000,
      terminalPalette: "signal-blue-dark",
      terminalCursor: "block",
      terminalCursorBlink: false,
      reducedMotion: "system",
    },
    groups: [
      {
        ...group(10, "Infrastructure"),
        revision: 3,
        port: { mode: "value", port: 2222 },
        auth: { mode: "value", identityId: id(40) },
      },
      group(11, "ประเทศไทย", id(10)),
      group(12, "Production", id(11)),
      group(13, "Elsewhere"),
    ],
    hosts: [
      host(20, "Ungrouped"),
      host(21, "Root host", id(10)),
      host(22, "เครื่องไทย", id(12)),
      {
        ...host(23, "Override", id(12)),
        port: { mode: "value", port: 2022 },
        auth: { mode: "value", identityId: id(41) },
      },
      host(24, "Other tree", id(13)),
    ],
    identities: [
      {
        ...entity(40, 5),
        label: "Password profile",
        username: "alice",
        method: "password",
        passwordRef: id(60),
        keyId: null,
      },
      {
        ...entity(41, 7),
        label: "Key profile",
        username: "bob",
        method: "key",
        passwordRef: null,
        keyId: id(50),
      },
    ],
    keys: [
      {
        ...entity(50, 4),
        label: "Public fixture metadata",
        algorithm: "ssh-ed25519",
        publicKey: "public-fixture",
        fingerprint: "SHA256:fixture",
        privateKeyRef: id(61),
        passphraseRef: id(62),
      },
    ],
    secretRefs: [
      { ...entity(60), kind: "password", operationId: id(70) },
      { ...entity(61), kind: "private-key", operationId: id(71) },
      { ...entity(62), kind: "passphrase", operationId: id(72) },
    ],
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
function value<T>(outcome: StoreResult<T>): T {
  if (!outcome.ok) assert.fail(JSON.stringify(outcome.error));
  return outcome.value;
}
function fails(
  outcome: StoreResult<unknown>,
  code: "constraint" | "invalid-request",
): void {
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.error.code, code);
    assert.ok(
      !/alice|fixture|SELECT|passwordRef|host-22|00000000/u.test(
        outcome.error.message,
      ),
    );
  }
}
const all = { scope: { kind: "all" } } as const;
function ids(snapshot: MetadataSnapshot, query: CatalogHostQuery): string[] {
  return value(queryCatalogHosts(snapshot, query)).map((row) => row.host.id);
}
function freezeInput<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeInput(child);
    Object.freeze(value);
  }
  return value;
}

test("resolver independently selects nearest port and one complete auth bundle with winning provenance", () => {
  const snapshot = fixture();
  snapshot.groups[1].port = { mode: "value", port: 2200 };
  snapshot.groups[1].revision = 6;
  snapshot.hosts[2].environment = "PROD";
  const actual = value(resolveHostConfig(freezeInput(snapshot), id(22)));
  assert.deepEqual(actual, {
    hostRef: { id: id(22), revision: 1, label: "เครื่องไทย", groupId: id(12) },
    address: "host-22.test",
    environment: "PROD",
    port: { value: 2200, source: { kind: "group", id: id(11), revision: 6 } },
    auth: {
      selection: "identity",
      identity: snapshot.identities[0],
      key: null,
      source: { kind: "group", id: id(10), revision: 3 },
    },
    ancestry: [
      { id: id(10), revision: 3, label: "Infrastructure" },
      { id: id(11), revision: 6, label: "ประเทศไทย" },
      { id: id(12), revision: 1, label: "Production" },
    ],
    catalogRevision: 17,
  });
  const override = value(resolveHostConfig(snapshot, id(23)));
  assert.deepEqual(override.port, {
    value: 2022,
    source: { kind: "host", id: id(23), revision: 1 },
  });
  assert.deepEqual(override.auth, {
    selection: "identity",
    identity: snapshot.identities[1],
    key: snapshot.keys[0],
    source: { kind: "host", id: id(23), revision: 1 },
  });
  assert.equal(override.auth.identity?.passwordRef, null);
  assert.equal(override.auth.identity?.revision, 7);
  assert.equal(override.auth.key?.revision, 4);
});

test("clear stops auth inheritance at host or nearest group while port continues independently", () => {
  const snapshot = fixture();
  snapshot.groups[1].auth = { mode: "clear" };
  let config = value(resolveHostConfig(snapshot, id(22)));
  assert.deepEqual(config.auth, {
    selection: "clear",
    identity: null,
    key: null,
    source: { kind: "group", id: id(11), revision: 1 },
  });
  assert.equal(config.port.value, 2222);
  // A descendant value cuts off the clear, and a host clear cuts off that value.
  assert.equal(
    value(resolveHostConfig(snapshot, id(23))).auth.identity?.id,
    id(41),
  );
  snapshot.hosts[3].auth = { mode: "clear" };
  config = value(resolveHostConfig(snapshot, id(23)));
  assert.deepEqual(config.auth, {
    selection: "clear",
    identity: null,
    key: null,
    source: { kind: "host", id: id(23), revision: 1 },
  });
  assert.equal(config.port.value, 2022);
  snapshot.groups[1].auth = { mode: "inherit" };
  snapshot.groups[2].auth = { mode: "value", identityId: id(41) };
  config = value(resolveHostConfig(snapshot, id(22)));
  assert.equal(config.auth.identity?.username, "bob");
  assert.equal(config.auth.identity?.passwordRef, null);
  assert.equal(config.auth.key?.privateKeyRef, id(61));
});

test("root and ungrouped defaults are explicit and direct metadata never inherits", () => {
  const snapshot = fixture();
  const config = value(resolveHostConfig(snapshot, id(20)));
  assert.deepEqual(config.port, { value: 22, source: { kind: "default" } });
  assert.deepEqual(config.auth, {
    selection: "none",
    identity: null,
    key: null,
    source: { kind: "default" },
  });
  assert.deepEqual(config.ancestry, []);
  assert.equal(value(resolveHostConfig(snapshot, id(24))).port.value, 22);
  assert.deepEqual(
    value(queryCatalogHosts(snapshot, all)).find(
      (row) => row.host.id === id(21),
    )?.tags,
    [],
  );
  assert.equal(value(resolveHostConfig(snapshot, id(22))).environment, null);
  assert.equal(
    value(resolveHostConfig(snapshot, id(22))).address,
    snapshot.hosts[2].address,
  );
});

test("all, ungrouped, direct group and arbitrary-depth descendant scopes stay distinct", () => {
  const snapshot = fixture();
  assert.equal(ids(snapshot, all).length, 5);
  assert.deepEqual(ids(snapshot, { scope: { kind: "ungrouped" } }), [id(20)]);
  assert.deepEqual(
    ids(snapshot, {
      scope: { kind: "group", groupId: id(10), includeDescendants: false },
    }),
    [id(21)],
  );
  assert.deepEqual(
    new Set(
      ids(snapshot, {
        scope: { kind: "group", groupId: id(10), includeDescendants: true },
      }),
    ),
    new Set([id(21), id(22), id(23)]),
  );
  assert.deepEqual(
    new Set(
      ids(snapshot, {
        scope: { kind: "group", groupId: id(11), includeDescendants: true },
      }),
    ),
    new Set([id(22), id(23)]),
  );
  assert.deepEqual(
    ids(snapshot, {
      scope: { kind: "group", groupId: id(11), includeDescendants: false },
    }),
    [],
  );
});

test("search normalizes case/NFC/trim across direct fields, effective username, tags and every ancestor", () => {
  const snapshot = fixture();
  snapshot.hosts[0].label = "Cafe\u0301";
  assert.deepEqual(ids(snapshot, { ...all, search: "  CAFÉ " }), [id(20)]);
  assert.deepEqual(ids(snapshot, { ...all, search: "HOST-22.TEST" }), [id(22)]);
  assert.deepEqual(ids(snapshot, { ...all, search: "เครื่องไทย" }), [id(22)]);
  assert.deepEqual(ids(snapshot, { ...all, search: "ฐานข้อมูล" }), [id(22)]);
  assert.deepEqual(
    new Set(ids(snapshot, { ...all, search: "  ALICE " })),
    new Set([id(21), id(22)]),
  );
  assert.deepEqual(ids(snapshot, { ...all, search: "BOB" }), [id(23)]);
  assert.deepEqual(
    new Set(ids(snapshot, { ...all, search: "ประเทศไทย" })),
    new Set([id(22), id(23)]),
  );
  assert.deepEqual(
    new Set(ids(snapshot, { ...all, search: "infrastructure" })),
    new Set([id(21), id(22), id(23)]),
  );
  assert.deepEqual(ids(snapshot, { ...all, search: "not present" }), []);
  assert.deepEqual(ids(snapshot, { ...all, search: "  " }), ids(snapshot, all));
  // Secret references and the unselected identity's label are not searched.
  assert.deepEqual(ids(snapshot, { ...all, search: id(60) }), []);
  assert.deepEqual(ids(snapshot, { ...all, search: "Password profile" }), []);
});

test("tag filters use direct membership, AND and deduplicate selections while composing with scope/search", () => {
  const snapshot = fixture();
  assert.deepEqual(
    ids(snapshot, { ...all, tagIds: [id(30), id(31), id(30)] }),
    [id(22)],
  );
  assert.deepEqual(
    new Set(ids(snapshot, { ...all, tagIds: [id(30), id(30)] })),
    new Set([id(22), id(23)]),
  );
  assert.deepEqual(
    ids(snapshot, {
      scope: { kind: "group", groupId: id(10), includeDescendants: true },
      tagIds: [id(30)],
      search: "ALICE",
    }),
    [id(22)],
  );
  assert.deepEqual(ids(snapshot, { ...all, tagIds: [id(30), id(32)] }), []);
  assert.deepEqual(ids(snapshot, { ...all, tagIds: [] }), ids(snapshot, all));
});

test("query rejects missing/unknown scopes and fields, malformed types and unknown IDs without widening", () => {
  const snapshot = fixture();
  const bad: unknown[] = [
    {},
    null,
    [],
    { scope: { kind: "unknown" } },
    { scope: { kind: "all", groupId: id(10) } },
    { scope: { kind: "ungrouped", includeDescendants: true } },
    { scope: { kind: "group", groupId: id(10) } },
    { scope: { kind: "group", groupId: id(10), includeDescendants: "yes" } },
    { scope: { kind: "group", groupId: id(999), includeDescendants: true } },
    { scope: { kind: "group", groupId: "bad", includeDescendants: true } },
    { ...all, tagIds: [id(999)] },
    { ...all, tagIds: "all" },
    { ...all, tagIds: [2] },
    { ...all, search: 4 },
    { ...all, search: undefined },
    { ...all, password: "reject" },
    { ...all, scope: { kind: "all", ignored: true } },
  ];
  for (const query of bad)
    fails(
      queryCatalogHosts(snapshot, query as CatalogHostQuery),
      "invalid-request",
    );
  fails(resolveHostConfig(snapshot, id(999)), "invalid-request");
  fails(resolveHostConfig(snapshot, "bad"), "invalid-request");
});

test("host/tag/tree ordering uses normalized label then UUID and ignores input insertion order", () => {
  const snapshot = fixture();
  snapshot.hosts = [
    host(202, "é"),
    host(201, "E\u0301"),
    host(200, "a"),
    host(203, "Z"),
  ];
  snapshot.hostTags = [];
  assert.deepEqual(ids(snapshot, all), [id(200), id(203), id(201), id(202)]);
  snapshot.hosts.reverse();
  assert.deepEqual(ids(snapshot, all), [id(200), id(203), id(201), id(202)]);
  snapshot.groups = [
    group(102, "é"),
    group(101, "E\u0301"),
    group(100, "a"),
    group(103, "Z"),
    group(105, "b", id(100)),
    group(104, "B", id(100)),
  ];
  const tree = value(catalogGroupTree(snapshot));
  assert.deepEqual(
    tree.map((node) => node.group.id),
    [id(100), id(103), id(101), id(102)],
  );
  assert.deepEqual(
    tree[0].children.map((node) => node.group.id),
    [id(104), id(105)],
  );
  assert.equal(tree.length, 4);
  snapshot.hostTags = [
    { vaultId: id(1), hostId: id(200), tagId: id(31) },
    { vaultId: id(1), hostId: id(200), tagId: id(30) },
    { vaultId: id(1), hostId: id(200), tagId: id(32) },
  ];
  assert.deepEqual(
    value(queryCatalogHosts(snapshot, all))[0].tags.map((row) => row.id),
    [id(32), id(30), id(31)],
  );
});

test("configuration, views and tree are deeply frozen independent copies that survive later catalog edits", () => {
  const snapshot = fixture();
  const captured = value(resolveHostConfig(snapshot, id(23)));
  const views = value(queryCatalogHosts(snapshot, all));
  const tree = value(catalogGroupTree(snapshot));
  const original = structuredClone({ captured, views, tree });
  assert.notEqual(captured.auth.identity, snapshot.identities[1]);
  assert.notEqual(captured.auth.key, snapshot.keys[0]);
  assert.notEqual(
    views[0].host,
    snapshot.hosts.find((host) => host.id === views[0].host.id),
  );
  assert.notEqual(
    tree[0].group.port,
    snapshot.groups.find((group) => group.id === tree[0].group.id)?.port,
  );
  for (const mutate of [
    () => {
      captured.port.value = 1;
    },
    () => {
      captured.port.source.kind = "default";
    },
    () => {
      (captured.auth.identity as Identity).username = "changed";
    },
    () => {
      (captured.auth.key as KeyMetadata).privateKeyRef = id(999);
    },
    () => {
      (captured.ancestry as unknown as { id: string }[]).push({ id: id(999) });
    },
    () => {
      captured.ancestry[0].label = "changed";
    },
    () => {
      views.push(views[0]);
    },
    () => {
      views[0].host.auth.mode = "clear";
    },
    () => {
      (views.find((row) => row.tags.length)!.tags[0] as Tag).label = "changed";
    },
    () => {
      (tree[0].children as unknown[]).pop();
    },
    () => {
      tree[0].group.port.mode = "value";
    },
  ])
    assert.throws(mutate, TypeError);
  snapshot.catalogRevision++;
  snapshot.identities[1].username = "new-user";
  snapshot.identities[1].revision++;
  snapshot.keys[0].privateKeyRef = id(63);
  snapshot.keys[0].revision++;
  snapshot.secretRefs.push({
    ...entity(63),
    kind: "private-key",
    operationId: id(73),
  });
  snapshot.hosts[3].address = "changed.test";
  snapshot.hosts[3].auth = { mode: "clear" };
  snapshot.groups[0].label = "Changed ancestry";
  snapshot.tags[0].label = "new tag";
  snapshot.tags[0].normalizedName = "new tag";
  assert.deepEqual({ captured, views, tree }, original);
  assert.equal(
    value(resolveHostConfig(snapshot, id(23))).auth.selection,
    "clear",
  );
  assert.equal(
    value(resolveHostConfig(snapshot, id(23))).address,
    "changed.test",
  );
  assert.equal(Object.isFrozen(snapshot), false);
});

test("invalid graphs, missing references and malformed bundles fail closed with sanitized outcomes", () => {
  const mutations: ((snapshot: MetadataSnapshot) => void)[] = [
    (s) => {
      s.groups[0].parentId = id(12);
    },
    (s) => {
      s.groups.push({ ...group(90, "unreachable cycle"), parentId: id(90) });
    },
    (s) => {
      s.groups[1].parentId = id(999);
    },
    (s) => {
      s.hosts[0].groupId = id(999);
    },
    (s) => {
      s.groups[0].auth = { mode: "value", identityId: id(999) };
    },
    (s) => {
      s.hosts[3].auth = { mode: "value", identityId: id(999) };
    },
    (s) => {
      s.identities[1].keyId = id(999);
    },
    (s) => {
      s.identities[0].passwordRef = id(999);
    },
    (s) => {
      s.keys[0].privateKeyRef = id(999);
    },
    (s) => {
      s.keys[0].passphraseRef = id(999);
    },
    (s) => {
      s.identities[1].passwordRef = id(60);
    },
    (s) => {
      s.keys[0].vaultId = id(999);
    },
    (s) => {
      s.groups.push({ ...s.groups[0] });
    },
    (s) => {
      s.hostTags[0].tagId = id(999);
    },
    (s) => {
      s.hostTags[0].hostId = id(999);
    },
    (s) => {
      s.hosts[0].port = { mode: "value", port: 0 };
    },
    (s) => {
      s.hosts[0].port = { mode: "clear" } as never;
    },
    (s) => {
      s.hosts[0].auth = { mode: "clear", identityId: id(40) } as never;
    },
  ];
  for (const mutate of mutations) {
    const snapshot = fixture();
    mutate(snapshot);
    fails(resolveHostConfig(snapshot, id(22)), "constraint");
    fails(queryCatalogHosts(snapshot, all), "constraint");
    fails(catalogGroupTree(snapshot), "constraint");
  }
});

test("deep group trees are bounded iterative reads and do not inspect protected content or providers", () => {
  const snapshot = fixture();
  snapshot.groups = Array.from({ length: 2500 }, (_, n) =>
    group(1000 + n, `Group ${n}`, n === 0 ? null : id(999 + n)),
  );
  snapshot.groups[0].port = { mode: "value", port: 2223 };
  snapshot.hosts = [host(20, "Deep host", snapshot.groups.at(-1)!.id)];
  snapshot.hostTags = [];
  Object.defineProperty(snapshot, "snippets", {
    get() {
      throw new Error("must never inspect protected bodies");
    },
  });
  Object.defineProperty(snapshot, "secretOperations", {
    get() {
      throw new Error("must never consult a provider journal");
    },
  });
  const config = value(resolveHostConfig(snapshot, id(20)));
  assert.equal(config.ancestry.length, 2500);
  assert.equal(config.port.value, 2223);
  assert.deepEqual(
    ids(snapshot, {
      scope: { kind: "group", groupId: id(1000), includeDescendants: true },
    }),
    [id(20)],
  );
  let node = value(catalogGroupTree(snapshot))[0];
  let count = 1;
  while (node.children.length) {
    node = node.children[0];
    count++;
  }
  assert.equal(count, 2500);
  assert.equal(Object.isFrozen(node.group.auth), true);
});
