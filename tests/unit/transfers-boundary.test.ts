import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createTransferController, registerTransferHandlers, transferChannels, withTransferPrompt } from "../../apps/desktop/src/main/transfers.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { createTransferEngine } from "../../packages/services/src/index.ts";
import { failure, isEnqueueTransfersRequest, isTransferState, isResolveTransferConflictRequest, type EnqueueTransfersRequest, type TransferState } from "../../packages/contracts/src/index.ts";
import type { TransferFileProvider } from "../../packages/services/src/transfers.ts";

const owner = { windowId: 1, generation: 1 };
const other = { windowId: 2, generation: 1 };
const remote = { kind: "remote" as const, sessionId: "session", generation: 1 };
const request: EnqueueTransfersRequest = { owner, source: { kind: "local" }, sourceDirectory: "/local", names: ["ไฟล์.txt"], destination: remote, destinationDirectory: "/remote" };
const tick = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };
function fixture() {
  let locked = false;
  let live = true;
  let exists = false;
  let observer: ((snapshot: any) => void) | undefined;
  const provider: TransferFileProvider = {
    maxRead: 32_768, maxWrite: 32_768, atomicReplace: true,
    publish: async () => ({ ok: true, value: { retainedPartial: false } }),
    lstat: async (path) => (path.startsWith("/local") || exists) ? { ok: true, value: { type: "file", size: 1, permissions: 0o600, mtime: 0 } } : { ok: false, code: "not-found" },
    openRead: async () => ({ ok: true, value: { read: async (position) => ({ ok: true, value: position ? null : new Uint8Array([1]) }), close: async () => ({ ok: true, value: undefined }) } }),
    openWrite: async () => ({ ok: true, value: { write: async () => ({ ok: true, value: undefined }), close: async () => ({ ok: true, value: undefined }) } }),
  };
  const registry = {
    get locked() { return locked; },
    sftp: (id: string, session: string, generation: number) => !locked && live && id === "window:1:1" && session === "session" && generation === 1 ? provider : undefined,
    snapshot: () => [{ id: "session", generation: 1, kind: "sftp", hostId: "host", state: "Ready", target: { label: "Lab", environment: "PROD", address: "localhost", port: 22, username: "fixture" } }],
    subscribe: (_: string, callback: (snapshot: any) => void) => { observer = callback; return () => {}; },
    close() { live = false; return { ok: true }; },
  } as unknown as Parameters<typeof createTransferController>[0]["registry"];
  const engine = createTransferEngine();
  const controller = createTransferController({ registry, local: provider, engine });
  const sent: TransferState[] = [];
  controller.register(owner, (_, value) => sent.push(value));
  controller.register(other, () => {});
  return { controller, sent, engine, provider, setExisting() { exists = true; }, lock() { locked = true; observer?.({ kind: "sftp", state: "Closed", id: "session", generation: 1 }); },
    stale() { live = false; }, dispose() { controller.dispose(); } };
}

test("transfer request guards reject traversal, extra fields, invalid endpoint pairing and oversized batches", () => {
  assert.ok(isEnqueueTransfersRequest(request));
  for (const names of [["."], [".."], ["a/b"], ["a", "a"], ["bad\0"], ["�"], [], Array.from({ length: 101 }, (_, i) => `${i}`)])
    assert.equal(isEnqueueTransfersRequest({ ...request, names }), false);
  assert.equal(isEnqueueTransfersRequest({ ...request, destination: { kind: "local" } }), false);
  assert.equal(isEnqueueTransfersRequest({ ...request, extra: true }), false);
});

test("transfer controller fences foreign/stale sessions, locked actions and UTF-8 path bounds", async () => {
  const f = fixture();
  try {
    assert.deepEqual(f.controller.enqueueTransfers({ ...request, owner: other }), failure("conflict"));
    assert.deepEqual(f.controller.enqueueTransfers({ ...request, destination: { ...remote, generation: 2 } }), failure("conflict"));
    assert.deepEqual(f.controller.enqueueTransfers({ ...request, names: ["ก".repeat(400)] }), failure("invalid-request"));
    assert.deepEqual(f.controller.enqueueTransfers({ ...request, sourceDirectory: "/" + "ก".repeat(1400) }), failure("invalid-request"));
    assert.deepEqual(f.controller.enqueueTransfers({ ...request, owner: { windowId: 3, generation: 1 } }), failure("stale-owner"));
    f.lock();
    assert.deepEqual(f.controller.enqueueTransfers(request), failure("unavailable"));
  } finally { f.dispose(); }
});

