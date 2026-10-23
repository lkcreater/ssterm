import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createExternalClients, parseExternalClients, type ClientKeys } from "../../apps/desktop/src/main/agent-external.ts";
import { createAgentTerminals, TOOLS, type AgentGate, type AgentStepRecord, type ExternalHooks } from "../../apps/desktop/src/main/agent-mcp.ts";
import { createAgentRunner, type AgentSettingsStore } from "../../apps/desktop/src/main/agent-runner.ts";
import { cliEnv } from "../../apps/desktop/src/main/agent-cli.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { KeychainMcpClientStore, clearTestNamespace } from "../../packages/adapters/src/keychain.ts";
import {
  isAgentState, isAnswerExternalRequest, isUpdateExternalClientsRequest, type AgentState, type ExternalBindingView,
} from "../../packages/contracts/src/index.ts";
import { classifyReadOnly, type SessionSnapshot } from "../../packages/services/src/index.ts";

const sha = (value: string) => createHash("sha256").update(value).digest();
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done)); };
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "ssterm-ext-")));

function memory() {
  let stored: Uint8Array | undefined;
  const keys = new Map<string, Uint8Array>();
  return {
    store: { read: async () => stored ? { status: "present" as const, value: stored } : { status: "missing" as const }, write: async (value: Uint8Array) => { stored = value; return "confirmed" as const; } },
    keys: {
      read: async (id: string) => keys.get(id) ?? "missing" as const,
      write: async (id: string, value: Uint8Array) => { keys.set(id, Uint8Array.from(value)); return true; },
      delete: async (id: string) => { keys.delete(id); return true; },
    } satisfies ClientKeys,
    stored: () => stored ? JSON.parse(new TextDecoder().decode(stored)) : undefined,
    items: keys,
  };
}

