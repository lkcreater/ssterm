import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createTerminalController, registerTerminalHandlers, terminalChannels } from "../../apps/desktop/src/main/terminals.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { SessionRegistry, TransientSecrets, type SessionContext } from "../../packages/services/src/index.ts";
import {
  channels, failure, isAckTerminalRequest, isResizeTerminalRequest, isTerminalEnd, isTerminalOutput, isTerminalState,
  isTerminalTarget, isWriteTerminalRequest, MAX_TERMINAL_CHUNK, MAX_TERMINAL_WRITE, TERMINAL_ERROR_CODES, type TerminalOutput, type TerminalState,
} from "../../packages/contracts/src/index.ts";
import type { ResolvedHostConfig, TerminalChannel, TerminalWrite } from "../../packages/domain/src/index.ts";

const owner = { windowId: 1, generation: 1 };
const other = { windowId: 2, generation: 2 };
const ownerId = sessionOwnerId(owner);
const config: ResolvedHostConfig = {
  hostRef: { id: "host-1", revision: 1, label: "เป้าหมาย lab", groupId: null }, address: "example.com", environment: "PROD",
  port: { value: 2222, source: { kind: "default" } },
  auth: { selection: "identity", source: { kind: "default" }, key: null, identity: null }, ancestry: [], catalogRevision: 1,
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fakeChannel() {
  const calls = {
    sink: undefined as ((chunk: Uint8Array, sequence: number) => void) | undefined,
    opens: 0, acks: [] as number[], writes: [] as number[][], resizes: [] as [number, number][],
    result: "ok" as TerminalWrite,
  };
  const channel: TerminalChannel = {
    drained: Promise.resolve(),
    dispose() {},
    open(output) { calls.opens += 1; if (calls.sink) return false; calls.sink = output; return true; },
    ack(bytes) { calls.acks.push(bytes); },
    write(bytes) { calls.writes.push([...bytes]); return calls.result; },
    resize(columns, rows) { calls.resizes.push([columns, rows]); },
  };
  return { channel, calls };
}
async function fixture(checkAccess?: () => Promise<boolean>) {
  const contexts: SessionContext[] = [];
  const registry = new SessionRegistry({ resolve: () => ({ ok: true, value: config }), transient: new TransientSecrets(), adapter: { start(context) { contexts.push(context); } } });
  const controller = createTerminalController({ registry, checkAccess });
  const sent: { channel: string; value: TerminalState | TerminalOutput }[] = [];
  controller.register(owner, (channel, value) => sent.push({ channel, value }));
  controller.register(other, () => assert.fail("foreign owner received a frame"));
  const ready = async () => {
    await tick();
    const context = contexts.at(-1)!;
    const fake = fakeChannel();
    context.verifyingHost(); context.authenticating();
    assert.ok(context.ready(fake.channel));
    return { context, ...fake };
  };
  const connected = registry.connect(ownerId, "host-1");
  assert.ok(connected.ok);
  const first = await ready();
  const states = () => sent.filter((entry) => entry.channel === channels.terminalStateChanged).map((entry) => entry.value as TerminalState);
  const frames = () => sent.filter((entry) => entry.channel === channels.terminalOutput).map((entry) => entry.value as TerminalOutput);
  const identity = { owner, sessionId: connected.value.id, generation: connected.value.generation };
  return { registry, controller, sent, states, frames, identity, ready, first, contexts };
}

test("terminal contracts reject extra keys, oversize payloads, non-integers and zero sizes", () => {
  const target = { owner, sessionId: "s-1", generation: 1 };
  assert.ok(isTerminalTarget(target));
  assert.ok(isWriteTerminalRequest({ ...target, bytes: new Uint8Array(MAX_TERMINAL_WRITE) }));
  assert.ok(isResizeTerminalRequest({ ...target, columns: 1, rows: 1000 }));
  assert.ok(isAckTerminalRequest({ ...target, bytes: MAX_TERMINAL_CHUNK }));
  assert.ok(isTerminalOutput({ ...target, sequence: 0, bytes: new Uint8Array(1) }));
  for (const end of [{ kind: "exit", code: 7 }, { kind: "exit", code: 0xffff_ffff }, { kind: "signal", signal: "SIGKILL" }, { kind: "eof" }]) assert.ok(isTerminalEnd(end));
  for (const invalid of [
    { ...target, generation: 0 }, { ...target, sessionId: "a b" }, { ...target, owner: { ...owner, extra: 1 } }, { ...target, extra: true },
  ]) assert.equal(isTerminalTarget(invalid), false);
  for (const invalid of [
    { ...target, bytes: new Uint8Array(0) }, { ...target, bytes: new Uint8Array(MAX_TERMINAL_WRITE + 1) },
    { ...target, bytes: [1, 2] }, { ...target, bytes: "ls" }, { ...target, bytes: new Uint8Array(1), extra: true },
  ]) assert.equal(isWriteTerminalRequest(invalid), false);
  for (const [columns, rows] of [[0, 24], [80, 0], [1001, 24], [80, 1001], [80.5, 24], [80, Number.NaN], ["80", 24]])
    assert.equal(isResizeTerminalRequest({ ...target, columns, rows }), false);
  assert.equal(isResizeTerminalRequest({ ...target, columns: 80, rows: 24, pixels: 1 }), false);
  for (const bytes of [0, -1, 1.5, MAX_TERMINAL_CHUNK + 1]) assert.equal(isAckTerminalRequest({ ...target, bytes }), false);
  for (const invalid of [
    { ...target, sequence: 0, bytes: new Uint8Array(0) }, { ...target, sequence: 0, bytes: new Uint8Array(MAX_TERMINAL_CHUNK + 1) },
    { ...target, sequence: -1, bytes: new Uint8Array(1) }, { ...target, sequence: 0, bytes: new Uint8Array(1), text: "x" },
  ]) assert.equal(isTerminalOutput(invalid), false);
  for (const invalid of [
    { kind: "exit", code: -1 }, { kind: "exit", code: 1.5 }, { kind: "signal", signal: "KILL" }, { kind: "signal", signal: "SIGKILL", message: "server text" },
    { kind: "eof", code: 0 }, { kind: "closed" },
  ]) assert.equal(isTerminalEnd(invalid), false);
  const session = { sessionId: "s-1", generation: 1, phase: "ready", target: null, end: null, error: null };
  assert.ok(isTerminalState({ owner, sequence: 0, sessions: [session] }));
  for (const error of TERMINAL_ERROR_CODES) assert.ok(isTerminalState({ owner, sequence: 0, sessions: [{ ...session, phase: "failed", error }] }));
  for (const error of ["invalid-state", "not-found", "disposed", "Connection reset by 10.0.0.1", 1, undefined])
    assert.equal(isTerminalState({ owner, sequence: 0, sessions: [{ ...session, error }] }), false, String(error));
  const { error: _error, ...withoutError } = session;
  assert.equal(isTerminalState({ owner, sequence: 0, sessions: [withoutError] }), false);
  assert.equal(isTerminalState({ owner, sequence: 0, sessions: Array(33).fill(session) }), false);
  assert.equal(isTerminalState({ owner, sequence: 0, sessions: [{ ...session, phase: "Ready" }] }), false);
});

test("controller projects the target, frames output to the owner and maps write outcomes", async () => {
  const f = await fixture();
  try {
    const state = f.controller.terminalState(owner);
    assert.ok(state.ok);
    assert.deepEqual(state.value.sessions, [{ sessionId: f.identity.sessionId, generation: f.identity.generation, phase: "ready", end: null, error: null,
      target: { label: "เป้าหมาย lab", environment: "PROD", endpointHost: "example.com", endpointPort: 2222, username: null } }]);
    assert.equal(f.first.calls.sink, undefined, "output stays unbound until a view opens it");

    assert.deepEqual(f.controller.openTerminal(f.identity), { ok: true, value: { accepted: true } });
    assert.deepEqual(f.controller.openTerminal(f.identity), failure("conflict"), "a second open binds nothing, so the view is told");
    const chunk = new Uint8Array([104, 105]);
    f.first.calls.sink!(chunk, 0);
    f.first.calls.sink!(new Uint8Array([10]), 1);
    assert.deepEqual(f.frames(), [
      { ...f.identity, sequence: 0, bytes: chunk },
      { ...f.identity, sequence: 1, bytes: new Uint8Array([10]) },
    ]);

    assert.deepEqual(f.controller.writeTerminal({ ...f.identity, bytes: new Uint8Array([108, 115]) }), { ok: true, value: { accepted: true } });
    f.first.calls.result = "busy";
    assert.deepEqual(f.controller.writeTerminal({ ...f.identity, bytes: new Uint8Array([1]) }), failure("busy"));
    f.first.calls.result = "closed";
    assert.deepEqual(f.controller.writeTerminal({ ...f.identity, bytes: new Uint8Array([2]) }), failure("conflict"));
    assert.deepEqual(f.first.calls.writes, [[108, 115], [1], [2]]);

    assert.deepEqual(f.controller.resizeTerminal({ ...f.identity, columns: 120, rows: 40 }), { ok: true, value: { accepted: true } });
    assert.deepEqual(f.controller.ackTerminal({ ...f.identity, bytes: 2 }), { ok: true, value: { accepted: true } });
    assert.deepEqual(f.first.calls.resizes, [[120, 40]]);
    assert.deepEqual(f.first.calls.acks, [2]);

    const stale = { ...f.identity, generation: f.identity.generation + 1 };
    assert.deepEqual(f.controller.writeTerminal({ ...stale, bytes: new Uint8Array([3]) }), failure("conflict"));
    assert.deepEqual(f.controller.resizeTerminal({ ...stale, columns: 80, rows: 24 }), failure("conflict"));
    assert.deepEqual(f.controller.ackTerminal({ ...stale, bytes: 1 }), failure("conflict"));
    assert.deepEqual(f.controller.openTerminal({ ...f.identity, sessionId: "unknown" }), failure("conflict"));
    assert.deepEqual(f.controller.writeTerminal({ ...f.identity, owner: other, bytes: new Uint8Array([4]) }), failure("conflict"));
    assert.deepEqual(f.controller.writeTerminal({ ...f.identity, owner: { windowId: 9, generation: 9 }, bytes: new Uint8Array([4]) }), failure("stale-owner"));
    assert.deepEqual(f.controller.resizeTerminal({ ...f.identity, columns: 0, rows: 24 }), failure("invalid-request"));
    assert.equal(f.first.calls.writes.length, 3);
  } finally { f.controller.dispose(); await f.registry.dispose(); }
});

test("remote end, local close and reconnect fence every older generation", async () => {
  const f = await fixture();
  try {
    assert.ok(f.controller.openTerminal(f.identity).ok);
    f.first.context.ended({ kind: "exit", code: 7 });
    await tick();
    const ended = f.states().at(-1)!.sessions[0]!;
    assert.equal(ended.phase, "closed");
    assert.deepEqual(ended.end, { kind: "exit", code: 7 });
    assert.equal(ended.target?.label, "เป้าหมาย lab", "the execution target survives teardown");
    assert.deepEqual(f.controller.writeTerminal({ ...f.identity, bytes: new Uint8Array([1]) }), failure("conflict"));
    assert.equal(f.first.calls.writes.length, 0);

    const reconnected = f.registry.reconnect(ownerId, f.identity.sessionId);
    assert.ok(reconnected.ok);
    const second = await f.ready();
    const next = { ...f.identity, generation: reconnected.value.generation };
    assert.notEqual(next.generation, f.identity.generation);
    assert.equal(f.states().at(-1)!.sessions[0]!.end, null);
    for (const result of [
      f.controller.openTerminal(f.identity), f.controller.writeTerminal({ ...f.identity, bytes: new Uint8Array([1]) }),
      f.controller.resizeTerminal({ ...f.identity, columns: 80, rows: 24 }), f.controller.ackTerminal({ ...f.identity, bytes: 1 }),
    ]) assert.deepEqual(result, failure("conflict"));
    assert.ok(f.controller.writeTerminal({ ...next, bytes: new Uint8Array([9]) }).ok);
    assert.deepEqual(second.calls.writes, [[9]]);
    assert.equal(f.first.calls.writes.length, 0, "no input reaches or replays to the old channel");

    await f.registry.close(ownerId, next.sessionId);
    const closed = f.controller.terminalState(owner);
    assert.ok(closed.ok);
    assert.equal(closed.value.sessions[0]!.phase, "closed");
    assert.equal(closed.value.sessions[0]!.end, null, "a local close never reports a remote end");
    assert.deepEqual(f.controller.writeTerminal({ ...next, bytes: new Uint8Array([1]) }), failure("conflict"));
    assert.ok(f.states().every(isTerminalState));
  } finally { f.controller.dispose(); await f.registry.dispose(); }
});

test("revoked owners stop receiving frames and dispose is idempotent", async () => {
  const f = await fixture();
  try {
    assert.ok(f.controller.openTerminal(f.identity).ok);
    f.controller.revokeOwner(owner);
    f.first.calls.sink!(new Uint8Array([1]), 0);
    assert.equal(f.frames().length, 0);
    assert.deepEqual(f.controller.terminalState(owner), failure("stale-owner"));
    assert.deepEqual(f.controller.writeTerminal({ ...f.identity, bytes: new Uint8Array([1]) }), failure("stale-owner"));
    f.controller.dispose();
    f.controller.dispose();
    f.controller.register(owner, () => assert.fail("disposed controller registered"));
    await f.registry.close(ownerId, f.identity.sessionId);
    assert.deepEqual(f.controller.terminalState(owner), failure("stale-owner"));
    assert.deepEqual(f.controller.openTerminal(f.identity), failure("stale-owner"));
  } finally { f.controller.dispose(); await f.registry.dispose(); }
});

test("terminal IPC authorizes sender and owner, requires one argument and wipes written bytes", async () => {
  const f = await fixture();
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sent: { channel: string; value: unknown }[] = [];
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send: (channel: string, value: unknown) => sent.push({ channel, value }) };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } } satisfies Pick<IpcMain, "handle" | "removeHandler">;
  const unregister = registerTerminalHandlers({ ipc, boundary, controller: () => f.controller });
  const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event as IpcMainInvokeEvent, ...args);
  const event = { sender, senderFrame: mainFrame };
  const write = () => ({ ...f.identity, bytes: new TextEncoder().encode("typed-secret") });
  const wiped = (request: { bytes: Uint8Array }) => request.bytes.every((byte) => byte === 0);
  try {
    assert.deepEqual([...handlers.keys()].sort(), [channels.ackTerminal, channels.openTerminal, channels.resizeTerminal, channels.terminalState,
      channels.writeTerminal, channels.closeTerminal, channels.reconnectTerminal, channels.dismissTerminal].sort());
    assert.deepEqual([...terminalChannels].sort(), [...handlers.keys()].sort());
    for (const forged of [{ sender: { ...sender }, senderFrame: mainFrame }, { sender, senderFrame: { url: mainFrame.url } }, { sender, senderFrame: null }]) {
      const request = write();
      assert.deepEqual(invoke(channels.writeTerminal, forged, request), failure("unauthorized"));
      assert.ok(wiped(request));
    }
    const stale = write();
    assert.deepEqual(invoke(channels.writeTerminal, event, { ...stale, owner: { ...owner, generation: 99 } }), failure("stale-owner"));
    assert.deepEqual(invoke(channels.writeTerminal, event, { ...write(), owner: { windowId: 2, generation: 1 } }), failure("unauthorized"));
    const extra = write();
    assert.deepEqual(invoke(channels.writeTerminal, event, extra, extra), failure("invalid-request"));
    assert.ok(wiped(extra));
    const extraKey = { ...write(), extra: true };
    assert.deepEqual(invoke(channels.writeTerminal, event, extraKey), failure("invalid-request"));
    assert.ok(wiped(extraKey));
    assert.deepEqual(invoke(channels.resizeTerminal, event, { ...f.identity, columns: 80.5, rows: 24 }), failure("invalid-request"));
    assert.deepEqual(invoke(channels.terminalState, event), failure("invalid-request"));
    assert.equal(f.first.calls.writes.length, 0);

    assert.deepEqual(invoke(channels.openTerminal, event, f.identity), { ok: true, value: { accepted: true } });
    const valid = write();
    assert.deepEqual(invoke(channels.writeTerminal, event, valid), { ok: true, value: { accepted: true } });
    assert.ok(wiped(valid));
    assert.equal(new TextDecoder().decode(new Uint8Array(f.first.calls.writes[0]!)), "typed-secret");
    f.first.calls.sink!(new Uint8Array([111, 107]), 0);
    assert.deepEqual(sent.filter((entry) => entry.channel === channels.terminalOutput).map((entry) => entry.value),
      [{ ...f.identity, sequence: 0, bytes: new Uint8Array([111, 107]) }]);
    const state = invoke(channels.terminalState, event, { owner }) as { ok: boolean };
    assert.equal(state.ok, true);
    assert.equal(JSON.stringify(sent).includes("typed-secret"), false);
  } finally { unregister(); assert.equal(handlers.size, 0); boundary.dispose(); f.controller.dispose(); await f.registry.dispose(); }
});

