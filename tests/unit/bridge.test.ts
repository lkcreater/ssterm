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
  MAX_TERMINAL_WRITE,
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
    "ackTerminal", "agentSettings", "agentState", "answerCredentials", "answerHostTrust", "appLockState", "applyCatalogChange", "bootstrap", "cancelAgentTask", "cancelCredentialPrompt", "cancelGoogleSignIn", "cancelTransfer", "catalogState", "checkRemoteEdit", "chooseKeyFile", "clearFinishedTransfers", "closeAgent", "closeSftp", "closeTerminal", "configureAgent", "configureRecording", "confirmAppLockPassword", "connectHost", "connectSftp", "credentialState", "deleteKey", "deleteRecordings", "deleteSnippet", "deleteWorkspaceTemplate", "discardKeyImport", "discardRemoteEdit", "dismissSftp", "dismissTerminal", "enqueueTransfers", "exportRecording", "forgetCommand", "forgetKeyPassphrase", "googleSignIn", "importKey", "listDirectory", "liveWork", "lockNow", "onAgentState", "onCatalogState", "onCredentialState", "onRemoteEditState", "onSftpState", "onTerminalOutput", "onTerminalState", "onTransferState", "onTrustState", "onTunnelState", "onWindowState", "openAgent", "openLink", "openRemoteEditor", "openSnippet", "openTerminal", "ping", "prepareCatalogChange", "prepareKnownHostRevoke", "reconnectSftp", "reconnectTerminal", "recordingState", "recoverAppLock", "regenerateRecoveryCode", "remoteEditState", "renameKey", "resizeTerminal", "resolvePath", "resolveTransferConflict", "retrySecrets", "retryTransfer", "revokeKnownHost", "saveSnippet", "saveWorkspaceTemplate", "sendAgent", "setIdentityPassword", "settings", "setupAppLockPassword", "sftpState", "startLocalTerminal", "startRemoteEdit", "startTunnel", "statPath", "stopTunnel", "suggestCommands", "syncCommand", "syncState", "teamCommand", "teamState", "terminalState", "transferState", "trustState", "tunnelState", "unlockAppLock", "unlockAppLockOffline", "updateSettings", "uploadRemoteEdit", "workspaceTemplates", "writeTerminal",
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


test("credential bridge fences owner/sequence and wipes its world's answer bytes once the call settles", async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const state = (sequence: number) => ({ owner, sequence, availability: "ready", prompts: [] });
  const received: unknown[] = [];
  f.api.onCredentialState((value) => received.push(value));
  f.emit(state(1)); f.emit(state(1));
  f.emit({ ...state(2), owner: { windowId: 2, generation: 2 } });
  f.emit({ ...state(2), values: [] });
  f.emit(state(2));
  assert.deepEqual(received, [state(1), state(2)]);
  f.setReply({ ok: true, value: state(3) });
  assert.deepEqual(await f.api.credentialState({ owner }), { ok: true, value: state(3) });
  f.emit(state(3)); f.emit(state(4)); assert.equal(received.length, 3);
  const value = new TextEncoder().encode("owned-answer");
  const identity = { owner, sessionId: "s", generation: 1, promptId: "p" };
  f.setReply({ ok: true, value: { accepted: true } });
  assert.deepEqual(await f.api.answerCredentials({ ...identity, values: [{ id: "password", value }] }), { ok: true, value: { accepted: true } });
  const forwarded = f.calls.at(-1)!.args[0] as { values: { id: string; value: Uint8Array }[] };
  assert.equal(forwarded.values[0]!.value, value, "no second copy");
  // Here the caller's buffer stands in for the copy contextBridge gives preload.
  assert.ok(value.every((byte) => byte === 0), "preload's copy is wiped");
  const count = f.calls.length;
  assert.deepEqual(await f.api.answerCredentials({ ...identity, values: [{ id: "password", value }], extra: true } as never), failure("invalid-request"));
  assert.equal(f.calls.length, count);
  assert.deepEqual(await f.api.cancelCredentialPrompt(identity), { ok: true, value: { accepted: true } });
  assert.equal(f.calls.at(-1)!.channel, channels.cancelCredentialPrompt);
  f.setReject();
  const rejected = new TextEncoder().encode("owned-answer");
  assert.deepEqual(await f.api.answerCredentials({ ...identity, values: [{ id: "password", value: rejected }] }), failure("unavailable"));
  assert.ok(rejected.every((byte) => byte === 0), "wiped when the call fails too");
  f.dispose(); assert.equal(f.listeners.size, 0);
});

