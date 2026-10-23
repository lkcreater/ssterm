import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect, changeCatalog } from "./fixtures";
import { pane, snapshot, terminalState } from "./support/transfer-fixture";

// Sessions authenticate with the lab password typed from main; keep automatic artifacts off.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
const ROOT = "/home/fixture/picker";
const ALPHA = "ไฟล์ อัลฟา ผลิตจริง";
const BRAVO = "ไฟล์ บราโว";
const NONE = "ยังไม่มีตัวตน";

// SST-040/11: the Files header picker opens SFTP through the same path as Servers → Open files, including the
// confirmation before a switch would stop a pending transfer.
test("Files server picker: empty page, current is a no-op, switch without and with a live transfer, Servers Open files shares the confirmation", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const { app, page, profile } = desktop;
  const lab = await startFixture();
  const count = async (pattern: string) => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", pattern])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw error; }
  };
  const sftpProcesses = async () => (await count("sshd: fixture@notty")) + (await count("sshd: fixture@internal-sftp"));
  const credentials = page.getByTestId("credential-prompt-dialog");
  const password = async (label: string) => {
    await expect(credentials).toBeVisible({ timeout: 20_000 });
    await expect(credentials).toContainText(label);
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }, file) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
        const input = document.querySelector('[data-testid="credential-prompt-dialog"] input');
        if (!input || input.disabled) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    }, join(lab.directory, "password"))).toBe(true);
    await credentials.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(credentials).toHaveCount(0);
  };
  try {
    await runFile("docker", ["exec", "-u", "fixture", lab.container, "python3", "-c",
      `import os\nos.makedirs(${JSON.stringify(ROOT)})\nopen(${JSON.stringify(`${ROOT}/existing.txt`)},'wb').write(b'server')`]);
    await writeFile(join(lab.directory, "password"), lab.password, { mode: 0o600 });
    await changeCatalog(app, [
      { type: "create-identity", data: { label: "Picker lab", username: lab.username, method: "password" } },
      { type: "create-host", data: { label: ALPHA, address: lab.host, environment: "PROD", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
      { type: "create-host", data: { label: BRAVO, address: lab.host, port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
      { type: "create-host", data: { label: NONE, address: "none.example.test" } },
    ]);
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(ALPHA);
    const endpoint = `${lab.username}@${lab.host}:${lab.port}`;

    // An empty Files page: the header picker shows no server and no state.
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const header = page.locator(".files-header");
    const picker = header.getByRole("combobox", { name: "Server to browse" });
    const status = header.locator("[data-files-picker] .connection-status");
    await expect(picker).toContainText("Choose a server");
    await expect(status).toHaveCount(0);
    // Keyboard: the list opens from the trigger; a server without an identity is disabled with Connect's reason.
    await picker.focus();
    await page.keyboard.press("Enter");
    const options = page.locator('[data-slot="select-content"]').getByRole("option");
    const option = (label: string) => options.filter({ hasText: label });
    await expect(options).toHaveCount(3);
    await expect(option(NONE)).toHaveAttribute("aria-disabled", "true");
    await expect(option(NONE)).toContainText("Choose an identity to connect.");
    await expect(option(ALPHA)).toContainText("PROD");
    await expect(option(ALPHA)).toContainText(endpoint);
    await option(ALPHA).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    await password(ALPHA);
    const remote = pane(page, "remote");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(remote.section).toHaveAttribute("aria-label", `Remote files on ${ALPHA}`);
    await expect(picker).toContainText(ALPHA);
    await expect(status).toHaveAttribute("data-state", "connected");
    await expect(status).toHaveText("Connected");
    const first = (await remote.section.getAttribute("data-session-id"))!;
    expect(await sftpProcesses(), "one SFTP connection and subsystem").toBe(2);

    // Choosing the current server changes nothing.
    await picker.click();
    await option(ALPHA).click();
    await expect(options).toHaveCount(0);
    await expect(remote.section).toHaveAttribute("data-session-id", first);
    await expect(remote.section).toHaveAttribute("data-phase", "ready");
    await expect(credentials).toHaveCount(0);
    expect(await sftpProcesses()).toBe(2);

    // Without pending work, switching asks nothing: the old session closes and the new one opens (key remembered).
    const confirm = page.getByTestId("sftp-switch-dialog");
    await picker.click();
    await option(BRAVO).click();
    await password(BRAVO);
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("host-trust-dialog")).toHaveCount(0);
    await expect(remote.section).toHaveAttribute("aria-label", `Remote files on ${BRAVO}`);
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(picker).toContainText(BRAVO);
    const second = (await remote.section.getAttribute("data-session-id"))!;
    expect(second).not.toBe(first);
    await expect.poll(sftpProcesses, { message: "the previous SFTP session was reaped", timeout: 10_000 }).toBe(2);

    // A live transfer: an upload waiting on a conflict decision stays pending until someone answers it.
    const folder = join(profile, "picker-local");
    await mkdir(folder);
    await writeFile(join(folder, "existing.txt"), "local");
    const local = pane(page, "local");
    await local.goto(await realpath(folder));
    await remote.goto(ROOT);
    await local.select(["existing.txt"]);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    const job = page.getByTestId("transfer-panel").getByTestId("transfer-job");
    await expect(job).toHaveAttribute("data-state", "conflict", { timeout: 20_000 });

    // Switching asks first, Cancel focused; Cancel keeps the session and the transfer.
    await picker.click();
    await option(ALPHA).click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveAttribute("role", "alertdialog");
    await expect(confirm).toContainText(`Close ${BRAVO} and open ${ALPHA}?`);
    await expect(confirm).toContainText(endpoint);
    await expect(confirm).toContainText("1 pending transfer will be cancelled.");
    await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(confirm).toHaveCount(0);
    await expect(picker, "focus returns to the picker").toBeFocused();
    await expect(remote.section).toHaveAttribute("data-session-id", second);
    await expect(remote.section).toHaveAttribute("data-phase", "ready");
    await expect(job).toHaveAttribute("data-state", "conflict");
    await expect(credentials).toHaveCount(0);

    // Servers → Open files takes the same path: the same confirmation; Esc keeps everything.
    await page.getByRole("button", { name: /^Servers/u }).click();
    await page.getByTestId("hosts-page").getByRole("button", { name: `Actions for ${ALPHA}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Open files", exact: true }).click();
    // The drawer makes the page inert, so the Files page is checked by attribute rather than by role.
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId("files-workspace")).not.toHaveAttribute("data-hidden");
    await expect(confirm).toContainText("1 pending transfer will be cancelled.");
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(remote.section).toHaveAttribute("data-session-id", second);
    await expect(job).toHaveAttribute("data-state", "conflict");

    // 960×640: the header (picker, state, actions) and the drawer fit without horizontal overflow.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await header.evaluate((node) => node.scrollWidth <= node.clientWidth), "header fits at 960").toBe(true);
    await expect(picker).toBeInViewport();
    await expect(status).toBeInViewport();
    await testInfo.attach("files-picker-960x640", { body: await page.screenshot(), contentType: "image/png" });

    // Confirming closes the old session (its transfer stops) and opens the chosen server.
    await picker.click();
    await option(ALPHA).click();
    await expect(confirm).toBeVisible();
    await expect(options).toHaveCount(0);
    expect(await confirm.evaluate((node) => node.scrollWidth <= node.clientWidth), "drawer fits at 960").toBe(true);
    await testInfo.attach("files-picker-switch-confirm-960x640", { body: await page.screenshot(), contentType: "image/png" });
    await confirm.getByRole("button", { name: "Close and switch", exact: true }).click();
    await password(ALPHA);
    await expect(confirm).toHaveCount(0);
    await expect(remote.section).toHaveAttribute("aria-label", `Remote files on ${ALPHA}`);
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(picker).toContainText(ALPHA);
    await expect(status).toHaveText("Connected");
    await expect.poll(async () => (await snapshot(page)).every(terminalState), { message: "the old session's transfer stopped" }).toBe(true);
    await expect(job).not.toHaveAttribute("data-state", "conflict");
    await expect.poll(sftpProcesses, { message: "the previous SFTP session was reaped", timeout: 10_000 }).toBe(2);

    // A remote edit (downloaded working copy, no editor launched) also asks first; confirming discards it.
    const edits = () => page.evaluate(async () => {
      const boot = await window.ssterm.bootstrap();
      if (!boot.ok) throw new Error("Bootstrap unavailable");
      const result = await window.ssterm.remoteEditState({ owner: boot.value.owner });
      if (!result.ok) throw new Error("Remote edits unavailable");
      return result.value.edits.map(({ sessionId, state, localAvailable }) => ({ sessionId, state, localAvailable }));
    });
    const editOn = async () => {
      await remote.goto(ROOT);
      await remote.select(["existing.txt"]);
      await page.getByRole("button", { name: "Edit remote file", exact: true }).click();
      const sessionId = (await remote.section.getAttribute("data-session-id"))!;
      await expect.poll(async () => (await edits()).find((edit) => edit.sessionId === sessionId)?.state, { timeout: 20_000 }).toBe("ready");
      return sessionId;
    };
    // Room for the remote edit rows beside the panes.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1280);
    const alphaSession = await editOn();
    await picker.click();
    await option(BRAVO).click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("1 remote edit will be discarded.");
    await expect(confirm).not.toContainText("pending transfer");
    await confirm.getByRole("button", { name: "Close and switch", exact: true }).click();
    await password(BRAVO);
    await expect(remote.section).toHaveAttribute("aria-label", `Remote files on ${BRAVO}`);
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect.poll(async () => (await edits()).find((edit) => edit.sessionId === alphaSession)?.localAvailable, { message: "the edit's working copy was discarded", timeout: 10_000 }).toBe(false);

    // A lock while the drawer is open stops the work itself: the drawer closes without switching.
    const bravoSession = await editOn();
    await picker.click();
    await option(ALPHA).click();
    await expect(confirm).toBeVisible();
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(confirm).toHaveCount(0);
    await expect(remote.section).toHaveAttribute("data-session-id", bravoSession);
    await expect(remote.section).toHaveAttribute("data-phase", "closed", { timeout: 10_000 });
    await expect(credentials).toHaveCount(0);
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
  } finally {
    try {
      await desktop.close();
      await expect.poll(() => count("sshd: fixture@"), { message: "no SSH process survives app quit", timeout: 10_000 }).toBe(0);
    } finally {
      lab.privateKey.fill(0);
      await lab.dispose();
      await lab.assertCleaned();
    }
  }
});
