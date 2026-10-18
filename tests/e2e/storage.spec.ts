import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";

test("initializes one durable vault without exposing database details", async ({
  desktop,
}) => {
  const { page, profile } = desktop;
  const before = await page.evaluate(() => window.ssterm.bootstrap());
  expect(before.ok).toBe(true);
  if (!before.ok) throw new Error("Bootstrap failed");
  expect(before.value.storage).toEqual({ status: "ready", schemaVersion: 3 });
  expect(JSON.stringify(before)).not.toContain(profile);
  const database = await readFile(join(profile, "metadata/catalog.sqlite"));
  expect(database.subarray(0, 16).toString()).toBe("SQLite format 3\0");
  await page.reload();
  const after = await page.evaluate(() => window.ssterm.bootstrap());
  expect(after.ok && after.value.storage.status === "ready").toBe(true);
});

test("runs the shipped SQLite Adapter through atomic CRUD, backup and restart", async ({
  desktop,
}, testInfo) => {
  const result = await desktop.app.evaluate(async ({ app }) => {
    const require = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const fs = require("node:fs");
    const path = require("node:path");
    const { randomUUID, createHash } = require("node:crypto");
    const { openMetadata } = require(
      path.join(app.getAppPath(), "out/main/storage.js"),
    );
    const directory = fs.mkdtempSync(
      path.join(app.getPath("temp"), "ssterm-store-runtime-"),
    );
    const database = path.join(directory, "catalog.sqlite");
    let repository: any;
    let restored: any;
    try {
      const opened = await openMetadata({ path: database });
      if (!opened.ok) throw new Error("Runtime storage open failed");
      repository = opened.value;
      const initial = repository.snapshot().value;
      const hostId = randomUUID();
      const created = repository.commit({
        expectedCatalogRevision: initial.catalogRevision,
        changes: [
          {
            type: "create-host",
            id: hostId,
            data: { label: "เครื่องทดสอบ", address: "EXAMPLE.COM." },
          },
        ],
      });
      if (!created.ok) throw new Error("Runtime create failed");
      const host = created.value.hosts.find((row: any) => row.id === hostId);
      const rejected = repository.commit({
        expectedCatalogRevision: created.value.catalogRevision,
        changes: [
          {
            type: "update-host",
            id: hostId,
            expectedRevision: host.revision,
            data: { label: "Must roll back" },
          },
          {
            type: "create-host",
            id: randomUUID(),
            data: {
              label: "Bad relation",
              address: "invalid.example",
              groupId: randomUUID(),
            },
          },
        ],
      });
      const unchanged = repository.snapshot().value;
      const updated = repository.commit({
        expectedCatalogRevision: unchanged.catalogRevision,
        changes: [
          {
            type: "update-host",
            id: hostId,
            expectedRevision: host.revision,
            data: { label: "Updated · กรุงเทพฯ" },
          },
        ],
      });
      if (!updated.ok) throw new Error("Runtime update failed");
      const snapshotPath = path.join(directory, "backup.sqlite");
      const backup = await repository.backup({ destination: snapshotPath });
      if (!backup.ok) throw new Error("Runtime backup failed");
      const hash = createHash("sha256")
        .update(fs.readFileSync(snapshotPath))
        .digest("hex");
      const manifest = JSON.parse(
        fs.readFileSync(snapshotPath + ".manifest.json", "utf8"),
      );
      repository.close();
      repository.close();
      const reopened = await openMetadata({ path: database });
      if (!reopened.ok) throw new Error("Runtime reopen failed");
      repository = reopened.value;
      const persistent = repository.snapshot().value;
      const copy = path.join(directory, "restored.sqlite");
      fs.copyFileSync(snapshotPath, copy);
      const restoration = await openMetadata({ path: copy });
      if (!restoration.ok) throw new Error("Runtime restore copy failed");
      restored = restoration.value;
      const recovered = restored.snapshot().value;
      const deleted = repository.commit({
        expectedCatalogRevision: persistent.catalogRevision,
        changes: [
          {
            type: "delete-host",
            id: hostId,
            expectedRevision: persistent.hosts[0].revision,
          },
        ],
      });
      repository.close();
      repository = undefined;
      const permissiveFile = path.join(directory, "public-readable.sqlite");
      fs.copyFileSync(snapshotPath, permissiveFile);
      fs.chmodSync(permissiveFile, 0o644);
      const privateHash = createHash("sha256")
        .update(fs.readFileSync(permissiveFile))
        .digest("hex");
      const readable = await openMetadata({ path: permissiveFile });
      if (readable.ok) {
        readable.value.close();
        throw new Error("Permissive storage was accepted");
      }
      const permissiveDirectory = path.join(directory, "public-directory");
      fs.mkdirSync(permissiveDirectory, { mode: 0o755 });
      const publicStore = path.join(permissiveDirectory, "catalog.sqlite");
      fs.copyFileSync(snapshotPath, publicStore);
      fs.chmodSync(publicStore, 0o600);
      const publicFolder = await openMetadata({ path: publicStore });
      if (publicFolder.ok) {
        publicFolder.value.close();
        throw new Error("Permissive directory was accepted");
      }
      const { DatabaseSync } = require("node:sqlite");
      const future = new DatabaseSync(database);
      future.exec("PRAGMA user_version = 999");
      future.close();
      const beforeBlocked = createHash("sha256")
        .update(fs.readFileSync(database))
        .digest("hex");
      const newer = await openMetadata({ path: database });
      if (newer.ok) {
        newer.value.close();
        throw new Error("Newer schema was accepted");
      }
      return {
        electron: process.versions.electron,
        node: process.versions.node,
        created: {
          address: host.address,
          label: host.label,
          revision: host.revision,
        },
        rejected: !rejected.ok,
        rolledBack:
          unchanged.hosts[0].label === host.label &&
          unchanged.catalogRevision === created.value.catalogRevision,
        persisted: persistent.hosts[0].label,
        sameVault: persistent.vault.id === initial.vault.id,
        recovered: recovered.hosts[0].label,
        backup: {
          hashMatches: manifest.sha256 === hash,
          includesOsSecrets: manifest.includesOsSecrets,
          schemaVersion: manifest.schemaVersion,
        },
        deleted: deleted.ok && deleted.value.hosts.length === 0,
        newer: newer.error.code,
        privatePermissions:
          readable.error.code === "unwritable" &&
          publicFolder.error.code === "unwritable" &&
          (fs.statSync(permissiveFile).mode & 0o777) === 0o644 &&
          (fs.statSync(permissiveDirectory).mode & 0o777) === 0o755 &&
          privateHash ===
            createHash("sha256")
              .update(fs.readFileSync(permissiveFile))
              .digest("hex"),
        newerPreserved:
          beforeBlocked ===
          createHash("sha256").update(fs.readFileSync(database)).digest("hex"),
      };
    } finally {
      repository?.close();
      restored?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  expect(result.electron).toBe("44.7.2");
  expect(result.created).toEqual({
    address: "example.com",
    label: "เครื่องทดสอบ",
    revision: 1,
  });
  expect(
    result.rejected && result.rolledBack && result.sameVault && result.deleted,
  ).toBe(true);
  expect(result.persisted).toBe("Updated · กรุงเทพฯ");
  expect(result.recovered).toBe(result.persisted);
  expect(result.backup).toEqual({
    hashMatches: true,
    includesOsSecrets: false,
    schemaVersion: 3,
  });
  expect(result.newer).toBe("unsupported-schema");
  expect(result.newerPreserved).toBe(true);
  expect(result.privatePermissions).toBe(true);
  await testInfo.attach("sqlite-runtime", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
});

test.describe("blocked existing store", () => {
  test.use({ corruptStore: true });
  test("preserves corrupt bytes and reports a sanitized blocked state", async ({
    desktop,
  }) => {
    const { page, profile } = desktop;
    const result = await page.evaluate(() => window.ssterm.bootstrap());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Bootstrap failed");
    expect(result.value.storage.status).toBe("blocked");
    expect(JSON.stringify(result)).not.toContain(profile);
    await expect(page.getByRole("alert")).toBeVisible();
    expect(
      await readFile(join(profile, "metadata/catalog.sqlite"), "utf8"),
    ).toBe("ssterm-corrupt-owned-fixture");
  });
});
