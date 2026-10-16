import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  CatalogModule,
  SecretService,
  TransientSecrets,
  type CatalogIntent,
} from "../../packages/services/src/index.ts";
import {
  openMetadata,
  previewMetadataChanges,
} from "../../packages/adapters/src/index.ts";
import type {
  MetadataChange,
  StoreResult,
} from "../../packages/domain/src/index.ts";
import { MemorySecretProvider } from "../fixtures/secrets/memory-provider.ts";
function value<T>(result: StoreResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}
function code<T>(result: StoreResult<T>) {
  return result.ok ? "ok" : result.error.code;
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync("/private/tmp/ssterm-catalog-test-");
  const repo = value(await openMetadata({ path: join(dir, "catalog.sqlite") }));
  const provider = new MemorySecretProvider();
  const transient = new TransientSecrets();
  const secrets = new SecretService({ repository: repo, provider, transient });
  let now = 1000;
  const catalog = new CatalogModule({ repository: repo, now: () => now });
  t.after(() => {
    transient.purgeAll();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const snapshot = () => value(repo.snapshot());
  const commit = (changes: MetadataChange[]) =>
    value(
      repo.commit({
        expectedCatalogRevision: snapshot().catalogRevision,
        changes,
      }),
    );
  const apply = (intent: CatalogIntent) => {
    const preview = value(catalog.prepare(intent));
    value(catalog.apply(preview.token));
    return preview;
  };
  const create = (intent: CatalogIntent) => apply(intent).createdIds[0]!;
  return {
    repo,
    provider,
    secrets,
    catalog,
    snapshot,
    commit,
    apply,
    create,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("catalog intents create generated IDs, resolve inheritance and keep a captured config detached after edits", async (t) => {
  const s = await fixture(t);
  const identityId = s.create({
    type: "create-identity",
    data: { label: "Lab login", username: "alice", method: "password" },
  });
  assert.equal(s.snapshot().identities[0]!.passwordRef, null);
  const groupId = s.create({
    type: "create-group",
    data: {
      label: "Lab",
      port: { mode: "value", port: 2222 },
      auth: { mode: "value", identityId },
    },
  });
  const hostId = s.create({
    type: "create-host",
    data: { label: "Box", address: "BOX.EXAMPLE", groupId },
  });
  const captured = value(s.catalog.resolve(hostId));
  assert.equal(captured.address, "box.example");
  assert.equal(captured.port.value, 2222);
  assert.equal(captured.auth.identity?.username, "alice");
  const group = s.snapshot().groups[0]!;
  const preview = s.apply({
    type: "update-group",
    id: groupId,
    expectedRevision: group.revision,
    data: { port: { mode: "value", port: 2200 } },
  });
  assert.equal(preview.impacts.hosts[0]!.effectiveConnectionChanged, true);
  assert.equal(captured.port.value, 2222);
  assert.equal(value(s.catalog.resolve(hostId)).port.value, 2200);
  assert.equal(s.provider.calls.length, 0);
});
test("preview owns its changes; stale global revision, consumed and expired tokens cannot commit", async (t) => {
  const s = await fixture(t);
  const input: CatalogIntent = {
    type: "create-host",
    data: { label: "Owned", address: "owned.example" },
  };
  const preview = value(s.catalog.prepare(input));
  input.data.label = "Mutated";
  preview.createdIds[0] = randomUUID();
  value(s.catalog.apply(preview.token));
  assert.equal(s.snapshot().hosts[0]!.label, "Owned");
  assert.equal(code(s.catalog.apply(preview.token)), "invalid-request");
  const next = value(
    s.catalog.prepare({
      type: "delete-host",
      id: s.snapshot().hosts[0]!.id,
      expectedRevision: 1,
    }),
  );
  s.create({ type: "create-group", data: { label: "Unrelated edit" } });
  const before = s.snapshot();
  assert.equal(code(s.catalog.apply(next.token)), "conflict");
  assert.deepEqual(s.snapshot(), before);
  const expired = value(
    s.catalog.prepare({ type: "create-tag", data: { label: "Later" } }),
  );
  s.advance(300_000);
  assert.equal(code(s.catalog.apply(expired.token)), "invalid-request");
  assert.equal(s.snapshot().tags.length, 0);
});
test("preview capacity is bounded and expiry frees capacity", async (t) => {
  const s = await fixture(t);
  const request: CatalogIntent = {
    type: "create-tag",
    data: { label: "draft" },
  };
  for (let i = 0; i < 64; i++) value(s.catalog.prepare(request));
  assert.equal(code(s.catalog.prepare(request)), "busy");
  s.advance(300_000);
  assert.equal(code(s.catalog.prepare(request)), "ok");
});
test("strict intents reject secret fields, caller IDs, raw changes, invalid nested fields and dispositions", async (t) => {
  const s = await fixture(t);
  for (const invalid of [
    {
      type: "create-host",
      id: randomUUID(),
      data: { label: "x", address: "x.test" },
    },
    {
      type: "create-identity",
      data: {
        label: "x",
        username: "x",
        method: "password",
        passwordRef: randomUUID(),
      },
    },
    {
      type: "create-identity",
      data: {
        label: "x",
        username: "x",
        method: "password",
        password: "never-accepted",
      },
    },
    {
      type: "create-host",
      data: {
        label: "x",
        address: "x.test",
        auth: { mode: "inherit", identityId: randomUUID() },
      },
    },
    {
      type: "create-host",
      data: {
        label: "x",
        address: "x.test",
        port: { mode: "value", port: 22, extra: true },
      },
    },
    {
      type: "delete-group",
      id: randomUUID(),
      expectedRevision: 1,
      disposition: { mode: "subtree", parentId: null },
    },
    { changes: [] },
    { type: "create-snippet", data: { label: "x", body: "secret" } },
  ])
    assert.equal(
      code(s.catalog.prepare(invalid as CatalogIntent)),
      "invalid-request",
    );
  assert.equal(s.snapshot().catalogRevision, 0);
  assert.equal(s.provider.calls.length, 0);
});
test("group reparent preserves nested hosts and preview rejects cycles including reparent into own subtree", async (t) => {
  const s = await fixture(t);
  const root = s.create({
    type: "create-group",
    data: { label: "Root", port: { mode: "value", port: 2222 } },
  });
  const child = s.create({
    type: "create-group",
    data: { label: "Child", parentId: root },
  });
  const leaf = s.create({
    type: "create-group",
    data: { label: "Leaf", parentId: child },
  });
  const direct = s.create({
    type: "create-host",
    data: { label: "Direct", address: "direct.test", groupId: root },
  });
  const nested = s.create({
    type: "create-host",
    data: {
      label: "Nested",
      address: "nested.test",
      groupId: leaf,
      port: { mode: "value", port: 2022 },
    },
  });
  const revision = s.snapshot().catalogRevision;
  assert.equal(
    code(
      s.catalog.prepare({
        type: "update-group",
        id: root,
        expectedRevision: 1,
        data: { parentId: leaf },
      }),
    ),
    "constraint",
  );
  assert.equal(
    code(
      s.catalog.prepare({
        type: "delete-group",
        id: root,
        expectedRevision: 1,
        disposition: { mode: "reparent", parentId: child },
      }),
    ),
    "constraint",
  );
  assert.equal(s.snapshot().catalogRevision, revision);
  const preview = s.apply({
    type: "delete-group",
    id: root,
    expectedRevision: 1,
    disposition: { mode: "reparent", parentId: null },
  });
  assert.equal(
    s.snapshot().groups.find((row) => row.id === child)?.parentId,
    null,
  );
  assert.equal(
    s.snapshot().hosts.find((row) => row.id === direct)?.groupId,
    null,
  );
  const indirect = preview.impacts.hosts.find((row) => row.hostId === nested)!;
  assert.equal(indirect.effectiveConnectionChanged, false);
  assert.equal(indirect.pathChanged, true);
  assert.equal(value(s.catalog.resolve(nested)).port.value, 2022);
});
test("subtree deletion removes owned hosts, memberships and tunnels atomically while preserving trust and identities", async (t) => {
  const s = await fixture(t);
  const groupId = s.create({ type: "create-group", data: { label: "Remove" } });
  const child = s.create({
    type: "create-group",
    data: { label: "Child", parentId: groupId },
  });
  const hostId = s.create({
    type: "create-host",
    data: { label: "Host", address: "lab.test", groupId: child },
  });
  const tagId = s.create({ type: "create-tag", data: { label: "Keep" } });
  const identityId = s.create({
    type: "create-identity",
    data: { label: "Keep", username: "bob", method: "password" },
  });
  s.apply({
    type: "set-host-tag",
    hostId,
    tagId,
    present: true,
    expectedHostRevision: 1,
  });
  const tunnelId = randomUUID();
  s.commit([
    {
      type: "create-tunnel-rule",
      id: tunnelId,
      data: {
        label: "Owned",
        hostId,
        bindPort: 8000,
        destinationHost: "localhost",
        destinationPort: 80,
      },
    },
  ]);
  const preview = s.apply({
    type: "delete-group",
    id: groupId,
    expectedRevision: 1,
    disposition: { mode: "subtree" },
  });
  assert.deepEqual(preview.impacts.removedHostIds, [hostId]);
  assert.deepEqual(preview.impacts.removedTunnelRuleIds, [tunnelId]);
  assert.equal(s.snapshot().groups.length, 0);
  assert.equal(s.snapshot().hostTags.length, 0);
  assert.equal(s.snapshot().tunnelRules.length, 0);
  assert.equal(s.snapshot().identities[0]!.id, identityId);
  assert.equal(s.snapshot().tags[0]!.id, tagId);
});
test("identity detach uses CLEAR for all direct refs and effective users stop at overrides; reassign validates targets", async (t) => {
  const s = await fixture(t);
  const login = s.create({
    type: "create-identity",
    data: { label: "Shared", username: "alice", method: "password" },
  });
  const other = s.create({
    type: "create-identity",
    data: { label: "Other", username: "bob", method: "password" },
  });
  const group = s.create({
    type: "create-group",
    data: { label: "Shared group", auth: { mode: "value", identityId: login } },
  });
  const inherited = s.create({
    type: "create-host",
    data: { label: "Inherited", address: "inherited.test", groupId: group },
  });
  const direct = s.create({
    type: "create-host",
    data: {
      label: "Direct",
      address: "direct.test",
      auth: { mode: "value", identityId: login },
    },
  });
  const cutoff = s.create({
    type: "create-host",
    data: {
      label: "Cutoff",
      address: "cutoff.test",
      groupId: group,
      auth: { mode: "value", identityId: other },
    },
  });
  assert.equal(
    code(
      s.catalog.prepare({
        type: "delete-identity",
        id: login,
        expectedRevision: 1,
        disposition: { mode: "reassign", identityId: login },
      }),
    ),
    "constraint",
  );
  const preview = s.apply({
    type: "delete-identity",
    id: login,
    expectedRevision: 1,
    disposition: { mode: "detach" },
  });
  assert.deepEqual(
    new Set(preview.impacts.effectiveIdentityHostIds),
    new Set([inherited, direct]),
  );
  assert.deepEqual(preview.impacts.directIdentityHostIds, [direct]);
  assert.equal(s.snapshot().groups[0]!.auth.mode, "clear");
  assert.equal(
    s.snapshot().hosts.find((row) => row.id === direct)!.auth.mode,
    "clear",
  );
  assert.equal(value(s.catalog.resolve(inherited)).auth.selection, "clear");
  assert.equal(value(s.catalog.resolve(cutoff)).auth.identity?.id, other);
});
test("tag deletion touches host and encrypted snippet once, preserving the exact envelope without secret access", async (t) => {
  const s = await fixture(t);
  await s.secrets.initializeContentKey();
  const snippetId = randomUUID();
  assert.equal(
    (
      await s.secrets.saveSnippet({
        id: snippetId,
        label: "Command",
        body: new TextEncoder().encode("owned-fixture-body"),
      })
    ).status,
    "saved",
  );
  const hostId = s.create({
    type: "create-host",
    data: { label: "Host", address: "host.test" },
  });
  const tagId = s.create({ type: "create-tag", data: { label: "Tag" } });
  s.commit([
    {
      type: "set-host-tag",
      hostId,
      tagId,
      present: true,
      expectedHostRevision: 1,
    },
    {
      type: "set-snippet-tag",
      snippetId,
      tagId,
      present: true,
      expectedSnippetRevision: 1,
    },
  ]);
  const before = s.snapshot();
  const calls = s.provider.calls.length;
  const preview = s.apply({
    type: "delete-tag",
    id: tagId,
    expectedRevision: 1,
  });
  const after = s.snapshot();
  assert.equal(after.hostTags.length, 0);
  assert.equal(after.snippetTags.length, 0);
  assert.equal(after.tags.length, 0);
  assert.equal(after.hosts[0]!.revision, 3);
  assert.equal(after.snippets[0]!.revision, 3);
  assert.deepEqual(
    after.snippets[0]!.bodyEnvelope,
    before.snippets[0]!.bodyEnvelope,
  );
  assert.deepEqual(preview.impacts.removedSnippetTags, [{ snippetId, tagId }]);
  assert.equal(s.provider.calls.length, calls);
  assert.equal((await s.secrets.openSnippet(snippetId)).status, "open");
  const duplicate = structuredClone(after);
  duplicate.snippetTags = [
    { vaultId: after.vault.id, snippetId, tagId },
    { vaultId: after.vault.id, snippetId, tagId },
  ];
  assert.equal(
    code(
      previewMetadataChanges(duplicate, [
        {
          type: "update-vault",
          expectedRevision: after.vault.revision,
          data: { label: "Changed" },
        },
      ]),
    ),
    "constraint",
  );
});
test("saved password detachment queues cleanup in the same commit; denied OS cleanup stays pending and retries safely", async (t) => {
  const s = await fixture(t);
  const identityId = randomUUID();
  const saved = await s.secrets.storeSecret({
    kind: "password",
    owner: { type: "identity", id: identityId, expectedRevision: null },
    value: new TextEncoder().encode("owned-fixture-password"),
    publish: (ref) => [
      {
        type: "create-identity",
        id: identityId,
        data: {
          label: "Login",
          username: "alice",
          method: "password",
          passwordRef: ref,
        },
      },
    ],
  });
  assert.equal(saved.status, "published");
  const passwordRef = s.snapshot().identities[0]!.passwordRef!;
  s.apply({
    type: "update-identity",
    id: identityId,
    expectedRevision: 1,
    data: { label: "Retained" },
  });
  assert.equal(s.snapshot().identities[0]!.passwordRef, passwordRef);
  const preview = value(
    s.catalog.prepare({
      type: "update-identity",
      id: identityId,
      expectedRevision: 2,
      data: {},
      forgetPassword: true,
    }),
  );
  assert.deepEqual(preview.impacts.cleanupRefIds, [passwordRef]);
  assert.equal(s.provider.count("delete"), 0);
  const applied = value(s.catalog.apply(preview.token));
  assert.equal(applied.pendingSecretCleanupOperationIds.length, 1);
  assert.equal(s.snapshot().identities[0]!.passwordRef, null);
  assert.equal(s.provider.items.size, 1);
  s.provider.inject({ op: "delete", status: "denied" });
  assert.equal((await s.secrets.reconcile()).pending, 1);
  assert.equal(s.provider.items.size, 1);
  assert.equal(
    s
      .snapshot()
      .secretOperations.find(
        (row) =>
          row.operationId === applied.pendingSecretCleanupOperationIds[0],
      )!.state,
    "cleanup",
  );
  assert.equal((await s.secrets.reconcile()).cleaned, 1);
  assert.equal(s.provider.items.size, 0);
  assert.equal(s.snapshot().secretRefs.length, 0);
});
test("pending secret publications block identity edits; stale and failed SQL plans never call the provider", async (t) => {
  const s = await fixture(t);
  const identityId = s.create({
    type: "create-identity",
    data: { label: "Login", username: "alice", method: "password" },
  });
  s.provider.inject(
    { op: "write", status: "unknown" },
    { op: "lookup", status: "unavailable" },
  );
  assert.equal(
    (
      await s.secrets.storeSecret({
        kind: "password",
        owner: { type: "identity", id: identityId, expectedRevision: 1 },
        value: new TextEncoder().encode("owned-password"),
      })
    ).status,
    "pending",
  );
  for (const request of [
    {
      type: "update-identity",
      id: identityId,
      expectedRevision: 1,
      data: { label: "Edit" },
    },
    {
      type: "delete-identity",
      id: identityId,
      expectedRevision: 1,
      disposition: { mode: "detach" },
    },
  ] as CatalogIntent[])
    assert.equal(code(s.catalog.prepare(request)), "busy");
  const calls = s.provider.calls.length;
  const invalid = s.catalog.prepare({
    type: "update-identity",
    id: identityId,
    expectedRevision: 100,
    data: { label: "Fail" },
  });
  assert.equal(code(invalid), "conflict");
  const plan = value(
    s.catalog.prepare({
      type: "create-host",
      data: { label: "Draft", address: "draft.test" },
    }),
  );
  s.create({ type: "create-tag", data: { label: "Change" } });
  assert.equal(code(s.catalog.apply(plan.token)), "conflict");
  assert.equal(s.provider.calls.length, calls);
  assert.equal(s.provider.count("delete"), 0);
});
test("identity reassign transfers all direct refs; password method switch and deletion queue cleanup without OS calls", async (t) => {
  const s = await fixture(t);
  const savedId = randomUUID();
  const saved = await s.secrets.storeSecret({
    kind: "password",
    owner: { type: "identity", id: savedId, expectedRevision: null },
    value: new TextEncoder().encode("fixture-switch-password"),
    publish: (ref) => [
      {
        type: "create-identity",
        id: savedId,
        data: {
          label: "Saved",
          username: "alice",
          method: "password",
          passwordRef: ref,
        },
      },
    ],
  });
  assert.equal(saved.status, "published");
  const other = s.create({
    type: "create-identity",
    data: { label: "Other", username: "bob", method: "password" },
  });
  const groupId = s.create({
    type: "create-group",
    data: { label: "Group", auth: { mode: "value", identityId: savedId } },
  });
  const hostId = s.create({
    type: "create-host",
    data: { label: "Host", address: "host.test", groupId },
  });
  const before = s.snapshot();
  assert.equal(
    code(
      s.catalog.prepare({
        type: "update-identity",
        id: savedId,
        expectedRevision: 1,
        data: { keyId: "bad" },
      }),
    ),
    "invalid-request",
  );
  assert.deepEqual(s.snapshot(), before);
  const switched = s.apply({
    type: "update-identity",
    id: savedId,
    expectedRevision: 1,
    data: { method: "keyboard-interactive" },
  });
  assert.equal(switched.impacts.cleanupRefIds.length, 1);
  assert.equal(
    s.snapshot().identities.find((row) => row.id === savedId)!.passwordRef,
    null,
  );
  assert.equal(s.provider.count("delete"), 0);
  const reassigned = s.apply({
    type: "delete-identity",
    id: savedId,
    expectedRevision: 2,
    disposition: { mode: "reassign", identityId: other },
  });
  assert.deepEqual(reassigned.impacts.effectiveIdentityHostIds, [hostId]);
  assert.equal(value(s.catalog.resolve(hostId)).auth.identity?.id, other);
  assert.deepEqual(
    s.snapshot().groups.find((row) => row.id === groupId)!.auth,
    { mode: "value", identityId: other },
  );
  // A saved-password identity deletion also queues its descriptor atomically.
  const deleteId = randomUUID();
  assert.equal(
    (
      await s.secrets.storeSecret({
        kind: "password",
        owner: { type: "identity", id: deleteId, expectedRevision: null },
        value: new TextEncoder().encode("fixture-delete-password"),
        publish: (ref) => [
          {
            type: "create-identity",
            id: deleteId,
            data: {
              label: "Delete",
              username: "carol",
              method: "password",
              passwordRef: ref,
            },
          },
        ],
      })
    ).status,
    "published",
  );
  const removed = s.apply({
    type: "delete-identity",
    id: deleteId,
    expectedRevision: 1,
    disposition: { mode: "detach" },
  });
  assert.equal(removed.impacts.cleanupRefIds.length, 1);
  assert.equal(s.provider.count("delete"), 0);
});
test("membership changes and newly added descendants invalidate existing destructive previews", async (t) => {
  const s = await fixture(t);
  const groupId = s.create({ type: "create-group", data: { label: "Group" } });
  const hostId = s.create({
    type: "create-host",
    data: { label: "Host", address: "host.test", groupId },
  });
  const tagId = s.create({ type: "create-tag", data: { label: "Tag" } });
  const removal = value(
    s.catalog.prepare({
      type: "delete-group",
      id: groupId,
      expectedRevision: 1,
      disposition: { mode: "subtree" },
    }),
  );
  s.apply({
    type: "set-host-tag",
    hostId,
    tagId,
    present: true,
    expectedHostRevision: 1,
  });
  assert.equal(code(s.catalog.apply(removal.token)), "conflict");
  assert.equal(s.snapshot().hosts.length, 1);
  const newer = value(
    s.catalog.prepare({
      type: "delete-group",
      id: groupId,
      expectedRevision: 1,
      disposition: { mode: "subtree" },
    }),
  );
  const child = s.create({
    type: "create-group",
    data: { label: "New child", parentId: groupId },
  });
  assert.equal(code(s.catalog.apply(newer.token)), "conflict");
  assert.ok(s.snapshot().groups.some((row) => row.id === child));
});
test("plans above the repository batch bound reject without chunking or partial changes", async (t) => {
  const s = await fixture(t);
  const groupId = s.create({
    type: "create-group",
    data: { label: "Large group" },
  });
  const hosts = Array.from(
    { length: 1000 },
    (_, i): MetadataChange => ({
      type: "create-host",
      id: randomUUID(),
      data: { label: `Host ${i}`, address: `h${i}.test`, groupId },
    }),
  );
  s.commit(hosts);
  const before = s.snapshot();
  assert.equal(
    code(
      s.catalog.prepare({
        type: "delete-group",
        id: groupId,
        expectedRevision: 1,
        disposition: { mode: "subtree" },
      }),
    ),
    "invalid-request",
  );
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.provider.calls.length, 0);
});
test("final SQL ID reservation failure rolls back a preview without changing the provider or catalog", async (t) => {
  const s = await fixture(t);
  const deletedId = s.create({ type: "create-tag", data: { label: "Prior" } });
  s.apply({ type: "delete-tag", id: deletedId, expectedRevision: 1 });
  // A historical UUID is absent from a snapshot but remains reserved by SQL.
  const catalog = new CatalogModule({
    repository: s.repo,
    createId: () => deletedId,
  });
  const preview = value(
    catalog.prepare({
      type: "create-host",
      data: { label: "Reuse forbidden", address: "reuse.test" },
    }),
  );
  const before = s.snapshot();
  assert.equal(code(catalog.apply(preview.token)), "constraint");
  assert.deepEqual(s.snapshot(), before);
  assert.equal(s.provider.calls.length, 0);
});
test("a host edit in a 5,000-host catalog prepares in linear time with the same impacts as a small catalog", async (t) => {
  const summary = async (count: number) => {
    const s = await fixture(t);
    const groupId = s.create({
      type: "create-group",
      data: { label: "Fleet", port: { mode: "value", port: 2200 } },
    });
    for (let start = 0; start < count; start += 1000)
      s.commit(
        Array.from(
          { length: Math.min(1000, count - start) },
          (_, i): MetadataChange => ({
            type: "create-host",
            id: randomUUID(),
            data: {
              label: `Host ${start + i}`,
              address: `h${start + i}.test`,
              groupId,
            },
          }),
        ),
      );
    const host = s.snapshot().hosts.find((row) => row.label === "Host 0")!;
    const started = performance.now();
    const preview = value(
      s.catalog.prepare({
        type: "update-host",
        id: host.id,
        expectedRevision: host.revision,
        data: { label: "Renamed" },
      }),
    );
    const elapsed = performance.now() - started;
    const { hosts, ...rest } = preview.impacts;
    return {
      elapsed,
      impacts: {
        hosts: hosts.map((row) => ({
          same: row.hostId === host.id,
          labels: [row.before?.hostRef.label, row.after?.hostRef.label],
          port: [row.before?.port.value, row.after?.port.value],
          flags: [row.effectiveConnectionChanged, row.provenanceChanged, row.pathChanged],
        })),
        rest,
      },
    };
  };
  const reference = await summary(3);
  const large = await summary(5000);
  assert.ok(large.elapsed < 1000, `prepare took ${large.elapsed.toFixed(0)} ms`);
  assert.deepEqual(large.impacts, reference.impacts);
  assert.deepEqual(reference.impacts.hosts, [
    { same: true, labels: ["Host 0", "Renamed"], port: [2200, 2200], flags: [false, false, false] },
  ]);
});
