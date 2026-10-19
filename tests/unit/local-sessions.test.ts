import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { EventEmitter } from "node:events";
import { SessionRegistry, TransientSecrets, type LocalSessionContext } from "../../packages/services/src/index.ts";
import type { TerminalChannel } from "../../packages/domain/src/index.ts";
import { channels, failure, isStartLocalTerminalRequest, isTerminalSession, isSftpSessionView } from "../../packages/contracts/src/index.ts";
import { createTerminalController, registerTerminalHandlers, closePrompt } from "../../apps/desktop/src/main/terminals.ts";
import { createDesktopSessions, sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { createDesktopBridge } from "../../apps/desktop/src/preload/bridge.ts";

const owner = { windowId: 1, generation: 1 };
const ownerId = sessionOwnerId(owner);
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const metadata = { shell: "/bin/zsh", platform: "darwin" as const };
const channel = (dispose = () => {}): TerminalChannel => ({ dispose, drained: Promise.resolve(), open: () => true, write: () => "ok", resize() {}, ack() {} });
function harness(limits?: { sessions: number }) {
  const contexts: LocalSessionContext[] = [];
  let resolves = 0;
  const registry = new SessionRegistry({
    transient: new TransientSecrets(), limits,
    resolve() { resolves++; throw new Error("resolver must not run for local"); },
    adapter: { start() { assert.fail("SSH adapter must not run for local"); } },
    localAdapter: { metadata, start(context) { contexts.push(context); } },
  });
  return { registry, contexts, resolves: () => resolves };
}

test("local sessions skip host/auth resolution, preserve local metadata and isolate streams by kind/owner/generation", async () => {
  const f = harness();
  try {
    const events: string[] = [];
    f.registry.subscribe(ownerId, (snapshot) => events.push(snapshot.state));
    const opened = f.registry.connectLocal(ownerId); assert.ok(opened.ok);
    assert.equal(opened.value.hostId, null);
    assert.deepEqual(opened.value.local, metadata);
    await tick();
    const context = f.contexts[0]!;
    assert.deepEqual(Object.keys(context).sort(), ["ended", "failed", "generation", "id", "own", "ready", "signal"]);
    const stream = channel();
    assert.ok(context.ready(stream));
    assert.equal(f.registry.terminal(ownerId, opened.value.id, 1), stream);
    assert.equal(f.registry.terminal("other", opened.value.id, 1), undefined);
    assert.equal(f.registry.terminal(ownerId, opened.value.id, 2), undefined);
    assert.equal(f.registry.sftp(ownerId, opened.value.id, 1), undefined);
    assert.equal(f.registry.tunnel(ownerId, opened.value.id, 1), undefined);
    assert.equal(f.registry.snapshot(ownerId)[0]!.target, undefined);
    assert.equal(f.registry.snapshot(ownerId)[0]!.prompt, undefined);
    assert.equal(f.resolves(), 0);
    assert.ok(events.every((state) => ["Connecting", "Ready"].includes(state)));
    context.ended({ kind: "exit", code: 7 }); await tick();
    const ended = f.registry.snapshot(ownerId)[0]!;
    assert.equal(ended.state, "Closed"); assert.deepEqual(ended.local, metadata);
    assert.deepEqual(ended.end, { kind: "exit", code: 7 });
    const restarted = f.registry.reconnect(ownerId, opened.value.id, 1); assert.ok(restarted.ok);
    await tick(); assert.equal(f.contexts.length, 2); assert.equal(restarted.value.generation, 2);
    let discarded = 0;
    assert.equal(context.ready(channel(() => { discarded++; })), false);
    context.failed("network"); context.ended();
    assert.equal(discarded, 1); assert.equal(f.registry.snapshot(ownerId)[0]!.state, "Connecting");
    assert.equal(f.resolves(), 0);
  } finally { await f.registry.dispose(); }
});

test("local attempts share limits and lock/owner/late native cleanup fences", async () => {
  const f = harness({ sessions: 1 });
  let disposed = 0;
  try {
    const opened = f.registry.connectLocal(ownerId); assert.ok(opened.ok); await tick();
    const exceeded = f.registry.connectLocal("other"); assert.ok(!exceeded.ok); assert.equal(exceeded.error.code, "resource-limit");
    const sshExceeded = f.registry.connect(ownerId, "host-1"); assert.ok(!sshExceeded.ok); assert.equal(sshExceeded.error.code, "resource-limit");
    f.contexts[0]!.own({ dispose() { disposed++; }, drained: Promise.resolve() });
    await f.registry.lock();
    assert.equal(disposed, 1); assert.ok(f.contexts[0]!.signal.aborted);
    const locked = f.registry.connectLocal(ownerId); assert.ok(!locked.ok); assert.equal(locked.error.code, "locked");
    assert.equal(f.contexts[0]!.ready(channel(() => { disposed++; })), false);
    assert.equal(disposed, 2);
    assert.equal(f.registry.terminal(ownerId, opened.value.id, 1), undefined);
    assert.equal(f.registry.snapshot(ownerId)[0]!.cleanup, "complete");
  } finally { await f.registry.dispose(); }
});

test("unsupported adapters and thrown local failures produce fixed diagnostics without raw process errors", async () => {
  for (const localAdapter of [undefined, { metadata, start() { throw new Error("private-home raw env secret"); } }]) {
    const registry = new SessionRegistry({ transient: new TransientSecrets(), resolve() { throw new Error("never"); }, adapter: { start() {} }, localAdapter });
    try {
      assert.ok(registry.connectLocal(ownerId).ok); await tick();
      const snapshot = registry.snapshot(ownerId)[0]!;
      assert.equal(snapshot.state, "Failed");
      assert.equal(snapshot.error!.code, localAdapter ? "local-spawn-failed" : "local-unsupported");
      assert.equal(JSON.stringify(snapshot).includes("private-home"), false);
    } finally { await registry.dispose(); }
  }
});

test("local contracts distinguish host sessions and forbid launch settings or executable metadata extras", () => {
  const local = { sessionId: "s-1", generation: 1, hostId: null, local: metadata, target: null, phase: "ready", end: null, error: null };
  assert.ok(isTerminalSession(local)); assert.ok(isStartLocalTerminalRequest({ owner }));
  for (const extra of [{ shell: "/bin/sh" }, { cwd: "/tmp" }, { env: {} }, { args: [] }, { command: "id" }])
    assert.equal(isStartLocalTerminalRequest({ owner, ...extra }), false);
  for (const changed of [{ hostId: "host-1" }, { local: undefined }, { local: { ...metadata, pid: 1 } }, { local: { ...metadata, platform: "linux" } }, { local: { ...metadata, shell: "\n/bin/zsh" } }])
    assert.equal(isTerminalSession({ ...local, ...changed }), false);
  const { local: _local, ...missingKind } = local;
  assert.equal(isTerminalSession(missingKind), false);
  const { end: _end, ...localFiles } = local;
  assert.equal(isSftpSessionView({ ...localFiles, home: "/tmp" }), false);
  const { local: _metadata, ...missingLocal } = localFiles;
  assert.equal(isSftpSessionView({ ...missingLocal, home: "/tmp" }), false);
  assert.ok(closePrompt([local as never], "quit")!.detail.includes("LOCAL · This Mac — /bin/zsh"));
  assert.ok(closePrompt([local as never], "quit")!.detail.includes("owned jobs will be terminated"));
});

test("local controller unlock uses local access and fences revoked owners and racing locks", async () => {
  const f = harness();
  let finish!: (allowed: boolean) => void;
  let checks = 0;
  const controller = createTerminalController({ registry: f.registry,
    checkAccess: async () => { assert.fail("local must not depend on metadata"); },
    checkLocalAccess: () => { checks++; return new Promise((resolve) => { finish = resolve; }); },
  });
  controller.register(owner, () => {});
  try {
    await f.registry.lock();
    const pending = controller.startLocalTerminal({ owner });
    await tick(); assert.equal(checks, 1);
    await f.registry.lock(); finish(true);
    assert.deepEqual(await pending, failure("unavailable")); assert.equal(f.contexts.length, 0);
    const revoked = controller.startLocalTerminal({ owner }); await tick();
    controller.revokeOwner(owner); finish(true);
    assert.deepEqual(await revoked, failure("stale-owner")); assert.equal(f.contexts.length, 0);
    controller.register(owner, () => {});
    const opened = await controller.startLocalTerminal({ owner }); assert.ok(opened.ok); await tick();
    const target = { owner, sessionId: opened.value.sessionId, generation: opened.value.generation };
    assert.ok(f.contexts[0]!.ready(channel()));
    await f.registry.lock();
    const restart = controller.reconnectTerminal(target); await tick(); finish(true);
    assert.ok((await restart).ok); await tick(); assert.equal(f.contexts.length, 2);
  } finally { controller.dispose(); await f.registry.dispose(); }
});

test("local IPC authenticates frame and app access before accepting only owner; preload rebuilds request", async () => {
  const f = harness();
  const controller = createTerminalController({ registry: f.registry });
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send() {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 4 }));
  boundary.register(sender, 1, true, () => {});
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = { handle(name, handler) { handlers.set(name, handler); }, removeHandler(name) { handlers.delete(name); } } satisfies Pick<IpcMain, "handle" | "removeHandler">;
  const unregister = registerTerminalHandlers({ ipc, boundary, controller: () => controller });
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const invoke = (...args: unknown[]) => handlers.get(channels.startLocalTerminal)!(event, ...args);
  try {
    assert.deepEqual(await invoke({ owner, shell: "/bin/sh" }), failure("invalid-request"));
    assert.deepEqual(await invoke({ owner }, {}), failure("invalid-request"));
    assert.deepEqual(await invoke({ owner: { ...owner, generation: 2 } }), failure("stale-owner"));
    assert.deepEqual(await handlers.get(channels.startLocalTerminal)!({ ...event, senderFrame: null } as unknown as IpcMainInvokeEvent, { owner }), failure("unauthorized"));
    const opened = await invoke({ owner }) as { ok: boolean }; assert.ok(opened.ok); await tick();
    assert.equal(f.contexts.length, 1);
    const calls: unknown[] = [];
    const bridge = createDesktopBridge({ invoke: async (name, ...args) => { calls.push({ name, args }); return { ok: true, value: { sessionId: "s-1", generation: 1 } }; }, on() {}, removeListener() {} });
    assert.deepEqual(await bridge.api.startLocalTerminal({ owner, env: {} } as never), failure("invalid-request"));
    assert.equal(calls.length, 0);
    assert.ok((await bridge.api.startLocalTerminal({ owner })).ok);
    assert.deepEqual(calls, [{ name: channels.startLocalTerminal, args: [{ owner }] }]);
    bridge.dispose();
  } finally { unregister(); boundary.dispose(); controller.dispose(); await f.registry.dispose(); }
});

test("desktop power and owner lifecycle dispose local processes without SSH prerequisites", async () => {
  const power = new EventEmitter(); let disposed = 0;
  const runtime = createDesktopSessions({ power, transient: new TransientSecrets(), resolve() { throw new Error("no metadata"); },
    localAdapter: { metadata, start(context) { context.ready(channel(() => { disposed++; })); } },
  });
  try {
    assert.ok(runtime.registry.connectLocal(ownerId).ok); await tick();
    power.emit("suspend"); await tick(); assert.equal(disposed, 1);
    await runtime.registry.unlock(async () => true);
    assert.ok(runtime.registry.connectLocal(ownerId).ok); await tick();
    runtime.revokeOwner(owner); await tick(); assert.equal(disposed, 2);
    assert.equal(runtime.registry.snapshot(ownerId).length, 0);
  } finally { await runtime.shutdown(); }
  assert.equal(power.listenerCount("suspend"), 0);
});
