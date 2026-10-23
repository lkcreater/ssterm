import { strict as assert } from "node:assert";
import { test } from "node:test";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTerminals, observeBoth, type AgentGate, type GateDecision } from "../../apps/desktop/src/main/agent-mcp.ts";
import { createTerminalController } from "../../apps/desktop/src/main/terminals.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { SessionRegistry, TransientSecrets, type SessionContext } from "../../packages/services/src/index.ts";
import { channels, failure, isTerminalSession, type TerminalState } from "../../packages/contracts/src/index.ts";
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
    assert.ok(agents.input(ownerId, target.sessionId, target.generation, bytes("x")), "no executor, no hold, before a binding");
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
    assert.deepEqual((await good.request("tools/list")).result.tools.map((tool: { name: string }) => tool.name), ["propose_plan", "run_command", "read_output", "cancel"]);
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
    assert.ok(writes[1]!.endsWith("\r") && writes[1]!.includes("; { cat /etc/hostname; } </dev/null; "), "a read-only step reads nothing from the terminal");
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

test("review M1: read_output and cancel answer only for commands their own credential started", async () => {
  const { agents, target, writes, emit, cleanup } = await lab();
  try {
    const mine = (await agents.issue(ownerId, target.sessionId))!;
    const theirs = (await agents.issue(ownerId, target.sessionId))!;
    const a = await client(mine.socketPath, mine.credential);
    const b = await client(theirs.socketPath, theirs.credential);
    const running = a.call("run_command", { command: "sleep 30" });
    await settle();
    const nonce = nonceOf(writes.at(-1)!);
    emit(`\x1b]ssterm;ready;${nonce}\x07$ \x1b]ssterm;start;${nonce}\x07SECRET-OUTPUT\r\n`);
    await settle();
    assert.equal((await a.call("read_output")).structuredContent.status, "running");
    assert.deepEqual((await b.call("read_output")).structuredContent, { status: "none" }, "another credential sees nothing of it");
    assert.deepEqual((await b.call("cancel")).structuredContent, { cancelled: false }, "nor can it cancel it");
    assert.notEqual(writes.at(-1), "\x03");
    assert.deepEqual((await a.call("cancel")).structuredContent, { cancelled: true });
    assert.equal((await running).structuredContent.status, "interrupted");
    assert.equal((await a.call("read_output")).structuredContent.status, "interrupted", "its own last result");
    assert.deepEqual((await b.call("read_output")).structuredContent, { status: "none" }, "never another credential's last result");
    a.socket.destroy();
    b.socket.destroy();
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

test("ticket 03: a role binding serves its own tools; terminal calls are recorded; revoking a binding interrupts its running command", async () => {
  const { agents, target, writes, emit, cleanup } = await lab();
  try {
    const calls: unknown[] = [];
    const role = {
      tools: [{ name: "delegate_task", description: "d", inputSchema: { type: "object" } }],
      call: async (name: unknown, args: unknown) => { calls.push([name, args]); return { content: [{ type: "text" as const, text: "ok" }], isError: false }; },
    };
    const main = (await agents.issue(ownerId, target.sessionId, { role }))!;
    const mainClient = await client(main.socketPath, main.credential);
    assert.deepEqual((await mainClient.request("tools/list")).result.tools.map((tool: { name: string }) => tool.name), ["delegate_task"]);
    assert.equal((await mainClient.call("delegate_task", { goal: "x" })).content[0].text, "ok");
    assert.equal((await mainClient.call("run_command", { command: "ls" })).content[0].text, "ok", "routed to the role, which refuses it");
    assert.deepEqual(calls, [["delegate_task", { goal: "x" }], ["run_command", { command: "ls" }]]);
    assert.equal(writes.length, 0, "a role binding never reaches the terminal");

    const steps: unknown[] = [];
    let limit: string | undefined;
    const sub = (await agents.issue(ownerId, target.sessionId, { record: (step) => steps.push(step), admit: () => limit }))!;
    const subClient = await client(sub.socketPath, sub.credential);
    await subClient.call("run_command", { command: "touch /tmp/x" });
    // A control character in a refused command is recorded visibly replaced, so the agent view stays valid.
    await subClient.call("run_command", { command: "rm\r-rf\u0007/" });
    assert.equal((steps.pop() as { command: string }).command, "rm\ufffd-rf\ufffd/");
    limit = "LIMIT reached";
    const before = writes.length;
    const limited = await subClient.call("run_command", { command: "ls" });
    assert.deepEqual([limited.isError, limited.content[0].text, writes.length, steps.length], [true, "LIMIT reached", before, 1], "refused before anything is typed");
    limit = undefined;
    const running = subClient.call("run_command", { command: "sleep 30" });
    await settle();
    const nonce = nonceOf(writes.at(-1)!);
    emit(`\x1b]ssterm;ready;${nonce}\x07$ \x1b]ssterm;start;${nonce}\x07`);
    agents.revoke(sub.credential);
    assert.equal(writes.at(-1), "\x03", "Ctrl+C: nobody is left to receive the result");
    void limit;
    await subClient.ended;
    emit("^C\r\n$ ");
    await new Promise((done) => setTimeout(done, 60));
    assert.deepEqual(steps, [
      { command: "touch /tmp/x", status: "refused", exitCode: null, output: steps.length ? (steps[0] as { output: string }).output : "", truncated: false, via: null },
      { command: "sleep 30", status: "interrupted", exitCode: null, output: "^C\n$ ", truncated: false, via: "read-only" },
    ]);
    assert.match((steps[0] as { output: string }).output, /^Refused in Read only mode/u);
    void running;
    mainClient.socket.destroy();
  } finally { cleanup(); }
});

test("ticket 04: a binding's gate decides each run_command; what it approves is typed; a refusal or a wait past the session types nothing", async () => {
  const { agents, registry, target, writes, emit, cleanup } = await lab();
  try {
    const steps: { command: string; status: string; via: string | null }[] = [];
    const undone: string[] = [];
    let release: ((decision: GateDecision) => void) | undefined;
    const gate: AgentGate = {
      authorize: async (command, verdict) => {
        if (command === "wait for me") return new Promise((resolve) => { release = resolve; });
        if (verdict.readOnly) return { run: command, via: "read-only" };
        if (command === " touch /tmp/planned ") return { run: "touch /tmp/planned", via: "plan", undo: () => undone.push(command) };
        return { refuse: "NO: not approved" };
      },
      propose: async (args) => ({ content: [{ type: "text", text: `proposed ${JSON.stringify(args)}` }], isError: false }),
    };
    const issued = (await agents.issue(ownerId, target.sessionId, { record: (step) => steps.push(step), gate }))!;
    const agent = await client(issued.socketPath, issued.credential);
    assert.equal((await agent.call("propose_plan", { goal: "g", commands: ["x"] })).content[0].text, 'proposed {"goal":"g","commands":["x"]}');
    const refused = await agent.call("run_command", { command: "rm -rf /" });
    assert.deepEqual([refused.isError, refused.content[0].text, writes.length], [true, "NO: not approved", 0]);

    const planned = agent.call("run_command", { command: " touch /tmp/planned " });
    await settle();
    const nonce = nonceOf(writes.at(-1)!);
    emit(`\x1b]ssterm;ready;${nonce}\x07$ `);
    assert.ok(writes.at(-1)!.includes("; touch /tmp/planned; "), "the gate's text is typed");
    // While it runs, a second plan command meets a busy executor: nothing typed, the plan entry is given back.
    const typed = writes.length;
    assert.match((await agent.call("run_command", { command: " touch /tmp/planned " })).content[0].text, /one runs at a time/u);
    assert.deepEqual([writes.length, undone], [typed, [" touch /tmp/planned "]]);
    emit(`\x1b]ssterm;start;${nonce}\x07\x1b]ssterm;done;${nonce};0\x07$ `);
    assert.equal((await planned).structuredContent.status, "completed");
    assert.deepEqual(steps.map((step) => [step.command, step.status, step.via]), [
      ["rm -rf /", "refused", null], ["touch /tmp/planned", "refused", null], ["touch /tmp/planned", "completed", "plan"],
    ]);

    // An approval that outlives the session: nothing is typed when it finally arrives.
    const waiting = agent.call("run_command", { command: "wait for me" });
    await settle();
    const before = writes.length;
    assert.ok((await registry.close(ownerId, target.sessionId, target.generation)).ok);
    await agent.ended;
    release!({ run: "touch /tmp/late", via: "approval", undo: () => undone.push("late") });
    await settle();
    assert.equal(writes.length, before, "nothing reaches a closed session");
    assert.deepEqual(undone.at(-1), "late");
    void waiting;

    // Without a gate a binding stays Read only and has no plans.
    const readOnly = await lab();
    try {
      const plain = (await readOnly.agents.issue(ownerId, readOnly.target.sessionId))!;
      const other = await client(plain.socketPath, plain.credential);
      const proposal = await other.call("propose_plan", { goal: "g", commands: ["touch /tmp/a"] });
      assert.deepEqual([proposal.isError, /Read only mode/u.test(proposal.content[0].text)], [true, true]);
      assert.match((await other.call("run_command", { command: "touch /tmp/a" })).content[0].text, /^Refused in Read only mode/u);
      assert.equal(readOnly.writes.length, 0);
      other.socket.destroy();
    } finally { readOnly.cleanup(); }
  } finally { cleanup(); }
});

test("M1: a card belongs to the MCP request that raised it; notifications/cancelled and a closed connection abort it and nothing is typed after a later approve", async () => {
  const { agents, target, writes, cleanup } = await lab();
  try {
    const steps: { command: string; status: string; output: string }[] = [];
    const pending: { signal: AbortSignal; approve(): void }[] = [];
    const gate: AgentGate = {
      authorize: (command, _verdict, signal) => new Promise((resolve) => pending.push({ signal, approve: () => resolve({ run: command, via: "approval" }) })),
      propose: async () => ({ content: [{ type: "text", text: "x" }], isError: false }),
    };
    const issued = (await agents.issue(ownerId, target.sessionId, { record: (step) => steps.push(step), gate }))!;
    const first = await client(issued.socketPath, issued.credential);
    const answers: unknown[] = [];
    first.socket.on("data", (chunk: string) => answers.push(chunk));
    first.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "call-7", method: "tools/call", params: { name: "run_command", arguments: { command: "touch /tmp/x" } } })}\n`);
    await settle();
    assert.equal(pending.length, 1);
    first.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "call-8" } })}\n`);
    await settle();
    assert.equal(pending[0]!.signal.aborted, false, "another request id cancels nothing");
    first.socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "call-7", reason: "user" } })}\n`);
    await settle();
    assert.equal(pending[0]!.signal.aborted, true);
    pending[0]!.approve();
    await settle();
    assert.equal(writes.length, 0, "approved after the cancel: nothing typed");
    assert.deepEqual([steps.at(-1)!.status, /cancelled/u.test(steps.at(-1)!.output)], ["refused", true], "and the record says so");

    const second = await client(issued.socketPath, issued.credential);
    void second.call("run_command", { command: "touch /tmp/y" });
    await settle();
    assert.equal(pending.length, 2);
    second.socket.destroy();
    await second.ended;
    await settle();
    assert.equal(pending[1]!.signal.aborted, true, "the requesting connection closed");
    pending[1]!.approve();
    await settle();
    assert.equal(writes.length, 0);
    assert.equal(steps.length, 2, "one record per admitted call");
    first.socket.destroy();
  } finally { cleanup(); }
});

test("ticket 05: a password prompt is handed to the pane (banner, input passes until Return), the result carries only the handoff note; a waiting prompt refuses the probe", async () => {
  const { agents, target, controller, writes, states, emit, cleanup } = await lab();
  try {
    const steps: unknown[] = [];
    // The user's own sudo left at its prompt before the binding: nothing is typed into it.
    emit("$ sudo -v\r\n[sudo] password for fixture: ");
    const gate: AgentGate = { authorize: async (command) => ({ run: command, via: "full-allow" }), propose: async () => { throw new Error("unused"); } };
    const issued = (await agents.issue(ownerId, target.sessionId, { record: (step) => steps.push(step), gate }))!;
    const agent = await client(issued.socketPath, issued.credential);
    const pendingPrompt = await agent.call("run_command", { command: "pwd" });
    assert.equal(pendingPrompt.isError, true);
    assert.match(pendingPrompt.content[0].text, /waiting at a password prompt, so nothing was typed/u);
    assert.equal(writes.length, 0);
    emit("\r\nsudo: 1 incorrect password attempt\r\n$ ");

    const pending = agent.call("run_command", { command: "sudo cat /etc/hostname" });
    await settle();
    const nonce = nonceOf(writes[0]!);
    emit(`\x1b]ssterm;ready;${nonce}\x07$ `);
    assert.ok(!writes[1]!.includes("/dev/null"), "not a read-only step");
    emit(`sudo cat /etc/hostname\r\n\x1b]ssterm;start;${nonce}\x07[sudo] password for fixture: `);
    assert.deepEqual(controller.writeTerminal({ ...target, bytes: bytes("early") }), failure("held"), "held until the prompt stays quiet");
    await new Promise((done) => setTimeout(done, 150));
    assert.deepEqual(states.at(-1)!.sessions[0]!.agent, { command: "sudo cat /etc/hostname", password: true });
    for (const key of "s3cret-P") assert.ok(controller.writeTerminal({ ...target, bytes: bytes(key) }).ok);
    // A write that runs past Return: the entry up to Return goes through, the rest is dropped; a distinct outcome.
    assert.deepEqual(controller.writeTerminal({ ...target, bytes: bytes("W\recho REPLAY\r") }), failure("partly-held"));
    assert.deepEqual(states.at(-1)!.sessions[0]!.agent, { command: "sudo cat /etc/hostname" }, "Return ends the entry");
    assert.deepEqual(controller.writeTerminal({ ...target, bytes: bytes("more\r") }), failure("held"));
    assert.equal(writes.slice(2).join(""), "s3cret-PW\r", "the entry went to the pane, nothing else");
    // The program prints the entry back: the whole output is withheld.
    emit(`\r\nlab-host s3cret-PW\r\n\x1b]ssterm;done;${nonce};0\x07$ `);
    const result = await pending;
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { status: "completed", command: "sudo cat /etc/hostname", exitCode: 0,
      output: "[ssterm: output withheld: it contained what you typed at a password prompt]\n", truncated: false, outputWithheld: true, passwordPrompts: 1, passwordHandedOff: true,
      note: "A password prompt was handed to the user, who typed in the terminal; what they typed is not included." });
    assert.ok(!JSON.stringify([result, steps, states]).includes("s3cret"));
    assert.equal((steps.at(-1) as { status: string }).status, "completed");
    // Held bytes were dropped, never kept: once the command is over, input flows and nothing earlier is replayed.
    assert.ok(controller.writeTerminal({ ...target, bytes: bytes("next") }).ok);
    assert.equal(writes.slice(2).join(""), "s3cret-PW\rnext");
    agent.socket.destroy();
  } finally { cleanup(); }
});

test("ticket 05: the terminal contract carries the password flag only as true", async () => {
  const { states, cleanup } = await lab();
  try {
    const session = states.at(-1)!.sessions[0]!;
    assert.ok(isTerminalSession({ ...session, agent: { command: "ls", password: true } }));
    for (const agent of [{ command: "ls", password: false }, { command: "ls", password: "yes" }, { command: "ls", typed: "x" }])
      assert.equal(isTerminalSession({ ...session, agent }), false, JSON.stringify(agent));
  } finally { cleanup(); }
});
