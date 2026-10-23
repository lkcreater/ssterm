import { resolve } from "node:path";
import type { Locator } from "@playwright/test";
import type { CredentialPrompt, Owner } from "../../packages/contracts/src/index";
import { test, expect } from "./fixtures";
import { expectDrawerPlaced } from "./support/drawer";

// Credential values must never enter traces, automatic screenshots, videos, or test attachments.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("shipped SSH prompts unlock real keys and isolate bounded keyboard-interactive conversations", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  const bootstrap = await page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("Credential fixture bootstrap failed");
  const owner = bootstrap.value.owner;
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
    if (!checked.ok || JSON.stringify(checked.value.owner) !== JSON.stringify(parameters.owner)) throw new Error("Credential fixture owner mismatch");
    const { startCredentialFixture } = require(parameters.fixturePath);
    const fixture = await startCredentialFixture(production, {
      owner: parameters.owner, tempDirectory: app.getPath("temp"),
      send: (state: unknown) => window.webContents.send(production.channels.credentialStateChanged, state),
    });
    for (const name of ["credentialState", "answerCredentials", "cancelCredentialPrompt"]) ipcMain.removeHandler(production.channels[name]);
    const disposeHandlers = production.registerCredentialHandlers({ ipc: ipcMain, boundary, controller: () => fixture.controller });
    (globalThis as any).__sstermCredentialFixture = { fixture, disposeHandlers, boundary };
  }, { owner, fixturePath: resolve("tests/fixtures/credentials/ssh.cjs") });

  type Snapshot = { id: string; generation: number; state: string; error: string | null; cleanup: string; prompt: { id: string; attempt: number } | null };
  type Status = { current: string; sessions: Snapshot[]; observations: { zeroRounds: number; firstRounds: number; secondRounds: number; shells: number; rejectedMethods: number } };
  const operate = (method: "connect" | "close" | "reconnect" | "lock" | "status", argument?: string): Promise<Status> => app.evaluate(async (_electron, parameters) => {
    await new Promise<void>((done) => setImmediate(done));
    return (globalThis as any).__sstermCredentialFixture.fixture[parameters.method](parameters.argument);
  }, { method, argument });
  const status = () => operate("status");
  const fill = async (mode: "wrong" | "passphrase" | "password" | "first" | "second") => {
    // Main checks live prompt metadata and settled enabled fields before injecting any value.
    // A previous dialog may still be exiting after the registry has already published its replacement.
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }, mode) => {
      await new Promise<void>((done) => setImmediate(done));
      return (globalThis as any).__sstermCredentialFixture.fixture.fill(BrowserWindow.getAllWindows()[0].webContents, mode);
    }, mode)).toBe(true);
  };
  const dialog = page.getByTestId("credential-prompt-dialog");
  const proceed = dialog.getByRole("button", { name: "Continue", exact: true });
  const current = async () => { const state = await status(); return state.sessions.find((s) => s.id === state.current)!; };
  const settled = async (state: string, id?: string) => {
    await expect.poll(async () => {
      const snapshot = id ? (await status()).sessions.find((s) => s.id === id)! : await current();
      return snapshot.cleanup === "pending" ? "cleaning" : snapshot.state;
    }).toBe(state);
    // Registry completion precedes the renderer's state update and dialog exit animation.
    if (!(await status()).sessions.some((session) => session.prompt)) await expect(dialog).toHaveCount(0);
  };
  const prompt = async (): Promise<CredentialPrompt> => {
    const state = await page.evaluate((owner) => window.ssterm.credentialState({ owner }), owner);
    if (!state.ok || !state.value.prompts[0]) throw new Error("Credential prompt missing");
    return state.value.prompts[0];
  };
  const identity = (p: CredentialPrompt) => ({ owner, sessionId: p.sessionId, generation: p.generation, promptId: p.promptId });
  const staleAnswer = (parameters: { owner: Owner; sessionId: string; generation: number; promptId: string }) => page.evaluate((request) =>
    window.ssterm.answerCredentials({ ...request, values: [{ id: "passphrase", value: new Uint8Array([1]) }] }), parameters);
  const shots: string[] = [];
  const shot = async (name: string) => {
    // Evidence is captured only while every input is empty. This predicate returns no values.
    expect(await dialog.locator("input").evaluateAll((inputs) => inputs.every((input) => !(input as HTMLInputElement).value))).toBe(true);
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
    shots.push(name);
  };
  const contrast: Record<string, number> = {};
  const measure = async (locator: Locator, label: string) => {
    const ratio = await locator.evaluate((element) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const ancestors: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
      for (const node of ancestors) { context.fillStyle = getComputedStyle(node).backgroundColor; context.fillRect(0, 0, 1, 1); }
      const background = [...context.getImageData(0, 0, 1, 1).data];
      context.fillStyle = getComputedStyle(element).color; context.fillRect(0, 0, 1, 1);
      const foreground = [...context.getImageData(0, 0, 1, 1).data];
      const luminance = (rgb: number[]) => rgb.slice(0, 3).map((value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
      const values = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
      return (values[0]! + 0.05) / (values[1]! + 0.05);
    });
    contrast[label] = Math.round(ratio * 100) / 100;
    expect(ratio, label).toBeGreaterThanOrEqual(4.5);
  };
  let cleaned = false;
  try {
    const nav = page.getByRole("button", { name: "Known hosts", exact: true });
    await nav.click();
    await operate("connect", "passphrase");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Passphrase", { exact: true })).toBeFocused();
    await expect(dialog.getByLabel("Passphrase", { exact: true })).toHaveAttribute("type", "password");
    await expect(dialog.getByText("Attempt 1 of 3", { exact: false })).toBeVisible();
    await expect(dialog.getByText("ระบบทดสอบ กรุงเทพ", { exact: true })).toBeVisible();
    await expect(dialog.getByText("PROD", { exact: true })).toBeVisible();
    // A click on the scrim neither dismisses nor cancels the prompt.
    const opened = identity(await prompt());
    await page.mouse.click(40, 320);
    await expect(dialog).toBeVisible();
    expect(identity(await prompt())).toEqual(opened);
    await expect(dialog.getByLabel("Passphrase", { exact: true })).toBeFocused();
    await shot("credentials-passphrase-1280");
    await expectDrawerPlaced(page, "credential-passphrase");
    await measure(dialog.getByRole("heading", { name: "SSH authentication", exact: true }), "heading");
    await measure(dialog.getByText("ระบบทดสอบ กรุงเทพ", { exact: true }), "Thai target");
    await measure(dialog.getByText("PROD", { exact: true }), "PROD badge");
    await measure(dialog.getByText("Attempt 1 of 3", { exact: false }), "attempt");
    await measure(dialog.getByText("Passphrase", { exact: true }), "field label");
    await measure(proceed, "continue");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(proceed).toBeFocused();
    // The drawer's header Close (an explicit cancel, like Esc) is last in tab order.
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByLabel("Passphrase", { exact: true })).toBeFocused();
    // A composing Enter is consumed without dispatching credentials or advancing the attempt.
    await dialog.getByLabel("Passphrase", { exact: true }).evaluate((input) => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true }));
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await expect(dialog.getByText("Attempt 1 of 3", { exact: false })).toBeVisible();
    const beforeByteLimit = identity(await prompt());
    // This static Thai marker is test data, not a credential: 6,000 characters encode to 18,000 bytes.
    await dialog.getByLabel("Passphrase", { exact: true }).evaluate((input) => {
      (input as HTMLInputElement).value = "ก".repeat(6_000);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await proceed.click();
    await expect(dialog.getByText("Authentication responses are too long", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Passphrase", { exact: true })).toHaveValue("");
    expect(identity(await prompt())).toEqual(beforeByteLimit);
    await fill("wrong");
    await proceed.click();
    await expect(dialog.getByText("Attempt 2 of 3", { exact: false })).toBeVisible();
    await expect(dialog.getByLabel("Passphrase", { exact: true })).toHaveValue("");
    await fill("passphrase");
    await proceed.click();
    await settled("Ready");
    await expect(dialog).toHaveCount(0);
    await expect(nav).toBeFocused();
    await operate("close");

    await operate("connect", "passphrase");
    await expect(dialog).toBeVisible();
    const cancelled = identity(await prompt());
    await fill("passphrase");
    await page.keyboard.press("Escape");
    await settled("Failed");
    await expect(dialog).toHaveCount(0);
    expect((await staleAnswer(cancelled)).ok).toBe(false);
    await operate("reconnect");
    await expect(dialog).toBeVisible();
    expect((await staleAnswer(cancelled)).ok).toBe(false);
    await expect(dialog.getByText("Attempt 1 of 3", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await settled("Failed");
    await operate("close");

    await operate("connect", "passphrase");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(dialog.getByText(`Attempt ${attempt} of 3`, { exact: false })).toBeVisible();
      await fill("wrong");
      await proceed.click();
    }
    await settled("Failed");
    await expect(dialog).toHaveCount(0);
    await operate("close");

    await operate("connect", "password");
    await expect(dialog.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
    await fill("password");
    await proceed.click();
    await settled("Ready");
    await expect(dialog).toHaveCount(0);
    await operate("close");

    await operate("connect", "keyboard");
    await expect(dialog.getByLabel("Response 1", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("Response 1", { exact: true })).toHaveAttribute("type", "password");
    await expect(dialog.getByLabel("Response 2", { exact: true })).toHaveAttribute("type", "text");
    expect(await dialog.textContent()).not.toContain("Untrusted");
    expect(await dialog.textContent()).not.toContain("Remote instruction");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await shot("credentials-keyboard-960-reduced-motion");
    await expectDrawerPlaced(page, "credential-keyboard-interactive");
    await measure(dialog.getByText("Response 1", { exact: true }), "keyboard field label");
    await fill("first");
    await proceed.click();
    await expect(dialog.getByText("Attempt 2 of 3", { exact: false })).toBeVisible();
    await expect(dialog.getByLabel("Response 2", { exact: true })).toHaveCount(0);
    await expect(dialog.getByLabel("Response 1", { exact: true })).toHaveValue("");
    await fill("second");
    await proceed.click();
    await settled("Ready");
    expect((await status()).observations.zeroRounds).toBe(1);
    await operate("close");

    await operate("connect", "zero");
    await settled("Ready");
    await expect(dialog).toHaveCount(0);
    expect((await status()).observations.zeroRounds).toBe(2);
    await operate("close");

    await operate("connect", "exhaust");
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(dialog.getByText(`Attempt ${attempt} of 3`, { exact: false })).toBeVisible();
      await fill(attempt === 1 ? "first" : "second");
      await proceed.click();
    }
    await settled("Failed");
    await expect(dialog).toHaveCount(0);
    await operate("close");

    // Two live prompts remain bound to their captured sessions and cannot exchange responses.
    const first = (await operate("connect", "passphrase")).current;
    await expect(dialog.getByLabel("Passphrase", { exact: true })).toBeVisible();
    const p = identity(await prompt());
    await fill("passphrase");
    const second = (await operate("connect", "keyboard")).current;
    await expect.poll(async () => {
      const state = await page.evaluate((owner) => window.ssterm.credentialState({ owner }), owner);
      return state.ok ? state.value.prompts.length : -1;
    }).toBe(2);
    expect((await page.evaluate((request) => window.ssterm.cancelCredentialPrompt(request), { ...p, sessionId: second })).ok).toBe(false);
    // Unrelated session projections preserve the pending DOM input without copying it into React state.
    expect(await dialog.getByLabel("Passphrase", { exact: true }).evaluate((input) => (input as HTMLInputElement).value.length > 0)).toBe(true);
    await proceed.click();
    await settled("Ready", first);
    await expect(dialog.getByLabel("Response 2", { exact: true })).toBeVisible();
    await fill("first"); await proceed.click();
    await expect(dialog.getByText("Attempt 2 of 3", { exact: false })).toBeVisible();
    await fill("second"); await proceed.click();
    await settled("Ready", second);
    await operate("close", first); await operate("close", second);

    await operate("connect", "delayed");
    await expect(dialog.getByLabel("Response 2", { exact: true })).toBeVisible();
    await fill("first"); await proceed.click();
    await operate("close");
    await settled("Closed");
    await expect(dialog).toHaveCount(0);
    // The following real prompt timeout outlives the delayed server callback as well.
    await operate("connect", "timeout");
    await expect(dialog).toBeVisible();
    await expect.poll(async () => (await current()).state, { timeout: 20_000 }).toBe("Failed");
    await expect(dialog).toHaveCount(0);
    await operate("close");
    await operate("connect", "passphrase");
    await expect(dialog).toBeVisible();
    await fill("passphrase");
    await operate("lock");
    await settled("Closed");
    await expect(dialog).toHaveCount(0);

    const privacy = await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      return (globalThis as any).__sstermCredentialFixture.fixture.privacy();
    });
    expect(privacy).toEqual({ safeEvents: true, noPlaintextMetadata: true, unsavedPassphrase: true, rejectedMethods: 0 });
    expect(desktop.errors).toEqual([]);
    await testInfo.attach("credential-runtime-evidence", { body: JSON.stringify({ ...privacy, shots, contrast, viewport: [960, 640], reducedMotion: true, platform: process.platform }), contentType: "application/json" });
    const receipt = await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      const owned = (globalThis as any).__sstermCredentialFixture;
      owned.disposeHandlers();
      return owned.fixture.cleanup();
    });
    expect(receipt).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
    cleaned = true;
  } finally {
    if (!cleaned) {
      const diagnostics = await app.evaluate(async ({ BrowserWindow }) => {
        await new Promise<void>((done) => setImmediate(done));
        const owned = (globalThis as any).__sstermCredentialFixture;
        // Clear even echo-enabled fields before Playwright captures its failure ARIA snapshot.
        const dom = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
          const dialogs = [...document.querySelectorAll('[data-testid="credential-prompt-dialog"]')];
          const inputs = dialogs.flatMap((dialog) => [...dialog.querySelectorAll('input')]);
          const result = { dialogs: dialogs.length, fields: inputs.length, disabled: inputs.filter((input) => input.disabled).length };
          inputs.forEach((input) => { input.value = ''; });
          return result;
        })()`);
        const registry = owned?.fixture.status();
        owned?.disposeHandlers();
        await owned?.fixture.cleanup();
        return { dom, registry };
      });
      await testInfo.attach("credential-failure-state", { body: JSON.stringify(diagnostics), contentType: "application/json" });
    }
  }
});
