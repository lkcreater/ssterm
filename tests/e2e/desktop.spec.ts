import { test, expect } from "./fixtures";
import type { WebContents, WebPreferences } from "electron";

test("renders the local shell offline with bundled fonts and isolated renderer", async ({
  desktop,
}, testInfo) => {
  const { app, page, errors, externalRequests } = desktop;
  await expect(page.getByText("No servers yet", { exact: true })).toBeVisible();
  const result = await page.evaluate(() => window.ssterm.bootstrap());
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Bootstrap failed");
  expect(result.value.app.name).toBe("ssterm");
  expect(await page.evaluate(() => Object.keys(window.ssterm).sort())).toEqual([
    "ackTerminal",
    "answerCredentials",
    "answerHostTrust",
    "applyCatalogChange",
    "bootstrap",
    "cancelCredentialPrompt",
    "catalogState",
    "chooseKeyFile",
    "closeSftp",
    "closeTerminal",
    "connectHost",
    "connectSftp",
    "credentialState",
    "deleteKey",
    "discardKeyImport",
    "dismissSftp",
    "dismissTerminal",
    "forgetKeyPassphrase",
    "importKey",
    "listDirectory",
    "onCatalogState",
    "onCredentialState",
    "onSftpState",
    "onTerminalOutput",
    "onTerminalState",
    "onTrustState",
    "onWindowState",
    "openLink",
    "openTerminal",
    "ping",
    "prepareCatalogChange",
    "prepareKnownHostRevoke",
    "reconnectSftp",
    "reconnectTerminal",
    "renameKey",
    "resizeTerminal",
    "resolvePath",
    "retrySecrets",
    "revokeKnownHost",
    "setIdentityPassword",
    "settings",
    "sftpState",
    "statPath",
    "terminalState",
    "trustState",
    "updateSettings",
    "writeTerminal",
  ]);
  expect(
    await page.evaluate(
      () => typeof (window as unknown as Record<string, unknown>).require,
    ),
  ).toBe("undefined");
  const policy = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    // Pinned Electron 44 exposes this diagnostic internally, outside its public types.
    const prefs = (
      window.webContents as WebContents & {
        getLastWebPreferences(): WebPreferences;
      }
    ).getLastWebPreferences();
    return {
      sandbox: prefs.sandbox,
      isolation: prefs.contextIsolation,
      node: prefs.nodeIntegration,
      webview: prefs.webviewTag,
      url: window.webContents.getURL(),
    };
  });
  expect(policy).toMatchObject({
    sandbox: true,
    isolation: true,
    node: false,
    webview: false,
  });
  expect(policy.url).toMatch(/^file:/);
  expect(
    await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content"),
  ).toContain("connect-src 'none'");
  await page.evaluate(() => document.fonts.ready);
  const typography = await page.evaluate(async () => {
    const loaded = await Promise.all([
      document.fonts.load('13px "Inter Variable"'),
      document.fonts.load('13px "JetBrains Mono Variable"'),
      document.fonts.load('13px "Noto Sans Thai Variable"', "ภาษาไทย"),
    ]);
    return {
      background: getComputedStyle(document.body).backgroundColor,
      inter: document.fonts.check('13px "Inter Variable"'),
      mono: document.fonts.check('13px "JetBrains Mono Variable"'),
      thai: document.fonts.check('13px "Noto Sans Thai Variable"', "ภาษาไทย"),
      loadedFaces: loaded.map((faces) =>
        faces.map((face) => ({ family: face.family, status: face.status })),
      ),
      fontSources: [...document.styleSheets].flatMap((sheet) =>
        [...sheet.cssRules]
          .filter(
            (rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule,
          )
          .map((rule) => rule.style.getPropertyValue("src")),
      ),
    };
  });
  expect(typography.background).toBe("rgb(12, 18, 32)");
  expect(typography.inter && typography.mono && typography.thai).toBe(true);
  expect(
    typography.loadedFaces.every(
      (faces) =>
        faces.length > 0 && faces.every((face) => face.status === "loaded"),
    ),
  ).toBe(true);
  expect(typography.fontSources.length).toBeGreaterThan(0);
  expect(
    typography.fontSources.every(
      (source) => !/https?:/.test(source) && source.includes(".woff2"),
    ),
  ).toBe(true);
  for (const [width, height] of [
    [1280, 800],
    [960, 640],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height],
    );
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`shell-${width}.png`) });
  }
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("validates runtime arguments, owner and stale generations through real IPC", async ({
  desktop,
}) => {
  const { page } = desktop;
  const before = await page.evaluate(() => window.ssterm.bootstrap());
  if (!before.ok) throw new Error("Bootstrap failed");
  const result = await page.evaluate(async (owner) => {
    const valid = await window.ssterm.ping({ owner, requestId: "health-1" });
    const wrongOwner = await window.ssterm.ping({
      owner: { ...owner, windowId: owner.windowId + 1 },
      requestId: "health-2",
    });
    const malformed = await (
      window.ssterm.ping as (value: unknown) => Promise<unknown>
    )({ owner, requestId: "x".repeat(65), password: "rejected-fixture-input" });
    return { valid, wrongOwner, malformed };
  }, before.value.owner);
  expect(result.valid).toEqual({
    ok: true,
    value: { requestId: "health-1", ready: true },
  });
  expect(result.wrongOwner).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  expect(result.malformed).toMatchObject({
    ok: false,
    error: { code: "invalid-request" },
  });
  expect(JSON.stringify(result)).not.toContain("rejected-fixture-input");
  await page.reload();
  const after = await page.evaluate(() => window.ssterm.bootstrap());
  if (!after.ok) throw new Error("Bootstrap after reload failed");
  expect(after.value.owner.generation).toBeGreaterThan(
    before.value.owner.generation,
  );
  const stale = await page.evaluate(
    (owner) => window.ssterm.ping({ owner, requestId: "stale" }),
    before.value.owner,
  );
  expect(stale).toMatchObject({ ok: false, error: { code: "stale-owner" } });
});

