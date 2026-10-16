import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  channels, failure, isTerminalOutput, isTerminalState, isTerminalStateRequest, isTerminalTarget,
  isWriteTerminalRequest, isResizeTerminalRequest, isAckTerminalRequest,
  type Owner, type Result, type TerminalState, type TerminalSession, type TerminalOutput, type TerminalPhase,
  type TerminalTarget, type TerminalActionResponse, type WriteTerminalRequest, type ResizeTerminalRequest,
  type AckTerminalRequest,
} from "@ssterm/contracts";
import type { SessionRegistry, SessionSnapshot, SessionState } from "@ssterm/services";
import type { TerminalStream } from "@ssterm/domain";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";

type Send = (channel: string, value: TerminalState | TerminalOutput) => void;
interface Registration {
  owner: Owner;
  sequence: number;
  send: Send;
  unsubscribe(): void;
}
const phases = {
  Idle: "connecting", Connecting: "connecting", VerifyingHost: "connecting", Authenticating: "connecting",
  AwaitingInput: "connecting", Ready: "ready", Closing: "closed", Closed: "closed", Failed: "failed",
} as const satisfies Record<SessionState, TerminalPhase>;
const accepted: Result<TerminalActionResponse> = { ok: true, value: { accepted: true } };

function project(snapshot: SessionSnapshot): TerminalSession {
  const target = snapshot.target;
  return {
    sessionId: snapshot.id,
    generation: snapshot.generation,
    phase: phases[snapshot.state],
    target: target ? { label: target.label, environment: target.environment, endpointHost: target.address,
      endpointPort: target.port, username: target.username } : null,
    end: snapshot.end ? { ...snapshot.end } : null,
  };
}

/** Fence and framing only: stream policy lives in the adapter, lifecycle in the registry. */
export function createTerminalController(options: {
  registry: Pick<SessionRegistry, "snapshot" | "subscribe" | "terminal">;
}) {
  const registrations = new Map<string, Registration>();
  let disposed = false;
  const matching = (owner: Owner) => registrations.get(sessionOwnerId(owner));
  const state = (registration: Registration): Result<TerminalState> => {
    try {
      const value: TerminalState = { owner: { ...registration.owner }, sequence: registration.sequence,
        sessions: options.registry.snapshot(sessionOwnerId(registration.owner)).map(project) };
      return isTerminalState(value) ? { ok: true, value } : failure("unavailable");
    } catch { return failure("unavailable"); }
  };
  const publish = (registration: Registration) => {
    if (disposed || matching(registration.owner) !== registration) return;
    registration.sequence += 1;
    const current = state(registration);
    if (!current.ok) return;
    try { registration.send(channels.terminalStateChanged, current.value); } catch { /* Closed windows cannot interrupt cleanup. */ }
  };
  const revokeOwner = (owner: Owner) => {
    const registration = matching(owner);
    registrations.delete(sessionOwnerId(owner));
    registration?.unsubscribe();
  };
  /** Runs `use` only on the exact owner/session/generation stream while it is live and Ready. */
  const withStream = (request: TerminalTarget, use: (stream: TerminalStream, registration: Registration) => Result<TerminalActionResponse>): Result<TerminalActionResponse> => {
    const registration = matching(request.owner);
    if (disposed || !registration) return failure("stale-owner");
    try {
      const stream = options.registry.terminal(sessionOwnerId(request.owner), request.sessionId, request.generation);
      return stream ? use(stream, registration) : failure("conflict");
    } catch { return failure("unavailable"); }
  };
  return {
    register(owner: Owner, send: Send) {
      if (disposed) return;
      const existing = matching(owner);
      if (existing) { existing.send = send; return; }
      const registration: Registration = { owner: { ...owner }, sequence: 0, send, unsubscribe: () => {} };
      registrations.set(sessionOwnerId(owner), registration);
      registration.unsubscribe = options.registry.subscribe(sessionOwnerId(owner), () => publish(registration));
    },
    terminalState(owner: Owner): Result<TerminalState> {
      const registration = matching(owner);
      return !disposed && registration ? state(registration) : failure("stale-owner");
    },
    openTerminal(request: TerminalTarget): Result<TerminalActionResponse> {
      if (!isTerminalTarget(request)) return failure("invalid-request");
      const { sessionId, generation } = request;
      const owner = { ...request.owner };
      return withStream(request, (stream, registration) => {
        // A second open would bind nothing; the view must not wait for frames from sequence 0.
        const bound = stream.open((bytes, sequence) => {
          // Frames for a revoked or replaced owner are discarded; its sessions are already closing.
          if (disposed || matching(owner) !== registration) return;
          const frame: TerminalOutput = { owner: { ...owner }, sessionId, generation, sequence, bytes };
          if (!isTerminalOutput(frame)) return;
          try { registration.send(channels.terminalOutput, frame); } catch { /* Closed windows cannot interrupt output. */ }
        });
        return bound ? accepted : failure("conflict");
      });
    },
    writeTerminal(request: WriteTerminalRequest): Result<TerminalActionResponse> {
      if (!isWriteTerminalRequest(request)) return failure("invalid-request");
      return withStream(request, (stream) => {
        const written = stream.write(request.bytes);
        return written === "ok" ? accepted : failure(written === "busy" ? "busy" : "conflict");
      });
    },
    resizeTerminal(request: ResizeTerminalRequest): Result<TerminalActionResponse> {
      if (!isResizeTerminalRequest(request)) return failure("invalid-request");
      return withStream(request, (stream) => { stream.resize(request.columns, request.rows); return accepted; });
    },
    ackTerminal(request: AckTerminalRequest): Result<TerminalActionResponse> {
      if (!isAckTerminalRequest(request)) return failure("invalid-request");
      return withStream(request, (stream) => { stream.ack(request.bytes); return accepted; });
    },
    revokeOwner,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of [...registrations.values()]) revokeOwner(registration.owner);
    },
  };
}
export type TerminalController = ReturnType<typeof createTerminalController>;

export function registerTerminalHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => TerminalController | undefined;
}): () => void {
  const ownedChannels = [channels.terminalState, channels.openTerminal, channels.writeTerminal, channels.resizeTerminal, channels.ackTerminal];
  const register = (event: IpcMainInvokeEvent, owner: Owner, controller: TerminalController) => controller.register(owner, (channel, value) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, value);
  });
  // Handlers stay synchronous so the arrival order of write invokes is the order bytes reach the channel.
  const handle = <T>(channel: string, validate: (value: unknown) => value is T, run: (controller: TerminalController, request: T) => unknown) => {
    options.ipc.handle(channel, (event, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        register(event, authorized.value, controller);
        return run(controller, request);
      } catch { return failure("unavailable"); }
      finally {
        // Typed input can be a remote password; the channel has its own copy by now.
        if (channel === channels.writeTerminal) for (const arg of args) {
          if (arg && typeof arg === "object" && "bytes" in arg && arg.bytes instanceof Uint8Array) arg.bytes.fill(0);
        }
      }
    });
  };
  handle(channels.terminalState, isTerminalStateRequest, (controller, request) => controller.terminalState(request.owner));
  handle(channels.openTerminal, isTerminalTarget, (controller, request) => controller.openTerminal(request));
  handle(channels.writeTerminal, isWriteTerminalRequest, (controller, request) => controller.writeTerminal(request));
  handle(channels.resizeTerminal, isResizeTerminalRequest, (controller, request) => controller.resizeTerminal(request));
  handle(channels.ackTerminal, isAckTerminalRequest, (controller, request) => controller.ackTerminal(request));
  return () => { for (const channel of ownedChannels) options.ipc.removeHandler(channel); };
}