test("pairing token: off by default, single use, short-lived, one presentation at a time, rate-limited, burned by denial or repeated wrong tokens", async () => {
  let now = 1_000_000;
  const backing = memory();
  const clients = createExternalClients({ store: backing.store, keys: backing.keys, now: () => now });
  await clients.ready;
  assert.equal(clients.enabled, false, "off by default");
  assert.equal(clients.issuePairing(), "disabled");
  assert.equal(createExternalClients({ store: backing.store, keys: undefined }).issuePairing(), "unavailable", "no Keychain, no pairing");
  assert.equal(await clients.setEnabled(true), true);
  assert.deepEqual(backing.stored(), { version: 2, enabled: true, clients: [], revoked: [] });

  const first = clients.issuePairing();
  assert.ok(typeof first === "object");
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(first.expiresAt, now + 5 * 60_000);
  // Wrong token or name: refused (and counted); the right one reserves it; a second presentation waits for no one.
  assert.equal(clients.present("A".repeat(43), "Claude Desktop"), undefined);
  assert.equal(clients.present(first.token, "bad\u0007name"), undefined);
  const ticket = clients.present(first.token, "Claude Desktop");
  assert.ok(typeof ticket === "object");
  assert.equal(clients.present(first.token, "Claude Desktop"), undefined, "one presentation at a time");
  // The connection closed before the user decided: the token stays for the rest of its life.
  clients.release(ticket, false);
  const again = clients.present(first.token, "Claude Desktop");
  assert.ok(typeof again === "object");
  // Denied: burned.
  clients.release(again, true);
  assert.equal(clients.present(first.token, "Claude Desktop"), undefined);

  // Expiry.
  const second = clients.issuePairing();
  assert.ok(typeof second === "object");
  now += 5 * 60_000;
  assert.equal(clients.present(second.token, "Cursor"), undefined, "expired");

  // Five wrong presentations burn the outstanding token.
  const third = clients.issuePairing();
  assert.ok(typeof third === "object");
  for (let i = 0; i < 5; i++) assert.equal(clients.present(`${"B".repeat(42)}${i}`, "Cursor"), undefined);
  assert.equal(clients.present(third.token, "Cursor"), undefined, "burned after 5 wrong tokens");

  // A new token replaces the previous one; at most 5 per 10 minutes.
  const fourth = clients.issuePairing();
  const fifth = clients.issuePairing();
  assert.ok(typeof fourth === "object" && typeof fifth === "object");
  assert.equal(clients.present(fourth.token, "Cursor"), undefined, "replaced");
  assert.equal(clients.issuePairing(), "rate-limited");
  now += 10 * 60_000;
  const sixth = clients.issuePairing();
  assert.ok(typeof sixth === "object");

  // Approved: a credential once; the token is used up.
  const paired = await clients.complete(clients.present(sixth.token, "Claude Desktop") as never, "Claude Desktop");
  assert.ok(paired);
  assert.match(paired.credential, /^[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/u);
  assert.equal(paired.credential.slice(0, 32), paired.clientId);
  assert.equal(clients.present(sixth.token, "Claude Desktop"), undefined, "single use");
  // Review L2: names are unique (case-insensitive); the token stays for another name. L6: no runs of 3+ marks.
  const named = clients.issuePairing();
  assert.ok(typeof named === "object");
  assert.equal(clients.present(named.token, "claude desktop"), "name-in-use");
  assert.equal(clients.present(named.token, "a\u0301\u0301\u0301"), undefined);
  assert.ok(typeof clients.present(named.token, "ก\u0e34\u0e48") === "object", "Thai with two marks is a name");
  // Turning off drops the outstanding token.
  const seventh = clients.issuePairing();
  assert.ok(typeof seventh === "object");
  const drops: (string | undefined)[] = [];
  clients.onDrop((id) => drops.push(id));
  await clients.setEnabled(false);
  assert.deepEqual(drops, [undefined]);
  await clients.setEnabled(true);
  assert.equal(clients.present(seventh.token, "Cursor"), undefined);
});

test("credential: only its SHA-256 verifier is kept (Keychain), compared in constant time; revoke invalidates at once and persists; it survives a restart", async () => {
  let now = 5_000_000;
  const backing = memory();
  const clients = createExternalClients({ store: backing.store, keys: backing.keys, now: () => now });
  await clients.ready;
  await clients.setEnabled(true);
  const token = clients.issuePairing();
  assert.ok(typeof token === "object");
  const paired = (await clients.complete(clients.present(token.token, "Claude Desktop") as never, "Claude Desktop"))!;
  const secret = paired.credential.slice(33);
  assert.deepEqual([...backing.items.keys()], [paired.clientId]);
  assert.deepEqual(Buffer.from(backing.items.get(paired.clientId)!), sha(secret), "the verifier, never the credential");
  assert.ok(!JSON.stringify(backing.stored()).includes(secret), "nothing secret in the client list");
  assert.deepEqual(backing.stored(), { version: 2, enabled: true, revoked: [], clients: [{ id: paired.clientId, name: "Claude Desktop", createdAt: now, lastUsedAt: null, timeoutSec: 60 }] });

  assert.equal(clients.authenticate(paired.credential), paired.clientId);
  for (const bad of [`${paired.clientId}_${"A".repeat(43)}`, `${"0".repeat(32)}_${secret}`, secret, paired.credential.slice(0, -1), `${paired.credential}x`, ""])
    assert.equal(clients.authenticate(bad), undefined, bad);
  clients.touch(paired.clientId);
  assert.equal(clients.client(paired.clientId)!.lastUsedAt, now);
  now += 30_000;
  clients.touch(paired.clientId);
  assert.equal(clients.client(paired.clientId)!.lastUsedAt, now - 30_000, "written at most once a minute");
  assert.equal(await clients.setTimeout(paired.clientId, 9), false);
  assert.equal(await clients.setTimeout(paired.clientId, 3_601), false);
  assert.equal(await clients.setTimeout(paired.clientId, 120), true);

  // A restart reads the list and the verifier again.
  const restarted = createExternalClients({ store: backing.store, keys: backing.keys, now: () => now });
  await restarted.ready;
  assert.equal(restarted.authenticate(paired.credential), paired.clientId);
  assert.equal(restarted.client(paired.clientId)!.timeoutSec, 120);
  // Without its Keychain item nothing authenticates (fail closed).
  assert.equal(createExternalClients({ store: backing.store, keys: { ...backing.keys, read: async () => "error" } }).authenticate(paired.credential), undefined);
  // Off: refused, still paired.
  await restarted.setEnabled(false);
  assert.equal(restarted.authenticate(paired.credential), undefined);
  await restarted.setEnabled(true);

  const drops: (string | undefined)[] = [];
  restarted.onDrop((id) => drops.push(id));
  const revoking = restarted.revoke(paired.clientId);
  assert.equal(restarted.authenticate(paired.credential), undefined, "invalid before anything is written");
  assert.deepEqual(drops, [paired.clientId]);
  assert.equal(await revoking, true);
  assert.equal(backing.items.size, 0, "Keychain item deleted");
  assert.deepEqual(backing.stored().clients, []);
  assert.equal(await restarted.revoke(paired.clientId), false);

  // Review L4: a revoke whose Keychain delete fails is kept as `revoked` and retried at launch; a listed client without its
  // Keychain item (the list write failed after the delete) is dropped at launch. Neither comes back.
  const second = restarted.issuePairing();
  assert.ok(typeof second === "object");
  const again = (await restarted.complete(restarted.present(second.token, "Cursor") as never, "Cursor"))!;
  const failing = { ...backing.keys, delete: async () => false };
  const stuck = createExternalClients({ store: backing.store, keys: failing, now: () => now });
  await stuck.ready;
  assert.equal(await stuck.revoke(again.clientId), false, "reported");
  assert.deepEqual(backing.stored().revoked, [again.clientId]);
  assert.ok(backing.items.has(again.clientId), "the item is still there");
  const relaunched = createExternalClients({ store: backing.store, keys: backing.keys, now: () => now });
  await relaunched.ready;
  assert.equal(relaunched.authenticate(again.credential), undefined);
  assert.equal(backing.items.has(again.clientId), false, "deleted on the retry");
  assert.deepEqual(backing.stored().revoked, []);
  const third = relaunched.issuePairing();
  assert.ok(typeof third === "object");
  const orphan = (await relaunched.complete(relaunched.present(third.token, "Orphan") as never, "Orphan"))!;
  backing.items.delete(orphan.clientId);
  const dropped = createExternalClients({ store: backing.store, keys: backing.keys, now: () => now });
  await dropped.ready;
  assert.equal(dropped.client(orphan.clientId), undefined, "no Keychain item, no client");
  assert.deepEqual(backing.stored().clients, []);
  assert.deepEqual(parseExternalClients(new TextEncoder().encode(JSON.stringify({ version: 1, enabled: true, clients: [{ id: "x", name: "n", createdAt: 1, lastUsedAt: null, timeoutSec: 60 }] }))), { enabled: true, clients: [], revoked: [] });
  assert.deepEqual(parseExternalClients(new TextEncoder().encode("{}")), { enabled: false, clients: [], revoked: [] });
});

test("Keychain store: a fresh dev.ssterm.test namespace, round trip and delete, zero leftovers", { skip: process.platform !== "darwin" }, async () => {
  const namespace = `dev.ssterm.test.${randomUUID()}`;
  const keys = new KeychainMcpClientStore(namespace);
  assert.throws(() => new KeychainMcpClientStore("dev.ssterm.test.probe"));
  try {
    const id = "0123456789abcdef0123456789abcdef";
    assert.equal(await keys.read(id), "missing");
    assert.equal(await keys.write(id, sha("secret")), true);
    assert.deepEqual(Buffer.from(await keys.read(id) as Uint8Array), sha("secret"));
    assert.equal(await keys.write("../x", sha("secret")), false, "only a client id names an item");
    assert.equal(await keys.delete(id), true);
    assert.equal(await keys.read(id), "missing");
    assert.equal(await keys.delete(id), true, "already gone");
  } finally {
    assert.equal(await clearTestNamespace(namespace), 0);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Bindings in the runner (fake terminal endpoint) and the external role of the MCP endpoint.

const owner = { windowId: 1, generation: 1 };
const ownerId = sessionOwnerId(owner);
const other = { windowId: 2, generation: 1 };
type Issued = { credential: string; record?: (step: AgentStepRecord) => void; admit?: (reserve: boolean) => string | undefined; gate?: AgentGate; revoked: boolean; sessionId: string };

async function lab() {
  const folder = temp();
  const backing = memory();
  const clients = createExternalClients({ store: backing.store, keys: backing.keys });
  await clients.ready;
  await clients.setEnabled(true);
  const issued: Issued[] = [];
  const sessions: Record<string, Partial<SessionSnapshot>> = {
    s1: { id: "s1", kind: "terminal", generation: 1, state: "Ready", hostId: "h1", target: { label: "web", address: "web.example", port: 22, username: "ops", environment: "DEV", hostRevision: 1, catalogRevision: 1 } },
    s2: { id: "s2", kind: "terminal", generation: 1, state: "Ready", hostId: "h2", target: { label: "db", address: "db.example", port: 22, username: "ops", environment: "PROD", hostRevision: 1, catalogRevision: 1 } },
    s3: { id: "s3", kind: "terminal", generation: 1, state: "Ready", local: { shell: "/bin/zsh", platform: "darwin" } as never, hostId: null as never, target: undefined },
  };
  let stored: Uint8Array | undefined;
  const store: AgentSettingsStore = { read: async () => stored ? { status: "present", value: stored } : { status: "missing" }, write: async (value) => { stored = value; return "confirmed"; } };
  let open = true;
  const dropped: (string | undefined)[] = [];
  const runner = createAgentRunner({
    clients, socketPath: "/p/mcp/ssterm.sock", credentialFolder: "/h/.config/ssterm-mcp", accessible: () => open,
    terminals: {
      issue: async (_owner, sessionId, use = {}) => {
        if (sessions[sessionId]?.state !== "Ready") return undefined;
        const entry: Issued = { credential: `cred-${issued.length + 1}`, ...use, revoked: false, sessionId };
        issued.push(entry);
        return { credential: entry.credential, socketPath: "/p/mcp/ssterm.sock" };
      },
      revoke: (credential) => { const entry = issued.find((candidate) => candidate.credential === credential); if (entry) entry.revoked = true; },
      active: (credential) => !issued.find((candidate) => candidate.credential === credential)?.revoked,
      dropExternal: (clientId) => { dropped.push(clientId); },
    },
    registry: () => ({ snapshot: (id: string, session?: string) => id === ownerId && sessions[session ?? ""] ? [sessions[session!] as SessionSnapshot] : [] }),
    store, bridge: "/b/ssterm-mcp", tmp: folder, home: folder, profile: "/profile/one",
    resolve: async () => ({ status: "ready", path: "/fake/claude", version: "2.1.309" }),
    env: (tmp) => cliEnv({ home: folder, user: "u", tmp }),
  });
  const states: AgentState[] = [];
  const others: AgentState[] = [];
  runner.register(owner, (state) => states.push(state));
  runner.register(other, (state) => others.push(state));
  const hooks = runner.externalHooks;
  const pair = async (name = "Claude Desktop") => {
    const token = clients.issuePairing();
    assert.ok(typeof token === "object");
    const pairing = hooks.pair(token.token, name, new AbortController().signal);
    await tick();
    const request = states.at(-1)!.external.requests.at(-1)!;
    assert.deepEqual([request.kind, request.clientName], ["pair", name]);
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: request.id, decision: "approve" }), { status: "applied" });
    return (await pairing) as { clientId: string; credential: string };
  };
  const bind = async (clientId: string, sessionId = "s1") => {
    const binding = hooks.bind(clientId, true, new AbortController().signal);
    await tick();
    const request = states.at(-1)!.external.requests.find((entry) => entry.kind === "bind")!;
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: request.id, decision: "approve", sessionId, generation: 1 }), { status: "applied" });
    const credential = await binding;
    assert.equal(typeof credential, "string");
    return issued.find((entry) => entry.credential === credential)!;
  };
  const binding = (clientId: string): ExternalBindingView | undefined => states.at(-1)!.external.bindings.find((entry) => entry.clientId === clientId);
  return { folder, clients, runner, hooks, issued, sessions, states, others, dropped, pair, bind, binding, lock: (value: boolean) => { open = value; },
    cleanup: async () => { await runner.dispose(); rmSync(folder, { recursive: true, force: true }); } };
}
const live = () => new AbortController().signal;
const refusal = (value: string | { refuse: string }) => typeof value === "string" ? "" : value.refuse;

