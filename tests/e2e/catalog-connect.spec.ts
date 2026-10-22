import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Locator } from "@playwright/test";
import { test, expect, changeCatalog } from "./fixtures";

// The session authenticates with the lab password; keep terminal and dialog content out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const group = "PROD lab ห้องทดลอง";
const server = "ระบบจริง กรุงเทพ";
const unconfigured = "ยังไม่มีตัวตน";
const identity = "Lab password";
const locked = "Closed because ssterm locked (screen lock or sleep)";

test("a server created in the UI connects through production main: trust, password prompt, lock and Connect to unlock", async ({ desktop }, testInfo) => {
  test.setTimeout(180_000);
  // The runner owns the lab so it can be inspected after the app's sessions end.
  const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
  const lab = await startFixture();
  const shells = async () => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", "sshd: fixture@"])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw new Error("Shell count unavailable"); }
  };
  try {
    const { app, page } = desktop;
    // Main reads the password from the lab's private directory, so the value never crosses Playwright.
    const secretFile = join(lab.directory, "ui-password");
    await writeFile(secretFile, lab.password, { mode: 0o600 });
    const fill = () => expect.poll(() => app.evaluate(async ({ BrowserWindow }, file) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
        const dialogs = [...document.querySelectorAll('[data-testid="credential-prompt-dialog"]')];
        if (dialogs.length !== 1) return false;
        const inputs = [...dialogs[0].querySelectorAll('input')];
        if (inputs.length !== 1 || inputs[0].disabled) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], ${JSON.stringify(value)});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true; })()`);
    }, secretFile), { message: "the password prompt accepted the lab password" }).toBe(true);

    // Identities are created in SST-017: seed one (password method, nothing saved) through a second connection.
    await changeCatalog(app, [{ type: "create-identity", data: { label: identity, username: lab.username, method: "password" } }]);
    await page.reload();
    const hosts = page.getByTestId("hosts-page");
    /** A Servers table row, by the server's name. */
    const row = (label: string) => hosts.getByRole("row").filter({ has: page.locator("button[data-host-id]", { hasText: label }) });
    await expect(hosts.getByText("No servers yet", { exact: true })).toBeVisible();
    const choose = async (dialog: Locator, label: string, option: string) => {
      await dialog.getByLabel(label, { exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };

    // Group with the lab's port; the server inherits it and selects the seeded identity.
    await hosts.getByRole("button", { name: "New group" }).click();
    const groupEditor = page.getByTestId("group-editor");
    await groupEditor.getByLabel("Name").fill(group);
    await groupEditor.getByRole("button", { name: "Custom", exact: true }).click();
    await groupEditor.getByLabel("Custom port").fill(String(lab.port));
    await groupEditor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(groupEditor).toHaveCount(0);
    const serverEditor = page.getByTestId("server-editor");
    const addServer = async (label: string, auth: string) => {
      await hosts.getByRole("button", { name: "Add server" }).click();
      await serverEditor.getByLabel("Name").fill(label);
      await serverEditor.getByLabel("Address").fill(lab.host);
      await choose(serverEditor, "Environment", "PROD");
      await choose(serverEditor, "Identity", auth);
      await serverEditor.getByRole("button", { name: "Save", exact: true }).click();
      await expect(serverEditor).toHaveCount(0);
      await expect(row(label)).toBeVisible();
    };

    // A server whose identity is cleared cannot connect, and says why.
    await addServer(unconfigured, "No identity");
    let connect = hosts.getByRole("button", { name: `Connect ${unconfigured}`, exact: true });
    await expect(connect).toHaveAttribute("aria-disabled", "true");
    await expect(connect).toHaveAccessibleDescription("Choose an identity to connect.");
    // aria-disabled keeps it focusable; activating it from the keyboard opens nothing.
    await connect.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Servers");
    await expect(page.getByRole("tablist", { name: "Terminal tabs" }), "no session was opened").toHaveCount(0);

    await addServer(server, `${identity} (${lab.username})`);
    // The row names the execution target, identity and PROD; the host drawer says where the port comes from.
    await expect(row(server).locator(".host-target")).toHaveText(`${lab.username}@${lab.host}:${lab.port}`);
    await expect(row(server)).toContainText(`${identity} (${lab.username})`);
    await expect(row(server).getByText("PROD", { exact: true })).toBeVisible();
    await expect(row(server).locator(".connection-status")).toHaveText("Disconnected");
    await row(server).locator("button[data-host-id]").click();
    await expect(serverEditor.getByText(`Uses ${lab.port}, from group ${group}.`)).toBeVisible();
    await expect(serverEditor.getByLabel("Saved connection")).toContainText(`${lab.username}@${lab.host}:${lab.port}`);
    await page.keyboard.press("Escape");
    await expect(serverEditor).toHaveCount(0);
    connect = hosts.getByRole("button", { name: `Connect ${server}`, exact: true });
    await expect(connect).not.toHaveAttribute("aria-disabled", "true");

    // Connect switches to the terminal view before the session is Ready.
    // By attribute: a modal trust or password dialog hides the pane from the accessibility tree.
    const pane = page.locator(`section[aria-label="Terminal for ${server}"]`);
    const trust = page.getByTestId("host-trust-dialog");
    const credentials = page.getByTestId("credential-prompt-dialog");
    const rows = pane.locator(".xterm-rows");
    await connect.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terminals");
    await expect(pane).toHaveAttribute("data-phase", "connecting");
    await expect(pane.locator(".pane-header").getByText("PROD", { exact: true })).toBeVisible();
    // Awaiting trust: the drawer is open and the tab and pane status bar show amber "Awaiting trust", never Connected.
    await expect(trust).toBeVisible();
    for (const status of [page.locator(".session-tab .connection-status"), pane.locator(".pane-statusbar .connection-status")]) {
      await expect(status).toHaveAttribute("data-state", "awaiting-trust");
      await expect(status).toHaveText("Awaiting trust");
    }
    await expect(page.locator('.connection-status[data-state="connected"]')).toHaveCount(0);
    await trust.getByRole("button", { name: "Remember", exact: true }).click();
    // Trusted: authentication continues, so the state goes back to Connecting while the password is asked.
    await expect(pane.locator(".pane-statusbar .connection-status")).toHaveAttribute("data-state", "connecting");
    await expect(credentials).toBeVisible();
    await expect(credentials).toContainText(server);
    // Closing the trust dialog must not pull focus out of the password prompt that replaces it.
    await expect(credentials.locator("input")).toBeFocused();
    await fill();
    await credentials.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });
    // Closing the prompt returns focus to this session's terminal, not to the removed Connect button.
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    // Computed remotely, so the echoed command line cannot satisfy the assertion.
    await page.keyboard.type('echo "UI-CONNECT-$((40+2))"');
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("UI-CONNECT-42");
    expect(await shells()).toBe(1);

    // Servers shows the live state per row and the workspace summary (ready terminals and SFTP sessions).
    await page.getByRole("button", { name: "Servers", exact: true }).click();
    await expect(row(server).locator(".connection-status")).toHaveAttribute("data-state", "connected");
    await expect(row(server).locator(".connection-status")).toHaveText("Connected");
    await expect(row(unconfigured).locator(".connection-status")).toHaveText("Disconnected");
    await expect(page.getByTestId("servers-summary")).toHaveText(/Local workspace\s*2 servers\s*1 connected/u);
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await expect(pane).toBeVisible();

    // Lock closes the session; Connect from the servers page is the explicit unlock.
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(pane.getByText(locked, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect.poll(shells, { message: "the lock reaped the shell", timeout: 10_000 }).toBe(0);
    await pane.getByRole("button", { name: "Close pane", exact: true }).click();
    await expect(pane).toHaveCount(0);
    await page.getByRole("button", { name: "Show servers" }).click();
    await connect.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terminals");
    // The key is remembered and the password was not saved: only the password is asked for again.
    await expect(credentials).toBeVisible();
    await expect(trust).toHaveCount(0);
    await fill();
    await credentials.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    expect(await shells()).toBe(1);

    // Disconnect clears the session: the pane goes and the shell is reaped.
    await pane.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(pane).toHaveCount(0);
    await expect.poll(shells, { message: "Disconnect reaped the shell", timeout: 10_000 }).toBe(0);
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("catalog-connect-evidence", {
      body: JSON.stringify({ port: lab.port, shellsAfter: await shells(), platform: process.platform }),
      contentType: "application/json",
    });
  } finally {
    // Close the app before the lab so no session outlives its server.
    await desktop.close();
    lab.privateKey.fill(0);
    await lab.dispose();
    await lab.assertCleaned();
  }
});
