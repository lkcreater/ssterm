import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { SHELL_INTEGRATION } from "../../packages/domain/src/recording";
import { test, expect, changeCatalog, emptyTestNamespace } from "./fixtures";
import { renderedContrast } from "./support/transfer-fixture";

// Sessions authenticate with a fixture password and terminals show arbitrary output: no traces, screenshots or video.
test.use({ trace: "off", screenshot: "off", video: "off" });

/** Every file's bytes under `directory` (recursively), for plaintext scans. */
async function blobs(directory: string): Promise<Buffer[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? blobs(join(directory, entry.name))
    : entry.isFile() ? readFile(join(directory, entry.name)).then((bytes) => [bytes]) : Promise.resolve([])));
  return nested.flat();
}
const found = async (directories: string[], needles: string[]) => {
  const all = (await Promise.all(directories.map(blobs))).flat();
  return needles.filter((needle) => all.some((bytes) => bytes.includes(needle)));
};
const recordingNames = async (root: string) => (await readdir(root).catch(() => [] as string[])).filter((name) => /^(out|cmd)-/u.test(name)).sort();
/** Appends the shipped snippet to a startup file inside the owned container only. */
function appendToContainer(container: string, file: string, text: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("docker", ["exec", "-i", container, "sh", "-c", `cat >> ${file}`], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", () => fail(new Error("docker exec failed")));
    child.once("exit", (code) => (code === 0 ? done() : fail(new Error("docker exec failed"))));
    child.stdin.end(`\n${text}\n`);
  });
}
/** The cursor row (xterm renders the cursor only while focused) — the shell's current command line. */
const cursorRow = (pane: Locator) => pane.locator(".xterm-rows > div:has(.xterm-cursor)");
async function typeAt(page: Page, pane: Locator, text: string) {
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.insertText(text);
}

