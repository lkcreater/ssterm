import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, launchDesktop, type Desktop } from "./fixtures";
import { renderedContrast } from "./support/transfer-fixture";
import { expectDrawerPlaced } from "./support/drawer";

// Fixture bodies are project-owned strings; keep editor contents out of traces.
test.use({ trace: "off" });

const BODY = "#!/bin/sh\nset -eu\nexport ข้อความ='สวัสดี ชาวโลก 🚀'\n\tprintf '%s\\n' \"$ข้อความ\" | tee /tmp/ssterm-fixture-out\n\n# trailing blank line kept\n\n";
const EDITED = `${BODY}echo "แก้ไขแล้ว ✓"`;
const NEEDLES = ["สวัสดี ชาวโลก", "ssterm-fixture-out", "แก้ไขแล้ว", "trailing blank line kept"];

function ui(page: Page) {
  const root = page.getByTestId("snippets-page");
  // The editor opens in a right drawer (portal), outside the page.
  const drawer = page.getByTestId("snippet-drawer");
  const editor = drawer.getByTestId("snippet-editor");
  return {
    root,
    drawer,
    editor,
    nav: page.getByRole("button", { name: "Snippets", exact: true }),
    // CSS, not roles: while the modal drawer is open the page behind it is inert and out of the accessibility tree.
    rows: root.locator('ul[aria-label="Snippets"] button[data-snippet-id]'),
    row: (label: string) => root.locator('ul[aria-label="Snippets"] button[data-snippet-id]').filter({ hasText: label }),
    name: editor.getByLabel("Name", { exact: true }),
    body: editor.getByLabel("Script", { exact: true }),
    search: root.getByRole("searchbox", { name: "Search snippets" }),
  };
}
/** The metadata database and its WAL hold only ciphertext for bodies. */
async function plaintextInStorage(profile: string): Promise<string[]> {
  const directory = join(profile, "metadata");
  const found: string[] = [];
  for (const file of await readdir(directory)) {
    const bytes = await readFile(join(directory, file));
    for (const needle of NEEDLES) if (bytes.includes(Buffer.from(needle))) found.push(`${file}: ${needle}`);
  }
  return found;
}
async function openSessions(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const boot = await window.ssterm.bootstrap();
    if (!boot.ok) return -1;
    const state = await window.ssterm.terminalState({ owner: boot.value.owner });
    return state.ok ? state.value.sessions.length : -1;
  });
}

