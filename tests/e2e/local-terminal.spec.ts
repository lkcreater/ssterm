import { resolve } from "node:path";
import type { Locator, TestInfo } from "@playwright/test";
import type { Owner } from "../../packages/contracts/src/index";
import { test, expect, emptyTestNamespace, type Desktop } from "./fixtures";
import { renderedContrast } from "./support/transfer-fixture";

// Native shells can print arbitrary content. Only explicit, empty-terminal visual evidence is captured.
test.use({ trace: "off", screenshot: "off", video: "off" });

interface Session {
  id: string; generation: number; state: string; cleanup: string; hostId: string | null; target: unknown;
  local: { shell: string; platform: string } | null; error: string | null;
}

async function localTerminal(desktop: Desktop) {
  const { app, page } = desktop;
  const boot = await page.evaluate(() => window.ssterm.bootstrap());
  if (!boot.ok) throw new Error("Local terminal bootstrap failed");
  const owner: Owner = boot.value.owner;
  await app.evaluate(async ({ app, BrowserWindow, ipcMain, powerMonitor }, parameters) => {
    await new Promise<void>((done) => setImmediate(done));
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const production = require(path.join(app.getAppPath(), "out/main/ssh.js"));
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const owned: any = { disposers: [] };
    const boundary = new production.WindowBoundary(contents.getURL().split("#")[0],
      { name: "ssterm", version: app.getVersion(), platform: process.platform }, () => ({ status: "ready", schemaVersion: 4 }),
      (revoked: unknown) => { owned.fixture?.controller.revokeOwner(revoked); owned.fixture?.runtime.revokeOwner(revoked); });
    boundary.register(contents, BrowserWindow.getAllWindows()[0].id, true, () => {});
    for (let generation = 1; generation < parameters.owner.generation; generation += 1) boundary.rotate(contents);
    const checked = boundary.bootstrap({ sender: contents, senderFrame: contents.mainFrame }, []);
    if (!checked.ok || JSON.stringify(checked.value.owner) !== JSON.stringify(parameters.owner)) throw new Error("Local fixture owner mismatch");
    owned.fixture = await require(parameters.fixturePath).startLocalTerminalFixture(production, {
      owner: parameters.owner, power: powerMonitor,
      send(channel: string, frame: unknown) { if (!contents.isDestroyed()) contents.send(channel, frame); },
    });
    for (const channel of production.terminalChannels) ipcMain.removeHandler(channel);
    owned.disposers.push(production.registerTerminalHandlers({ ipc: ipcMain, boundary, controller: () => owned.fixture.controller }));
    const crash = () => boundary.rotate(contents);
    contents.on("render-process-gone", crash);
    owned.disposers.push(() => contents.removeListener("render-process-gone", crash));
    // The fixture participates in Electron quit using the same shipped runtime.shutdown drain as main.
    let quitting = false, drained = false;
    const quit = (event: Electron.Event) => {
      if (drained) return;
      event.preventDefault();
      if (quitting) return;
      quitting = true;
      void owned.fixture.cleanup().then(() => { drained = true; app.quit(); });
    };
    app.on("before-quit", quit);
    owned.disposers.push(() => app.removeListener("before-quit", quit));
    (globalThis as any).__sstermLocalTerminal = owned;
  }, { owner, fixturePath: resolve("tests/fixtures/local-terminal/pty.cjs") });

  const operate = <T>(method: string, args: unknown[] = []): Promise<T> => app.evaluate(async (_, parameters) => {
    await new Promise<void>((done) => setImmediate(done));
    return (globalThis as any).__sstermLocalTerminal.fixture[parameters.method](...parameters.args);
  }, { method, args });
  const ids = () => page.locator("section[data-terminal-kind=local]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-session-id")!));
  const opened = async (before: string[]) => {
    let id = "";
    await expect.poll(async () => (id = (await ids()).find((id) => !before.includes(id)) ?? "")).not.toBe("");
    return page.locator(`section[data-session-id="${id}"]`);
  };
  const ready = async (pane: Locator, generation = 1) => {
    await expect(pane).toHaveAttribute("data-generation", String(generation));
    await expect(pane).toHaveAttribute("data-phase", "ready");
    await expect(pane.locator(".xterm-rows")).toContainText("bash-");
  };
  const start = async () => {
    const before = await ids();
    await page.getByRole("button", { name: "New local terminal", exact: true }).first().click();
    const pane = await opened(before);
    await ready(pane);
    return pane;
  };
  const run = async (pane: Locator, command: string) => {
    await pane.locator(".xterm-helper-textarea").focus();
    // insertText delivers Unicode through the actual xterm input handler without using the real clipboard.
    await page.keyboard.insertText(command);
    await page.keyboard.press("Enter");
  };
  const target = async (pane: Locator) => ({ owner, sessionId: (await pane.getAttribute("data-session-id"))!, generation: Number(await pane.getAttribute("data-generation")) });
  let cleaned = false;
  const finish = async () => {
    const receipt = await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      const owned = (globalThis as any).__sstermLocalTerminal;
      for (const dispose of owned.disposers.splice(0)) dispose();
      return owned.fixture.cleanup();
    });
    cleaned = true;
    return receipt;
  };
  const diagnose = async (info: TestInfo) => {
    if (cleaned) return;
    const diagnostics = await app.evaluate(async () => {
      const owned = (globalThis as any).__sstermLocalTerminal;
      for (const dispose of owned.disposers.splice(0)) dispose();
      const sessions = owned.fixture.sessions();
      const cleanup = await owned.fixture.cleanup().catch((error: Error) => error.message);
      return { sessions, cleanup };
    }).catch(() => ({ unavailable: true }));
    await info.attach("local-terminal-cleanup", { body: JSON.stringify(diagnostics), contentType: "application/json" });
  };
  return { owner, start, ready, run, target, ids, opened, operate, finish, diagnose };
}