const ok = { ok: true, value: { accepted: true } };
const session = (f: Awaited<ReturnType<typeof fixture>>) => {
  const state = f.controller.terminalState(owner);
  assert.ok(state.ok);
  return state.value.sessions.find((entry) => entry.sessionId === f.identity.sessionId)!;
};

test("close, reconnect and dismiss act only on the exact owner, session and generation in the required state", async () => {
  const f = await fixture();
  try {
    const stale = { ...f.identity, generation: f.identity.generation + 1 };
    // Wrong state: a live session cannot be reconnected or dismissed.
    assert.deepEqual(await f.controller.reconnectTerminal(f.identity), failure("conflict"));
    assert.deepEqual(await f.controller.dismissTerminal(f.identity), failure("conflict"));
    // Foreign or unknown targets look identical to stale ones; unregistered owners are stale-owner.
    assert.deepEqual(await f.controller.closeTerminal({ ...f.identity, owner: other }), failure("conflict"));
    assert.deepEqual(await f.controller.closeTerminal({ ...f.identity, sessionId: "unknown" }), failure("conflict"));
    assert.deepEqual(await f.controller.closeTerminal({ ...f.identity, owner: { windowId: 9, generation: 9 } }), failure("stale-owner"));
    assert.deepEqual(await f.controller.closeTerminal({ ...f.identity, extra: 1 } as never), failure("invalid-request"));
    assert.deepEqual(await f.controller.closeTerminal(stale), failure("conflict"));
    assert.equal(session(f).phase, "ready");

    assert.deepEqual(await f.controller.closeTerminal(f.identity), ok);
    assert.deepEqual(session(f), { ...session(f), phase: "closed", error: null, end: null });
    assert.deepEqual(await f.controller.closeTerminal(f.identity), ok, "close is idempotent on Closed");

    const [first, second] = await Promise.all([f.controller.reconnectTerminal(f.identity), f.controller.reconnectTerminal(f.identity)]);
    assert.deepEqual([first, second], [ok, failure("conflict")], "a double click starts one generation");
    assert.equal(session(f).generation, stale.generation);
    const next = await f.ready();
    assert.deepEqual(await f.controller.closeTerminal(f.identity), failure("conflict"), "a stale close leaves the new generation alone");
    assert.equal(session(f).phase, "ready");
    assert.equal(next.context.signal.aborted, false);

    next.context.failed("network");
    await tick();
    assert.deepEqual(await f.controller.dismissTerminal(f.identity), failure("conflict"));
    assert.deepEqual(await f.controller.dismissTerminal({ ...stale, owner: other }), failure("conflict"));
    assert.deepEqual(await f.controller.dismissTerminal(stale), ok);
    const state = f.controller.terminalState(owner);
    assert.ok(state.ok);
    assert.deepEqual(state.value.sessions, [], "dismiss frees the slot");
    assert.deepEqual(f.states().at(-1)!.sessions, [], "the owner's view is told the pane is gone");
    assert.deepEqual(await f.controller.dismissTerminal(stale), failure("conflict"));
  } finally { f.controller.dispose(); await f.registry.dispose(); }
});