test("terminal output reaches subscribers for the current owner only, with sequence gaps preserved", async () => {
  const f = fixture();
  const owner = { windowId: 1, generation: 2 };
  const frame = (sequence: number, extra: Record<string, unknown> = {}) =>
    ({ owner, sessionId: "s-1", generation: 1, sequence, bytes: new Uint8Array([sequence + 1]), ...extra });
  const received: unknown[] = [];
  f.api.onTerminalOutput((value) => received.push(value));
  f.emit(frame(0));
  assert.equal(received.length, 0, "nothing is delivered before bootstrap");
  await f.api.bootstrap();
  f.emit(frame(0));
  f.emit(frame(0));
  f.emit(frame(5));
  f.emit(frame(1, { owner: { windowId: 1, generation: 1 } }));
  f.emit(frame(1, { owner: { windowId: 2, generation: 2 } }));
  f.emit(frame(1, { text: "<b>x</b>" }));
  f.emit(frame(1, { bytes: [1, 2] }));
  f.emit(frame(1, { bytes: new Uint8Array(0) }));
  f.emit(frame(1, { bytes: new Uint8Array(1_048_577) }));
  assert.deepEqual(received, [frame(0), frame(0), frame(5)]);
  f.dispose();
  f.emit(frame(6));
  assert.equal(received.length, 3);
  assert.equal(f.listeners.size, 0);
});

test("terminal state is owner/sequence fenced and resets when ownership changes", async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const state = (sequence: number, generation = 2) => ({ owner: { windowId: 1, generation }, sequence, sessions: [] });
  const received: unknown[] = [];
  f.api.onTerminalState((value) => received.push(value));
  f.emit(state(1)); f.emit(state(1)); f.emit({ ...state(2), extra: 1 }); f.emit(state(2));
  f.setReply({ ok: true, value: state(4) });
  assert.deepEqual(await f.api.terminalState({ owner }), { ok: true, value: state(4) });
  f.emit(state(3)); f.emit(state(4)); f.emit(state(5));
  assert.deepEqual(received, [state(1), state(2), state(5)]);
  f.setReply({ ok: true, value: {
    app: { name: "ssterm", version: "0.1.0", platform: "darwin" }, owner: { windowId: 1, generation: 3 },
    window: { focused: false, sequence: 0 }, storage: { status: "ready", schemaVersion: 1 },
  } });
  await f.api.bootstrap();
  f.emit(state(6)); f.emit(state(1, 3));
  assert.deepEqual(received.at(-1), state(1, 3));
  assert.equal(received.length, 4);
  f.setReply({ ok: true, value: state(9) });
  assert.deepEqual(await f.api.terminalState({ owner }), failure("stale-owner"));
});

test("terminal commands are rebuilt and written bytes are copied then wiped", async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const target = { owner, sessionId: "s-1", generation: 1 };
  const bytes = new TextEncoder().encode("typed");
  f.setReply({ ok: true, value: { accepted: true } });
  assert.deepEqual(await f.api.writeTerminal({ ...target, bytes }), { ok: true, value: { accepted: true } });
  const forwarded = f.calls.at(-1)!;
  assert.equal(forwarded.channel, channels.writeTerminal);
  const sent = forwarded.args[0] as { bytes: Uint8Array };
  assert.deepEqual(Object.keys(sent).sort(), ["bytes", "generation", "owner", "sessionId"]);
  assert.notEqual(sent.bytes, bytes);
  assert.ok(sent.bytes.every((byte) => byte === 0));
  assert.equal(new TextDecoder().decode(bytes), "typed");
  f.setReply({ ok: false, error: { code: "busy", message: "The session is not accepting input. Try again." } });
  assert.deepEqual(await f.api.writeTerminal({ ...target, bytes }), failure("busy"));
  f.setReply({ ok: true, value: { accepted: true } });
  assert.deepEqual(await f.api.openTerminal(target), { ok: true, value: { accepted: true } });
  assert.deepEqual(f.calls.at(-1), { channel: channels.openTerminal, args: [target] });
  assert.ok((await f.api.resizeTerminal({ ...target, columns: 120, rows: 40 })).ok);
  assert.deepEqual(f.calls.at(-1), { channel: channels.resizeTerminal, args: [{ ...target, columns: 120, rows: 40 }] });
  assert.ok((await f.api.ackTerminal({ ...target, bytes: 5 })).ok);
  assert.deepEqual(f.calls.at(-1), { channel: channels.ackTerminal, args: [{ ...target, bytes: 5 }] });
  for (const [method, channel] of [["closeTerminal", channels.closeTerminal], ["reconnectTerminal", channels.reconnectTerminal],
    ["dismissTerminal", channels.dismissTerminal]] as const) {
    assert.ok((await f.api[method](target)).ok);
    assert.deepEqual(f.calls.at(-1), { channel, args: [target] });
    assert.notEqual(f.calls.at(-1)!.args[0], target, "rebuilt, never the caller's object");
  }
  assert.ok((await f.api.closeTerminal({ ...target, onlyConnecting: true })).ok);
  assert.deepEqual(f.calls.at(-1), { channel: channels.closeTerminal, args: [{ ...target, onlyConnecting: true }] });
  assert.notEqual((f.calls.at(-1)!.args[0] as typeof target).owner, owner, "cancellation copies its owner projection");
  const count = f.calls.length;
  for (const onlyConnecting of [false, undefined, null, 1, "true"])
    assert.deepEqual(await f.api.closeTerminal({ ...target, onlyConnecting } as never), failure("invalid-request"));
  for (const invalid of [
    f.api.writeTerminal({ ...target, bytes: new Uint8Array(0) }),
    f.api.writeTerminal({ ...target, bytes: new Uint8Array(MAX_TERMINAL_WRITE + 1) }),
    f.api.writeTerminal({ ...target, bytes, extra: true } as never),
    f.api.resizeTerminal({ ...target, columns: 0, rows: 24 }),
    f.api.ackTerminal({ ...target, bytes: 1.5 }),
    f.api.openTerminal({ ...target, generation: 0 }),
    f.api.closeTerminal({ ...target, extra: true } as never),
    f.api.reconnectTerminal({ ...target, generation: 1.5 }),
    f.api.dismissTerminal({ ...target, sessionId: "a b" }),
  ]) assert.deepEqual(await invalid, failure("invalid-request"));
  assert.equal(f.calls.length, count);
  f.setReject();
  assert.deepEqual(await f.api.writeTerminal({ ...target, bytes }), failure("unavailable"));
  assert.ok((f.calls.at(-1)!.args[0] as { bytes: Uint8Array }).bytes.every((byte) => byte === 0));
});

