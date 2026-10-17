import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { connect, createServer, Socket, type Server } from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { listenLocal } from "../../packages/adapters/src/local-listener.ts";
import { createTunnelChannel, TUNNEL_MAX_OPENING, TUNNEL_MAX_REMOTE_LISTENERS } from "../../packages/adapters/src/tunnel.ts";
import { socksHandshake } from "../../packages/services/src/socks5.ts";
import { TunnelService, TUNNEL_MAX_CONNECTIONS, type TunnelSnapshot } from "../../packages/services/src/tunnels.ts";
import type { SessionSnapshot } from "../../packages/services/src/sessions.ts";
import type { TunnelForward, TunnelRule } from "../../packages/domain/src/index.ts";

const until = async (check: () => boolean | Promise<boolean>, label: string, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail(`timed out: ${label}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};
const listening = (port: number, host = "127.0.0.1") => new Promise<boolean>((done) => {
  const socket = connect({ host, port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
});
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
/** An owned echo server standing in for the destination the SSH server would open. */
async function echoServer(t: TestContext) {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }));
  return { port: (server.address() as { port: number }).port, sockets };
}
async function roundTrip(port: number, text: string, host = "127.0.0.1"): Promise<string> {
  const socket = connect({ host, port });
  return new Promise<string>((done) => {
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.length >= text.length) { socket.destroy(); done(received); }
    });
    socket.on("error", () => done(received));
    socket.on("close", () => done(received));
    socket.write(text);
  });
}

test("listener: exclusive loopback bind, typed collision, close destroys accepted sockets and frees the port", async () => {
  const port = await freePort();
  const accepted: Socket[] = [];
  const first = await listenLocal({ address: "127.0.0.1", port, connection: (socket) => accepted.push(socket) });
  assert.ok(first.ok);
  assert.equal(first.listener.port, port);
  assert.deepEqual(await listenLocal({ address: "127.0.0.1", port, connection() {} }), { ok: false, code: "address-in-use" });
  assert.deepEqual(await listenLocal({ address: "0.0.0.0" as "127.0.0.1", port, connection() {} }), { ok: false, code: "bind-failed" });
  const client = connect({ host: "127.0.0.1", port });
  const clientClosed = new Promise<void>((done) => client.once("close", () => done()));
  client.on("error", () => undefined);
  await until(() => accepted.length === 1, "accepted");
  assert.equal(first.listener.connections, 1);
  await Promise.all([first.listener.close(), first.listener.close()]);
  await clientClosed;
  assert.equal(await listening(port), false);
  const again = await listenLocal({ address: "127.0.0.1", port, connection() {} });
  assert.ok(again.ok, "the port is free again");
  await again.listener.close();
});

test("tunnel channel: bounded opens, refused opens carry no server text, dispose destroys streams and late replies", async () => {
  const pending: ((error: Error | undefined, stream: Duplex) => void)[] = [];
  const client = { forwardOut: (...args: unknown[]) => { pending.push(args[4] as never); } };
  const channel = createTunnelChannel(client, Promise.resolve());
  const opens = Array.from({ length: TUNNEL_MAX_OPENING }, () => channel.forward({ address: "127.0.0.1", port: 1 }, { host: "127.0.0.1", port: 8080 }));
  assert.deepEqual(await channel.forward({ address: "", port: 0 }, { host: "x", port: 1 }), { ok: false, code: "resource-limit" });
  const stream = new PassThrough();
  pending[0]!(undefined, stream);
  pending[1]!(new Error("administratively prohibited: open failed"), undefined as never);
  assert.equal((await opens[0]!).ok, true);
  assert.deepEqual(await opens[1], { ok: false, code: "refused" });
  channel.dispose();
  assert.equal(stream.destroyed, true);
  const late = new PassThrough();
  pending[2]!(undefined, late);
  assert.deepEqual(await opens[2], { ok: false, code: "closed" });
  assert.equal(late.destroyed, true, "a reply after dispose is destroyed");
  assert.deepEqual(await channel.forward({ address: "", port: 0 }, { host: "x", port: 1 }), { ok: false, code: "closed" });
});

/** A registry stand-in: sessions become Ready on demand; forward() dials the destination directly. */
function harness(t: TestContext, destinationPort: number, options: { dial?: (host: string, port: number) => Socket } = {}) {
  const ownerId = "window:1:1";
  const hostId = randomUUID();
  const rules: TunnelRule[] = [];
  const observers = new Set<(snapshot: SessionSnapshot) => void>();
  const sessions = new Map<string, { generation: number; state: SessionSnapshot["state"]; error?: string }>();
  const forwards: TunnelForward[] = [];
  let refuse = false;
  let refuseListen = false;
  /** Stand-ins for the server's remote listeners: a loopback server whose connections arrive as forwarded streams. */
  const remoteListeners = new Map<string, Server[]>();
  const listens: { address: string; port: number }[] = [];
  const snapshotOf = (id: string): SessionSnapshot => {
    const row = sessions.get(id)!;
    return { id, kind: "tunnel", generation: row.generation, hostId, state: row.state, cleanup: "none",
      ...(row.error ? { error: { code: row.error as never, message: "" } } : {}) };
  };
  const set = (id: string, state: SessionSnapshot["state"], error?: string) => {
    sessions.set(id, { ...sessions.get(id)!, state, error });
    for (const observer of [...observers]) observer(snapshotOf(id));
  };
  const registry = {
    locked: false,
    connect(_owner: string, _host: string, kind: string) {
      if (registry.locked) return { ok: false, error: { code: "locked", message: "" } } as const;
      assert.equal(kind, "tunnel");
      const id = randomUUID();
      sessions.set(id, { generation: 1, state: "Connecting" });
      return { ok: true, value: snapshotOf(id) } as const;
    },
    async close(_owner: string, id: string) {
      for (const server of remoteListeners.get(id) ?? []) server.close();
      remoteListeners.delete(id);
      if (sessions.has(id)) set(id, "Closed");
      return { ok: true, value: undefined } as const;
    },
    settled: async () => {},
    forget(_owner: string, id: string) { sessions.delete(id); return { ok: true, value: undefined } as const; },
    snapshot: () => [],
    subscribe(_owner: string, callback: (snapshot: SessionSnapshot) => void) { observers.add(callback); return () => observers.delete(callback); },
    tunnel(_owner: string, id: string, generation: number) {
      const row = sessions.get(id);
      if (!row || row.generation !== generation || row.state !== "Ready") return undefined;
      return {
        listen: async (address: string, port: number, connection: (stream: Duplex, origin: { address: string; port: number }) => void) => {
          listens.push({ address, port });
          if (refuseListen) return { ok: false as const, code: "refused" as const };
          const server = createServer((socket) => connection(socket, { address: "127.0.0.1", port: 1 }));
          await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
          remoteListeners.set(id, [...(remoteListeners.get(id) ?? []), server]);
          return { ok: true as const, port: (server.address() as { port: number }).port };
        },
        forward: async (_origin: unknown, destination: { host: string; port: number }): Promise<TunnelForward> => {
          if (refuse) return { ok: false, code: "refused" };
          const stream = connect({ host: destination.host, port: destination.port });
          await new Promise((done) => stream.once("connect", done));
          const result = { ok: true as const, stream };
          forwards.push(result);
          return result;
        },
      };
    },
  };
  const service = new TunnelService({
    registry: registry as never,
    repository: { snapshot: () => ({ ok: true, value: { tunnelRules: rules } }) as never },
    listen: listenLocal as never,
    ...(options.dial ? { dial: options.dial, dialTimeoutMs: 100 } : {}),
  });
  t.after(() => service.dispose());
  const events: TunnelSnapshot[] = [];
  service.subscribe(ownerId, (snapshot) => events.push(snapshot));
  const rule = (bindPort: number, overrides: Partial<TunnelRule> = {}) => {
    const value = { id: randomUUID(), vaultId: randomUUID(), revision: 1, createdAt: "", updatedAt: "", label: "r", hostId, type: "local",
      bindAddress: "127.0.0.1", bindPort, destinationHost: "127.0.0.1", destinationPort, ...overrides } as TunnelRule;
    rules.push(value);
    return value;
  };
  const ready = (id: string) => set(id, "Ready");
  const sessionOf = () => [...sessions.keys()].at(-1)!;
  return {
    ownerId, service, registry, sessions, events, rule, ready, set, sessionOf, forwards, listens, remoteListeners,
    refuse: (value: boolean) => { refuse = value; }, refuseListen: (value: boolean) => { refuseListen = value; },
  };
}

test("service: bind first, running only after Ready, bytes round-trip, stop closes listener, sockets and session", async (t) => {
  const echo = await echoServer(t);
  const h = harness(t, echo.port);
  const rule = h.rule(await freePort());
  assert.equal(await listening(rule.bindPort), false, "a saved rule never listens by itself");
  const started = await h.service.start(h.ownerId, rule.id);
  assert.ok(started.ok);
  assert.equal(started.value.state, "starting");
  assert.equal(await listening(rule.bindPort), true, "bound while starting");
  // Before Ready, a local connection is closed and counted.
  assert.equal(await roundTrip(rule.bindPort, "early"), "");
  // Both the probe above and this connection arrived before Ready.
  await until(() => h.service.snapshot(h.ownerId)[0]!.failedConnections === 2, "early refusals counted");
  assert.deepEqual(await h.service.start(h.ownerId, rule.id), { ok: false, code: "already-active" });
  h.ready(h.sessionOf());
  assert.equal(h.service.snapshot(h.ownerId)[0]!.state, "running");
  assert.equal(await roundTrip(rule.bindPort, "สวัสดี tunnel"), "สวัสดี tunnel");
  // Hold one connection open across stop.
  const held = connect({ host: "127.0.0.1", port: rule.bindPort });
  held.on("error", () => undefined);
  const heldClosed = new Promise<void>((done) => held.once("close", () => done()));
  held.write("x");
  await until(() => h.service.snapshot(h.ownerId)[0]?.activeConnections === 1, "held connection active");
  assert.equal(h.service.active(rule.id), true);
  const session = h.sessionOf();
  assert.deepEqual(await h.service.stop(h.ownerId, rule.id), { ok: true, value: undefined });
  await heldClosed;
  assert.equal(await listening(rule.bindPort), false, "no listener after stop");
  assert.equal(h.sessions.has(session), false, "the session was closed and forgotten");
  await until(() => echo.sockets.size === 0, "forwarded streams closed");
  assert.deepEqual(h.service.snapshot(h.ownerId), []);
  assert.equal(h.service.active(rule.id), false);
  assert.deepEqual([...new Set(h.events.map((event) => event.state))], ["starting", "running", "stopping", "stopped"]);
});

test("service: collision fails before any session; refused destinations close the local socket; session failure and lock tear down", async (t) => {
  const echo = await echoServer(t);
  const h = harness(t, echo.port);
  const port = await freePort();
  const blocker = await listenLocal({ address: "127.0.0.1", port, connection() {} });
  assert.ok(blocker.ok);
  const collided = h.rule(port);
  assert.deepEqual(await h.service.start(h.ownerId, collided.id), { ok: false, code: "address-in-use" });
  assert.equal(h.sessions.size, 0, "no SSH session for a failed bind");
  assert.equal(h.service.snapshot(h.ownerId)[0]!.state, "failed");
  await blocker.listener.close();
  assert.deepEqual(await h.service.start(h.ownerId, randomUUID()), { ok: false, code: "rule-not-found" });

  // A failed tunnel may be started again.
  const started = await h.service.start(h.ownerId, collided.id);
  assert.ok(started.ok);
  h.ready(h.sessionOf());
  h.refuse(true);
  assert.equal(await roundTrip(port, "nope"), "");
  await until(() => h.service.snapshot(h.ownerId)[0]!.failedConnections === 1, "refused destination counted");
  assert.equal(h.service.snapshot(h.ownerId)[0]!.state, "running", "one refused destination does not stop the tunnel");
  h.refuse(false);

  // Transport loss (or lock, which fails the session as `locked`): listener and sockets close; state failed with the code.
  const held = connect({ host: "127.0.0.1", port });
  held.on("error", () => undefined);
  const heldClosed = new Promise<void>((done) => held.once("close", () => done()));
  await until(() => h.service.snapshot(h.ownerId)[0]?.activeConnections === 1, "held");
  h.set(h.sessionOf(), "Failed", "locked");
  await heldClosed;
  await until(async () => !(await listening(port)), "listener closed after failure");
  const failed = h.service.snapshot(h.ownerId)[0]!;
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "locked");
  // Lock refuses a new start; no listener is left behind.
  h.registry.locked = true;
  assert.deepEqual(await h.service.start(h.ownerId, collided.id), { ok: false, code: "locked" });
  assert.equal(await listening(port), false, "a refused start released its listener");
});

test("service: connection cap, owner revocation and dispose close everything", async (t) => {
  const echo = await echoServer(t);
  const h = harness(t, echo.port);
  const a = h.rule(await freePort());
  const b = h.rule(await freePort(), { bindAddress: "::1" });
  assert.ok((await h.service.start(h.ownerId, a.id)).ok);
  h.ready(h.sessionOf());
  const bStart = await h.service.start(h.ownerId, b.id);
  if (bStart.ok) {
    h.ready(h.sessionOf());
    assert.equal(await roundTrip(b.bindPort, "v6", "::1"), "v6");
  } else assert.equal(bStart.code, "address-unavailable", "::1 may be unavailable on this host");
  const sockets: Socket[] = [];
  for (let i = 0; i < TUNNEL_MAX_CONNECTIONS + 1; i++) {
    const socket = connect({ host: "127.0.0.1", port: a.bindPort });
    socket.on("error", () => undefined);
    sockets.push(socket);
  }
  await until(() => {
    const row = h.service.snapshot(h.ownerId).find((s) => s.ruleId === a.id)!;
    return row.activeConnections === TUNNEL_MAX_CONNECTIONS && row.failedConnections >= 1;
  }, "cap enforced", 5_000);
  await h.service.closeOwner(h.ownerId);
  assert.equal(await listening(a.bindPort), false);
  assert.equal(h.sessions.size, 0);
  await until(() => sockets.every((socket) => socket.destroyed || socket.closed), "local sockets closed");
  // A revoked owner (a closed window generation) never starts again; a new generation does.
  assert.deepEqual(await h.service.start(h.ownerId, a.id), { ok: false, code: "invalid-state" });
  assert.ok((await h.service.start("window:1:2", a.id)).ok);
  await h.service.dispose();
  assert.equal(await listening(a.bindPort), false, "dispose (quit) leaves no listener");
  assert.deepEqual(await h.service.start(h.ownerId, a.id), { ok: false, code: "disposed" });
});

test("listener: a wildcard listener already serving the port is reported in use (macOS would let the loopback bind shadow it)", async () => {
  const wildcard = createServer((socket) => socket.destroy());
  await new Promise<void>((done) => wildcard.listen(0, "0.0.0.0", done));
  const { port } = wildcard.address() as { port: number };
  try {
    assert.deepEqual(await listenLocal({ address: "127.0.0.1", port, connection() {} }), { ok: false, code: "address-in-use" });
  } finally {
    await new Promise<void>((done) => wildcard.close(() => done()));
  }
});

test("listener: half-close keeps the reply path open", async (t) => {
  const port = await freePort();
  const result = await listenLocal({ address: "127.0.0.1", port, connection(socket) {
    let received = "";
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("end", () => socket.end(`reply:${received}`));
  } });
  assert.ok(result.ok);
  t.after(() => result.listener.close());
  const client = connect({ host: "127.0.0.1", port });
  const reply = await new Promise<string>((done) => {
    let text = "";
    client.on("data", (chunk) => { text += chunk; });
    client.on("close", () => done(text));
    client.end("request");
  });
  assert.equal(reply, "reply:request");
});

test("service: stop during the bind leaves nothing bound; a restart after failure never receives the old teardown's event", async (t) => {
  const echo = await echoServer(t);
  const h = harness(t, echo.port);
  const rule = h.rule(await freePort());
  const starting = h.service.start(h.ownerId, rule.id);
  const stopped = h.service.stop(h.ownerId, rule.id);
  assert.equal((await starting).ok, false);
  assert.deepEqual(await stopped, { ok: true, value: undefined });
  assert.equal(await listening(rule.bindPort), false, "the late listener was closed");
  assert.equal(h.sessions.size, 0, "no session was opened");
  assert.deepEqual(h.service.snapshot(h.ownerId), []);

  assert.ok((await h.service.start(h.ownerId, rule.id)).ok);
  h.ready(h.sessionOf());
  h.set(h.sessionOf(), "Failed", "network");
  // Restart immediately: start waits for the old teardown, then binds the same port.
  const restarted = await h.service.start(h.ownerId, rule.id);
  assert.ok(restarted.ok, JSON.stringify(restarted));
  h.ready(h.sessionOf());
  await new Promise((done) => setTimeout(done, 50));
  const states = h.events.filter((event) => event.ruleId === rule.id).map((event) => event.state);
  assert.equal(states.at(-1), "running", `no stale failed after the restart: ${states.join(",")}`);
  assert.equal(await roundTrip(rule.bindPort, "again"), "again");
});

test("service: a start waiting on an old teardown opens nothing for an owner revoked meanwhile", async (t) => {
  const echo = await echoServer(t);
  const h = harness(t, echo.port);
  const rule = h.rule(await freePort());
  assert.ok((await h.service.start(h.ownerId, rule.id)).ok);
  h.ready(h.sessionOf());
  // Hold the old session's settle so its teardown is still draining when Start is pressed again.
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  h.registry.settled = () => gate;
  h.set(h.sessionOf(), "Failed", "network");
  const restart = h.service.start(h.ownerId, rule.id);
  const closing = h.service.closeOwner(h.ownerId);
  release();
  await closing;
  assert.equal((await restart).ok, false);
  assert.equal(await listening(rule.bindPort), false, "no orphaned listener");
  assert.equal(h.sessions.size, 0, "no orphaned session");
  assert.deepEqual(h.service.snapshot(h.ownerId), []);
  assert.equal(h.service.active(rule.id), false);
});

/** A SOCKS5 client: greeting, CONNECT (with early payload in the same write), then the reply and echoed bytes. */
async function socksRoundTrip(port: number, request: number[], payload: string): Promise<{ reply: number[]; echoed: string }> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.on("error", () => undefined);
  let buffer = Buffer.alloc(0);
  return new Promise((done) => {
    let stage = 0;
    const finish = () => { socket.destroy(); done({ reply: [...buffer.subarray(2, 12)].slice(0, 2), echoed: buffer.subarray(12).toString() }); };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) {
        stage = 1;
        socket.write(Buffer.concat([Buffer.from(request), Buffer.from(payload)]));
      }
      if (buffer.length >= 12 && (buffer[3] !== 0 || buffer.length >= 12 + Buffer.byteLength(payload))) finish();
    });
    socket.on("close", finish);
    socket.write(Buffer.from([5, 1, 0]));
  });
}
const connectRequest = (host: number[], port: number, type = 1) => [5, 1, 0, type, ...host, port >> 8, port & 0xff];

test("socks5: no-auth CONNECT for IPv4, domain and IPv6; early bytes stay; other methods, commands and garbage are refused", async () => {
  const pair = async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const accepted = new Promise<Socket>((done) => server.once("connection", done));
    const client = connect({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
    client.on("error", () => undefined);
    const socket = await accepted;
    server.close();
    return { client, socket };
  };
  const read = (socket: Socket, length: number) => new Promise<number[]>((done) => {
    let buffer = Buffer.alloc(0);
    const on = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); if (buffer.length >= length) { socket.off("data", on); done([...buffer]); } };
    socket.on("data", on);
  });
  {
    const { client, socket } = await pair();
    const handshake = socksHandshake(socket);
    client.write(Buffer.from([5, 2, 2, 0]));
    assert.deepEqual(await read(client, 2), [5, 0]);
    const name = [...Buffer.from("db.internal")];
    client.write(Buffer.from([...connectRequest([name.length, ...name], 5432, 3), ...Buffer.from("early")]));
    const request = await handshake;
    assert.ok(request.ok, JSON.stringify(request));
    assert.deepEqual([request.host, request.port], ["db.internal", 5432], "names go to the server unresolved");
    const rest = await new Promise<string>((done) => { socket.once("data", (chunk) => done(chunk.toString())); socket.resume(); });
    assert.equal(rest, "early");
    request.reply(0);
    assert.deepEqual((await read(client, 10)).slice(0, 2), [5, 0]);
    client.destroy(); socket.destroy();
  }
  {
    const { client, socket } = await pair();
    const handshake = socksHandshake(socket);
    client.write(Buffer.from([5, 1, 0, ...connectRequest([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 443, 4)]));
    const request = await handshake;
    assert.ok(request.ok);
    assert.equal(request.host, "2001:db8:0:0:0:0:0:1");
    client.destroy(); socket.destroy();
  }
  for (const [bytes, expected] of [
    [[5, 1, 2], [5, 0xff]], // username/password only
    [[5, 1, 0, 5, 2, 0, 1, 127, 0, 0, 1, 0, 80], [5, 0, 5, 7]], // BIND
    [[5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 0], [5, 0, 5, 2]], // port 0
    [[5, 1, 0, 5, 1, 0, 9], [5, 0, 5, 8]], // unknown address type
    [[4, 1, 0, 80, 127, 0, 0, 1, 0], []], // SOCKS4
  ] as const) {
    const { client, socket } = await pair();
    const handshake = socksHandshake(socket);
    const received: number[] = [];
    client.on("data", (chunk) => received.push(...chunk));
    const closed = new Promise<void>((done) => client.once("close", () => done()));
    client.write(Buffer.from(bytes));
    assert.deepEqual(await handshake, { ok: false });
    client.end();
    await closed;
    assert.deepEqual(received.slice(0, expected.length), [...expected], JSON.stringify(bytes));
    socket.destroy();
  }
  {
    const { client, socket } = await pair();
    const started = Date.now();
    assert.deepEqual(await socksHandshake(socket, 50), { ok: false }, "a silent client times out");
    assert.ok(Date.now() - started < 1_000);
    client.write(Buffer.alloc(0));
    client.destroy();
  }
});

test("service (dynamic): SOCKS5 on loopback forwards each request through the session; refusals reply and count", async (t) => {
  const echo = await echoServer(t);
  const h = harness(t, echo.port);
  const rule = h.rule(await freePort(), { type: "dynamic", destinationHost: null, destinationPort: null });
  assert.ok((await h.service.start(h.ownerId, rule.id)).ok);
  h.ready(h.sessionOf());
  assert.equal(h.service.snapshot(h.ownerId)[0]!.state, "running");
  assert.deepEqual(await socksRoundTrip(rule.bindPort, connectRequest([127, 0, 0, 1], echo.port), "ผ่าน socks"), { reply: [5, 0], echoed: "ผ่าน socks" });
  const name = [...Buffer.from("localhost")];
  assert.equal((await socksRoundTrip(rule.bindPort, connectRequest([name.length, ...name], echo.port, 3), "by name")).echoed, "by name");
  h.refuse(true);
  assert.deepEqual((await socksRoundTrip(rule.bindPort, connectRequest([127, 0, 0, 1], echo.port), "x")).reply, [5, 5]);
  await until(() => h.service.snapshot(h.ownerId)[0]!.failedConnections === 1, "refusal counted");
  assert.equal(h.service.snapshot(h.ownerId)[0]!.totalConnections, 3);
  await h.service.stop(h.ownerId, rule.id);
  assert.equal(await listening(rule.bindPort), false);
});

test("service (remote): no local listener; running once the server listens (assigned port reported); connections reach the destination from this Mac", async (t) => {
  const echo = await echoServer(t);
  const h = harness(t, echo.port);
  const rule = h.rule(0, { type: "remote", bindAddress: "0.0.0.0" });
  const started = await h.service.start(h.ownerId, rule.id);
  assert.ok(started.ok);
  assert.equal(h.listens.length, 0, "nothing asked of the server before Ready");
  h.ready(h.sessionOf());
  await until(() => h.service.snapshot(h.ownerId)[0]?.state === "running", "running");
  assert.deepEqual(h.listens, [{ address: "0.0.0.0", port: 0 }]);
  const assigned = h.service.snapshot(h.ownerId)[0]!.remotePort!;
  assert.ok(assigned > 0);
  assert.equal(await roundTrip(assigned, "กลับมา remote"), "กลับมา remote");
  const held = connect({ host: "127.0.0.1", port: assigned });
  held.on("error", () => undefined);
  const heldClosed = new Promise<void>((done) => held.once("close", () => done()));
  held.write("x");
  await until(() => h.service.snapshot(h.ownerId)[0]?.activeConnections === 1, "held");
  const session = h.sessionOf();
  await h.service.stop(h.ownerId, rule.id);
  await heldClosed;
  assert.equal(h.sessions.has(session), false);
  await until(() => echo.sockets.size === 0, "destination sockets closed");
  // An unreachable destination on this Mac closes the forwarded stream and is counted.
  const dead = h.rule(0, { type: "remote", destinationPort: await freePort() });
  assert.ok((await h.service.start(h.ownerId, dead.id)).ok);
  h.ready(h.sessionOf());
  await until(() => h.service.snapshot(h.ownerId).find((row) => row.ruleId === dead.id)?.state === "running", "dead running");
  assert.equal(await roundTrip(h.service.snapshot(h.ownerId).find((row) => row.ruleId === dead.id)!.remotePort!, "x"), "");
  await until(() => h.service.snapshot(h.ownerId).find((row) => row.ruleId === dead.id)?.failedConnections === 1, "dial failure counted");
  // The server refusing the listener fails the tunnel with a fixed code and closes the session.
  h.refuseListen(true);
  const refused = h.rule(2222, { type: "remote" });
  assert.ok((await h.service.start(h.ownerId, refused.id)).ok);
  const refusedSession = h.sessionOf();
  h.ready(refusedSession);
  await until(() => h.service.snapshot(h.ownerId).find((row) => row.ruleId === refused.id)?.state === "failed", "failed");
  assert.equal(h.service.snapshot(h.ownerId).find((row) => row.ruleId === refused.id)!.error, "remote-bind-refused");
  await until(() => !h.sessions.has(refusedSession), "refused session closed");
});

test("tunnel channel: remote listeners (assigned port, bounded, refusals), routed connections, dispose unforwards and destroys", async () => {
  const forwardIns: ((error: Error | undefined, port: number) => void)[] = [];
  const unforwarded: string[] = [];
  const client = {
    forwardOut: () => undefined,
    forwardIn: (_address: string, _port: number, callback: (error: Error | undefined, port: number) => void) => { forwardIns.push(callback); },
    unforwardIn: (address: string, port: number) => { unforwarded.push(`${address}:${port}`); },
  };
  const channel = createTunnelChannel(client, Promise.resolve());
  const received: Duplex[] = [];
  const first = channel.listen("127.0.0.1", 0, (stream) => received.push(stream));
  forwardIns[0]!(undefined, 40_001);
  assert.deepEqual(await first, { ok: true, port: 40_001 });
  const refused = channel.listen("0.0.0.0", 80, () => undefined);
  forwardIns[1]!(new Error("remote port forwarding failed for listen port 80"), 0);
  assert.deepEqual(await refused, { ok: false, code: "refused" }, "no server text");
  const accepted = new PassThrough();
  channel.incoming({ destIP: "127.0.0.1", destPort: 40_001, srcIP: "10.0.0.2", srcPort: 5 }, () => accepted, () => assert.fail("rejected"));
  assert.deepEqual(received, [accepted]);
  let rejected = 0;
  channel.incoming({ destIP: "127.0.0.1", destPort: 40_002, srcIP: "", srcPort: 0 }, () => assert.fail("accepted a stranger") as never, () => { rejected += 1; });
  assert.equal(rejected, 1, "connections to a port we do not listen on are refused");
  for (let i = 1; i < TUNNEL_MAX_REMOTE_LISTENERS; i += 1) {
    const more = channel.listen("127.0.0.1", 50_000 + i, () => undefined);
    forwardIns.at(-1)!(undefined, 0);
    assert.equal((await more).ok, true);
  }
  assert.deepEqual(await channel.listen("127.0.0.1", 1, () => undefined), { ok: false, code: "resource-limit" });
  const pending = channel.listen("::1", 3000, () => undefined);
  channel.dispose();
  assert.equal(accepted.destroyed, true);
  assert.ok(unforwarded.includes("127.0.0.1:40001"));
  assert.equal(unforwarded.length, TUNNEL_MAX_REMOTE_LISTENERS);
  void pending;
  assert.deepEqual(await channel.listen("127.0.0.1", 2, () => undefined), { ok: false, code: "closed" });
});

test("socks5: early data larger than the header bound after a complete request is kept, not refused", async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const accepted = new Promise<Socket>((done) => server.once("connection", done));
  const client = connect({ host: "127.0.0.1", port: (server.address() as { port: number }).port });
  client.on("error", () => undefined);
  const socket = await accepted;
  server.close();
  const handshake = socksHandshake(socket);
  const early = Buffer.alloc(2_000, 0x16); // e.g. a TLS ClientHello sent with the request
  client.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 1, 187]), early]));
  const request = await handshake;
  assert.ok(request.ok);
  let kept = 0;
  socket.on("data", (chunk) => { kept += chunk.length; });
  socket.resume();
  await until(() => kept === early.length, "early bytes kept");
  client.destroy(); socket.destroy();
});

test("tunnel channel: pending listens count toward the cap; port-0 confirmations without a port and dead transports are not refusals", async () => {
  const forwardIns: ((error: Error | undefined, port: number) => void)[] = [];
  let throwing = false;
  const client = {
    forwardOut: () => undefined,
    forwardIn: (_address: string, _port: number, callback: (error: Error | undefined, port: number) => void) => {
      if (throwing) throw new Error("Not connected");
      forwardIns.push(callback);
    },
    unforwardIn: () => undefined,
  };
  const channel = createTunnelChannel(client, Promise.resolve());
  const pending = Array.from({ length: TUNNEL_MAX_REMOTE_LISTENERS }, (_v, i) => channel.listen("127.0.0.1", 41_000 + i, () => undefined));
  assert.deepEqual(await channel.listen("127.0.0.1", 1, () => undefined), { ok: false, code: "resource-limit" }, "pending requests are counted");
  forwardIns[0]!(undefined, 0);
  assert.equal((await pending[0]!).ok, true);
  forwardIns[1]!(new Error("x"), 0);
  assert.deepEqual(await pending[1], { ok: false, code: "refused" });
  const zero = channel.listen("127.0.0.1", 0, () => undefined);
  forwardIns.at(-1)!(undefined, 0);
  assert.deepEqual(await zero, { ok: false, code: "refused" }, "an assigned port of 0 is unusable");
  throwing = true;
  assert.deepEqual(await channel.listen("127.0.0.1", 2, () => undefined), { ok: false, code: "closed" });
  channel.dispose();
});

test("service (remote): a connection in the same tick as the confirmation is served; an unanswered dial times out and is counted", async (t) => {
  const echo = await echoServer(t);
  const blackholes: Socket[] = [];
  let blackhole = false;
  const h = harness(t, echo.port, { dial: (host, port) => {
    if (!blackhole) return connect({ host, port });
    const socket = new Socket(); // never connects
    blackholes.push(socket);
    return socket;
  } });
  const rule = h.rule(0, { type: "remote" });
  assert.ok((await h.service.start(h.ownerId, rule.id)).ok);
  const session = h.sessionOf();
  // Wrap listen so the server delivers a connection before the confirmation reaches the service.
  const original = h.registry.tunnel.bind(h.registry);
  let early: Duplex | undefined;
  h.registry.tunnel = ((owner: string, id: string, generation: number) => {
    const real = original(owner, id, generation);
    if (!real) return real;
    return { ...real, listen: async (address: string, port: number, connection: (stream: Duplex, origin: { address: string; port: number }) => void) => {
      const result = await real.listen(address, port, connection);
      early = new PassThrough();
      connection(early, { address: "127.0.0.1", port: 1 });
      return result;
    } };
  }) as never;
  h.ready(session);
  await until(() => h.service.snapshot(h.ownerId)[0]?.state === "running", "running");
  assert.ok(early);
  assert.equal(h.service.snapshot(h.ownerId)[0]!.failedConnections, 0, "the same-tick connection was not refused");
  early!.destroy();
  blackhole = true;
  const port = h.service.snapshot(h.ownerId)[0]!.remotePort!;
  const client = connect({ host: "127.0.0.1", port });
  client.on("error", () => undefined);
  await until(() => h.service.snapshot(h.ownerId)[0]!.failedConnections === 1, "dial timeout counted");
  await until(() => blackholes.every((socket) => socket.destroyed), "the dial was abandoned");
  client.destroy();
});
