import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { connect as connectTcp, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import ssh2, { type Connection } from "ssh2";
import type { ResolvedHostConfig, SecretItem, SecretProvider } from "../../packages/domain/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { connectThroughProxy } from "../../packages/adapters/src/proxy.ts";
import { ed25519 } from "./ssh-keys.ts";
import { createSavedHostSshAdapter, KnownHostPolicy, SessionRegistry, TransientSecrets, type SessionSnapshot } from "../../packages/services/src/index.ts";

const OWNER = "fixture-owner";
const until = async (check: () => boolean, label: string, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** One owned in-process SSH server. `forward` decides direct-tcpip requests (a jump host); `shell` serves a target. */
async function sshServer(t: TestContext, options: { name: string; password: string; deny?: boolean; forward?: (destination: { host: string; port: number }) => number | undefined }) {
  const hostKey = Buffer.from(ed25519().private);
  const clients = new Set<Connection>();
  const passwords: string[] = [];
  const forwards: { host: string; port: number }[] = [];
  let open = 0;
  const server = new ssh2.Server({ hostKeys: [hostKey] });
  server.on("connection", (client) => {
    clients.add(client);
    open += 1;
    client.on("close", () => { open -= 1; clients.delete(client); });
    client.on("error", () => {});
    client.on("authentication", (auth) => {
      if (auth.method === "password") passwords.push(auth.password);
      if (!options.deny && auth.method === "password" && auth.password === options.password) auth.accept();
      else auth.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        forwards.push({ host: info.destIP, port: info.destPort });
        const port = options.forward?.({ host: info.destIP, port: info.destPort });
        if (port === undefined) return reject();
        const upstream = connectTcp({ host: "127.0.0.1", port });
        upstream.on("error", () => stream.destroy());
        const stream = accept();
        stream.on("error", () => upstream.destroy());
        stream.pipe(upstream).pipe(stream);
      });
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("shell", (acceptShell) => acceptShell().write(`${options.name} output`));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { for (const client of clients) client.end(); server.close(() => resolve()); }));
  return { port: (server.address() as { port: number }).port, passwords, forwards, open: () => open };
}

const entity = (id: string) => ({ id, vaultId: "fixture-vault", revision: 1, createdAt: "fixture", updatedAt: "fixture" });
function hop(id: string, label: string, address: string, port: number, username: string, passwordRef: string | null, environment: ResolvedHostConfig["environment"] = null): ResolvedHostConfig {
  return {
    hostRef: { id, revision: 1, label, groupId: null }, address, environment, port: { value: port, source: { kind: "host", id, revision: 1 } },
    auth: { selection: "identity", source: { kind: "host", id, revision: 1 }, key: null, identity: {
      ...entity(`${id}-identity`), label: `${label} identity`, username, method: "password", passwordRef, keyId: null,
    } }, ancestry: [], catalogRevision: 1,
  };
}

async function harness(t: TestContext, target: ResolvedHostConfig, secrets: Record<string, string>) {
  const dir = mkdtempSync("/private/tmp/ssterm-jump-");
  const opened = await openMetadata({ path: join(dir, "metadata.db") });
  assert(opened.ok);
  const repository = opened.value;
  const policy = new KnownHostPolicy({ repository });
  const reads: string[] = [];
  const provider: SecretProvider = {
    async read(item: SecretItem) {
      reads.push(item.ref);
      const value = secrets[item.ref];
      return value === undefined ? { status: "missing" } : { status: "present", value: Buffer.from(value) };
    },
    async lookup() { return { status: "missing" }; },
    async write() { return { status: "confirmed" }; },
    async delete() { return { status: "missing" }; },
  };
  const registry = new SessionRegistry({
    resolve: () => ({ ok: true, value: target }),
    transient: new TransientSecrets(),
    adapter: createSavedHostSshAdapter({ provider, policy }),
    limits: { connectMs: 20_000, promptMs: 20_000 },
  });
  const states: string[] = [];
  registry.subscribe(OWNER, (snapshot) => states.push(snapshot.state));
  t.after(async () => { await registry.dispose(); policy.dispose(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  const current = (): SessionSnapshot => registry.snapshot(OWNER)[0]!;
  const prompts: NonNullable<SessionSnapshot["prompt"]>[] = [];
  return {
    registry, policy, reads, states, current, prompts,
    connect: () => assert(registry.connect(OWNER, target.hostRef.id).ok),
    /** Answers every prompt in order (trust: accept-once; credentials: from `typed`) until Ready or Failed. */
    async drive(typed: Record<string, string> = {}) {
      for (;;) {
        await until(() => !!current().prompt || ["Ready", "Failed", "Closed"].includes(current().state), "prompt or outcome");
        const snapshot = current();
        const prompt = snapshot.prompt;
        if (!prompt) return snapshot;
        prompts.push(prompt);
        if (prompt.kind === "host-trust")
          assert(registry.answerPrompt(OWNER, snapshot.id, snapshot.generation, prompt.id, { kind: "host-trust", decision: "accept-once" }).ok);
        else {
          const label = prompt.hop?.label ?? target.hostRef.label;
          const value = typed[label];
          assert(value !== undefined, `no typed credential for ${label}`);
          assert(registry.answerPrompt(OWNER, snapshot.id, snapshot.generation, prompt.id, {
            kind: "credentials", values: prompt.fields.map((field) => ({ id: field.id, value: Buffer.from(value) })),
          }).ok);
        }
        await until(() => current().prompt?.id !== prompt.id, "prompt consumed");
      }
    },
  };
}

test("one jump host: each hop verifies its own key and signs in with its own identity only; the jump host resolves the target", async (t) => {
  const target = await sshServer(t, { name: "target", password: "target-pass" });
  const bastion = await sshServer(t, { name: "bastion", password: "bastion-pass", forward: (to) => (to.host === "target.internal" && to.port === 22 ? target.port : undefined) });
  const config = { ...hop("t", "Target", "target.internal", 22, "deploy", "target-ref", "PROD"), jumps: [hop("b", "Bastion", "127.0.0.1", bastion.port, "jumper", "bastion-ref")] };
  const h = await harness(t, config, { "bastion-ref": "bastion-pass", "target-ref": "target-pass" });
  h.connect();
  const outcome = await h.drive();
  assert.equal(outcome.state, "Ready");
  // Prompts in order: the jump host's key (labelled as the jump host), then the target's key (no hop).
  assert.deepEqual(h.prompts.map((prompt) => [prompt.kind, prompt.kind === "host-trust" ? `${prompt.endpointHost}:${prompt.endpointPort}` : "", prompt.hop?.label ?? null]), [
    ["host-trust", `127.0.0.1:${bastion.port}`, "Bastion"],
    ["host-trust", "target.internal:22", null],
  ]);
  assert.deepEqual(h.prompts[0]!.hop, { index: 0, total: 2, label: "Bastion", environment: null, endpointHost: "127.0.0.1", endpointPort: bastion.port, username: "jumper" });
  // Credentials never cross hops: each server saw only its own password, read in hop order.
  assert.deepEqual(bastion.passwords, ["bastion-pass"]);
  assert.deepEqual(target.passwords, ["target-pass"]);
  assert.deepEqual(h.reads, ["bastion-ref", "target-ref"]);
  assert.deepEqual(bastion.forwards, [{ host: "target.internal", port: 22 }], "the name went to the jump host unresolved");
  const terminal = h.registry.terminal(OWNER, outcome.id, outcome.generation);
  assert(terminal);
  // Closing tears down both hops.
  await h.registry.close(OWNER, outcome.id, outcome.generation);
  await until(() => bastion.open() === 0 && target.open() === 0, "both hops closed");
});

test("two jump hosts in a row; a credential prompt for a jump host names that host and user", async (t) => {
  const target = await sshServer(t, { name: "target", password: "target-pass" });
  const inner = await sshServer(t, { name: "inner", password: "inner-pass", forward: (to) => (to.host === "target.internal" ? target.port : undefined) });
  const outer = await sshServer(t, { name: "outer", password: "outer-pass", forward: (to) => (to.host === "inner.internal" ? inner.port : undefined) });
  const config = {
    ...hop("t", "Target", "target.internal", 22, "deploy", "target-ref"),
    jumps: [hop("o", "Outer", "127.0.0.1", outer.port, "o-user", "outer-ref"), hop("i", "Inner", "inner.internal", 22, "i-user", null)],
  };
  const h = await harness(t, config, { "outer-ref": "outer-pass", "target-ref": "target-pass" });
  h.connect();
  const outcome = await h.drive({ Inner: "inner-pass" });
  assert.equal(outcome.state, "Ready");
  const credential = h.prompts.find((prompt) => prompt.kind === "credentials")!;
  assert.deepEqual(credential.hop, { index: 1, total: 3, label: "Inner", environment: null, endpointHost: "inner.internal", endpointPort: 22, username: "i-user" });
  assert.deepEqual([outer.passwords, inner.passwords, target.passwords], [["outer-pass"], ["inner-pass"], ["target-pass"]]);
  assert.deepEqual(h.prompts.filter((prompt) => prompt.kind === "host-trust").map((prompt) => prompt.hop?.label ?? "target"), ["Outer", "Inner", "target"]);
  await h.registry.close(OWNER, outcome.id, outcome.generation);
  await until(() => outer.open() + inner.open() + target.open() === 0, "every hop closed");
});

test("a failed intermediate hop fails the session with that hop's code, never contacts the target, and leaves nothing open", async (t) => {
  const target = await sshServer(t, { name: "target", password: "target-pass" });
  const bastion = await sshServer(t, { name: "bastion", password: "bastion-pass", deny: true, forward: () => target.port });
  const config = { ...hop("t", "Target", "target.internal", 22, "deploy", "target-ref"), jumps: [hop("b", "Bastion", "127.0.0.1", bastion.port, "jumper", "bastion-ref")] };
  const h = await harness(t, config, { "bastion-ref": "wrong", "target-ref": "target-pass" });
  h.connect();
  const outcome = await h.drive();
  assert.equal(outcome.state, "Failed");
  assert.equal(outcome.error?.code, "auth-denied");
  assert.deepEqual(h.reads, ["bastion-ref"], "the target's credentials were never read");
  assert.equal(target.passwords.length, 0);
  assert.equal(bastion.forwards.length, 0);
  await until(() => bastion.open() === 0, "bastion connection closed");
  await h.registry.settled(OWNER, outcome.id, outcome.generation);
  assert.equal(h.registry.snapshot(OWNER)[0]?.cleanup, "complete");
});

test("a jump host that refuses to connect onward fails with jump-refused; cancelling during the target's prompt closes every hop", async (t) => {
  const target = await sshServer(t, { name: "target", password: "target-pass" });
  const refusing = await sshServer(t, { name: "bastion", password: "bastion-pass", forward: () => undefined });
  const h = await harness(t, { ...hop("t", "Target", "target.internal", 22, "deploy", "target-ref"), jumps: [hop("b", "Bastion", "127.0.0.1", refusing.port, "jumper", "bastion-ref")] },
    { "bastion-ref": "bastion-pass", "target-ref": "target-pass" });
  h.connect();
  const refused = await h.drive();
  assert.equal(refused.error?.code, "jump-refused");
  assert.equal(target.passwords.length, 0);
  await until(() => refusing.open() === 0, "refusing bastion closed");

  const bastion = await sshServer(t, { name: "bastion", password: "bastion-pass", forward: () => target.port });
  const c = await harness(t, { ...hop("t2", "Target", "target.internal", 22, "deploy", "target-ref"), jumps: [hop("b2", "Bastion", "127.0.0.1", bastion.port, "jumper", "bastion-ref")] },
    { "bastion-ref": "bastion-pass", "target-ref": "target-pass" });
  c.connect();
  await until(() => c.current().prompt?.kind === "host-trust", "bastion trust");
  const first = c.current();
  assert(c.registry.answerPrompt(OWNER, first.id, first.generation, first.prompt!.id, { kind: "host-trust", decision: "accept-once" }).ok);
  await until(() => c.current().prompt?.kind === "host-trust" && !c.current().prompt?.hop, "target trust");
  assert.equal(bastion.open(), 1);
  const at = c.current();
  await c.registry.close(OWNER, at.id, at.generation);
  await until(() => bastion.open() === 0 && target.open() === 0, "cancel closed every hop");
});

test("registry: a hop count beyond the captured chain cannot re-enter VerifyingHost, and the target channel needs every hop", async () => {
  const direct = hop("d", "Direct", "127.0.0.1", 22, "u", "r");
  let observed: { second?: boolean; ready?: boolean } = {};
  const registry = new SessionRegistry({
    resolve: () => ({ ok: true, value: direct }),
    transient: new TransientSecrets(),
    adapter: { start(context) {
      assert.equal(context.verifyingHost(), true);
      assert.equal(context.authenticating(), true);
      observed.second = context.verifyingHost();
      observed.ready = context.ready({ open: () => ({}), dispose() {} } as never);
    } },
  });
  assert(registry.connect(OWNER, "d").ok);
  await until(() => observed.ready !== undefined, "adapter ran");
  assert.equal(observed.second, false, "a direct session has exactly one hop");
  assert.equal(observed.ready, true);
  await registry.dispose();

  const chained = { ...hop("t", "T", "t", 22, "u", "r"), jumps: [hop("b", "B", "b", 22, "u", "r")] };
  observed = {};
  const early = new SessionRegistry({
    resolve: () => ({ ok: true, value: chained }),
    transient: new TransientSecrets(),
    adapter: { start(context) {
      context.verifyingHost();
      context.authenticating();
      observed.ready = context.ready({ open: () => ({}), dispose() {} } as never);
    } },
  });
  assert(early.connect(OWNER, "t").ok);
  await until(() => observed.ready !== undefined, "adapter ran");
  assert.equal(observed.ready, false, "a channel before the last hop is refused");
  await early.dispose();
});

/** A test-owned HTTP CONNECT proxy (Node's own CONNECT handling) and a minimal SOCKS5 server. */
async function proxies(t: TestContext) {
  const connects: string[] = [];
  const http = createHttpServer();
  http.on("connect", (request, socket: Socket, head) => {
    connects.push(String(request.url));
    const [host, port] = String(request.url).split(":");
    if (host === "deny.example") { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const upstream = connectTcp({ host: host === "ssh.internal" ? "127.0.0.1" : host!, port: Number(port) });
    upstream.on("connect", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); upstream.pipe(socket).pipe(upstream); });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  const socksRequests: string[] = [];
  const socks: TcpServer = createTcpServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 0;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 3) { buffer = buffer.subarray(2 + buffer[1]!); socket.write(Buffer.from([5, 0])); stage = 1; }
      if (stage === 1 && buffer.length >= 5 && buffer[3] === 3 && buffer.length >= 7 + buffer[4]!) {
        const host = buffer.subarray(5, 5 + buffer[4]!).toString();
        const port = buffer.readUInt16BE(5 + buffer[4]!);
        socksRequests.push(`${host}:${port}`);
        stage = 2;
        socket.pause();
        socket.removeAllListeners("data");
        const upstream = connectTcp({ host: "127.0.0.1", port });
        upstream.on("connect", () => {
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(socket).pipe(upstream);
          socket.resume();
        });
        upstream.on("error", () => socket.destroy());
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => socks.listen(0, "127.0.0.1", resolve));
  t.after(() => { http.closeAllConnections(); http.close(); socks.close(); });
  return { httpPort: (http.address() as { port: number }).port, socksPort: (socks.address() as { port: number }).port, connects, socksRequests };
}

test("proxies: SSH through HTTP CONNECT and SOCKS5 (name sent unresolved); a refused CONNECT is proxy-failed; abort is honoured", async (t) => {
  const target = await sshServer(t, { name: "target", password: "target-pass" });
  const p = await proxies(t);
  for (const proxy of [{ type: "http" as const, port: p.httpPort }, { type: "socks5" as const, port: p.socksPort }]) {
    const config = { ...hop(`p-${proxy.type}`, "Proxied", "ssh.internal", target.port, "deploy", "target-ref"), proxy: { type: proxy.type, host: "127.0.0.1", port: proxy.port } };
    const h = await harness(t, config, { "target-ref": "target-pass" });
    h.connect();
    const outcome = await h.drive();
    assert.equal(outcome.state, "Ready", proxy.type);
    assert.equal(h.prompts[0]?.kind === "host-trust" && h.prompts[0].endpointHost, "ssh.internal", "trust is keyed by the target endpoint, not the proxy");
    await h.registry.close(OWNER, outcome.id, outcome.generation);
  }
  assert.deepEqual(p.connects, [`ssh.internal:${target.port}`]);
  assert.deepEqual(p.socksRequests, [`ssh.internal:${target.port}`]);
  const denied = await connectThroughProxy({ type: "http", host: "127.0.0.1", port: p.httpPort, target: { host: "deny.example", port: 22 }, signal: new AbortController().signal });
  assert.deepEqual(denied, { ok: false, code: "proxy-failed" });
  const controller = new AbortController();
  const silent = createTcpServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  t.after(() => silent.close());
  const pending = connectThroughProxy({ type: "socks5", host: "127.0.0.1", port: (silent.address() as { port: number }).port, target: { host: "x", port: 22 }, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await pending, { ok: false, code: "cancelled" });
  assert.deepEqual(await connectThroughProxy({ type: "socks5", host: "127.0.0.1", port: (silent.address() as { port: number }).port, target: { host: "x", port: 22 }, signal: new AbortController().signal, timeoutMs: 50 }), { ok: false, code: "timeout" });
});
