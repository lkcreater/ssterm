import { strict as assert } from "node:assert";
import { test } from "node:test";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTerminals, observeBoth } from "../../apps/desktop/src/main/agent-mcp.ts";
import { createTerminalController } from "../../apps/desktop/src/main/terminals.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { SessionRegistry, TransientSecrets, type SessionContext } from "../../packages/services/src/index.ts";
import { channels, failure, type TerminalState } from "../../packages/contracts/src/index.ts";
import type { ResolvedHostConfig, TerminalChannel } from "../../packages/domain/src/index.ts";

const owner = { windowId: 1, generation: 1 };
const ownerId = sessionOwnerId(owner);
const config: ResolvedHostConfig = {
  hostRef: { id: "host-1", revision: 1, label: "lab", groupId: null }, address: "example.com", environment: "PROD",
  port: { value: 22, source: { kind: "default" } },
  auth: { selection: "identity", source: { kind: "default" }, key: null, identity: null }, ancestry: [], catalogRevision: 1,
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const bytes = (text: string) => new TextEncoder().encode(text);

async function lab() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ssterm-mcp-")));
  const contexts: SessionContext[] = [];
  const writes: string[] = [];
  let sink: ((chunk: Uint8Array, sequence: number) => void) | undefined;
  let sequence = 0;
  let registry: SessionRegistry | undefined;
  const agents = createAgentTerminals({ registry: () => registry, socketPath: join(folder, "mcp", "ssterm.sock"), version: "0.1.0", settleMs: 20 });
  registry = new SessionRegistry({
    resolve: () => ({ ok: true, value: config }), transient: new TransientSecrets(),
    adapter: { start(context) { contexts.push(context); } },
    observeTerminal: observeBoth(undefined, agents.observe),
  });
  const controller = createTerminalController({ registry, agent: agents });
  const states: TerminalState[] = [];
  controller.register(owner, (channel, value) => { if (channel === channels.terminalStateChanged) states.push(value as TerminalState); });
  const ready = async () => {
    await tick();
    const context = contexts.at(-1)!;
    sequence = 0;
    const channel: TerminalChannel = {
      drained: Promise.resolve(), dispose() {},
      open(output) { sink = output; return true; }, ack() {}, resize() {},
      write(data) { writes.push(new TextDecoder().decode(data)); return "ok"; },
    };
    context.verifyingHost(); context.authenticating();
    assert.ok(context.ready(channel));
    const target = { owner, sessionId: context.id, generation: context.generation };
    assert.ok(controller.openTerminal(target).ok);
    return target;
  };
  const connected = registry.connect(ownerId, "host-1");
  assert.ok(connected.ok);
  const target = await ready();
  return {
    folder, agents, registry, controller, states, writes, target, ready,
    emit: (text: string) => sink!(bytes(text), sequence++),
    cleanup: () => { agents.dispose(); controller.dispose(); void registry!.dispose(); rmSync(folder, { recursive: true, force: true }); },
  };
}