test("session errors project only allowlisted codes and fold request-level codes", async () => {
  const f = await fixture();
  try {
    for (const [code, projected] of [
      ["auth-denied", "auth-denied"], ["timeout", "timeout"], ["network", "network"], ["invalid-state", "subsystem-unavailable"],
      ["disposed", "subsystem-unavailable"], ["not-found", "subsystem-unavailable"], ["raw upstream text", "subsystem-unavailable"],
    ] as const) {
      const live = f.contexts.at(-1)!;
      live.failed(code as never);
      await tick();
      assert.equal(session(f).phase, "failed");
      assert.equal(session(f).error, projected, code);
      assert.ok((await f.controller.reconnectTerminal({ ...f.identity, generation: session(f).generation })).ok);
      assert.equal(session(f).error, null, "a new generation starts without the old reason");
      await tick();
    }
    assert.ok(f.states().every(isTerminalState));
  } finally { f.controller.dispose(); await f.registry.dispose(); }
});

test("reconnect and dismiss right after a failure wait for its teardown instead of refusing", async () => {
  const f = await fixture();
  try {
    const slow = () => {
      let finish!: () => void;
      f.contexts.at(-1)!.own({ dispose() {}, drained: new Promise<void>((done) => { finish = done; }) });
      f.contexts.at(-1)!.failed("network");
      return () => finish();
    };
    let finish = slow();
    let reconnected: unknown;
    void f.controller.reconnectTerminal(f.identity).then((result) => { reconnected = result; });
    await tick();
    assert.equal(reconnected, undefined, "the click waits while the failed generation drains");
    assert.equal(session(f).generation, 1);
    finish();
    await tick();
    assert.deepEqual(reconnected, ok);
    assert.equal(session(f).generation, 2);
    await f.ready();
    const second = { ...f.identity, generation: 2 };

    finish = slow();
    const dismissed = f.controller.dismissTerminal(second);
    finish();
    assert.deepEqual(await dismissed, ok);
    assert.deepEqual(f.registry.snapshot(ownerId), []);
  } finally { f.controller.dispose(); await f.registry.dispose(); }

  const g = await fixture();
  try {
    let finish!: () => void;
    g.contexts.at(-1)!.own({ dispose() {}, drained: new Promise<void>((done) => { finish = done; }) });
    g.contexts.at(-1)!.failed("network");
    const pending = g.controller.reconnectTerminal(g.identity);
    g.controller.revokeOwner(owner);
    finish();
    assert.deepEqual(await pending, failure("stale-owner"), "an owner revoked while waiting starts nothing");
    assert.equal(g.registry.snapshot(ownerId)[0]!.generation, 1);
  } finally { g.controller.dispose(); await g.registry.dispose(); }
});

