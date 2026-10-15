import { test, expect } from "./fixtures";

test("uses the shipped catalog for inheritance, search, stale previews and immutable captures", async ({
  desktop,
}, testInfo) => {
  const result = await desktop.app.evaluate(async ({ app }) => {
    const require = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const fs = require("node:fs"),
      path = require("node:path");
    const main = path.join(app.getAppPath(), "out/main");
    const { openMetadata } = require(path.join(main, "storage.js"));
    const { CatalogModule } = require(path.join(main, "catalog.js"));
    const directory = fs.mkdtempSync(
      path.join(app.getPath("temp"), "ssterm-catalog-runtime-"),
    );
    let repository: any;
    try {
      const opened = await openMetadata({
        path: path.join(directory, "catalog.sqlite"),
      });
      if (!opened.ok) throw new Error("Catalog fixture open failed");
      repository = opened.value;
      const catalog = new CatalogModule({ repository });
      const value = (r: any) => {
        if (!r.ok) throw new Error(`Catalog fixture: ${r.error.code}`);
        return r.value;
      };
      const perform = (intent: any) => {
        const preview = value(catalog.prepare(intent));
        return value(catalog.apply(preview.token));
      };
      const identity = perform({
        type: "create-identity",
        data: { label: "Lab prompt", username: "alice", method: "password" },
      }).createdIds[0];
      const parent = perform({
        type: "create-group",
        data: {
          label: "Bangkok",
          port: { mode: "value", port: 2222 },
          auth: { mode: "value", identityId: identity },
        },
      }).createdIds[0];
      const child = perform({
        type: "create-group",
        data: { label: "ระบบทดสอบ", parentId: parent },
      }).createdIds[0];
      const host = perform({
        type: "create-host",
        data: {
          label: "เครื่องทดสอบ",
          address: "EXAMPLE.COM.",
          groupId: child,
        },
      }).createdIds[0];
      const captured = value(catalog.resolve(host));
      const capturedJSON = JSON.stringify(captured);
      const tag = perform({
        type: "create-tag",
        data: { label: " Production " },
      }).createdIds[0];
      const hostRevision = value(repository.snapshot()).hosts.find(
        (row: any) => row.id === host,
      ).revision;
      perform({
        type: "set-host-tag",
        hostId: host,
        tagId: tag,
        present: true,
        expectedHostRevision: hostRevision,
      });
      const views = value(
        catalog.query({
          scope: { kind: "group", groupId: parent, includeDescendants: true },
          search: "alice",
          tagIds: [tag, tag],
        }),
      );
      const stale = value(
        catalog.prepare({
          type: "update-group",
          id: parent,
          expectedRevision: 1,
          data: { port: { mode: "value", port: 2200 } },
        }),
      );
      perform({
        type: "update-tag",
        id: tag,
        expectedRevision: 1,
        data: { label: "Production lab" },
      });
      const rejected = catalog.apply(stale.token);
      const move = value(
        catalog.prepare({
          type: "update-group",
          id: child,
          expectedRevision: 1,
          data: { parentId: null },
        }),
      );
      value(catalog.apply(move.token));
      const afterMove = value(catalog.resolve(host));
      const detach = value(
        catalog.prepare({
          type: "delete-identity",
          id: identity,
          expectedRevision: 1,
          disposition: { mode: "detach" },
        }),
      );
      value(catalog.apply(detach.token));
      const state = value(repository.snapshot());
      const deletion = value(
        catalog.prepare({
          type: "delete-group",
          id: child,
          expectedRevision: 2,
          disposition: { mode: "subtree" },
        }),
      );
      value(catalog.apply(deletion.token));
      return {
        electron: process.versions.electron,
        inherited: {
          port: captured.port.value,
          username: captured.auth.identity?.username,
          source: captured.port.source.id,
        },
        parent,
        matched: views.length === 1 && views[0].host.id === host,
        staleRejected: !rejected.ok && rejected.error.code === "conflict",
        capturedUnchanged:
          capturedJSON === JSON.stringify(captured) &&
          Object.isFrozen(captured) &&
          Object.isFrozen(captured.auth),
        moveDefault:
          afterMove.port.value === 22 && afterMove.auth.selection === "none",
        moveImpact: move.impacts.hosts.some(
          (row: any) =>
            row.hostId === host &&
            row.effectiveConnectionChanged &&
            row.pathChanged,
        ),
        detachClear:
          state.groups.find((row: any) => row.id === parent).auth.mode ===
          "clear",
        subtreeRemoved: value(repository.snapshot()).hosts.length === 0,
      };
    } finally {
      repository?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  expect(result.electron).toBe("44.7.2");
  expect(result.inherited).toEqual({
    port: 2222,
    username: "alice",
    source: result.parent,
  });
  expect(
    result.matched &&
      result.staleRejected &&
      result.capturedUnchanged &&
      result.moveDefault &&
      result.moveImpact &&
      result.detachClear &&
      result.subtreeRemoved,
  ).toBe(true);
  await testInfo.attach("catalog-runtime", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
});

test("atomically queues identity cleanup and preserves pending secrets on provider denial", async ({
  desktop,
}, testInfo) => {
  const result = await desktop.app.evaluate(async ({ app }) => {
    const require = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const fs = require("node:fs"),
      path = require("node:path"),
      { randomUUID } = require("node:crypto");
    const main = path.join(app.getAppPath(), "out/main");
    const { openMetadata } = require(path.join(main, "storage.js"));
    const { CatalogModule } = require(path.join(main, "catalog.js"));
    const { SecretService, TransientSecrets } = require(
      path.join(main, "secrets.js"),
    );
    const directory = fs.mkdtempSync(
      path.join(app.getPath("temp"), "ssterm-catalog-secret-runtime-"),
    );
    const items = new Map<string, Uint8Array>();
    const key = (item: any) => `${item.vaultId}/${item.kind}/${item.ref}`;
    let denied = true,
      deleteCalls = 0,
      repository: any;
    const provider = {
      async read(item: any) {
        const value = items.get(key(item));
        return value
          ? { status: "present", value: Uint8Array.from(value) }
          : { status: "missing" };
      },
      async lookup(item: any) {
        return { status: items.has(key(item)) ? "present" : "missing" };
      },
      async write(item: any, value: Uint8Array) {
        items.set(key(item), Uint8Array.from(value));
        return { status: "confirmed" };
      },
      async delete(item: any) {
        deleteCalls++;
        if (denied) return { status: "denied" };
        return { status: items.delete(key(item)) ? "confirmed" : "missing" };
      },
    };
    const transient = new TransientSecrets();
    try {
      repository = (
        await openMetadata({ path: path.join(directory, "catalog.sqlite") })
      ).value;
      const service = new SecretService({ repository, provider, transient });
      const identityId = randomUUID();
      const stored = await service.storeSecret({
        kind: "password",
        owner: { type: "identity", id: identityId, expectedRevision: null },
        value: new TextEncoder().encode("owned-catalog-fixture"),
        publish: (ref: string) => [
          {
            type: "create-identity",
            id: identityId,
            data: {
              label: "Saved fixture",
              username: "deploy",
              method: "password",
              passwordRef: ref,
            },
          },
        ],
      });
      if (stored.status !== "published")
        throw new Error(`Catalog secret fixture: ${stored.status}`);
      const catalog = new CatalogModule({ repository });
      const preview = catalog.prepare({
        type: "delete-identity",
        id: identityId,
        expectedRevision: 1,
        disposition: { mode: "detach" },
      });
      if (!preview.ok) throw new Error("Identity preview failed");
      const applied = catalog.apply(preview.value.token);
      if (!applied.ok) throw new Error("Identity delete failed");
      const queuedWithoutOSDelete =
        deleteCalls === 0 &&
        items.size === 1 &&
        repository.snapshot().value.identities.length === 0 &&
        applied.value.pendingSecretCleanupOperationIds.length === 1;
      await service.reconcile();
      const denialRetained =
        items.size === 1 &&
        repository
          .snapshot()
          .value.secretOperations.some(
            (op: any) => op.action === "delete" && op.state === "cleanup",
          );
      denied = false;
      await service.reconcile();
      return {
        queuedWithoutOSDelete,
        denialRetained,
        cleaned:
          items.size === 0 &&
          repository.snapshot().value.secretRefs.length === 0,
      };
    } finally {
      transient.purgeAll();
      repository?.close();
      for (const value of items.values()) value.fill(0);
      items.clear();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  expect(result).toEqual({
    queuedWithoutOSDelete: true,
    denialRetained: true,
    cleaned: true,
  });
  await testInfo.attach("catalog-secret-cleanup", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
});
