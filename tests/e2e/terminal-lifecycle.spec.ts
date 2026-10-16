import { execFile, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Locator, Page, TestInfo } from "@playwright/test";
import type { Owner } from "../../packages/contracts/src/index";
import { _electron } from "@playwright/test";
import { test, expect, showPane } from "./fixtures";

// Sessions authenticate with a Keychain-held fixture password; keep terminal content out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

const label = "ระบบทดสอบ วงจรชีวิต";
const secondLabel = "เครื่องสำรอง วงจรชีวิต";
const promptLabel = "ระบบทดสอบ รหัสผ่าน";
const locked = "Closed because ssterm locked (screen lock or sleep)";
const runFile = promisify(execFile);
type Status = { id: string; generation: number; state: string; cleanup: string; error: string | null } | null;
interface Desktop { app: ElectronApplication; page: Page; errors: string[] }
interface Lab { host: string; port: number; username: string; password: string; container: string }
interface Options {
  limits?: { connectMs?: number };
  autoTrust?: boolean;
  /** Route credential and host-trust dialogs to the fixture registry. */
  prompts?: boolean;
  /** Use Electron's powerMonitor, so a lock-screen event reaches the fixture registry. */
  power?: boolean;
  /** A runner-owned lab that outlives the app. */
  lab?: Lab;
  /** Mirror main: a crashed renderer rotates the owner, which closes its sessions. */
  crash?: boolean;
}