test("reconnect after a lock is the explicit unlock; a denied unlock stays locked as unavailable", async () => {
  let allowed = false;
  let checks = 0;
  const f = await fixture(async () => { checks += 1; return allowed; });
  try {
    await f.registry.lock();
    assert.equal(session(f).phase, "closed");
    assert.equal(session(f).error, "locked");
    assert.deepEqual(await f.controller.reconnectTerminal({ ...f.identity, generation: 2 }), failure("conflict"), "a stale target never unlocks");
    assert.equal(checks, 0);
    assert.deepEqual(await f.controller.reconnectTerminal(f.identity), failure("unavailable"));
    assert.equal(checks, 1);
    assert.deepEqual(await f.controller.reconnectTerminal(f.identity), failure("unavailable"));
    allowed = true;
    assert.deepEqual(await f.controller.reconnectTerminal(f.identity), ok);
    assert.equal(session(f).generation, 2);
    assert.equal(session(f).error, null);
    await f.ready();
    assert.equal(session(f).phase, "ready");
  } finally { f.controller.dispose(); await f.registry.dispose(); }
  const g = await fixture();
  try {
    await g.registry.lock();
    assert.deepEqual(await g.controller.reconnectTerminal(g.identity), failure("unavailable"), "no access check means no unlock");
  } finally { g.controller.dispose(); await g.registry.dispose(); }
});

