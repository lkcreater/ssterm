import { randomUUID } from "node:crypto";
import type { RemoteAttributes, RemoteReader, RemoteWriter, SftpFailure } from "@ssterm/domain";

export type TransferFailure = SftpFailure | "not-file" | "destination-exists" | "timeout";
export type TransferResult<T> = { ok: true; value: T } | { ok: false; code: TransferFailure };
export interface TransferFileProvider {
  readonly maxRead: number;
  readonly maxWrite: number;
  lstat(path: string, signal?: AbortSignal): Promise<TransferResult<RemoteAttributes>>;
  openRead(path: string, signal?: AbortSignal): Promise<TransferResult<RemoteReader>>;
  openWrite(path: string, options: { mode: number }, signal?: AbortSignal): Promise<TransferResult<RemoteWriter>>;
}
export type TransferTarget = {
  label: string; endpointHost: string; endpointPort: number;
  username: string | null; environment: "DEV" | "STAGING" | "PROD" | null;
} | null;
export interface TransferInput {
  direction: "upload" | "download";
  sourcePath: string;
  destinationPath: string;
  target: TransferTarget;
  sessionId: string;
  generation: number;
  source: TransferFileProvider;
  destination: TransferFileProvider;
  /** Invalidates only the captured SSH session generation. */
  onStall(): void;
  /** Rechecks the captured capability when a queued job starts. */
  validate?(): boolean;
}
export interface TransferJob {
  id: string;
  direction: TransferInput["direction"];
  sourcePath: string;
  destinationPath: string;
  target: TransferTarget;
  sessionId: string;
  generation: number;
  state: "queued" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
  bytes: number;
  total: number | null;
  error: TransferFailure | null;
  /** The exclusively created destination may contain incomplete data. Never removed automatically. */
  partial: boolean;
}
interface Work {
  owner: string;
  input: TransferInput;
  job: TransferJob;
  abort: AbortController;
  reason?: TransferFailure;
  lastProgress: number;
}
const terminal = (job: TransferJob) => job.state === "completed" || job.state === "cancelled" || job.state === "failed";
const copy = (job: TransferJob): TransferJob => ({ ...job, target: job.target && { ...job.target } });
const fail = <T>(code: TransferFailure): TransferResult<T> => ({ ok: false, code });
class TransferStopped {
  constructor(readonly code: TransferFailure) {}
}
const validPath = (path: string) => typeof path === "string" && path.startsWith("/") && !path.includes("\0") && !/\p{Cs}/u.test(path) && Buffer.byteLength(path) <= 4_096;