/** Shipped controllers and handlers over an owned saved-host registry, with keepalive 1 s × 2. */
async function start(desktop: Desktop, options: Options = {}) {
  const { app, page } = desktop;
  const bootstrap = await page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("Lifecycle fixture bootstrap failed");
  const owner: Owner = bootstrap.value.owner;
  await app.evaluate(async ({ app, BrowserWindow, ipcMain, powerMonitor }, parameters) => {
    await new Promise<void>((done) => setImmediate(done));
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const out = (name: string) => require(path.join(app.getAppPath(), `out/main/${name}.js`));
    const trust = out("trust");
    const production = { ...out("ssh"), ...out("secrets"),
      createKnownHostsController: trust.createKnownHostsController, registerKnownHostHandlers: trust.registerKnownHostHandlers };
    const window = BrowserWindow.getAllWindows()[0];
    const contents = window.webContents;
    const send = (channel: string, value: unknown) => { if (!contents.isDestroyed()) contents.send(channel, value); };
    const owned: any = { disposers: [] as (() => void)[] };
    // Same revoke order as main: stop output frames, then close the owner's sessions.
    const boundary = new production.WindowBoundary(contents.getURL().split("#")[0],
      { name: "ssterm", version: app.getVersion(), platform: process.platform }, () => ({ status: "ready", schemaVersion: 1 }),
      (revoked: unknown) => { owned.fixture?.controller.revokeOwner(revoked); owned.fixture?.revokeOwner(revoked); });
    boundary.register(contents, window.id, true, () => {});
    for (let generation = 1; generation < parameters.owner.generation; generation += 1) boundary.rotate(contents);
    const checked = boundary.bootstrap({ sender: contents, senderFrame: contents.mainFrame }, []);
    if (!checked.ok || JSON.stringify(checked.value.owner) !== JSON.stringify(parameters.owner)) throw new Error("Lifecycle fixture owner mismatch");
    if (parameters.crash) {
      // main's own listener (index.ts) must be wired; the fixture's below only mirrors it for its owner. Electron
      // adds an internal listener to every webContents, so main's is told apart by its (unminified) body.
      // Checked before the fixture starts, so a failure leaves no lab or Keychain namespace behind.
      const wired = contents.listeners("render-process-gone").filter((listener) => String(listener).includes(".rotate(contents)"));
      if (wired.length !== 1) throw new Error("Production render-process-gone listener missing");
    }
    const { startTerminalFixture } = require(parameters.fixturePath);
    const fixture = await startTerminalFixture(production, {
      owner: parameters.owner, label: parameters.label, secondLabel: parameters.secondLabel, promptLabel: parameters.promptLabel,
      tempDirectory: app.getPath("temp"), send, keepalive: { intervalMs: 1000, countMax: 2 }, limits: parameters.limits,
      autoTrust: parameters.autoTrust, power: parameters.power ? powerMonitor : undefined, lab: parameters.lab,
    });
    owned.fixture = fixture;
    for (const channel of production.terminalChannels) ipcMain.removeHandler(channel);
    owned.disposers.push(production.registerTerminalHandlers({ ipc: ipcMain, boundary, controller: () => fixture.controller }));
    if (parameters.prompts) {
      const credentials = production.createCredentialsController({ registry: fixture.registry });
      const trusts = production.createKnownHostsController({ registry: fixture.registry, policy: fixture.policy });
      credentials.register(parameters.owner, (state: unknown) => send(production.channels.credentialStateChanged, state));
      trusts.register(parameters.owner, (state: unknown) => send(production.channels.trustStateChanged, state));
      for (const name of ["credentialState", "answerCredentials", "cancelCredentialPrompt", "trustState", "answerHostTrust",
        "prepareKnownHostRevoke", "revokeKnownHost"]) ipcMain.removeHandler(production.channels[name]);
      owned.disposers.push(
        production.registerCredentialHandlers({ ipc: ipcMain, boundary, controller: () => credentials }),
        production.registerKnownHostHandlers({ ipc: ipcMain, boundary, controller: () => trusts }),
        () => credentials.dispose(), () => trusts.dispose());
    }
    if (parameters.crash) {
      const gone = () => boundary.rotate(contents);
      contents.on("render-process-gone", gone);
      owned.disposers.push(() => contents.removeListener("render-process-gone", gone));
    }
    (globalThis as any).__sstermLifecycle = owned;
  }, { owner, label, secondLabel, promptLabel, fixturePath: resolve("tests/fixtures/terminal/ssh.cjs"),
    limits: options.limits, autoTrust: options.autoTrust, prompts: options.prompts ?? false, power: options.power ?? false,
    lab: options.lab, crash: options.crash ?? false });

  const operate = <T = Status>(method: string): Promise<T> => app.evaluate(async (_electron, method) => {
    // Touch fixture state only from a fresh macrotask.
    await new Promise<void>((done) => setImmediate(done));
    return (globalThis as any).__sstermLifecycle.fixture[method]();
  }, method);
  // By attribute: a pane in a background tab is hidden (and inert) until its tab is shown.
  const pane = (name = label) => page.locator(`section[aria-label="Terminal for ${name}"]`);
  const screen = (target: Locator) => target.locator(".xterm-rows");
  const button = (target: Locator, name: string) => target.getByRole("button", { name, exact: true });
  const click = async (target: Locator, name: string) => {
    await showPane(page, target);
    await button(target, name).click();
  };
  // Markers are computed remotely, so the echoed command line never satisfies its own assertion.
  const run = async (target: Locator, command: string) => {
    await showPane(page, target);
    await target.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
  };
  const ready = async (target: Locator, generation: number) => {
    await expect(target).toHaveAttribute("data-generation", String(generation));
    await expect(target).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect.poll(() => newPrompt(screen(target)), { message: `generation ${generation} rendered a prompt` }).toBe(true);
  };
  const outcome = async (target: Locator, text: string, timeout?: number) => {
    await showPane(page, target);
    await expect(target.getByText(text, { exact: true }), text).toBeVisible({ timeout });
  };
  const settled = (expected: string, read: () => Promise<Status> = () => operate("status")) => expect.poll(async () => {
    const status = await read();
    return status && `${status.state}/${status.cleanup === "pending" ? "cleaning" : status.error ?? "-"}`;
  }, { timeout: 20_000 }).toBe(expected);
  const target = async (generation?: number) => {
    const status = (await operate("status"))!;
    return { owner, sessionId: status.id, generation: generation ?? status.generation };
  };
  const command = (method: "closeTerminal" | "reconnectTerminal", request: Awaited<ReturnType<typeof target>>) =>
    page.evaluate(async ({ method, request }) => {
      const result = await window.ssterm[method](request);
      return result.ok ? "ok" : result.error.code;
    }, { method, request });
  let cleaned = false;
  const finish = async () => {
    const receipt = await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      const owned = (globalThis as any).__sstermLifecycle;
      for (const dispose of owned.disposers.splice(0)) dispose();
      return owned.fixture.cleanup();
    });
    cleaned = true;
    return receipt;
  };
  const diagnose = async (testInfo: TestInfo) => {
    if (cleaned) return;
    const diagnostics = await app.evaluate(async () => {
      await new Promise<void>((done) => setImmediate(done));
      const owned = (globalThis as any).__sstermLifecycle;
      const sessions = owned?.fixture.sessions();
      await owned?.fixture.unpause().catch(() => undefined);
      for (const dispose of owned?.disposers.splice(0) ?? []) dispose();
      const receipt = await owned?.fixture.cleanup().catch((error: Error) => error.message);
      return { sessions, receipt };
    }).catch(() => ({ sessions: "unavailable" }));
    await testInfo.attach("lifecycle-failure-state", { body: JSON.stringify(diagnostics), contentType: "application/json" });
  };
  return { owner, operate, pane, screen, button, click, run, ready, outcome, settled, target, command, finish, diagnose };
}

