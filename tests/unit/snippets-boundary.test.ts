import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { createSnippetsController, registerSnippetHandlers, snippetChannels } from "../../apps/desktop/src/main/snippets.ts";
import { createCatalogController } from "../../apps/desktop/src/main/catalog-controller.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { CatalogModule, SecretService, TransientSecrets } from "../../packages/services/src/index.ts";
import type { MetadataRepository, StoreResult } from "../../packages/domain/src/index.ts";
import {
  channels, failure, isDeleteSnippetRequest, isDeleteSnippetResponse, isOpenSnippetRequest, isOpenSnippetResponse,
  isSaveSnippetRequest, isSaveSnippetResponse, MAX_SNIPPET_BODY_BYTES, MAX_SNIPPET_TAGS, type Result,
} from "../../packages/contracts/src/index.ts";
import { MemorySecretProvider } from "../fixtures/secrets/memory-provider.ts";

const owner = { windowId: 1, generation: 1 };
const id = () => randomUUID();
const FIXTURE_BODY = "#!/bin/sh\r\nexport ข้อความ='สวัสดี 🚀'\n\tprintf '%s\\n' \"$ข้อความ\"\n\n";
function value<T>(result: Result<T> | StoreResult<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}

test("snippet request guards: exact keys, create vs update pairs, bounded body and unique tag ids", () => {
  const snippetId = id();
  const create = { owner, snippetId: null, expectedRevision: null, label: "x", body: "", tagIds: [] };
  assert.ok(isSaveSnippetRequest(create));
  assert.ok(isSaveSnippetRequest({ ...create, snippetId, expectedRevision: 3, body: "a".repeat(MAX_SNIPPET_BODY_BYTES), tagIds: [id()] }));
  for (const request of [
    { ...create, snippetId },
    { ...create, expectedRevision: 1 },
    { ...create, snippetId, expectedRevision: 0 },
    { ...create, body: "a".repeat(MAX_SNIPPET_BODY_BYTES + 1) },
    { ...create, body: new Uint8Array(1) },
    { ...create, label: "x".repeat(2049) },
    { ...create, tagIds: ["tag"] },
    { ...create, tagIds: Array.from({ length: MAX_SNIPPET_TAGS + 1 }, id) },
    (() => { const tag = id(); return { ...create, tagIds: [tag, tag] }; })(),
    { ...create, run: true },
    { ...create, owner: undefined },
  ]) assert.equal(isSaveSnippetRequest(request), false, JSON.stringify(request).slice(0, 120));
  assert.ok(isOpenSnippetRequest({ owner, snippetId, expectedRevision: 1 }));
  assert.equal(isOpenSnippetRequest({ owner, snippetId, expectedRevision: 1, field: "body" }), false);
  assert.ok(isDeleteSnippetRequest({ owner, snippetId, expectedRevision: 2 }));
  assert.equal(isDeleteSnippetRequest({ owner, snippetId }), false);

  assert.ok(isOpenSnippetResponse({ status: "open", revision: 1, body: "" }));
  assert.ok(isOpenSnippetResponse({ status: "key-unavailable", reason: "missing" }));
  assert.ok(isOpenSnippetResponse({ status: "corrupt" }));
  for (const response of [
    { status: "key-unavailable", reason: "uninitialized" },
    { status: "key-unavailable", reason: "errSecItemNotFound" },
    { status: "open", revision: 1, body: "x", keyRef: id() },
    { status: "open", revision: 1, body: new Uint8Array(1) },
  ]) assert.equal(isOpenSnippetResponse(response), false, JSON.stringify(response));
  assert.ok(isSaveSnippetResponse({ status: "saved", snippetId, revision: 1 }));
  assert.ok(isSaveSnippetResponse({ status: "invalid", field: "body", code: "too-large" }));
  assert.equal(isSaveSnippetResponse({ status: "invalid", field: "body", code: "empty" }), false);
  assert.equal(isSaveSnippetResponse({ status: "saved", snippetId, revision: 1, body: "x" }), false);
  assert.ok(isDeleteSnippetResponse({ status: "deleted" }));
});

