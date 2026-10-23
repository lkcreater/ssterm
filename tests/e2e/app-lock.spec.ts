import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop, type Desktop } from "./fixtures";
import { pane } from "./support/transfer-fixture";
import { audit } from "./support/audit";
import { expectDrawerPlaced } from "./support/drawer";

// Passwords and recovery codes are owned fixture values; keep traces off anyway.
test.use({ trace: "off", screenshot: "off", video: "off" });

const LOCK = { SSTERM_TEST_APP_LOCK: "on" };
const PASSWORD = "เปิด ssterm ด้วยรหัสยาว 2026";
const NEXT_PASSWORD = "a different long passphrase";

const screen = (page: Page) => page.getByTestId("app-lock");
async function gated(page: Page) {
  return page.evaluate(async () => {
    const boot = await window.ssterm.bootstrap();
    if (!boot.ok) return "bootstrap";
    const catalog = await window.ssterm.catalogState({ owner: boot.value.owner });
    const sync = await window.ssterm.syncState({ owner: boot.value.owner });
    const team = await window.ssterm.teamState({ owner: boot.value.owner });
    const mutation = await window.ssterm.teamCommand({ owner: boot.value.owner, action: { type: "fetch" } });
    if (!catalog.ok && catalog.error.code === "unauthorized" && (team.ok || team.error.code !== "unauthorized" || mutation.ok || mutation.error.code !== "unauthorized")) return "team-gate-bypassed";
    if (!catalog.ok && catalog.error.code === "unauthorized" && (sync.ok || sync.error.code !== "unauthorized")) return "sync-gate-bypassed";
    return catalog.ok ? "open" : catalog.error.code;
  });
}
async function saveRecoveryCode(page: Page): Promise<string> {
  const view = page.getByTestId("recovery-code");
  await expect(view).toBeVisible();
  // Shown only once: no × that could drop it (the native close still works).
  await expect(screen(page).getByRole("button", { name: "Close window" })).toHaveCount(0);
  const code = (await view.getByLabel("Recovery code", { exact: true }).textContent())!.trim();
  await expect(view.getByRole("button", { name: "Continue" })).toBeDisabled();
  await view.getByRole("checkbox", { name: "I saved the recovery code" }).click();
  await view.getByRole("button", { name: "Continue" }).click();
  return code;
}