test("binding: clients see no sessions; the user picks a Ready SSH session (not local, not bound); Auto plans and cards apply per binding", async () => {
  const fixture = await lab();
  const { runner, hooks } = fixture;
  try {
    const first = await fixture.pair("Claude Desktop");
    assert.equal(hooks.authenticate(first.credential), first.clientId);
    assert.equal(await hooks.pair("x".repeat(43), "Other", live()), "pairing-refused");
    assert.ok(isAgentState(fixture.states.at(-1)));
    assert.match(refusal(await hooks.bind(first.clientId, false, live())), /No terminal is bound/u, "read_output/cancel never ask");
    // A binding request: the user denies, then binds a session.
    const denied = hooks.bind(first.clientId, true, live());
    await tick();
    const request = fixture.states.at(-1)!.external.requests[0]!;
    assert.deepEqual([request.kind, request.clientName], ["bind", "Claude Desktop"]);
    assert.deepEqual(fixture.others.at(-1)!.external.requests.map((entry) => entry.id), [request.id], "every window can answer");
    assert.match(refusal(await hooks.bind(first.clientId, true, live())), /already waiting/u);
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: request.id, decision: "approve", sessionId: "s3", generation: 1 }), { status: "refused", reason: "session" }, "not a local terminal");
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: request.id, decision: "approve", sessionId: "s1", generation: 2 }), { status: "refused", reason: "session" }, "that exact generation");
    assert.deepEqual(runner.answerExternal(other, { owner: other, requestId: request.id, decision: "approve", sessionId: "s1", generation: 1 }), { status: "refused", reason: "session" }, "the answering window's own session");
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: request.id, decision: "deny" }), { status: "applied" });
    assert.match(refusal(await denied), /denied/u);
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: request.id, decision: "deny" }), { status: "refused", reason: "stale" });

    const grant = await fixture.bind(first.clientId, "s1");
    const view = fixture.binding(first.clientId)!;
    assert.deepEqual([view.sessionId, view.mode, view.clientName, view.target.endpoint], ["s1", "auto", "Claude Desktop", "ops@web.example:22"]);
    assert.equal(fixture.others.at(-1)!.external.bindings.length, 0, "another window does not see it");
    assert.equal(await hooks.bind(first.clientId, false, live()), grant.credential, "kept for later calls");

    // A second client cannot use, see or take the first one's binding.
    const second = await fixture.pair("Cursor");
    assert.match(refusal(await hooks.bind(second.clientId, false, live())), /No terminal is bound/u);
    const asking = hooks.bind(second.clientId, true, live());
    await tick();
    const secondRequest = fixture.states.at(-1)!.external.requests.find((entry) => entry.kind === "bind")!;
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: secondRequest.id, decision: "approve", sessionId: "s1", generation: 1 }), { status: "refused", reason: "session" }, "already bound");
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: secondRequest.id, decision: "approve", sessionId: "s2", generation: 1 }), { status: "applied" });
    const secondCredential = await asking;
    const secondGrant = fixture.issued.find((entry) => entry.credential === secondCredential)!;
    assert.equal(secondGrant.sessionId, "s2");

    // Auto: read-only runs, anything else needs the plan or its own card; decided like any agent card.
    const gate = grant.gate!;
    assert.deepEqual(await gate.authorize("uptime", classifyReadOnly("uptime"), live()), { run: "uptime", via: "read-only" });
    const proposing = gate.propose({ goal: "Restart", commands: ["touch /tmp/a"] }, live());
    await tick();
    const plan = fixture.binding(first.clientId)!.task.plan!;
    assert.equal(plan.status, "pending");
    assert.deepEqual(runner.decide(owner, "s1", 1, plan.id, "approve", false), { status: "applied" });
    assert.equal(((await proposing).structuredContent as { status: string }).status, "approved");
    const planned = await gate.authorize("touch /tmp/a", classifyReadOnly("touch /tmp/a"), live());
    assert.deepEqual(["run" in planned && planned.run, "via" in planned && planned.via], ["touch /tmp/a", "plan"]);
    grant.record!({ command: "touch /tmp/a", status: "completed", exitCode: 0, output: "", truncated: false, via: "plan" });
    assert.deepEqual(fixture.binding(first.clientId)!.task.steps.map((step) => step.via), ["plan"]);

    // PROD (the second binding): approving needs the confirmation step.
    const prodCard = secondGrant.gate!.authorize("touch /tmp/b", classifyReadOnly("touch /tmp/b"), live());
    await tick();
    const card = fixture.binding(second.clientId)!.task.approval!;
    assert.deepEqual(runner.decide(owner, "s2", 1, card.id, "approve", false), { status: "refused", reason: "production" });
    assert.deepEqual(runner.decide(owner, "s1", 1, card.id, "approve", true), { status: "refused", reason: "stale" }, "bound to its session");
    assert.deepEqual(runner.decide(owner, "s2", 1, card.id, "approve", true), { status: "applied" });
    assert.deepEqual(await prodCard, { run: "touch /tmp/b", via: "approval" });

    // Mode per binding: Read only refuses; Full allow needs the warning and, on PROD, the Settings option.
    assert.deepEqual(runner.setMode(owner, "s1", 1, "read-only", false, true), { status: "set" });
    assert.match(refusal(await gate.authorize("touch /tmp/c", classifyReadOnly("touch /tmp/c"), live()) as never), /^Refused in Read only mode/u);
    assert.equal(fixture.binding(first.clientId)!.mode, "read-only");
    assert.deepEqual(runner.setMode(owner, "s1", 1, "full-allow", false, true), { status: "refused", reason: "acknowledge" });
    assert.deepEqual(runner.setMode(owner, "s2", 1, "full-allow", true, true), { status: "refused", reason: "production" });
    assert.deepEqual(runner.setMode(owner, "s1", 1, "full-allow", true, true), { status: "set" });
    assert.deepEqual(await gate.authorize("touch /tmp/d", classifyReadOnly("touch /tmp/d"), live()), { run: "touch /tmp/d", via: "full-allow" });
    assert.deepEqual(runner.setMode(owner, "s1", 1, "auto", false, false), { status: "refused", reason: "ended" }, "a conversation's mode is separate");

    // Stop ends it (credential revoked, a running command interrupted); the next call asks again.
    runner.stopExternal(owner, "s1");
    assert.equal(grant.revoked, true);
    assert.equal(fixture.binding(first.clientId), undefined);
    assert.match(grant.admit!(false)!, /binding has ended/u);
    assert.match(refusal(await hooks.bind(first.clientId, false, live())), /No terminal is bound/u);
  } finally { await fixture.cleanup(); }
});