test("rejects unregistered windows and blocks navigation, popups and permission grants", async ({
  desktop,
}) => {
  const { app, page } = desktop;
  const unauthorized = app.waitForEvent("window");
  const id = await app.evaluate(async ({ BrowserWindow, app }) => {
    const source = BrowserWindow.getAllWindows()[0];
    const testWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: `${app.getAppPath()}/out/preload/index.js`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await testWindow.loadURL(source.webContents.getURL());
    return testWindow.id;
  });
  const otherPage = await unauthorized;
  expect(
    await otherPage.evaluate(() => window.ssterm.bootstrap()),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  await app.evaluate(
    ({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.destroy(),
    id,
  );
  const original = page.url();
  await page.evaluate(() => {
    window.open("https://example.invalid/");
  });
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    location.href = "https://example.invalid/";
  });
  expect(page.url()).toBe(original);
  expect(await page.evaluate(() => Notification.requestPermission())).toBe(
    "denied",
  );
});

test("delivers ordered window events and respects idempotent unsubscribe", async ({
  desktop,
}) => {
  const { app, page } = desktop;
  await page.evaluate(async () => {
    await window.ssterm.bootstrap();
    const state = window as unknown as {
      events: number[];
      stopEvents: () => void;
    };
    state.events = [];
    state.stopEvents = window.ssterm.onWindowState((event) =>
      state.events.push(event.sequence),
    );
  });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.emit("blur");
    window.emit("focus");
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { events: number[] }).events.length,
      ),
    )
    .toBeGreaterThan(0);
  const sequences = await page.evaluate(() => {
    const state = window as unknown as {
      events: number[];
      stopEvents: () => void;
    };
    state.stopEvents();
    state.stopEvents();
    return state.events;
  });
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.emit("blur");
    window.emit("focus");
  });
  await page.evaluate(() => window.ssterm.bootstrap());
  expect(
    await page.evaluate(
      () => (window as unknown as { events: number[] }).events,
    ),
  ).toEqual(sequences);
});
