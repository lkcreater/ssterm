import { resolve } from "node:path";
import type { Locator } from "@playwright/test";
import { test, expect, showPane } from "./fixtures";
import { renderedContrast } from "./support/transfer-fixture";

// Real Docker OpenSSH sessions with a Keychain-held fixture password; keep terminal content out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

const label = "ระบบผลิต สนิปเพ็ต";
const secondLabel = "เครื่องพัฒนา สนิปเพ็ต";

test("snippet Paste sends nothing until Run or Insert; Run goes to the target the drawer captured; PROD asks first", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  const bootstrap = await page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("bootstrap failed");
  const owner = bootstrap.value.owner;
  // The shipped terminal handlers over the owned fixture registry; catalog and snippets stay production main.
  await app.evaluate(async ({ app, BrowserWindow, ipcMain }, parameters) => {
    await new Promise<void>((done) => setImmediate(done));
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const production = { ...require(path.join(app.getAppPath(), "out/main/ssh.js")), ...require(path.join(app.getAppPath(), "out/main/secrets.js")) };
    const window = BrowserWindow.getAllWindows()[0];
    const boundary = new production.WindowBoundary(window.webContents.getURL().split("#")[0],
      { name: "ssterm", version: app.getVersion(), platform: process.platform }, () => ({ status: "ready", schemaVersion: 1 }));
    boundary.register(window.webContents, window.id, true, () => {});
    for (let generation = 1; generation < parameters.owner.generation; generation += 1) boundary.rotate(window.webContents);
    const checked = boundary.bootstrap({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, []);
    if (!checked.ok || JSON.stringify(checked.value.owner) !== JSON.stringify(parameters.owner)) throw new Error("owner mismatch");
    const { startTerminalFixture } = require(parameters.fixturePath);
    const fixture = await startTerminalFixture(production, {
      owner: parameters.owner, label: parameters.label, secondLabel: parameters.secondLabel, tempDirectory: app.getPath("temp"),
      send: (channel: string, value: unknown) => { if (!window.webContents.isDestroyed()) window.webContents.send(channel, value); },
    });
    for (const channel of production.terminalChannels) ipcMain.removeHandler(channel);
    const dispose = production.registerTerminalHandlers({ ipc: ipcMain, boundary, controller: () => fixture.controller });
    // A gate in front of the shipped openSnippet handler holds the decrypt while the test switches panes.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
    const original = handlers?.get(parameters.openSnippet);
    const gate = { held: false, release: () => {}, gated: !!original };
    if (original) {
      ipcMain.removeHandler(parameters.openSnippet);
      ipcMain.handle(parameters.openSnippet, async (...args: unknown[]) => {
        if (gate.held) await new Promise<void>((done) => { gate.release = done; });
        return original(...args);
      });
    }
    (globalThis as any).__sstermSnippetRun = { fixture, gate, dispose: () => {
      dispose();
      if (original) { ipcMain.removeHandler(parameters.openSnippet); ipcMain.handle(parameters.openSnippet, original); }
    } };
  }, { owner, label, secondLabel, fixturePath: resolve("tests/fixtures/terminal/ssh.cjs"), openSnippet: "ssterm:open-snippet" });

  const fixture = <T>(method: string): Promise<T> => app.evaluate(async (_electron, method) => {
    await new Promise<void>((done) => setImmediate(done));
    return (globalThis as any).__sstermSnippetRun.fixture[method]();
  }, method);
  const writes = () => fixture<{ current: number; second: number }>("writes");
  const hold = (held: boolean) => app.evaluate((_electron, held) => {
    const gate = (globalThis as any).__sstermSnippetRun.gate;
    gate.held = held;
    if (!held) gate.release();
    return gate.gated as boolean;
  }, held);
  const save = (label: string, body: string) => page.evaluate(async ({ owner, label, body }) => {
    const result = await window.ssterm.saveSnippet({ owner, snippetId: null, expectedRevision: null, label, body, tagIds: [] });
    if (!result.ok || result.value.status !== "saved") throw new Error(`save failed: ${JSON.stringify(result)}`);
    return result.value.snippetId;
  }, { owner, label, body });

  const paneA = page.locator(`section[aria-label="Terminal for ${label}"]`);
  const paneB = page.locator(`section[aria-label="Terminal for ${secondLabel}"]`);
  const screen = (pane: Locator) => pane.locator(".xterm-rows");
  const textarea = (pane: Locator) => pane.locator(".xterm-helper-textarea");
  const panel = page.getByTestId("snippet-panel");
  const composer = panel.getByTestId("snippet-composer");
  const feedback = panel.getByTestId("snippet-feedback");
  const row = (name: string) => panel.locator("li[data-snippet-id]").filter({ hasText: name });
  // The cursor row renders while the pane is focused; it ends in the prompt once readline reads again.
  const idle = async (pane: Locator) => {
    await textarea(pane).focus();
    await expect(pane.locator(".xterm-rows > div:has(.xterm-cursor)")).toHaveText(/\$\s*$/);
  };
  const ready = async (pane: Locator) => {
    await expect(pane).toHaveAttribute("data-phase", "ready");
    await expect(screen(pane)).toContainText("fixture@");
  };
  const settle = () => page.waitForTimeout(400);
  const target = panel.getByTestId("snippet-target");
  // The drawer is modal: closing it returns focus to the active pane; reopening captures the active pane again.
  const closePanel = async () => {
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  };
  const openPanel = async (pane: Locator) => {
    await textarea(pane).focus();
    await page.keyboard.press("Meta+Shift+KeyS");
    await expect(panel).toBeVisible();
  };
  // A switch made behind the modal drawer (as a programmatic tab change would), not through its scrim.
  // CSS, not roles: the modal drawer hides the page from the accessibility tree.
  const switchBehind = (name: string) => page.locator('[role="tablist"][aria-label="Terminal tabs"] [role="tab"]')
    .filter({ has: page.locator(".session-tab-label").getByText(name, { exact: true }) })
    .evaluate((element: HTMLElement) => element.click());
  let cleaned = false;
  try {
    await save("Answer", 'echo "SNIP-$((6*7))"');
    await save("หลายบรรทัด", 'echo "M1-$((1+1))"\necho "ไทย-$((2+2))"\n');
    await save("Captured", 'echo "CAP-$((5*5))"');
    await save("Empty", "");

    await fixture("connect");
    await ready(paneA);
    await idle(paneA);
    await expect(paneA.locator(".pane-header").getByText("PROD", { exact: true })).toBeVisible();

    // Open from the keyboard while the PROD pane is focused: a right-edge drawer whose header names the captured target.
    await openPanel(paneA);
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel.getByRole("searchbox", { name: "Search snippets to send" })).toBeFocused();
    await expect(target).toContainText(label);
    await expect(target).toContainText("PROD");
    await expect.poll(() => panel.evaluate((element) => Math.abs(innerWidth - element.getBoundingClientRect().right)),
      { message: "the drawer comes to rest at the right edge" }).toBeLessThanOrEqual(0.5);

    // 1. Paste fills the composer and sends nothing, even after editing.
    const before = await writes();
    await row("Answer").getByRole("button", { name: "Paste Answer to composer" }).click();
    await expect(composer).toBeVisible();
    await expect(composer.getByRole("textbox", { name: "Pending input text" })).toHaveValue('echo "SNIP-$((6*7))"');
    await expect(composer).toContainText(label);
    await composer.getByRole("textbox", { name: "Pending input text" }).fill('echo "SNIP-$((6*7))-EDITED"');
    await settle();
    expect((await writes()).current, "Paste and editing send no bytes").toBe(before.current);
    await expect(screen(paneA)).not.toContainText("SNIP-42");

    // 2. Run on PROD asks first, as a step inside the same drawer, with Cancel focused; Cancel and Esc send nothing;
    //    Run sends text plus one Enter.
    await composer.getByRole("button", { name: "Run" }).click();
    const confirm = panel.getByTestId("snippet-confirm");
    await expect(confirm).toContainText("PROD");
    await expect(confirm).toContainText(label);
    await expect(page.getByRole("dialog"), "the confirmation is not a stacked overlay").toHaveCount(1);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Cancel" })).toBeFocused();
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(composer.getByRole("textbox", { name: "Pending input text" })).toHaveValue('echo "SNIP-$((6*7))-EDITED"');
    await composer.getByRole("button", { name: "Run" }).click();
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm, "Esc leaves the step, not the drawer").toHaveCount(0);
    await expect(panel).toBeVisible();
    await settle();
    expect((await writes()).current, "a cancelled Run sends nothing").toBe(before.current);
    await expect(screen(paneA)).not.toContainText("SNIP-42");
    await composer.getByRole("button", { name: "Run" }).click();
    await panel.getByRole("button", { name: "Run", exact: true }).click();
    await expect(screen(paneA)).toContainText("SNIP-42-EDITED");
    await expect(feedback).toContainText("Sent and pressed Enter: 1 line to");
    await expect(feedback).toContainText("cannot tell whether the command succeeded");
    await expect(composer).toHaveCount(0);
    await expect(panel.getByRole("searchbox", { name: "Search snippets to send" }), "focus stays usable in the drawer").toBeFocused();
    expect((await writes()).current, "one Run is one write").toBe(before.current + 1);
    await closePanel();
    await expect(textarea(paneA), "closing returns focus to the active pane").toBeFocused();
    await idle(paneA);

    // 3. Insert without Enter: the text waits at the prompt until the user presses Enter.
    await openPanel(paneA);
    await row("Answer").getByRole("button", { name: "Paste Answer to composer" }).click();
    await composer.getByRole("textbox", { name: "Pending input text" }).fill('echo "INS-$((3+4))"');
    await composer.getByRole("button", { name: "Insert without Enter" }).click();
    await expect(feedback).toContainText("Inserted: 1 line to");
    await expect(screen(paneA)).toContainText('echo "INS-$((3+4))"');
    await settle();
    await expect(screen(paneA)).not.toContainText("INS-7");
    await closePanel();
    await textarea(paneA).focus();
    await page.keyboard.press("Enter");
    await expect(screen(paneA)).toContainText("INS-7");
    await idle(paneA);

    // 4. Empty snippets send nothing.
    await openPanel(paneA);
    const beforeEmpty = await writes();
    await row("Empty").getByRole("button", { name: "Run Empty" }).click();
    await expect(feedback).toContainText("This snippet is empty. Nothing was sent.");
    expect((await writes()).current).toBe(beforeEmpty.current);

    // 5. A DEV session in another tab: reopened there, multiline Thai runs in one bracketed paste without asking.
    await closePanel();
    await fixture("connectSecond");
    await showPane(page, paneB);
    await ready(paneB);
    await idle(paneB);
    await openPanel(paneB);
    await expect(target).toContainText(secondLabel);
    await row("หลายบรรทัด").getByRole("button", { name: "Run หลายบรรทัด" }).click();
    await expect(screen(paneB)).toContainText("M1-2");
    await expect(screen(paneB)).toContainText("ไทย-4");
    await expect(feedback).toContainText("2 lines to");
    await expect(page.getByTestId("snippet-confirm")).toHaveCount(0);

    // 960×640: the drawer stays inside the window without horizontal overflow and its text meets 4.5:1.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(960);
    const bounds = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { inside: box.left >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5, scroll: element.scrollWidth - element.clientWidth };
    });
    expect(bounds).toEqual({ inside: true, scroll: 0 });
    for (const [name, locator] of [
      ["feedback", feedback.locator("span")],
      ["target", target.locator("span.truncate.font-medium")],
      ["row", row("Answer").locator("span.truncate.font-medium")],
    ] as const) expect((await renderedContrast(locator)).ratio, name).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: testInfo.outputPath("snippet-panel-960x640.png") });

    // 6. The drawer captured B: switching to A behind it, before the click and while the body decrypts, cannot
    //    redirect Run, and the header keeps naming B.
    const gated = await hold(true);
    expect(gated, "the decrypt was held while panes switched").toBe(true);
    const beforeCapture = await writes();
    await switchBehind(label);
    await expect(target).toContainText(secondLabel);
    await expect(target).not.toContainText(label);
    await expect(target).toContainText("no longer the active terminal");
    await row("Captured").getByRole("button", { name: "Run Captured" }).click();
    await switchBehind(secondLabel);
    await switchBehind(label);
    await hold(false);
    await expect(feedback).toContainText(`1 line to ${secondLabel}`);
    await closePanel();
    await showPane(page, paneB);
    await expect(screen(paneB)).toContainText("CAP-25");
    await settle();
    await expect(screen(paneA)).not.toContainText("CAP-25");
    expect((await writes()).current, "the newly active PROD pane received nothing").toBe(beforeCapture.current);
    await idle(paneB);

    // 7. The captured terminal disconnects while the drawer is open: an explicit error, nothing sent. Opened on a
    //    pane with no connected terminal: an explicit error, nothing sent.
    await showPane(page, paneA);
    await openPanel(paneA);
    await expect(target).toContainText(label);
    const beforeClose = await writes();
    await fixture("close");
    await expect(paneA).not.toHaveAttribute("data-phase", "ready");
    await row("Answer").getByRole("button", { name: "Run Answer" }).click();
    await expect(feedback).toContainText(`Not sent: ${label} is no longer connected`);
    await closePanel();
    await openPanel(paneA);
    await expect(target).toContainText("No connected terminal");
    await row("Answer").getByRole("button", { name: "Run Answer" }).click();
    await expect(feedback).toContainText("No connected terminal is active. Nothing was sent.");
    expect((await writes()).current, "nothing reached the closed session").toBe(beforeClose.current);
    await closePanel();

    // 8. A lock clears the composer's decrypted text. Before that, Esc with pending input asks before discarding it.
    await showPane(page, paneB);
    await openPanel(paneB);
    await row("Answer").getByRole("button", { name: "Paste Answer to composer" }).click();
    await expect(composer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel.getByRole("alert")).toContainText("Discard unsaved changes?");
    await panel.getByRole("button", { name: "Keep editing" }).click();
    await expect(composer).toBeVisible();
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(composer).toHaveCount(0);
    await expect(feedback).toContainText("The workspace locked");

    // Esc closes the drawer and never reaches the terminal.
    await panel.getByRole("searchbox", { name: "Search snippets to send" }).focus();
    const beforeEsc = await writes();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    expect((await writes()).current, "Esc in the drawer sent nothing").toBe(beforeEsc.current);
    expect(desktop.errors).toEqual([]);
    await testInfo.attach("snippet-run-evidence", {
      body: JSON.stringify({ captureGated: gated, writes: await writes(), platform: process.platform }), contentType: "application/json",
    });
    const receipt = await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      const owned = (globalThis as any).__sstermSnippetRun;
      owned.dispose();
      return owned.fixture.cleanup();
    });
    expect(receipt).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
    cleaned = true;
  } finally {
    if (!cleaned) {
      await app.evaluate(async () => {
        await new Promise<void>((done) => setImmediate(done));
        const owned = (globalThis as any).__sstermSnippetRun;
        owned?.gate.release();
        owned?.dispose();
        await owned?.fixture.cleanup().catch(() => undefined);
      }).catch(() => undefined);
    }
  }
});
