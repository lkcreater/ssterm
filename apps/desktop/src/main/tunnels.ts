import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  channels, failure, isTunnelRuleRequest, isTunnelState, isTunnelStateRequest, TUNNEL_ERROR_CODES,
  type Owner, type Result, type StartTunnelResponse, type StopTunnelResponse, type TunnelErrorCode, type TunnelRuleRequest,
  type TunnelState, type TunnelStatus,
} from "@ssterm/contracts";
import type { SessionRegistry, TunnelFailure, TunnelService, TunnelSnapshot } from "@ssterm/services";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";

type Service = Pick<TunnelService, "start" | "stop" | "snapshot" | "subscribe">;
interface Registration {
  owner: Owner;
  sequence: number;
  send(state: TunnelState): void;
  unsubscribe(): void;
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const errorCode = (code: TunnelFailure | null): TunnelErrorCode =>
  code && (TUNNEL_ERROR_CODES as readonly string[]).includes(code) ? code as TunnelErrorCode : "other";
const status = (row: TunnelSnapshot & { state: TunnelStatus["phase"] }): TunnelStatus => ({
  ruleId: row.ruleId, phase: row.state, error: row.state === "failed" ? errorCode(row.error) : null,
  activeConnections: row.activeConnections, totalConnections: row.totalConnections, failedConnections: row.failedConnections,
  remotePort: row.remotePort,
});

/** Owner-bound tunnel status and the explicit Start/Stop actions. Start is the unlock, as for other explicit actions. */
export function createTunnelController(options: {
  service: Service;
  lock?: Pick<SessionRegistry, "locked" | "lockEpoch" | "unlock">;
  checkAccess?: () => Promise<boolean>;
}) {
  const registrations = new Map<string, Registration>();
  let disposed = false;
  const state = (registration: Registration): Result<TunnelState> => {
    const value = {
      owner: { ...registration.owner }, sequence: registration.sequence,
      tunnels: options.service.snapshot(sessionOwnerId(registration.owner))
        .filter((row): row is TunnelSnapshot & { state: TunnelStatus["phase"] } => row.state !== "stopped").map(status),
    };
    return isTunnelState(value) ? ok(value) : failure("unavailable");
  };
  const publish = (registration: Registration) => {
    registration.sequence += 1;
    const current = state(registration);
    if (!current.ok) return;
    try { registration.send(current.value); } catch { /* A closed window cannot interrupt other owners. */ }
  };
  async function unlocked(since: number): Promise<boolean> {
    const lock = options.lock;
    if (!lock) return !disposed;
    if (lock.locked && options.checkAccess) await lock.unlock(options.checkAccess, since);
    return !disposed && !lock.locked && lock.lockEpoch === since;
  }
  return {
    register(owner: Owner, send: (state: TunnelState) => void): void {
      if (disposed) return;
      const key = sessionOwnerId(owner);
      const existing = registrations.get(key);
      if (existing) { existing.send = send; return; }
      const registration: Registration = { owner: { ...owner }, sequence: 0, send, unsubscribe: () => {} };
      registration.unsubscribe = options.service.subscribe(key, () => publish(registration));
      registrations.set(key, registration);
    },
    tunnelState(owner: Owner): Result<TunnelState> {
      const registration = registrations.get(sessionOwnerId(owner));
      return !disposed && registration ? state(registration) : failure("stale-owner");
    },
    async startTunnel(request: TunnelRuleRequest): Promise<Result<StartTunnelResponse>> {
      const since = options.lock?.lockEpoch ?? 0;
      if (disposed || !registrations.has(sessionOwnerId(request.owner))) return failure("stale-owner");
      if (!(await unlocked(since))) return ok({ status: "failed", code: "locked" });
      // The window may have closed while the unlock was pending.
      if (disposed || !registrations.has(sessionOwnerId(request.owner))) return failure("stale-owner");
      const started = await options.service.start(sessionOwnerId(request.owner), request.ruleId);
      return ok(started.ok ? { status: "starting" } : { status: "failed", code: errorCode(started.code) });
    },
    async stopTunnel(request: TunnelRuleRequest): Promise<Result<StopTunnelResponse>> {
      if (disposed || !registrations.has(sessionOwnerId(request.owner))) return failure("stale-owner");
      // Idempotent: a rule with no tunnel is already stopped.
      await options.service.stop(sessionOwnerId(request.owner), request.ruleId);
      return ok({ status: "stopped" });
    },
    revokeOwner(owner: Owner): void {
      const key = sessionOwnerId(owner);
      registrations.get(key)?.unsubscribe();
      registrations.delete(key);
    },
    dispose(): void {
      disposed = true;
      for (const registration of registrations.values()) registration.unsubscribe();
      registrations.clear();
    },
  };
}
export type TunnelController = ReturnType<typeof createTunnelController>;

export const tunnelChannels = Object.freeze([channels.tunnelState, channels.startTunnel, channels.stopTunnel]);

export function registerTunnelHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => TunnelController | undefined;
}): () => void {
  const handle = <T extends { owner: Owner }>(channel: string, validate: (value: unknown) => value is T,
    run: (controller: TunnelController, request: T) => unknown) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        controller.register(authorized.value, (state) => {
          if (!event.sender.isDestroyed()) event.sender.send(channels.tunnelStateChanged, state);
        });
        return await run(controller, request);
      } catch { return failure("unavailable"); }
    });
  };
  handle(channels.tunnelState, isTunnelStateRequest, (controller, request) => controller.tunnelState(request.owner));
  handle(channels.startTunnel, isTunnelRuleRequest, (controller, request) => controller.startTunnel(request));
  handle(channels.stopTunnel, isTunnelRuleRequest, (controller, request) => controller.stopTunnel(request));
  return () => { for (const channel of tunnelChannels) options.ipc.removeHandler(channel); };
}