async function fixture(t: TestContext) {
  const dir = mkdtempSync("/private/tmp/ssterm-snippets-test-");
  const path = join(dir, "catalog.sqlite");
  const repo = value(await openMetadata({ path })) as MetadataRepository;
  const transient = new TransientSecrets();
  const provider = new MemorySecretProvider();
  const secrets = new SecretService({ repository: repo, provider, transient });
  const lock = { locked: false, lockEpoch: 0, allow: true,
    async unlock(check: () => Promise<boolean>, since?: number) {
      if (since !== undefined && since !== this.lockEpoch) return false;
      if (await check() && this.allow) this.locked = false;
      return !this.locked;
    } };
  const controller = createSnippetsController({ repository: repo, secrets: () => secrets, lock, checkAccess: async () => true });
  const catalog = createCatalogController({ repository: repo, catalog: new CatalogModule({ repository: repo }), lockEpoch: () => lock.lockEpoch });
  catalog.register(owner, () => {});
  t.after(() => {
    controller.dispose();
    catalog.dispose();
    transient.purgeAll();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const tag = (label: string) => {
    const tagId = id();
    const s = value(repo.snapshot());
    value(repo.commit({ expectedCatalogRevision: s.catalogRevision, changes: [{ type: "create-tag", id: tagId, data: { label } }] }));
    return tagId;
  };
  return { dir, path, repo, provider, controller, catalog, lock, tag, state: () => value(catalog.catalogState(owner)) };
}

test("first save creates the vault key once; bodies round-trip exactly; catalog state carries labels and tags only", async (t) => {
  const s = await fixture(t);
  const ops = s.tag("ops"), db = s.tag("ฐานข้อมูล");
  const saved = value(await s.controller.saveSnippet({ owner, snippetId: null, expectedRevision: null, label: "  Deploy ไทย  ", body: FIXTURE_BODY, tagIds: [ops, db] }));
  assert.equal(saved.status, "saved");
  const snippetId = (saved as { snippetId: string }).snippetId;
  assert.equal(s.provider.count("write"), 1, "one content key");
  const empty = value(await s.controller.saveSnippet({ owner, snippetId: null, expectedRevision: null, label: "Empty", body: "", tagIds: [] }));
  assert.equal(empty.status, "saved");
  assert.equal(s.provider.count("write"), 1, "the key is never replaced or duplicated");

  const state = s.state();
  assert.deepEqual(state.snippets.map((row) => row.label), ["Deploy ไทย", "Empty"]);
  const row = state.snippets.find((snippet) => snippet.id === snippetId)!;
  assert.deepEqual(row.tagIds, [ops, db], "sorted by tag label");
  const serialized = JSON.stringify(state);
  for (const needle of ["สวัสดี", "printf", "bodyEnvelope", "keyRef", "contentKeyRef", "protectionFormat"])
    assert.ok(!serialized.includes(needle), needle);

  assert.deepEqual(value(await s.controller.openSnippet({ owner, snippetId, expectedRevision: 1 })), { status: "open", revision: 1, body: FIXTURE_BODY });
  const emptyId = (empty as { snippetId: string }).snippetId;
  assert.deepEqual(value(await s.controller.openSnippet({ owner, snippetId: emptyId, expectedRevision: 1 })), { status: "open", revision: 1, body: "" });
  for (const file of [s.path, `${s.path}-wal`].filter(existsSync)) {
    const raw = readFileSync(file);
    for (const needle of ["สวัสดี", "printf", "#!/bin/sh"]) assert.ok(!raw.includes(Buffer.from(needle)), `${needle} in ${file}`);
  }

  // Edit: new body and tag set; stale revisions are conflicts and change nothing.
  const edited = value(await s.controller.saveSnippet({ owner, snippetId, expectedRevision: 1, label: "Deploy", body: `${FIXTURE_BODY}echo ok`, tagIds: [ops] }));
  assert.deepEqual(edited, { status: "saved", snippetId, revision: 2 });
  assert.deepEqual(await s.controller.saveSnippet({ owner, snippetId, expectedRevision: 1, label: "Stale", body: "x", tagIds: [] }), failure("conflict"));
  assert.deepEqual(await s.controller.openSnippet({ owner, snippetId, expectedRevision: 1 }), failure("conflict"));
  assert.deepEqual(value(await s.controller.openSnippet({ owner, snippetId, expectedRevision: 2 })), { status: "open", revision: 2, body: `${FIXTURE_BODY}echo ok` });
  assert.deepEqual(s.state().snippets.find((snippet) => snippet.id === snippetId)?.tagIds, [ops]);

  // Delete: stale refused; current removes the row; the key stays.
  assert.deepEqual(await s.controller.deleteSnippet({ owner, snippetId, expectedRevision: 1 }), failure("conflict"));
  assert.deepEqual(value(await s.controller.deleteSnippet({ owner, snippetId, expectedRevision: 2 })), { status: "deleted" });
  assert.deepEqual(s.state().snippets.map((snippet) => snippet.id), [emptyId]);
  assert.equal(s.provider.items.size, 1);
});

test("field problems are typed and nothing is written; a missing key is reported without regeneration", async (t) => {
  const s = await fixture(t);
  const create = { owner, snippetId: null, expectedRevision: null, body: "echo", tagIds: [] as string[] };
  assert.deepEqual(value(await s.controller.saveSnippet({ ...create, label: "   " })), { status: "invalid", field: "label", code: "empty" });
  assert.deepEqual(value(await s.controller.saveSnippet({ ...create, label: "a\tb" })), { status: "invalid", field: "label", code: "control" });
  assert.deepEqual(value(await s.controller.saveSnippet({ ...create, label: "x".repeat(201) })), { status: "invalid", field: "label", code: "too-long" });
  assert.deepEqual(value(await s.controller.saveSnippet({ ...create, label: "x", body: "bad \uD800 text" })), { status: "invalid", field: "body", code: "invalid-text" });
  // Under the UTF-16 guard but over 1 MiB of UTF-8.
  assert.deepEqual(value(await s.controller.saveSnippet({ ...create, label: "x", body: "ก".repeat(400_000) })), { status: "invalid", field: "body", code: "too-large" });
  assert.deepEqual(value(await s.controller.saveSnippet({ ...create, label: "x", tagIds: [id()] })), { status: "invalid", field: "tag", code: "not-found" });
  assert.equal(s.provider.count("write"), 0, "no key is created for a refused save");
  assert.equal(value(s.repo.snapshot()).snippets.length, 0);

  const saved = value(await s.controller.saveSnippet({ ...create, label: "Keep" })) as { snippetId: string };
  const before = Buffer.from(value(s.repo.snapshot()).snippets[0]!.bodyEnvelope);
  s.provider.items.clear();
  assert.deepEqual(value(await s.controller.openSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1 })), { status: "key-unavailable", reason: "missing" });
  assert.deepEqual(value(await s.controller.saveSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1, label: "Keep", body: "new", tagIds: [] })),
    { status: "key-unavailable", reason: "missing" });
  assert.deepEqual(value(await s.controller.saveSnippet({ ...create, label: "Another" })), { status: "key-unavailable", reason: "missing" });
  assert.equal(s.provider.items.size, 0, "never regenerated");
  assert.deepEqual(Buffer.from(value(s.repo.snapshot()).snippets[0]!.bodyEnvelope), before);
  // Deletion needs no key.
  assert.deepEqual(value(await s.controller.deleteSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1 })), { status: "deleted" });
});