test("a Reconnect that arrived before a lock never unlocks or reconnects after it, even while it waits on teardown", async () => {
  let checks = 0;
  const f = await fixture(async () => { checks += 1; return true; });
  try {
    let finish!: () => void;
    f.contexts.at(-1)!.own({ dispose() {}, drained: new Promise<void>((done) => { finish = done; }) });
    f.contexts.at(-1)!.failed("network");
    // Clicked while the failed generation still drains; the screen locks before the wait ends.
    const pending = f.controller.reconnectTerminal(f.identity);
    await tick();
    const locked = f.registry.lock();
    finish();
    assert.deepEqual(await pending, failure("unavailable"));
    await locked;
    assert.equal(checks, 0, "a pre-lock request never asks to unlock");
    assert.equal(session(f).generation, 1);
    // A Reconnect issued after the lock is the explicit unlock.
    assert.deepEqual(await f.controller.reconnectTerminal(f.identity), ok);
    assert.equal(checks, 1);
    assert.equal(session(f).generation, 2);
  } finally { f.controller.dispose(); await f.registry.dispose(); }

  // Unlocked by someone else between arrival and the attempt: still refused, nothing starts.
  const g = await fixture(async () => true);
  try {
    let finish!: () => void;
    g.contexts.at(-1)!.own({ dispose() {}, drained: new Promise<void>((done) => { finish = done; }) });
    g.contexts.at(-1)!.failed("network");
    const pending = g.controller.reconnectTerminal(g.identity);
    await tick();
    const locked = g.registry.lock();
    assert.ok(await g.registry.unlock(async () => true));
    finish();
    await locked;
    assert.deepEqual(await pending, failure("unavailable"));
    assert.equal(session(g).generation, 1);
  } finally { g.controller.dispose(); await g.registry.dispose(); }
});

