import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createDesktopBridge,
  type BridgeTransport,
} from "../../apps/desktop/src/preload/bridge.ts";
import {
  channels,
  failure,
  isStorageHealth,
  type BootstrapData,
  type WindowStateEvent,
} from "../../packages/contracts/src/index.ts";

function fixture() {
  const listeners = new Set<(event: unknown, value: unknown) => void>();
  const calls: { channel: string; args: unknown[] }[] = [];
  let reply: unknown = {
    ok: true,
    value: {
      app: { name: "ssterm", version: "0.1.0", platform: "darwin" },
      owner: { windowId: 1, generation: 2 },
      window: { focused: false, sequence: 0 },
      storage: { status: "ready", schemaVersion: 1 },
    } satisfies BootstrapData,
  };
  let reject = false;
  const transport: BridgeTransport = {
    async invoke(channel, ...args) {
      calls.push({ channel, args });
      if (reject)
        throw new Error("/private/secret exception that must not escape");
      return reply;
    },
    on(_channel, listener) {
      listeners.add(listener);
    },
    removeListener(_channel, listener) {
      listeners.delete(listener);
    },
  };
  const bridge = createDesktopBridge(transport);
  return {
    ...bridge,
    listeners,
    calls,
    setReply: (value: unknown) => {
      reply = value;
    },
    setReject: () => {
      reject = true;
    },
    emit: (value: unknown) => {
      for (const listener of listeners)
        listener({ sender: "must be stripped" }, value);
    },
  };
}
function event(sequence: number, generation = 2): WindowStateEvent {
  return {
    owner: { windowId: 1, generation },
    type: "focus-changed",
    focused: true,
    sequence,
  };
}

test("bridge exposes only narrow methods and forwards a rebuilt, validated ping", async () => {
  const { api, calls, setReply } = fixture();
  assert.deepEqual(Object.keys(api).sort(), [
    "answerHostTrust", "bootstrap", "onTrustState", "onWindowState", "ping",
    "prepareKnownHostRevoke", "revokeKnownHost", "trustState",
  ]);
  assert.ok(Object.isFrozen(api));
  const bootstrap = await api.bootstrap();
  assert.ok(bootstrap.ok);
  assert.deepEqual(calls, [{ channel: channels.bootstrap, args: [] }]);
  setReply({ ok: true, value: { requestId: "hello", ready: true } });
  assert.deepEqual(
    await api.ping({
      owner: { windowId: 1, generation: 2 },
      requestId: "hello",
    }),
    {
      ok: true,
      value: { requestId: "hello", ready: true },
    },
  );
  assert.deepEqual(calls[1], {
    channel: channels.ping,
    args: [{ owner: { windowId: 1, generation: 2 }, requestId: "hello" }],
  });
  const before = calls.length;
  assert.deepEqual(
    await api.ping({
      owner: { windowId: 1, generation: 2 },
      requestId: "x".repeat(65),
    }),
    failure("invalid-request"),
  );
  assert.equal(calls.length, before);
});

test("bridge sanitizes invocation failures and invalid responses", async () => {
  const { api, setReply, setReject } = fixture();
  for (const reply of [
    null,
    { ok: true, value: {} },
    { ok: true, value: {}, extra: 1 },
    { ok: false, error: { code: "unauthorized", message: "/private/path" } },
  ]) {
    setReply(reply);
    assert.deepEqual(await api.bootstrap(), failure("unavailable"));
  }
  setReply(failure("unauthorized"));
  assert.deepEqual(await api.bootstrap(), failure("unauthorized"));
  setReject();
  assert.deepEqual(await api.bootstrap(), failure("unavailable"));
});

test("all subscribers receive ordered matching events without Electron event objects", async () => {
  const { api, emit, listeners, dispose } = fixture();
  await api.bootstrap();
  const a: unknown[][] = [];
  const b: unknown[][] = [];
  const offA = api.onWindowState((...args) => a.push(args));
  api.onWindowState((...args) => b.push(args));
  emit(event(1));
  emit(event(1));
  emit(event(0));
  emit(event(5, 1));
  emit({ ...event(2), owner: { windowId: 2, generation: 2 } });
  emit({ ...event(2), secret: "unexpected" });
  emit(event(2));
  assert.deepEqual(a, [[event(1)], [event(2)]]);
  assert.deepEqual(b, a);
  offA();
  offA();
  assert.equal(listeners.size, 1);
  emit(event(3));
  assert.equal(a.length, 2);
  assert.equal(b.length, 3);
  dispose();
  dispose();
  assert.equal(listeners.size, 0);
  emit(event(4));
  assert.equal(b.length, 3);
  assert.deepEqual(await api.bootstrap(), failure("unavailable"));
  const empty = api.onWindowState(() => assert.fail("disposed callback"));
  empty();
  assert.equal(listeners.size, 0);
});

