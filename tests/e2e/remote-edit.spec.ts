import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { RemoteEditView } from "../../packages/contracts/src/index";
import { test, expect, type Desktop } from "./fixtures";
import { pane, renderedContrast } from "./support/transfer-fixture";
import { expectDrawerPlaced } from "./support/drawer";

// Credential-bearing main fixture and local/remote text must never enter automatic traces or screenshots.
test.use({ trace: "off", screenshot: "off", video: "off" });
const ROOT = "/home/fixture/remote-edit-ไทย";
const LABEL = "แก้ไขไฟล์ ผลิตจริง";
const NAME = "แก้ไข-🚀.txt";
const original = "original-owned-text\n";
const suffix = "\nบันทึกจาก editor ที่เป็น fixture 🚀\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const row = (page: Page, name: string) => page.getByTestId("remote-edits").locator(`[data-testid="remote-edit"][data-remote-path=${JSON.stringify(`${ROOT}/${name}`)}]`).last();
const dialog = (page: Page, action: string) => page.getByTestId(`remote-edit-${action}-confirm`);
async function snapshot(page: Page): Promise<RemoteEditView[]> {
  return page.evaluate(async () => {
    const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("Bootstrap unavailable");
    const result = await window.ssterm.remoteEditState({ owner: boot.value.owner });
    if (!result.ok) throw new Error("Remote edits unavailable");
    return result.value.edits;
  });
}
async function setup(desktop: Desktop, info: TestInfo) {
  const { app, page } = desktop;
  const boot = await page.evaluate(() => window.ssterm.bootstrap());
  if (!boot.ok) throw new Error("Remote edit bootstrap unavailable");
  await app.evaluate(async ({ app, BrowserWindow, ipcMain, powerMonitor }, parameters) => {
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const production = { ...require(path.join(app.getAppPath(), "out/main/ssh.js")), ...require(path.join(app.getAppPath(), "out/main/secrets.js")) };
    const window = BrowserWindow.getAllWindows()[0];
    const boundary = new production.WindowBoundary(window.webContents.getURL().split("#")[0],
      { name: "ssterm", version: app.getVersion(), platform: process.platform }, () => ({ status: "ready", schemaVersion: 4 }));
    boundary.register(window.webContents, window.id, true, () => {});
    for (let generation = 1; generation < parameters.owner.generation; generation++) boundary.rotate(window.webContents);
    const checked = boundary.bootstrap({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, []);
    if (!checked.ok || JSON.stringify(checked.value.owner) !== JSON.stringify(parameters.owner)) throw new Error("Remote edit owner mismatch");
    const fixture = await require(parameters.fixturePath).startRemoteEditFixture(production, {
      owner: parameters.owner, label: parameters.label, tempDirectory: app.getPath("temp"), power: powerMonitor, nodeBinary: parameters.nodeBinary,
      send: (channel: string, value: unknown) => { if (!window.webContents.isDestroyed()) window.webContents.send(channel, value); },
    });
    for (const channel of [...production.sftpChannels, ...production.remoteEditChannels]) ipcMain.removeHandler(channel);
    const stopSftp = production.registerSftpHandlers({ ipc: ipcMain, boundary, controller: () => fixture.sftp });
    const stopEdits = production.registerRemoteEditHandlers({ ipc: ipcMain, boundary, controller: () => fixture.edits });
    (globalThis as any).__sstermRemoteEditFixture = { fixture, dispose: () => { stopSftp(); stopEdits(); } };
  }, { owner: boot.value.owner, label: LABEL, fixturePath: resolve("tests/fixtures/remote-edit/ssh.cjs"), nodeBinary: process.execPath });
  const operate = <T = any>(method: string, argument?: string | number): Promise<T> => app.evaluate(async (_electron, parameters) => {
    await new Promise<void>((done) => setImmediate(done));
    return (globalThis as any).__sstermRemoteEditFixture.fixture[parameters.method](parameters.argument);
  }, { method, argument });
  const finish = async () => {
    const receipt = await app.evaluate(async () => {
      const owned = (globalThis as any).__sstermRemoteEditFixture;
      owned.dispose(); return owned.fixture.cleanup();
    });
    expect(receipt).toEqual({ fixtureCleaned: true, leftoverItems: 0, labCleaned: true });
    expect(desktop.errors).toEqual([]); expect(desktop.externalRequests).toEqual([]);
    await info.attach("remote-edit-cleanup", { body: JSON.stringify(receipt), contentType: "application/json" });
  };
  try {
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await operate("connect");
    await expect(pane(page, "remote").section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await pane(page, "remote").goto(ROOT);
  } catch (error) { await finish().catch(() => undefined); throw error; }
  const start = async (name: string) => {
    await pane(page, "remote").select([name]);
    await page.getByRole("button", { name: "Edit remote file", exact: true }).click();
    await expect(row(page, name)).toHaveAttribute("data-state", name === "binary.bin" ? "failed" : "ready", { timeout: 20_000 });
    await expect.poll(async () => (await snapshot(page)).find((edit) => edit.remotePath === `${ROOT}/${name}`)?.cleanupPending).toBe(false);
  };
  const open = async (name: string) => {
    await row(page, name).getByRole("button", { name: "Open in TextEdit", exact: true }).click();
    await expect(dialog(page, "open").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await dialog(page, "open").getByRole("button", { name: "Open TextEdit", exact: true }).click();
    await expect(row(page, name)).toHaveAttribute("data-state", "editing");
  };
  const discard = async (name: string, uploaded = false) => {
    await row(page, name).getByRole("button", { name: uploaded ? "Finish edit" : "Discard edit", exact: true }).click();
    await expect(dialog(page, "discard").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await dialog(page, "discard").getByRole("button", { name: uploaded ? "Finish edit" : "Discard working copy", exact: true }).click();
    await expect(row(page, name)).toHaveCount(0);
  };
  return { operate, start, open, discard, finish };
}

test("remote edit uses an owned editor process, private copies and exact explicit snapshot consent", async ({ desktop }, info) => {
  test.setTimeout(240_000);
  const { app, page } = desktop; const lab = await setup(desktop, info);
  try {
    await lab.start(NAME);
    expect(await lab.operate("launches")).toBe(0);
    const local = await lab.operate("localInfo");
    expect(local).toMatchObject({ copies: 1, rootMode: 0o700, pending: 1, documents: [{ mode: 0o600, directoryMode: 0o700, hash: hash(original) }] });
    await row(page, NAME).getByRole("button", { name: "Open in TextEdit", exact: true }).click();
    const confirm = dialog(page, "open");
    await expect(confirm).toContainText(LABEL); await expect(confirm).toContainText(`${ROOT}/${NAME}`);
    await expect(confirm.getByText("PROD", { exact: true })).toBeVisible();
    await expect(confirm).toContainText("plaintext local working copy"); await expect(confirm).toContainText("autosaves");
    await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
    expect(await confirm.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await confirm.evaluate((node) => { const box = node.getBoundingClientRect(); return { right: Math.abs(innerWidth - box.right) <= 0.5, bottom: Math.abs(innerHeight - box.bottom) <= 0.5 }; }), "right-edge drawer below the titlebar").toEqual({ right: true, bottom: true });
    await expect(page.getByRole("alertdialog"), "one confirmation drawer, no stacked overlay").toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expectDrawerPlaced(page, "remote-edit-open-consent");
    const contrasts: Record<string, unknown> = {};
    for (const [name, locator] of [["title", confirm.getByRole("heading")], ["description", confirm.locator('[data-slot="sheet-description"]')], ["cancel", confirm.getByRole("button", { name: "Cancel", exact: true })], ["open", confirm.getByRole("button", { name: "Open TextEdit", exact: true })], ["PROD", confirm.getByText("PROD", { exact: true })]] as const) {
      const measured = await renderedContrast(locator); contrasts[name] = measured; expect(measured.ratio, name).toBeGreaterThanOrEqual(4.5);
    }
    for (let index = 0; index < 5; index++) { await page.keyboard.press("Tab"); await expect.poll(() => confirm.evaluate((node) => node.contains(document.activeElement))).toBe(true); }
    await info.attach("remote-edit-confirm-960x640", { body: await page.screenshot(), contentType: "image/png" });
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row(page, NAME).getByRole("button", { name: "Open in TextEdit", exact: true })).toBeFocused();
    expect(await lab.operate("launches")).toBe(0);
    await lab.open(NAME);
    expect(await lab.operate("launches")).toBe(1);
    expect((await lab.operate("remoteInfo", NAME)).hash, "editor save alone never uploads").toBe(hash(original));
    expect((await lab.operate("localInfo")).documents[0].hash).toBe(hash(original + suffix));
    const state = await snapshot(page);
    expect(Object.keys(state[0]!).sort()).toEqual(["id", "revision", "sessionId", "generation", "target", "remotePath", "state", "localChanged", "localAvailable", "size", "approvalId", "error", "partialPath", "cleanupPending"].sort());
    const renderer = await page.locator("body").innerText();
    expect(renderer).not.toContain("remote-edit-temp"); expect(renderer).not.toContain(original); expect(renderer).not.toContain(suffix.trim());
    await expect(row(page, NAME).getByRole("button", { name: "Upload changes", exact: true })).toBeDisabled();
    await row(page, NAME).getByRole("button", { name: "Check for changes", exact: true }).click();
    await expect(row(page, NAME)).toHaveAttribute("data-state", "changed");
    await row(page, NAME).getByRole("button", { name: "Upload changes", exact: true }).click();
    await expect(dialog(page, "upload")).toContainText("cannot compare and replace atomically");
    await expect(dialog(page, "upload").getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expectDrawerPlaced(page, "remote-edit-upload-consent");
    await dialog(page, "upload").getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await lab.operate("remoteInfo", NAME)).hash).toBe(hash(original));
    await row(page, NAME).getByRole("button", { name: "Upload changes", exact: true }).click();
    await dialog(page, "upload").getByRole("button", { name: "Replace remote file", exact: true }).click();
    await expect(row(page, NAME)).toHaveAttribute("data-state", "uploaded");
    expect(await lab.operate("remoteInfo", NAME)).toMatchObject({ hash: hash(original + suffix), mode: 0o600 });
    expect((await lab.operate("localInfo")).copies, "successful publication retains working copy").toBe(1);
    await lab.discard(NAME, true);
    await expect.poll(async () => (await lab.operate("localInfo")).entries).toBe(0);
    await expect.poll(() => lab.operate("handles")).toBe(0);
    await info.attach("remote-edit-consent-evidence", { body: JSON.stringify({ nativeEditorLaunched: false, ownedEditorProcess: true, originalHash: hash(original), uploadedHash: hash(original + suffix), contrasts, viewport: [960, 640], reducedMotion: true, platform: process.platform }), contentType: "application/json" });
  } finally { await lab.finish(); }
});

test("remote SHA conflict survives equal size/mtime; local saves invalidate approval and rows remain independent", async ({ desktop }, info) => {
  test.setTimeout(240_000);
  const { page } = desktop; const lab = await setup(desktop, info);
  try {
    await lab.start(NAME); await lab.open(NAME);
    const before = await lab.operate("remoteInfo", NAME);
    await lab.operate("mutateSameMetadata", NAME);
    const changed = await lab.operate("remoteInfo", NAME);
    expect(changed.size).toBe(before.size); expect(changed.mtime).toBe(before.mtime); expect(changed.hash).not.toBe(before.hash);
    await row(page, NAME).getByRole("button", { name: "Check for changes", exact: true }).click();
    await expect(row(page, NAME)).toHaveAttribute("data-state", "conflict");
    await expect(row(page, NAME).getByRole("button", { name: "Upload changes", exact: true })).toBeDisabled();
    expect((await lab.operate("remoteInfo", NAME)).hash).toBe(changed.hash);
    await lab.start("second.txt"); await lab.operate("setMode", "append"); await lab.open("second.txt");
    await row(page, "second.txt").getByRole("button", { name: "Check for changes", exact: true }).click();
    await expect(row(page, "second.txt")).toHaveAttribute("data-state", "changed");
    await lab.operate("save", 1);
    await row(page, "second.txt").getByRole("button", { name: "Upload changes", exact: true }).click();
    await dialog(page, "upload").getByRole("button", { name: "Replace remote file", exact: true }).click();
    await expect(row(page, "second.txt")).toHaveAttribute("data-state", "failed");
    await expect(row(page, "second.txt")).toContainText("working copy changed");
    expect((await lab.operate("remoteInfo", "second.txt")).hash).toBe(hash(original));
    await expect(row(page, NAME)).toHaveAttribute("data-state", "conflict");
    await lab.start("binary.bin"); await expect(row(page, "binary.bin")).toContainText("valid UTF-8 text without NUL");
    expect((await lab.operate("localInfo")).copies).toBe(2);
    await lab.discard("binary.bin"); await lab.discard(NAME); await lab.discard("second.txt");
    await expect.poll(async () => (await lab.operate("localInfo")).entries).toBe(0);
    await expect.poll(() => lab.operate("handles")).toBe(0);
  } finally { await lab.finish(); }
});

test("disconnect, reconnect and lock clean owned copies and never replay an edit or approval", async ({ desktop }, info) => {
  test.setTimeout(240_000);
  const { page } = desktop; const lab = await setup(desktop, info);
  try {
    await lab.start(NAME); await lab.open(NAME);
    await row(page, NAME).getByRole("button", { name: "Check for changes", exact: true }).click();
    await expect(row(page, NAME)).toHaveAttribute("data-state", "changed");
    const old = (await snapshot(page))[0]!;
    await lab.operate("disconnect");
    await expect.poll(async () => (await lab.operate("localInfo")).copies).toBe(0);
    expect((await lab.operate("localInfo")).pending).toBe(0);
    await lab.operate("reconnect");
    await expect(pane(page, "remote").section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    expect((await lab.operate("status")).generation).toBe(old.generation + 1);
    const refused = await page.evaluate(async (old) => {
      const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("Bootstrap unavailable");
      return window.ssterm.uploadRemoteEdit({ owner: boot.value.owner, editId: old.id, revision: old.revision, approvalId: old.approvalId! });
    }, old);
    expect(refused.ok).toBe(false);
    expect((await lab.operate("remoteInfo", NAME)).hash).toBe(hash(original));
    expect(await lab.operate("launches")).toBe(1);
    await pane(page, "remote").goto(ROOT);
    await lab.start("second.txt"); await lab.open("second.txt");
    await lab.operate("lock");
    await expect.poll(async () => (await lab.operate("localInfo")).entries).toBe(0);
    await expect.poll(async () => (await lab.operate("localInfo")).pending).toBe(0);
    await expect.poll(() => lab.operate("handles")).toBe(0);
    expect((await lab.operate("remoteInfo", "second.txt")).hash).toBe(hash(original));
  } finally { await lab.finish(); }
});