test("review M1: a session has an ssterm agent conversation or an external binding, never both", async () => {
  const fixture = await lab();
  const { runner, hooks } = fixture;
  try {
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "", allowFullAllowOnProd: false, custom: null }, true);
    const client = await fixture.pair();
    // Bound first: the agent panel cannot open there.
    await fixture.bind(client.clientId, "s1");
    assert.deepEqual(await runner.open(owner, "s1", 1), { status: "refused", reason: "external" });
    // A conversation first: the session is not offered or accepted for a binding.
    assert.deepEqual(await runner.open(owner, "s2", 1), { status: "opened" });
    runner.stopExternal(owner, "s1");
    const asking = hooks.bind(client.clientId, true, live());
    await tick();
    const request = fixture.states.at(-1)!.external.requests.find((entry) => entry.kind === "bind")!;
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: request.id, decision: "approve", sessionId: "s2", generation: 1 }), { status: "refused", reason: "session" });
    await runner.close(owner, "s2");
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: request.id, decision: "approve", sessionId: "s2", generation: 1 }), { status: "applied" });
    assert.equal(typeof await asking, "string");
    assert.deepEqual(await runner.open(owner, "s2", 1), { status: "refused", reason: "external" });
  } finally { await fixture.cleanup(); }
});

test("binding ends with its session, a lock (a new binding is then needed) and a revoke; requests are withdrawn; cards expire before the client's tool timeout", async () => {
  const fixture = await lab();
  const { runner, hooks, clients } = fixture;
  try {
    const client = await fixture.pair();
    // Session end.
    let grant = await fixture.bind(client.clientId);
    runner.observe({ ownerId, sessionId: "s1", generation: 1, local: false, hostId: "h1", label: "web", endpoint: null, environment: "DEV" })!.end();
    assert.equal(grant.revoked, true);
    assert.equal(fixture.binding(client.clientId), undefined);

    // Lock: bindings and pending requests go; the credential stays; a locked workspace refuses the client.
    grant = await fixture.bind(client.clientId);
    const waiting = grant.gate!.propose({ goal: "g", commands: ["touch /tmp/a"] }, live());
    const pairing = hooks.pair("x".repeat(43), "Other", live());
    const binding2 = hooks.bind((await fixture.pair("Cursor")).clientId, true, live());
    await tick();
    fixture.lock(false);
    await runner.lock();
    assert.equal(grant.revoked, true);
    assert.equal(((await waiting).structuredContent as { status: string }).status, "cancelled");
    assert.equal(await pairing, "pairing-refused");
    assert.match(refusal(await binding2), /withdrawn|no longer paired|locked/u);
    assert.deepEqual({ ...fixture.states.at(-1)!.external, clients: 0 }, { requests: [], bindings: [], clients: 0 });
    assert.equal(hooks.authenticate(client.credential), undefined, "refused while locked");
    assert.equal(hooks.valid(client.clientId), false);
    fixture.lock(true);
    assert.equal(hooks.authenticate(client.credential), client.clientId, "the credential remains");
    assert.match(refusal(await hooks.bind(client.clientId, false, live())), /No terminal is bound/u, "a new binding is required");

    // Revoke: binding ended, connections dropped, credential refused.
    grant = await fixture.bind(client.clientId);
    await clients.revoke(client.clientId);
    assert.equal(grant.revoked, true);
    assert.ok(fixture.dropped.includes(client.clientId));
    assert.equal(hooks.authenticate(client.credential), undefined);
    assert.match(refusal(await hooks.bind(client.clientId, true, live())), /no longer paired/u);

    // Approved, but the connection closed before the credential could be sent: it does not stay valid unseen.
    const gone = new AbortController();
    const token = clients.issuePairing();
    assert.ok(typeof token === "object");
    const undelivered = hooks.pair(token.token, "Gone", gone.signal);
    await tick();
    const pending = fixture.states.at(-1)!.external.requests.at(-1)!;
    assert.deepEqual(runner.answerExternal(owner, { owner, requestId: pending.id, decision: "approve" }), { status: "applied" });
    gone.abort();
    assert.equal(await undelivered, "pairing-refused");
    assert.equal(clients.list().some((entry) => entry.name === "Gone"), false);

    // A client's cards expire 5 s before its tool timeout (10 s here), saying so.
    const short = await fixture.pair("Short");
    await clients.setTimeout(short.clientId, 10);
    const shortGrant = await fixture.bind(short.clientId);
    const started = Date.now();
    const expired = await shortGrant.gate!.authorize("touch /tmp/e", classifyReadOnly("touch /tmp/e"), live());
    assert.ok(Date.now() - started >= 4_900 && Date.now() - started < 8_000);
    assert.match(refusal(expired as never), /stops waiting for a tool call after 10 seconds, so the card expired/u);

    // Turning the feature off ends every binding and drops every external connection.
    await runner.updateExternalClients({ type: "enable", enabled: false });
    assert.equal(shortGrant.revoked, true);
    assert.ok(fixture.dropped.includes(undefined));
  } finally { await fixture.cleanup(); }
});