test("snippets: create with feedback, tags and search; encrypted at rest; exact multiline Unicode after relaunch; delete", async ({ desktop }) => {
  test.setTimeout(120_000);
  const { page } = desktop;
  const s = ui(page);
  await s.nav.click();
  await expect(s.root.getByRole("heading", { name: "Snippets" })).toBeVisible();
  await expect(s.root.getByText("No snippets yet")).toBeVisible();
  await s.root.getByRole("button", { name: "New snippet" }).click();
  await expect(s.name).toBeFocused();

  // Invalid input: an empty name is refused in place and nothing is created.
  await s.body.fill("echo nope");
  await s.drawer.getByRole("button", { name: "Save snippet" }).click();
  await expect(s.editor.getByText("Enter a name.")).toBeVisible();
  await expect(s.name).toBeFocused();
  await expect(s.name).toHaveAttribute("aria-invalid", "true");

  await s.name.fill("Deploy ไทย");
  await s.body.fill(BODY);
  await s.editor.getByRole("textbox", { name: "New tag" }).fill("ops-ฐาน");
  await s.editor.getByRole("textbox", { name: "New tag" }).press("Enter");
  await expect(s.editor.getByRole("button", { name: "ops-ฐาน", pressed: true })).toBeVisible();
  await s.drawer.getByRole("button", { name: "Save snippet" }).click();
  await expect(s.editor.getByTestId("snippet-status")).toHaveText("Snippet saved");
  await expect(s.rows).toHaveCount(1);
  // The drawer stays open for further edits; Close returns to the list.
  await s.drawer.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(s.drawer).toHaveCount(0);
  await expect(s.row("Deploy ไทย")).toContainText("ops-ฐาน");
  expect(await openSessions(page), "saving never opens or runs anything").toBe(0);

  // An empty body is a valid encrypted snippet.
  await s.root.getByRole("button", { name: "New snippet" }).click();
  await s.name.fill("Empty");
  await s.drawer.getByRole("button", { name: "Save snippet" }).click();
  await expect(s.editor.getByTestId("snippet-status")).toHaveText("Snippet saved");
  await expect(s.rows).toHaveCount(2);
  await s.drawer.press("Escape");
  await expect(s.drawer).toHaveCount(0);

  // The renderer projection carries labels and tag ids only.
  const projected = await page.evaluate(async () => {
    const boot = await window.ssterm.bootstrap();
    if (!boot.ok) return "";
    const state = await window.ssterm.catalogState({ owner: boot.value.owner });
    return state.ok ? JSON.stringify(state.value) : "";
  });
  expect(projected).toContain("Deploy ไทย");
  for (const needle of [...NEEDLES, "bodyEnvelope", "keyRef"]) expect(projected).not.toContain(needle);

  // Search uses names and tags, never bodies.
  await s.search.fill("ฐาน");
  await expect(s.rows).toHaveCount(1);
  await s.search.fill("printf");
  await expect(s.root.getByText("No snippets match")).toBeVisible();
  await s.root.getByRole("button", { name: "Clear search" }).click();
  await expect(s.rows).toHaveCount(2);

  // Edit; leaving with unsaved changes asks first, as a step inside the same drawer.
  await s.row("Deploy ไทย").click();
  await expect(s.body).toHaveValue(BODY);
  await expectDrawerPlaced(page, "snippet-editor", { selector: "[data-testid='snippet-drawer']" });
  await expect(s.name).toBeFocused();
  await s.body.fill(EDITED);
  await s.body.press("Escape");
  const keep = s.drawer.getByRole("button", { name: "Keep editing" });
  await expect(keep).toBeFocused();
  await keep.click();
  await expect(s.body).toHaveValue(EDITED);
  await expect(s.body).toBeFocused();
  await s.body.press("Meta+s");
  await expect(s.editor.getByTestId("snippet-status")).toHaveText("Snippet saved");
  expect(await openSessions(page)).toBe(0);
  await s.drawer.press("Escape");
  await expect(s.drawer).toHaveCount(0);
  await expect(s.row("Deploy ไทย")).toBeFocused();

  expect(await plaintextInStorage(desktop.profile)).toEqual([]);
  expect(desktop.errors).toEqual([]);

  // Relaunch on the same profile and Keychain namespace: bodies decrypt byte-for-byte.
  await desktop.close({ keepSecrets: true });
  let again: Desktop | undefined;
  try {
    again = await launchDesktop(desktop.profile, { secretNamespace: desktop.secretNamespace });
    const r = ui(again.page);
    await r.nav.click();
    await expect(r.rows).toHaveCount(2);
    await r.row("Deploy ไทย").click();
    await expect(r.body).toHaveValue(EDITED);
    await expect(r.editor.getByRole("button", { name: "ops-ฐาน", pressed: true })).toBeVisible();
    await r.drawer.press("Escape");
    await expect(r.drawer).toHaveCount(0);
    await r.row("Empty").click();
    await expect(r.body).toHaveValue("");
    await r.drawer.press("Escape");
    await expect(r.drawer).toHaveCount(0);
    expect(await plaintextInStorage(again.profile)).toEqual([]);

    // Delete asks with Cancel focused, then removes the snippet; the other remains.
    await r.row("Deploy ไทย").click();
    await expect(r.body).toHaveValue(EDITED);
    await r.drawer.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(r.drawer.getByTestId("delete-snippet-confirm")).toBeVisible();
    await expect(r.drawer.getByRole("heading", { name: "Delete Deploy ไทย?" })).toBeVisible();
    await expect(r.drawer.getByRole("button", { name: "Cancel" })).toBeFocused();
    // Esc leaves the step without deleting; the editor is still there.
    await again.page.keyboard.press("Escape");
    await expect(r.body).toHaveValue(EDITED);
    await r.drawer.getByRole("button", { name: "Delete", exact: true }).click();
    await r.drawer.getByRole("button", { name: "Delete snippet" }).click();
    await expect(r.drawer).toHaveCount(0);
    await expect(r.rows).toHaveCount(1);
    await expect(r.row("Empty")).toBeVisible();
    await expect(r.row("Empty")).toBeFocused();
    expect(again.errors).toEqual([]);
  } finally {
    // The kept namespace is emptied by whichever launch reaches main; a failed relaunch gets one cleanup launch.
    if (again) await again.close();
    else await launchDesktop(desktop.profile, { secretNamespace: desktop.secretNamespace }).then((cleanup) => cleanup.close());
  }
});

