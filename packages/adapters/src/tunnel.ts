import type { Duplex } from "node:stream";
import type { RemoteListen, TunnelChannel, TunnelForward } from "@ssterm/domain";

/** Concurrent `direct-tcpip` opens and open forwarded streams per tunnel session. */
export const TUNNEL_MAX_OPENING = 16;
export const TUNNEL_MAX_STREAMS = 64;

interface ForwardingClient {
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, stream: Duplex) => void,
  ): unknown;
  forwardIn?(address: string, port: number, callback: (error: Error | undefined, port: number) => void): unknown;
  unforwardIn?(address: string, port: number, callback?: (error: Error | undefined) => void): unknown;
}
/** What ssh2 reports for a connection to one of our server-side listeners. */
export interface IncomingInfo { destIP: string; destPort: number; srcIP: string; srcPort: number }
/** Server-side listeners a tunnel session may hold. */
export const TUNNEL_MAX_REMOTE_LISTENERS = 4;

/**
 * Wraps one authenticated ssh2 client as a TunnelChannel. Every stream it opened is destroyed on dispose and on
 * transport loss (`lost`), and a late open reply after either is destroyed on arrival.
 */
export function createTunnelChannel(client: ForwardingClient, drained: Promise<void>): TunnelChannel & {
  lost(): void;
  /** Routes ssh2's `tcp connection` event; connections to no listener of ours are rejected. */
  incoming(info: IncomingInfo, accept: () => Duplex, reject: () => void): void;
} {
  const streams = new Set<Duplex>();
  const listeners = new Map<string, { address: string; port: number; requested: number; connection: (stream: Duplex, origin: { address: string; port: number }) => void }>();
  let opening = 0;
  let listening = 0;
  let closed = false;
  const key = (address: string, port: number) => `${address}\u0000${port}`;
  const destroyAll = () => {
    closed = true;
    for (const { address, port } of listeners.values()) {
      try { client.unforwardIn?.(address, port, () => undefined); } catch { /* the transport may already be gone */ }
    }
    listeners.clear();
    for (const stream of [...streams]) stream.destroy();
    streams.clear();
  };
  return {
    drained,
    forward(origin, destination): Promise<TunnelForward> {
      if (closed) return Promise.resolve({ ok: false, code: "closed" });
      if (opening >= TUNNEL_MAX_OPENING || streams.size + opening >= TUNNEL_MAX_STREAMS)
        return Promise.resolve({ ok: false, code: "resource-limit" });
      opening += 1;
      return new Promise<TunnelForward>((resolve) => {
        let settled = false;
        const settle = (value: TunnelForward) => {
          if (settled) return;
          settled = true;
          opening -= 1;
          resolve(value);
        };
        try {
          // An unknown peer address is reported as the unspecified address; it is informational for the server.
          client.forwardOut(origin.address || "0.0.0.0", origin.port > 0 ? origin.port : 0, destination.host, destination.port, (error, stream) => {
            if (error || !stream) return settle({ ok: false, code: closed ? "closed" : "refused" });
            if (closed) {
              stream.destroy();
              return settle({ ok: false, code: "closed" });
            }
            streams.add(stream);
            stream.once("close", () => streams.delete(stream));
            // A stream error is reported by its close; without a listener it would be an uncaught exception.
            stream.on("error", () => stream.destroy());
            settle({ ok: true, stream });
          });
        } catch {
          settle({ ok: false, code: closed ? "closed" : "refused" });
        }
      });
    },
    listen(address, port, connection): Promise<RemoteListen> {
      if (closed || !client.forwardIn) return Promise.resolve({ ok: false, code: "closed" });
      // Pending requests count too, so concurrent starts cannot exceed the cap.
      if (listeners.size + listening >= TUNNEL_MAX_REMOTE_LISTENERS) return Promise.resolve({ ok: false, code: "resource-limit" });
      listening += 1;
      return new Promise<RemoteListen>((resolve) => {
        let settled = false;
        const settle = (value: RemoteListen) => {
          if (settled) return;
          settled = true;
          listening -= 1;
          resolve(value);
        };
        try {
          client.forwardIn!(address, port, (error, assigned) => {
            if (error) return settle({ ok: false, code: closed ? "closed" : "refused" });
            const bound = port === 0 ? assigned : port;
            // A confirmation without a usable port is treated as a refusal (nothing to route or show).
            if (!Number.isInteger(bound) || bound < 1 || bound > 65_535) return settle({ ok: false, code: closed ? "closed" : "refused" });
            if (closed) {
              try { client.unforwardIn?.(address, bound, () => undefined); } catch { /* closing */ }
              return settle({ ok: false, code: "closed" });
            }
            listeners.set(key(address, bound), { address, port: bound, requested: port, connection });
            settle({ ok: true, port: bound });
          });
        } catch {
          // A synchronous throw means the transport is unusable ("Not connected"), not a server refusal.
          settle({ ok: false, code: "closed" });
        }
      });
    },
    incoming(info, accept, reject) {
      // Servers report the address as requested (or normalised, e.g. GatewayPorts no) and, for an assigned port,
      // either the assigned or the requested 0: exact match first, else the single listener on that port.
      const candidates = [...listeners.values()].filter((row) => row.port === info.destPort || (row.requested === 0 && info.destPort === 0));
      const listener = listeners.get(key(info.destIP, info.destPort)) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (closed || !listener || streams.size + opening >= TUNNEL_MAX_STREAMS) {
        try { reject(); } catch { /* already gone */ }
        return;
      }
      let stream: Duplex;
      try { stream = accept(); } catch { return; }
      streams.add(stream);
      stream.once("close", () => streams.delete(stream));
      stream.on("error", () => stream.destroy());
      try { listener.connection(stream, { address: info.srcIP, port: info.srcPort }); } catch { stream.destroy(); }
    },
    lost: destroyAll,
    dispose: destroyAll,
  };
}
