import type { Duplex } from "node:stream";
import type { MetadataRepository, TunnelRule } from "@ssterm/domain";
import type { SessionErrorCode, SessionRegistry, SessionSnapshot } from "./sessions.ts";

/** Local connections one running tunnel serves at once; more are closed on arrival. */
export const TUNNEL_MAX_CONNECTIONS = 64;
/** Active (starting, running or stopping) tunnels per service. Each also holds one registry session. */
export const MAX_TUNNELS = 16;

/** `stopped` appears only in the final event for a tunnel that was removed; `snapshot()` never lists it. */
export type TunnelState = "starting" | "running" | "stopping" | "failed" | "stopped";
/** Bind problems, rule problems, or the session's own typed failure (`locked`, `network`, `timeout`, …). */
export type TunnelFailure =
  | "address-in-use"
  | "permission-denied"
  | "address-unavailable"
  | "bind-failed"
  | "rule-not-found"
  | "already-active"
  | "resource-limit"
  | SessionErrorCode;
export interface TunnelSnapshot {
  ruleId: string;
  hostId: string;
  bindAddress: TunnelRule["bindAddress"];
  bindPort: number;
  destinationHost: string;
  destinationPort: number;
  state: TunnelState;
  /** Set only when `failed`. */
  error: TunnelFailure | null;
  /** Counters only; peer addresses and payload are never kept. */
  activeConnections: number;
  totalConnections: number;
  /** Local connections closed because the destination could not be opened or a limit was reached. */
  failedConnections: number;
}
export type TunnelResult<T> = { ok: true; value: T } | { ok: false; code: TunnelFailure };

/** The socket surface the service uses; `net.Socket` satisfies it. */
export type TunnelSocket = Duplex & { remoteAddress?: string; remotePort?: number };
export interface TunnelListener {
  readonly port: number;
  close(): Promise<void>;
}
export type TunnelListen = (options: {
  address: TunnelRule["bindAddress"];
  port: number;
  connection(socket: TunnelSocket): void;
  /** The listener failed after binding (it is already closing). */
  failed?(): void;
}) => Promise<{ ok: true; listener: TunnelListener } | { ok: false; code: "address-in-use" | "permission-denied" | "address-unavailable" | "bind-failed" }>;
type Registry = Pick<SessionRegistry, "connect" | "close" | "forget" | "settled" | "snapshot" | "subscribe" | "tunnel">;

interface Tunnel {
  ownerId: string;
  rule: TunnelRule;
  state: TunnelState;
  error: TunnelFailure | null;
  listener?: TunnelListener;
  sessionId?: string;
  generation?: number;
  /** Local sockets with their forwarded streams. */
  pairs: Set<{ socket: TunnelSocket; stream?: Duplex }>;
  total: number;
  failedConnections: number;
  stopping?: Promise<void>;
}

/**
 * Local port forwarding over saved hosts. A tunnel binds first (so a collision fails before any SSH work), then
 * connects its own `tunnel` session; it is `running` only once both are ready. Stop, failure, lock (which fails the
 * session), owner revocation and dispose close the listener and every accepted socket and forwarded stream. Nothing
 * here starts a tunnel except `start`, and nothing persists running state.
 */
export class TunnelService {
  readonly #tunnels = new Map<string, Tunnel>();
  readonly #observers = new Map<string, Set<(snapshot: TunnelSnapshot) => void>>();
  readonly #unsubscribe = new Map<string, () => void>();
  #disposed = false;
  constructor(private readonly options: {
    registry: Registry;
    repository: Pick<MetadataRepository, "snapshot">;
    listen: TunnelListen;
  }) {}

