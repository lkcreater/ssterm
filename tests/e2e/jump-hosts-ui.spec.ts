import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect, changeCatalog } from "./fixtures";
import { renderedContrast } from "./support/transfer-fixture";

// Passwords are typed from main out of each lab's private directory; keep automatic artifacts off.
test.use({ trace: "off", screenshot: "off", video: "off" });
const { startJumpLab, stopJumpLab } = createRequire(import.meta.url)("../fixtures/jump/ssh.cjs");

/** Puts a lab password into the one credential field from main, so the value never crosses Playwright. */
async function typeSecret(app: ElectronApplication, file: string) {
  await expect.poll(() => app.evaluate(async ({ BrowserWindow }, path) => {
    const value = process.getBuiltinModule("node:fs").readFileSync(path, "utf8");
    return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(() => {
      const inputs = [...document.querySelectorAll('[data-testid="credential-prompt-dialog"] input')];
      if (inputs.length !== 1 || inputs[0].disabled) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], ${JSON.stringify(value)});
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      return true; })()`);
  }, file)).toBe(true);
}
async function choose(page: Page, scope: ReturnType<Page["getByTestId"]>, label: string, option: string) {
  await scope.getByLabel(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("F-jump: a server saved with a jump host connects through it; each prompt names its own server; loops and in-use deletes are refused", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 640));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
  const lab = await startJumpLab();
  try {
    const { bastion, target } = lab.labs;
    const bastionSecret = join(bastion.directory, "password");
    const targetSecret = join(target.directory, "password");
    await writeFile(bastionSecret, bastion.password, { mode: 0o600 });
    await writeFile(targetSecret, target.password, { mode: 0o600 });
    // Identities without saved passwords, so each hop asks for its own.
    await changeCatalog(app, [
      { type: "create-identity", data: { label: "Bastion login", username: bastion.username, method: "password" } },
      { type: "create-identity", data: { label: "Target login", username: target.username, method: "password" } },
      { type: "create-host", data: { label: "Bastion", address: bastion.host, port: { mode: "value", port: bastion.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();

    // New server through the editor: Connect via a jump host.
    await page.getByRole("button", { name: "Add server or group" }).click();
    await page.getByRole("menuitem", { name: "New server" }).click();
    const editor = page.getByTestId("server-editor");
    await editor.getByLabel("Name", { exact: true }).fill("ฐานข้อมูล Target");
    await editor.getByLabel("Address", { exact: true }).fill("target");
    await choose(page, editor, "Environment", "PROD");
    await choose(page, editor, "Connect via", "A jump host (another saved server)");
    await expect(editor).toContainText("Its address is resolved by the jump host.");
    await editor.getByRole("button", { name: /^Save/u }).click();
    await expect(editor).toContainText("Choose the server to connect through.");
    const routeError = editor.getByText("Choose the server to connect through.", { exact: true });
    expect((await renderedContrast(routeError)).ratio).toBeGreaterThanOrEqual(4.5);
    await expect(editor.getByLabel("Jump host", { exact: true })).toBeFocused();
    expect(await editor.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("jump-editor-960x640.png") });
    await choose(page, editor, "Jump host", "Bastion");
    await choose(page, editor, "Identity", `Target login (${target.username})`);
    await editor.getByRole("button", { name: /^Save/u }).click();
    await expect(editor).toHaveCount(0);

    const detail = page.getByTestId("host-detail");
    await page.getByTestId("hosts-page").locator("button[data-host-id]", { hasText: "ฐานข้อมูล Target" }).click();
    await expect(detail.getByTestId("host-route")).toHaveText("Bastion → this server");

    // Connect: the bastion's key and password come first, each labelled as the bastion on the way to the target.
    await detail.getByRole("button", { name: "Connect", exact: true }).click();
    const trust = page.getByTestId("host-trust-dialog");
    await expect(trust).toContainText("Bastion");
    await expect(trust.getByTestId("trust-jump-for")).toHaveText("Jump host on the way to ฐานข้อมูล Target. This key belongs to the jump host.");
    await expect(trust).toContainText(`127.0.0.1:${bastion.port}`);
    await expect(trust).not.toContainText("PROD");
    expect((await renderedContrast(trust.getByTestId("trust-jump-for"))).ratio).toBeGreaterThanOrEqual(4.5);
    // The credential inputs have not been opened yet; this screenshot contains no fixture password.
    await page.screenshot({ path: testInfo.outputPath("jump-trust-960x640.png") });
    await trust.getByRole("button", { name: "Remember", exact: true }).click();
    const prompt = page.getByTestId("credential-prompt-dialog");
    await expect(prompt.getByTestId("credential-jump-for")).toBeVisible();
    await expect(prompt).toContainText(`${bastion.username}@127.0.0.1:${bastion.port}`);
    await typeSecret(app, bastionSecret);
    await prompt.getByRole("button", { name: "Continue" }).click();
    // Then the target's own key (PROD, its network name) and its own password.
    await expect(trust.getByTestId("trust-jump-for")).toHaveCount(0);
    await expect(trust).toContainText("ฐานข้อมูล Target");
    await expect(trust).toContainText("PROD");
    await expect(trust).toContainText("target:22");
    await trust.getByRole("button", { name: "Remember", exact: true }).click();
    await expect(prompt.getByTestId("credential-jump-for")).toHaveCount(0);
    await expect(prompt).toContainText(`${target.username}@target:22`);
    await typeSecret(app, targetSecret);
    await prompt.getByRole("button", { name: "Continue" }).click();
    const pane = page.locator("section[data-session-id]").first();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(pane.locator(".xterm-rows")).toContainText("fixture@");
    const body = await page.locator("body").innerText();
    expect(body).not.toContain(bastion.password);
    expect(body).not.toContain(target.password);

    // A loop is refused in the editor, and the jump host cannot be deleted while the target uses it.
    await page.getByRole("button", { name: /^All servers/u }).click();
    await page.getByTestId("hosts-page").locator("button[data-host-id]", { hasText: "Bastion" }).click();
    await detail.getByRole("button", { name: "Edit", exact: false }).first().click();
    const bastionEditor = page.getByTestId("server-editor");
    await choose(page, bastionEditor, "Connect via", "A jump host (another saved server)");
    await choose(page, bastionEditor, "Jump host", "ฐานข้อมูล Target · PROD");
    await bastionEditor.getByRole("button", { name: /^Save/u }).click();
    await expect(bastionEditor).toContainText("A host cannot be reached through itself.");
    await bastionEditor.getByRole("button", { name: "Cancel" }).click();
    await bastionEditor.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(bastionEditor).toHaveCount(0);
    await detail.getByRole("button", { name: "Delete", exact: false }).first().click();
    const remove = page.getByTestId("delete-host-drawer");
    // The preview already reports why; nothing can be confirmed.
    await expect(remove).toContainText("Another server connects through this one.");
    await remove.getByRole("button", { name: "Cancel" }).click();
    expect(desktop.errors).toEqual([]);
  } finally {
    await desktop.close();
    await stopJumpLab(lab);
  }
});