test("openLink forwards a rebuilt request and validates the reply", async () => {
  const f = fixture();
  const owner = { windowId: 1, generation: 2 };
  f.setReply({ ok: true, value: { opened: true } });
  const request = { owner, url: "https://example.com/" };
  assert.deepEqual(await f.api.openLink(request), { ok: true, value: { opened: true } });
  const forwarded = f.calls.at(-1)!;
  assert.deepEqual(forwarded, { channel: channels.openLink, args: [request] });
  assert.notEqual(forwarded.args[0], request);
  const count = f.calls.length;
  for (const invalid of [{ owner, url: "" }, { owner, url: "a".repeat(2049) }, { owner, url: "x", extra: true }, { url: "x" }])
    assert.deepEqual(await f.api.openLink(invalid as never), failure("invalid-request"));
  assert.equal(f.calls.length, count);
  f.setReply({ ok: true, value: { opened: "yes" } });
  assert.deepEqual(await f.api.openLink(request), failure("unavailable"));
});

test("settings commands are rebuilt and their replies validated", async () => {
  const f = fixture();
  const owner = { windowId: 1, generation: 2 };
  const settings = { terminalFontSize: 14, terminalScrollback: 2000, terminalCursor: "bar", terminalCursorBlink: false };
  f.setReply({ ok: true, value: settings });
  assert.deepEqual(await f.api.settings({ owner }), { ok: true, value: settings });
  assert.deepEqual(f.calls.at(-1), { channel: channels.settings, args: [{ owner }] });
  const request = { owner, changes: { terminalFontSize: 14 } };
  assert.deepEqual(await f.api.updateSettings(request), { ok: true, value: settings });
  const forwarded = f.calls.at(-1)!;
  assert.deepEqual(forwarded, { channel: channels.updateSettings, args: [request] });
  assert.notEqual((forwarded.args[0] as typeof request).changes, request.changes);
  const count = f.calls.length;
  for (const invalid of [{ owner, changes: {} }, { owner, changes: { theme: "dark" } }, { owner, changes: { terminalFontSize: 9 } }, { changes: { terminalFontSize: 14 } }])
    assert.deepEqual(await f.api.updateSettings(invalid as never), failure("invalid-request"));
  assert.deepEqual(await f.api.settings({ owner, extra: 1 } as never), failure("invalid-request"));
  assert.equal(f.calls.length, count);
  f.setReply({ ok: true, value: { ...settings, terminalFontSize: 99 } });
  assert.deepEqual(await f.api.settings({ owner }), failure("unavailable"));
});

