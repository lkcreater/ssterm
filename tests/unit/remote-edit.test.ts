import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { RemoteEditFiles, RemoteEditIOResult, RemoteEditSnapshot, RemoteReader, RemoteWriter, SftpSession } from "../../packages/domain/src/index.ts";
import { createRemoteEditService } from "../../packages/services/src/remote-edit.ts";

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
async function until(predicate: () => boolean) {
  for (let n = 0; n < 500 && !predicate(); n++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert(predicate(), "expected service state");
}
function fixture() {
  let local: Buffer = Buffer.from("original"), remoteBytes: Buffer = Buffer.from("original");
  let disposedSnapshots = 0, cleanupCalls = 0, editorCalls = 0, writes = 0, publications = 0, reads = 0;
  let valid = true, stalls = 0, cleanupFails = false, handleCloses = 0;
  const stages = new Map<string, Buffer>();
  const reader = (content: Buffer): RemoteReader => ({
    read: async (position, size) => ok(position >= content.length ? null : content.subarray(position, position + size)),
    close: async () => { handleCloses++; return ok(undefined); },
  });
  const workspace = {
    documentPath: "/private/owned/document.txt",
    openWrite: async () => ok<RemoteWriter>({ write: async (position, bytes) => {
      if (position === 0) local = Buffer.alloc(0);
      local = Buffer.concat([local, Buffer.from(bytes)]); return ok(undefined);
    }, close: async () => ok(undefined) }),
    snapshot: async (): Promise<RemoteEditIOResult<RemoteEditSnapshot>> => {
      const content = Buffer.from(local);
      return ok({ size: content.length, sha256: hash(content), openRead: async () => ok(reader(content)), dispose: async () => { disposedSnapshots++; return ok(undefined); } });
    },
    cleanup: async (): Promise<RemoteEditIOResult<void>> => { cleanupCalls++; return cleanupFails ? { ok: false, code: "permission-denied" } : ok(undefined); },
  };
  const remote: SftpSession = {
    home: "/", maxRead: 3, maxWrite: 2, atomicReplace: true,
    realpath: async (path) => ok(path), stat: async () => ok({ type: "file", size: remoteBytes.length, mtime: 10, permissions: 0o600 }),
    lstat: async () => ok({ type: "file", size: remoteBytes.length, mtime: 10, permissions: 0o600 }),
    list: async () => ok({ entries: [], truncated: false, skipped: 0 }),
    openRead: async () => { reads++; return ok(reader(Buffer.from(remoteBytes))); },
    openWrite: async (path, mode) => {
      assert.equal(mode.mode, 0o600); assert.match(path, /^\/folder\/\.ssterm-[a-f0-9-]+\.part$/);
      stages.set(path, Buffer.alloc(0));
      return ok({ write: async (_position, bytes) => { writes++; stages.set(path, Buffer.concat([stages.get(path)!, Buffer.from(bytes)])); return ok(undefined); }, close: async () => ok(undefined) });
    },
    publish: async (source, destination, options) => { publications++; assert.equal(destination, "/folder/remote.txt"); assert.deepEqual(options, { replace: true }); remoteBytes = stages.get(source)!; stages.delete(source); return ok({ retainedPartial: false }); },
  };
  const files = { create: async () => ok(workspace), prune: async () => ok(undefined) };
  const editor = { open: async (path: string) => { assert.equal(path, workspace.documentPath); editorCalls++; return ok(undefined); } };
  const input = { owner: "owner", sessionId: "sftp", generation: 1, target: { label: "Owned", environment: "PROD" as const, endpointHost: "127.0.0.1", endpointPort: 22, username: "fixture" },
    path: "/folder/remote.txt", remote, validate: () => valid, onStall: () => { stalls++; } };
  const service = createRemoteEditService({ files, editor });
  const view = () => service.snapshot("owner")[0]!;
  const ready = async () => { assert(service.start(input).ok); await until(() => view()?.state === "ready" && view()?.cleanupPending === false); await new Promise((r) => setTimeout(r, 0)); };
  const check = async () => { assert(service.check("owner", view().id, view().revision).ok); await until(() => ["changed", "conflict", "editing", "failed"].includes(view()?.state)); await new Promise((r) => setTimeout(r, 0)); };
  return { service, input, files, editor, remote, workspace, stages, view, ready, check,
    get local() { return local; }, set local(value: Buffer) { local = value; }, get remoteBytes() { return remoteBytes; }, set remoteBytes(value: Buffer) { remoteBytes = value; },
    get disposedSnapshots() { return disposedSnapshots; }, get cleanupCalls() { return cleanupCalls; }, get editorCalls() { return editorCalls; }, get writes() { return writes; }, get publications() { return publications; },
    get reads() { return reads; }, get stalls() { return stalls; }, get handleCloses() { return handleCloses; }, set valid(value: boolean) { valid = value; }, set cleanupFails(value: boolean) { cleanupFails = value; } };
}

test("remote edit requires explicit open/check/upload; projects no local paths/digests and keeps newer saves", async () => {
  const f = fixture(); await f.ready();
  assert.equal(f.editorCalls, 0); assert.equal(f.writes, 0); assert.equal(f.publications, 0);
  assert.equal(f.reads, 3); assert.equal(f.service.pendingCount(), 1);
  assert.equal(JSON.stringify(f.view()).includes("/private/owned"), false);
  assert.equal(JSON.stringify(f.view()).includes(hash(f.local)), false);
  assert.deepEqual(f.service.snapshot("other"), []);
  assert.deepEqual(f.service.openEditor("other", f.view().id, f.view().revision), { ok: false, code: "closed" });
  assert(f.service.openEditor("owner", f.view().id, f.view().revision).ok);
  await until(() => f.editorCalls === 1 && f.view().state === "editing"); await new Promise((r) => setTimeout(r, 0));
  f.local = Buffer.from("approved"); await f.check();
  assert.equal(f.view().state, "changed"); assert(f.view().approvalId);
  assert.deepEqual(f.service.upload("owner", f.view().id, f.view().revision, "wrong"), { ok: false, code: "invalid-request" });
  const publishing = defer<Awaited<ReturnType<NonNullable<SftpSession["publish"]>>>>();
  const originalPublish = f.remote.publish!;
  f.remote.publish = async (...args) => { const result = await originalPublish(...args); await publishing.promise; return result; };
  assert(f.service.upload("owner", f.view().id, f.view().revision, f.view().approvalId!).ok);
  await until(() => f.view().state === "publishing");
  f.local = Buffer.from("newer editor save");
  assert.deepEqual(f.service.discard("owner", f.view().id, f.view().revision), { ok: false, code: "invalid-request" });
  publishing.resolve(ok({ retainedPartial: false })); await until(() => f.view().state === "uploaded"); await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.remoteBytes.toString(), "approved"); assert.equal(f.cleanupCalls, 0);
  assert.equal(f.local.toString(), "newer editor save");
  await f.check(); assert.equal(f.view().state, "changed");
  assert(f.service.discard("owner", f.view().id, f.view().revision).ok);
  await until(() => f.service.pendingCount() === 0); assert.equal(f.cleanupCalls, 1);
  await f.service.dispose();
});