/** Process-memory, owner-fenced jobs. Internal permits outlive visible cancellation until native I/O settles. */
export function createTransferEngine(options: {
  concurrency?: number; maxJobs?: number; operationTimeoutMs?: number; cleanupTimeoutMs?: number;
  progressIntervalMs?: number; id?: () => string;
} = {}) {
  const concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
  const maxJobs = Math.max(1, Math.min(100, options.maxJobs ?? 100));
  const operationTimeout = options.operationTimeoutMs ?? 30_000;
  const cleanupTimeout = options.cleanupTimeoutMs ?? 2_000;
  const progressInterval = options.progressIntervalMs ?? 100;
  const works = new Map<string, Work>();
  // Native I/O can outlive terminal history and still write the destination.
  const inFlight = new Set<Work>();
  const listeners = new Map<string, Set<(jobs: TransferJob[]) => void>>();
  let active = 0, disposed = false;
  const snapshot = (owner: string) => [...works.values()].filter((w) => w.owner === owner).map((w) => copy(w.job));
  const emit = (owner: string) => {
    for (const listener of listeners.get(owner) ?? []) {
      try { listener(snapshot(owner)); } catch { /* Observers cannot interrupt cleanup. */ }
    }
  };
  const stop = (w: Work, reason: TransferFailure) => {
    if (terminal(w.job) || w.reason) return;
    w.reason = reason;
    if (w.job.state === "queued") {
      w.job.state = reason === "cancelled" ? "cancelled" : "failed";
      w.job.error = reason;
    } else w.job.state = "cancelling";
    w.abort.abort();
    emit(w.owner);
  };
  const run = async (w: Work) => {
    const { job, input } = w;
    const pending = new Set<Promise<unknown>>();
    const pendingRemote = new Set<Promise<unknown>>();
    let stalled = false;
    const stall = () => {
      if (stalled) return;
      stalled = true;
      try { input.onStall(); } catch { /* An invalidation observer cannot abandon handles. */ }
    };
    const track = <T>(promise: Promise<T>, remote = false) => {
      pending.add(promise);
      if (remote) pendingRemote.add(promise);
      void promise.finally(() => { pending.delete(promise); pendingRemote.delete(promise); });
      return promise;
    };
    const invoke = async <T>(operation: () => Promise<TransferResult<T>>, cleanup = false, late?: (value: T) => Promise<unknown>, remote = true): Promise<TransferResult<T>> => {
      if (!cleanup && w.abort.signal.aborted) return fail(w.reason ?? "cancelled");
      let finished = false, timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
      const raw = track(Promise.resolve().then(operation).catch(() => fail<T>("failure")), remote);
      const actual = raw.then((result) => {
        if (finished && result.ok && late) track(Promise.resolve().then(() => late(result.value)).catch(() => undefined));
        return result;
      });
      const interrupted = new Promise<TransferResult<T>>((resolve) => {
        timer = setTimeout(() => {
          // Invalidation can synchronously publish a session-close event. Keep this job's cause.
          w.reason ??= "timeout";
          if (remote) stall();
          resolve(fail("timeout"));
        }, cleanup ? cleanupTimeout : operationTimeout);
        if (!cleanup) w.abort.signal.addEventListener("abort", onAbort = () => resolve(fail(w.reason ?? "cancelled")), { once: true });
      });
      const result = await Promise.race([actual, interrupted]);
      finished = true;
      clearTimeout(timer);
      if (onAbort) w.abort.signal.removeEventListener("abort", onAbort);
      return result;
    };
    const sourceRemote = input.direction === "download", destinationRemote = input.direction === "upload";
    const closeLate = (remote: boolean) => (handle: RemoteReader | RemoteWriter) => invoke(() => handle.close(), true, undefined, remote);
    let reader: RemoteReader | undefined, writer: RemoteWriter | undefined;
    let outcome: TransferFailure | undefined;
    try {
      if (input.validate && !input.validate()) throw new TransferStopped("closed");
      const source = await invoke(() => input.source.lstat(job.sourcePath, w.abort.signal), false, undefined, sourceRemote);
      if (!source.ok) throw new TransferStopped(source.code);
      if (source.value.type !== "file") throw new TransferStopped("not-file");
      job.total = source.value.size;
      emit(w.owner);
      const destination = await invoke(() => input.destination.lstat(job.destinationPath, w.abort.signal), false, undefined, destinationRemote);
      if (destination.ok) throw new TransferStopped("destination-exists");
      if (destination.code !== "not-found") throw new TransferStopped(destination.code);
      const opened = await invoke(() => input.source.openRead(job.sourcePath, w.abort.signal), false, closeLate(sourceRemote), sourceRemote);
      if (!opened.ok) throw new TransferStopped(opened.code);
      reader = opened.value;
      // An interrupted exclusive OPEN may still create a file before a late reply arrives.
      const created = await invoke(() => {
        if (w.abort.signal.aborted) return Promise.resolve(fail<RemoteWriter>(w.reason ?? "cancelled"));
        job.partial = true;
        return input.destination.openWrite(job.destinationPath, { mode: 0o600 }, w.abort.signal);
      }, false, closeLate(destinationRemote), destinationRemote);
      if (!created.ok) {
        if (!["cancelled", "timeout", "connection-lost", "closed"].includes(created.code)) job.partial = false;
        throw new TransferStopped(created.code);
      }
      writer = created.value;
      const chunkSize = Math.min(65_536, input.source.maxRead, input.destination.maxWrite);
      for (;;) {
        const read = await invoke(() => reader!.read(job.bytes, chunkSize, w.abort.signal), false, undefined, sourceRemote);
        if (!read.ok) throw new TransferStopped(read.code);
        if (read.value === null) {
          if (job.total !== null && job.bytes !== job.total) job.total = null;
          break;
        }
        if (!(read.value instanceof Uint8Array) || read.value.length < 1 || read.value.length > chunkSize) throw new TransferStopped("failure");
        if (!Number.isSafeInteger(job.bytes + read.value.length)) throw new TransferStopped("resource-limit");
        const write = await invoke(() => writer!.write(job.bytes, read.value!, w.abort.signal), false, undefined, destinationRemote);
        if (!write.ok) throw new TransferStopped(write.code);
        job.bytes += read.value.length;
        if (job.total !== null && job.bytes > job.total) job.total = null;
        if (Date.now() - w.lastProgress >= progressInterval) { w.lastProgress = Date.now(); emit(w.owner); }
      }
    } catch (error) {
      outcome = error instanceof TransferStopped ? error.code : "failure";
    } finally {
      const closed = await Promise.all([
        reader && invoke(() => reader!.close(), true, undefined, sourceRemote),
        writer && invoke(() => writer!.close(), true, undefined, destinationRemote),
      ].filter((p): p is Promise<TransferResult<void>> => !!p));
      outcome ??= closed.find((r) => !r.ok)?.code;
      outcome = w.reason ?? outcome;
      job.error = outcome ?? null;
      job.state = outcome === "cancelled" ? "cancelled" : outcome ? "failed" : "completed";
      if (!outcome) job.partial = false;
      emit(w.owner);
      // A cancelled local read/open is still occupying native I/O. Do not admit another worker yet.
      const watchdog = setTimeout(() => { if (pendingRemote.size) stall(); }, cleanupTimeout);
      try { while (pending.size) await Promise.all([...pending]); }
      finally { clearTimeout(watchdog); }
    }
  };
  const pump = () => {
    if (disposed) return;
    for (const w of works.values()) {
      if (active >= concurrency) break;
      if (w.job.state !== "queued") continue;
      active++;
      inFlight.add(w);
      w.job.state = "running";
      emit(w.owner);
      void run(w).finally(() => { inFlight.delete(w); active--; pump(); });
    }
  };
  return {
    enqueue(owner: string, inputs: TransferInput[]): TransferResult<TransferJob[]> {
      if (disposed) return fail("closed");
      if (!owner || inputs.length < 1 || inputs.some((i) => !validPath(i.sourcePath) || !validPath(i.destinationPath)
        || ![i.source.maxRead, i.destination.maxWrite].every((n) => Number.isSafeInteger(n) && n > 0))) return fail("invalid-request");
      if (works.size + inputs.length > maxJobs) return fail("resource-limit");
      const added = inputs.map((input): Work => ({ owner, input: { ...input, target: input.target && { ...input.target } }, abort: new AbortController(), lastProgress: 0,
        job: { id: (options.id ?? randomUUID)(), direction: input.direction, sourcePath: input.sourcePath, destinationPath: input.destinationPath,
          target: input.target && { ...input.target }, sessionId: input.sessionId, generation: input.generation, state: "queued", bytes: 0, total: null, error: null, partial: false } }));
      for (const w of added) works.set(w.job.id, w);
      const result = added.map((w) => copy(w.job));
      emit(owner);
      pump();
      return { ok: true, value: result };
    },
    snapshot,
    subscribe(owner: string, listener: (jobs: TransferJob[]) => void) {
      let set = listeners.get(owner);
      if (!set) listeners.set(owner, set = new Set());
      set.add(listener);
      return () => { set.delete(listener); if (!set.size) listeners.delete(owner); };
    },
    cancel(owner: string, id: string) {
      const w = works.get(id);
      if (!w || w.owner !== owner) return false;
      stop(w, "cancelled");
      return true;
    },
    clearFinished(owner: string) {
      for (const [id, w] of works) if (w.owner === owner && terminal(w.job)) works.delete(id);
      emit(owner);
    },
    cancelSession(owner: string, sessionId: string, generation: number, reason: SftpFailure = "closed") {
      for (const w of works.values()) if (w.owner === owner && w.job.sessionId === sessionId && w.job.generation === generation) stop(w, reason);
    },
    pendingCount(owner: string) {
      const pending = new Set([...works.values()].filter((w) => w.owner === owner && !terminal(w.job)));
      for (const w of inFlight) if (w.owner === owner) pending.add(w);
      return pending.size;
    },
    revokeOwner(owner: string) {
      for (const [id, w] of works) if (w.owner === owner) { stop(w, "closed"); works.delete(id); }
      listeners.delete(owner);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const w of works.values()) stop(w, "closed");
      listeners.clear();
    },
  };
}
