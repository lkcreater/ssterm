import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  MAX_REMOTE_EDIT_BYTES, MAX_REMOTE_EDITS, REMOTE_EDIT_WORKERS,
  type RemoteEditEditor, type RemoteEditFiles, type RemoteEditFailure, type RemoteEditIOResult,
  type RemoteEditSnapshot, type RemoteEditTarget, type RemoteEditView, type RemoteEditWorkspace,
  type RemoteReader, type RemoteWriter, type SftpSession,
} from "@ssterm/domain";

const ok = <T>(value: T): RemoteEditIOResult<T> => ({ ok: true, value });
const fail = <T = never>(code: RemoteEditFailure): RemoteEditIOResult<T> => ({ ok: false, code });
class Stopped { constructor(readonly code: RemoteEditFailure) {} }
type Fingerprint = { sha256: string; size: number };
export interface RemoteEditInput {
  owner: string; sessionId: string; generation: number; target: RemoteEditTarget; path: string;
  remote: SftpSession; validate: () => boolean; onStall: () => void;
}
type Task = "download" | "open" | "check" | "upload" | "cleanup";
interface Document {
  input: RemoteEditInput; view: RemoteEditView; workspace?: RemoteEditWorkspace;
  baseline?: Fingerprint; approved?: RemoteEditSnapshot;
  task?: Task; running: boolean; invalid: boolean; abort: AbortController;
  handles: Map<RemoteReader | RemoteWriter, boolean>; garbage: Set<RemoteEditSnapshot>;
  history: boolean; removeAfterCleanup: boolean;
}
const copy = (d: Document): RemoteEditView => ({ ...d.view, target: { ...d.view.target } });
const same = (a: Fingerprint, b: Fingerprint) => a.size === b.size && a.sha256 === b.sha256;

