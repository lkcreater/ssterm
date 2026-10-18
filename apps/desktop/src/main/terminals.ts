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

interface Registration<M> {
  owner: Owner;
  sequence: number;
  send(channel: string, value: M): void;
  unsubscribe(): void;
}
export const phases = {
  Idle: "connecting", Connecting: "connecting", VerifyingHost: "connecting", Authenticating: "connecting",
  AwaitingInput: "connecting", Ready: "ready", Closing: "closed", Closed: "closed", Failed: "failed",
} as const satisfies Record<SessionState, TerminalPhase>;
// Exhaustive, so a new registry code fails compilation until it is allowlisted or folded.
export const errors = {
  "invalid-request": "subsystem-unavailable", "invalid-state": "subsystem-unavailable", "not-found": "subsystem-unavailable",
  disposed: "subsystem-unavailable", locked: "locked", "invalid-config": "invalid-config",
  "host-key-untrusted": "host-key-untrusted", "host-key-changed": "host-key-changed", "auth-denied": "auth-denied",
  "credentials-required": "credentials-required", "credentials-unavailable": "credentials-unavailable",
  "invalid-private-key": "invalid-private-key", "unsupported-private-key": "unsupported-private-key",
  "key-mismatch": "key-mismatch", "prompt-cancelled": "prompt-cancelled", timeout: "timeout", dns: "dns", network: "network",
  "channel-open-failed": "channel-open-failed", "subsystem-unavailable": "subsystem-unavailable", "resource-limit": "resource-limit",
  "jump-refused": "jump-refused", "proxy-failed": "proxy-failed",
} as const satisfies Record<SessionErrorCode, TerminalErrorCode>;
const accepted: Result<TerminalActionResponse> = { ok: true, value: { accepted: true } };
const relocked: SessionResult<never> = { ok: false, error: { code: "locked", message: "The workspace is locked." } };
/** Lifecycle outcomes: a missing, stale or wrong-state target is `conflict`; anything else is `unavailable`. */
const outcome = (result: SessionResult<unknown>): Result<TerminalActionResponse> =>
  result.ok ? accepted : failure(["not-found", "invalid-state"].includes(result.error.code) ? "conflict" : "unavailable");

