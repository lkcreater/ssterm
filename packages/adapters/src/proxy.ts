import { connect, isIP, type Socket } from "node:net";
import { normalizeEndpoint } from "@ssterm/domain";

/** SST-030: how long the proxy may take to connect and answer the CONNECT request. */
export const PROXY_HANDSHAKE_MS = 15_000;
const MAX_REPLY = 8_192;

export type ProxyResult = { ok: true; socket: Socket } | { ok: false; code: "proxy-failed" | "dns" | "timeout" | "cancelled" };

/**
 * Opens a byte stream to `target` through an HTTP CONNECT or SOCKS5 proxy (no proxy authentication). SOCKS5 sends
 * names unresolved (the proxy resolves them); IP literals go as IPv4/IPv6. Bytes the server sends right after the
 * proxy's reply (e.g. the SSH banner) are kept in the socket. Proxy reply text is never surfaced.
 */
export function connectThroughProxy(options: {
  type: "http" | "socks5";
  host: string;
  port: number;
  target: { host: string; port: number };
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<ProxyResult> {
  // Canonicalize IP literals (including IPv4-embedded IPv6) before encoding; reject header injection and
  // names that cannot fit SOCKS5's one-byte domain length, even if an internal caller bypassed catalog validation.
  let target: { host: string; port: number };
  try {
    target = { host: normalizeEndpoint(options.target.host), port: options.target.port };
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error("port");
  } catch {
    return Promise.resolve({ ok: false, code: "proxy-failed" });
  }
  return new Promise((resolve) => {
    if (options.signal.aborted) return resolve({ ok: false, code: "cancelled" });
    const socket = connect({ host: options.host, port: options.port });
    let buffer = Buffer.alloc(0);
    let stage = 0;
    let settled = false;
    const finish = (result: ProxyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (!result.ok) socket.destroy();
      else socket.pause();
      resolve(result);
    };
    const abort = () => finish({ ok: false, code: "cancelled" });
    const onError = (error: NodeJS.ErrnoException) =>
      finish({ ok: false, code: error.code === "ENOTFOUND" || error.code === "EAI_AGAIN" ? "dns" : "proxy-failed" });
    const onClose = () => finish({ ok: false, code: "proxy-failed" });
    const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), options.timeoutMs ?? PROXY_HANDSHAKE_MS);
    options.signal.addEventListener("abort", abort, { once: true });
    const done = (consumed: number) => {
      const rest = buffer.subarray(consumed);
      finish({ ok: true, socket });
      // After detaching: on a flowing socket unshift would re-emit `data` synchronously.
      if (rest.length) socket.unshift(rest);
    };
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (options.type === "http") {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return void (buffer.length > MAX_REPLY && finish({ ok: false, code: "proxy-failed" }));
        if (end + 4 > MAX_REPLY) return finish({ ok: false, code: "proxy-failed" });
        const status = /^HTTP\/1\.[01] (\d{3})[ \r]/u.exec(buffer.subarray(0, end + 2).toString("latin1"))?.[1];
        return status === "200" ? done(end + 4) : finish({ ok: false, code: "proxy-failed" });
      }
      if (stage === 0) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) return finish({ ok: false, code: "proxy-failed" });
        buffer = buffer.subarray(2);
        stage = 1;
        const family = isIP(target.host);
        const address = family === 4 ? [1, ...target.host.split(".").map(Number)]
          : family === 6 ? [4, ...ipv6Bytes(target.host)]
            : [3, Buffer.byteLength(target.host), ...Buffer.from(target.host)];
        socket.write(Buffer.from([5, 1, 0, ...address, target.port >> 8, target.port & 0xff]));
      }
      if (buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 0 || buffer[2] !== 0) return finish({ ok: false, code: "proxy-failed" });
      const length = buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : buffer[3] === 3 ? 7 + buffer[4]! : -1;
      if (length < 0 || (buffer[3] === 3 && buffer[4] === 0)) return finish({ ok: false, code: "proxy-failed" });
      if (buffer.length >= length) done(length);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.once("connect", () => {
      if (settled) return;
      if (options.type === "http") {
        const authority = isIP(target.host) === 6 ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      } else socket.write(Buffer.from([5, 1, 0]));
    });
  });
}

function ipv6Bytes(address: string): number[] {
  const [head = "", tail = ""] = address.split("::");
  const part = (text: string) => (text ? text.split(":") : []);
  const left = part(head), right = part(tail);
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}
