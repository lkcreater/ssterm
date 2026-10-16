import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerSettingsHandlers } from "../../apps/desktop/src/main/settings.ts";
import { closePrompt } from "../../apps/desktop/src/main/terminals.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import type { MetadataRepository } from "../../packages/domain/src/index.ts";
import {
  channels, DEFAULT_TERMINAL_SETTINGS, failure, isTerminalSettings, isUpdateSettingsRequest, type TerminalSession,
} from "../../packages/contracts/src/index.ts";

const owner = { windowId: 1, generation: 1 };

test("terminal settings guards accept only the four bounded fields", () => {
  assert.ok(isTerminalSettings(DEFAULT_TERMINAL_SETTINGS));
  assert.ok(isTerminalSettings({ terminalFontSize: 32, terminalScrollback: 100, terminalCursor: "underline", terminalCursorBlink: true }));
  for (const invalid of [
    { ...DEFAULT_TERMINAL_SETTINGS, terminalFontSize: 9 }, { ...DEFAULT_TERMINAL_SETTINGS, terminalFontSize: 13.5 },
    { ...DEFAULT_TERMINAL_SETTINGS, terminalScrollback: 100_001 }, { ...DEFAULT_TERMINAL_SETTINGS, terminalCursor: "beam" },
    { ...DEFAULT_TERMINAL_SETTINGS, terminalCursorBlink: 1 }, { ...DEFAULT_TERMINAL_SETTINGS, theme: "dark" },
    { terminalFontSize: 13 }, null, [],
  ]) assert.equal(isTerminalSettings(invalid), false, JSON.stringify(invalid));
  assert.ok(isUpdateSettingsRequest({ owner, changes: { terminalCursor: "bar" } }));
  assert.ok(isUpdateSettingsRequest({ owner, changes: { ...DEFAULT_TERMINAL_SETTINGS } }));
  for (const changes of [
    {}, { theme: "dark" }, { uiFontSize: 14 }, { reducedMotion: "on" }, { terminalPalette: "x" }, { terminalFontSize: 33 },
    { terminalScrollback: 99 }, { terminalCursorBlink: "true" }, { terminalCursor: "bar", uiFont: "Inter" }, null, [],
    JSON.parse('{"__proto__":{"terminalFontSize":12}}'),
  ]) assert.equal(isUpdateSettingsRequest({ owner, changes }), false, JSON.stringify(changes));
  assert.equal(isUpdateSettingsRequest({ owner, changes: { terminalFontSize: 12 }, extra: 1 }), false);
  assert.equal(isUpdateSettingsRequest({ changes: { terminalFontSize: 12 } }), false);
});

