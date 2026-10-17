import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { listenLocal } from "../../packages/adapters/src/local-listener.ts";
import { createTunnelChannel, TUNNEL_MAX_OPENING } from "../../packages/adapters/src/tunnel.ts";
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
function harness(t: TestContext, destinationPort: number) {
  const ownerId = "window:1:1";
  const hostId = randomUUID();
  const rules: TunnelRule[] = [];
  const observers = new Set<(snapshot: SessionSnapshot) => void>();
  const sessions = new Map<string, { generation: number; state: SessionSnapshot["state"]; error?: string }>();
  const forwards: TunnelForward[] = [];
  let refuse = false;
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
    async close(_owner: string, id: string) { if (sessions.has(id)) set(id, "Closed"); return { ok: true, value: undefined } as const; },
    settled: async () => {},
    forget(_owner: string, id: string) { sessions.delete(id); return { ok: true, value: undefined } as const; },
    snapshot: () => [],
    subscribe(_owner: string, callback: (snapshot: SessionSnapshot) => void) { observers.add(callback); return () => observers.delete(callback); },
    tunnel(_owner: string, id: string, generation: number) {
      const row = sessions.get(id);
      if (!row || row.generation !== generation || row.state !== "Ready") return undefined;
      return {
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
  return { ownerId, service, registry, sessions, events, rule, ready, set, sessionOf, forwards, refuse: (value: boolean) => { refuse = value; } };
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