/** A prompt after the last Reconnected marker, so an earlier generation's prompt never satisfies it. */
async function newPrompt(screen: Locator) {
  const text = (await screen.textContent()) ?? "";
  return text.slice(text.lastIndexOf("── Reconnected ──") + 1).includes("fixture@");
}
const size = async (target: Locator) => `${await target.getAttribute("data-rows")} ${await target.getAttribute("data-columns")}`;
const elapsed = (since: number) => Math.round(performance.now() - since);

test("a silent drop is reported and Reconnect resumes the same pane; timeout and refused attempts say why", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const h = await start(desktop, { limits: { connectMs: 3000 } });
  const pane = h.pane();
  const screen = h.screen(pane);
  const reconnect = h.button(pane, "Reconnect");
  const evidence: Record<string, unknown> = {};
  try {
    await h.operate("connect");
    await h.ready(pane, 1);
    // A remount would drop these marks: the reconnected pane must be the same element and xterm.
    await pane.evaluate((element) => {
      element.dataset.e2eSame = "pane";
      (element.querySelector(".xterm") as HTMLElement).dataset.e2eSame = "xterm";
    });
    await h.run(pane, 'rm -f ~/lifecycle-replay; echo once >> ~/lifecycle-replay; echo "BEFORE-$((20+1))"');
    await expect(screen).toContainText("BEFORE-21");

    // 1. Silent drop: the frozen peer is detected by keepalive, not by a socket error.
    await h.operate("pause");
    let since = performance.now();
    await h.outcome(pane, "Connection lost", 10_000);
    evidence.lossMs = elapsed(since);
    expect(evidence.lossMs as number, "keepalive 1 s × 2 reports the loss promptly").toBeLessThan(8_000);
    expect((await h.operate("status"))!.error).toBe("timeout");
    await h.operate("unpause");
    // Clicked as soon as the loss shows: Reconnect waits out the failed generation's teardown.
    await reconnect.click();
    await h.ready(pane, 2);
    await expect(pane).toHaveAttribute("data-e2e-same", "pane");
    await expect(pane.locator(".xterm")).toHaveAttribute("data-e2e-same", "xterm");
    await expect(screen, "earlier output stays in the pane").toContainText("BEFORE-21");
    await expect(screen).toContainText("── Reconnected ──");
    await expect(pane.locator(".xterm-helper-textarea"), "focus returns to the terminal").toBeFocused();
    const grid = await size(pane);
    await h.run(pane, 'echo "SIZE=$(stty size)"');
    await expect(screen, "the new PTY matches the current grid").toContainText(`SIZE=${grid}`);
    await h.run(pane, 'echo "LINES=$(wc -l < ~/lifecycle-replay)"');
    await expect(screen, "reconnect never replays earlier input").toContainText("LINES=1");

    // 2. Connect timeout: the attempt itself stalls on the frozen server.
    await h.operate("pause");
    await h.outcome(pane, "Connection lost", 10_000);
    await reconnect.click();
    await expect(pane).toHaveAttribute("data-generation", "3");
    since = performance.now();
    await h.outcome(pane, "Couldn't connect: the server did not respond in time", 10_000);
    evidence.connectTimeoutMs = elapsed(since);
    await h.settled("Failed/timeout");
    await h.operate("unpause");
    await reconnect.click();
    await h.ready(pane, 4);

    // 3. Refused: the server is gone, so the open session is lost and a new attempt cannot connect.
    await h.operate("stop");
    await h.outcome(pane, "Connection lost");
    expect((await h.operate("status"))!.error).toBe("network");
    await reconnect.click();
    await expect(pane).toHaveAttribute("data-generation", "5");
    await h.outcome(pane, "Couldn't connect: the server could not be reached");
    await h.settled("Failed/network");

    expect(desktop.errors).toEqual([]);
    await testInfo.attach("lifecycle-drop-evidence", { body: JSON.stringify({ ...evidence, grid }), contentType: "application/json" });
    expect(await h.finish()).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
  } finally { await h.diagnose(testInfo); }
});

