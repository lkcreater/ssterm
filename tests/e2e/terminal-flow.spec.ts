import { resolve } from "node:path";
import { test, expect } from "./fixtures";
import { TERMINAL_OUTPUT_WINDOW } from "../../packages/adapters/src/ssh";

// The session authenticates with a Keychain-held fixture password; keep terminal content out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

const label = "ระบบทดสอบ การไหล";
const MiB = 1_048_576;
// Adapter default output window plus one ssh2 chunk of slack.
const WINDOW_LIMIT = TERMINAL_OUTPUT_WINDOW + 32_768;
const PASTE = 262_144;
type Receipt = {
  count: number; bytes: number; consecutive: boolean; acks: number; ackedBytes: number;
  writes: number; writtenBytes: number; largestWrite: number; maxUnacked: number;
  firstFrameAt: number | null; lastFrameAt: number | null; lastAckAt: number | null; now: number;
};
const flood = (bytes: number, marker: string) =>
  `head -c ${bytes} /dev/zero | tr '\\0' x | fold -w 100; echo ${marker}-$((40+2))`;

test("terminal output and input stay bounded and responsive under a flood, a blocked renderer and a maximum paste", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const { app, page } = desktop;
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

  // Main-clock receipts (counts and timings only) for generation 1.
  const receipt = (method: "frames" | "mark" = "frames"): Promise<Receipt> => app.evaluate(async (_electron, method) => {
    await new Promise<void>((done) => setImmediate(done));
    return { ...(globalThis as any).__sstermTerminalFixture.fixture[method](1), now: performance.now() };
  }, method);
  // Peak main RSS and renderer working set, sampled in main so a blocked renderer cannot stall it.
  const stopMemory = () => app.evaluate(() => {
    const { start, main, renderer, timer } = (globalThis as any).__sstermFlowMemory;
    clearInterval(timer);
    return { mainGrowthMiB: (main - start) / 1_048_576, mainPeakMiB: main / 1_048_576, rendererPeakMiB: renderer / 1_048_576 };
  });
  const startMemory = () => app.evaluate(({ app }) => {
    const owned = globalThis as any;
    clearInterval(owned.__sstermFlowMemory?.timer);
    const state = { start: process.memoryUsage().rss, main: 0, renderer: 0, timer: undefined as unknown };
    const sample = () => {
      state.main = Math.max(state.main, process.memoryUsage().rss);
      for (const metric of app.getAppMetrics())
        if (metric.type === "Tab") state.renderer = Math.max(state.renderer, metric.memory.workingSetSize * 1024);
    };
    sample();
    state.timer = setInterval(sample, 50);
    owned.__sstermFlowMemory = state;
  });
  // Renderer long tasks and animation-frame intervals.
  const startProbe = () => page.evaluate(() => {
    const longTasks: number[] = [], intervals: number[] = [];
    const observer = new PerformanceObserver((list) => { for (const entry of list.getEntries()) longTasks.push(entry.duration); });
    observer.observe({ type: "longtask" });
    let running = true, last = performance.now();
    const tick = (now: number) => { intervals.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    (window as any).__sstermFlowProbe = { stop() { running = false; for (const entry of observer.takeRecords()) longTasks.push(entry.duration); observer.disconnect(); return { longTasks, intervals }; } };
  });
  const stopProbe = () => page.evaluate(() => {
    const { longTasks, intervals } = (window as any).__sstermFlowProbe.stop() as { longTasks: number[]; intervals: number[] };
    const sorted = [...intervals].sort((a, b) => a - b);
    return { longestTaskMs: Math.max(0, ...longTasks), longTasks: longTasks.length, frameP95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1) };
  });

  const pane = page.getByRole("region", { name: `Terminal for ${label}`, exact: true });
  const screen = pane.locator(".xterm-rows");
  const textarea = pane.locator(".xterm-helper-textarea");
  const type = async (command: string) => { await textarea.focus(); await page.keyboard.type(command); };
  const run = async (command: string) => { await type(command); await page.keyboard.press("Enter"); };
  // xterm draws the cursor element only while the terminal is focused.
  const idle = async () => { await textarea.focus(); await expect(pane.locator(".xterm-rows > div:has(.xterm-cursor)"), "the shell is waiting at an empty prompt").toHaveText(/\$\s*$/, { timeout: 60_000 }); };
  const growth = async (from: number, bytes: number) =>
    expect.poll(async () => (await receipt()).bytes - from, { intervals: [20], timeout: 30_000 }).toBeGreaterThan(bytes);
  const record = (name: string, value: unknown) => testInfo.annotations.push({ type: name, description: JSON.stringify(value) });
  let cleaned = false;
  try {
    await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      (globalThis as any).__sstermTerminalFixture.fixture.connect();
    });
    await expect(pane).toHaveAttribute("data-phase", "ready");
    await expect(screen, "remote prompt is rendered").toContainText("fixture@");
    await idle();

    // (a) 20 MB plain flood through the shipped path. The command is typed first so typing is not timed.
    await type(flood(20_000_000, "FLOW"));
    const start = await receipt("mark");
    await startProbe();
    await startMemory();
    await page.keyboard.press("Enter");
    await expect(screen, "the flood completes").toContainText("FLOW-42", { timeout: 60_000 });
    await idle();
    const end = await receipt();
    const render = await stopProbe();
    const floodMemory = await stopMemory();
    const bytes = end.bytes - start.bytes, mebibytes = bytes / MiB;
    const seconds = (end.lastFrameAt! - end.firstFrameAt!) / 1000;
    const flow = {
      MiB: +mebibytes.toFixed(1), seconds: +seconds.toFixed(2), MiBps: +(mebibytes / seconds).toFixed(1),
      framesPerMiB: +((end.count - start.count) / mebibytes).toFixed(1), acksPerMiB: +((end.acks - start.acks) / mebibytes).toFixed(1),
      maxUnackedKiB: +(end.maxUnacked / 1024).toFixed(0), ...render,
      mainPeakMiB: +floodMemory.mainPeakMiB.toFixed(0), rendererPeakMiB: +floodMemory.rendererPeakMiB.toFixed(0),
    };
    record("flood", flow);
    expect(bytes).toBeGreaterThanOrEqual(20_000_000);
    expect(end.consecutive, "frames are consecutive from sequence 0").toBe(true);
    expect(end.maxUnacked, "unacknowledged output stays within the window").toBeLessThanOrEqual(WINDOW_LIMIT);
    expect(render.longestTaskMs, "no renderer long task over 100 ms").toBeLessThanOrEqual(100);
    expect(flow.MiBps, "throughput budget").toBeGreaterThanOrEqual(10);

    // (b) Ctrl+C in the middle of an endless flood: the next command's output appears within 1 s.
    const before = await receipt();
    await run("yes FLOOD");
    await growth(before.bytes, MiB);
    const interrupted = Date.now();
    await page.keyboard.press("Control+C");
    // One input event, not one keystroke round trip per character, so the budget measures the terminal.
    await page.keyboard.insertText("echo STOPPED-$((3+4))");
    await page.keyboard.press("Enter");
    await expect(screen).toContainText("STOPPED-7", { timeout: 1_000 });
    const interruptMs = Date.now() - interrupted;
    record("interrupt", { markerVisibleMs: interruptMs });
    expect(interruptMs).toBeLessThanOrEqual(1_000);
    await idle();

    // (c) A renderer blocked for 3 s stops acknowledgements: output stops within the window, main stays
    // bounded, and the flood completes afterwards in order.
    await type(flood(60_000_000, "BLOCKED"));
    const blockStart = await receipt("mark");
    await startMemory();
    await page.keyboard.press("Enter");
    await growth(blockStart.bytes, 2 * MiB);
    await startProbe();
    await page.evaluate(() => { setTimeout(() => { const until = performance.now() + 3_000; while (performance.now() < until); }, 0); });
    const stalledFor = (ms: number) => expect.poll(async () => {
      const current = await receipt();
      return current.now - (current.lastAckAt ?? current.now);
    }, { intervals: [25], timeout: 5_000 }).toBeGreaterThanOrEqual(ms);
    await stalledFor(500);
    const held = await receipt();
    await stalledFor(2_000);
    const stillHeld = await receipt();
    expect(held.bytes - blockStart.bytes, "the renderer was blocked mid-flood").toBeLessThan(60_000_000);
    expect(stillHeld.count, "no frames are sent while the renderer is blocked").toBe(held.count);
    expect(stillHeld.bytes - stillHeld.ackedBytes).toBeLessThanOrEqual(WINDOW_LIMIT);
    await expect(screen, "the flood completes after the renderer recovers").toContainText("BLOCKED-42", { timeout: 60_000 });
    await idle();
    const recovered = await receipt();
    const blockedMemory = await stopMemory();
    // Proves the long-task instrument behind gate (a) observes this renderer.
    expect((await stopProbe()).longestTaskMs, "the 3 s block is observed as a long task").toBeGreaterThanOrEqual(2_900);
    record("blocked-renderer", {
      framesBeforeStall: held.count - blockStart.count, maxUnackedKiB: +(recovered.maxUnacked / 1024).toFixed(0),
      mainGrowthMiB: +blockedMemory.mainGrowthMiB.toFixed(1), mainPeakMiB: +blockedMemory.mainPeakMiB.toFixed(0),
      rendererPeakMiB: +blockedMemory.rendererPeakMiB.toFixed(0),
    });
    expect(recovered.consecutive).toBe(true);
    expect(recovered.bytes - blockStart.bytes).toBeGreaterThanOrEqual(60_000_000);
    expect(recovered.maxUnacked).toBeLessThanOrEqual(WINDOW_LIMIT);
    expect(blockedMemory.mainGrowthMiB, "main RSS growth stays bounded").toBeLessThanOrEqual(96);

    // (d) A maximum bracketed paste on an idle session reaches a byte-counting reader as one whole write.
    await run(String.raw`printf '\e[?2004h'; stty -icanon -echo; echo "PASTE-READY-$((5+5))"; head -c ${PASTE + 12} | wc -c | tr -d ' ' | sed 's/^/COUNT=/'; stty sane; printf '\e[?2004l'`);
    // READY follows the mode switch in the same stream, so xterm is bracketing by now.
    await expect(screen).toContainText("PASTE-READY-10");
    const unpasted = await receipt();
    const pasted = Date.now();
    await textarea.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, "x".repeat(PASTE));
    // An idle session always accepts one maximum write, so the paste must arrive whole.
    await expect(screen, "every pasted byte and both bracket markers arrived").toContainText(new RegExp(`COUNT=${PASTE + 12}(?!\\d)`), { timeout: 2_000 });
    const pasteMs = Date.now() - pasted;
    const after = await receipt();
    record("paste", { ms: pasteMs, writes: after.writes - unpasted.writes, bytes: after.writtenBytes - unpasted.writtenBytes });
    expect(after.writes - unpasted.writes, "the paste is one write").toBe(1);
    expect(after.writtenBytes - unpasted.writtenBytes).toBe(PASTE + 12);
    await expect(pane.getByText("Input was not delivered.", { exact: true })).toHaveCount(0);
    expect(pasteMs).toBeLessThanOrEqual(2_000);
    await idle();
    await run("echo NEXT-$((7+7))");
    await expect(screen, "the shell is not left inside a bracketed paste").toContainText("NEXT-14");

    expect(desktop.errors).toEqual([]);
    await testInfo.attach("terminal-flow-evidence", {
      body: JSON.stringify({ annotations: testInfo.annotations, platform: process.platform, arch: process.arch }),
      contentType: "application/json",
    });
    const cleanup = await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      const owned = (globalThis as any).__sstermTerminalFixture;
      owned.disposeHandlers();
      return owned.fixture.cleanup();
    });
    expect(cleanup).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
    cleaned = true;
  } finally {
    if (!cleaned) {
      const diagnostics = await app.evaluate(async () => {
        await new Promise<void>((done) => setImmediate(done));
        clearInterval((globalThis as any).__sstermFlowMemory?.timer);
        const owned = (globalThis as any).__sstermTerminalFixture;
        const status = owned?.fixture.status();
        owned?.disposeHandlers();
        const receipt = await owned?.fixture.cleanup().catch((error: Error) => error.message);
        return { status, receipt };
      }).catch(() => ({ status: "unavailable" }));
      await testInfo.attach("terminal-flow-failure-state", { body: JSON.stringify(diagnostics), contentType: "application/json" });
    }
  }
});