test("lock: the explicit action unlocks; an action from before a later lock gets no plaintext; catalog state reports the lock epoch", async (t) => {
  const s = await fixture(t);
  const saved = value(await s.controller.saveSnippet({ owner, snippetId: null, expectedRevision: null, label: "L", body: FIXTURE_BODY, tagIds: [] })) as { snippetId: string };
  assert.equal(s.state().lockEpoch, 0);
  s.lock.locked = true;
  s.lock.lockEpoch = 1;
  assert.equal(s.state().lockEpoch, 1);
  s.lock.allow = false;
  assert.deepEqual(await s.controller.openSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1 }), failure("unavailable"));
  s.lock.allow = true;
  assert.equal(value(await s.controller.openSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1 })).status, "open");
  // A lock while the decrypt is in flight discards the result.
  const pending = s.controller.openSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1 });
  s.lock.locked = true;
  s.lock.lockEpoch = 2;
  assert.deepEqual(await pending, failure("unavailable"));
});

test("lock while a save or delete waits on the Keychain or the queue: nothing is committed and the request fails", async (t) => {
  const s = await fixture(t);
  const saved = value(await s.controller.saveSnippet({ owner, snippetId: null, expectedRevision: null, label: "Fenced", body: "v1", tagIds: [] })) as { snippetId: string };
  const before = value(s.repo.snapshot());
  const read = s.provider.read.bind(s.provider);
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  s.provider.read = async (item) => { await gate; return read(item); };
  const pending = s.controller.saveSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1, label: "Fenced", body: "v2 after lock", tagIds: [] });
  // A delete queued behind the save is fenced too.
  const queued = s.controller.deleteSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1 });
  await new Promise((done) => setImmediate(done));
  s.lock.locked = true;
  s.lock.lockEpoch = 1;
  release();
  assert.deepEqual(await pending, failure("unavailable"));
  assert.deepEqual(await queued, failure("unavailable"));
  s.provider.read = read;
  const after = value(s.repo.snapshot());
  assert.equal(after.catalogRevision, before.catalogRevision);
  assert.deepEqual(Buffer.from(after.snippets[0]!.bodyEnvelope), Buffer.from(before.snippets[0]!.bodyEnvelope));
  // The next explicit action unlocks and works.
  assert.deepEqual(value(await s.controller.openSnippet({ owner, snippetId: saved.snippetId, expectedRevision: 1 })), { status: "open", revision: 1, body: "v1" });
});

