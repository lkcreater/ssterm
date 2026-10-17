import type { Duplex } from "node:stream";

/** RFC 1928 reply codes used by the dynamic tunnel. */
export const SOCKS_REPLY = { succeeded: 0, failure: 1, notAllowed: 2, hostUnreachable: 4, refused: 5, commandNotSupported: 7, addressNotSupported: 8 } as const;
export const SOCKS_HANDSHAKE_MS = 10_000;
const MAX_HEADER = 600;

export type SocksRequest = { ok: true; host: string; port: number; reply(code: number): void } | { ok: false };

/**
 * Server side of a SOCKS5 handshake on a loopback socket: no authentication (method 0) and CONNECT only; BIND and
 * UDP ASSOCIATE are refused. Domain names are passed to the SSH server unresolved (socks5h behaviour), so this Mac
 * performs no DNS lookup. Bytes the client sends after its request stay in the socket for the forwarded stream.
 */
export function socksHandshake(socket: Duplex, timeoutMs = SOCKS_HANDSHAKE_MS): Promise<SocksRequest> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "request" = "greeting";
    let settled = false;
    const finish = (result: SocksRequest) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.pause();
      resolve(result);
    };
    const refuse = (bytes?: number[]) => {
      if (bytes) socket.write(Buffer.from(bytes));
      socket.end();
      finish({ ok: false });
    };
    const reply = (code: number) => socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
    const onClose = () => finish({ ok: false });
    const timer = setTimeout(() => refuse(), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
      // Only an incomplete header is bounded; bytes after a complete request are the client's early data.
      if (!settled && buffer.length > MAX_HEADER) refuse();
    };
    const parse = (): void => {
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5) return refuse();
        const count = buffer[1]!;
        if (buffer.length < 2 + count) return;
        const methods = buffer.subarray(2, 2 + count);
        buffer = buffer.subarray(2 + count);
        if (!methods.includes(0)) return refuse([5, 0xff]);
        socket.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (buffer.length < 4) return;
      if (buffer[0] !== 5) return refuse();
      if (buffer[1] !== 1) return refuse([5, SOCKS_REPLY.commandNotSupported, 0, 1, 0, 0, 0, 0, 0, 0]);
      const type = buffer[3];
      let host: string;
      let end: number;
      if (type === 1) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(4, 8)].join(".");
        end = 8;
      } else if (type === 3) {
        if (buffer.length < 5) return;
        const length = buffer[4]!;
        if (buffer.length < 5 + length + 2) return;
        host = buffer.subarray(5, 5 + length).toString("latin1");
        end = 5 + length;
        // Printable ASCII host names only; anything else is not forwarded.
        if (!length || !/^[\x21-\x7e]+$/u.test(host)) return refuse([5, SOCKS_REPLY.addressNotSupported, 0, 1, 0, 0, 0, 0, 0, 0]);
      } else if (type === 4) {
        if (buffer.length < 22) return;
        const parts: string[] = [];
        for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(4 + i).toString(16));
        host = parts.join(":");
        end = 20;
      } else return refuse([5, SOCKS_REPLY.addressNotSupported, 0, 1, 0, 0, 0, 0, 0, 0]);
      const port = buffer.readUInt16BE(end);
      if (port === 0) return refuse([5, SOCKS_REPLY.notAllowed, 0, 1, 0, 0, 0, 0, 0, 0]);
      const rest = buffer.subarray(end + 2);
      // Detach (and pause) before unshift: on a flowing socket unshift re-emits `data` synchronously.
      finish({ ok: true, host, port, reply });
      if (rest.length) socket.unshift(rest);
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.resume();
  });
}