test("recording over SSH bash 5.2 through production main: opt-in, encrypted, exported, suggested without Enter, locked, keyless and deleted", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const { app, page, profile } = desktop;
  const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
  const lab = await startFixture();
  const id = randomUUID().slice(0, 8);
  const OUT = `NEEDLE_OUT_${id}`;
  const PW = `NEEDLE_PW_${id}`;
  const command = `echo ${OUT}-$((40+2))`;
  const server = "บันทึก PROD lab";
  const root = join(profile, "recordings");
  try {
    // 1. Off by default: an empty private root and no badge.
    await expect.poll(() => readdir(root)).toEqual([".ssterm-recordings"]);
    await appendToContainer(lab.container, "/home/fixture/.bashrc", SHELL_INTEGRATION.bash);
    const secretFile = join(lab.directory, "recording-password");
    await writeFile(secretFile, lab.password, { mode: 0o600 });
    const fill = () => expect.poll(() => app.evaluate(async ({ BrowserWindow }, file) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(() => {
        const inputs = [...document.querySelectorAll('[data-testid="credential-prompt-dialog"] input')];
        if (inputs.length !== 1 || inputs[0].disabled) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], ${JSON.stringify(value)});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true; })()`);
    }, secretFile), { message: "the password prompt accepted the lab password" }).toBe(true);
    const [, hostId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "Lab password", username: lab.username, method: "password" } },
      { type: "create-host", data: { label: server, address: lab.host, environment: "PROD", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();
    // Receipts only (length and whether Enter is pressed), read before the shipped handler wipes the bytes.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get("ssterm:write-terminal")!;
      const receipts: { bytes: number; enter: boolean }[] = [];
      ipcMain.removeHandler("ssterm:write-terminal");
      ipcMain.handle("ssterm:write-terminal", (event, ...args) => {
        const bytes = (args[0] as { bytes?: unknown } | undefined)?.bytes;
        if (bytes instanceof Uint8Array) receipts.push({ bytes: bytes.byteLength, enter: bytes.includes(13) });
        return original(event, ...args);
      });
      (globalThis as any).__sstermWrites = receipts;
    });
    const writes = () => app.evaluate(() => [...(globalThis as any).__sstermWrites] as { bytes: number; enter: boolean }[]);

    // 2. Enable both switches in Settings.
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("tab", { name: "Recording" }).click();
    const section = settings.getByTestId("recording-settings");
    await section.getByRole("switch", { name: "Record session output" }).click();
    await expect(section.getByRole("switch", { name: "Record session output" })).toBeChecked();
    await section.getByRole("switch", { name: "Keep command history" }).click();
    await expect(section.getByRole("switch", { name: "Keep command history" })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    const owner = await page.evaluate(async () => { const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("bootstrap"); return boot.value.owner; });
    const connect = async (trust: boolean) => {
      const result = await page.evaluate(({ owner, hostId }) => window.ssterm.connectHost({ owner, hostId }), { owner, hostId: hostId! });
      expect(result.ok).toBe(true);
      if (trust) await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
      await expect(page.getByTestId("credential-prompt-dialog")).toBeVisible();
      await fill();
      await page.getByTestId("credential-prompt-dialog").getByRole("button", { name: "Continue", exact: true }).click();
    };
    const pane = page.locator(`section[aria-label="Terminal for ${server}"]`);
    const rows = pane.locator(".xterm-rows");
    const badge = pane.locator(".recording-badge");
    await connect(true);
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });
    await expect(badge).toHaveAttribute("data-recording", "on");
    await expect(badge).toHaveAccessibleName("Recording");
    await expect(pane.locator(".connection-status")).toContainText("Connected");
    // The "on" badge is primary-blue text: the ADR 0008 accepted exception, so its ratio is attached as evidence below.
    const contrast = await renderedContrast(badge.locator(".recording-badge-text"));
    await expect(badge.locator(".recording-badge-text"), "the exception covers primary-blue text only").toHaveCSS("color", "rgb(37, 99, 235)");
    expect(contrast.ratio, "Recording badge primary-blue ratio (ADR 0008)").toBeGreaterThanOrEqual(2.9);

    // 3. Output and a no-echo secret, then Disconnect.
    await typeAt(page, pane, command);
    await page.keyboard.press("Enter");
    await expect(rows).toContainText(`${OUT}-42`);
    await typeAt(page, pane, "read -rs -p 'secret? ' v; echo READ-$((1+1))");
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("secret?");
    await page.keyboard.insertText(PW);
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("READ-2");
    await expect(rows).not.toContainText(PW);
    await pane.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(pane).toHaveCount(0);
    await expect.poll(async () => (await recordingNames(root)).map((name) => name.replace(/-[0-9a-f-]{36}/u, "")),
      { message: "both files are sealed" }).toEqual(["cmd.ssr", "out.ssr"]);

    // 4. Nothing captured is plaintext at rest, in recordings or in the catalog.
    expect(await found([root, join(profile, "metadata")], [OUT, PW, `${OUT}-$((40+2))`])).toEqual([]);

    // 5. Export through main's save dialog (stubbed): output, never the typed secret.
    await page.getByRole("button", { name: "Recordings", exact: true }).click();
    const recordings = page.getByTestId("recordings-page");
    const row = recordings.locator("li[data-recording-id]");
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-state", "complete");
    await expect(row.getByText("PROD", { exact: true })).toBeVisible();
    const exported = join(profile, `export-${id}.log`);
    const history = join(profile, `history-${id}.txt`);
    const save = (path: string) => app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, path);
    await save(exported);
    await row.getByRole("button", { name: `Export the log of ${server}` }).click();
    await expect(recordings.getByText(/^Exported as plaintext/u)).toBeVisible();
    const log = await readFile(exported, "utf8");
    expect(log).toContain(`${OUT}-42`);
    expect(log).not.toContain(PW);
    await save(history);
    await recordings.getByRole("button", { name: "Export history…" }).click();
    await expect.poll(() => readFile(history, "utf8").catch(() => "")).toContain(`\t${server}\t${command}\n`);

    // 6. ⌘; in a new session suggests the command; ⌘D is inert while the list is open; Return inserts without Enter.
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await connect(false);
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });
    await typeAt(page, pane, "echo NEE");
    await expect(cursorRow(pane)).toContainText("echo NEE");
    const list = pane.getByRole("listbox", { name: `Command history for ${server}` });
    await page.keyboard.press("Meta+Semicolon");
    await expect(list.getByRole("option")).toHaveText([command]);
    await expect(list).toBeFocused();
    const panes = await page.locator("section[data-session-id]").count();
    await page.keyboard.press("Meta+d");
    await expect(list).toHaveCount(0);
    expect(await page.locator("section[data-session-id]").count(), "no split while the list was open").toBe(panes);
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Meta+Semicolon");
    await expect(list.getByRole("option")).toHaveText([command]);
    const before = (await writes()).length;
    await page.keyboard.press("Enter");
    await expect(list).toHaveCount(0);
    await expect(cursorRow(pane)).toContainText(command);
    const inserted = (await writes()).slice(before);
    expect(inserted.length, "one insertion write").toBe(1);
    expect(inserted[0]!.enter, "accepting a suggestion never presses Enter").toBe(false);
    await page.waitForTimeout(500);
    await expect(rows, "the inserted command did not run").not.toContainText(`${OUT}-42`);

    // 7. Tab still belongs to the shell.
    await page.keyboard.press("Control+u");
    await page.keyboard.insertText("ech");
    await page.keyboard.press("Tab");
    await expect(cursorRow(pane)).toContainText(/\$ echo\s*$/u);
    await page.keyboard.press("Control+u");

    // 8. A screen lock closes the list, seals the files and drops the decrypted history.
    await page.keyboard.insertText("echo N");
    await expect(cursorRow(pane)).toContainText("echo N");
    await page.keyboard.press("Meta+Semicolon");
    await expect(list).toBeVisible();
    // The lock epoch starts before the main-owned Save dialog, including a result returned after lock.
    const abortedExport = join(profile, `locked-export-${id}.log`);
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (() => new Promise((resolve) => {
        (globalThis as any).__sstermPendingSave = resolve;
      })) as typeof dialog.showSaveDialog;
    });
    await page.evaluate(async (owner) => {
      const state = await window.ssterm.recordingState({ owner });
      if (!state.ok) throw new Error("recording state");
      const log = state.value.logs.find((log) => log.state === "complete")!;
      (globalThis as any).__sstermPendingExport = window.ssterm.exportRecording({ owner, target: { kind: "log", id: log.id } });
    }, owner);
    await expect.poll(() => app.evaluate(() => typeof (globalThis as any).__sstermPendingSave)).toBe("function");
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await app.evaluate((_electron, path) => { (globalThis as any).__sstermPendingSave({ canceled: false, filePath: path }); }, abortedExport);
    const aborted = await page.evaluate(() => (globalThis as any).__sstermPendingExport);
    expect(aborted.ok ? aborted.value.status : aborted.error.code).toMatch(/^(aborted|unauthorized)$/u);
    expect((await readdir(profile)).some((name) => name === `locked-export-${id}.log` || name.startsWith(".ssterm-export-"))).toBe(false);
    await expect(pane).not.toHaveAttribute("data-phase", "ready", { timeout: 10_000 });
    await expect(list).toHaveCount(0);
    await expect.poll(async () => (await recordingNames(root)).every((name) => name.endsWith(".ssr")), { message: "no file is left open" }).toBe(true);
    const sealed = await recordingNames(root);

    // 10. With the vault key gone from the Keychain, a new session shows Not recording and writes nothing; and
    // (8, continued) the history cache is gone, so ⌘; needs a new key read, which now fails.
    expect(await emptyTestNamespace(app, desktop.secretNamespace)).toBe(0);
    await pane.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByTestId("credential-prompt-dialog")).toBeVisible();
    await fill();
    await page.getByTestId("credential-prompt-dialog").getByRole("button", { name: "Continue", exact: true }).click();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(badge).toHaveAttribute("data-recording", "stopped", { timeout: 10_000 });
    await expect(badge).toHaveAccessibleName("Not recording");
    await expect(pane.locator(".connection-status")).toContainText("Connected");
    await typeAt(page, pane, "echo N");
    await expect(cursorRow(pane)).toContainText("echo N");
    await page.keyboard.press("Meta+Semicolon");
    await expect(pane.getByTestId("terminal-feedback")).toContainText("secure storage is unavailable");
    await page.keyboard.press("Control+u");
    expect(await recordingNames(root), "a keyless session writes nothing").toEqual(sealed);

    // 9. Delete one log, history, then everything; suggestions are empty afterwards.
    await page.getByRole("button", { name: "Recordings", exact: true }).click();
    await expect(row).toHaveCount(2);
    // Each confirmation is an alert drawer step: Cancel first, Delete closes it.
    const confirm = page.getByTestId("delete-recordings-dialog");
    await row.first().getByRole("button", { name: `Delete the log of ${server}` }).click();
    await expect(confirm).toHaveAttribute("role", "alertdialog");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(row).toHaveCount(1);
    await recordings.getByRole("button", { name: "Delete history" }).click();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect.poll(async () => (await recordingNames(root)).filter((name) => name.startsWith("cmd-"))).toEqual([]);
    await recordings.getByRole("button", { name: "Delete all" }).click();
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect(await recordingNames(root)).toEqual([]);
    expect((await readdir(root)).sort()).toEqual([".ssterm-recordings", "policy.json"]);
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await typeAt(page, pane, "echo N");
    await expect(cursorRow(pane)).toContainText("echo N");
    await page.keyboard.press("Meta+Semicolon");
    await expect(pane.getByTestId("terminal-feedback")).toContainText("No saved commands start with what is typed.");

    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("recording-ssh-evidence", { body: JSON.stringify({ contrast: contrast.ratio, platform: process.platform }), contentType: "application/json" });
  } finally {
    await desktop.close();
    lab.privateKey.fill(0);
    await lab.dispose();
    await lab.assertCleaned();
  }
});

/** A recorder, Keychain-namespaced vault and startup-file zsh pane, all owned by the test, behind the shipped handlers. */
async function localZsh(app: ElectronApplication, owner: { windowId: number; generation: number }, logMiB = 1024) {
  await app.evaluate(async ({ app, BrowserWindow, ipcMain, powerMonitor }, parameters) => {
    await new Promise<void>((done) => setImmediate(done));
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const fs = require("node:fs");
    const production = { ...require(path.join(app.getAppPath(), "out/main/ssh.js")), ...require(path.join(app.getAppPath(), "out/main/secrets.js")) };
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const owned: any = { disposers: [], namespace: `dev.ssterm.test.${require("node:crypto").randomUUID()}` };
    owned.directory = fs.mkdtempSync(path.join(app.getPath("temp"), "ssterm-recording-local-"));
    const opened = await production.openMetadata({ path: path.join(owned.directory, "catalog.sqlite") });
    if (!opened.ok) throw new Error("catalog");
    owned.repository = opened.value;
    const provider = new production.KeychainSecretProvider(owned.namespace);
    owned.reads = 0;
    const read = provider.read.bind(provider);
    provider.read = (item: unknown) => { owned.reads += 1; return read(item); };
    owned.transient = new production.TransientSecrets();
    const service = new production.SecretService({ repository: owned.repository, provider, transient: owned.transient });
    owned.root = path.join(owned.directory, "recordings");
    owned.recorder = production.createRecorder({ files: production.createRecordingFiles({ root: owned.root }), keys: () => service.recording });
    await owned.recorder.ready;
    const configured = await owned.recorder.configure({ logs: true, history: true, logDays: 30, logMiB: parameters.logMiB, historyDays: 180, historyMiB: 8 });
    if (configured.status !== "saved") throw new Error(`configure ${configured.status}`);
    const boundary = new production.WindowBoundary(contents.getURL().split("#")[0],
      { name: "ssterm", version: app.getVersion(), platform: process.platform }, () => ({ status: "ready", schemaVersion: 4 }));
    boundary.register(contents, BrowserWindow.getAllWindows()[0]!.id, true, () => {});
    for (let generation = 1; generation < parameters.owner.generation; generation += 1) boundary.rotate(contents);
    const checked = boundary.bootstrap({ sender: contents, senderFrame: contents.mainFrame }, []);
    if (!checked.ok || JSON.stringify(checked.value.owner) !== JSON.stringify(parameters.owner)) throw new Error("owner mismatch");
    owned.fixture = await require(parameters.fixturePath).startLocalTerminalFixture(production, {
      owner: parameters.owner, power: powerMonitor, shell: "/bin/zsh", args: ["-i"], files: { ".zshrc": parameters.zshrc },
      observeTerminal: owned.recorder.observe, recording: owned.recorder,
      send(channel: string, frame: unknown) { if (!contents.isDestroyed()) contents.send(channel, frame); },
    });
    for (const channel of [...production.terminalChannels, ...production.recordingChannels]) ipcMain.removeHandler(channel);
    owned.disposers.push(production.registerTerminalHandlers({ ipc: ipcMain, boundary, controller: () => owned.fixture.controller }));
    owned.disposers.push(production.registerRecordingHandlers({ ipc: ipcMain, boundary, recorder: () => owned.recorder,
      registry: () => owned.fixture.registry, chooseDestination: async () => undefined }));
    // Receipts only: file names, raw bytes for the plaintext scan, Enter-pressing writes and Keychain reads.
    owned.names = () => fs.readdirSync(owned.root).filter((name: string) => /^(out|cmd)-/u.test(name));
    owned.raw = () => fs.readdirSync(owned.root).map((name: string) => fs.readFileSync(path.join(owned.root, name)).toString("latin1")).join("");
    owned.enterWrites = () => owned.fixture.registry.snapshot(production.sessionOwnerId(parameters.owner))
      .reduce((sum: number, session: { id: string; generation: number }) => sum + (owned.fixture.frames(session.id, session.generation).enterWrites ?? 0), 0);
    owned.keyReads = () => owned.reads;
    owned.cleanup = async () => {
      for (const dispose of owned.disposers.splice(0)) dispose();
      const receipt = await owned.fixture.cleanup();
      await owned.recorder.dispose();
      owned.transient.purgeAll();
      owned.repository.close();
      const leftovers = await production.clearTestNamespace(owned.namespace);
      fs.rmSync(owned.directory, { recursive: true, force: true });
      return { ...receipt, leftovers };
    };
    (globalThis as any).__sstermRecordingLocal = owned;
  }, { owner, logMiB, fixturePath: resolve("tests/fixtures/local-terminal/pty.cjs"), zshrc: `${SHELL_INTEGRATION.zsh}\n` });
  const call = <T>(method: string) => app.evaluate(async (_electron, method) => {
    await new Promise<void>((done) => setImmediate(done));
    return (globalThis as any).__sstermRecordingLocal[method]();
  }, method) as Promise<T>;
  return {
    names: () => call<string[]>("names"),
    raw: () => call<string>("raw"),
    enterWrites: () => call<number>("enterWrites"),
    reads: () => call<number>("keyReads"),
    cleanup: () => call<{ fixtureCleaned: boolean; remainingProcesses: number; leftovers: number }>("cleanup"),
  };
}

test("a capped local log stays incomplete and exportable while history keeps recording", async ({ desktop }) => {
  test.setTimeout(120_000);
  const { app, page } = desktop;
  const boot = await page.evaluate(() => window.ssterm.bootstrap());
  if (!boot.ok) throw new Error("bootstrap");
  const local = await localZsh(app, boot.value.owner, 16);
  try {
    // SST-040/09: New local terminal lives in the Terminals page header.
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await page.getByRole("button", { name: "New local terminal", exact: true }).first().click();
    const pane = page.locator("section[data-terminal-kind=local]");
    await expect(pane).toHaveAttribute("data-phase", "ready");
    await expect(pane.locator(".recording-badge")).toHaveAttribute("data-recording", "on");
    await expect(pane.locator(".xterm-rows")).toContainText("%");
    await typeAt(page, pane, "LC_ALL=C /usr/bin/yes CAPPED | /usr/bin/head -c 18000000; echo CAP-$((40+2))");
    await page.keyboard.press("Enter");
    await expect(pane.locator(".xterm-rows")).toContainText("CAP-42", { timeout: 60_000 });
    const badge = pane.locator(".recording-badge");
    await expect(badge).toHaveAttribute("data-recording", "partial");
    await expect(badge).toHaveAccessibleName("Recording · partial");
    expect((await renderedContrast(badge)).ratio).toBeGreaterThanOrEqual(4.5);
    await expect(pane).toHaveAttribute("data-phase", "ready");
    await typeAt(page, pane, "echo AFTER_CAP-$((2+3))");
    await page.keyboard.press("Enter");
    await expect(pane.locator(".xterm-rows")).toContainText("AFTER_CAP-5");
    await typeAt(page, pane, "echo AFTER");
    await page.keyboard.press("Meta+Semicolon");
    await expect(pane.getByRole("listbox").getByRole("option")).toHaveText(["echo AFTER_CAP-$((2+3))"]);
    await page.keyboard.press("Escape");
    const receipt = await app.evaluate(async () => {
      const owned = (globalThis as any).__sstermRecordingLocal;
      const log = owned.recorder.state().logs[0];
      const destination = `${owned.directory}/capped-export.txt`;
      const outcome = await owned.recorder.export({ kind: "log", id: log.id }, destination);
      const fs = process.getBuiltinModule("node:fs");
      return { state: log.state, bytes: log.bytes, outcome, marked: fs.readFileSync(destination, "utf8").endsWith("[ssterm: recording incomplete]\r\n") };
    });
    expect(receipt.state).toBe("incomplete");
    expect(receipt.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(receipt.outcome).toEqual({ status: "saved", incomplete: true, gaps: 0 });
    expect(receipt.marked).toBe(true);
    await page.getByRole("button", { name: "Recordings", exact: true }).first().click();
    await expect(page.getByTestId("recordings-page").getByText("Incomplete", { exact: true })).toBeVisible();
  } finally {
    const receipt = await local.cleanup();
    expect(receipt.fixtureCleaned).toBe(true);
    expect(receipt.remainingProcesses).toBe(0);
    expect(receipt.leftovers).toBe(0);
  }
});

test("recording on local zsh: the LOCAL pane records, suggests the command it just ran and forgets it", async ({ desktop }) => {
  test.setTimeout(120_000);
  const { app, page } = desktop;
  const boot = await page.evaluate(() => window.ssterm.bootstrap());
  if (!boot.ok) throw new Error("bootstrap");
  const local = await localZsh(app, boot.value.owner);
  let cleaned = false;
  try {
    const id = randomUUID().slice(0, 8);
    const command = `echo LOCAL_${id}-$((2+3))`;
    // SST-040/09: New local terminal lives in the Terminals page header.
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await page.getByRole("button", { name: "New local terminal", exact: true }).first().click();
    const pane = page.locator("section[data-terminal-kind=local]");
    const rows = pane.locator(".xterm-rows");
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(pane.getByText("LOCAL", { exact: true })).toBeVisible();
    await expect(pane.locator(".recording-badge")).toHaveAttribute("data-recording", "on");
    await expect(rows).toContainText("%", { timeout: 20_000 });
    await typeAt(page, pane, command);
    await page.keyboard.press("Enter");
    await expect(rows).toContainText(`LOCAL_${id}-5`);
    await expect.poll(async () => (await local.names()).some((name) => name.startsWith("cmd-")), { message: "the live history file is on disk" }).toBe(true);
    const enters = await local.enterWrites();
    await typeAt(page, pane, "echo LOC");
    await expect(cursorRow(pane)).toContainText("echo LOC");
    await page.keyboard.press("Meta+Semicolon");
    const list = pane.getByRole("listbox", { name: "Command history for This Mac" });
    await expect(list.getByRole("option")).toHaveText([command]);
    await page.keyboard.press("Enter");
    await expect(cursorRow(pane)).toContainText(command);
    expect(await local.enterWrites(), "accepting never presses Enter").toBe(enters);
    await page.keyboard.press("Control+u");
    await page.keyboard.insertText("echo LOC");
    await expect(cursorRow(pane)).toContainText("echo LOC");
    await page.keyboard.press("Meta+Semicolon");
    await expect(list.getByRole("option")).toHaveText([command]);
    const elsewhere = page.getByRole("button", { name: /^Terminals/u });
    await elsewhere.click();
    await expect(list, "clicking away closes the list").toHaveCount(0);
    await expect(elsewhere, "clicking away keeps focus where the user clicked, not in the shell").toBeFocused();
    await pane.locator(".xterm-screen").click();
    await page.keyboard.press("Meta+Semicolon");
    await expect(list.getByRole("option")).toHaveText([command]);
    await page.keyboard.press("Shift+Backspace");
    await expect(list).toHaveCount(0);
    await expect(pane.getByTestId("terminal-feedback")).toContainText("Removed from this target's command history.");
    await page.keyboard.press("Meta+Semicolon");
    await expect(pane.getByTestId("terminal-feedback")).toContainText("No saved commands start with what is typed.");
    await page.keyboard.press("Control+u");
    expect(await local.raw()).not.toContain(`LOCAL_${id}`);
    expect(await local.reads(), "Keychain reads stay batched").toBeLessThanOrEqual(6);
    expect(await local.cleanup()).toEqual({ fixtureCleaned: true, remainingProcesses: 0, leftovers: 0 });
    cleaned = true;
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
  } finally {
    if (!cleaned) await local.cleanup().catch(() => undefined);
  }
});