/** Closes the window with the gate's ×, then reopens one (Dock click); its page and console errors are collected. */
async function closeAndReopen(desktop: Desktop, page: Page) {
  const closed = page.waitForEvent("close");
  await screen(page).getByRole("button", { name: "Close window" }).click();
  await closed;
  expect(await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  const reopened = desktop.app.waitForEvent("window");
  await desktop.app.evaluate(({ app }) => { app.emit("activate"); });
  const next = await reopened;
  const errors: string[] = [];
  next.on("pageerror", (error) => errors.push(error.message));
  next.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return { next, errors };
}

/**
 * SST-040/14: the gate is the whole window — no workspace landmark or catalog data — with the form panel flush right
 * below the titlebar, at 960×640 and 1280×800 under reduced motion, passing the release-gate audit (contrast, names, overflow).
 */
async function gateOnly(desktop: Desktop, page: Page, hidden: string[] = []) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(screen(page)).toBeVisible();
  await expect(page.locator(".app-workspace, [data-testid='hosts-page']")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Servers" })).toHaveCount(0);
  for (const text of hidden) await expect(page.locator("body")).not.toContainText(text);
  for (const [width, height] of [[960, 640], [1280, 800]] as const) {
    await desktop.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size[0], size[1]), [width, height] as const);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
    const size = `${width}×${height}`;
    const titlebar = (await page.locator(".app-lock-titlebar").boundingBox())!;
    const panel = (await page.locator(".app-lock-panel").boundingBox())!;
    expect(Math.abs(panel.x + panel.width - width), `${size}: panel flush right`).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.y - (titlebar.y + titlebar.height)), `${size}: panel below the titlebar`).toBeLessThanOrEqual(1);
    expect(Math.abs(panel.y + panel.height - height), `${size}: panel full height`).toBeLessThanOrEqual(1);
    expect(panel.x, `${size}: brand side on the left`).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${size}: no horizontal scroll`).toBeLessThanOrEqual(0);
    expect((await audit(page)).findings, `${size}: audit`).toEqual([]);
  }
}

test("password lock: zod-validated first setup, recovery code, locked relaunch with backoff, Settings and recovery", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-lock-"));
  const namespace = `dev.ssterm.test.${crypto.randomUUID()}`;
  let desktop: Desktop | undefined;
  try {
    // 1. First launch: set up a password.
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: LOCK });
    let page = desktop.page;
    await expect(screen(page).getByRole("heading", { name: "Set up sign-in" })).toBeVisible();
    expect(await gated(page), "feature IPC is closed before setup").toBe("unauthorized");
    // Focus enters at the first field; Tab walks the form in order.
    await expect(page.getByLabel("User name", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Confirm password")).toBeFocused();
    await gateOnly(desktop, page);
    await page.getByLabel("User name", { exact: true }).fill("al");
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByLabel("Confirm password").fill("other");
    await page.getByRole("button", { name: "Create password" }).click();
    await expect(page.getByText("Use at least 3 characters.")).toBeVisible();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    await expect(page.getByText("The passwords do not match.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("setup-errors.png") });
    await page.getByLabel("User name", { exact: true }).fill("alice");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create password" }).click();
    const firstCode = await saveRecoveryCode(page);
    expect(firstCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){5}$/u);
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(await gated(page)).toBe("open");
    await desktop.close({ keepSecrets: true });

    // 2. Relaunch: locked until the right password; wrong attempts back off.
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: LOCK });
    page = desktop.page;
    await expect(screen(page).getByRole("heading", { name: "Unlock ssterm" })).toBeVisible();
    expect(await gated(page)).toBe("unauthorized");
    await expect(page.getByLabel("User name", { exact: true })).toHaveValue("alice");
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    await gateOnly(desktop, page);
    await page.getByLabel("Password", { exact: true }).fill("wrong password");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("The user name or password is incorrect.")).toBeVisible();
    await expect(page.getByText(/Try again in \d+ s\./u)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("unlock-wrong.png") });
    await expect(page.getByText(/Try again in \d+ s\./u)).toHaveCount(0, { timeout: 5_000 });
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    // Enter submits.
    await page.getByLabel("Password", { exact: true }).press("Enter");
    await expect(page.getByTestId("hosts-page")).toBeVisible();

    // Settings: confirm, then issue a new recovery code (the old one stops working).
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Security" }).click();
    const settings = page.getByTestId("sign-in-settings");
    await expect(settings).toContainText("Password · alice");
    await settings.getByLabel("Current password").fill(PASSWORD);
    await settings.getByRole("button", { name: "Confirm" }).click();
    await settings.getByRole("button", { name: "New recovery code" }).click();
    const secondCode = (await settings.getByLabel("Recovery code", { exact: true }).textContent())!.trim();
    expect(secondCode).not.toBe(firstCode);
    await settings.getByRole("checkbox", { name: "I saved the recovery code" }).click();
    await settings.getByRole("button", { name: "Continue" }).click();
    expect(desktop.errors).toEqual([]);
    await desktop.close({ keepSecrets: true });

    // 3. Forgot the password: the replaced code fails, the current code allows a new setup.
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: LOCK });
    page = desktop.page;
    await page.getByRole("button", { name: "Forgot? Use a recovery code" }).click();
    await expect(page.getByLabel("Recovery code")).toBeFocused();
    // Back returns focus to the password field, not the page body.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Forgot? Use a recovery code" }).click();
    await expect(page.getByLabel("Recovery code")).toBeFocused();
    await page.getByLabel("Recovery code").fill(firstCode);
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(page.getByText("That recovery code is not correct.")).toBeVisible();
    await expect(page.getByText(/Try again in \d+ s\./u)).toHaveCount(0, { timeout: 5_000 });
    await page.getByLabel("Recovery code").fill(secondCode.toLowerCase());
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(screen(page).getByRole("heading", { name: "Set up sign-in again" })).toBeVisible();
    expect(await gated(page), "a recovery code alone does not open the app").toBe("unauthorized");
    await expect(page.getByLabel("User name", { exact: true })).toBeFocused();
    await page.getByLabel("User name", { exact: true }).fill("alice");
    await page.getByLabel("Password", { exact: true }).fill(NEXT_PASSWORD);
    await page.getByLabel("Confirm password").fill(NEXT_PASSWORD);
    await page.getByRole("button", { name: "Create password" }).click();
    expect(await saveRecoveryCode(page)).not.toBe(secondCode);
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(desktop.errors).toEqual([]);
  } finally {
    await desktop?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("Lock workspace: nothing live → every window shows the gate, feature IPC unauthorized, unlock restores the workspace; hidden when the lock is off", async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-relock-"));
  const plain = await mkdtemp(join(tmpdir(), "ssterm-e2e-relock-off-"));
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { env: LOCK });
    const page = desktop.page;
    await page.getByLabel("User name", { exact: true }).fill("alice");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create password" }).click();
    await saveRecoveryCode(page);
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(await gated(page)).toBe("open");
    // Catalog data that must not render behind the gate.
    const hidden = "ฐานข้อมูล หลังล็อก";
    await changeCatalog(desktop.app, [{ type: "create-host", data: { label: hidden, address: "192.0.2.10" } }]);
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(hidden);

    const lockWorkspace = page.getByRole("button", { name: "Lock workspace" });
    await expect(lockWorkspace).toBeVisible();
    await lockWorkspace.click();
    // Main reloads every window into the gate; this app opens one window, so check each one it has.
    const windows = desktop.app.windows();
    expect(await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windows.length);
    for (const window of windows) {
      await expect(screen(window).getByRole("heading", { name: "Unlock ssterm" })).toBeVisible();
      expect(await gated(window), "feature IPC is refused after Lock workspace").toBe("unauthorized");
    }
    await expect(page.getByTestId("hosts-page")).toHaveCount(0);
    // Served behind the gate and idempotent: a repeat answers locked and leaves the gate in place.
    expect(await page.evaluate(async () => {
      const boot = await window.ssterm.bootstrap();
      return boot.ok ? window.ssterm.lockNow({ owner: boot.value.owner }) : boot;
    })).toEqual({ ok: true, value: { status: "locked" } });
    await expect(page.getByLabel("User name", { exact: true })).toHaveValue("alice");
    await gateOnly(desktop, page, [hidden]);
    expect(desktop.errors).toEqual([]);

    // The gate's × closes the window (main's close path); a new window still shows the gate, never the workspace.
    const { next, errors } = await closeAndReopen(desktop, page);
    await expect(screen(next).getByRole("heading", { name: "Unlock ssterm" })).toBeVisible();
    await expect(next.getByTestId("hosts-page")).toHaveCount(0);
    await expect(next.locator("body")).not.toContainText(hidden);
    expect(await gated(next)).toBe("unauthorized");

    await next.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await next.getByRole("button", { name: "Unlock" }).click();
    await expect(next.getByTestId("hosts-page")).toBeVisible();
    expect(await gated(next)).toBe("open");
    await expect(next.getByRole("button", { name: "Lock workspace" })).toBeVisible();
    await expect(next.getByTestId("hosts-page")).toContainText(hidden);
    expect(errors).toEqual([]);
    await desktop.close();

    // App lock off (test profile default): no action, and main refuses the command.
    desktop = await launchDesktop(plain);
    await expect(desktop.page.getByTestId("hosts-page")).toBeVisible();
    await expect(desktop.page.getByRole("button", { name: "Settings", exact: true }).first()).toBeVisible();
    await expect(desktop.page.getByRole("button", { name: "Lock workspace" })).toHaveCount(0);
    expect(await desktop.page.evaluate(async () => {
      const boot = await window.ssterm.bootstrap();
      return boot.ok ? window.ssterm.lockNow({ owner: boot.value.owner }) : boot;
    })).toEqual({ ok: true, value: { status: "not-allowed" } });
    expect(await gated(desktop.page)).toBe("open");
    expect(desktop.errors).toEqual([]);
  } finally {
    await desktop?.close();
    await rm(profile, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

const runFile = promisify(execFile);
const { startFixture, portIsOpen } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}
const liveWork = (page: Page) => page.evaluate(async () => {
  const boot = await window.ssterm.bootstrap();
  if (!boot.ok) return "bootstrap";
  const work = await window.ssterm.liveWork({ owner: boot.value.owner });
  return work.ok ? { terminals: work.value.terminals.map((t) => (t.local ? "local" : t.target?.label)), tunnels: work.value.tunnels.length,
    transfers: work.value.transfers, remoteEdits: work.value.remoteEdits } : work.error.code;
});

// SST-040/13: with live work, Lock workspace asks first in a drawer that lists it; Cancel and Esc keep it running.
test("Lock workspace with live work: SSH and local terminals, a tunnel and a transfer are listed, kept on Cancel/Esc, closed on Lock and close 4", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-relock-live-"));
  // Local terminals start in this owned home (an empty .zshrc), never the developer's shell startup files.
  const home = join(profile, "home");
  await mkdir(home);
  await writeFile(join(home, ".zshrc"), "PS1='lock-e2e%# '\n");
  const lab = await startFixture();
  const server = "เซิร์ฟเวอร์ ล็อก";
  const count = async (pattern: string) => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", pattern])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw error; }
  };
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { env: { ...LOCK, SSTERM_TEST_LOCAL_HOME: home } });
    const { app, page } = desktop;
    await page.getByLabel("User name", { exact: true }).fill("alice");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create password" }).click();
    await saveRecoveryCode(page);
    await expect(page.getByTestId("hosts-page")).toBeVisible();

    // One PROD server with a saved password (read from a file in main, never over the test wire) and one tunnel rule.
    const remoteRoot = "/home/fixture/lock";
    await runFile("docker", ["exec", "-u", "fixture", lab.container, "python3", "-c",
      `import os\nos.makedirs(${JSON.stringify(remoteRoot)})\nopen(${JSON.stringify(`${remoteRoot}/existing.txt`)},'wb').write(b'server')`]);
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    const port = await freePort();
    const [identityId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "Lock lab", username: lab.username, method: "password" } },
      { type: "create-host", data: { label: server, address: lab.host, environment: "PROD", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
      { type: "create-tunnel-rule", data: { label: "เว็บ lock", hostId: "$1", bindPort: port, destinationHost: "127.0.0.1", destinationPort: 8080 } },
    ]);
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(server);
    expect(await app.evaluate(async ({ BrowserWindow }, { file, identityId }) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(async () => {
        const boot = await window.ssterm.bootstrap();
        const saved = await window.ssterm.setIdentityPassword({ owner: boot.value.owner, identityId: ${JSON.stringify(identityId)},
          expectedRevision: 1, value: new TextEncoder().encode(${JSON.stringify(value)}) });
        return saved.ok ? saved.value.status : saved.error.code; })()`);
    }, { file: secret, identityId })).toBe("saved");

    // Nothing live yet: the summary is empty (that path locks at once; covered by the nothing-live test).
    expect(await liveWork(page)).toEqual({ terminals: [], tunnels: 0, transfers: 0, remoteEdits: 0 });

    // 1. SSH terminal (trust once; the saved password connects).
    const hosts = page.getByTestId("hosts-page");
    await hosts.getByRole("button", { name: `Connect ${server}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const ssh = page.locator("section[data-terminal-kind=ssh]");
    await expect(ssh).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    // 2. Local terminal in the owned home.
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await page.getByRole("button", { name: "New local terminal", exact: true }).first().click();
    const local = page.locator("section[data-terminal-kind=local]");
    await expect(local).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(local.locator(".xterm-rows")).toContainText("lock-e2e%", { timeout: 20_000 });
    // 3. Tunnel.
    await page.getByRole("button", { name: "Port forwarding", exact: false }).click();
    const rule = page.getByTestId("tunnels-page").locator("tr[data-rule-id]").filter({ hasText: "เว็บ lock" });
    await rule.getByRole("button", { name: "Start เว็บ lock" }).click();
    await expect(rule.locator(".tunnel-status")).toContainText("Running", { timeout: 30_000 });
    expect(await portIsOpen(port)).toBe(true);
    // 4. A transfer that stays pending: an upload waiting on a conflict decision.
    await page.getByRole("button", { name: /^Servers/u }).click();
    await hosts.getByRole("button", { name: `Actions for ${server}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Open files", exact: true }).click();
    const remote = pane(page, "remote");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    const folder = join(profile, "lock-local");
    await mkdir(folder);
    await writeFile(join(folder, "existing.txt"), "local");
    await pane(page, "local").goto(await realpath(folder));
    await remote.goto(remoteRoot);
    await pane(page, "local").select(["existing.txt"]);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    const job = page.getByTestId("transfer-panel").getByTestId("transfer-job");
    await expect(job).toHaveAttribute("data-state", "conflict", { timeout: 20_000 });
    expect(await liveWork(page)).toEqual({ terminals: [server, "local"], tunnels: 1, transfers: 1, remoteEdits: 0 });
    // The local terminal's guardian (a child of main) and its zsh, checked again after the lock.
    const children = async (parent: number, pattern?: string) => {
      try { return (await runFile("pgrep", ["-P", String(parent), ...(pattern ? ["-f", pattern] : [])])).stdout.trim().split("\n").map(Number); }
      catch (error) { if ((error as { code?: number }).code === 1) return []; throw error; }
    };
    const guardians = await children(await app.evaluate(() => process.pid), "ssterm-local-guardian");
    expect(guardians, "one local terminal").toHaveLength(1);
    const shells = await children(guardians[0]!);
    expect(shells.length, "its interactive zsh").toBeGreaterThan(0);
    const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

    const lockWorkspace = page.getByRole("button", { name: "Lock workspace" });
    const drawer = page.getByTestId("lock-workspace-drawer");
    const alive = async () => {
      await expect(drawer).toHaveCount(0);
      await expect(screen(page)).toHaveCount(0);
      await expect(ssh).toHaveAttribute("data-phase", "ready");
      await expect(local).toHaveAttribute("data-phase", "ready");
      await expect(job).toHaveAttribute("data-state", "conflict");
      expect(await portIsOpen(port), "the tunnel still listens").toBe(true);
      expect(await liveWork(page)).toEqual({ terminals: [server, "local"], tunnels: 1, transfers: 1, remoteEdits: 0 });
      expect(await gated(page)).toBe("open");
    };
    const ask = async () => {
      await lockWorkspace.click();
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute("role", "alertdialog");
      await expect(drawer.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    };

    // The drawer lists what will close, with the target and PROD label; Esc keeps everything.
    await ask();
    await expect(drawer).toContainText("Lock workspace?");
    const terminalsList = drawer.getByTestId("lock-workspace-terminals");
    await expect(terminalsList.getByRole("listitem")).toHaveCount(2);
    await expect(terminalsList).toContainText(server);
    await expect(terminalsList).toContainText(`${lab.username}@${lab.host}:${lab.port}`);
    await expect(terminalsList).toContainText("PROD");
    await expect(terminalsList).toContainText("This Mac");
    await expect(terminalsList).toContainText("LOCAL");
    await expect(drawer.getByTestId("lock-workspace-tunnels")).toContainText("เว็บ lock");
    await expect(drawer.getByTestId("lock-workspace-tunnels")).toContainText(`127.0.0.1:${port}`);
    await expect(drawer).toContainText("1 pending transfer will be cancelled.");
    const confirm = drawer.getByRole("button", { name: "Lock and close 4", exact: true });
    await expect(confirm).toBeVisible();
    // Explicit evidence: the drawer shows targets and counts only (the saved password never reaches the UI).
    await expect.poll(() => drawer.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
    await expectDrawerPlaced(page, "lock-workspace");
    await page.screenshot({ path: testInfo.outputPath("lock-workspace-drawer.png") });
    await page.keyboard.press("Escape");
    await alive();
    // Cancel keeps everything too.
    await ask();
    await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
    await alive();

    // Lock and close 4: everything closes and the gate returns.
    await ask();
    await confirm.click();
    await expect(screen(page).getByRole("heading", { name: "Unlock ssterm" })).toBeVisible();
    await expect(page.locator("body"), "no catalog data behind the gate").not.toContainText(server);
    await expect(page.getByRole("navigation")).toHaveCount(0);
    expect(await gated(page)).toBe("unauthorized");
    expect(await liveWork(page), "not answered behind the gate").toBe("unauthorized");
    await expect.poll(() => portIsOpen(port), { message: "the tunnel listener closed", timeout: 15_000 }).toBe(false);
    await expect.poll(() => count("sshd: fixture@"), { message: "terminal, tunnel and SFTP connections closed", timeout: 20_000 }).toBe(0);
    await expect.poll(() => [...guardians, ...shells].filter(running), { message: "the local zsh and its guardian ended", timeout: 20_000 }).toEqual([]);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(await liveWork(page), "nothing survived the lock").toEqual({ terminals: [], tunnels: 0, transfers: 0, remoteEdits: 0 });
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await expect(page.locator("section[data-terminal-kind]")).toHaveCount(0);

    // If main cannot say what is live, Lock workspace still asks rather than locking silently.
    await app.evaluate(({ ipcMain }) => ipcMain.removeHandler("ssterm:app-lock-live-work"));
    await ask();
    await expect(drawer).toContainText("couldn't check for live work");
    await expect(drawer.getByRole("button", { name: "Lock and close all", exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(drawer).toHaveCount(0);
    expect(await gated(page)).toBe("open");
    // An OS screen lock while the drawer is open closes it (that lock already closed any live work) and shows no gate.
    await ask();
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(drawer).toHaveCount(0);
    await expect(screen(page)).toHaveCount(0);
    expect(await gated(page)).toBe("open");
    expect(desktop.errors).toEqual([]);
  } finally {
    await desktop?.close();
    await lab.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});

/** A local stand-in for Google: authorization redirect, PKCE-checked token endpoint and RS256 JWKS. */
async function fakeGoogle() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256", use: "sig" };
  const clientId = "e2e.apps.googleusercontent.com";
  const state = { mode: "ok" as "ok" | "other-account" | "offline", sub: "google-sub-1", pending: new Map<string, { challenge: string; nonce: string }>() };
  let base = "";
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    if (state.mode === "offline" && url.pathname !== "/auth") return void request.socket.destroy();
    if (url.pathname === "/auth") {
      const code = crypto.randomUUID();
      state.pending.set(code, { challenge: url.searchParams.get("code_challenge")!, nonce: url.searchParams.get("nonce")! });
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.search = new URLSearchParams({ code, state: url.searchParams.get("state")! }).toString();
      return void response.writeHead(302, { location: redirect.toString() }).end();
    }
    if (url.pathname === "/certs") return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        const pending = state.pending.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!pending || createHash("sha256").update(verifier).digest("base64url") !== pending.challenge || form.get("client_id") !== clientId)
          return void response.writeHead(400).end("{}");
        state.pending.delete(form.get("code")!);
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: base, aud: clientId, sub: state.mode === "other-account" ? "someone-else" : state.sub, email: "owner@example.com",
          email_verified: true, nonce: pending.nonce, iat: now, exp: now + 300 };
        const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "e2e" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
        const signature = sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), privateKey).toString("base64url");
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: `${head}.${payload}.${signature}` }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = {
    ...LOCK,
    SSTERM_TEST_GOOGLE: JSON.stringify({ clientId, clientSecret: "e2e-secret", authorization: `${base}/auth`, token: `${base}/token`, jwks: `${base}/certs`, issuer: base }),
  };
  return { env, state, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}
