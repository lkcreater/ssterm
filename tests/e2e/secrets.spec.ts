import { test, expect } from "./fixtures";

test("runs the shipped Keychain provider and secret service under an owned test namespace", async ({
  desktop,
}, testInfo) => {
  const result = await desktop.app.evaluate(async ({ app }) => {
    const require = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const fs = require("node:fs");
    const path = require("node:path");
    const { randomUUID } = require("node:crypto");
    const main = path.join(app.getAppPath(), "out/main");
    const { openMetadata } = require(path.join(main, "storage.js"));
    const {
      KeychainSecretProvider,
      SecretService,
      TransientSecrets,
      clearTestNamespace,
    } = require(path.join(main, "secrets.js"));
    // Never the production namespace; teardown deletes only this namespace's items.
    const namespace = `dev.ssterm.test.${randomUUID()}`;
    const directory = fs.mkdtempSync(
      path.join(app.getPath("temp"), "ssterm-secrets-runtime-"),
    );
    const database = path.join(directory, "catalog.sqlite");
    const password = "fixture-e2e-password-รหัส";
    const replacement = "fixture-e2e-replacement-ใหม่";
    const body = "fixture-e2e-body: echo สวัสดี";
    const encoder = new TextEncoder();
    const transient = new TransientSecrets();
    let repository: any;
    let remaining = -1;
    let outcome: Record<string, unknown> = {};
    try {
      repository = (await openMetadata({ path: database })).value;
      const provider = new KeychainSecretProvider(namespace);
      const item = {
        vaultId: randomUUID(),
        kind: "password",
        ref: randomUUID(),
      };
      const binary = Uint8Array.from([0, 255, 1, 128, ...encoder.encode(password)]);
      const direct = {
        missing: (await provider.read(item)).status,
        write: (await provider.write(item, binary)).status,
        roundTrip:
          Buffer.compare(
            Buffer.from((await provider.read(item)).value),
            Buffer.from(binary),
          ) === 0,
        lookup: JSON.stringify(await provider.lookup(item)),
        delete: (await provider.delete(item)).status,
        after: (await provider.read(item)).status,
      };
      let service = new SecretService({ repository, provider, transient });
      const key = await service.initializeContentKey();
      const snippetId = randomUUID();
      const saved = await service.saveSnippet({
        id: snippetId,
        label: "คำสั่ง",
        body: encoder.encode(body),
      });
      const identityId = randomUUID();
      const created = await service.storeSecret({
        kind: "password",
        owner: { type: "identity", id: identityId, expectedRevision: null },
        value: encoder.encode(password),
        publish: (ref: string) => [
          {
            type: "create-identity",
            id: identityId,
            data: { label: "Lab", username: "alice", method: "password", passwordRef: ref },
          },
        ],
      });
      const replaced = await service.storeSecret({
        kind: "password",
        owner: { type: "identity", id: identityId, expectedRevision: 1 },
        oldRef: created.ref,
        value: encoder.encode(replacement),
      });
      const stored = repository.snapshot().value;
      const readBack = await provider.read({
        vaultId: stored.vault.id,
        kind: "password",
        ref: replaced.ref,
      });
      const oldGone = (
        await provider.lookup({
          vaultId: stored.vault.id,
          kind: "password",
          ref: created.ref,
        })
      ).status;
      const removed = await service.removeSecrets(
        [{ type: "delete-identity", id: identityId, expectedRevision: 2 }],
        [replaced.ref],
      );
      repository.close();
      repository = (await openMetadata({ path: database })).value;
      service = new SecretService({ repository, provider, transient });
      const reopened = await service.openSnippet(snippetId);
      const decrypted = reopened.body.use((bytes: Uint8Array) =>
        Buffer.from(bytes).toString("utf8"),
      );
      const purged = transient.purgeAll();
      const final = repository.snapshot().value;
      repository.close();
      repository = undefined;
      const files = fs
        .readdirSync(directory)
        .map((name: string) => fs.readFileSync(path.join(directory, name)));
      outcome = {
        electron: process.versions.electron,
        direct,
        key: key.status,
        saved: saved.status,
        created: created.status,
        replaced: replaced.status,
        replacementRead:
          Buffer.from(readBack.value).toString("utf8") === replacement,
        oldGone,
        removed: removed.cleanup.map((c: { status: string }) => c.status),
        decrypted: decrypted === body,
        purged,
        disposed: reopened.body.disposed,
        finalRefs: final.secretRefs.map((r: { kind: string }) => r.kind),
        pendingOperations: final.secretOperations.filter(
          (op: { state: string }) => op.state !== "complete",
        ).length,
        // Packaged builds must load the bundled arm64 binding, not a repository copy.
        binding: Object.keys(require("node:module")._cache)
          .filter((name: string) => name.endsWith(".node"))
          .map((name: string) =>
            name.startsWith(app.getAppPath())
              ? path.relative(app.getAppPath(), name)
              : "outside-app",
          ),
        plaintextInDatabase: files.some((bytes: Buffer) =>
          [password, replacement, body].some((v) => bytes.includes(Buffer.from(v))),
        ),
      };
    } finally {
      repository?.close();
      remaining = await clearTestNamespace(namespace);
      fs.rmSync(directory, { recursive: true, force: true });
    }
    return { ...outcome, leftoverItems: remaining } as any;
  });
  expect(result.direct).toEqual({
    missing: "missing",
    write: "confirmed",
    roundTrip: true,
    lookup: '{"status":"present"}',
    delete: "confirmed",
    after: "missing",
  });
  expect(result).toMatchObject({
    electron: "44.7.2",
    key: "published",
    saved: "saved",
    created: "published",
    replaced: "published",
    replacementRead: true,
    oldGone: "missing",
    removed: ["cleaned"],
    decrypted: true,
    purged: 1,
    disposed: true,
    finalRefs: ["content-key"],
    pendingOperations: 0,
    plaintextInDatabase: false,
    leftoverItems: 0,
  });
  expect(result.binding).toEqual(
    process.env.SSTERM_PACKAGED_EXECUTABLE
      ? ["node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node"]
      : ["outside-app"],
  );
  await testInfo.attach("secrets-runtime", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
});
