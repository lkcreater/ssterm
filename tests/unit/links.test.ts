import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { registerLinkHandlers, validateExternalUrl } from "../../apps/desktop/src/main/links.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { channels, failure, isOpenLinkRequest, isOpenLinkResponse } from "../../packages/contracts/src/index.ts";

test("external URL validator returns normalized http(s) hrefs only", () => {
  assert.equal(validateExternalUrl("https://example.com"), "https://example.com/");
  assert.equal(validateExternalUrl("http://example.com:8080/a b?q=ไทย#x"), "http://example.com:8080/a%20b?q=%E0%B9%84%E0%B8%97%E0%B8%A2#x");
  assert.equal(validateExternalUrl("https://bücher.example/"), "https://xn--bcher-kva.example/");
  assert.equal(validateExternalUrl("HTTPS://EXAMPLE.COM/Path"), "https://example.com/Path");
  for (const rejected of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "file:///etc/passwd", "data:text/html,<b>x</b>", "ftp://example.com/",
    "ssh://example.com", "about:blank", "https://user:pass@example.com/", "https://user@example.com/", "https://:pass@example.com/",
    "example.com", "", "https://", `https://example.com/${"a".repeat(2048)}`,
    // Within the raw limit but over it once percent-encoded.
    `https://example.com/${"ไ".repeat(300)}`,
  ]) assert.equal(validateExternalUrl(rejected), undefined, rejected);
  for (const value of [undefined, null, 1, {}, ["https://example.com"], new URL("https://example.com")])
    assert.equal(validateExternalUrl(value), undefined);
  assert.ok(isOpenLinkRequest({ owner: { windowId: 1, generation: 1 }, url: "x" }));
  for (const invalid of [
    { owner: { windowId: 1, generation: 1 }, url: "" }, { owner: { windowId: 1, generation: 1 }, url: "a".repeat(2049) },
    { owner: { windowId: 1, generation: 1 }, url: 1 }, { owner: { windowId: 1, generation: 1 }, url: "x", extra: true }, { url: "x" },
  ]) assert.equal(isOpenLinkRequest(invalid), false);
  assert.ok(isOpenLinkResponse({ opened: false }));
  assert.equal(isOpenLinkResponse({ opened: 1 }), false);
});

test("open-link IPC authorizes sender and owner, requires one valid request and opens only the normalized href", async () => {
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send: () => {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } } satisfies Pick<IpcMain, "handle" | "removeHandler">;
  const opened: { href: string; sender: unknown }[] = [];
  let answer: boolean | Error = true;
  const unregister = registerLinkHandlers({ ipc, boundary, open: async (href, from) => {
    opened.push({ href, sender: from });
    if (answer instanceof Error) throw answer;
    return answer;
  } });
  const invoke = (event: unknown, ...args: unknown[]) => handlers.get(channels.openLink)!(event as IpcMainInvokeEvent, ...args);
  const event = { sender, senderFrame: mainFrame };
  const owner = { windowId: 1, generation: 1 };
  try {
    assert.deepEqual([...handlers.keys()], [channels.openLink]);
    const request = { owner, url: "https://example.com/docs" };
    for (const forged of [{ sender: { ...sender }, senderFrame: mainFrame }, { sender, senderFrame: { url: mainFrame.url } }, { sender, senderFrame: null }])
      assert.deepEqual(await invoke(forged, request), failure("unauthorized"));
    assert.deepEqual(await invoke(event, { ...request, owner: { windowId: 2, generation: 1 } }), failure("unauthorized"));
    assert.deepEqual(await invoke(event, { ...request, owner: { windowId: 1, generation: 9 } }), failure("stale-owner"));
    assert.deepEqual(await invoke(event), failure("invalid-request"));
    assert.deepEqual(await invoke(event, request, request), failure("invalid-request"));
    assert.deepEqual(await invoke(event, { ...request, extra: true }), failure("invalid-request"));
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.com/", "a".repeat(2049), 7])
      assert.deepEqual(await invoke(event, { owner, url }), failure("invalid-request"), String(url));
    assert.equal(opened.length, 0, "rejected requests never reach the opener");

    assert.deepEqual(await invoke(event, { owner, url: "HTTPS://Bücher.example/a b" }), { ok: true, value: { opened: true } });
    assert.deepEqual(opened, [{ href: "https://xn--bcher-kva.example/a%20b", sender }]);
    answer = false;
    assert.deepEqual(await invoke(event, request), { ok: true, value: { opened: false } });
    answer = new Error("/private/path from the OS");
    assert.deepEqual(await invoke(event, request), failure("unavailable"));
  } finally { unregister(); assert.equal(handlers.size, 0); boundary.dispose(); }
});