test("settings IPC contract: actions validated; pairing returns the token once; answer shapes are exact", async () => {
  const fixture = await lab();
  try {
    const view = await fixture.runner.externalClients();
    assert.deepEqual({ ...view, clients: [] }, { enabled: true, available: true, socketPath: "/p/mcp/ssterm.sock", bridgePath: "/b/ssterm-mcp", credentialFolder: "/h/.config/ssterm-mcp", clients: [] });
    const paired = await fixture.runner.updateExternalClients({ type: "pair" });
    assert.ok(paired.status === "saved" && paired.pairing && /^[A-Za-z0-9_-]{43}$/u.test(paired.pairing.token));
    for (const action of [{ type: "pair" }, { type: "enable", enabled: true }, { type: "revoke", clientId: "a".repeat(32) }, { type: "timeout", clientId: "a".repeat(32), seconds: 60 }])
      assert.ok(isUpdateExternalClientsRequest({ owner, action }), JSON.stringify(action));
    for (const action of [{ type: "pair", token: "x" }, { type: "timeout", clientId: "a".repeat(32), seconds: 5 }, { type: "revoke", clientId: "../x" }, { type: "enable" }])
      assert.equal(isUpdateExternalClientsRequest({ owner, action }), false, JSON.stringify(action));
    assert.ok(isAnswerExternalRequest({ owner, requestId: "bind-0000abcd-1", decision: "approve", sessionId: "s1", generation: 1 }));
    assert.equal(isAnswerExternalRequest({ owner, requestId: "pair-0000abcd-1", decision: "approve", sessionId: "s1", generation: 1 }), false, "a pairing names no session");
    assert.equal(isAnswerExternalRequest({ owner, requestId: "bind-0000abcd-1", decision: "approve" }), false, "a binding names its session");
    assert.deepEqual(await fixture.runner.updateExternalClients({ type: "revoke", clientId: "a".repeat(32) }), { status: "refused", reason: "unknown-client" });
  } finally { await fixture.cleanup(); }
});