test("catalog and connect commands are rebuilt, validated both ways and catalog states are owner-sequenced", async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const hostId = "0b7c7f3e-6a54-4c52-9a6e-3c1f1f9b2d10";
  const token = "5f0f5c1e-2b7a-4d3c-8e9f-0a1b2c3d4e5f";
  const state = (sequence: number, generation = 2) => ({ owner: { windowId: 1, generation }, sequence, availability: "ready", revision: 3,
    truncated: false, hosts: [], groups: [], tags: [], identities: [], keys: [], snippets: [], tunnelRules: [], secrets: { availability: "ready", cleanupPending: false }, lockEpoch: 0 });
  f.setReply({ ok: true, value: state(4) });
  assert.deepEqual(await f.api.catalogState({ owner }), { ok: true, value: state(4) });
  assert.deepEqual(f.calls.at(-1), { channel: channels.catalogState, args: [{ owner }] });
  const received: unknown[] = [];
  const off = f.api.onCatalogState((value) => received.push(value));
  f.emit(state(3)); f.emit(state(5)); f.emit(state(6, 3)); f.emit({ ...state(7), hosts: [{ passwordRef: "x" }] }); f.emit(state(6));
  assert.deepEqual(received, [state(5), state(6)], "older, foreign-owner and malformed states are dropped");
  off();
  f.emit(state(9));
  assert.equal(received.length, 2);
  f.setReply({ ok: true, value: state(1, 3) });
  assert.deepEqual(await f.api.catalogState({ owner }), failure("stale-owner"));

  const intent = { type: "update-host" as const, id: hostId, expectedRevision: 1, data: { port: { mode: "value" as const, port: 2222 } } };
  const preview = { kind: "preview", token, expiresAt: 1000, impacts: { hosts: [], removedHostIds: [], removedGroupIds: [], removedTunnelRules: 0, removedHostTags: 0, removedSnippetTags: 0, identity: null } };
  f.setReply({ ok: true, value: preview });
  assert.deepEqual(await f.api.prepareCatalogChange({ owner, intent }), { ok: true, value: preview });
  const sent = f.calls.at(-1)!;
  assert.deepEqual(sent, { channel: channels.prepareCatalogChange, args: [{ owner, intent }] });
  assert.notEqual((sent.args[0] as { intent: unknown }).intent, intent, "a copy, never the caller's object");
  f.setReply({ ok: true, value: { kind: "invalid", fields: [{ field: "port", code: "cycle" }] } });
  assert.deepEqual(await f.api.prepareCatalogChange({ owner, intent }), failure("unavailable"), "a malformed reply is refused");
  f.setReply({ ok: true, value: { revision: 4, createdIds: [] } });
  assert.deepEqual(await f.api.applyCatalogChange({ owner, token }), { ok: true, value: { revision: 4, createdIds: [] } });
  assert.deepEqual(f.calls.at(-1), { channel: channels.applyCatalogChange, args: [{ owner, token }] });
  f.setReply({ ok: true, value: { sessionId: "s-1", generation: 1 } });
  assert.deepEqual(await f.api.connectHost({ owner, hostId }), { ok: true, value: { sessionId: "s-1", generation: 1 } });
  assert.deepEqual(f.calls.at(-1), { channel: channels.connectHost, args: [{ owner, hostId }] });

  const count = f.calls.length;
  for (const invalid of [
    f.api.catalogState({ owner, extra: 1 } as never),
    f.api.prepareCatalogChange({ owner, intent: { type: "create-identity", data: {} } as never }),
    f.api.prepareCatalogChange({ owner, intent: { ...intent, data: {} } }),
    f.api.applyCatalogChange({ owner, token: "t" }),
    f.api.connectHost({ owner, hostId: "host-1" }),
  ]) assert.deepEqual(await invalid, failure("invalid-request"));
  assert.equal(f.calls.length, count);
});