test("local terminal uses a native isolated PTY, labels This Mac, resizes and restarts without replay", async ({ desktop }, info) => {
  test.setTimeout(120_000);
  const { app, page } = desktop;
  const h = await localTerminal(desktop);
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(960, 640));
    const pane = await h.start();
    const screen = pane.locator(".xterm-rows");
    await expect(pane).toHaveAttribute("aria-label", "Terminal for This Mac · LOCAL · /bin/bash");
    await expect(pane.getByText("LOCAL", { exact: true })).toBeVisible();
    await expect(pane.getByText("This Mac", { exact: true })).toBeVisible();
    await expect(pane.getByText("PROD", { exact: true })).toHaveCount(0);
    const tabs = page.getByRole("tablist", { name: "Terminal tabs" });
    await expect(tabs).toContainText("LOCAL");
    await expect(tabs).toContainText("This Mac");
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const contrasts: Record<string, unknown> = {};
    for (const [name, locator] of [
      ["local badge", pane.locator(".pane-header .pane-badge")],
      ["machine label", pane.locator(".pane-header .type-label")],
      ["system shell", pane.locator(".pane-header .host-target")],
    ] as const) {
      const contrast = await renderedContrast(locator);
      contrasts[name] = contrast;
      expect(contrast.ratio, name).toBeGreaterThanOrEqual(4.5);
    }
    await info.attach("local-terminal-visual-evidence", { body: JSON.stringify({ contrasts, viewport: [960, 640], reducedMotion: true, platform: process.platform }), contentType: "application/json" });
    await page.evaluate(() => document.fonts.ready);
    const path = info.outputPath("local-terminal-960x640.png");
    await page.screenshot({ path, animations: "disabled" });
    await info.attach("local-terminal-empty-960x640", { path, contentType: "image/png" });

    await h.run(pane, "echo once >> replay; printf '%s-%s\\n' 'ไทย' $((6*7))");
    await expect(screen).toContainText("ไทย-42");
    await h.run(pane, "printf '%s\\n' 'รับส่งภาษาไทย 🐚'; echo $$ > owned-shell.pid");
    await expect(screen).toContainText("รับส่งภาษาไทย 🐚");
    await h.run(pane, "printf 'FOREGROUND-%s\\n' $((8*8)); /bin/sleep 600");
    await expect(screen).toContainText("FOREGROUND-64");
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+c");
    await h.run(pane, "printf 'INTERRUPTED-%s\\n' $((9*9))");
    await expect(screen).toContainText("INTERRUPTED-81");
    const beforeSize = `${await pane.getAttribute("data-rows")} ${await pane.getAttribute("data-columns")}`;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
    await expect.poll(async () => `${await pane.getAttribute("data-rows")} ${await pane.getAttribute("data-columns")}`).not.toBe(beforeSize);
    let grid = "";
    await expect.poll(async () => grid === (grid = `${await pane.getAttribute("data-rows")} ${await pane.getAttribute("data-columns")}`), { intervals: [200] }).toBe(true);
    await h.run(pane, "echo SIZE-$(stty size)");
    await expect(screen).toContainText(`SIZE-${grid}`);
    await pane.getByRole("button", { name: "Pane actions", exact: true }).click();
    const menu = page.getByRole("menu", { name: "Pane actions", exact: true });
    await expect(menu).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Open in SFTP", exact: true })).toHaveCount(0);
    await menu.getByRole("menuitem").first().focus();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    const old = await h.target(pane);
    // Final bytes must be delivered before native exit disposes the terminal stream.
    await h.run(pane, "printf 'EXIT-%s\\n' $((20+9)); exit 7");
    await expect(screen).toContainText("EXIT-29");
    await expect(pane.getByText("Local process exited with status 7", { exact: true })).toBeVisible();
    await expect.poll(() => h.operate<number[]>("alive")).toEqual([]);
    await pane.getByRole("button", { name: "Restart local shell", exact: true }).click();
    await h.ready(pane, 2);
    expect(await h.operate<number>("replayLines")).toBe(1);
    const stale = await page.evaluate(async (request) => {
      const result = await window.ssterm.writeTerminal({ ...request, bytes: new TextEncoder().encode("exit\r") });
      return result.ok ? "ok" : result.error.code;
    }, old);
    expect(stale).toBe("conflict");
    await h.run(pane, "echo NEW-$((3*11)); echo $$ > owned-restarted.pid");
    await expect(screen).toContainText("NEW-33");

    const before = await h.ids();
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+d");
    const sibling = await h.opened(before);
    await h.ready(sibling);
    await expect(sibling.getByText("LOCAL", { exact: true })).toBeVisible();
    expect(await h.operate<number>("replayLines")).toBe(1);
    const snapshots = await h.operate<Session[]>("sessions");
    expect(snapshots).toHaveLength(2);
    for (const session of snapshots) {
      expect(session.hostId).toBeNull();
      expect(session.target).toBeNull();
      expect(session.local).toEqual({ shell: "/bin/bash", platform: "darwin" });
    }
    const projection = await page.evaluate(async (owner) => {
      const result = await window.ssterm.terminalState({ owner });
      if (!result.ok) throw new Error("Local projection unavailable");
      return result.value.sessions;
    }, h.owner);
    for (const session of projection) {
      expect(session.hostId).toBeNull();
      expect(session.target).toBeNull();
      expect(session.local).toEqual({ shell: "/bin/bash", platform: "darwin" });
    }
    const frames = await h.operate<{ consecutive: boolean; bytes: number }>("frames", [old.sessionId, 1]);
    expect(frames.consecutive).toBe(true);
    expect(frames.bytes).toBeGreaterThan(0);

    // Single-pane snippets retain the explicit local identity; Paste sends no bytes and Run targets
    // only the captured local pane. Multi-target composer below deliberately excludes local sessions.
    const saved = await page.evaluate(async (owner) => {
      const result = await window.ssterm.saveSnippet({ owner, snippetId: null, expectedRevision: null,
        label: "Owned local snippet", body: "printf 'LOCAL-SNIP-%s\\n' $((7*8))", tagIds: [] });
      return result.ok && result.value.status === "saved";
    }, h.owner);
    expect(saved).toBe(true);
    await sibling.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+Shift+KeyS");
    const snippets = page.getByTestId("snippet-panel");
    const snippetTarget = snippets.getByTestId("snippet-target");
    await expect(snippetTarget).toContainText("This Mac");
    await expect(snippetTarget).toContainText("LOCAL");
    await expect(snippetTarget).toContainText("/bin/bash");
    const siblingTarget = await h.target(sibling);
    const beforePaste = await h.operate<{ writes: number }>("frames", [siblingTarget.sessionId, 1]);
    await snippets.getByRole("button", { name: "Paste Owned local snippet to composer", exact: true }).click();
    const composer = snippets.getByTestId("snippet-composer");
    await expect(composer).toContainText("LOCAL");
    expect((await h.operate<{ writes: number }>("frames", [siblingTarget.sessionId, 1])).writes).toBe(beforePaste.writes);
    await composer.getByRole("button", { name: "Run", exact: true }).click();
    await expect(sibling.locator(".xterm-rows")).toContainText("LOCAL-SNIP-56");
    await expect(screen).not.toContainText("LOCAL-SNIP-56");
    await snippets.getByRole("button", { name: "Close snippets", exact: true }).click();

    await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
    const tools = page.getByTestId("workspace-tools");
    await expect(tools).toContainText("Local panes are excluded");
    await expect(tools.getByRole("group", { name: "Available targets", exact: true }).getByRole("checkbox")).toHaveCount(0);
    await tools.getByLabel("Template name", { exact: true }).fill("Owned local exclusion");
    await tools.getByRole("button", { name: "Save workspace template", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("saved-host panes");
    await expect(tools.getByRole("list", { name: "Saved workspace templates" }).getByRole("listitem")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
    expect(await h.finish()).toEqual({ fixtureCleaned: true, remainingProcesses: 0 });
  } finally { await h.diagnose(info); }
});

test("lock, suspend and owner revocation terminate local shells and owned background children", async ({ desktop }, info) => {
  test.setTimeout(120_000);
  const { app, page } = desktop;
  const h = await localTerminal(desktop);
  try {
    const pane = await h.start();
    for (const [round, event] of ["lock-screen", "suspend"].entries()) {
      await h.run(pane, `echo $$ > owned-shell-${round}.pid; sleep 600 & echo $! > owned-child-${round}.pid; echo CHILD-$((10+${round}))`);
      await expect(pane.locator(".xterm-rows")).toContainText(`CHILD-${10 + round}`);
      expect((await h.operate<number[]>("alive")).length).toBeGreaterThanOrEqual(2);
      await app.evaluate(({ powerMonitor }, event) => { powerMonitor.emit(event); }, event);
      await expect(pane.getByText("Closed because ssterm locked (screen lock or sleep)", { exact: true })).toBeVisible();
      await expect.poll(() => h.operate<number[]>("alive"), { timeout: 15_000 }).toEqual([]);
      await expect.poll(async () => (await h.operate<Session[]>("sessions")).every((session) => session.cleanup === "complete")).toBe(true);
      await pane.getByRole("button", { name: "Restart local shell", exact: true }).click();
      await h.ready(pane, round + 2);
    }
    await h.run(pane, "echo $$ > owned-crash-shell.pid; sleep 600 & echo $! > owned-crash-child.pid; echo CRASH-$((7*9))");
    await expect(pane.locator(".xterm-rows")).toContainText("CRASH-63");
    const crashed = page.waitForEvent("crash");
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); });
    await crashed;
    await expect.poll(() => h.operate<Session[]>("sessions")).toEqual([]);
    await expect.poll(() => h.operate<number[]>("alive"), { timeout: 15_000 }).toEqual([]);
    expect(await h.finish()).toEqual({ fixtureCleaned: true, remainingProcesses: 0 });
  } finally { await h.diagnose(info); }
});

test("quitting drains the real local PTY and owned background child before Electron exits", async ({ desktop }, info) => {
  test.setTimeout(90_000);
  const { app } = desktop;
  const h = await localTerminal(desktop);
  let quitting = false;
  try {
    const pane = await h.start();
    await h.run(pane, "echo $$ > owned-quit-shell.pid; sleep 600 & echo $! > owned-quit-child.pid; echo QUIT-$((5*5))");
    await expect(pane.locator(".xterm-rows")).toContainText("QUIT-25");
    const pids = await h.operate<number[]>("alive");
    expect(pids).toHaveLength(2);
    expect(await emptyTestNamespace(app, desktop.secretNamespace)).toBe(0);
    const child = app.process();
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    await app.evaluate(({ app, dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
      setImmediate(() => app.quit());
    });
    quitting = true;
    await exited;
    // The runner verifies after the main process is gone, so an in-memory fixture receipt cannot hide a leak.
    await expect.poll(() => pids.filter((pid) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    }), { timeout: 15_000 }).toEqual([]);
    expect(desktop.errors).toEqual([]);
  } finally { if (!quitting) await h.diagnose(info); }
});