/** Private, bounded documents. A worker remains occupied until even timed-out native I/O settles. */
export function createRemoteEditService(options: {
  files: RemoteEditFiles; editor: RemoteEditEditor; operationTimeoutMs?: number;
  cleanupTimeoutMs?: number; shutdownTimeoutMs?: number; id?: () => string;
}) {
  const docs = new Map<string, Document>();
  const listeners = new Map<string, Set<(views: RemoteEditView[]) => void>>();
  const workers = new Set<Promise<void>>();
  const id = options.id ?? randomUUID;
  const operationTimeout = options.operationTimeoutMs ?? 30_000;
  const cleanupTimeout = options.cleanupTimeoutMs ?? 2_000;
  let disposed = false;
  const snapshot = (owner: string) => [...docs.values()].filter((d) => d.input.owner === owner).map(copy);
  const emit = (owner: string) => {
    for (const callback of listeners.get(owner) ?? []) {
      try { callback(snapshot(owner)); } catch { /* Observers do not own document lifetimes. */ }
    }
  };
  const update = (d: Document, patch: Partial<RemoteEditView>) => {
    if (Object.entries(patch).every(([key, value]) => d.view[key as keyof RemoteEditView] === value)) return;
    Object.assign(d.view, patch); d.view.revision++; emit(d.input.owner);
  };
  const valid = (d: Document) => {
    if (d.invalid || disposed || d.abort.signal.aborted) return false;
    try { return d.input.validate(); } catch { return false; }
  };
  const invalidate = (d: Document, remove = false) => {
    d.removeAfterCleanup ||= remove;
    if (d.history) {
      if (d.removeAfterCleanup) { docs.delete(d.view.id); emit(d.input.owner); }
      return;
    }
    d.invalid = true; d.view.approvalId = null; d.abort.abort();
    update(d, { state: d.view.state === "publishing" ? "publishing" : "cancelling", cleanupPending: true });
    if (!d.running) { d.task = "cleanup"; pump(); }
  };

  async function run(d: Document, task: Task) {
    const pending = new Set<Promise<unknown>>();
    const pendingRemote = new Set<Promise<unknown>>();
    const handles = d.handles;
    const obsoleteSnapshots = d.garbage;
    let stalled = false, cleanupFailed = false, initialFailed = false;
    const track = <T>(promise: Promise<T>, remote = false): Promise<T> => {
      pending.add(promise);
      if (remote) pendingRemote.add(promise);
      const settled = () => { pending.delete(promise); pendingRemote.delete(promise); };
      void promise.then(settled, settled);
      return promise;
    };
    const stall = () => {
      if (stalled) return; stalled = true;
      try { d.input.onStall(); } catch { /* The captured subsystem alone is invalidated. */ }
    };
    const invoke = async <T>(operation: () => Promise<RemoteEditIOResult<T>>, config: {
      remote?: boolean; cleanup?: boolean; publication?: boolean; obtained?: (value: T) => void;
    } = {}): Promise<T> => {
      if (!config.cleanup && !valid(d)) throw new Stopped("closed");
      let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
      let native: Promise<RemoteEditIOResult<T>>;
      try { native = operation(); } catch { native = Promise.resolve(fail<T>(config.publication ? "publication-unknown" : "failure")); }
      const raw = track(native.catch(() => fail<T>(config.publication ? "publication-unknown" : "failure")).then((result) => {
        if (result.ok) config.obtained?.(result.value);
        return result;
      }), config.remote);
      const interrupted = new Promise<RemoteEditIOResult<T>>((resolve) => {
        timer = setTimeout(() => {
          if (config.remote) stall();
          resolve(fail(config.publication ? "publication-unknown" : "timeout"));
        }, config.cleanup ? cleanupTimeout : operationTimeout);
        if (!config.cleanup && !config.publication) d.abort.signal.addEventListener("abort", onAbort = () => resolve(fail("closed")), { once: true });
      });
      const result = await Promise.race([raw, interrupted]);
      clearTimeout(timer);
      if (onAbort) d.abort.signal.removeEventListener("abort", onAbort);
      if (!result.ok) throw new Stopped(config.publication && ["closed", "connection-lost", "cancelled", "timeout"].includes(result.code) ? "publication-unknown" : result.code);
      if (!config.cleanup && !config.publication && !valid(d)) throw new Stopped("closed");
      return result.value;
    };
    const drain = async () => { while (pending.size) await Promise.allSettled([...pending]); };
    const close = async (handle: RemoteReader | RemoteWriter) => {
      await invoke(() => handle.close(), { remote: handles.get(handle), cleanup: true });
      handles.delete(handle);
    };
    const readRemote = async (writer?: RemoteWriter): Promise<Fingerprint> => {
      const remote = d.input.remote;
      const attrs = await invoke(() => remote.lstat(d.input.path, d.abort.signal), { remote: true });
      if (attrs.type !== "file") throw new Stopped("not-file");
      if (attrs.size !== null && attrs.size > MAX_REMOTE_EDIT_BYTES) throw new Stopped("too-large");
      const reader = await invoke(() => remote.openRead(d.input.path, d.abort.signal), { remote: true, obtained: (h) => handles.set(h, true) });
      const hash = createHash("sha256"); let size = 0;
      const limit = Math.min(64 * 1024, remote.maxRead);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Stopped("unsupported");
      for (;;) {
        const bytes = await invoke(() => reader.read(size, limit, d.abort.signal), { remote: true });
        if (bytes === null) break;
        if (!bytes.byteLength || bytes.byteLength > limit) throw new Stopped("failure");
        if (size + bytes.byteLength > MAX_REMOTE_EDIT_BYTES) throw new Stopped("too-large");
        hash.update(bytes);
        if (writer) await invoke(() => writer.write(size, bytes, d.abort.signal));
        size += bytes.byteLength;
      }
      await close(reader);
      return { size, sha256: hash.digest("hex") };
    };
    const getLocal = () => invoke(() => d.workspace!.snapshot(d.abort.signal), { obtained: (s) => obsoleteSnapshots.add(s) });
    const releaseApproval = () => {
      if (d.approved) obsoleteSnapshots.add(d.approved);
      d.approved = undefined; d.view.approvalId = null;
    };
    const fingerprint = async () => {
      try { return await readRemote(); }
      catch (error) {
        if (error instanceof Stopped && ["not-found", "not-file"].includes(error.code)) throw new Stopped("remote-changed");
        throw error;
      }
    };
    try {
      if (task === "download") {
        update(d, { state: "downloading" });
        if (!d.input.remote.atomicReplace || !d.input.remote.publish) throw new Stopped("unsupported");
        const before = await readRemote();
        const workspace = await invoke(() => options.files.create(d.abort.signal), { obtained: (w) => { d.workspace = w; } });
        const writer = await invoke(() => workspace.openWrite(d.abort.signal), { obtained: (h) => handles.set(h, false) });
        const copied = await readRemote(writer);
        await close(writer);
        const local = await getLocal();
        const after = await readRemote();
        if (!same(before, copied) || !same(copied, after) || !same(copied, local)) throw new Stopped("remote-changed");
        d.baseline = copied;
        update(d, { state: "ready", size: local.size, localAvailable: true, error: null });
      } else if (task === "open") {
        await invoke(() => options.editor.open(d.workspace!.documentPath, d.abort.signal));
        update(d, { state: "editing", error: null });
      } else if (task === "check") {
        releaseApproval();
        const local = await getLocal();
        const remote = await fingerprint();
        const changed = !same(local, d.baseline!);
        if (!same(remote, d.baseline!)) {
          update(d, { state: "conflict", localChanged: changed, error: "remote-changed", size: local.size });
        } else if (changed) {
          obsoleteSnapshots.delete(local); d.approved = local;
          update(d, { state: "changed", localChanged: true, size: local.size, error: null, approvalId: id() });
        } else update(d, { state: "editing", localChanged: false, size: local.size, error: null });
      } else if (task === "upload") {
        const approved = d.approved!;
        d.approved = undefined; obsoleteSnapshots.add(approved);
        const local = await getLocal();
        if (!same(local, approved)) throw new Stopped("local-changed");
        if (!same(await fingerprint(), d.baseline!)) throw new Stopped("remote-changed");
        const partialPath = posix.join(posix.dirname(d.input.path), `.ssterm-${randomUUID()}.part`);
        const remote = d.input.remote;
        const writer = await invoke(() => remote.openWrite(partialPath, { mode: 0o600 }, d.abort.signal), { remote: true, obtained: (h) => {
          handles.set(h, true); update(d, { partialPath });
        } });
        const reader = await invoke(() => approved.openRead(d.abort.signal), { obtained: (h) => handles.set(h, false) });
        const limit = Math.min(64 * 1024, remote.maxWrite);
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Stopped("unsupported");
        let size = 0; const hash = createHash("sha256");
        for (;;) {
          const bytes = await invoke(() => reader.read(size, limit, d.abort.signal));
          if (bytes === null) break;
          if (!bytes.byteLength || bytes.byteLength > limit || size + bytes.byteLength > approved.size) throw new Stopped("local-changed");
          hash.update(bytes);
          await invoke(() => writer.write(size, bytes, d.abort.signal), { remote: true });
          size += bytes.byteLength;
        }
        if (!same({ size, sha256: hash.digest("hex") }, approved)) throw new Stopped("local-changed");
        await close(reader); await close(writer);
        if (!same(await fingerprint(), d.baseline!)) throw new Stopped("remote-changed");
        if (!valid(d)) throw new Stopped("closed");
        // No cancellation or retargeting between this fence and dispatch. ACK is authoritative.
        update(d, { state: "publishing" });
        const published = await invoke(() => remote.publish!(partialPath, d.input.path, { replace: true }), { remote: true, publication: true });
        d.baseline = { size: approved.size, sha256: approved.sha256 };
        update(d, { state: "uploaded", localChanged: false, size: approved.size, partialPath: published.retainedPartial ? partialPath : null, error: null });
      }
    } catch (error) {
      const code = error instanceof Stopped ? error.code : "failure";
      releaseApproval();
      initialFailed = task === "download";
      update(d, { state: code === "remote-changed" && !initialFailed ? "conflict" : "failed", error: code });
    } finally {
      if (pending.size || handles.size || obsoleteSnapshots.size || initialFailed || d.invalid || task === "cleanup") update(d, { cleanupPending: true });
      // A raced-out creation/open must first return its handle. Never release a worker or
      // delete a workspace while that native operation can still write into it.
      const watchdog = setTimeout(() => { if (pendingRemote.size) stall(); }, cleanupTimeout);
      await drain();
      clearTimeout(watchdog);
      for (const handle of [...handles.keys()]) {
        try { await close(handle); } catch { cleanupFailed = true; }
      }
      await drain();
      for (const snap of obsoleteSnapshots) {
        try { await invoke(() => snap.dispose(), { cleanup: true }); obsoleteSnapshots.delete(snap); } catch { cleanupFailed = true; }
      }
      await drain();
      if (initialFailed || d.invalid || task === "cleanup") {
        if (d.approved) {
          try { await invoke(() => d.approved!.dispose(), { cleanup: true }); d.approved = undefined; } catch { cleanupFailed = true; }
        }
        if (d.workspace) {
          try { await invoke(() => d.workspace!.cleanup(), { cleanup: true }); d.workspace = undefined; update(d, { localAvailable: false }); } catch { cleanupFailed = true; }
        }
        await drain();
        if (!cleanupFailed && (d.invalid || initialFailed)) {
          if (d.removeAfterCleanup) { docs.delete(d.view.id); emit(d.input.owner); }
          else {
            d.history = true; d.baseline = undefined;
            update(d, { state: d.view.state === "uploaded" ? "uploaded" : "failed", error: d.view.state === "uploaded" ? null : d.view.error ?? "closed", approvalId: null, localChanged: false, localAvailable: false, cleanupPending: false });
          }
        }
      }
      if (cleanupFailed) update(d, { state: "cleanup-failed", error: "cleanup-failed", cleanupPending: true });
      else if (docs.has(d.view.id)) update(d, { cleanupPending: false });
    }
  }
  function pump() {
    for (const d of docs.values()) {
      if (workers.size >= REMOTE_EDIT_WORKERS) break;
      if (d.running || !d.task) continue;
      const task = d.task; d.task = undefined; d.running = true;
      // Defer dispatch so the permit is registered before any observer can enqueue work.
      const promise = Promise.resolve().then(() => run(d, task)).finally(() => {
        d.running = false; workers.delete(promise);
        if (d.invalid && !d.history && docs.has(d.view.id) && d.view.state !== "cleanup-failed") d.task = "cleanup";
        emit(d.input.owner);
        pump();
      });
      workers.add(promise);
    }
  }
  const find = (owner: string, editId: string, revision: number): RemoteEditIOResult<Document> => {
    const d = docs.get(editId);
    if (!d || d.input.owner !== owner) return fail("closed");
    if (d.view.revision !== revision || d.running || d.task || d.view.cleanupPending) return fail("invalid-request");
    if (!valid(d)) return fail("closed");
    if (!d.workspace || !d.baseline) return fail("invalid-request");
    return ok(d);
  };
  const enqueue = (d: Document, task: Task, state: RemoteEditView["state"]) => {
    d.task = task; update(d, { state, approvalId: null, error: null }); pump(); return ok(undefined);
  };
  return {
    start(input: RemoteEditInput): RemoteEditIOResult<{ editId: string }> {
      if (disposed) return fail("closed");
      if (docs.size >= MAX_REMOTE_EDITS) return fail("resource-limit");
      if (!input.path.startsWith("/") || input.path.includes("\0") || Buffer.byteLength(input.path) > 4096 || /\p{Cs}/u.test(input.path)) return fail("invalid-path");
      try { if (!input.validate()) return fail("closed"); } catch { return fail("closed"); }
      const editId = id();
      const d: Document = { input: { ...input, target: { ...input.target } }, abort: new AbortController(), running: false, invalid: false, history: false, removeAfterCleanup: false, handles: new Map(), garbage: new Set(), task: "download",
        view: { id: editId, revision: 1, sessionId: input.sessionId, generation: input.generation, target: { ...input.target }, remotePath: input.path,
          state: "queued", size: null, localChanged: false, localAvailable: false, approvalId: null, error: null, partialPath: null, cleanupPending: false } };
      docs.set(editId, d); emit(input.owner); pump(); return ok({ editId });
    },
    snapshot,
    subscribe(owner: string, callback: (views: RemoteEditView[]) => void) {
      const set = listeners.get(owner) ?? new Set(); listeners.set(owner, set); set.add(callback);
      return () => { set.delete(callback); if (!set.size) listeners.delete(owner); };
    },
    openEditor(owner: string, editId: string, revision: number): RemoteEditIOResult<void> {
      const result = find(owner, editId, revision); if (!result.ok) return result;
      return enqueue(result.value, "open", "opening");
    },
    check(owner: string, editId: string, revision: number): RemoteEditIOResult<void> {
      const result = find(owner, editId, revision); if (!result.ok) return result;
      return enqueue(result.value, "check", "checking");
    },
    upload(owner: string, editId: string, revision: number, approvalId: string): RemoteEditIOResult<void> {
      const result = find(owner, editId, revision); if (!result.ok) return result;
      const d = result.value;
      if (!d.approved || !approvalId || d.view.approvalId !== approvalId || d.view.state !== "changed") return fail("invalid-request");
      return enqueue(d, "upload", "uploading");
    },
    discard(owner: string, editId: string, revision: number): RemoteEditIOResult<void> {
      const d = docs.get(editId);
      if (!d || d.input.owner !== owner) return fail("closed");
      if (d.view.revision !== revision || d.view.state === "publishing") return fail("invalid-request");
      invalidate(d, true); return ok(undefined);
    },
    closeSession(owner: string, sessionId: string, generation: number) {
      for (const d of docs.values()) if (d.input.owner === owner && d.input.sessionId === sessionId && d.input.generation === generation) invalidate(d);
    },
    closeOwner(owner: string) { for (const d of docs.values()) if (d.input.owner === owner) invalidate(d, true); },
    lock() { for (const d of docs.values()) invalidate(d); },
    pendingCount(owner?: string) { return [...docs.values()].filter((d) => (!d.history || d.running) && (owner === undefined || d.input.owner === owner)).length; },
    async dispose() {
      disposed = true;
      for (const d of docs.values()) invalidate(d, true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        (async () => { while (workers.size) await Promise.allSettled([...workers]); })(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, options.shutdownTimeoutMs ?? cleanupTimeout); }),
      ]);
      clearTimeout(timer); listeners.clear();
    },
  };
}