test("settings IPC authorizes, reads defaults, persists updates across reopen and maps storage failures", async () => {
  const dir = mkdtempSync("/private/tmp/ssterm-settings-boundary-");
  const path = join(dir, "catalog.sqlite");
  const open = async () => {
    const opened = await openMetadata({ path });
    assert.ok(opened.ok);
    return opened.value;
  };
  let repository: MetadataRepository | undefined = await open();
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send: () => {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } } satisfies Pick<IpcMain, "handle" | "removeHandler">;
  const unregister = registerSettingsHandlers({ ipc, boundary, repository: () => repository });
  const event = { sender, senderFrame: mainFrame };
  const invoke = (channel: string, from: unknown, ...args: unknown[]) => handlers.get(channel)!(from as IpcMainInvokeEvent, ...args);
  const read = () => invoke(channels.settings, event, { owner });
  const update = (changes: unknown) => invoke(channels.updateSettings, event, { owner, changes });
  try {
    assert.deepEqual([...handlers.keys()].sort(), [channels.settings, channels.updateSettings].sort());
    assert.deepEqual(read(), { ok: true, value: DEFAULT_TERMINAL_SETTINGS });
    for (const channel of [channels.settings, channels.updateSettings]) {
      const request = channel === channels.settings ? { owner } : { owner, changes: { terminalFontSize: 14 } };
      for (const forged of [{ sender: { ...sender }, senderFrame: mainFrame }, { sender, senderFrame: { url: mainFrame.url } }, { sender, senderFrame: null }])
        assert.deepEqual(invoke(channel, forged, request), failure("unauthorized"));
      assert.deepEqual(invoke(channel, event, { ...request, owner: { windowId: 2, generation: 1 } }), failure("unauthorized"));
      assert.deepEqual(invoke(channel, event, { ...request, owner: { windowId: 1, generation: 9 } }), failure("stale-owner"));
      assert.deepEqual(invoke(channel, event), failure("invalid-request"));
      assert.deepEqual(invoke(channel, event, request, request), failure("invalid-request"));
      assert.deepEqual(invoke(channel, event, { ...request, extra: true }), failure("invalid-request"));
    }
    for (const changes of [{}, { theme: "dark" }, { terminalFontSize: 40 }, { terminalCursor: "beam" }])
      assert.deepEqual(update(changes), failure("invalid-request"));

    const before = repository.snapshot();
    assert.ok(before.ok);
    const expected = { terminalFontSize: 18, terminalScrollback: 5000, terminalCursor: "bar", terminalCursorBlink: true };
    assert.deepEqual(update({ terminalFontSize: 18, terminalCursor: "bar" }), { ok: true, value: { ...DEFAULT_TERMINAL_SETTINGS, terminalFontSize: 18, terminalCursor: "bar" } });
    assert.deepEqual(update({ terminalScrollback: 5000, terminalCursorBlink: true }), { ok: true, value: expected });
    const after = repository.snapshot();
    assert.ok(after.ok);
    assert.equal(after.value.catalogRevision, before.value.catalogRevision, "settings writes are not catalog edits");
    assert.equal(after.value.settings.revision, before.value.settings.revision + 2);
    assert.equal(after.value.settings.uiFontSize, before.value.settings.uiFontSize);

    repository.close();
    repository = await open();
    assert.deepEqual(read(), { ok: true, value: expected });

    repository.close();
    assert.deepEqual(read(), failure("unavailable"), "a closed store is unavailable");
    repository = undefined;
    assert.deepEqual(read(), failure("unavailable"));
    assert.deepEqual(update({ terminalFontSize: 12 }), failure("unavailable"));
  } finally {
    unregister();
    assert.equal(handlers.size, 0);
    boundary.dispose();
    repository?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close and quit prompts list only Ready sessions with PROD and the full endpoint", () => {
  const session = (phase: TerminalSession["phase"], target: TerminalSession["target"], id = "s1"): TerminalSession =>
    ({ sessionId: id, generation: 1, hostId: "h1", phase, target, end: null, error: null });
  const prod = { label: "billing", environment: "PROD" as const, endpointHost: "db.example", endpointPort: 22, username: "deploy" };
  const v6 = { label: "lab", environment: null, endpointHost: "2001:db8::1", endpointPort: 2222, username: null };
  assert.equal(closePrompt([], "close"), undefined);
  assert.equal(closePrompt([session("connecting", prod), session("closed", prod), session("failed", v6)], "quit"), undefined);
  assert.deepEqual(closePrompt([session("ready", prod), session("connecting", v6, "s2")], "close"), {
    message: "Close this window and disconnect 1 connected session?",
    detail: "PROD · billing — deploy@db.example:22",
  });
  assert.deepEqual(closePrompt([session("ready", prod), session("ready", v6, "s2")], "quit"), {
    message: "Quit ssterm and disconnect 2 connected sessions?",
    detail: "PROD · billing — deploy@db.example:22\nlab — [2001:db8::1]:2222",
  });
  const many = closePrompt(Array.from({ length: 11 }, (_, index) => session("ready", v6, `s${index}`)), "quit")!;
  assert.equal(many.detail.split("\n").length, 9);
  assert.equal(many.detail.split("\n").at(-1), "and 3 more");
});