test("same-size remote mutation with identical mtime blocks upload and never publishes", async () => {
  const f = fixture(); await f.ready(); f.local = Buffer.from("approved");
  f.remoteBytes = Buffer.from("mutated!"); await f.check();
  assert.equal(f.view().state, "conflict"); assert.equal(f.view().error, "remote-changed"); assert.equal(f.view().approvalId, null); assert.equal(f.writes, 0);
  await f.service.dispose();
});

test("unstable initial download is rejected and private workspace cleaned", async () => {
  const f = fixture(); const original = f.remote.openRead;
  f.remote.openRead = async (...args) => { if (f.reads === 1) f.remoteBytes = Buffer.from("mutated!"); return original(...args); };
  assert(f.service.start(f.input).ok); await until(() => f.view().state === "failed" && f.cleanupCalls === 1);
  assert.equal(f.view().error, "remote-changed"); assert.equal(f.editorCalls, 0); assert.equal(f.publications, 0);
  await f.service.dispose();
});

test("changed local snapshot invalidates prior approval before remote staging", async () => {
  const f = fixture(); await f.ready(); f.local = Buffer.from("approved"); await f.check();
  const revision = f.view().revision, token = f.view().approvalId!;
  assert.deepEqual(f.service.upload("owner", f.view().id, revision - 1, token), { ok: false, code: "invalid-request" });
  f.local = Buffer.from("changed after consent");
  assert(f.service.upload("owner", f.view().id, revision, token).ok);
  await until(() => f.view().state === "failed"); assert.equal(f.view().error, "local-changed"); assert.equal(f.writes, 0); assert.equal(f.publications, 0);
  await f.service.dispose();
});

