import { connect, createServer, type Server, type Socket } from "node:net";

/** Loopback addresses a tunnel rule may bind (the schema allows nothing else). */
export type LoopbackAddress = "127.0.0.1" | "::1";
export type ListenFailure = "address-in-use" | "permission-denied" | "address-unavailable" | "bind-failed";
export interface LocalListener {
  readonly address: LoopbackAddress;
  readonly port: number;
  /** Open accepted sockets. */
  readonly connections: number;
  /** Stops accepting, destroys every accepted socket and resolves once the server closed. Idempotent. */
  close(): Promise<void>;
}
export type ListenResult = { ok: true; listener: LocalListener } | { ok: false; code: ListenFailure };
export type Listen = (options: {
  address: LoopbackAddress;
  port: number;
  /** Receives every accepted socket; it is destroyed by `close` if still open. */
  connection(socket: Socket): void;
  /** The server failed after it was listening; the listener is already closing. */
  failed?(): void;
}) => Promise<ListenResult>;

export const LISTEN_TIMEOUT_MS = 3_000;
/** How long the pre-bind probe waits for an existing loopback listener to answer. */
export const PROBE_TIMEOUT_MS = 500;
const failure = (code: unknown): ListenFailure =>
  code === "EADDRINUSE" ? "address-in-use" : code === "EACCES" || code === "EPERM" ? "permission-denied"
    : code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT" ? "address-unavailable" : "bind-failed";

/**
 * macOS lets a specific-address bind succeed beside a wildcard (`0.0.0.0` / `::`) listener on the same port, so a
 * port already served on loopback (for example a Docker-published port) would be silently shadowed. A connect probe
 * finds such a listener without ever binding a wildcard address ourselves.
 */
function servedOnLoopback(address: LoopbackAddress, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: address, port });
    const finish = (served: boolean) => { clearTimeout(timer); socket.destroy(); done(served); };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** A loopback-only TCP bind. Half-close is kept, as OpenSSH `-L` does, so a client's EOF still gets its reply. */
export const listenLocal: Listen = async ({ address, port, connection, failed }) => {
  if ((address !== "127.0.0.1" && address !== "::1") || !Number.isInteger(port) || port < 0 || port > 65_535)
    return { ok: false, code: "bind-failed" };
  if (port !== 0 && await servedOnLoopback(address, port)) return { ok: false, code: "address-in-use" };
  const sockets = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= new Promise<void>((done) => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    // Also covers a listen that completes after a timeout: close() is retried from the listen callback.
    if (!server.listening) return done();
    server.close(() => done());
  }));
  server.on("connection", (socket) => {
    if (closing) return void socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    try { connection(socket); } catch { socket.destroy(); }
  });
  return new Promise<ListenResult>((resolve) => {
    let settled = false;
    const settle = (result: ListenResult) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      resolve(result);
      return true;
    };
    const timer = setTimeout(() => {
      void close();
      settle({ ok: false, code: "bind-failed" });
    }, LISTEN_TIMEOUT_MS);
    server.once("error", (error: NodeJS.ErrnoException) => {
      void close();
      settle({ ok: false, code: failure(error.code) });
    });
    server.listen({ host: address, port, ipv6Only: address === "::1" }, () => {
      // Too late (timed out) or already closing: never leave the server bound.
      if (settled || closing) {
        server.close();
        return;
      }
      server.removeAllListeners("error");
      server.on("error", () => {
        void close();
        try { failed?.(); } catch { /* reported by the closed listener */ }
      });
      const bound = server.address();
      if (!bound || typeof bound === "string") {
        void close();
        return void settle({ ok: false, code: "bind-failed" });
      }
      settle({
        ok: true,
        listener: {
          address,
          port: bound.port,
          get connections() { return sockets.size; },
          close,
        },
      });
    });
  });
};
