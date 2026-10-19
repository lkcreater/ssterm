import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { registerRecordingHandlers, recordingChannels, exportName } from "../../apps/desktop/src/main/recordings.ts";
import { createTerminalController } from "../../apps/desktop/src/main/terminals.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { createDesktopBridge } from "../../apps/desktop/src/preload/bridge.ts";
import {
  channels, failure, isConfigureRecordingRequest, isDeleteRecordingsRequest, isExportRecordingRequest, isForgetCommandRequest,
  isRecordingState, isSuggestCommandsRequest, isSuggestCommandsResponse, isTerminalSession, DEFAULT_RECORDING_POLICY,
  type Result, type TerminalState,
} from "../../packages/contracts/src/index.ts";
import { createRecorder, SessionRegistry, TransientSecrets, type Recorder, type SessionSnapshot } from "../../packages/services/src/index.ts";
import { createRecordingFiles } from "../../packages/adapters/src/recording-files.ts";
import type { RecordingKeys } from "../../packages/domain/src/recording.ts";
import type { TerminalChannel } from "../../packages/domain/src/index.ts";

const owner = { windowId: 1, generation: 1 };
const sessionId = randomUUID();
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("recording guards: exact keys, bounded policy, scope never from the renderer, display-safe text both ways", () => {
  assert.ok(isConfigureRecordingRequest({ owner, policy: { ...DEFAULT_RECORDING_POLICY, logs: true } }));
  assert.equal(isConfigureRecordingRequest({ owner, policy: { ...DEFAULT_RECORDING_POLICY, logDays: 0 } }), false);
  assert.ok(isDeleteRecordingsRequest({ owner, target: { kind: "all" } }));
  assert.equal(isDeleteRecordingsRequest({ owner, target: { kind: "log", id: "../x" } }), false);
  assert.ok(isExportRecordingRequest({ owner, target: { kind: "history" } }));
  assert.equal(isExportRecordingRequest({ owner, target: { kind: "history" }, path: "/tmp/x" }), false, "no path crosses IPC");
  assert.ok(isSuggestCommandsRequest({ owner, sessionId, generation: 1, prefix: "" }));
  for (const bad of [{ owner, sessionId, generation: 1, prefix: "a\u0007" }, { owner, sessionId, generation: 1, prefix: "x".repeat(1025) },
    { owner, sessionId, generation: 1, prefix: "", scope: "host" }, { owner, sessionId, generation: 0, prefix: "" }])
    assert.equal(isSuggestCommandsRequest(bad), false, JSON.stringify(bad).slice(0, 80));
  assert.ok(isForgetCommandRequest({ owner, sessionId, generation: 1, text: "ls" }));
  assert.equal(isForgetCommandRequest({ owner, sessionId, generation: 1, text: " ls" }), false);
  assert.ok(isSuggestCommandsResponse({ status: "ok", suggestions: ["git status"] }));
  for (const bad of [["a\rb"], ["‮evil"], [" leading"], Array.from({ length: 9 }, (_, i) => `c${i}`)])
    assert.equal(isSuggestCommandsResponse({ status: "ok", suggestions: bad }), false, JSON.stringify(bad));
  const base = { sessionId, generation: 1, hostId: null, local: { shell: "/bin/zsh", platform: "darwin" }, phase: "ready", target: null, end: null, error: null };
  assert.ok(isTerminalSession(base));
  assert.ok(isTerminalSession({ ...base, recording: { output: true, commands: false, state: "on", gaps: false, problem: null } }));
  assert.equal(isTerminalSession({ ...base, recording: { output: true, commands: false, state: "on", gaps: false, problem: "disk" } }), false);
  assert.match(exportName({ kind: "history" }, { state: () => { throw new Error("unused"); } }, new Date(2026, 9, 19, 8, 5)), /^ssterm-command-history-2026-10-19-0805\.txt$/u);
});