test("cancel ends an attempt in every connecting phase without trusting or prompting further", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { page } = desktop;
  const h = await start(desktop, { autoTrust: false, prompts: true });
  const pane = h.pane();
  const prompted = h.pane(promptLabel);
  const trust = page.getByTestId("host-trust-dialog");
  const credentials = page.getByTestId("credential-prompt-dialog");
  try {
    // Connecting: the server is frozen, so the attempt cannot progress.
    await h.operate("pause");
    await h.operate("connect");
    await expect(pane).toHaveAttribute("data-phase", "connecting");
    await expect.poll(async () => (await h.operate("status"))!.state).toBe("Connecting");
    await h.click(pane, "Cancel");
    await h.outcome(pane, "Session closed");
    await h.settled("Closed/-");
    await h.operate("unpause");

    // VerifyingHost: the trust dialog is modal, so Cancel is the same pane command sent through the bridge.
    await h.click(pane, "Reconnect");
    await expect(trust).toBeVisible();
    await expect.poll(async () => (await h.operate("status"))!.state).toBe("VerifyingHost");
    expect(await h.command("closeTerminal", await h.target())).toBe("ok");
    await expect(trust).toHaveCount(0);
    await h.outcome(pane, "Session closed");
    await h.settled("Closed/-");
    expect(await h.operate<number>("knownHosts"), "a cancelled verification writes no known host").toBe(0);

    // AwaitingInput: closing the pane's session ends it as Closed.
    await h.operate("connectPrompt");
    await expect(trust).toBeVisible();
    await trust.getByRole("button", { name: "Remember", exact: true }).click();
    await expect(credentials).toBeVisible();
    await expect.poll(async () => (await h.operate("status"))!.state).toBe("AwaitingInput");
    expect(await h.operate<number>("knownHosts")).toBe(1);
    expect(await h.command("closeTerminal", await h.target())).toBe("ok");
    await expect(credentials).toHaveCount(0);
    await h.outcome(prompted, "Session closed");
    await h.settled("Closed/-");

    // ...whereas the dialog's own Cancel fails the attempt as a cancelled prompt.
    await h.click(prompted, "Reconnect");
    await expect(credentials).toBeVisible();
    await credentials.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(credentials).toHaveCount(0);
    await h.outcome(prompted, "Couldn't connect: authentication was cancelled");
    await h.settled("Failed/prompt-cancelled");

    expect(desktop.errors).toEqual([]);
    expect(await h.finish()).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
  } finally { await h.diagnose(testInfo); }
});

