import type { Page } from "@playwright/test";
import { test, expect, launchDesktop, type Desktop } from "./fixtures";

const DEFAULTS = { terminalFontSize: 13, terminalScrollback: 10_000, terminalCursor: "block", terminalCursorBlink: false };

async function openSettings(page: Page) {
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  return {
    dialog,
    font: dialog.getByLabel("Font size"),
    scrollback: dialog.getByLabel("Scrollback"),
    cursor: (name: string) => dialog.getByRole("button", { name, exact: true }),
    blink: dialog.getByRole("switch", { name: "Blinking cursor" }),
  };
}
/** What main has stored, read through the bridge. */
const stored = (page: Page) => page.evaluate(async () => {
  const boot = await window.ssterm.bootstrap();
  if (!boot.ok) return boot.error.code;
  const result = await window.ssterm.settings({ owner: boot.value.owner });
  return result.ok ? result.value : result.error.code;
});

test("terminal settings persist across relaunch; invalid values show an inline error and are not saved", async ({ desktop }) => {
  let relaunched: Desktop | undefined;
  try {
    const s = await openSettings(desktop.page);
    // SST-040/07: one right-edge drawer (up to 640 px), Terminal first (AI Agent added by SST-041); terminal colors are read-only.
    await expect(s.dialog.getByRole("tab")).toHaveText(["Terminal", "Recording", "Security", "Sync", "AI Agent"]);
    await expect(s.dialog.getByRole("tab", { name: "Terminal" })).toHaveAttribute("aria-selected", "true");
    await expect(s.dialog.getByText("Terminal colors", { exact: true })).toBeVisible();
    await expect(s.dialog.getByText("Charcoal", { exact: true })).toBeVisible();
    await expect.poll(() => s.dialog.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { right: Math.round(innerWidth - box.right), width: box.width <= 640 };
    }), { message: "settles at the right edge" }).toEqual({ right: 0, width: true });
    await expect(s.font).toHaveValue("13");
    await expect(s.scrollback).toHaveValue("10000");
    await expect(s.cursor("Block")).toHaveAttribute("aria-pressed", "true");
    await expect(s.blink).not.toBeChecked();

    // Out of range, fractional and empty entries stay in the field with an error; nothing is saved.
    for (const value of ["9", "33", "12.5", ""]) {
      await s.font.fill(value);
      await s.font.press("Enter");
      await expect(s.dialog.getByText("Enter a whole number from 10 to 32.", { exact: true }), `font ${JSON.stringify(value)}`).toBeVisible();
      await expect(s.font).toHaveAttribute("aria-invalid", "true");
    }
    await s.scrollback.fill("99");
    await s.scrollback.blur();
    await expect(s.dialog.getByText("Enter a whole number from 100 to 100,000.", { exact: true })).toBeVisible();
    expect(await stored(desktop.page)).toEqual(DEFAULTS);

    // Valid values save at once and clear the errors.
    await s.font.fill("18");
    await s.font.press("Enter");
    await s.scrollback.fill("5000");
    await s.scrollback.press("Enter");
    await s.cursor("Bar").click();
    await s.blink.click();
    await expect(s.dialog.getByText(/^Enter a whole number/u)).toHaveCount(0);
    const saved = { terminalFontSize: 18, terminalScrollback: 5000, terminalCursor: "bar", terminalCursorBlink: true };
    await expect.poll(() => stored(desktop.page)).toEqual(saved);
    await desktop.page.keyboard.press("Escape");
    await expect(s.dialog).toHaveCount(0);

    // A new launch on the same profile shows the saved values.
    await desktop.close();
    relaunched = await launchDesktop(desktop.profile);
    const again = await openSettings(relaunched.page);
    await expect(again.font).toHaveValue("18");
    await expect(again.scrollback).toHaveValue("5000");
    await expect(again.cursor("Bar")).toHaveAttribute("aria-pressed", "true");
    await expect(again.blink).toBeChecked();
    expect(await stored(relaunched.page)).toEqual(saved);
    expect(relaunched.errors).toEqual([]);
  } finally {
    await relaunched?.close();
  }
  expect(desktop.errors).toEqual([]);
});

test("Settings › Recording opens the Recording tab; Manage recordings closes Settings on the Recordings page", async ({ desktop }) => {
  const { page } = desktop;
  await page.locator("#app-sidebar").getByRole("button", { name: "Recordings", exact: true }).click();
  await page.getByTestId("recordings-page").getByRole("button", { name: "Settings › Recording" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByRole("tab", { name: "Recording" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByTestId("recording-settings").getByRole("switch", { name: "Record session output" })).not.toBeChecked();
  await dialog.getByRole("button", { name: "Manage recordings and shell integration" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("recordings-page")).toBeVisible();
  expect(desktop.errors).toEqual([]);
});

test("Cmd+W with no sessions closes the window without asking", async ({ desktop }) => {
  const { app, page } = desktop;
  // Any close or quit sheet would be recorded and cancelled.
  await app.evaluate(({ dialog }) => {
    const shown = globalThis as { sheets?: number };
    shown.sheets = 0;
    dialog.showMessageBox = (async () => {
      shown.sheets! += 1;
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  // Enabled once the window has an owner, so the workspace (and its Cmd+W) is mounted.
  await expect(page.locator("#app-sidebar").getByRole("button", { name: "Settings", exact: true })).toBeEnabled();
  const closed = page.waitForEvent("close");
  // The page can close before the key-up is delivered.
  await page.keyboard.press("Meta+w").catch(() => undefined);
  await closed;
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
  expect(await app.evaluate(() => (globalThis as { sheets?: number }).sheets)).toBe(0);
  expect(desktop.errors).toEqual([]);
});

test.describe("with workspace storage unavailable", () => {
  test.use({ corruptStore: true });

  test("settings show the defaults with the controls disabled and the reason", async ({ desktop }) => {
    const s = await openSettings(desktop.page);
    await expect(s.dialog).toContainText("Settings can't be saved while workspace storage is unavailable. Defaults are in use.");
    for (const control of [s.font, s.scrollback, s.cursor("Block"), s.cursor("Bar"), s.blink]) await expect(control).toBeDisabled();
    await expect(s.font).toHaveValue("13");
    await expect(s.scrollback).toHaveValue("10000");
    expect(await stored(desktop.page)).toBe("unavailable");
  });
});
