import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createTerminalController, registerTerminalHandlers } from "../../apps/desktop/src/main/terminals.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { SessionRegistry, TransientSecrets, type SessionContext } from "../../packages/services/src/index.ts";
import {
  channels, failure, isAckTerminalRequest, isResizeTerminalRequest, isTerminalEnd, isTerminalOutput, isTerminalState,
  isTerminalTarget, isWriteTerminalRequest, MAX_TERMINAL_CHUNK, MAX_TERMINAL_WRITE, type TerminalOutput, type TerminalState,
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
async function fixture() {
  const contexts: SessionContext[] = [];
  const registry = new SessionRegistry({ resolve: () => ({ ok: true, value: config }), transient: new TransientSecrets(), adapter: { start(context) { contexts.push(context); } } });
  const controller = createTerminalController({ registry });
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
  return { registry, controller, sent, states, frames, identity, ready, first };
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
  const session = { sessionId: "s-1", generation: 1, phase: "ready", target: null, end: null };
  assert.ok(isTerminalState({ owner, sequence: 0, sessions: [session] }));
  assert.equal(isTerminalState({ owner, sequence: 0, sessions: Array(33).fill(session) }), false);
  assert.equal(isTerminalState({ owner, sequence: 0, sessions: [{ ...session, phase: "Ready" }] }), false);
});

test("controller projects the target, frames output to the owner and maps write outcomes", async () => {
  const f = await fixture();
  try {
    const state = f.controller.terminalState(owner);
    assert.ok(state.ok);
    assert.deepEqual(state.value.sessions, [{ sessionId: f.identity.sessionId, generation: f.identity.generation, phase: "ready", end: null,
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
    assert.deepEqual([...handlers.keys()].sort(), [channels.ackTerminal, channels.openTerminal, channels.resizeTerminal, channels.terminalState, channels.writeTerminal].sort());
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