test("snippet IPC requires the owning main frame and one valid argument; channels are removable", async () => {
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send() {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } };
  const calls: unknown[] = [];
  const controller = {
    openSnippet: async (request: unknown) => (calls.push(request), { ok: true, value: { status: "corrupt" } }),
    saveSnippet: async (request: unknown) => (calls.push(request), { ok: true, value: { status: "corrupt" } }),
    deleteSnippet: async (request: unknown) => (calls.push(request), { ok: true, value: { status: "deleted" } }),
    dispose() {},
  } as unknown as ReturnType<typeof createSnippetsController>;
  const unregister = registerSnippetHandlers({ ipc, boundary, controller: () => controller });
  assert.deepEqual([...handlers.keys()].sort(), [...snippetChannels].sort());
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const request = { owner, snippetId: id(), expectedRevision: 1 };
  assert.deepEqual(await handlers.get(channels.openSnippet)!(event, request), { ok: true, value: { status: "corrupt" } });
  assert.deepEqual(await handlers.get(channels.openSnippet)!(event, request, "extra"), failure("invalid-request"));
  assert.deepEqual(await handlers.get(channels.deleteSnippet)!(event, { ...request, expectedRevision: 0 }), failure("invalid-request"));
  const frame = { sender, senderFrame: { url: "https://evil.example/" } } as unknown as IpcMainInvokeEvent;
  assert.equal(((await handlers.get(channels.saveSnippet)!(frame, { owner, snippetId: null, expectedRevision: null, label: "x", body: "", tagIds: [] })) as Result<unknown>).ok, false);
  assert.deepEqual(await handlers.get(channels.openSnippet)!(event, { ...request, owner: { windowId: 1, generation: 9 } }), failure("stale-owner"));
  assert.equal(calls.length, 1);
  unregister();
  assert.equal(handlers.size, 0);
});