test("lifecycle commands are generation fenced, sessions are independent and a lock closes all until Reconnect", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { app } = desktop;
  const h = await start(desktop, { power: true });
  const first = h.pane();
  const second = h.pane(secondLabel);
  try {
    await h.operate("connect");
    await h.ready(first, 1);
    await h.click(first, "Disconnect");
    await h.outcome(first, "Session closed");
    await h.settled("Closed/-");

    // Two Reconnects for the same generation start exactly one new generation.
    const ended = await h.target();
    const results = await desktop.page.evaluate(async (request) => (await Promise.all([
      window.ssterm.reconnectTerminal(request), window.ssterm.reconnectTerminal(request),
    ])).map((result) => (result.ok ? "ok" : result.error.code)), ended);
    expect(results.sort()).toEqual(["conflict", "ok"]);
    await h.ready(first, 2);
    // A close carrying the old generation never reaches the new one.
    expect(await h.command("closeTerminal", ended)).toBe("conflict");
    await expect(first).toHaveAttribute("data-phase", "ready");
    expect((await h.operate("status"))!.state).toBe("Ready");

    // Independence: one session's end or disconnect leaves the other working.
    await h.operate("connectSecond");
    await h.ready(second, 1);
    await h.run(first, "kill -KILL $$");
    await h.outcome(first, "Remote process was terminated by SIGKILL");
    await h.run(second, 'echo "SECOND-$((3+4))"');
    await expect(h.screen(second)).toContainText("SECOND-7");
    await h.click(first, "Reconnect");
    await h.ready(first, 3);
    await h.click(second, "Disconnect");
    await h.outcome(second, "Session closed");
    await h.run(first, 'echo "FIRST-$((4+5))"');
    await expect(h.screen(first)).toContainText("FIRST-9");

    // Lock: every live pane closes; Reconnect is the explicit unlock.
    await h.click(second, "Reconnect");
    await h.ready(second, 2);
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await h.outcome(first, locked);
    await h.outcome(second, locked);
    await h.settled("Closed/locked");
    await h.click(first, "Reconnect");
    await h.ready(first, 4);
    await h.click(second, "Reconnect");
    await h.ready(second, 3);
    await h.run(second, 'echo "UNLOCKED-$((5+6))"');
    await expect(h.screen(second)).toContainText("UNLOCKED-11");

    expect(desktop.errors).toEqual([]);
    expect(await h.finish()).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
  } finally { await h.diagnose(testInfo); }
});

test("repeated connect, disconnect and close pane leaves no record, socket or server shell", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  const h = await start(desktop);
  const pane = h.pane();
  const rounds = 20;
  const sockets = () => app.evaluate(() => process.getActiveResourcesInfo().filter((name) => name === "TCPSocketWrap").length);
  try {
    const baseline = await sockets();
    for (let round = 1; round <= rounds; round += 1) {
      await h.operate("connect");
      await h.ready(pane, 1);
      if (round === 1) expect(await sockets(), "a live session holds a counted socket").toBeGreaterThan(baseline);
      await h.click(pane, "Disconnect");
      await h.outcome(pane, "Session closed");
      // Close pane right away: dismiss waits for the closing generation's teardown.
      await h.click(pane, "Close pane");
      await expect(page.locator(".live-terminal-pane"), `round ${round} leaves no pane`).toHaveCount(0);
    }
    expect(await h.operate<unknown[]>("sessions"), "the registry forgot every record").toEqual([]);
    await expect.poll(sockets, { message: "main holds no SSH socket", timeout: 10_000 }).toBeLessThanOrEqual(baseline);
    await expect.poll(() => h.operate<number>("shells"), { message: "the server reaped every shell", timeout: 10_000 }).toBe(0);
    await testInfo.attach("lifecycle-leak-evidence", { body: JSON.stringify({ rounds, baseline, after: await sockets() }), contentType: "application/json" });
    expect(desktop.errors).toEqual([]);
    expect(await h.finish()).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
  } finally { await h.diagnose(testInfo); }
});

