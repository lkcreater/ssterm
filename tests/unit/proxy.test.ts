import { strict as assert } from "node:assert";
import { createServer, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { connectThroughProxy } from "../../packages/adapters/src/proxy.ts";

async function proxy(t: TestContext, onConnect: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    onConnect(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as { port: number };
  return (type: "http" | "socks5", host = "target.internal") => connectThroughProxy({
    type, host: "127.0.0.1", port, target: { host, port: 22 }, signal: new AbortController().signal,
  });
}

test("HTTP CONNECT rejects an oversized complete header and retains coalesced SSH bytes after a bounded header", async (t) => {
  const oversized = await proxy(t, (socket) => socket.once("data", () => {
    socket.write(`HTTP/1.1 200 OK\r\nX-Padding: ${"x".repeat(8192)}\r\n\r\nSSH-2.0-fixture\r\n`);
  }));
  assert.deepEqual(await oversized("http"), { ok: false, code: "proxy-failed" });

  const banner = Buffer.from("SSH-2.0-fixture\r\n");
  const good = await proxy(t, (socket) => socket.once("data", () => {
    socket.write("HTTP/1.1 200 Connection");
    setImmediate(() => socket.write(Buffer.concat([Buffer.from(" Established\r\n\r\n"), banner])));
  }));
  const opened = await good("http");
  assert(opened.ok);
  t.after(() => opened.socket.destroy());
  assert.deepEqual(opened.socket.read(banner.length), banner, "the SSH banner survives the proxy handshake");
});

test("SOCKS5 rejects nonzero reserved bytes and empty reply domain names", async (t) => {
  for (const reply of [[5, 0, 1, 1, 0, 0, 0, 0, 0, 0], [5, 0, 0, 3, 0, 0, 0]]) {
    const open = await proxy(t, (socket) => {
      socket.once("data", () => {
        socket.write(Buffer.from([5, 0]));
        socket.once("data", () => socket.write(Buffer.from(reply)));
      });
    });
    assert.deepEqual(await open("socks5"), { ok: false, code: "proxy-failed" });
  }
});

test("SOCKS5 canonicalizes IPv4-embedded IPv6 before encoding the 16-byte address", async (t) => {
  let request: Buffer | undefined;
  const open = await proxy(t, (socket) => {
    socket.once("data", () => {
      socket.write(Buffer.from([5, 0]));
      socket.once("data", (bytes) => {
        request = bytes;
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      });
    });
  });
  const opened = await open("socks5", "::ffff:192.0.2.1");
  assert(opened.ok);
  t.after(() => opened.socket.destroy());
  assert.equal(request?.toString("hex"), "0501000400000000000000000000ffffc00002010016");
  assert.deepEqual(await open("http", "target\r\nInjected: yes"), { ok: false, code: "proxy-failed" });
});
