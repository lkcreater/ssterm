import { resolve } from "node:path";
import { test, expect } from "./fixtures";

// The session authenticates with a Keychain-held fixture password; keep terminal content out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

const label = "ระบบทดสอบ เทอร์มินัล";
type Status = { id: string; generation: number; state: string; cleanup: string; error: string | null; end: { kind: string; code?: number; signal?: string } | null };
type Frames = { count: number; bytes: number; consecutive: boolean };

test("shipped terminal streams a real remote shell with resize, exits and no input replay", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.type()); void dialog.dismiss(); });
  const bootstrap = await page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("Terminal fixture bootstrap failed");
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
    if (!checked.ok || JSON.stringify(checked.value.owner) !== JSON.stringify(parameters.owner)) throw new Error("Terminal fixture owner mismatch");
    const { startTerminalFixture } = require(parameters.fixturePath);
    const fixture = await startTerminalFixture(production, {
      owner: parameters.owner, label: parameters.label, tempDirectory: app.getPath("temp"),
      send: (channel: string, value: unknown) => { if (!window.webContents.isDestroyed()) window.webContents.send(channel, value); },
    });
    for (const channel of production.terminalChannels) ipcMain.removeHandler(channel);
    const disposeHandlers = production.registerTerminalHandlers({ ipc: ipcMain, boundary, controller: () => fixture.controller });
    (globalThis as any).__sstermTerminalFixture = { fixture, disposeHandlers };
  }, { owner, label, fixturePath: resolve("tests/fixtures/terminal/ssh.cjs") });

  const operate = <T = Status>(method: "connect" | "reconnect" | "close" | "status" | "frames", argument?: number): Promise<T> => app.evaluate(async (_electron, parameters) => {
    await new Promise<void>((done) => setImmediate(done));
    return (globalThis as any).__sstermTerminalFixture.fixture[parameters.method](parameters.argument);
  }, { method, argument });
  const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const pane = page.getByRole("region", { name: `Terminal for ${label}`, exact: true });
  const screen = pane.locator(".xterm-rows");
  // Markers are computed remotely, so the echoed command line never satisfies its own assertion.
  const run = async (command: string) => {
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
  };
  const size = async () => ({ rows: await pane.getAttribute("data-rows"), columns: await pane.getAttribute("data-columns") });
  const ready = async (generation: number) => {
    await expect(pane).toHaveAttribute("data-generation", String(generation));
    await expect(pane).toHaveAttribute("data-phase", "ready");
    // Only text after the last Reconnected marker counts, so an earlier generation's prompt never satisfies it.
    await expect.poll(async () => {
      const text = (await screen.textContent()) ?? "";
      return text.slice(text.lastIndexOf("── Reconnected ──") + 1).includes("fixture@");
    }, { message: `generation ${generation} rendered a prompt` }).toBe(true);
  };
  const settled = async (state: string) => expect.poll(async () => {
    const status = await operate("status");
    return `${status.state}/${status.cleanup}`;
  }, { timeout: 20_000 }).toBe(`${state}/complete`);
  let cleaned = false;
  try {
    await operate("connect");
    await ready(1);
    await expect(pane.getByText("PROD", { exact: true })).toBeVisible();

    await run("echo $((6*7))-ANSWER");
    await expect(screen, "typed input reaches the shell and its output returns").toContainText("42-ANSWER");

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1000);
    await expect(pane).toHaveAttribute("data-rows", /^\d+$/);
    const small = await size();
    await run('echo "SIZE=$(stty size)"');
    await expect(screen, "remote PTY size equals the rendered grid").toContainText(`SIZE=${small.rows} ${small.columns}`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
    await expect.poll(async () => {
      const current = await size();
      return Number(current.rows) > Number(small.rows) && Number(current.columns) > Number(small.columns);
    }, { message: "a larger window yields a larger grid" }).toBe(true);
    const large = await size();
    await run('echo "SIZE=$(stty size)"');
    await expect(screen, "remote PTY follows the window resize").toContainText(`SIZE=${large.rows} ${large.columns}`);

    await run("tput smcup; printf 'ALT-%s' SCREEN; sleep 2; tput rmcup");
    await expect(screen, "full-screen output appears on the alternate screen").toContainText("ALT-SCREEN");
    await expect(screen, "leaving the alternate screen restores the normal buffer").not.toContainText("ALT-SCREEN");
    await expect(screen).toContainText("ALT-%s");

    await run("printf '\\x3cimg src=x onerror=alert(1)\\x3e-%s\\n' TRUST; printf '\\e]8;;https://example.invalid\\e\\\\LINK-%s\\e]8;;\\e\\\\\\n' OSC");
    await expect(screen, "HTML stays literal terminal text").toContainText("<img src=x onerror=alert(1)>-TRUST");
    await expect(pane.locator("img")).toHaveCount(0);
    const link = screen.getByText("LINK-OSC", { exact: false }).last();
    await expect(link).toBeVisible();
    const box = (await link.boundingBox())!;
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await expect(pane.locator(".xterm-screen"), "the pointer is over a recognized OSC 8 link").toHaveClass(/xterm-cursor-pointer/);
    await page.mouse.click(box.x + 4, box.y + box.height / 2);
    await run("echo AFTER-$((2+3))");
    await expect(screen).toContainText("AFTER-5");
    expect(await windows(), "OSC 8 link activation opens no window").toBe(1);
    expect(dialogs, "remote content raises no dialog").toEqual([]);

    await run("head -c 2000000 /dev/zero | tr '\\0' x | fold -w 100; echo DONE-$((40+2))");
    await expect(screen, "large output completes in order").toContainText("DONE-42", { timeout: 90_000 });
    const bulk = await operate<Frames>("frames", 1);
    expect(bulk.consecutive, "frames are consecutive from sequence 0").toBe(true);
    expect(bulk.bytes).toBeGreaterThanOrEqual(2_000_000);
    expect(bulk.count).toBeGreaterThan(1);

    await run("echo once >> ~/ssterm-replay");
    await run("exit 7");
    await expect(pane.getByText("Remote process exited with status 7", { exact: true })).toBeVisible();
    await settled("Closed");
    expect((await operate("status")).end).toEqual({ kind: "exit", code: 7 });

    const first = await operate("status");
    await operate("reconnect");
    await ready(2);
    const stale = await page.evaluate((request) => window.ssterm.writeTerminal({ ...request, bytes: new Uint8Array([0x0a]) }),
      { owner, sessionId: first.id, generation: first.generation });
    expect(stale.ok ? null : stale.error.code, "old generation input is refused").toBe("conflict");
    await run('echo "LINES=$(wc -l < ~/ssterm-replay)"');
    await expect(screen, "reconnect never replays earlier input").toContainText("LINES=1");
    await run("kill -KILL $$");
    await expect(pane.getByText("Remote process was terminated by SIGKILL", { exact: true })).toBeVisible();
    await settled("Closed");
    expect((await operate("status")).end).toEqual({ kind: "signal", signal: "SIGKILL" });

    await operate("reconnect");
    await ready(3);
    await run("kill -KILL $PPID");
    await expect(pane.getByText("Connection lost", { exact: true })).toBeVisible();
    await settled("Failed");
    expect(await operate("status")).toMatchObject({ error: "network", end: null });

    await operate("reconnect");
    await ready(4);
    await operate("close");
    await expect(pane.getByText("Session closed", { exact: true })).toBeVisible();
    await settled("Closed");
    expect((await operate("status")).end).toBeNull();

    expect(desktop.errors).toEqual([]);
    const evidence = { bulkFrames: bulk.count, bulkBytes: bulk.bytes, bulkConsecutive: bulk.consecutive, small, large,
      windows: await windows(), dialogs: dialogs.length, platform: process.platform };
    await testInfo.attach("terminal-runtime-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
    const receipt = await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      const owned = (globalThis as any).__sstermTerminalFixture;
      owned.disposeHandlers();
      return owned.fixture.cleanup();
    });
    expect(receipt).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
    cleaned = true;
  } finally {
    if (!cleaned) {
      const diagnostics = await app.evaluate(async () => {
        await new Promise<void>((done) => setImmediate(done));
        const owned = (globalThis as any).__sstermTerminalFixture;
        const status = owned?.fixture.status();
        owned?.disposeHandlers();
        const receipt = await owned?.fixture.cleanup().catch((error: Error) => error.message);
        return { status, receipt };
      }).catch(() => ({ status: "unavailable" }));
      await testInfo.attach("terminal-failure-state", { body: JSON.stringify(diagnostics), contentType: "application/json" });
    }
  }
});