test("MCP endpoint, external role: pairing line → user approval → credential line once, queued lines then served; terminal tools only; bad tokens, revoke and lock close the connection; the bridge pairs over stdio and keeps a 0600 credential file", async () => {
  const folder = temp();
  const socketPath = join(folder, "mcp", "ssterm.sock");
  const agents = createAgentTerminals({ registry: () => undefined, socketPath, version: "0.1.0" });
  let approve = true;
  const asked: string[] = [];
  const paired = new Set<string>();
  const hooks: ExternalHooks = {
    enabled: () => true,
    authenticate: (credential) => credential === `${"c".repeat(32)}_${"S".repeat(43)}` && paired.has("c".repeat(32)) ? "c".repeat(32) : undefined,
    valid: (clientId) => paired.has(clientId),
    pair: async (token, name) => {
      asked.push(`${String(token).slice(0, 4)}:${String(name)}`);
      await new Promise((done) => setTimeout(done, 50));
      if (name === "Taken") return "name-in-use";
      if (!approve || token !== "T".repeat(43)) return "pairing-refused";
      paired.add("c".repeat(32));
      return { clientId: "c".repeat(32), credential: `${"c".repeat(32)}_${"S".repeat(43)}` };
    },
    bind: async () => ({ refuse: "No terminal is bound to this client." }),
    undelivered: () => undefined,
  };
  agents.serveExternal(hooks);
  assert.equal(await agents.listenExternal(), true);
  assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  const open = async (first: object) => {
    const socket = connect(socketPath);
    await once(socket, "connect");
    socket.setEncoding("utf8");
    const lines: any[] = [];
    let buffer = "";
    socket.on("data", (chunk: string) => { buffer += chunk; for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); } });
    const closed = once(socket, "close");
    socket.write(`${JSON.stringify(first)}\n`);
    return { socket, lines, closed };
  };
  try {
    // Wrong token: one error line, then closed; no credential.
    const wrong = await open({ pair: "W".repeat(43), name: "Bad" });
    await wrong.closed;
    assert.deepEqual(wrong.lines, [{ error: "pairing-refused" }]);
    const taken = await open({ pair: "T".repeat(43), name: "Taken" });
    await taken.closed;
    assert.deepEqual(taken.lines, [{ error: "name-in-use" }]);
    // A client credential nobody issued: the same; an ssterm agent's credential format still gets no answer.
    const forged = await open({ credential: `${"c".repeat(32)}_${"S".repeat(43)}` });
    await forged.closed;
    assert.deepEqual(forged.lines, [{ error: "credential-rejected" }]);
    const agentFormat = await open({ credential: "A".repeat(43) });
    await agentFormat.closed;
    assert.deepEqual(agentFormat.lines, []);
    // Pairing: the client initializes at once; its lines wait for the decision.
    const client = await open({ pair: "T".repeat(43), name: "Claude Desktop" });
    client.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    client.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    client.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_command", arguments: { command: "ls" } } })}\n`);
    for (let i = 0; i < 100 && client.lines.length < 4; i++) await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(client.lines[0], { credential: `${"c".repeat(32)}_${"S".repeat(43)}` }, "the credential, once, first");
    assert.equal(client.lines[1].result.serverInfo.name, "ssterm");
    assert.deepEqual(client.lines[2].result.tools.map((tool: { name: string }) => tool.name), TOOLS.map((tool) => tool.name));
    assert.deepEqual(client.lines[3].result, { content: [{ type: "text", text: "No terminal is bound to this client." }], isError: true });
    // The same credential later; revoke drops it.
    const later = await open({ credential: `${"c".repeat(32)}_${"S".repeat(43)}` });
    later.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions", arguments: {} } })}\n`);
    for (let i = 0; i < 100 && !later.lines.length; i++) await new Promise((done) => setTimeout(done, 10));
    assert.match(later.lines[0].result.content[0].text, /^Unknown tool: list_sessions/u, "no session listing");
    agents.dropExternal("c".repeat(32));
    await Promise.all([client.closed, later.closed]);

    // The bundled bridge over stdio: pairs, writes the credential file (0600), then pipes MCP unchanged; next time it uses the file.
    paired.clear();
    const file = join(folder, "client", "claude.credential");
    const env = { PATH: "/usr/bin:/bin", SSTERM_MCP_SOCKET: socketPath, SSTERM_MCP_CREDENTIAL_FILE: file, SSTERM_MCP_PAIRING_TOKEN: "T".repeat(43), SSTERM_MCP_CLIENT_NAME: "Claude Desktop (test)" };
    const run = (input: string, extra: Record<string, string> = {}) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      const child = execFile("/bin/sh", [resolve("apps/desktop/resources/ssterm-mcp")], { env: { ...env, ...extra }, timeout: 10_000 }, (error, stdout, stderr) =>
        done({ code: error ? (error as { code?: number }).code ?? 1 : 0, stdout, stderr }));
      child.stdin!.write(input);
      setTimeout(() => child.stdin!.end(), 400);
    });
    const ping = `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })}\n`;
    const first = await run(ping);
    assert.equal(first.stdout, `${JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })}\n`, first.stderr);
    assert.equal(readFileSync(file, "utf8"), `${"c".repeat(32)}_${"S".repeat(43)}\n`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(folder, "client")).mode & 0o777, 0o700);
    assert.equal(asked.at(-1), "TTTT:Claude Desktop (test)");
    const second = await run(ping, { SSTERM_MCP_PAIRING_TOKEN: "" });
    assert.equal(second.stdout, `${JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} })}\n`, "the credential file is used");
    assert.equal(asked.length, 4, "no second pairing");
    // A refused pairing: nothing written, a clear error.
    approve = false;
    const refusedFile = join(folder, "client", "refused.credential");
    const refused = await run(ping, { SSTERM_MCP_CREDENTIAL_FILE: refusedFile });
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /pairing was refused or expired/u);
    assert.throws(() => statSync(refusedFile));
    assert.match((await run(ping, { SSTERM_MCP_CREDENTIAL_FILE: refusedFile, SSTERM_MCP_CLIENT_NAME: 'x"y' })).stderr, /unsupported characters/u);
    assert.match((await run(ping, { SSTERM_MCP_CREDENTIAL_FILE: refusedFile, SSTERM_MCP_CLIENT_NAME: "Taken" })).stderr, /already has this name/u);
    // Review L1: a stored credential that is refused (revoked here) is reported at once, exit 77, without waiting for stdin.
    paired.clear();
    const rejectedAt = Date.now();
    const rejected = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = execFile("/bin/sh", [resolve("apps/desktop/resources/ssterm-mcp")], { env: { ...env, SSTERM_MCP_PAIRING_TOKEN: "" }, timeout: 10_000 }, (error, _stdout, stderr) =>
        done({ code: error ? (error as { code?: number }).code ?? 1 : 0, stderr }));
      child.stdin!.write(ping);
    });
    assert.equal(rejected.code, 77);
    assert.match(rejected.stderr, /refused this credential/u);
    assert.ok(Date.now() - rejectedAt < 5_000, "the client's stdin stayed open");

    // Lock: every connection dropped; with external clients on, the socket is back at once.
    paired.add("c".repeat(32));
    const again = await open({ credential: `${"c".repeat(32)}_${"S".repeat(43)}` });
    await new Promise((done) => setTimeout(done, 50));
    agents.lock();
    await again.closed;
    for (let i = 0; i < 100; i++) { try { statSync(socketPath); break; } catch { await new Promise((done) => setTimeout(done, 10)); } }
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  } finally {
    agents.dispose();
    rmSync(folder, { recursive: true, force: true });
  }
});