  /** Starts a saved rule. Resolves `starting` once bound and connecting; progress arrives through `subscribe`. */
  async start(ownerId: string, ruleId: string): Promise<TunnelResult<TunnelSnapshot>> {
    if (this.#disposed) return { ok: false, code: "disposed" };
    const key = this.#key(ownerId, ruleId);
    const existing = this.#tunnels.get(key);
    if (existing && existing.state !== "failed") return { ok: false, code: "already-active" };
    // A failed tunnel may still be releasing its port and session; restart only after that finished.
    if (existing?.stopping) await existing.stopping;
    if (this.#disposed) return { ok: false, code: "disposed" };
    const again = this.#tunnels.get(key);
    if (again && again !== existing) return { ok: false, code: "already-active" };
    if ([...this.#tunnels.values()].filter((row) => row.state !== "failed").length >= MAX_TUNNELS)
      return { ok: false, code: "resource-limit" };
    const stored = this.options.repository.snapshot();
    const rule = stored.ok ? stored.value.tunnelRules.find((row) => row.id === ruleId) : undefined;
    if (!rule) return { ok: false, code: "rule-not-found" };
    const tunnel: Tunnel = { ownerId, rule: structuredClone(rule), state: "starting", error: null, pairs: new Set(), total: 0, failedConnections: 0 };
    this.#tunnels.set(key, tunnel);
    const bound = await this.options.listen({
      address: rule.bindAddress,
      port: rule.bindPort,
      connection: (socket) => this.#accept(tunnel, socket),
      failed: () => void this.#teardown(tunnel, "failed", "bind-failed"),
    });
    if (this.#tunnels.get(key) !== tunnel || tunnel.state !== "starting" || this.#disposed) {
      // Stopped or disposed while binding.
      if (bound.ok) await bound.listener.close();
      return { ok: false, code: this.#disposed ? "disposed" : "invalid-state" };
    }
    if (!bound.ok) return this.#failStart(tunnel, bound.code);
    tunnel.listener = bound.listener;
    this.#watch(ownerId);
    const connected = this.options.registry.connect(ownerId, rule.hostId, "tunnel");
    if (!connected.ok) {
      await tunnel.listener.close();
      return this.#failStart(tunnel, connected.error.code);
    }
    tunnel.sessionId = connected.value.id;
    tunnel.generation = connected.value.generation;
    this.#emit(tunnel);
    // The session may already have settled while we subscribed.
    this.#observe(tunnel, connected.value);
    return { ok: true, value: this.#snapshot(tunnel) };
  }

  /** Closes the listener, every accepted socket and the session. Resolves when all of that finished. */
  stop(ownerId: string, ruleId: string): Promise<TunnelResult<void>> {
    const tunnel = this.#tunnels.get(this.#key(ownerId, ruleId));
    if (!tunnel) return Promise.resolve({ ok: false, code: "not-found" });
    const key = this.#key(ownerId, ruleId);
    // A failed tunnel is only forgotten once its own teardown released the port and session.
    const done = tunnel.state === "failed" ? Promise.resolve(tunnel.stopping) : this.#teardown(tunnel, "stopping", null);
    return done.then(() => {
      if (this.#tunnels.get(key) === tunnel) {
        this.#tunnels.delete(key);
        this.#notify(tunnel.ownerId, { ...this.#snapshot(tunnel), state: "stopped", error: null, activeConnections: 0 });
      }
      return { ok: true as const, value: undefined };
    });
  }

  snapshot(ownerId: string): TunnelSnapshot[] {
    return [...this.#tunnels.values()].filter((row) => row.ownerId === ownerId).map((row) => this.#snapshot(row));
  }
  /** Rules with a starting, running or stopping tunnel (SST-026 refuses editing or deleting those). */
  active(ruleId: string): boolean {
    return [...this.#tunnels.values()].some((row) => row.rule.id === ruleId && row.state !== "failed");
  }
  subscribe(ownerId: string, callback: (snapshot: TunnelSnapshot) => void): () => void {
    if (this.#disposed || typeof callback !== "function") return () => {};
    const set = this.#observers.get(ownerId) ?? new Set();
    set.add(callback);
    this.#observers.set(ownerId, set);
    return () => {
      set.delete(callback);
      if (!set.size) this.#observers.delete(ownerId);
    };
  }
  /** Owner revocation: stop that owner's tunnels and forget them. */
  async closeOwner(ownerId: string): Promise<void> {
    // A revoked window receives nothing more, not even the teardown's own state changes.
    this.#observers.delete(ownerId);
    const owned = [...this.#tunnels.values()].filter((row) => row.ownerId === ownerId);
    await Promise.all(owned.map((row) => this.stop(ownerId, row.rule.id)));
    this.#unsubscribe.get(ownerId)?.();
    this.#unsubscribe.delete(ownerId);
  }
  /** Quit: stops every tunnel. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await Promise.all([...this.#tunnels.values()].map((row) => row.state === "failed" ? row.stopping : this.#teardown(row, "stopping", null)));
    this.#tunnels.clear();
    for (const stop of this.#unsubscribe.values()) stop();
    this.#unsubscribe.clear();
    this.#observers.clear();
  }

  #key(ownerId: string, ruleId: string): string {
    return `${ownerId}\u0000${ruleId}`;
  }
  #failStart(tunnel: Tunnel, code: TunnelFailure): TunnelResult<TunnelSnapshot> {
    // Stopped meanwhile: the row is gone and must not come back as failed.
    if (tunnel.stopping) return { ok: false, code: "invalid-state" };
    tunnel.state = "failed";
    tunnel.error = code;
    this.#emit(tunnel);
    return { ok: false, code };
  }
  #watch(ownerId: string): void {
    if (this.#unsubscribe.has(ownerId)) return;
    this.#unsubscribe.set(ownerId, this.options.registry.subscribe(ownerId, (snapshot) => {
      for (const tunnel of this.#tunnels.values())
        if (tunnel.ownerId === ownerId && tunnel.sessionId === snapshot.id) this.#observe(tunnel, snapshot);
    }));
  }
  #observe(tunnel: Tunnel, snapshot: SessionSnapshot): void {
    if (snapshot.kind !== "tunnel" || snapshot.generation !== tunnel.generation) return;
    if (tunnel.state === "starting" && snapshot.state === "Ready") {
      tunnel.state = "running";
      this.#emit(tunnel);
      return;
    }
    if ((tunnel.state === "starting" || tunnel.state === "running") && ["Failed", "Closing", "Closed"].includes(snapshot.state)) {
      // Lock, transport loss, keepalive timeout, auth failure or a remote end: the tunnel cannot continue.
      void this.#teardown(tunnel, "failed", snapshot.error?.code ?? "network");
    }
  }
  #accept(tunnel: Tunnel, socket: TunnelSocket): void {
    const pair: { socket: TunnelSocket; stream?: Duplex } = { socket };
    socket.on("error", () => socket.destroy());
    const refuse = () => {
      tunnel.failedConnections += 1;
      socket.destroy();
      this.#emit(tunnel);
    };
    if (tunnel.state !== "running" || tunnel.pairs.size >= TUNNEL_MAX_CONNECTIONS) return refuse();
    const session = tunnel.sessionId && this.options.registry.tunnel(tunnel.ownerId, tunnel.sessionId, tunnel.generation!);
    if (!session) return refuse();
    tunnel.pairs.add(pair);
    tunnel.total += 1;
    // Nothing is read until the forwarded stream exists, so early bytes wait in the socket.
    socket.pause();
    const release = () => {
      if (!tunnel.pairs.delete(pair)) return;
      socket.destroy();
      pair.stream?.destroy();
      this.#emit(tunnel);
    };
    socket.once("close", release);
    this.#emit(tunnel);
    void session.forward(
      { address: socket.remoteAddress ?? "", port: socket.remotePort ?? 0 },
      { host: tunnel.rule.destinationHost, port: tunnel.rule.destinationPort },
    ).then((opened) => {
      if (!opened.ok) {
        if (tunnel.pairs.has(pair)) tunnel.failedConnections += 1;
        return release();
      }
      if (!tunnel.pairs.has(pair) || tunnel.state !== "running") {
        opened.stream.destroy();
        return release();
      }
      pair.stream = opened.stream;
      opened.stream.once("close", release);
      // pipe() applies backpressure both ways; either side ending closes the pair.
      socket.pipe(opened.stream);
      opened.stream.pipe(socket);
      socket.resume();
    }, release);
  }
  /** Closes the listener first (no new sockets), then every pair, then the session. */
  #teardown(tunnel: Tunnel, state: "stopping" | "failed", error: TunnelFailure | null): Promise<void> {
    if (tunnel.stopping) return tunnel.stopping;
    tunnel.state = state;
    tunnel.error = error;
    this.#emit(tunnel);
    tunnel.stopping = (async () => {
      const listener = tunnel.listener;
      tunnel.listener = undefined;
      const closed = listener?.close();
      for (const pair of [...tunnel.pairs]) {
        pair.socket.destroy();
        pair.stream?.destroy();
      }
      tunnel.pairs.clear();
      await closed;
      const { sessionId, generation } = tunnel;
      if (sessionId) {
        await this.options.registry.close(tunnel.ownerId, sessionId, generation).catch(() => undefined);
        await this.options.registry.settled(tunnel.ownerId, sessionId, generation!).catch(() => undefined);
        this.options.registry.forget(tunnel.ownerId, sessionId, generation);
      }
      if (state === "failed") this.#emit(tunnel);
    })();
    return tunnel.stopping;
  }
  #snapshot(tunnel: Tunnel): TunnelSnapshot {
    const { rule } = tunnel;
    return {
      ruleId: rule.id, hostId: rule.hostId, bindAddress: rule.bindAddress, bindPort: rule.bindPort,
      destinationHost: rule.destinationHost, destinationPort: rule.destinationPort,
      state: tunnel.state, error: tunnel.error,
      activeConnections: tunnel.pairs.size, totalConnections: tunnel.total, failedConnections: tunnel.failedConnections,
    };
  }
  #emit(tunnel: Tunnel): void {
    // A replaced or forgotten tunnel (e.g. a late teardown after a restart) never reports over its successor.
    const current = this.#tunnels.get(this.#key(tunnel.ownerId, tunnel.rule.id));
    if (current !== tunnel) return;
    this.#notify(tunnel.ownerId, this.#snapshot(tunnel));
  }
  #notify(ownerId: string, value: TunnelSnapshot): void {
    for (const callback of [...(this.#observers.get(ownerId) ?? [])]) {
      try { callback(value); } catch { /* An observer cannot interrupt the tunnel. */ }
    }
  }
}