test("identity commands send rebuilt requests, wipe preload's credential copies and validate replies", async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const identityId = "0b7c7f3e-6a54-4c52-9a6e-3c1f1f9b2d10";
  const importId = "5f0f5c1e-2b7a-4d3c-8e9f-0a1b2c3d4e5f";
  const value = new TextEncoder().encode("fixture-password");
  const capture = () => { const args = f.calls.at(-1)!.args[0] as Record<string, unknown>; return args; };
  f.setReply({ ok: true, value: { status: "saved" } });
  assert.deepEqual(await f.api.setIdentityPassword({ owner, identityId, expectedRevision: 1, value }), { ok: true, value: { status: "saved" } });
  const sentPassword = capture();
  assert.equal(f.calls.at(-1)!.channel, channels.setIdentityPassword);
  assert.deepEqual(Object.keys(sentPassword).sort(), ["expectedRevision", "identityId", "owner", "value"]);
  // The caller's buffer stands in for the copy contextBridge gives preload.
  assert.ok(value.every((byte) => byte === 0), "preload's copy is wiped after the call");

  f.setReply({ ok: true, value: { status: "imported", keyId: identityId, fingerprint: `SHA256:${"A".repeat(43)}`, passphrase: { status: "saved" } } });
  const passphrase = new TextEncoder().encode("fixture-passphrase");
  assert.ok((await f.api.importKey({ owner, importId, label: "Lab key", passphrase, savePassphrase: true })).ok);
  const sentImport = capture();
  assert.equal(f.calls.at(-1)!.channel, channels.importKey);
  assert.equal(sentImport.passphrase, passphrase);
  assert.ok(passphrase.every((byte) => byte === 0));
  f.setReply({ ok: true, value: { status: "secret-store", reason: "nope" } });
  assert.deepEqual(await f.api.importKey({ owner, importId, label: "Lab key", passphrase: null, savePassphrase: false }), failure("unavailable"),
    "a malformed reply is refused");

  for (const [call, channel, reply] of [
    [() => f.api.chooseKeyFile({ owner }), channels.chooseKeyFile, { status: "chosen", importId, suggestedLabel: "id_ed25519", encrypted: true, algorithm: null, fingerprint: null }],
    [() => f.api.discardKeyImport({ owner, importId }), channels.discardKeyImport, { status: "discarded" }],
    [() => f.api.renameKey({ owner, keyId: identityId, expectedRevision: 1, label: "x" }), channels.renameKey, { status: "renamed" }],
    [() => f.api.forgetKeyPassphrase({ owner, keyId: identityId, expectedRevision: 1 }), channels.forgetKeyPassphrase, { status: "forgotten", cleanup: "pending" }],
    [() => f.api.deleteKey({ owner, keyId: identityId, expectedRevision: 1 }), channels.deleteKey, { status: "in-use", identityIds: [identityId] }],
    [() => f.api.retrySecrets({ owner }), channels.retrySecrets, { status: "retried" }],
  ] as const) {
    f.setReply({ ok: true, value: reply });
    assert.deepEqual(await call(), { ok: true, value: reply }, channel);
    assert.equal(f.calls.at(-1)!.channel, channel);
  }
  const count = f.calls.length;
  for (const invalid of [
    f.api.setIdentityPassword({ owner, identityId, expectedRevision: 1, value: new Uint8Array() }),
    f.api.setIdentityPassword({ owner, identityId, expectedRevision: 1, value: new Uint8Array(16 * 1024 + 1) }),
    f.api.setIdentityPassword({ owner, identityId, expectedRevision: 1, value: "password" as never }),
    f.api.importKey({ owner, importId, label: "k", passphrase: null, savePassphrase: true }),
    f.api.importKey({ owner, importId: "id", label: "k", passphrase: null, savePassphrase: false }),
    f.api.chooseKeyFile({ owner, path: "/etc/passwd" } as never),
    f.api.deleteKey({ owner, keyId: identityId, expectedRevision: 0 }),
  ]) assert.deepEqual(await invalid, failure("invalid-request"));
  assert.equal(f.calls.length, count);
});

