import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { posix } from "node:path";
import {
  channels, failure, isCancelTransferRequest, isEnqueueTransfersRequest, isTerminalStateRequest, isTransferState,
  type CancelTransferRequest, type EnqueueTransfersRequest, type Owner, type Result, type TerminalActionResponse,
  type TransferState,
} from "@ssterm/contracts";
import { createTransferEngine, type SessionRegistry, type TransferFileProvider } from "@ssterm/services";
import { filePath } from "@ssterm/adapters/local-files";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";
import { project } from "./terminals";

const accepted: Result<TerminalActionResponse> = { ok: true, value: { accepted: true } };
type Registry = Pick<SessionRegistry, "sftp" | "snapshot" | "subscribe" | "close" | "locked">;
interface Registration {
  owner: Owner;
  sequence: number;
  signature: string;
  send(channel: string, state: TransferState): void;
  unsubscribe(): void;
  timer?: ReturnType<typeof setTimeout>;
  lastSent: number;
}

/** Main alone authorizes paths and sessions; file bytes remain behind the service/provider seam. */
export function createTransferController(options: {
  registry: Registry;
  local: TransferFileProvider;
  engine?: ReturnType<typeof createTransferEngine>;
}) {
  const { registry } = options;
  const engine = options.engine ?? createTransferEngine();
  const registrations = new Map<string, Registration>();
  let disposed = false;
  const current = (owner: Owner) => disposed ? undefined : registrations.get(sessionOwnerId(owner));
  const state = (row: Registration): TransferState => ({
    owner: { ...row.owner }, sequence: row.sequence,
    jobs: engine.snapshot(sessionOwnerId(row.owner)).map((job) => ({
      id: job.id, sessionId: job.sessionId, generation: job.generation, direction: job.direction,
      sourcePath: job.sourcePath, destinationPath: job.destinationPath, target: job.target,
      state: job.state, bytes: job.bytes, total: job.total, error: job.error, partial: job.partial,
    })),
  });
  const publish = (row: Registration) => {
    if (current(row.owner) !== row) return;
    clearTimeout(row.timer); row.timer = undefined;
    row.sequence++;
    row.lastSent = Date.now();
    const value = state(row);
    if (isTransferState(value)) { try { row.send(channels.transferStateChanged, value); } catch { /* Owner is closing. */ } }
  };
  const changed = (row: Registration) => {
    const next = state(row);
    // Job transitions are immediate; coalesce byte-only changes to ten snapshots per second.
    const signature = JSON.stringify(next.jobs.map(({ bytes: _bytes, ...job }) => job));
    if (signature !== row.signature) { row.signature = signature; publish(row); return; }
    if (!row.timer) row.timer = setTimeout(() => publish(row), Math.max(0, 100 - (Date.now() - row.lastSent)));
  };
  return {
    register(owner: Owner, send: Registration["send"]): void {
      if (disposed) return;
      const old = current(owner);
      if (old) { old.send = send; return; }
      const ownerId = sessionOwnerId(owner);
      const row: Registration = { owner: { ...owner }, sequence: 0, signature: "", send, unsubscribe: () => {}, lastSent: 0 };
      registrations.set(ownerId, row);
      const stopEngine = engine.subscribe(ownerId, () => changed(row));
      const stopRegistry = registry.subscribe(ownerId, (snapshot) => {
        if (snapshot.kind !== "sftp" || snapshot.state === "Ready") return;
        engine.cancelSession(ownerId, snapshot.id, snapshot.generation, snapshot.end || snapshot.error ? "connection-lost" : "closed");
      });
      row.unsubscribe = () => { stopEngine(); stopRegistry(); };
    },
    transferState(owner: Owner): Result<TransferState> {
      const row = current(owner);
      if (!row) return failure("stale-owner");
      const value = state(row);
      return isTransferState(value) ? { ok: true, value } : failure("unavailable");
    },
    enqueueTransfers(request: EnqueueTransfersRequest): Result<TerminalActionResponse> {
      if (!isEnqueueTransfersRequest(request)) return failure("invalid-request");
      if (!current(request.owner)) return failure("stale-owner");
      if (registry.locked) return failure("unavailable");
      const ownerId = sessionOwnerId(request.owner);
      const remote = request.source.kind === "remote" ? request.source : request.destination.kind === "remote" ? request.destination : undefined;
      if (!remote) return failure("invalid-request");
      const capability = registry.sftp(ownerId, remote.sessionId, remote.generation);
      const snapshot = registry.snapshot(ownerId, remote.sessionId).find((item) => item.generation === remote.generation && item.kind === "sftp" && item.state === "Ready");
      if (!capability || !snapshot) return failure("conflict");
      const sourceDirectory = filePath(request.sourceDirectory), destinationDirectory = filePath(request.destinationDirectory);
      if (!sourceDirectory || !destinationDirectory) return failure("invalid-request");
      const inputs = request.names.map((name) => {
        if (Buffer.byteLength(name) > 1_024) return undefined;
        const sourcePath = filePath(posix.join(sourceDirectory, name)), destinationPath = filePath(posix.join(destinationDirectory, name));
        if (!sourcePath || !destinationPath) return undefined;
        return {
          direction: request.source.kind === "local" ? "upload" as const : "download" as const,
          sourcePath, destinationPath, target: project(snapshot).target,
          sessionId: remote.sessionId, generation: remote.generation,
          source: request.source.kind === "local" ? options.local : capability,
          destination: request.destination.kind === "local" ? options.local : capability,
          validate: () => !registry.locked && !!current(request.owner) && registry.sftp(ownerId, remote.sessionId, remote.generation) === capability,
          onStall: () => { registry.close(ownerId, remote.sessionId, remote.generation); },
        };
      });
      if (inputs.some((item) => !item)) return failure("invalid-request");
      const result = engine.enqueue(ownerId, inputs.filter((item) => item !== undefined));
      return result.ok ? accepted : failure(result.code === "resource-limit" ? "busy" : result.code === "invalid-request" ? "invalid-request" : "unavailable");
    },
    cancelTransfer(request: CancelTransferRequest): Result<TerminalActionResponse> {
      if (!isCancelTransferRequest(request)) return failure("invalid-request");
      if (!current(request.owner)) return failure("stale-owner");
      return engine.cancel(sessionOwnerId(request.owner), request.jobId) ? accepted : failure("conflict");
    },
    clearFinishedTransfers(owner: Owner): Result<TerminalActionResponse> {
      if (!current(owner)) return failure("stale-owner");
      engine.clearFinished(sessionOwnerId(owner));
      return accepted;
    },
    pendingCount(owner: Owner): number { return engine.pendingCount(sessionOwnerId(owner)); },
    revokeOwner(owner: Owner): void {
      const row = current(owner);
      if (!row) return;
      registrations.delete(sessionOwnerId(owner));
      clearTimeout(row.timer); row.unsubscribe();
      engine.revokeOwner(sessionOwnerId(owner));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const row of registrations.values()) { clearTimeout(row.timer); row.unsubscribe(); }
      registrations.clear(); engine.dispose();
    },
  };
}
export type TransferController = ReturnType<typeof createTransferController>;
export const transferChannels = Object.freeze([channels.transferState, channels.enqueueTransfers, channels.cancelTransfer, channels.clearFinishedTransfers]);
export function registerTransferHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller(): TransferController | undefined;
}) {
  const handle = <T>(channel: string, validate: (value: unknown) => value is T, run: (controller: TransferController, request: T) => unknown) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        controller.register(authorized.value, (channel, value) => { if (!event.sender.isDestroyed()) event.sender.send(channel, value); });
        return await run(controller, request);
      } catch { return failure("unavailable"); }
    });
  };
  handle(channels.transferState, isTerminalStateRequest, (controller, request) => controller.transferState(request.owner));
  handle(channels.enqueueTransfers, isEnqueueTransfersRequest, (controller, request) => controller.enqueueTransfers(request));
  handle(channels.cancelTransfer, isCancelTransferRequest, (controller, request) => controller.cancelTransfer(request));
  handle(channels.clearFinishedTransfers, isTerminalStateRequest, (controller, request) => controller.clearFinishedTransfers(request.owner));
  return () => { for (const channel of transferChannels) options.ipc.removeHandler(channel); };
}

/** Both terminal sessions and file writes are consequential on window/app exit. */
export function withTransferPrompt(prompt: { message: string; detail: string } | undefined, count: number, action: "close" | "quit") {
  if (count === 0) return prompt;
  const transfers = `${count} pending ${count === 1 ? "transfer will" : "transfers will"} be cancelled. Newly created incomplete files are retained at their destination paths.`;
  return { message: prompt?.message ?? (action === "quit" ? "Quit with pending transfers?" : "Close with pending transfers?"),
    detail: prompt ? `${prompt.detail}\n\n${transfers}` : transfers };
}
