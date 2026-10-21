import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openMetadata, open } from "../../packages/adapters/src/index.ts";
import {
  SecretService,
  TransientSecrets,
} from "../../packages/services/src/index.ts";
import { MemorySecretProvider } from "../fixtures/secrets/memory-provider.ts";

test("sync snippet preparation is encrypted, atomic-ready and revision/lifecycle fenced", async (t) => {
  const dir = mkdtempSync("/private/tmp/ssterm-sync-snippet-");
  const result = await openMetadata({ path: join(dir, "catalog.sqlite") });
  assert.ok(result.ok);
  if (!result.ok) return;
  const repository = result.value;
  const provider = new MemorySecretProvider();
  const transient = new TransientSecrets();
  const service = new SecretService({ repository, provider, transient });
  t.after(() => {
    transient.purgeAll();
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const initial = repository.snapshot();
  assert.ok(initial.ok);
  if (!initial.ok) return;
  const id = randomUUID(),
    body = Buffer.from("sync-owned-ไทย\nline two");
  assert.equal(
    (
      await service.prepareSnippetImport({
        expectedCatalogRevision: initial.value.catalogRevision,
        snippets: [{ id, label: "Imported", body }],
      })
    ).status,
    "failed",
  );
  await service.initializeContentKey();
  const before = repository.snapshot();
  assert.ok(before.ok);
  if (!before.ok) return;
  const request = {
    expectedCatalogRevision: before.value.catalogRevision,
    snippets: [{ id, label: "Imported", body }],
  };
  assert.equal(
    (await service.prepareSnippetImport({ ...request, fence: () => false }))
      .status,
    "failed",
  );
  const prepared = await service.prepareSnippetImport(request);
  assert.equal(prepared.status, "ready");
  if (prepared.status !== "ready") return;
  const unchanged = repository.snapshot();
  assert.ok(unchanged.ok);
  if (!unchanged.ok) return;
  assert.equal(unchanged.value.snippets.length, 0);
  assert.equal(unchanged.value.catalogRevision, before.value.catalogRevision);
  assert.equal(prepared.changes.length, 1);
  assert.ok(!JSON.stringify(prepared.changes).includes(body.toString()));
  const applied = repository.commit({
    expectedCatalogRevision: prepared.catalogRevision,
    changes: prepared.changes,
  });
  assert.ok(applied.ok);
  if (!applied.ok) return;
  assert.equal((await service.prepareSnippetImport(request)).status, "failed");
  assert.equal(
    (await service.exportSnippetBodies([id], () => false)).status,
    "failed",
  );
  const captured = await service.exportSnippetBodies([id]);
  assert.equal(captured.status, "ready");
  if (captured.status === "ready") {
    assert.deepEqual(captured.bodies[0]!.body, body);
    captured.bodies[0]!.body.fill(0);
  }
  const key = await provider.read({
    vaultId: applied.value.vault.id,
    kind: "content-key",
    ref: applied.value.vault.contentKeyRef!,
  });
  assert.equal(key.status, "present");
  if (key.status !== "present") return;
  const decoded = open(
    key.value,
    { vaultId: applied.value.vault.id, snippetId: id, field: "body" },
    applied.value.snippets[0]!,
  );
  assert.deepEqual(decoded, body);
  decoded.fill(0);
  key.value.fill(0);
  assert.equal(
    (
      await service.prepareSnippetImport({
        expectedCatalogRevision: applied.value.catalogRevision,
        snippets: [{ id, label: "Overwrite", body, expectedRevision: 999 }],
      })
    ).status,
    "failed",
  );
});