test("snippets: a workspace lock closes the open editor and drops unsaved changes; reopening shows the saved body", async ({ desktop }) => {
  const { app, page } = desktop;
  const s = ui(page);
  await s.nav.click();
  await s.root.getByRole("button", { name: "New snippet" }).click();
  await s.name.fill("Lock test");
  await s.body.fill(BODY);
  await s.drawer.getByRole("button", { name: "Save snippet" }).click();
  await expect(s.editor.getByTestId("snippet-status")).toHaveText("Snippet saved");
  await s.body.fill(`${BODY}unsaved draft line`);
  await expect(s.editor.getByTestId("snippet-status")).toHaveText("Unsaved changes");

  // 960×640: no horizontal overflow; long lines scroll inside the body; text meets 4.5:1.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(960);
  await s.body.fill(`${BODY}${"x".repeat(400)}\nunsaved draft line`);
  const overflow = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="snippets-page"]')!;
    const body = document.querySelector<HTMLTextAreaElement>("#snippet-body")!;
    return { page: root.scrollWidth - root.clientWidth, bodyScrolls: body.scrollWidth > body.clientWidth };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.bodyScrolls).toBe(true);
  for (const [label, locator] of [
    ["body text", s.body],
    ["status", s.editor.getByTestId("snippet-status")],
    ["notice", s.root.getByText("Snippet bodies are encrypted on this Mac.")],
    ["row", s.row("Lock test")],
  ] as const) expect((await renderedContrast(locator)).ratio, label).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: test.info().outputPath("snippets-960x640.png") });

  await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
  const locked = s.drawer.getByTestId("snippet-locked");
  await expect(locked).toBeVisible();
  await expect(s.editor).toHaveCount(0);
  await expect(page.locator("textarea#snippet-body")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.innerText.includes("unsaved draft line"))).toBe(false);

  // Switching snippets after a lock never asks to discard: the draft is already gone.
  await locked.getByRole("button", { name: "Open again" }).click();
  await expect(s.body).toHaveValue(BODY);
  await expect(s.drawer.getByText("Discard unsaved changes?")).toHaveCount(0);
  expect(desktop.errors).toEqual([]);
});

test("snippets: an undecryptable snippet reports why and can still be deleted from its drawer (no key needed)", async ({ desktop }) => {
  const { app, page } = desktop;
  const s = ui(page);
  await page.evaluate(async () => {
    const boot = await window.ssterm.bootstrap();
    if (!boot.ok) throw new Error("bootstrap");
    for (const label of ["Broken", "Kept"])
      await window.ssterm.saveSnippet({ owner: boot.value.owner, snippetId: null, expectedRevision: null, label, body: "echo hi", tagIds: [] });
  });
  // main answers the shipped open-snippet channel with an integrity failure, as for tampered ciphertext.
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    (globalThis as any).__sstermOpenSnippet = handlers?.get("ssterm:open-snippet");
    ipcMain.removeHandler("ssterm:open-snippet");
    ipcMain.handle("ssterm:open-snippet", async () => ({ ok: true, value: { status: "corrupt" } }));
  });
  try {
    await s.nav.click();
    await expect(s.rows).toHaveCount(2);
    await s.row("Broken").click();
    await expect(s.drawer.getByText("This snippet cannot be decrypted")).toBeVisible();
    await expect(s.body).toHaveCount(0);
    await expect(s.drawer.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await s.drawer.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(s.drawer.getByRole("button", { name: "Cancel" })).toBeFocused();
    await s.drawer.getByRole("button", { name: "Delete snippet" }).click();
    await expect(s.drawer).toHaveCount(0);
    await expect(s.rows).toHaveCount(1);
    await expect(s.row("Kept")).toBeFocused();
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const original = (globalThis as any).__sstermOpenSnippet;
      if (!original) return;
      ipcMain.removeHandler("ssterm:open-snippet");
      ipcMain.handle("ssterm:open-snippet", original);
    });
  }
  expect(desktop.errors).toEqual([]);
});