test("remote mutation after staging retains partial and blocks final publication", async () => {
  const f = fixture(); await f.ready(); f.local = Buffer.from("approved"); await f.check();
  const openWrite = f.remote.openWrite;
  f.remote.openWrite = async (...args) => { const opened = await openWrite(...args); assert(opened.ok); const close = opened.value.close;
    opened.value.close = async () => { f.remoteBytes = Buffer.from("mutated!"); return close(); }; return opened;
  };
  assert(f.service.upload("owner", f.view().id, f.view().revision, f.view().approvalId!).ok);
  await until(() => f.view().state === "conflict"); assert.equal(f.view().error, "remote-changed"); assert.equal(f.publications, 0); assert(f.view().partialPath); assert.equal(f.cleanupCalls, 0);
  await f.service.dispose(); assert.equal(f.stages.size, 1);
});

test("unconfirmed publication is never retried and requires explicit discard", async () => {
  const f = fixture(); await f.ready(); f.local = Buffer.from("approved"); await f.check();
  f.remote.publish = async () => ({ ok: false, code: "connection-lost" });
  assert(f.service.upload("owner", f.view().id, f.view().revision, f.view().approvalId!).ok);
  await until(() => f.view().state === "failed");
  assert.equal(f.view().error, "publication-unknown"); assert(f.view().partialPath); assert.equal(f.view().approvalId, null);
  await f.service.dispose();
});

test("eight retained documents and two native workers stay bounded through cancellation and late resources", async () => {
  const f = fixture(); const held = defer<{ ok: true; value: typeof f.workspace }>(); let creates = 0;
  f.files.create = async () => { creates++; return held.promise; };
  const service = createRemoteEditService({ files: f.files, editor: f.editor, operationTimeoutMs: 10, shutdownTimeoutMs: 10 });
  for (let n = 0; n < 8; n++) assert(service.start(f.input).ok);
  assert.deepEqual(service.start(f.input), { ok: false, code: "resource-limit" });
  await until(() => creates === 2); service.lock();
  await service.dispose(); assert.equal(creates, 2); assert.equal(service.pendingCount(), 8); assert.equal(f.cleanupCalls, 0);
  held.resolve(ok(f.workspace)); await until(() => service.pendingCount() === 0);
  assert.equal(creates, 2); assert.equal(f.cleanupCalls, 2);
  await f.service.dispose();
});

test("cleanup failures remain visible/countable and explicit discard retries cleanup", async () => {
  const f = fixture(); await f.ready(); f.cleanupFails = true;
  assert(f.service.discard("owner", f.view().id, f.view().revision).ok);
  await until(() => f.view().state === "cleanup-failed"); await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.service.pendingCount(), 1); assert.equal(f.view().cleanupPending, true);
  f.cleanupFails = false;
  assert(f.service.discard("owner", f.view().id, f.view().revision).ok);
  await until(() => f.service.pendingCount() === 0); assert.equal(f.cleanupCalls, 2); await f.service.dispose();
});