test("transfer snapshots validate, capture target/paths, exclude providers and reject foreign cancellation", async () => {
  const f = fixture();
  try {
    assert.equal(f.controller.enqueueTransfers(request).ok, true);
    await tick();
    const state = f.controller.transferState(owner);
    assert.ok(state.ok && isTransferState(state.value));
    const job = state.value.jobs[0]!;
    assert.equal(job.sourcePath, "/local/ไฟล์.txt");
    assert.equal(job.destinationPath, "/remote/ไฟล์.txt");
    assert.equal(job.target?.environment, "PROD");
    assert.equal(job.state, "completed");
    assert.deepEqual(f.controller.cancelTransfer({ owner: other, jobId: job.id }), failure("conflict"));
    assert.ok(!JSON.stringify(state).includes("maxRead"));
    assert.ok(f.sent.every(isTransferState));
    f.controller.revokeOwner(owner);
    assert.deepEqual(f.controller.transferState(owner), failure("stale-owner"));
  } finally { f.dispose(); }
});

test("transfer IPC authorizes sender before malformed payload and removes all handlers", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ipc = { handle: (name: string, callback: (...args: any[]) => unknown) => handlers.set(name, callback), removeHandler: (name: string) => handlers.delete(name) } as unknown as Pick<IpcMain, "handle" | "removeHandler">;
  const boundary = { authorizeOwner: () => failure("unauthorized") } as unknown as WindowBoundary;
  const remove = registerTransferHandlers({ ipc, boundary, controller: () => undefined });
  for (const channel of transferChannels) assert.deepEqual(await handlers.get(channel)!({} as IpcMainInvokeEvent, null), failure("unauthorized"));
  remove(); assert.equal(handlers.size, 0);
});

test("close and quit prompts include pending transfers and retained partial policy", () => {
  assert.equal(withTransferPrompt(undefined, 0, "quit"), undefined);
  assert.match(withTransferPrompt(undefined, 2, "close")!.detail, /2 pending transfers.*cancelled/);
  assert.match(withTransferPrompt({ message: "Quit?", detail: "Disconnect." }, 1, "quit")!.detail, /Disconnect.*\n\n1 pending transfer/s);
});


test("conflict decisions require exact owner/job/nonce and captured Ready generation", async () => {
  const f = fixture();
  try {
    f.setExisting();
    assert.ok(f.controller.enqueueTransfers(request).ok);
    await tick();
    const job = f.engine.snapshot("window:1:1")[0]!;
    assert.equal(job.state, "conflict");
    assert.equal(f.controller.pendingCount(owner), 1);
    const decision = { owner, jobId: job.id, conflictId: job.conflictId!, decision: "skip" as const, name: null };
    assert.deepEqual(f.controller.resolveTransferConflict({ ...decision, owner: other }), failure("conflict"));
    assert.deepEqual(f.controller.resolveTransferConflict({ ...decision, conflictId: "stale" }), failure("conflict"));
    assert.deepEqual(f.controller.resolveTransferConflict({ ...decision, decision: "rename", name: "ก".repeat(400) }), failure("invalid-request"));
    assert.ok(f.controller.resolveTransferConflict(decision).ok);
    assert.equal(f.engine.snapshot("window:1:1")[0]!.state, "skipped");
    assert.deepEqual(f.controller.resolveTransferConflict(decision), failure("conflict"));
    assert.deepEqual(f.controller.retryTransfer({ owner, jobId: job.id }), failure("conflict"), "skip cannot silently restart");
  } finally { f.dispose(); }
});

test("conflict rename guards exclude arbitrary paths and reject accidental overwrite consent", () => {
  const valid = { owner, jobId: "job", conflictId: "nonce", decision: "rename", name: "ไฟล์ใหม่.txt" };
  assert.ok(isResolveTransferConflictRequest(valid));
  for (const name of ["..", ".", "a/b", "", "bad\0", "�", null])
    assert.equal(isResolveTransferConflictRequest({ ...valid, name }), false);
  assert.equal(isResolveTransferConflictRequest({ ...valid, decision: "overwrite" }), false);
  assert.equal(isResolveTransferConflictRequest({ ...valid, decision: "skip", name: null, path: "/foreign" }), false);
  assert.ok(isResolveTransferConflictRequest({ ...valid, decision: "overwrite", name: null }));
});

test("retry creates a fresh captured attempt, refuses foreign/stale generations and preserves old history", async () => {
  const f = fixture();
  try {
    const publish = f.provider.publish;
    delete f.provider.publish;
    assert.ok(f.controller.enqueueTransfers(request).ok);
    await tick();
    const job = f.engine.snapshot("window:1:1")[0]!;
    assert.equal(job.state, "failed");
    f.provider.publish = publish;
    assert.deepEqual(f.controller.retryTransfer({ owner: other, jobId: job.id }), failure("conflict"));
    assert.ok(f.controller.retryTransfer({ owner, jobId: job.id }).ok);
    await tick();
    const jobs = f.engine.snapshot("window:1:1");
    assert.equal(jobs.length, 2);
    assert.notEqual(jobs[0]!.id, jobs[1]!.id);
    assert.equal(jobs[1]!.generation, job.generation);
    f.stale();
    assert.deepEqual(f.controller.retryTransfer({ owner, jobId: job.id }), failure("conflict"));
  } finally { f.dispose(); }
});