export function project(snapshot: SessionSnapshot): TerminalSession {
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

export type LifecycleRegistry = Pick<SessionRegistry, "snapshot" | "subscribe" | "connect" | "close" | "reconnect" | "forget" | "unlock" | "settled" | "lockEpoch">;
export interface KindState<V> { owner: Owner; sequence: number; sessions: V[] }

/**
 * One session kind's owner registrations, state stream and lifecycle commands. Sessions of another kind are
 * invisible: they publish nothing and every command on them is `conflict`, exactly like a missing session.
 */
export function createKindSessions<V, Extra = never>(options: {
  kind: SessionSnapshot["kind"];
  registry: LifecycleRegistry;
  /** Whether a locked registry may unlock (metadata storage ready; a missing secret store fails per saved ref). Absent: never. */
  checkAccess?: () => Promise<boolean>;
  stateChannel: string;
  view(snapshot: SessionSnapshot, ownerId: string): V;
  isState(value: unknown): value is KindState<V>;
}) {
  type Live = Registration<KindState<V> | Extra>;
  const { registry, kind } = options;
  const registrations = new Map<string, Live>();
  let disposed = false;
  /** The live registration of `owner`; undefined once revoked or disposed. */
  const registration = (owner: Owner) => disposed ? undefined : registrations.get(sessionOwnerId(owner));
  const state = (current: Live): Result<KindState<V>> => {
    try {
      const ownerId = sessionOwnerId(current.owner);
      const value: KindState<V> = { owner: { ...current.owner }, sequence: current.sequence,
        sessions: registry.snapshot(ownerId).filter((session) => session.kind === kind).map((session) => options.view(session, ownerId)) };
      return options.isState(value) ? { ok: true, value } : failure("unavailable");
    } catch { return failure("unavailable"); }
  };
  const publish = (current: Live) => {
    if (registration(current.owner) !== current) return;
    current.sequence += 1;
    const next = state(current);
    if (!next.ok) return;
    try { current.send(options.stateChannel, next.value); } catch { /* Closed windows cannot interrupt cleanup. */ }
  };
  const revokeOwner = (owner: Owner) => {
    const current = registrations.get(sessionOwnerId(owner));
    registrations.delete(sessionOwnerId(owner));
    current?.unsubscribe();
  };
  /** Exact owner/session/generation lifecycle command; foreign sessions are indistinguishable from missing ones. */
  const lifecycle = async (request: TerminalTarget, run: (ownerId: string) => SessionResult<unknown> | Promise<SessionResult<unknown>>, settle = false): Promise<Result<TerminalActionResponse>> => {
    if (!isTerminalTarget(request)) return failure("invalid-request");
    if (!registration(request.owner)) return failure("stale-owner");
    try {
      const ownerId = sessionOwnerId(request.owner);
      if (registry.snapshot(ownerId, request.sessionId).some((session) => session.kind !== kind)) return failure("conflict");
      if (settle) {
        // A pane offers Reconnect/Close as soon as a generation fails; wait out its bounded teardown instead of refusing.
        await registry.settled(ownerId, request.sessionId, request.generation);
        if (!registration(request.owner)) return failure("stale-owner");
      }
      return outcome(await run(ownerId));
    } catch { return failure("unavailable"); }
  };
  return {
    registration,
    register(owner: Owner, send: Live["send"]) {
      if (disposed) return;
      const existing = registration(owner);
      if (existing) { existing.send = send; return; }
      const current: Live = { owner: { ...owner }, sequence: 0, send, unsubscribe: () => {} };
      registrations.set(sessionOwnerId(owner), current);
      current.unsubscribe = registry.subscribe(sessionOwnerId(owner), (snapshot) => {
        if (snapshot.kind === kind) publish(current);
      });
    },
    state(owner: Owner): Result<KindState<V>> {
      const current = registration(owner);
      return current ? state(current) : failure("stale-owner");
    },
    /** Resolves once teardown settles (bounded by the registry drain limit). Idempotent on Closed. */
    close(request: TerminalTarget): Promise<Result<TerminalActionResponse>> {
      return lifecycle(request, (ownerId) => registry.close(ownerId, request.sessionId, request.generation));
    },
    reconnect(request: TerminalTarget): Promise<Result<TerminalActionResponse>> {
      // Captured on arrival, before the teardown wait: a click that predates a lock never unlocks or reconnects after it.
      const since = registry.lockEpoch;
      return lifecycle(request, async (ownerId) => {
        const reconnect = () => registry.lockEpoch === since
          ? registry.reconnect(ownerId, request.sessionId, request.generation) : relocked;
        const first = reconnect();
        if (first.ok || first.error.code !== "locked" || !options.checkAccess) return first;
        // The user's Reconnect is the explicit unlock action. A refused unlock may only have been superseded by
        // a concurrent one, so reconnect is retried once either way; it re-checks the lock and the epoch.
        await registry.unlock(options.checkAccess, since);
        // An owner revoked while access was checked must not start a new generation.
        return registration(request.owner) ? reconnect() : first;
      }, true);
    },
    /** Opens a new session of this kind for a saved host. Like Reconnect, a Connect after a lock is the explicit unlock. */
    async connect(request: ConnectHostRequest): Promise<Result<ConnectHostResponse>> {
      if (!isConnectHostRequest(request)) return failure("invalid-request");
      if (!registration(request.owner)) return failure("stale-owner");
      const since = registry.lockEpoch;
      try {
        const ownerId = sessionOwnerId(request.owner);
        const connect = () => registry.lockEpoch === since ? registry.connect(ownerId, request.hostId, kind) : relocked;
        let result = connect();
        if (!result.ok && result.error.code === "locked" && options.checkAccess) {
          await registry.unlock(options.checkAccess, since);
          if (!registration(request.owner)) return failure("stale-owner");
          result = connect();
        }
        if (result.ok) return { ok: true, value: { sessionId: result.value.id, generation: result.value.generation } };
        return failure(result.error.code === "resource-limit" ? "busy" : "unavailable");
      } catch { return failure("unavailable"); }
    },
    dismiss(request: TerminalTarget): Promise<Result<TerminalActionResponse>> {
      return lifecycle(request, (ownerId) => {
        const result = registry.forget(ownerId, request.sessionId, request.generation);
        // Forgetting a record emits nothing from the registry, so the owner's view learns it here.
        const current = registration(request.owner);
        if (result.ok && current) publish(current);
        return result;
      }, true);
    },
    revokeOwner,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const current of [...registrations.values()]) revokeOwner(current.owner);
    },
  };
}

/** Fence and framing only: stream policy lives in the adapter, lifecycle in the registry. */
export function createTerminalController(options: {
  registry: LifecycleRegistry & Pick<SessionRegistry, "terminal">;
  checkAccess?: () => Promise<boolean>;
}) {
  const sessions = createKindSessions<TerminalSession, TerminalOutput>({ kind: "terminal", registry: options.registry, checkAccess: options.checkAccess,
    stateChannel: channels.terminalStateChanged, view: project, isState: isTerminalState });
  type Live = NonNullable<ReturnType<typeof sessions.registration>>;
  /** Runs `use` only on the exact owner/session/generation stream while it is live and Ready. */
  const withStream = (request: TerminalTarget, use: (stream: TerminalStream, registration: Live) => Result<TerminalActionResponse>): Result<TerminalActionResponse> => {
    const registration = sessions.registration(request.owner);
    if (!registration) return failure("stale-owner");
    try {
      const stream = options.registry.terminal(sessionOwnerId(request.owner), request.sessionId, request.generation);
      return stream ? use(stream, registration) : failure("conflict");
    } catch { return failure("unavailable"); }
  };
  return {
    register: sessions.register,
    terminalState: (owner: Owner): Result<TerminalState> => sessions.state(owner),
    openTerminal(request: TerminalTarget): Result<TerminalActionResponse> {
      if (!isTerminalTarget(request)) return failure("invalid-request");
      const { sessionId, generation } = request;
      const owner = { ...request.owner };
      return withStream(request, (stream, registration) => {
        // A second open would bind nothing; the view must not wait for frames from sequence 0.
        const bound = stream.open((bytes, sequence) => {
          // Frames for a revoked or replaced owner are discarded; its sessions are already closing.
          if (sessions.registration(owner) !== registration) return;
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
    closeTerminal: sessions.close,
    reconnectTerminal: sessions.reconnect,
    connectHost: sessions.connect,
    dismissTerminal: sessions.dismiss,
    revokeOwner: sessions.revokeOwner,
    dispose: sessions.dispose,
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
