import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  channels, failure, isTerminalOutput, isTerminalState, isTerminalStateRequest, isTerminalTarget,
  isWriteTerminalRequest, isResizeTerminalRequest, isAckTerminalRequest, isConnectHostRequest,
  type Owner, type Result, type TerminalState, type TerminalSession, type TerminalOutput, type TerminalPhase,
  type TerminalTarget, type TerminalActionResponse, type WriteTerminalRequest, type ResizeTerminalRequest,
  type AckTerminalRequest, type TerminalErrorCode, type ConnectHostRequest, type ConnectHostResponse,
} from "@ssterm/contracts";
import type { SessionErrorCode, SessionRegistry, SessionResult, SessionSnapshot, SessionState } from "@ssterm/services";
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
// Exhaustive, so a new registry code fails compilation until it is allowlisted or folded.
const errors = {
  "invalid-request": "subsystem-unavailable", "invalid-state": "subsystem-unavailable", "not-found": "subsystem-unavailable",
  disposed: "subsystem-unavailable", locked: "locked", "invalid-config": "invalid-config",
  "host-key-untrusted": "host-key-untrusted", "host-key-changed": "host-key-changed", "auth-denied": "auth-denied",
  "credentials-required": "credentials-required", "credentials-unavailable": "credentials-unavailable",
  "invalid-private-key": "invalid-private-key", "unsupported-private-key": "unsupported-private-key",
  "key-mismatch": "key-mismatch", "prompt-cancelled": "prompt-cancelled", timeout: "timeout", dns: "dns", network: "network",
  "channel-open-failed": "channel-open-failed", "subsystem-unavailable": "subsystem-unavailable", "resource-limit": "resource-limit",
} as const satisfies Record<SessionErrorCode, TerminalErrorCode>;
const accepted: Result<TerminalActionResponse> = { ok: true, value: { accepted: true } };
const relocked: SessionResult<never> = { ok: false, error: { code: "locked", message: "The workspace is locked." } };
/** Lifecycle outcomes: a missing, stale or wrong-state target is `conflict`; anything else is `unavailable`. */
const outcome = (result: SessionResult<unknown>): Result<TerminalActionResponse> =>
  result.ok ? accepted : failure(["not-found", "invalid-state"].includes(result.error.code) ? "conflict" : "unavailable");

function project(snapshot: SessionSnapshot): TerminalSession {
  const target = snapshot.target;
  return {
    sessionId: snapshot.id,
    generation: snapshot.generation,
    hostId: snapshot.hostId,
    phase: phases[snapshot.state],
    target: target ? { label: target.label, environment: target.environment, endpointHost: target.address,
      endpointPort: target.port, username: target.username } : null,
    end: snapshot.end ? { ...snapshot.end } : null,
    error: snapshot.error ? errors[snapshot.error.code] ?? "subsystem-unavailable" : null,
  };
}