/** Stands in for the system browser: main's openExternal follows the authorization redirect to the loopback callback. */
async function browserFollowsRedirect(desktop: Desktop) {
  await desktop.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(new URL(url).origin);
      const response = await fetch(url, { redirect: "manual" });
      const location = response.headers.get("location");
      if (location) await fetch(location);
    };
  });
}

test("Google lock: system-browser sign-in through 127.0.0.1:55411, bound account only, offline grace", async () => {
  test.setTimeout(120_000);
  const google = await fakeGoogle();
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-google-"));
  const namespace = `dev.ssterm.test.${crypto.randomUUID()}`;
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: google.env });
    // SST-040/14: × while Google waits ends that sign-in; finishing it in the browser afterwards configures nothing.
    await desktop.app.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => { (globalThis as { __pending?: string }).__pending = url; };
    });
    await desktop.page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(screen(desktop.page).getByText("Waiting for Google in your browser…")).toBeVisible();
    const { next, errors } = await closeAndReopen(desktop, desktop.page);
    const late = await desktop.app.evaluate(async () => {
      const response = await fetch((globalThis as { __pending?: string }).__pending!, { redirect: "manual" });
      return fetch(response.headers.get("location")!).then(() => "answered", () => "closed");
    });
    expect(late, "the loopback listener closed with the window").toBe("closed");
    await expect(screen(next).getByRole("heading", { name: "Set up sign-in" })).toBeVisible();
    expect(await gated(next)).toBe("unauthorized");
    await browserFollowsRedirect(desktop);
    let page = next;
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await saveRecoveryCode(page);
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(errors).toEqual([]);
    await desktop.close({ keepSecrets: true });

    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: google.env });
    await browserFollowsRedirect(desktop);
    page = desktop.page;
    await expect(screen(page)).toContainText("owner@example.com");
    expect(await gated(page)).toBe("unauthorized");
    google.state.mode = "other-account";
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByText("That Google account is not the one this Mac was set up with.")).toBeVisible();
    expect(await gated(page)).toBe("unauthorized");
    google.state.mode = "ok";
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(await desktop.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toHaveLength(2);
    await desktop.close({ keepSecrets: true });

    // Offline: Google cannot be reached, and the last sign-in is recent, so ssterm may open.
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: google.env });
    await browserFollowsRedirect(desktop);
    page = desktop.page;
    google.state.mode = "offline";
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByText("Google cannot be reached right now.")).toBeVisible();
    await page.getByRole("button", { name: "Continue offline (recent Google sign-in)" }).click();
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(desktop.errors).toEqual([]);
  } finally {
    await desktop?.close();
    await google.close();
    await rm(profile, { recursive: true, force: true });
  }
});