test("quitting with live sessions exits promptly and the server reaps every shell", async ({}, testInfo) => {
  test.setTimeout(180_000);
  // The runner owns this container so it survives the app and can be inspected after exit.
  const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
  const lab = await startFixture();
  const shells = async () => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", "sshd: fixture@"])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw new Error("Shell count unavailable"); }
  };
  const receiptPath = testInfo.outputPath("quit-receipt.json");
  // Launched here, not by the shared fixture, because this test ends the app itself.
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  env.SSTERM_TEST_USER_DATA = profile;
  const packaged = process.env.SSTERM_PACKAGED_EXECUTABLE;
  if (packaged) env.ELECTRON_RENDERER_URL = "http://127.0.0.1:9/";
  let app: ElectronApplication | undefined;
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  // Read from the child, never from `app`: Playwright disposes the application object once it exits.
  const alive = () => !!child && child.exitCode === null && child.signalCode === null;
  try {
    app = await _electron.launch({ executablePath: packaged, args: packaged ? [] : [resolve("apps/desktop")], env,
      chromiumSandbox: true, timeout: 25_000 });
    child = app.process();
    exited = new Promise<void>((done) => child!.once("exit", () => done()));
    await app.context().setOffline(true);
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.waitForLoadState("domcontentloaded");
    const h = await start({ app, page, errors }, { lab: { host: lab.host, port: lab.port, username: lab.username, password: lab.password, container: lab.container } });
    // The owned registry joins quit like main's own: its shutdown runs inside before-quit, and the
    // receipt (Keychain namespace emptied) is written before the process may exit.
    await app.evaluate(async ({ app }, receiptPath) => {
      const fs = process.getBuiltinModule("node:fs");
      const path = process.getBuiltinModule("node:path");
      const owned = (globalThis as any).__sstermLifecycle;
      let started = false, finished = false;
      app.on("before-quit", (event) => {
        if (finished) return;
        event.preventDefault();
        if (started) return;
        started = true;
        for (const dispose of owned.disposers.splice(0)) dispose();
        void owned.fixture.cleanup().then((receipt: unknown) => receipt, (error: Error) => ({ error: error.message })).then((receipt: unknown) => {
          fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
          fs.writeFileSync(receiptPath, JSON.stringify(receipt));
          finished = true;
          app.quit();
        });
      });
    }, receiptPath);
    await h.operate("connect");
    await h.ready(h.pane(), 1);
    await h.operate("connectSecond");
    await h.ready(h.pane(secondLabel), 1);
    expect(await shells()).toBe(2);
    expect(errors).toEqual([]);
    const since = performance.now();
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await exited;
    const exitMs = elapsed(since);
    expect(exitMs, "the app exits promptly with live sessions").toBeLessThan(5_000);
    await expect.poll(shells, { message: "quit reaps every server shell", timeout: 10_000 }).toBe(0);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
    await testInfo.attach("lifecycle-quit-evidence", { body: JSON.stringify({ exitMs }), contentType: "application/json" });
  } finally {
    if (alive()) {
      await Promise.race([app!.close().catch(() => undefined), exited, new Promise((done) => setTimeout(done, 10_000))]);
      if (alive()) child!.kill("SIGKILL");
    }
    await rm(profile, { recursive: true, force: true });
    lab.privateKey.fill(0);
    await lab.dispose();
    await lab.assertCleaned();
  }
});

test("a crashed renderer closes its owner's sessions", async ({ desktop }, testInfo) => {
  test.setTimeout(180_000);
  const { app, page } = desktop;
  const h = await start(desktop, { crash: true });
  try {
    await h.operate("connect");
    await h.ready(h.pane(), 1);
    await h.operate("connectSecond");
    await h.ready(h.pane(secondLabel), 1);
    expect(await h.operate<number>("shells")).toBe(2);
    const crashed = page.waitForEvent("crash");
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); });
    await crashed;
    await expect.poll(() => h.operate<unknown[]>("sessions"), { message: "the revoked owner's records are closed and forgotten" }).toEqual([]);
    await expect.poll(() => h.operate<number>("shells"), { message: "the server reaped every shell", timeout: 10_000 }).toBe(0);
    expect(await h.finish()).toEqual({ fixtureCleaned: true, leftoverItems: 0 });
  } finally { await h.diagnose(testInfo); }
});