test("pre-bootstrap events are ignored and new ownership rejects previous generations", async () => {
  const { api, emit, setReply } = fixture();
  const received: WindowStateEvent[] = [];
  api.onWindowState((event) => received.push(event));
  emit(event(1));
  assert.equal(received.length, 0);
  await api.bootstrap();
  emit(event(1));
  setReply({
    ok: true,
    value: {
      app: { name: "ssterm", version: "0.1.0", platform: "darwin" },
      owner: { windowId: 1, generation: 3 },
      window: { focused: false, sequence: 0 },
      storage: { status: "ready", schemaVersion: 1 },
    },
  });
  await api.bootstrap();
  emit(event(20, 2));
  emit(event(1, 3));
  assert.deepEqual(received, [event(1), event(1, 3)]);
});

test("bridge validates finite storage health without paths, rows or raw errors", async () => {
  const { api, setReply } = fixture();
  const original = await api.bootstrap();
  assert.ok(original.ok);
  if (!original.ok) return;
  for (const code of [
    "corrupt", "foreign-database", "unsupported-schema", "unsupported-protection",
    "recovery-required", "unwritable", "migration-failed", "busy", "unavailable",
  ]) {
    setReply({ ok: true, value: { ...original.value, storage: { status: "blocked", code } } });
    assert.deepEqual(await api.bootstrap(), {
      ok: true, value: { ...original.value, storage: { status: "blocked", code } },
    });
  }
  for (const storage of [
    undefined, null, {}, { status: "ready", schemaVersion: 0 },
    { status: "ready", schemaVersion: 1.2 },
    { status: "ready", schemaVersion: Number.MAX_SAFE_INTEGER + 1 },
    { status: "ready", schemaVersion: 1, vaultId: "hidden" },
    { status: "blocked", code: "io" },
    { status: "blocked", code: "corrupt", message: "/private/data" },
    { status: "blocked", code: "corrupt", rows: [] },
    { status: "blocked", code: "corrupt", schemaVersion: 1 },
  ]) {
    assert.equal(isStorageHealth(storage), false);
    setReply({ ok: true, value: { ...original.value, storage } });
    assert.deepEqual(await api.bootstrap(), failure("unavailable"));
  }
  const { storage: _storage, ...missingStorage } = original.value;
  setReply({ ok: true, value: missingStorage });
  assert.deepEqual(await api.bootstrap(), failure("unavailable"));
});

test("trust bridge filters owner, sequence, malformed data and credential prompts", async () => {
  const { api, emit, setReply, listeners, dispose, calls } = fixture();
  await api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const state = (sequence: number) => ({ owner, sequence, availability: "ready", knownHosts: [], truncated: false, prompts: [] });
  const received: unknown[] = [];
  api.onTrustState((value) => received.push(value));
  emit(state(1));
  emit(state(1));
  emit({ ...state(2), owner: { windowId: 2, generation: 2 } });
  emit({ ...state(2), publicKey: "must not cross" });
  emit({ ...state(2), prompts: [{ kind: "credentials", fields: [{ id: "password" }] }] });
  emit(state(2));
  assert.deepEqual(received, [state(1), state(2)]);
  setReply({ ok: true, value: state(3) });
  assert.deepEqual(await api.trustState({ owner }), { ok: true, value: state(3) });
  emit(state(3));
  emit(state(4));
  assert.equal(received.length, 3);
  const count = calls.length;
  assert.deepEqual(await api.answerHostTrust({ owner, sessionId: "s", generation: 1, promptId: "p", decision: "remember", secret: "bad" } as never), failure("invalid-request"));
  assert.deepEqual(await api.prepareKnownHostRevoke({ owner, id: "h", expectedRevision: 0 }), failure("invalid-request"));
  assert.equal(calls.length, count);
  setReply({ ok: true, value: { accepted: true, secret: "bad" } });
  assert.deepEqual(await api.answerHostTrust({ owner, sessionId: "s", generation: 1, promptId: "p", decision: "reject" }), failure("unavailable"));
  setReply({ ok: true, value: { accepted: true } });
  assert.deepEqual(await api.revokeKnownHost({ owner, token: "token" }), { ok: true, value: { accepted: true } });
  dispose();
  assert.equal(listeners.size, 0);
});