test("SFTP state is owner/sequence fenced; SFTP and file commands are rebuilt and validated", async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const view = { sessionId: "s-1", generation: 1, hostId: "h-1", phase: "ready", target: null, error: null, home: "/home/fixture" };
  const state = (sequence: number, generation = 2) => ({ owner: { windowId: 1, generation }, sequence, sessions: [view] });
  const received: unknown[] = [];
  const off = f.api.onSftpState((value) => received.push(value));
  f.emit(state(1)); f.emit(state(1)); f.emit(state(2, 3)); f.emit({ ...state(2), sessions: [{ ...view, end: null }] });
  f.setReply({ ok: true, value: state(4) });
  assert.deepEqual(await f.api.sftpState({ owner }), { ok: true, value: state(4) });
  assert.deepEqual(f.calls.at(-1), { channel: channels.sftpState, args: [{ owner }] });
  f.emit(state(3)); f.emit(state(5));
  assert.deepEqual(received, [state(1), state(5)]);
  off();
  assert.equal(f.listeners.size, 0);

  const target = { owner, sessionId: "s-1", generation: 1 };
  f.setReply({ ok: true, value: { sessionId: "s-1", generation: 1 } });
  assert.ok((await f.api.connectSftp({ owner, hostId: "0b7c7f3e-6a54-4c52-9a6e-3c1f1f9b2d10" })).ok);
  assert.equal(f.calls.at(-1)!.channel, channels.connectSftp);
  f.setReply({ ok: true, value: { accepted: true } });
  for (const [method, channel] of [["closeSftp", channels.closeSftp], ["reconnectSftp", channels.reconnectSftp], ["dismissSftp", channels.dismissSftp]] as const) {
    assert.ok((await f.api[method](target)).ok);
    assert.deepEqual(f.calls.at(-1), { channel, args: [target] });
    assert.notEqual(f.calls.at(-1)!.args[0], target);
  }
  const source = { kind: "remote" as const, sessionId: "s-1", generation: 1 };
  const listing = { path: "/home", entries: [{ name: "\u001b", addressable: true, type: "file", size: 1, mtime: 0, permissions: 0o600 }], truncated: false, skipped: 0 };
  f.setReply({ ok: true, value: { ok: true, value: listing } });
  assert.deepEqual(await f.api.listDirectory({ owner, source, path: "/home" }), { ok: true, value: { ok: true, value: listing } });
  assert.deepEqual(f.calls.at(-1), { channel: channels.listDirectory, args: [{ owner, source, path: "/home" }] });
  assert.notEqual((f.calls.at(-1)!.args[0] as { source: unknown }).source, source, "the source is rebuilt too");
  f.setReply({ ok: true, value: { ok: false, error: "permission-denied" } });
  assert.deepEqual(await f.api.statPath({ owner, source: { kind: "local" }, path: "/x" }), { ok: true, value: { ok: false, error: "permission-denied" } });
  f.setReply({ ok: true, value: { ok: false, error: "permission-denied", message: "server text" } });
  assert.deepEqual(await f.api.statPath({ owner, source, path: "/x" }), failure("unavailable"), "text in a reply is refused");
  f.setReply({ ok: true, value: { ok: true, value: "/home/fixture" } });
  assert.deepEqual(await f.api.resolvePath({ owner, source, path: "~" }), { ok: true, value: { ok: true, value: "/home/fixture" } });
  assert.equal(f.calls.at(-1)!.channel, channels.resolvePath);
  f.setReply({ ok: true, value: { ok: true, value: "relative" } });
  assert.deepEqual(await f.api.resolvePath({ owner, source, path: "~" }), failure("unavailable"));

  const count = f.calls.length;
  for (const invalid of [
    f.api.sftpState({ owner, extra: 1 } as never),
    f.api.connectSftp({ owner, hostId: "host-1" }),
    f.api.closeSftp({ ...target, generation: 0 }),
    f.api.listDirectory({ owner, source, path: "~" }),
    f.api.statPath({ owner, source: { kind: "remote" } as never, path: "/" }),
    f.api.listDirectory({ owner, source: { kind: "local", sessionId: "s-1" } as never, path: "/" }),
    f.api.resolvePath({ owner, source, path: "" }),
    f.api.resolvePath({ owner, source, path: "a\0b" }),
  ]) assert.deepEqual(await invalid, failure("invalid-request"));
  assert.equal(f.calls.length, count);
});

test("transfer bridge captures rebuilt endpoints and validates commands and replies without file bytes", async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const request = { owner, source: { kind: "local" as const }, sourceDirectory: "/tmp/ไทย", names: ["รายงาน.txt"],
    destination: { kind: "remote" as const, sessionId: "s-1", generation: 1 }, destinationDirectory: "/home/fixture" };
  f.setReply({ ok: true, value: { accepted: true } });
  assert.deepEqual(await f.api.enqueueTransfers(request), { ok: true, value: { accepted: true } });
  const forwarded = f.calls.at(-1)!;
  assert.deepEqual(forwarded, { channel: channels.enqueueTransfers, args: [request] });
  const sent = forwarded.args[0] as typeof request;
  for (const key of ["owner", "source", "destination", "names"] as const) assert.notEqual(sent[key], request[key], `${key} is rebuilt`);
  request.names.push("later.txt");
  assert.deepEqual(sent.names, ["รายงาน.txt"], "later selection changes do not alter the queued request");
  assert.deepEqual(await f.api.cancelTransfer({ owner, jobId: "transfer-1" }), { ok: true, value: { accepted: true } });
  assert.deepEqual(f.calls.at(-1), { channel: channels.cancelTransfer, args: [{ owner, jobId: "transfer-1" }] });
  assert.deepEqual(await f.api.clearFinishedTransfers({ owner }), { ok: true, value: { accepted: true } });
  assert.deepEqual(f.calls.at(-1), { channel: channels.clearFinishedTransfers, args: [{ owner }] });
  const count = f.calls.length;
  for (const invalid of [
    f.api.enqueueTransfers({ ...request, names: ["../escape"] }),
    f.api.enqueueTransfers({ ...request, names: ["a", "a"] }),
    f.api.enqueueTransfers({ ...request, destination: { kind: "local" } }),
    f.api.enqueueTransfers({ ...request, bytes: new Uint8Array([1]) } as never),
    f.api.cancelTransfer({ owner, jobId: "" }),
    f.api.cancelTransfer({ owner, jobId: "transfer-1", path: "/tmp/other" } as never),
    f.api.clearFinishedTransfers({ owner, allWindows: true } as never),
  ]) assert.deepEqual(await invalid, failure("invalid-request"));
  assert.equal(f.calls.length, count);
  f.setReply({ ok: true, value: { accepted: true, contents: "private file bytes" } });
  assert.deepEqual(await f.api.enqueueTransfers(request), failure("unavailable"));
  f.setReject();
  assert.deepEqual(await f.api.cancelTransfer({ owner, jobId: "transfer-1" }), failure("unavailable"));
});

