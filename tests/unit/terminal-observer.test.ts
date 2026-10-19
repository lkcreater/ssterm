import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ObservedTerminal, ResolvedHostConfig, TerminalChannel, TerminalObserver } from "../../packages/domain/src/index.ts";
import { SessionRegistry, TransientSecrets, type LocalSessionContext, type SessionContext } from "../../packages/services/src/index.ts";

const config: ResolvedHostConfig = {
  hostRef: { id: "host-1", revision: 1, label: "Owned fixture", groupId: null }, address: "127.0.0.1", environment: "PROD",
  port: { value: 2222, source: { kind: "default" } },
  auth: { selection: "identity", source: { kind: "default" }, key: null, identity: {
    id: "identity-1", vaultId: "vault-1", revision: 1, createdAt: "fixture", updatedAt: "fixture", label: "fixture identity",
    username: "fixture", method: "password", passwordRef: "OPAQUE", keyId: null } },
  ancestry: [], catalogRevision: 1,
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
/** A channel whose producer the test drives through `emit`. */
function channel() {
  let sink: ((chunk: Uint8Array, sequence: number) => void) | undefined;
  let sequence = 0;
  const value: TerminalChannel = {
    open(output) { if (sink) return false; sink = output; return true; },
    ack() {}, write: () => "ok", resize() {}, dispose() { sink = undefined; }, drained: Promise.resolve(),
  };
  return { value, emit: (text: string) => sink?.(new TextEncoder().encode(text), sequence++) };
}
function harness(observe: (session: ObservedTerminal) => TerminalObserver | undefined) {
  const contexts: SessionContext[] = [];
  const locals: LocalSessionContext[] = [];
  const registry = new SessionRegistry({
    resolve: () => ({ ok: true, value: config }), transient: new TransientSecrets(), observeTerminal: observe,
    adapter: { start(context) { contexts.push(context); } },
    localAdapter: { metadata: { shell: "/bin/zsh", platform: "darwin" }, start(context) { locals.push(context); } },
  });
  /** Connects one SSH generation of `kind` to Ready with a fresh channel. */
  const ready = async (kind: "terminal" | "sftp" | "tunnel" = "terminal") => {
    const opened = registry.connect("owner-1", "host-1", kind);
    assert.ok(opened.ok);
    await tick();
    const context = contexts.at(-1)!;
    assert.ok(context.verifyingHost() && context.authenticating());
    const stream = channel();
    const adopted = kind === "terminal" ? stream.value
      : kind === "sftp" ? { dispose() {}, drained: Promise.resolve(), list() {} } as never : { dispose() {}, drained: Promise.resolve(), forward() {} } as never;
    assert.equal(context.ready(adopted), true);
    return { id: opened.value.id, context, stream };
  };
  return { registry, contexts, locals, ready };
}
function recorder() {
  const events: string[] = [];
  const observed: ObservedTerminal[] = [];
  const observe = (session: ObservedTerminal): TerminalObserver => {
    observed.push(session);
    return { output: (chunk) => events.push(`out:${new TextDecoder().decode(chunk)}`), end: () => events.push(`end:${session.generation}`) };
  };
  return { events, observed, observe };
}

test("observeTerminal runs once per terminal generation, never for SFTP or tunnels, and sees the view's frames in order", async () => {
  const r = recorder();
  const h = harness(r.observe);
  await h.ready("sftp");
  await h.ready("tunnel");
  assert.equal(r.observed.length, 0);
  const { id, stream } = await h.ready();
  assert.deepEqual(r.observed, [{ ownerId: "owner-1", sessionId: id, generation: 1, hostId: "host-1", local: false, label: "Owned fixture",
    endpoint: "fixture@127.0.0.1:2222", environment: "PROD" }]);
  const view: string[] = [];
  const terminal = h.registry.terminal("owner-1", id, 1)!;
  assert.equal(terminal.open((chunk) => { view.push(new TextDecoder().decode(chunk)); r.events.push("view"); }), true);
  stream.emit("one");
  stream.emit("two");
  assert.deepEqual(view, ["one", "two"]);
  assert.deepEqual(r.events, ["view", "out:one", "view", "out:two"], "the observer follows the view");
  assert.equal(terminal.open(() => {}), false, "still one consumer");
  await h.registry.close("owner-1", id);
  stream.emit("late");
  assert.deepEqual(r.events.slice(-1), ["end:1"]);
});

test("end runs exactly once on remote end, failure, close, closeOwner, lock and dispose", async () => {
  for (const path of ["ended", "failed", "close", "closeOwner", "lock", "dispose"] as const) {
    const r = recorder();
    const h = harness(r.observe);
    const { id, context } = await h.ready();
    if (path === "ended") context.ended({ kind: "exit", code: 0 });
    else if (path === "failed") context.failed("network");
    else if (path === "close") await h.registry.close("owner-1", id);
    else if (path === "closeOwner") await h.registry.closeOwner("owner-1");
    else if (path === "lock") await h.registry.lock();
    else await h.registry.dispose();
    await tick();
    await h.registry.close("owner-1", id).catch(() => undefined);
    await h.registry.dispose();
    assert.deepEqual(r.events.filter((event) => event.startsWith("end")), ["end:1"], path);
  }
});

test("local terminals are observed with their shell as the endpoint; a reconnect is a new generation", async () => {
  const r = recorder();
  const h = harness(r.observe);
  const opened = h.registry.connectLocal("owner-1");
  assert.ok(opened.ok);
  await tick();
  assert.equal(h.locals[0]!.ready(channel().value), true);
  assert.deepEqual(r.observed[0], { ownerId: "owner-1", sessionId: opened.value.id, generation: 1, hostId: null, local: true, label: "This Mac", endpoint: "/bin/zsh", environment: null });
  await h.registry.close("owner-1", opened.value.id);
  assert.ok(h.registry.reconnect("owner-1", opened.value.id).ok);
  await tick();
  assert.equal(h.locals[1]!.ready(channel().value), true);
  assert.deepEqual(r.observed.map((session) => session.generation), [1, 2]);
  assert.deepEqual(r.events, ["end:1"]);
  await h.registry.dispose();
  assert.deepEqual(r.events, ["end:1", "end:2"]);
});

test("a throwing observer never breaks the stream or teardown, and no observer means the channel itself", async () => {
  let ends = 0;
  const h = harness(() => ({ output() { throw new Error("observer output"); }, end() { ends++; throw new Error("observer end"); } }));
  const { id, stream } = await h.ready();
  const view: string[] = [];
  h.registry.terminal("owner-1", id, 1)!.open((chunk) => view.push(new TextDecoder().decode(chunk)));
  stream.emit("kept");
  assert.deepEqual(view, ["kept"]);
  await h.registry.close("owner-1", id);
  assert.equal(ends, 1);
  assert.equal(h.registry.snapshot("owner-1", id)[0]?.state, "Closed");

  const thrown = harness(() => { throw new Error("observeTerminal"); });
  const plain = await thrown.ready();
  assert.equal(thrown.registry.terminal("owner-1", plain.id, 1), plain.stream.value, "unobserved generations keep their channel");
  const none = harness(() => undefined);
  const untouched = await none.ready();
  assert.equal(none.registry.terminal("owner-1", untouched.id, 1), untouched.stream.value);
});
