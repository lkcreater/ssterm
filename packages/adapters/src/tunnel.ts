import type { Duplex } from "node:stream";
import type { TunnelChannel, TunnelForward } from "@ssterm/domain";

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
}

/**
 * Wraps one authenticated ssh2 client as a TunnelChannel. Every stream it opened is destroyed on dispose and on
 * transport loss (`lost`), and a late open reply after either is destroyed on arrival.
 */
export function createTunnelChannel(client: ForwardingClient, drained: Promise<void>): TunnelChannel & { lost(): void } {
  const streams = new Set<Duplex>();
  let opening = 0;
  let closed = false;
  const destroyAll = () => {
    closed = true;
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
    lost: destroyAll,
    dispose: destroyAll,
  };
}