test("recording IPC: owner-authorized, app-lock gated, one valid argument, scope from the exact live generation", async (t) => {
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send() {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  let open = true;
  boundary.setAccessGate(() => open);
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } };
  const calls: string[] = [];
  const state = { policy: { ...DEFAULT_RECORDING_POLICY }, problem: null, logs: [], logCount: 0, logBytes: 0, historyFiles: 0, historyBytes: 0 };
  const recorder = {
    state: () => (calls.push("state"), state),
    suggest: async (scope: string, prefix: string) => (calls.push(`suggest:${scope}:${prefix}`), { status: "ok", suggestions: ["ls -la"] }),
    forget: async (scope: string, text: string) => (calls.push(`forget:${scope}:${text}`), { status: "forgotten" }),
    export: async (_target: unknown, destination: string) => (calls.push(`export:${destination}`), { status: "saved", incomplete: false, gaps: 0 }),
  } as unknown as Recorder;
  const snapshots: Partial<SessionSnapshot>[] = [{ id: sessionId, kind: "terminal", generation: 2, hostId: "host-a", state: "Ready" }];
  const registry = { snapshot: (ownerId: string, id?: string) => ownerId === sessionOwnerId(owner) ? snapshots.filter((s) => s.id === id) as SessionSnapshot[] : [] };
  let destination: string | undefined;
  const chosen: string[] = [];
  const unregister = registerRecordingHandlers({ ipc, boundary, recorder: () => recorder, registry: () => registry,
    chooseDestination: async (_owner, name) => (chosen.push(name), destination) });
  t.after(unregister);
  assert.deepEqual([...handlers.keys()].sort(), [...recordingChannels].sort());
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  assert.deepEqual(await call(channels.suggestCommands, { owner, sessionId, generation: 2, prefix: "l" }), { ok: true, value: { status: "ok", suggestions: ["ls -la"] } });
  assert.deepEqual(await call(channels.suggestCommands, { owner, sessionId, generation: 1, prefix: "l" }), failure("conflict"), "stale generation");
  snapshots[0]!.state = "Closing";
  assert.deepEqual(await call(channels.forgetCommand, { owner, sessionId, generation: 2, text: "ls" }), failure("conflict"), "not Ready");
  snapshots[0]!.state = "Ready";
  snapshots[0]!.hostId = null;
  assert.deepEqual(await call(channels.forgetCommand, { owner, sessionId, generation: 2, text: "ls" }), { ok: true, value: { status: "forgotten" } });
  assert.deepEqual(calls, ["suggest:host-a:l", "forget:local:ls"]);
  assert.deepEqual(await call(channels.exportRecording, { owner, target: { kind: "history" } }), { ok: true, value: { status: "cancelled" } });
  destination = "/private/tmp/chosen.txt";
  assert.deepEqual(await call(channels.exportRecording, { owner, target: { kind: "history" } }), { ok: true, value: { status: "saved", incomplete: false, gaps: 0 } });
  assert.match(chosen[0]!, /^ssterm-command-history-/u);
  assert.equal(calls.at(-1), "export:/private/tmp/chosen.txt");
  assert.deepEqual(await call(channels.recordingState, { owner }, "extra"), failure("invalid-request"));
  assert.deepEqual(await call(channels.recordingState, { owner: { windowId: 1, generation: 9 } }), failure("stale-owner"));
  const forged = { sender, senderFrame: { url: "https://evil.example/" } } as unknown as IpcMainInvokeEvent;
  assert.equal(((await handlers.get(channels.recordingState)!(forged, { owner })) as Result<unknown>).ok, false);
  const before = calls.length;
  open = false;
  assert.deepEqual(await call(channels.recordingState, { owner }), failure("unauthorized"), "the app lock answers first");
  assert.equal(calls.length, before, "the recorder is not read while the app is locked");
});

test("the preload bridge rebuilds recording requests and drops replies with unsafe suggestions", async () => {
  const sent: { channel: string; args: unknown[] }[] = [];
  let reply: unknown = { ok: true, value: { status: "ok", suggestions: ["git status"] } };
  const { api } = createDesktopBridge({ invoke: async (channel, ...args) => (sent.push({ channel, args }), reply), on() {}, removeListener() {} });
  const request = { owner, sessionId, generation: 1, prefix: "git" };
  assert.deepEqual(await api.suggestCommands(request), reply);
  assert.deepEqual(sent.at(-1), { channel: channels.suggestCommands, args: [request] });
  reply = { ok: true, value: { status: "ok", suggestions: ["git status\r"] } };
  assert.deepEqual(await api.suggestCommands(request), failure("unavailable"));
  assert.deepEqual(await api.exportRecording({ owner, target: { kind: "history" }, path: "/x" } as never), failure("invalid-request"));
  reply = { ok: true, value: { policy: DEFAULT_RECORDING_POLICY, problem: null, logs: [], logCount: 0, logBytes: 0, historyFiles: 0, historyBytes: 0 } };
  assert.ok(isRecordingState((reply as { value: unknown }).value));
  assert.deepEqual(await api.recordingState({ owner }), reply);
});

test("the terminal state projects each generation's recording badge and a recorder change republishes that owner only", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "ssterm-recording-projection-"));
  const keys: RecordingKeys = {
    prepare: async () => ({ ok: true }), open: async () => ({ ok: false, reason: "missing" }),
    seal: async (items) => ({ ok: false, reason: items.length ? "denied" : "missing" }),
  };
  t.after(() => rm(profile, { recursive: true, force: true }));
  // Capture is wanted (policy on) but every key wrap is denied, so the badge must say why it is not recording.
  await createRecordingFiles({ root: join(profile, "recordings") }).writePolicy({ ...DEFAULT_RECORDING_POLICY, logs: true });
  const capture = createRecorder({ files: createRecordingFiles({ root: join(profile, "recordings") }), keys: () => keys });
  await capture.ready;
  t.after(() => capture.dispose());
  const locals: { ready(channel: TerminalChannel): boolean }[] = [];
  const registry = new SessionRegistry({
    resolve: () => ({ ok: false, error: { code: "unavailable", message: "x" } }), transient: new TransientSecrets(),
    adapter: { start: (context) => context.failed("subsystem-unavailable") }, observeTerminal: capture.observe,
    localAdapter: { metadata: { shell: "/bin/zsh", platform: "darwin" }, start(context) { locals.push(context); } },
  });
  t.after(() => registry.dispose());
  const controller = createTerminalController({ registry, recording: capture });
  t.after(() => controller.dispose());
  const states: TerminalState[] = [];
  const other: TerminalState[] = [];
  controller.register(owner, (_channel, value) => states.push(value as TerminalState));
  controller.register({ windowId: 2, generation: 1 }, (_channel, value) => other.push(value as TerminalState));
  const started = registry.connectLocal(sessionOwnerId(owner));
  assert.ok(started.ok);
  await tick();
  const channel: TerminalChannel = { open: () => true, ack() {}, write: () => "ok", resize() {}, dispose() {}, drained: Promise.resolve() };
  assert.ok(locals[0]!.ready(channel));
  const latest = () => states.at(-1)?.sessions[0]?.recording;
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 100 && latest()?.problem !== "key-unavailable"; i++) await new Promise((done) => setTimeout(done, 5));
  });
  assert.deepEqual(latest(), { output: true, commands: false, state: "stopped", gaps: false, problem: "key-unavailable" });
  assert.equal(other.length, 0, "another owner is never republished");
  await registry.close(sessionOwnerId(owner), started.value.id);
  await tick();
  assert.equal(latest(), undefined, "the badge goes with the generation");
});