test("transfer subscriptions fence owners, malformed jobs, sequence snapshots, and disposal", async () => {
  const f = fixture();
  const owner = { windowId: 1, generation: 2 };
  const state = (sequence: number, generation = 2) => ({ owner: { windowId: 1, generation }, sequence, jobs: [] });
  const received: unknown[] = [];
  f.api.onTransferState((value) => received.push(value));
  f.emit(state(1));
  assert.equal(received.length, 0, "events before bootstrap are ignored");
  await f.api.bootstrap();
  f.emit(state(1)); f.emit(state(1)); f.emit(state(2, 3));
  f.emit({ ...state(2), jobs: [{ id: "bad", bytes: "server text" }] });
  f.emit({ ...state(2), contents: new Uint8Array([1]) });
  f.setReply({ ok: true, value: state(4) });
  assert.deepEqual(await f.api.transferState({ owner }), { ok: true, value: state(4) });
  assert.deepEqual(f.calls.at(-1), { channel: channels.transferState, args: [{ owner }] });
  f.emit(state(3)); f.emit(state(4)); f.emit(state(5));
  assert.deepEqual(received, [state(1), state(5)]);
  f.setReply({ ok: true, value: state(6, 3) });
  assert.deepEqual(await f.api.transferState({ owner }), failure("stale-owner"));
  f.setReply({ ok: true, value: { ...state(6), extra: "server text" } });
  assert.deepEqual(await f.api.transferState({ owner }), failure("unavailable"));
  f.dispose(); f.emit(state(9));
  assert.equal(received.length, 2);
  assert.equal(f.listeners.size, 0);
});

test("transfer conflict decisions and retries rebuild captured identities and reject malformed names and extra authority", async () => {
  const f = fixture(); await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const identity = { owner, jobId: "transfer-1", conflictId: "conflict-1" };
  f.setReply({ ok: true, value: { accepted: true } });
  for (const [decision, name] of [["overwrite", null], ["skip", null], ["rename", "รายงานใหม่.txt"]] as const) {
    const request = { ...identity, decision, name };
    assert.deepEqual(await f.api.resolveTransferConflict(request), { ok: true, value: { accepted: true } });
    const call = f.calls.at(-1)!;
    assert.deepEqual(call, { channel: channels.resolveTransferConflict, args: [request] });
    assert.notEqual(call.args[0], request);
    assert.notEqual((call.args[0] as typeof request).owner, owner);
  }
  const retry = { owner, jobId: "transfer-1" };
  assert.deepEqual(await f.api.retryTransfer(retry), { ok: true, value: { accepted: true } });
  assert.deepEqual(f.calls.at(-1), { channel: channels.retryTransfer, args: [retry] });
  assert.notEqual(f.calls.at(-1)!.args[0], retry);
  const before = f.calls.length;
  for (const request of [
    { ...identity, decision: "overwrite", name: "unrequested.txt" },
    { ...identity, decision: "skip" },
    { ...identity, decision: "rename", name: "../outside" },
    { ...identity, decision: "rename", name: "." },
    { ...identity, decision: "rename", name: null },
    { ...identity, decision: "overwrite", name: null, conflictId: "" },
    { ...identity, decision: "overwrite", name: null, destinationPath: "/tmp/other-target" },
  ]) assert.deepEqual(await f.api.resolveTransferConflict(request as never), failure("invalid-request"));
  for (const request of [{ ...retry, jobId: "" }, { ...retry, generation: 99 }, { ...retry, partialPath: "/tmp/unlink" }])
    assert.deepEqual(await f.api.retryTransfer(request as never), failure("invalid-request"));
  assert.equal(f.calls.length, before);
  f.setReply({ ok: true, value: { accepted: true, deletedPath: "/tmp/file" } });
  assert.deepEqual(await f.api.retryTransfer(retry), failure("unavailable"));
  f.setReject();
  assert.deepEqual(await f.api.resolveTransferConflict({ ...identity, decision: "skip", name: null }), failure("unavailable"));
});