/** Fence and framing only: stream policy lives in the adapter, lifecycle in the registry. */
export function createTerminalController(options: {
  registry: Pick<SessionRegistry, "snapshot" | "subscribe" | "terminal" | "connect" | "close" | "reconnect" | "forget" | "unlock" | "settled" | "lockEpoch">;
  /** Whether a locked registry may unlock (metadata storage ready; a missing secret store fails per saved ref). Absent: never. */
  checkAccess?: () => Promise<boolean>;
}) {
  const registrations = new Map<string, Registration>();
  let disposed = false;
  const matching = (owner: Owner) => registrations.get(sessionOwnerId(owner));
  const state = (registration: Registration): Result<TerminalState> => {
    try {
      const value: TerminalState = { owner: { ...registration.owner }, sequence: registration.sequence,
        sessions: options.registry.snapshot(sessionOwnerId(registration.owner)).filter((session) => session.kind === "terminal").map(project) };
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
  /** Exact owner/session/generation lifecycle command; foreign sessions are indistinguishable from missing ones. */
  const lifecycle = async (request: TerminalTarget, run: (ownerId: string) => SessionResult<unknown> | Promise<SessionResult<unknown>>, settle = false): Promise<Result<TerminalActionResponse>> => {
    if (!isTerminalTarget(request)) return failure("invalid-request");
    if (disposed || !matching(request.owner)) return failure("stale-owner");
    try {
      const ownerId = sessionOwnerId(request.owner);
      // Another kind's session is not a terminal target, exactly like a missing one.
      if (options.registry.snapshot(ownerId, request.sessionId).some((session) => session.kind !== "terminal")) return failure("conflict");
      if (settle) {
        // A pane offers Reconnect/Close as soon as a generation fails; wait out its bounded teardown instead of refusing.
        await options.registry.settled(ownerId, request.sessionId, request.generation);
        if (disposed || !matching(request.owner)) return failure("stale-owner");
      }
      return outcome(await run(ownerId));
    } catch { return failure("unavailable"); }
  };
  return {
    register(owner: Owner, send: Send) {
      if (disposed) return;
      const existing = matching(owner);
      if (existing) { existing.send = send; return; }
      const registration: Registration = { owner: { ...owner }, sequence: 0, send, unsubscribe: () => {} };
      registrations.set(sessionOwnerId(owner), registration);
      registration.unsubscribe = options.registry.subscribe(sessionOwnerId(owner), (snapshot) => {
        if (snapshot.kind === "terminal") publish(registration);
      });
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
    /** Resolves once teardown settles (bounded by the registry drain limit). Idempotent on Closed. */
    closeTerminal(request: TerminalTarget): Promise<Result<TerminalActionResponse>> {
      return lifecycle(request, (ownerId) => options.registry.close(ownerId, request.sessionId, request.generation));
    },
    reconnectTerminal(request: TerminalTarget): Promise<Result<TerminalActionResponse>> {
      // Captured on arrival, before the teardown wait: a click that predates a lock never unlocks or reconnects after it.
      const since = options.registry.lockEpoch;
      return lifecycle(request, async (ownerId) => {
        const reconnect = () => options.registry.lockEpoch === since
          ? options.registry.reconnect(ownerId, request.sessionId, request.generation) : relocked;
        const first = reconnect();
        if (first.ok || first.error.code !== "locked" || !options.checkAccess) return first;
        // The user's Reconnect is the explicit unlock action. A refused unlock may only have been superseded by
        // a concurrent one, so reconnect is retried once either way; it re-checks the lock and the epoch.
        await options.registry.unlock(options.checkAccess, since);
        // An owner revoked while access was checked must not start a new generation.
        return disposed || !matching(request.owner) ? first : reconnect();
      }, true);
    },
    /** Opens a new session for a saved host. Like Reconnect, a Connect after a lock is the explicit unlock. */
    async connectHost(request: ConnectHostRequest): Promise<Result<ConnectHostResponse>> {
      if (!isConnectHostRequest(request)) return failure("invalid-request");
      if (disposed || !matching(request.owner)) return failure("stale-owner");
      const since = options.registry.lockEpoch;
      try {
        const ownerId = sessionOwnerId(request.owner);
        const connect = () => options.registry.lockEpoch === since ? options.registry.connect(ownerId, request.hostId) : relocked;
        let result = connect();
        if (!result.ok && result.error.code === "locked" && options.checkAccess) {
          await options.registry.unlock(options.checkAccess, since);
          if (disposed || !matching(request.owner)) return failure("stale-owner");
          result = connect();
        }
        if (result.ok) return { ok: true, value: { sessionId: result.value.id, generation: result.value.generation } };
        return failure(result.error.code === "resource-limit" ? "busy" : "unavailable");
      } catch { return failure("unavailable"); }
    },
    dismissTerminal(request: TerminalTarget): Promise<Result<TerminalActionResponse>> {
      return lifecycle(request, (ownerId) => {
        const result = options.registry.forget(ownerId, request.sessionId, request.generation);
        // Forgetting a record emits nothing from the registry, so the owner's view learns it here.
        const registration = matching(request.owner);
        if (result.ok && registration) publish(registration);
        return result;
      }, true);
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

/** Every IPC channel `registerTerminalHandlers` owns, for callers that re-register them. */
export const terminalChannels = Object.freeze([
  channels.terminalState, channels.openTerminal, channels.writeTerminal, channels.resizeTerminal, channels.ackTerminal,
  channels.closeTerminal, channels.reconnectTerminal, channels.dismissTerminal, channels.connectHost,
]);

export function registerTerminalHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => TerminalController | undefined;
}): () => void {
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
  handle(channels.closeTerminal, isTerminalTarget, (controller, request) => controller.closeTerminal(request));
  handle(channels.reconnectTerminal, isTerminalTarget, (controller, request) => controller.reconnectTerminal(request));
  handle(channels.dismissTerminal, isTerminalTarget, (controller, request) => controller.dismissTerminal(request));
  handle(channels.connectHost, isConnectHostRequest, (controller, request) => controller.connectHost(request));
  return () => { for (const channel of terminalChannels) options.ipc.removeHandler(channel); };
}

const MAX_PROMPT_LINES = 8;
/** Native close/quit sheet text, or undefined when no Ready session would be disconnected. */
export function closePrompt(sessions: readonly TerminalSession[], action: "close" | "quit"): { message: string; detail: string } | undefined {
  const ready = sessions.filter((session) => session.phase === "ready");
  if (ready.length === 0) return undefined;
  const count = ready.length === 1 ? "1 connected session" : `${ready.length} connected sessions`;
  const lines = ready.slice(0, MAX_PROMPT_LINES).map(({ target }) => {
    if (!target) return "Unknown host";
    const host = target.endpointHost.includes(":") ? `[${target.endpointHost}]` : target.endpointHost;
    const endpoint = `${target.username ? `${target.username}@` : ""}${host}:${target.endpointPort}`;
    return `${target.environment === "PROD" ? "PROD · " : ""}${target.label} — ${endpoint}`;
  });
  if (ready.length > MAX_PROMPT_LINES) lines.push(`and ${ready.length - MAX_PROMPT_LINES} more`);
  return {
    message: action === "close" ? `Close this window and disconnect ${count}?` : `Quit ssterm and disconnect ${count}?`,
    detail: lines.join("\n"),
  };
}