test("concurrent Reconnects after a lock: the one whose unlock was superseded still reconnects its own session", async () => {
  const access: (() => void)[] = [];
  const f = await fixture(() => new Promise<boolean>((done) => access.push(() => done(true))));
  try {
    const second = f.registry.connect(ownerId, "host-1");
    assert.ok(second.ok);
    await f.ready();
    await f.registry.lock();
    const target = { owner, sessionId: second.value.id, generation: second.value.generation };
    const first = f.controller.reconnectTerminal(f.identity);
    await tick();
    const other = f.controller.reconnectTerminal(target);
    await tick();
    assert.equal(access.length, 2);
    // The later unlock supersedes the earlier one, which is refused and retries once.
    for (const allow of access) allow();
    assert.deepEqual(await Promise.all([first, other]), [ok, ok]);
    const generations = f.registry.snapshot(ownerId).map((snapshot) => snapshot.generation);
    assert.deepEqual(generations, [2, 2]);
  } finally { f.controller.dispose(); await f.registry.dispose(); }
});

test("lifecycle IPC requires the owning main frame and exactly one valid target", async () => {
  const f = await fixture();
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send: () => {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const unregister = registerTerminalHandlers({ ipc: { handle: (channel: string, listener: Handler) => { handlers.set(channel, listener); }, removeHandler: (channel: string) => { handlers.delete(channel); } }, boundary, controller: () => f.controller });
  const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event as IpcMainInvokeEvent, ...args);
  const event = { sender, senderFrame: mainFrame };
  try {
    for (const channel of [channels.closeTerminal, channels.reconnectTerminal, channels.dismissTerminal]) {
      assert.deepEqual(await invoke(channel, { sender: { ...sender }, senderFrame: mainFrame }, f.identity), failure("unauthorized"));
      assert.deepEqual(await invoke(channel, event, { ...f.identity, owner: { windowId: 2, generation: 1 } }), failure("unauthorized"));
      assert.deepEqual(await invoke(channel, event, f.identity, f.identity), failure("invalid-request"));
      assert.deepEqual(await invoke(channel, event, { ...f.identity, generation: 0 }), failure("invalid-request"));
    }
    assert.equal(session(f).phase, "ready");
    assert.deepEqual(await invoke(channels.closeTerminal, event, f.identity), ok);
    assert.deepEqual(await invoke(channels.reconnectTerminal, event, f.identity), ok);
    await f.ready();
    assert.deepEqual(await invoke(channels.closeTerminal, event, { ...f.identity, generation: 2 }), ok);
    assert.deepEqual(await invoke(channels.dismissTerminal, event, { ...f.identity, generation: 2 }), ok);
    assert.equal(f.registry.snapshot(ownerId).length, 0);
  } finally { unregister(); assert.equal(handlers.size, 0); boundary.dispose(); f.controller.dispose(); await f.registry.dispose(); }
});