test("transfer bridge projects conflict and retained-stage fields while refusing server-text and malformed paths", async () => {
  const f = fixture(); await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const job = { id: "transfer-1", sessionId: "s-1", generation: 1, direction: "upload", sourcePath: "/tmp/รายงาน.txt",
    destinationPath: "/home/fixture/รายงาน.txt", target: null, state: "conflict", bytes: 0, total: null, error: null,
    partial: false, partialPath: null, atomicReplace: true, conflictId: "conflict-1" };
  const state = { owner, sequence: 1, jobs: [job] };
  const received: unknown[] = []; f.api.onTransferState((value) => received.push(value));
  f.emit(state); assert.deepEqual(received, [state]);
  for (const patch of [{ partialPath: "relative.part" }, { atomicReplace: "supported" }, { conflictId: "" },
    { error: "server: disk full" }, { rawError: "/private/credential" }, { contents: new Uint8Array([1]) }]) {
    f.emit({ ...state, sequence: 2, jobs: [{ ...job, ...patch }] });
    f.setReply({ ok: true, value: { ...state, sequence: 2, jobs: [{ ...job, ...patch }] } });
    assert.deepEqual(await f.api.transferState({ owner }), failure("unavailable"));
  }
  assert.equal(received.length, 1);
  const failed = { ...state, sequence: 2, jobs: [{ ...job, state: "failed", error: "publication-unknown",
    partial: true, partialPath: "/home/fixture/.ssterm-owned.part", conflictId: null }] };
  f.emit(failed); assert.deepEqual(received.at(-1), failed);
});

test('remote edit bridge rebuilds bounded metadata commands and rejects extra filesystem authority', async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const start = { owner, source: { kind: 'remote' as const, sessionId: 'session', generation: 3 }, path: '/ไฟล์.txt' };
  f.setReply({ ok: true, value: { editId: 'edit' } });
  assert.deepEqual(await f.api.startRemoteEdit(start), { ok: true, value: { editId: 'edit' } });
  assert.deepEqual(f.calls.at(-1), { channel: channels.startRemoteEdit, args: [start] });
  assert.notEqual(f.calls.at(-1)!.args[0], start);
  const request = { owner, editId: 'edit', revision: 4 };
  f.setReply({ ok: true, value: { accepted: true } });
  for (const [method, channel] of [['openRemoteEditor', channels.openRemoteEditor], ['checkRemoteEdit', channels.checkRemoteEdit], ['discardRemoteEdit', channels.discardRemoteEdit]] as const) {
    assert.ok((await f.api[method](request)).ok);
    assert.deepEqual(f.calls.at(-1), { channel, args: [request] });
    assert.deepEqual(await f.api[method]({ ...request, documentPath: '/private/document.txt' } as never), failure('invalid-request'));
  }
  const upload = { ...request, approvalId: 'approval' };
  assert.ok((await f.api.uploadRemoteEdit(upload)).ok);
  assert.deepEqual(f.calls.at(-1), { channel: channels.uploadRemoteEdit, args: [upload] });
  assert.deepEqual(await f.api.uploadRemoteEdit({ ...upload, bytes: new Uint8Array([1]) } as never), failure('invalid-request'));
  assert.deepEqual(await f.api.startRemoteEdit({ ...start, source: { kind: 'local' } } as never), failure('invalid-request'));
  f.setReply({ ok: true, value: { editId: 'edit', localPath: '/private' } });
  assert.deepEqual(await f.api.startRemoteEdit(start), failure('unavailable'));
  f.dispose();
});

test('remote edit state subscriptions fence owner, sequence and private response fields', async () => {
  const f = fixture();
  await f.api.bootstrap();
  const owner = { windowId: 1, generation: 2 };
  const state = { owner, sequence: 1, edits: [], capabilities: { editor: 'textedit', maxBytes: 8388608, resume: false, remoteToRemote: false } };
  const received: unknown[] = [];
  const stop = f.api.onRemoteEditState((value) => received.push(value));
  f.emit(state); f.emit(state); f.emit({ ...state, sequence: 2, owner: { ...owner, generation: 1 } });
  f.emit({ ...state, sequence: 3, documentPath: '/private' });
  assert.equal(received.length, 1);
  f.setReply({ ok: true, value: { ...state, sequence: 5 } });
  assert.ok((await f.api.remoteEditState({ owner })).ok);
  f.emit({ ...state, sequence: 4 }); assert.equal(received.length, 1);
  f.emit({ ...state, sequence: 6 }); assert.equal(received.length, 2);
  f.setReply({ ok: true, value: { ...state, owner: { ...owner, generation: 1 } } });
  assert.deepEqual(await f.api.remoteEditState({ owner }), failure('stale-owner'));
  stop(); f.emit({ ...state, sequence: 7 }); assert.equal(received.length, 2);
  f.dispose(); assert.equal(f.listeners.size, 0);
});