test("failed creation retains an inert cleanup capability until explicit discard succeeds", async () => {
  const f = fixture();
  f.cleanupFails = true;
  const files: RemoteEditFiles = {
    prune: f.files.prune,
    create: async () => ok({ ...f.workspace,
      openWrite: async () => ({ ok: false as const, code: "no-space" as const }),
      snapshot: async () => ({ ok: false as const, code: "no-space" as const }),
    }),
  };
  const service = createRemoteEditService({ files, editor: f.editor });
  const view = () => service.snapshot("owner")[0]!;
  assert(service.start(f.input).ok);
  await until(() => view()?.state === "cleanup-failed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(service.pendingCount(), 1);
  assert.equal(view().localAvailable, false);
  assert.equal(f.editorCalls, 0);
  assert.equal(f.writes, 0);
  f.cleanupFails = false;
  assert(service.discard("owner", view().id, view().revision).ok);
  await until(() => service.pendingCount() === 0);
  assert.deepEqual(service.snapshot("owner"), []);
  assert.equal(f.cleanupCalls, 2);
  await service.dispose(); await f.service.dispose();
});

test("invalid capability fences local creation, editor launch and remote writes", async () => {
  const f = fixture(); await f.ready(); f.valid = false;
  assert.deepEqual(f.service.openEditor("owner", f.view().id, f.view().revision), { ok: false, code: "closed" });
  assert.deepEqual(f.service.check("owner", f.view().id, f.view().revision), { ok: false, code: "closed" });
  assert.equal(f.editorCalls, 0); assert.equal(f.writes, 0);
  f.service.closeSession("owner", "sftp", 2); assert.equal(f.service.pendingCount(), 1);
  f.service.closeSession("owner", "sftp", 1); await until(() => f.service.pendingCount() === 0);
  assert.deepEqual(f.service.start(f.input), { ok: false, code: "closed" }); await f.service.dispose();
});

test("unsupported replacement and oversized remote files fail before copying or editor launch", async () => {
  for (const reason of ["unsupported", "too-large"] as const) {
    const f = fixture();
    if (reason === "unsupported") Object.assign(f.remote, { atomicReplace: false });
    else f.remote.lstat = async () => ok({ type: "file", size: 8 * 1024 * 1024 + 1, mtime: null, permissions: null });
    assert(f.service.start(f.input).ok); await until(() => f.view().state === "failed");
    assert.equal(f.view().error, reason); assert.equal(f.reads, 0); assert.equal(f.editorCalls, 0); assert.equal(f.writes, 0);
    await until(() => !f.view().cleanupPending);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(f.service.pendingCount(), 0, "clean failed-download history has no working copy or native I/O");
    await f.service.dispose();
  }
});

test("cancelled late remote open holds worker, triggers captured-session watchdog, then closes its handle", async () => {
  const f = fixture(); const held = defer<{ ok: true; value: RemoteReader }>(); let opened = 0, closed = 0;
  f.remote.openRead = async () => { opened++; return held.promise; };
  const service = createRemoteEditService({ files: f.files, editor: f.editor, cleanupTimeoutMs: 5, shutdownTimeoutMs: 5 });
  assert(service.start(f.input).ok); await until(() => opened === 1);
  service.closeOwner("owner"); await until(() => f.stalls === 1);
  assert.equal(service.pendingCount(), 1); assert.equal(f.cleanupCalls, 0);
  held.resolve(ok({ read: async () => ok(null), close: async () => { closed++; return ok(undefined); } }));
  await until(() => service.pendingCount() === 0); assert.equal(closed, 1); assert.equal(f.cleanupCalls, 0);
  await service.dispose(); await f.service.dispose();
});

test("publication acknowledgement remains authoritative after session closes in flight", async () => {
  const f = fixture(); await f.ready(); f.local = Buffer.from("approved"); await f.check();
  const held = defer<Awaited<ReturnType<NonNullable<SftpSession["publish"]>>>>();
  const originalPublish = f.remote.publish!; let dispatched = false;
  f.remote.publish = async (...args) => { const result = await originalPublish(...args); dispatched = true; await held.promise; return result; };
  const states: string[] = []; f.service.subscribe("owner", (views) => { for (const view of views) states.push(view.state); });
  assert(f.service.upload("owner", f.view().id, f.view().revision, f.view().approvalId!).ok);
  await until(() => dispatched); f.service.closeSession("owner", "sftp", 1);
  held.resolve(ok({ retainedPartial: false })); await until(() => f.service.pendingCount() === 0);
  assert(states.includes("uploaded")); assert.equal(f.remoteBytes.toString(), "approved"); assert.equal(f.cleanupCalls, 1);
  assert.equal(f.view().state, "uploaded", "confirmed publication remains authoritative in final clean history");
  assert.equal(f.view().localAvailable, false);
  await f.service.dispose();
});

test("publication timeout stays unknown and retains worker until native acknowledgement settles", async () => {
  const f = fixture();
  const service = createRemoteEditService({ files: f.files, editor: f.editor, operationTimeoutMs: 10, cleanupTimeoutMs: 5 });
  assert(service.start(f.input).ok); const view = () => service.snapshot("owner")[0]!;
  await until(() => view()?.state === "ready"); await new Promise((r) => setTimeout(r, 0));
  f.local = Buffer.from("approved"); assert(service.check("owner", view().id, view().revision).ok);
  await until(() => view().state === "changed"); await new Promise((r) => setTimeout(r, 0));
  const held = defer<Awaited<ReturnType<NonNullable<SftpSession["publish"]>>>>(); f.remote.publish = () => held.promise;
  assert(service.upload("owner", view().id, view().revision, view().approvalId!).ok);
  await until(() => view().error === "publication-unknown"); assert.equal(f.stalls, 1); assert.equal(view().cleanupPending, true);
  assert.deepEqual(service.check("owner", view().id, view().revision), { ok: false, code: "invalid-request" });
  held.resolve(ok({ retainedPartial: false })); await until(() => !view().cleanupPending);
  assert.equal(view().error, "publication-unknown"); assert.equal(f.cleanupCalls, 0);
  await service.dispose(); await f.service.dispose();
});

test("unknown publication retains metadata and partial path after lifecycle cleanup, excluded from pending count", async () => {
  const f = fixture(); await f.ready(); f.local = Buffer.from("approved"); await f.check();
  f.remote.publish = async () => ({ ok: false, code: "connection-lost" });
  assert(f.service.upload("owner", f.view().id, f.view().revision, f.view().approvalId!).ok);
  await until(() => f.view().error === "publication-unknown" && !f.view().cleanupPending); await new Promise((r) => setTimeout(r, 0));
  const partial = f.view().partialPath; assert(partial); const editId = f.view().id;
  f.service.closeSession("owner", "sftp", 1); await until(() => f.service.pendingCount() === 0);
  assert.equal(f.service.snapshot("owner").length, 1); assert.equal(f.view().id, editId);
  assert.equal(f.view().error, "publication-unknown"); assert.equal(f.view().partialPath, partial);
  assert.equal(f.view().approvalId, null); assert.equal(f.view().cleanupPending, false); assert.equal(f.cleanupCalls, 1);
  assert.equal(f.view().localAvailable, false);
  assert.deepEqual(f.service.check("owner", editId, f.view().revision), { ok: false, code: "closed" });
  assert.deepEqual(f.service.openEditor("owner", editId, f.view().revision), { ok: false, code: "closed" });
  assert(f.service.discard("owner", editId, f.view().revision).ok);
  assert.equal(f.service.snapshot("owner").length, 0); assert.equal(f.cleanupCalls, 1);
  assert.equal(f.stages.size, 1); await f.service.dispose();
});

test("clean history stays within the retained-record bound and owner removal drops it without new IO", async () => {
  const f = fixture(); await f.ready(); f.service.lock(); await until(() => f.service.pendingCount() === 0);
  assert.equal(f.service.snapshot("owner").length, 1); assert.equal(f.view().error, "closed");
  const cleanupCalls = f.cleanupCalls; f.service.closeOwner("owner");
  assert.equal(f.service.snapshot("owner").length, 0); assert.equal(f.cleanupCalls, cleanupCalls);
  await f.service.dispose();
});
