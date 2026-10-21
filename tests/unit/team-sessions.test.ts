import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import ssh2, { type Connection } from "ssh2";
import type { ResolvedHostConfig, SecretProvider } from "../../packages/domain/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { createSavedHostSessions } from "../../apps/desktop/src/main/ssh.ts";
import { TransientSecrets } from "../../packages/services/src/transient.ts";
import { SessionRegistry, type SessionResolveContext, type SessionSnapshot } from "../../packages/services/src/sessions.ts";
import { TeamSessionGuard, type ManagedTeamSessionClient, type TeamSessionAccessChange } from "../../packages/services/src/team-session-guard.ts";
import { ed25519 } from "./ssh-keys.ts";

const ownedPassword = "owned-team-fixture-password";
const virtualId = () => `7ea03700-${randomUUID().slice(9, 14)}8${randomUUID().slice(15)}`;
const source = () => ({
  kind: "team" as const, teamId: randomUUID(), principalId: randomUUID(), deviceId: randomUUID(),
  recordId: randomUUID(), policyHash: "a".repeat(64), metadataHash: "b".repeat(64),
  credentialHash: "c".repeat(64), leaseId: randomUUID(),
});
function config(id: string, port = 22): ResolvedHostConfig {
  return {
    source: source(), hostRef: { id, revision: 1, label: "Team fixture", groupId: null },
    address: "127.0.0.1", port: { value: port, source: { kind: "default" } }, environment: "PROD",
    auth: { selection: "identity", source: { kind: "default" }, key: null, identity: {
      id: randomUUID(), vaultId: randomUUID(), revision: 1, createdAt: "fixture", updatedAt: "fixture",
      label: "Managed team", username: "fixture", method: "password", passwordRef: null, keyId: null,
    } }, ancestry: [], catalogRevision: 1,
  };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(check(), "Expected fixture state within five seconds");
}
function fakeClient(resolved: ResolvedHostConfig) {
  let observer: ((event: TeamSessionAccessChange) => void) | undefined;
  const contexts: SessionResolveContext[] = [];
  const passwords: Uint8Array[] = [];
  let allowed = true, loads = 0, fetches = 0, bound = true, offline = false;
  let resolveHook: (() => Promise<void>) | undefined;
  let loadHook: (() => Promise<void>) | undefined;
  const client: ManagedTeamSessionClient = {
    hasVirtualBinding: (id) => bound && id === resolved.hostRef.id,
    async resolveCapturedHost({ session }) {
      contexts.push(session);
      await resolveHook?.();
      return allowed ? { ok: true, value: resolved } : { ok: false, code: "unauthorized" };
    },
    async loadManagedPassword() {
      loads++;
      await loadHook?.();
      if (!allowed) return { ok: false, code: "unauthorized" };
      const bytes = Buffer.from(ownedPassword);
      passwords.push(bytes);
      return { ok: true, value: { bytes, dispose() { bytes.fill(0); } } };
    },
    observePolicy(listener) { observer = listener; return () => { observer = undefined; }; },
    async fetch() { fetches++; if (offline) throw new Error("owned-offline-fixture"); },
  };
  return {
    client, contexts, passwords, loads: () => loads, fetches: () => fetches,
    allow(value: boolean) { allowed = value; }, binding(value: boolean) { bound = value; },
    offline(value: boolean) { offline = value; },
    gateResolve(hook: () => Promise<void>) { resolveHook = hook; }, gateLoad(hook: () => Promise<void>) { loadHook = hook; },
    notify(canConnect: boolean) {
      observer?.({ ...resolved.source!, role: canConnect ? "Connector" : "Viewer", canConnect });
    },
  };
}
async function fixture(t: TestContext, options: { team?: boolean } = {}) {
  const dir = mkdtempSync("/private/tmp/ssterm-team-sessions-");
  const opened = await openMetadata({ path: join(dir, "metadata.db") });
  assert(opened.ok);
  const repository = opened.value;
  const clients: Connection[] = [];
  const methods: string[] = [];
  const server = new ssh2.Server({ hostKeys: [ed25519().private] });
  server.on("connection", (client) => {
    clients.push(client);
    client.on("error", () => {});
    client.on("authentication", (auth) => {
      methods.push(auth.method);
      if (auth.method === "password" && auth.password === ownedPassword) auth.accept(); else auth.reject(["password"]);
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("shell", (acceptShell) => acceptShell().write("owned team output"));
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address(); assert(address && typeof address !== "string");
  const id = virtualId(), resolved = config(id, address.port), team = fakeClient(resolved);
  let personalReads = 0;
  const provider: SecretProvider = {
    async read() { personalReads++; return { status: "present", value: Buffer.from(ownedPassword) }; },
    async lookup() { return { status: "missing" }; }, async write() { return { status: "confirmed" }; },
    async delete() { return { status: "confirmed" }; },
  };
  const runtime = createSavedHostSessions({ repository, provider, transient: new TransientSecrets(), power: new EventEmitter(),
    ...(options.team === false ? {} : { team: team.client }) });
  const snapshots: SessionSnapshot[] = [];
  runtime.registry.subscribe("owner", (snapshot) => snapshots.push(snapshot));
  const current = () => runtime.registry.snapshot("owner")[0]!;
  t.after(async () => {
    await runtime.shutdown();
    for (const client of clients) client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    repository.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { runtime, repository, resolved, id, team, methods, snapshots, current, personalReads: () => personalReads,
    connect(kind: "terminal" | "sftp" | "tunnel" = "terminal") { return runtime.registry.connect("owner", id, kind); },
    trust() {
      const currentSnapshot = current(); assert.equal(currentSnapshot.prompt?.kind, "host-trust");
      assert(runtime.registry.answerPrompt("owner", currentSnapshot.id, currentSnapshot.generation, currentSnapshot.prompt!.id,
        { kind: "host-trust", decision: "accept-once" }).ok);
    },
  };
}

test("managed real SSH loads password after host trust and keeps owned bytes/provenance out of snapshots", async (t) => {
  const f = await fixture(t);
  assert(f.connect().ok);
  await until(() => f.current().prompt?.kind === "host-trust");
  assert.equal(f.team.loads(), 0); assert.deepEqual(f.methods, []);
  const initial = f.team.contexts[0]!;
  assert.equal(initial.ownerId, "owner"); assert.equal(initial.sessionId, f.current().id);
  assert.equal(initial.generation, 1); assert.equal(initial.kind, "terminal");
  f.trust();
  await until(() => f.current().state === "Ready");
  assert.equal(f.current().target?.source, "team"); assert.equal(f.current().target?.environment, "PROD");
  assert.equal(f.team.loads(), 1); assert.equal(f.personalReads(), 0); assert.deepEqual(f.methods, ["password"]);
  assert(f.team.passwords.every((bytes) => bytes.every((byte) => byte === 0)));
  assert(!f.snapshots.some((snapshot) => snapshot.prompt?.kind === "credentials"));
  assert(!JSON.stringify(f.snapshots).includes(ownedPassword));
  assert(!JSON.stringify(f.snapshots).includes(f.resolved.source!.leaseId));
  assert(Object.isFrozen(initial));
});

test("post-trust online policy denial never authenticates or prompts/reads personal credentials", async (t) => {
  const f = await fixture(t);
  assert(f.connect().ok);
  await until(() => f.current().prompt?.kind === "host-trust");
  f.team.allow(false);
  f.trust();
  await until(() => f.current().state === "Failed");
  assert.equal(f.current().error?.code, "auth-denied");
  assert.equal(f.team.loads(), 1); assert.equal(f.personalReads(), 0); assert.deepEqual(f.methods, []);
  assert(!f.snapshots.some((snapshot) => snapshot.prompt?.kind === "credentials"));
});

test("observed revocation closes a managed pending trust prompt and active sessions across window owners", async (t) => {
  const f = await fixture(t);
  assert(f.connect().ok);
  await until(() => !!f.current().prompt);
  f.trust(); await until(() => f.current().state === "Ready");
  assert(f.runtime.registry.connect("other-owner", f.id).ok);
  await until(() => !!f.runtime.registry.snapshot("other-owner")[0]?.prompt);
  f.team.notify(false);
  await until(() => f.current().state === "Closed" && f.runtime.registry.snapshot("other-owner")[0]?.state === "Closed");
  assert(f.team.contexts.every((context) => context.signal.aborted));
  assert.equal(f.team.loads(), 1); assert.equal(f.personalReads(), 0);
});

test("managed reconnect re-enters resolver with a fresh exact generation", async (t) => {
  const f = await fixture(t);
  assert(f.connect().ok); await until(() => !!f.current().prompt); f.trust();
  await until(() => f.current().state === "Ready");
  const id = f.current().id;
  await f.runtime.registry.close("owner", id);
  assert(f.runtime.registry.reconnect("owner", id, 1).ok);
  await until(() => f.current().generation === 2 && !!f.current().prompt);
  f.trust(); await until(() => f.current().state === "Ready");
  assert.equal(f.team.contexts.length, 2); assert.equal(f.team.contexts[1]!.sessionId, id);
  assert.equal(f.team.contexts[1]!.generation, 2); assert.notEqual(f.team.contexts[0]!.signal, f.team.contexts[1]!.signal);
  assert.equal(f.team.loads(), 2);
});

test("managed SFTP/tunnel requests and unknown/missing-client reserved UUID collisions fail before personal fallback", async (t) => {
  for (const mode of ["sftp", "tunnel", "unbound", "tombstone", "no-client"] as const) {
    const f = await fixture(t, { team: mode !== "no-client" });
    if (mode === "unbound") f.team.binding(false);
    if (mode === "tombstone") f.team.allow(false);
    const before = f.repository.snapshot(); assert(before.ok);
    const identityId = randomUUID();
    assert(f.repository.commit({ expectedCatalogRevision: before.value.catalogRevision, changes: [
      { type: "create-identity", id: identityId, data: { label: "Collision", username: "fixture", method: "password" } },
      { type: "create-host", id: f.id, data: { label: "Collision", address: "127.0.0.1", port: { mode: "value", port: f.resolved.port.value },
        auth: { mode: "value", identityId } } },
    ] }).ok);
    assert(f.connect(mode === "sftp" || mode === "tunnel" ? mode : "terminal").ok);
    await until(() => f.current().state === "Failed");
    assert.equal(f.current().error?.code, "invalid-config", mode);
    assert.equal(f.team.contexts.length, mode === "tombstone" ? 1 : 0, mode); assert.equal(f.team.loads(), 0, mode);
    assert.equal(f.personalReads(), 0, mode); assert.deepEqual(f.methods, [], mode);
    assert(!f.current().prompt, mode);
  }
});

test("guard registers before ACL await, fences late replies, and closes only managed attempts", async (t) => {
  const resolved = config(virtualId()), team = fakeClient(resolved);
  let release!: () => void;
  team.gateResolve(() => new Promise<void>((resolve) => { release = resolve; }));
  const closed: SessionResolveContext[] = [];
  const guard = new TeamSessionGuard({ client: team.client, close: (session) => closed.push(session) });
  t.after(() => guard.dispose());
  const session: SessionResolveContext = { ownerId: "owner", sessionId: randomUUID(), generation: 7, kind: "terminal", signal: new AbortController().signal };
  const pending = guard.resolve(resolved.hostRef.id, session);
  assert.equal(team.contexts.length, 1);
  team.notify(false);
  assert.deepEqual(closed, [session]);
  release(); assert.equal((await pending).ok, false);
});

test("guard polls only while managed sessions exist and observing an offline failure does not revoke live SSH", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const resolved = config(virtualId()), team = fakeClient(resolved), closed: SessionResolveContext[] = [];
  const guard = new TeamSessionGuard({ client: team.client, close: (session) => closed.push(session) });
  const abort = new AbortController();
  const session: SessionResolveContext = { ownerId: "owner", sessionId: randomUUID(), generation: 1, kind: "terminal", signal: abort.signal };
  t.after(() => guard.dispose());
  assert((await guard.resolve(resolved.hostRef.id, session)).ok);
  team.offline(true);
  t.mock.timers.tick(14_999); await Promise.resolve(); assert.equal(team.fetches(), 0);
  t.mock.timers.tick(1); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(team.fetches(), 1); assert.deepEqual(closed, []);
  abort.abort(); t.mock.timers.tick(60_000); await Promise.resolve(); assert.equal(team.fetches(), 1);
});

test("guard lock/dispose reject late resolution without closing unrelated personal/local registry generations", async (t) => {
  const resolved = config(virtualId()), team = fakeClient(resolved);
  const registry = new SessionRegistry({ resolve: () => ({ ok: true, value: { ...resolved, source: undefined } }),
    transient: new TransientSecrets(), adapter: { start() {} }, localAdapter: { metadata: { shell: "/bin/zsh", platform: "darwin" }, start() {} } });
  t.after(() => registry.dispose());
  const personal = registry.connect("personal", randomUUID()), local = registry.connectLocal("local");
  assert(personal.ok && local.ok);
  const closed: SessionResolveContext[] = [];
  const guard = new TeamSessionGuard({ client: team.client, close: (session) => closed.push(session) });
  const session: SessionResolveContext = { ownerId: "team", sessionId: randomUUID(), generation: 1, kind: "terminal", signal: new AbortController().signal };
  assert((await guard.resolve(resolved.hostRef.id, session)).ok);
  guard.lock(); assert.deepEqual(closed, [session]);
  assert.equal(registry.snapshot("personal")[0]!.state, "Connecting");
  assert.equal(registry.snapshot("local")[0]!.state, "Connecting");
  guard.dispose(); assert.equal((await guard.resolve(resolved.hostRef.id, session)).ok, false);
});

test("a late managed password after cancellation is disposed and never reaches SSH authentication", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.team.gateLoad(() => new Promise<void>((resolve) => { release = resolve; }));
  assert(f.connect().ok); await until(() => !!f.current().prompt); f.trust();
  await until(() => f.team.loads() === 1);
  await f.runtime.registry.cancel("owner", f.current().id);
  release();
  await until(() => f.team.passwords.length === 1);
  assert(f.team.passwords[0]!.every((byte) => byte === 0));
  assert.deepEqual(f.methods, []); assert.equal(f.personalReads(), 0);
});

test("invalid managed password buffers fail closed and are wiped even if disposal throws", async (t) => {
  for (const mode of ["empty", "oversize", "dispose-throws"] as const) {
    const f = await fixture(t);
    const bytes = Buffer.alloc(mode === "empty" ? 0 : mode === "oversize" ? 16_385 : 12, 7);
    f.team.client.loadManagedPassword = async () => ({ ok: true, value: { bytes,
      dispose() { if (mode === "dispose-throws") throw new Error("fixture-only"); bytes.fill(0); },
    } });
    assert(f.connect().ok); await until(() => !!f.current().prompt); f.trust();
    await until(() => f.current().state === "Failed");
    assert.equal(f.current().error?.code, "credentials-unavailable");
    assert(bytes.every((byte) => byte === 0)); assert.deepEqual(f.methods, []); assert.equal(f.personalReads(), 0);
    assert(!f.snapshots.some((snapshot) => snapshot.prompt?.kind === "credentials"));
  }
});

test("managed hosts retain shared changed-host-key blocking before any team password authorization", async (t) => {
  const f = await fixture(t);
  const previous = ed25519().public;
  const accepted = await f.runtime.policy.verify({ endpointHost: f.resolved.address, endpointPort: f.resolved.port.value,
    publicKey: Buffer.from(previous.split(" ")[1]!, "base64"), signal: new AbortController().signal,
    requestDecision: async () => "remember",
  });
  assert(accepted.ok);
  assert(f.connect().ok); await until(() => !!f.current().prompt);
  const snapshot = f.current();
  assert(snapshot.prompt?.kind === "host-trust" && snapshot.prompt.status === "changed");
  assert.equal(f.team.loads(), 0); assert.equal(f.personalReads(), 0); assert.deepEqual(f.methods, []);
  assert(f.runtime.registry.answerPrompt("owner", snapshot.id, snapshot.generation, snapshot.prompt.id,
    { kind: "host-trust", decision: "reject" }).ok);
  await until(() => f.current().state === "Failed");
  assert.equal(f.current().error?.code, "host-key-changed"); assert.equal(f.team.loads(), 0);
});

test("managed routes cannot introduce jumps/proxies or missing source credentials through the shared resolver", async (t) => {
  for (const mode of ["jump", "proxy", "missing-source"] as const) {
    const f = await fixture(t);
    if (mode === "jump") f.resolved.jumps = [config(randomUUID(), f.resolved.port.value)];
    if (mode === "proxy") f.resolved.proxy = { type: "socks5", host: "127.0.0.1", port: 9 };
    if (mode === "missing-source") delete f.resolved.source;
    assert(f.connect().ok); await until(() => f.current().state === "Failed");
    assert.equal(f.current().error?.code, "invalid-config");
    assert.equal(f.team.loads(), 0); assert.equal(f.personalReads(), 0); assert.deepEqual(f.methods, []);
    assert(!f.current().prompt);
  }
});

test("a validated replacement of the local authority device closes sessions captured for its previous device", async (t) => {
  const resolved = config(virtualId()), team = fakeClient(resolved), closed: SessionResolveContext[] = [];
  const guard = new TeamSessionGuard({ client: team.client, close: (session) => closed.push(session) });
  t.after(() => guard.dispose());
  const session: SessionResolveContext = { ownerId: "owner", sessionId: randomUUID(), generation: 1, kind: "terminal", signal: new AbortController().signal };
  assert((await guard.resolve(resolved.hostRef.id, session)).ok);
  resolved.source = { ...resolved.source!, deviceId: randomUUID() };
  team.notify(true);
  assert.deepEqual(closed, [session]);
});