async function client(path: string, credential?: string) {
  const socket = connect(path);
  await once(socket, "connect");
  const waiters = new Map<number, (value: any) => void>();
  let buffer = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiters.get(message.id)?.(message);
    }
  });
  const ended = new Promise<void>((done) => socket.on("close", () => { closed = true; done(); }));
  socket.on("error", () => {});
  if (credential !== undefined) socket.write(`${JSON.stringify({ credential })}\n`);
  let next = 1;
  const request = (method: string, params?: object) => new Promise<any>((resolve) => {
    const id = next++;
    waiters.set(id, resolve);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
  const call = async (name: string, args: object = {}) => (await request("tools/call", { name, arguments: args })).result;
  return { socket, request, call, ended, closed: () => closed };
}
const nonceOf = (line: string) => /ssterm;(?:ready|start);([0-9a-f]{32})/u.exec(line)![1]!;
const settle = () => new Promise((done) => setTimeout(done, 20));

test("a credential binds one Ready SSH generation over a 0600 socket in a 0700 folder; anything else is closed unanswered", async () => {
  const { agents, target, cleanup, folder } = await lab();
  try {
    assert.equal(existsSync(join(folder, "mcp")), false, "no socket until a conversation is bound");
    assert.equal(agents.input(ownerId, target.sessionId, target.generation, bytes("x")), true, "no executor, no hold, before a binding");
    assert.equal(await agents.issue(ownerId, "missing"), undefined);
    assert.equal(await agents.issue(sessionOwnerId({ windowId: 2, generation: 1 }), target.sessionId), undefined, "another owner's session");
    const issued = (await agents.issue(ownerId, target.sessionId))!;
    assert.match(issued.credential, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(statSync(issued.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(folder, "mcp")).mode & 0o777, 0o700);
    assert.ok(statSync(issued.socketPath).isSocket());

    for (const bad of ["", "x".repeat(43), issued.credential.slice(1) + "A", `${issued.credential} `]) {
      const intruder = await client(issued.socketPath, bad);
      const answer = intruder.request("tools/list");
      await intruder.ended;
      assert.equal(await Promise.race([answer, Promise.resolve("none")]), "none");
    }
    const raw = await client(issued.socketPath);
    raw.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    await raw.ended;

    const good = await client(issued.socketPath, issued.credential);
    const init = await good.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "ssterm");
    assert.deepEqual((await good.request("tools/list")).result.tools.map((tool: { name: string }) => tool.name), ["run_command", "read_output", "cancel"]);
    assert.equal((await good.request("resources/list")).error.code, -32601);
    assert.deepEqual(await good.call("read_output"), { content: [{ type: "text", text: '{"status":"none"}' }], structuredContent: { status: "none" }, isError: false });
    assert.equal((await good.call("run_command", { command: "ls", extra: 1 })).isError, true);
    assert.equal((await good.call("list_sessions")).isError, true, "no tool reaches other sessions or the catalog");
    // Ticket 03's panel close: one conversation's credential and connections end; another stays.
    const other = (await agents.issue(ownerId, target.sessionId))!;
    agents.revoke(issued.credential);
    await good.ended;
    const kept = await client(other.socketPath, other.credential);
    assert.ok((await kept.request("ping")).result);
    kept.socket.destroy();
  } finally { cleanup(); }
});

test("run_command: a non-read-only command types nothing; a read-only one is typed with markers, holds input, returns its span", async () => {
  const { agents, target, controller, writes, states, emit, cleanup } = await lab();
  try {
    emit("previous output with a secret\r\n$ ");
    const issued = (await agents.issue(ownerId, target.sessionId))!;
    const agent = await client(issued.socketPath, issued.credential);
    const refused = await agent.call("run_command", { command: "ls; rm -rf /" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Refused in Read only mode: command chaining/u);
    assert.equal(writes.length, 0, "a refused command never reaches the terminal");

    const pending = agent.call("run_command", { command: "cat /etc/hostname" });
    await settle();
    assert.equal(writes.length, 1, "only the prompt probe until the shell answers it");
    const nonce = nonceOf(writes[0]!);
    assert.ok(!writes[0]!.includes("cat /etc/hostname"));
    emit(`\x1b]ssterm;ready;${nonce}\x07$ `);
    assert.equal(writes.length, 2);
    assert.ok(writes[1]!.endsWith("\r") && writes[1]!.includes("; cat /etc/hostname; "));
    assert.deepEqual(states.at(-1)!.sessions[0]!.agent, { command: "cat /etc/hostname" }, "the pane banner names the command");
    // A second command waits for the first: refused, not queued.
    assert.match((await agent.call("run_command", { command: "pwd" })).content[0].text, /one runs at a time/u);
    // User input is held, a lone Ctrl+C would pass.
    assert.deepEqual(controller.writeTerminal({ ...target, bytes: bytes("rm -rf /\r") }), failure("held"));
    assert.equal(writes.length, 2);
    const running = await agent.call("read_output");
    assert.equal(running.structuredContent.status, "running");
    emit(`cat /etc/hostname\r\n\x1b]ssterm;start;${nonce}\x07lab-host\r\n\x1b]ssterm;done;${"0".repeat(32)};0\x07`);
    emit(`\x1b]ssterm;done;${nonce};0\x07$ `);
    const result = await pending;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { status: "completed", command: "cat /etc/hostname", exitCode: 0, output: "lab-host\n", truncated: false });
    assert.equal(states.at(-1)!.sessions[0]!.agent, undefined);
    assert.ok(controller.writeTerminal({ ...target, bytes: bytes("x") }).ok, "input flows again");
    agent.socket.destroy();
  } finally { cleanup(); }
});

test("Ctrl+C from the pane and the cancel tool interrupt; the timeout path is the executor's (unit-tested)", async () => {
  const { agents, target, controller, writes, emit, cleanup } = await lab();
  try {
    const issued = (await agents.issue(ownerId, target.sessionId))!;
    const agent = await client(issued.socketPath, issued.credential);
    const first = agent.call("run_command", { command: "sleep 30" });
    await settle();
    emit(`\x1b]ssterm;ready;${nonceOf(writes[0]!)}\x07$ \x1b]ssterm;start;${nonceOf(writes[0]!)}\x07`);
    assert.ok(controller.writeTerminal({ ...target, bytes: Uint8Array.of(3) }).ok, "Ctrl+C passes through");
    emit("^C\r\n$ ");
    assert.equal((await first).structuredContent.status, "interrupted");

    const second = agent.call("run_command", { command: "sleep 30" });
    await settle();
    const nonce = nonceOf(writes.at(-1)!);
    emit(`\x1b]ssterm;ready;${nonce}\x07$ \x1b]ssterm;start;${nonce}\x07`);
    assert.deepEqual((await agent.call("cancel")).structuredContent, { cancelled: true });
    assert.equal(writes.at(-1), "\x03");
    assert.equal((await second).structuredContent.status, "interrupted");
    agent.socket.destroy();
  } finally { cleanup(); }
});

test("a reconnect fences the old generation; a lock revokes every credential, drops connections and removes the socket", async () => {
  const { agents, registry, target, ready, cleanup } = await lab();
  try {
    const issued = (await agents.issue(ownerId, target.sessionId))!;
    const agent = await client(issued.socketPath, issued.credential);
    assert.equal((await agent.request("ping")).result !== undefined, true);
    assert.ok((await registry.close(ownerId, target.sessionId, target.generation)).ok);
    await agent.ended;
    const reconnected = registry.reconnect(ownerId, target.sessionId, target.generation);
    assert.ok(reconnected.ok);
    const next = await ready();
    assert.equal(next.generation, target.generation + 1);
    const stale = await client(issued.socketPath, issued.credential);
    await stale.ended;
    assert.ok(stale.closed(), "the old generation's credential is refused after a reconnect");

    const fresh = (await agents.issue(ownerId, next.sessionId))!;
    const bound = await client(fresh.socketPath, fresh.credential);
    assert.ok((await bound.request("ping")).result);
    agents.lock();
    await bound.ended;
    assert.equal(existsSync(fresh.socketPath), false);
    // After unlock a new binding is needed; the old credential stays revoked on the new socket.
    const again = (await agents.issue(ownerId, next.sessionId))!;
    const revoked = await client(again.socketPath, fresh.credential);
    await revoked.ended;
    assert.ok(revoked.closed());
  } finally { cleanup(); }
});

test("local terminals get no executor; observeBoth isolates a throwing tap", () => {
  const agents = createAgentTerminals({ registry: () => undefined, socketPath: "/nonexistent/s.sock", version: "0" });
  const session = { ownerId, sessionId: "s", generation: 1, hostId: null, local: true, label: "This Mac", endpoint: "/bin/zsh", environment: null };
  assert.equal(agents.observe(session), undefined);
  const seen: string[] = [];
  const both = observeBoth(() => { throw new Error("x"); }, () => ({ output: () => seen.push("out"), end: () => seen.push("end") }))({ ...session, local: false })!;
  both.output(bytes("a"));
  both.end();
  assert.deepEqual(seen, ["out", "end"]);
  agents.dispose();
});
