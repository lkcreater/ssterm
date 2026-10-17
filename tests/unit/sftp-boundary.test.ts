import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createSftpController, registerSftpHandlers, sftpChannels, LOCAL_FILES_IN_FLIGHT } from "../../apps/desktop/src/main/sftp.ts";
import { createTerminalController } from "../../apps/desktop/src/main/terminals.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { createLocalFiles, type LocalFiles } from "../../packages/adapters/src/local-files.ts";
import { SessionRegistry, TransientSecrets, type SessionContext } from "../../packages/services/src/index.ts";
import { channels, failure, isSftpState, isTerminalState, type SftpState, type TerminalState } from "../../packages/contracts/src/index.ts";
import type { RemoteAttributes, ResolvedHostConfig, SftpChannel, SftpFailure, SftpResult } from "../../packages/domain/src/index.ts";

const owner = { windowId: 1, generation: 1 };
const other = { windowId: 2, generation: 2 };
const ownerId = sessionOwnerId(owner);
const hostId = "0b7c7f3e-6a54-4c52-9a6e-3c1f1f9b2d10";
const config: ResolvedHostConfig = {
  hostRef: { id: hostId, revision: 1, label: "lab", groupId: null }, address: "example.com", environment: "PROD",
  port: { value: 2222, source: { kind: "default" } },
  auth: { selection: "identity", source: { kind: "default" }, key: null, identity: null }, ancestry: [], catalogRevision: 1,
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const ok = { ok: true, value: { accepted: true } };
const SERVER_TEXT = "No such file: /etc/shadow (server says)";
const fileAttrs: RemoteAttributes = { type: "file", size: 3, mtime: 1_700_000_000, permissions: 0o644 };

/** Records every call; results leak extra keys (like server text) that must never cross the boundary. */
function fakeSftp(home = "/home/fixture") {
  const calls: [string, string][] = [];
  let next: SftpFailure | undefined;
  const answer = <T>(op: string, path: string, value: T): Promise<SftpResult<T>> => {
    calls.push([op, path]);
    const code = next;
    return Promise.resolve(code ? { ok: false, code, message: SERVER_TEXT } as never : { ok: true, value, message: SERVER_TEXT } as never);
  };
  const channel: SftpChannel = {
    home, maxRead: 32_768, maxWrite: 32_768, drained: Promise.resolve(), dispose() {},
    realpath: (path) => answer("realpath", path, path),
    stat: (path) => answer("stat", path, { ...fileAttrs, linkTarget: "/etc" } as RemoteAttributes),
    lstat: (path) => answer("lstat", path, fileAttrs),
    list: (path) => answer("list", path, {
      truncated: false, skipped: 2,
      entries: [{ name: "a\u001b[31m", addressable: true, ...fileAttrs, longname: SERVER_TEXT }, { name: "�", addressable: false, type: "unknown", size: null, mtime: null, permissions: null }],
    } as never),
    openRead: () => assert.fail("never opened"), openWrite: () => assert.fail("never opened"),
  };
  return { channel, calls, fail(code?: SftpFailure) { next = code; } };
}

async function fixture(options: { checkAccess?: () => Promise<boolean>; local?: LocalFiles; localTimeoutMs?: number } = {}) {
  const contexts: SessionContext[] = [];
  const registry = new SessionRegistry({ resolve: () => ({ ok: true, value: config }), transient: new TransientSecrets(), adapter: { start(context) { contexts.push(context); } } });
  const sftpLookups: unknown[] = [];
  const spied = new Proxy(registry, {
    get(target, key) {
      if (key === "sftp") return (...args: [string, string, number]) => { sftpLookups.push(args); return target.sftp(...args); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const controller = createSftpController({ registry: spied, checkAccess: options.checkAccess, local: options.local ?? createLocalFiles("/"), localTimeoutMs: options.localTimeoutMs });
  const terminals = createTerminalController({ registry, checkAccess: options.checkAccess });
  const sent: { channel: string; value: unknown }[] = [];
  controller.register(owner, (channel, value) => sent.push({ channel, value }));
  terminals.register(owner, (channel, value) => sent.push({ channel, value }));
  controller.register(other, () => assert.fail("foreign owner received SFTP state"));
  const ready = async (channel: SftpChannel | Parameters<SessionContext["ready"]>[0]) => {
    await tick();
    const context = contexts.at(-1)!;
    context.verifyingHost(); context.authenticating();
    assert.ok(context.ready(channel));
    return context;
  };
  const connected = await controller.connectSftp({ owner, hostId });
  assert.ok(connected.ok);
  const remote = fakeSftp();
  const context = await ready(remote.channel);
  const source = { kind: "remote" as const, sessionId: connected.value.sessionId, generation: connected.value.generation };
  const sftpStates = () => sent.filter((entry) => entry.channel === channels.sftpStateChanged).map((entry) => entry.value as SftpState);
  const terminalStates = () => sent.filter((entry) => entry.channel === channels.terminalStateChanged).map((entry) => entry.value as TerminalState);
  const view = () => { const state = controller.sftpState(owner); assert.ok(state.ok); return state.value.sessions; };
  const dispose = async () => { controller.dispose(); terminals.dispose(); await registry.dispose(); };
  return { registry, controller, terminals, contexts, remote, context, source, ready, sftpStates, terminalStates, view, sftpLookups, dispose,
    target: { owner, sessionId: source.sessionId, generation: source.generation } };
}

test("SFTP state carries only SFTP sessions with their home; terminal and SFTP streams exclude each other", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.view(), [{ sessionId: f.source.sessionId, generation: 1, hostId, phase: "ready", error: null, home: "/home/fixture",
      target: { label: "lab", environment: "PROD", endpointHost: "example.com", endpointPort: 2222, username: null } }]);
    const terminal = await f.terminals.connectHost({ owner, hostId });
    assert.ok(terminal.ok);
    await f.ready({ drained: Promise.resolve(), dispose() {}, open: () => true, ack() {}, write: () => "ok", resize() {} });
    assert.ok(f.sftpStates().length > 0 && f.terminalStates().length > 0);
    assert.ok(f.sftpStates().every((state) => isSftpState(state) && state.sessions.every((s) => s.sessionId === f.source.sessionId)));
    assert.ok(f.terminalStates().every((state) => isTerminalState(state) && state.sessions.every((s) => s.sessionId === terminal.value.sessionId)));
    const sequences = f.sftpStates().map((state) => state.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(new Set(sequences).size, sequences.length, "sequence strictly increases");

    const published = f.sftpStates().length;
    assert.ok((await f.terminals.closeTerminal({ owner, ...terminal.value })).ok);
    assert.equal(f.sftpStates().length, published, "terminal lifecycle publishes no SFTP state");
    assert.deepEqual(await f.controller.closeSftp({ owner, ...terminal.value }), failure("conflict"), "a terminal is not an SFTP target");
    assert.deepEqual(await f.controller.dismissSftp({ owner, ...terminal.value }), failure("conflict"));
    assert.equal(f.registry.snapshot(ownerId, terminal.value.sessionId).length, 1);

    assert.deepEqual(await f.controller.closeSftp(f.target), ok);
    assert.deepEqual(f.view().map((s) => [s.phase, s.home]), [["closed", null]], "home is only known while Ready");
  } finally { await f.dispose(); }
});

test("remote file requests reach only the exact owner, session, generation and kind while Ready", async () => {
  const f = await fixture();
  try {
    const path = "/home/fixture";
    const list = (source: unknown, requester = owner) => f.controller.listDirectory({ owner: requester, source, path } as never);
    assert.deepEqual(await list({ ...f.source, generation: 2 }), failure("conflict"), "stale generation");
    assert.deepEqual(await list({ ...f.source, sessionId: "unknown" }), failure("conflict"), "unknown session");
    assert.deepEqual(await list(f.source, other), failure("conflict"), "another window's session looks missing");
    assert.deepEqual(await list(f.source, { windowId: 9, generation: 9 }), failure("stale-owner"));
    assert.deepEqual(await f.controller.listDirectory({ owner, source: f.source, path: "relative" }), failure("invalid-request"));
    assert.deepEqual(await f.controller.statPath({ owner, source: f.source, path: "~" }), failure("invalid-request"));
    for (const method of ["listDirectory", "statPath", "resolvePath"] as const)
      assert.deepEqual(await f.controller[method](null as never), failure("invalid-request"), method);
    const terminal = await f.terminals.connectHost({ owner, hostId });
    assert.ok(terminal.ok);
    await f.ready({ drained: Promise.resolve(), dispose() {}, open: () => true, ack() {}, write: () => "ok", resize() {} });
    assert.deepEqual(await list({ kind: "remote", ...terminal.value }), failure("conflict"), "a terminal session is not a file source");

    const pending = await f.controller.connectSftp({ owner, hostId });
    assert.ok(pending.ok);
    await tick();
    assert.deepEqual(await list({ kind: "remote", ...pending.value }), failure("conflict"), "not Ready yet");
    assert.equal(f.remote.calls.length, 0);

    const listed = await list(f.source);
    assert.ok(listed.ok && listed.value.ok);
    assert.deepEqual(f.remote.calls, [["list", path]]);
    f.context.failed("network");
    await tick();
    assert.deepEqual(await list(f.source), failure("conflict"), "a failed generation is fenced");
    assert.equal(f.remote.calls.length, 1);
  } finally { await f.dispose(); }
});

test("remote results are rebuilt from fixed fields and codes; server text never crosses", async () => {
  const f = await fixture();
  try {
    const listed = await f.controller.listDirectory({ owner, source: f.source, path: "/home//fixture/./" });
    assert.deepEqual(listed, { ok: true, value: { ok: true, value: { path: "/home/fixture", truncated: false, skipped: 2, entries: [
      { name: "a\u001b[31m", addressable: true, ...fileAttrs },
      { name: "�", addressable: false, type: "other", size: null, mtime: null, permissions: null },
    ] } } });
    assert.deepEqual(f.remote.calls.at(-1), ["list", "/home/fixture"]);
    assert.deepEqual(await f.controller.statPath({ owner, source: f.source, path: "/x" }), { ok: true, value: { ok: true, value: fileAttrs } });

    const before = f.remote.calls.length;
    const long = await f.controller.listDirectory({ owner, source: f.source, path: "/" + "ก".repeat(2_000) });
    assert.deepEqual(long, { ok: true, value: { ok: false, error: "invalid-path" } }, "4,096 UTF-16 units but over 4,096 UTF-8 bytes");
    assert.equal(f.remote.calls.length, before);

    const mapped: [SftpFailure, string][] = [["not-found", "not-found"], ["permission-denied", "permission-denied"], ["failure", "failure"],
      ["invalid-path", "invalid-path"], ["unsupported", "unsupported"], ["connection-lost", "connection-lost"],
      ["resource-limit", "resource-limit"], ["closed", "closed"], ["cancelled", "failure"], ["invalid-request", "invalid-path"]];
    const replies: unknown[] = [listed];
    for (const [code, error] of mapped) {
      f.remote.fail(code);
      for (const reply of [
        await f.controller.listDirectory({ owner, source: f.source, path: "/x" }),
        await f.controller.statPath({ owner, source: f.source, path: "/x" }),
        await f.controller.resolvePath({ owner, source: f.source, path: "~" }),
      ]) {
        assert.deepEqual(reply, { ok: true, value: { ok: false, error } }, code);
        replies.push(reply);
      }
    }
    assert.equal(JSON.stringify(replies).includes("server says"), false);
    assert.equal(JSON.stringify(replies).includes("/etc"), false);
  } finally { await f.dispose(); }
});

test("resolvePath takes '~' and relative input from the source's home", async () => {
  const f = await fixture();
  try {
    for (const [input, resolved] of [["~", "/home/fixture"], ["~/a/../b", "/home/fixture/b"], ["docs", "/home/fixture/docs"],
      ["~other", "/home/fixture/~other"], ["/srv//x/", "/srv/x"]]) {
      assert.deepEqual(await f.controller.resolvePath({ owner, source: f.source, path: input }), { ok: true, value: { ok: true, value: resolved } }, input);
    }
  } finally { await f.dispose(); }

  const raw = await mkdtemp(join(tmpdir(), "ssterm-resolve-"));
  const home = await realpath(raw);
  await mkdir(join(home, "ไทย"));
  const g = await fixture({ local: createLocalFiles(raw) });
  try {
    const local = { kind: "local" as const };
    const resolve = (path: string) => g.controller.resolvePath({ owner, source: local, path });
    assert.deepEqual(await resolve("~"), { ok: true, value: { ok: true, value: home } }, "realpath of the home itself");
    assert.deepEqual(await resolve("~/ไทย"), { ok: true, value: { ok: true, value: join(home, "ไทย") } });
    assert.deepEqual(await resolve("ไทย/.."), { ok: true, value: { ok: true, value: home } });
    assert.deepEqual(await resolve("~/missing"), { ok: true, value: { ok: false, error: "not-found" } });
  } finally { await g.dispose(); await rm(home, { recursive: true, force: true }); }
});

test("local requests never touch the registry, work while locked and allow two in flight across all windows", async () => {
  const waiting: (() => void)[] = [];
  let calls = 0;
  const empty = { entries: [], truncated: false, skipped: 0 };
  const local: LocalFiles = {
    home: "/Users/fixture",
    realpath: async (path) => ({ ok: true, value: path }),
    stat: async () => ({ ok: true, value: fileAttrs }),
    lstat: async () => ({ ok: true, value: fileAttrs }),
    list: () => { calls++; return new Promise((done) => waiting.push(() => done({ ok: true, value: empty }))); },
  };
  const f = await fixture({ local });
  try {
    await f.registry.lock();
    const lookups = f.sftpLookups.length;
    const request = { owner, source: { kind: "local" as const }, path: "/Users" };
    const first = f.controller.listDirectory(request);
    const second = f.controller.listDirectory(request);
    await tick();
    assert.equal(calls, LOCAL_FILES_IN_FLIGHT);
    const third = f.controller.listDirectory(request);
    await tick();
    assert.equal(calls, 2, "a third local request never reaches the provider");
    assert.deepEqual(await third, failure("busy"));
    assert.deepEqual(await f.controller.statPath(request), failure("busy"), "the cap covers every local operation");
    assert.equal(calls, 2);
    f.controller.register({ windowId: 3, generation: 1 }, () => {});
    const elsewhere = { ...request, owner: { windowId: 3, generation: 1 } };
    assert.deepEqual(await f.controller.listDirectory(elsewhere), failure("busy"), "the budget is shared by every window");
    assert.equal(calls, 2);
    waiting.shift()!();
    assert.deepEqual(await first, { ok: true, value: { ok: true, value: { path: "/Users", ...empty } } });
    assert.ok((await f.controller.statPath(elsewhere)).ok, "a finished request frees its slot");
    for (const done of waiting.splice(0)) done();
    assert.ok((await second).ok);
    assert.equal(f.sftpLookups.length, lookups, "local requests never look up a session");

    const revoked = f.controller.listDirectory(request);
    await tick();
    f.controller.revokeOwner(owner);
    for (const done of waiting.splice(0)) done();
    assert.deepEqual(await revoked, failure("stale-owner"), "a reply for a revoked window is dropped");
    assert.deepEqual(await f.controller.listDirectory(request), failure("stale-owner"));
  } finally { await f.dispose(); }
});

test("a local operation that never returns times out as not-responding, frees its slot and is aborted", async () => {
  const signals: AbortSignal[] = [];
  const never = <T>(_path: string, signal?: AbortSignal) => { signals.push(signal!); return new Promise<T>(() => {}); };
  const local: LocalFiles = { home: "/Volumes/dead", realpath: never, stat: never, lstat: never, list: never };
  const f = await fixture({ local, localTimeoutMs: 20 });
  try {
    const request = { owner, source: { kind: "local" as const }, path: "/Volumes/dead" };
    const hung = [f.controller.listDirectory(request), f.controller.statPath(request)];
    await tick();
    assert.deepEqual(await f.controller.resolvePath(request), failure("busy"), "both slots are held while they hang");
    for (const outcome of await Promise.all(hung)) assert.deepEqual(outcome, { ok: true, value: { ok: false, error: "not-responding" } });
    assert.ok(signals.length === 2 && signals.every((signal) => signal.aborted), "the provider is told to stop");
    assert.deepEqual(await f.controller.listDirectory(request), { ok: true, value: { ok: false, error: "not-responding" } },
      "a timed-out operation no longer holds a slot");
  } finally { await f.dispose(); }
});

test("an mtime past what a Date can show crosses the boundary as null", async () => {
  const listing = { truncated: false, skipped: 0, entries: [{ name: "far", addressable: true, ...fileAttrs, mtime: 8_640_000_000_001 }] };
  const local: LocalFiles = {
    home: "/", realpath: async (path) => ({ ok: true, value: path }), lstat: async () => ({ ok: true, value: fileAttrs }),
    stat: async () => ({ ok: true, value: { ...fileAttrs, mtime: Number.MAX_SAFE_INTEGER } }),
    list: async () => ({ ok: true, value: listing }),
  };
  const f = await fixture({ local });
  try {
    const request = { owner, source: { kind: "local" as const }, path: "/" };
    const listed = await f.controller.listDirectory(request);
    assert.ok(listed.ok && listed.value.ok);
    assert.equal(listed.value.value.entries[0]!.mtime, null);
    assert.deepEqual(await f.controller.statPath(request), { ok: true, value: { ok: true, value: { ...fileAttrs, mtime: null } } });
  } finally { await f.dispose(); }
});

test("SFTP lifecycle: connect opens an SFTP session; a locked connect or reconnect unlocks once", async () => {
  let checks = 0;
  let allowed = true;
  const f = await fixture({ checkAccess: async () => { checks += 1; return allowed; } });
  try {
    assert.equal(f.registry.snapshot(ownerId, f.source.sessionId)[0]!.kind, "sftp");
    assert.deepEqual(await f.controller.reconnectSftp(f.target), failure("conflict"), "a Ready session cannot be reconnected");
    await f.registry.lock();
    assert.deepEqual(f.view().map((s) => [s.phase, s.error, s.home]), [["closed", "locked", null]]);
    assert.equal(checks, 0);
    allowed = false;
    assert.deepEqual(await f.controller.reconnectSftp(f.target), failure("unavailable"));
    assert.equal(checks, 1, "one unlock attempt per click");
    allowed = true;
    assert.deepEqual(await f.controller.reconnectSftp(f.target), ok);
    assert.equal(checks, 2);
    assert.equal(f.registry.snapshot(ownerId, f.source.sessionId)[0]!.kind, "sftp", "reconnect keeps the kind");
    const second = fakeSftp("/srv");
    await f.ready(second.channel);
    assert.deepEqual(f.view().map((s) => [s.generation, s.phase, s.home]), [[2, "ready", "/srv"]]);
    const old = await f.controller.listDirectory({ owner, source: f.source, path: "/" });
    assert.deepEqual(old, failure("conflict"), "the old generation stays fenced");

    await f.registry.lock();
    const connected = await f.controller.connectSftp({ owner, hostId });
    assert.ok(connected.ok);
    assert.equal(checks, 3, "a Connect after a lock unlocks exactly once");
    assert.equal(f.registry.snapshot(ownerId, connected.value.sessionId)[0]!.kind, "sftp");

    const target = { ...f.target, generation: 2 };
    assert.deepEqual(await f.controller.dismissSftp(target), ok);
    assert.equal(f.registry.snapshot(ownerId, f.source.sessionId).length, 0);
    assert.ok(f.sftpStates().at(-1)!.sessions.every((s) => s.sessionId !== f.source.sessionId), "dismiss republishes");
    assert.deepEqual(await f.controller.connectSftp({ owner, hostId: "../x" } as never), failure("invalid-request"));
  } finally { await f.dispose(); }
});

test("SFTP IPC authorizes the owning main frame, requires one valid argument and removes every handler", async () => {
  const f = await fixture();
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sent: { channel: string; value: unknown }[] = [];
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send: (channel: string, value: unknown) => sent.push({ channel, value }) };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } } satisfies Pick<IpcMain, "handle" | "removeHandler">;
  const unregister = registerSftpHandlers({ ipc, boundary, controller: () => f.controller });
  const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event as IpcMainInvokeEvent, ...args);
  const event = { sender, senderFrame: mainFrame };
  const request = { owner, source: f.source, path: "/home/fixture" };
  try {
    assert.deepEqual([...handlers.keys()].sort(), [...sftpChannels].sort());
    assert.equal(sftpChannels.length, 8);
    for (const channel of sftpChannels) {
      assert.deepEqual(await invoke(channel, { sender: { ...sender }, senderFrame: mainFrame }, request), failure("unauthorized"), channel);
      assert.deepEqual(await invoke(channel, event, { ...request, owner: { windowId: 2, generation: 1 } }), failure("unauthorized"), channel);
      assert.deepEqual(await invoke(channel, event, { owner }, { owner }), failure("invalid-request"), channel);
    }
    assert.deepEqual(await invoke(channels.listDirectory, event, { ...request, path: "~" }), failure("invalid-request"));
    assert.deepEqual(await invoke(channels.statPath, event, { ...request, source: { kind: "remote" } }), failure("invalid-request"));
    assert.equal(f.remote.calls.length, 0);
    assert.ok(((await invoke(channels.listDirectory, event, request)) as { ok: boolean }).ok);
    assert.ok(((await invoke(channels.resolvePath, event, { ...request, path: "~" })) as { ok: boolean }).ok);
    const state = await invoke(channels.sftpState, event, { owner }) as { ok: true; value: SftpState };
    assert.ok(state.ok && isSftpState(state.value));
    assert.deepEqual(await invoke(channels.closeSftp, event, f.target), ok);
    assert.ok(sent.some((entry) => entry.channel === channels.sftpStateChanged), "the invoking window receives state");
  } finally { unregister(); assert.equal(handlers.size, 0); boundary.dispose(); await f.dispose(); }
});
