import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Locator } from "@playwright/test";
import { test, expect, changeCatalog, emptyTestNamespace, type Desktop } from "./fixtures";
import { expectDrawerPlaced } from "./support/drawer";

// The lab password is typed from main and saved in the test Keychain namespace; keep automatic artifacts off.
// The visual test attaches explicit screenshots that show only terminals, labels and empty inputs.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
interface Lab {
  host: string; port: number; username: string; password: string; directory: string; container: string; privateKey: Buffer;
  dispose(): Promise<void>; assertCleaned(): Promise<void>;
}
interface Server { label: string; environment?: "PROD"; /** Points at a refused loopback port, so it fails. */ closed?: boolean }
interface Prompt { sheet: boolean; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }

const alpha = "ฐานข้อมูล อัลฟา";
const bravo = "แอปพลิเคชัน บราโว";
const charlie = "คิวงาน ชาร์ลี";
const CLOSED_PORT = 1;

async function keychainCount(service: string): Promise<number> {
  const { stdout } = await runFile("security", ["dump-keychain"], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").filter((line) => line.includes(`"svce"<blob>="${service}"`)).length;
}
async function fixtureContainers(): Promise<number> {
  const { stdout } = await runFile("docker", ["ps", "-aq", "--filter", "label=dev.ssterm.spike.fixture"]);
  return stdout.trim() ? stdout.trim().split("\n").length : 0;
}

/**
 * A runner-owned lab, an identity whose password is saved through the editor (main types it, so it never
 * crosses Playwright) and saved servers using it. Sessions open through the production Connect path.
 */
async function workspace(desktop: Desktop, servers: Server[]) {
  const { app, page } = desktop;
  const lab: Lab = await startFixture();
  const shells = async () => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", "sshd: fixture@"])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw new Error("Shell count unavailable"); }
  };
  const finish = async () => {
    try {
      await desktop.close();
      expect(await shells(), "no server shell outlives the app").toBe(0);
    } finally {
      lab.privateKey.fill(0);
      await lab.dispose();
      await lab.assertCleaned();
    }
    expect(await keychainCount(desktop.secretNamespace), "teardown emptied the namespace").toBe(0);
    expect(await fixtureContainers(), "no fixture containers remain").toBe(0);
  };
  try {
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    await page.getByRole("button", { name: "Identities", exact: true }).click();
    const identities = page.getByTestId("identities-page");
    await identities.getByRole("tab", { name: "Identities" }).click();
    await identities.getByRole("button", { name: "New identity" }).first().click();
    const editor = page.getByTestId("identity-editor");
    await editor.getByLabel("Name", { exact: true }).fill("Lab workspace");
    await editor.getByLabel("User name", { exact: true }).fill(lab.username);
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }, file) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
        const inputs = [...document.querySelectorAll('[data-testid="identity-editor"] input[type="password"]')];
        if (inputs.length !== 1 || inputs[0].disabled) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], ${JSON.stringify(value)});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true; })()`);
    }, secret), { message: "main typed the lab password" }).toBe(true);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    const row = identities.locator("tr[data-identity-id]", { hasText: "Lab workspace" });
    await expect(row).toContainText("Saved in Keychain");
    const identityId = await row.getAttribute("data-identity-id");
    await changeCatalog(app, servers.map(({ label, environment, closed }) => ({
      type: "create-host",
      data: {
        label, address: lab.host, environment: environment ?? null,
        port: { mode: "value", port: closed ? CLOSED_PORT : lab.port },
        auth: { mode: "value", identityId },
      },
    })));
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(servers[0]!.label);
  } catch (error) {
    await finish().catch(() => undefined);
    throw error;
  }

  const prompts = join(lab.directory, "prompts.jsonl");
  const ids = () => page.locator("section[data-session-id]").evaluateAll((all) => all.map((pane) => pane.getAttribute("data-session-id")!));
  /** The pane of the one session that was not in `before`. */
  const opened = async (before: string[]) => {
    let id = "";
    await expect.poll(async () => (id = (await ids()).find((candidate) => !before.includes(candidate)) ?? ""), { message: "a new pane" }).not.toBe("");
    return page.locator(`section[data-session-id="${id}"]`);
  };
  const owner = async () => {
    const boot = await page.evaluate(() => window.ssterm.bootstrap());
    if (!boot.ok) throw new Error("bootstrap failed");
    return boot.value.owner;
  };
  const screen = (pane: Locator) => pane.locator(".xterm-rows");
  const w = {
    lab, shells, finish, screen, opened, ids,
    tabs: page.getByRole("tablist", { name: "Terminal tabs" }).getByRole("tab"),
    /** Connect from the Servers page (Thai labels never contain one another). */
    async connect(label: string, options: { trust?: boolean; ready?: boolean } = {}) {
      const before = await ids();
      await page.getByRole("button", { name: /^All servers/u }).click();
      await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${label}`, exact: true }).click();
      if (options.trust) await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
      const pane = await opened(before);
      if (options.ready ?? true) await w.ready(pane);
      return pane;
    },
    /** Connect through the bridge, as a session opened elsewhere: its tab is added but never shown. */
    async connectInBackground(label: string) {
      const before = await ids();
      const code = await page.evaluate(async ({ owner, label }) => {
        const state = await window.ssterm.catalogState({ owner });
        if (!state.ok) return state.error.code;
        const host = state.value.hosts.find((row) => row.label === label);
        if (!host) return "missing";
        const result = await window.ssterm.connectHost({ owner, hostId: host.id });
        return result.ok ? "ok" : result.error.code;
      }, { owner: await owner(), label });
      expect(code).toBe("ok");
      return opened(before);
    },
    async ready(pane: Locator) {
      await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
      await expect(screen(pane)).toContainText("fixture@", { timeout: 20_000 });
    },
    async run(pane: Locator, command: string) {
      await pane.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type(command);
      await page.keyboard.press("Enter");
    },
    size: async (pane: Locator) => `${await pane.getAttribute("data-rows")}x${await pane.getAttribute("data-columns")}`,
    /** The remote PTY size (computed remotely) equals the pane's rows×columns. */
    async geometry(pane: Locator, tag: string) {
      // A refit can take more than one frame: read the size once it held for 300 ms.
      let size = "";
      await expect.poll(async () => size === (size = await w.size(pane)), { intervals: [300] }).toBe(true);
      await w.run(pane, `echo "${tag}-$(stty size | tr ' ' x)"`);
      await expect(screen(pane)).toContainText(`${tag}-${size}`);
      return size;
    },
    /** Searches the pane's history and expects `count` matches; Esc returns to the terminal. */
    async search(pane: Locator, query: string, count: number) {
      await pane.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Meta+f");
      const box = pane.getByRole("searchbox");
      await expect(box).toBeFocused();
      await box.fill(query);
      await expect(pane.getByRole("search"), `matches for ${query}`).toHaveAttribute("data-search-count", String(count));
      await page.keyboard.press("Escape");
      await expect(pane.getByRole("search")).toHaveCount(0);
    },
    async menu(pane: Locator, item: string) {
      await pane.getByRole("button", { name: "Pane actions", exact: true }).click();
      await page.getByRole("menuitem", { name: item }).click();
    },
    /**
     * Main's close/quit sheets answer `response` (0 Cancel, 1 confirm) and record each call; `null` keeps
     * each sheet open until `release`.
     */
    answer(response: 0 | 1 | null) {
      return app.evaluate(({ dialog }, { file, response }) => {
        const fs = process.getBuiltinModule("node:fs");
        const held = globalThis as { releaseSheet?: (response: number) => void };
        dialog.showMessageBox = (async (...args: unknown[]) => {
          const options = args.at(-1) as Electron.MessageBoxOptions;
          fs.appendFileSync(file, JSON.stringify({ sheet: args.length === 2, message: options.message, detail: options.detail,
            buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId }) + "\n");
          const answer = response ?? await new Promise<number>((done) => { held.releaseSheet = done; });
          return { response: answer, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
      }, { file: prompts, response });
    },
    release: (response: 0 | 1) => app.evaluate((_, response) => {
      (globalThis as { releaseSheet?: (response: number) => void }).releaseSheet?.(response);
    }, response),
    prompts: async (): Promise<Prompt[]> =>
      (await readFile(prompts, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    windows: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  };
  return w;
}

const endpoint = (lab: Lab) => `${lab.username}@${lab.host}:${lab.port}`;

test("tabs and splits: split opens a session, merge/focus/move never reconnect, shortcuts never reach a shell, separators resize", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const { page } = desktop;
  const w = await workspace(desktop, [{ label: alpha, environment: "PROD" }, { label: bravo }, { label: charlie }]);
  try {
    // Three Connects give three tabs; only the active tab's pane is shown.
    const a = await w.connect(alpha, { trust: true });
    const b = await w.connect(bravo);
    const c = await w.connect(charlie);
    await expect(w.tabs).toHaveCount(3);
    await expect(w.tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(w.tabs.nth(0).getByText("PROD", { exact: true })).toBeVisible();
    await expect(c).toBeVisible();
    await expect(a).toBeHidden();
    await expect(b).toBeHidden();
    expect(await w.shells()).toBe(3);

    // Cmd+1 shows the first tab; Cmd+D opens a new session to the same server beside it, in the same tab.
    await page.keyboard.press("Meta+1");
    await expect(w.tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(a.locator(".xterm-helper-textarea")).toBeFocused();
    const before = await w.ids();
    await page.keyboard.press("Meta+d");
    const a2 = await w.opened(before);
    await w.ready(a2);
    await expect(a2).toHaveAttribute("aria-label", `Terminal for ${alpha}`);
    await expect(a2.locator(".pane-header").getByText("PROD", { exact: true })).toBeVisible();
    await expect(w.tabs).toHaveCount(3);
    await expect(w.tabs.nth(0)).toContainText("+1 pane");
    await expect(a2.locator(".xterm-helper-textarea"), "the new pane is focused once Ready").toBeFocused();
    expect((await a.boundingBox())!.x).toBeLessThan((await a2.boundingBox())!.x);
    expect(await w.shells()).toBe(4);

    // Merge another tab's session into this split from the pane menu.
    const generation = (await b.getAttribute("data-generation"))!;
    await w.menu(a, "Add to this split");
    await page.getByRole("menuitem", { name: bravo }).click();
    await expect(w.tabs).toHaveCount(2);
    await expect(w.tabs.nth(0)).toContainText("+2 panes");
    for (const pane of [a, a2, b]) await expect(pane).toBeVisible();

    // A remote loop keeps printing while the pane goes to Focus, back to Split and to a new tab.
    await w.run(b, `for i in $(seq 1 300); do printf 'TICK-%03d\\x21\\n' $i; sleep 0.05; done; echo "DONE-$((1+1))"`);
    await expect(w.screen(b)).toContainText("TICK-001!");
    const split = await w.size(b);
    await page.keyboard.press("Meta+Shift+Enter");
    await expect(page.getByRole("group", { name: "Focused pane" })).toBeVisible();
    await expect(a).toBeHidden();
    await expect(a2).toBeHidden();
    await expect.poll(() => w.size(b), { message: "the focused pane fills the tab" }).not.toBe(split);
    await expect(b.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Meta+Shift+Enter");
    await expect(page.getByRole("group", { name: "Focused pane" })).toHaveCount(0);
    await expect(a).toBeVisible();
    await expect.poll(() => w.size(b)).toBe(split);
    await w.menu(b, "Move to new tab");
    await expect(w.tabs).toHaveCount(3);
    await expect(w.tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await expect(w.tabs.nth(0)).toContainText("+1 pane");
    await expect(a).toBeHidden();
    expect(await w.screen(b).textContent(), "the loop was still running after the moves").not.toContain("DONE-2");
    await expect(w.screen(b)).toContainText("DONE-2", { timeout: 40_000 });
    await expect(b, "no reconnect").toHaveAttribute("data-generation", generation);
    await expect(b).toHaveAttribute("data-phase", "ready");
    await expect(b.locator(".live-terminal-notice"), "no stream fault").toHaveCount(0);
    expect(await w.shells()).toBe(4);
    await w.search(b, "!", 300);
    await w.search(b, "TICK-001!", 1);
    const moved = await w.geometry(b, "MOVED");
    expect(moved).not.toBe(split);

    // Shortcuts move focus and tabs while every shell is reading: none of them receives a keystroke.
    await page.keyboard.press("Meta+3");
    await expect(w.tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await w.run(b, 'read -t 15 x; echo "B[$x]"');
    await page.keyboard.press("Meta+2");
    await expect(c).toBeVisible();
    await w.run(c, 'read -t 15 x; echo "C[$x]"');
    await page.keyboard.press("Meta+1");
    await w.run(a, 'read -t 15 x; echo "L[$x]"');
    await page.keyboard.press("Meta+Alt+ArrowRight");
    await expect(a2.locator(".xterm-helper-textarea")).toBeFocused();
    await expect(a2).toHaveAttribute("data-active", "true");
    await page.keyboard.type('read -t 15 x; echo "R[$x]"');
    await page.keyboard.press("Enter");
    await page.keyboard.press("Meta+Alt+ArrowLeft");
    await expect(a.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Meta+Alt+ArrowRight");
    await expect(a2.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.press("Meta+2");
    await expect(w.tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+Shift+BracketRight");
    await expect(w.tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+Shift+BracketRight");
    await expect(w.tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+Shift+BracketLeft");
    await expect(w.tabs.nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+1");
    await expect(w.tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    for (const [pane, mark] of [[a, "L"], [a2, "R"], [b, "B"], [c, "C"]] as const)
      await expect(w.screen(pane), `${mark}: no shortcut reached the shell`).toContainText(`${mark}[]`, { timeout: 25_000 });

    // The separator moves by keyboard; the left pane gains columns and the PTY follows.
    const separator = page.getByRole("separator", { name: "Resize panes left and right" });
    await expect(separator).toHaveAttribute("aria-valuenow", "50");
    const columns = Number(await a.getAttribute("data-columns"));
    await separator.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "60");
    await expect.poll(async () => Number(await a.getAttribute("data-columns"))).toBeGreaterThan(columns);
    const wider = await w.geometry(a, "WIDER");
    await testInfo.attach("workspace-evidence", {
      body: JSON.stringify({ split, moved, wider, columnsBefore: columns, generation, shells: await w.shells(), platform: process.platform }),
      contentType: "application/json",
    });
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
  } finally {
    await w.finish();
  }
});

// SST-040/02: a catalog drawer opened over a live terminal keeps every key, including Esc, Cancel and the discard step.
test("drawer over a terminal: Esc, the discard step and Cancel never reach the shell behind it", async ({ desktop }) => {
  test.setTimeout(180_000);
  const { page } = desktop;
  const w = await workspace(desktop, [{ label: alpha }]);
  try {
    const pane = await w.connect(alpha, { trust: true });
    // Raw single-byte read: the first byte the shell receives is printed as its code (Esc 27, "d" 100, our "Z" 90).
    await w.run(pane, `read -rsn1 x; printf 'D[%d]\\n' "'$x"`);
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    const editor = page.getByTestId("server-editor");
    const name = editor.getByLabel("Name", { exact: true });
    const open = async () => {
      await page.getByRole("button", { name: "Add server or group" }).click();
      await page.getByRole("menuitem", { name: "New server" }).click();
      await expect(name).toBeFocused();
      await expect(pane, "the terminal stays visible beside the drawer").toBeVisible();
    };
    await open();
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await open();
    await page.keyboard.type("draft");
    await page.keyboard.press("Escape");
    await expect(editor.getByRole("alert", { name: "Discard unsaved changes?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(name).toHaveValue("draft");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("Z");
    await expect(w.screen(pane), "the first byte the shell read is the Z typed after the drawer closed").toContainText("D[90]", { timeout: 20_000 });
    expect(desktop.errors).toEqual([]);
  } finally {
    await w.finish();
  }
});

test("closing: Cmd+W asks only for a Ready pane; closing the window and quitting ask with a native sheet", async ({ desktop }) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  const w = await workspace(desktop, [{ label: alpha, environment: "PROD" }, { label: bravo }]);
  try {
    const a = await w.connect(alpha, { trust: true });
    const b = await w.connect(bravo);
    expect(await w.shells()).toBe(2);

    // Clicking a tab goes on typing in its pane, and Backspace there edits the line instead of closing the tab.
    await w.tabs.nth(0).click();
    await expect(a.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.type('echo "CLICKED-$((4+4))"x');
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect(w.screen(a)).toContainText("CLICKED-8");
    await expect(w.tabs).toHaveCount(2);
    await expect(page.getByTestId("close-confirm-dialog")).toHaveCount(0);

    // Copy target hands the endpoint to the copy event; the page keeps it from the system clipboard.
    await page.evaluate(() => {
      getSelection()?.removeAllRanges();
      addEventListener("copy", (event) => {
        const data = new DataTransfer();
        Object.defineProperty(event, "clipboardData", { value: data });
        // Not cancelled, so nothing is written; with no selection the default copy writes nothing either.
        event.preventDefault = () => {};
        setTimeout(() => { (window as { copied?: string }).copied = data.getData("text/plain"); });
      }, { capture: true, once: true });
    });
    await a.getByRole("button", { name: "Copy target", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as { copied?: string }).copied)).toBe(endpoint(w.lab));
    await expect(a.getByTestId("terminal-feedback")).toHaveText(`Copied ${endpoint(w.lab)}`);

    await page.keyboard.press("Meta+1");
    await expect(a.locator(".xterm-helper-textarea")).toBeFocused();

    // Cancel keeps the session; Cancel has focus so Enter cannot disconnect by accident.
    const confirm = page.getByTestId("close-confirm-dialog");
    await page.keyboard.press("Meta+w");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(`Disconnect and close ${alpha}?`);
    await expect(confirm.getByText("PROD", { exact: true })).toBeVisible();
    await expectDrawerPlaced(page, "close-confirm");
    await expect(confirm).toContainText(endpoint(w.lab));
    await expect(confirm.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(a).toHaveAttribute("data-phase", "ready");
    await w.run(a, 'echo "KEPT-$((2+3))"');
    await expect(w.screen(a)).toContainText("KEPT-5");
    expect(await w.shells()).toBe(2);

    // Confirm disconnects and closes the pane; the server shell goes.
    await page.keyboard.press("Meta+w");
    await confirm.getByRole("button", { name: "Disconnect and close", exact: true }).click();
    await expect(a).toHaveCount(0);
    await expect.poll(w.shells, { message: "the closed pane's shell was reaped" }).toBe(1);
    await expect(w.tabs).toHaveCount(1);
    await expect(b).toBeVisible();

    // Disconnect is explicit: it ends the session and removes the pane without asking.
    await b.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(b).toHaveCount(0);
    await expect(confirm).toHaveCount(0);
    await expect.poll(w.shells).toBe(0);
    expect(await w.windows()).toBe(1);

    // Window close and quit with a Ready session ask with a sheet; Cancel keeps everything running.
    const live = await w.connect(alpha);
    await w.answer(0);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await expect.poll(async () => (await w.prompts()).length).toBe(1);
    const detail = `PROD · ${alpha} — ${endpoint(w.lab)}`;
    expect((await w.prompts())[0]).toEqual({ sheet: true, message: "Close this window and disconnect 1 connected session?",
      detail, buttons: ["Cancel", "Close Window"], defaultId: 0, cancelId: 0 });
    await app.evaluate(({ app }) => { app.quit(); });
    await expect.poll(async () => (await w.prompts()).length).toBe(2);
    expect((await w.prompts())[1]).toEqual({ sheet: true, message: "Quit ssterm and disconnect 1 connected session?",
      detail, buttons: ["Cancel", "Quit"], defaultId: 0, cancelId: 0 });
    expect(await w.windows()).toBe(1);
    await w.run(live, 'echo "STILL-$((3+4))"');
    await expect(w.screen(live)).toContainText("STILL-7");
    expect(await w.shells()).toBe(1);

    // Quit while the close sheet is open asks nothing more; confirming closes the window and its
    // session, and the app stays open on macOS.
    await w.answer(null);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    await expect.poll(async () => (await w.prompts()).length).toBe(3);
    // before-quit runs within quit(), and a quit sheet would be recorded before it returned.
    await app.evaluate(({ app }) => { app.quit(); });
    expect(await w.prompts()).toHaveLength(3);
    await w.release(1);
    await expect.poll(w.windows, { message: "the window closed" }).toBe(0);
    await expect.poll(w.shells, { message: "closing the window reaped the shell" }).toBe(0);
    expect((await w.prompts()).map((prompt) => prompt.message)).toEqual([
      "Close this window and disconnect 1 connected session?",
      "Quit ssterm and disconnect 1 connected session?",
      "Close this window and disconnect 1 connected session?",
    ]);
    expect(desktop.errors).toEqual([]);
  } finally {
    await w.finish();
  }
});

test("terminal settings apply live, scrollback bounds history, a never-shown tab sees its exit, and Quit asks first", async ({ desktop }) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  const w = await workspace(desktop, [{ label: alpha }, { label: bravo }]);
  try {
    const a = await w.connect(alpha, { trust: true });
    const start = await w.geometry(a, "BEFORE");

    // A larger font refits the open pane at once and the remote PTY follows.
    const settings = page.getByRole("dialog", { name: "Settings" });
    await page.keyboard.press("Meta+Comma");
    await expect(settings).toBeVisible();
    const font = settings.getByLabel("Font size");
    await expect(font).toHaveValue("13");
    await font.fill("20");
    await font.press("Enter");
    await expect.poll(() => w.size(a), { message: "the pane refit to the new font" }).not.toBe(start);
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    const larger = await w.geometry(a, "AFTER");
    expect(Number(larger.split("x")[1]), "fewer columns at 20 px").toBeLessThan(Number(start.split("x")[1]));

    // With the default scrollback an early line stays searchable; at 100 lines it is gone.
    await w.run(a, 'echo "EARLY-$((6*7))"; seq 1 400; echo "FILLED-$((2*3))"');
    await expect(w.screen(a)).toContainText("FILLED-6");
    await w.search(a, "EARLY-42", 1);
    await page.keyboard.press("Meta+Comma");
    await settings.getByLabel("Scrollback").fill("100");
    await settings.getByLabel("Scrollback").press("Enter");
    await expect(settings).toContainText("A change applies now to the open terminal, up to 100 lines (a lower value removes older lines).");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await w.run(a, 'echo "LATE-$((7*8))"; seq 1 400; echo "FLUSHED-$((3*3))"');
    await expect(w.screen(a)).toContainText("FLUSHED-9");
    await w.search(a, "LATE-56", 0);
    await w.search(a, "FLUSHED-9", 1);

    // A session opened elsewhere gets a background tab that is never shown, yet it opens and sees its exit.
    const b = await w.connectInBackground(bravo);
    await expect(w.tabs).toHaveCount(2);
    await expect(w.tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(b).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(w.screen(b), "the hidden pane opened and rendered the prompt").toContainText("fixture@", { timeout: 20_000 });
    await expect(b).toBeHidden();
    const target = { sessionId: (await b.getAttribute("data-session-id"))!, generation: Number(await b.getAttribute("data-generation")) };
    const written = await page.evaluate(async (target) => {
      const boot = await window.ssterm.bootstrap();
      if (!boot.ok) return boot.error.code;
      const result = await window.ssterm.writeTerminal({ owner: boot.value.owner, ...target, bytes: new TextEncoder().encode("exit 7\r") });
      return result.ok ? "ok" : result.error.code;
    }, target);
    expect(written).toBe("ok");
    await expect(b).toHaveAttribute("data-phase", "closed", { timeout: 10_000 });
    await expect(b).toBeHidden();
    await w.tabs.nth(1).click();
    await expect(b.getByText("Remote process exited with status 7", { exact: true })).toBeVisible();
    expect(await w.shells()).toBe(1);

    // Quit with a Ready session asks; confirming quits and the server reaps the shell.
    expect(await emptyTestNamespace(app, desktop.secretNamespace), "saved password removed before the app exits").toBe(0);
    await w.answer(1);
    const child = app.process();
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await exited;
    await expect.poll(w.shells, { message: "quit reaped the shell", timeout: 10_000 }).toBe(0);
    expect(await w.prompts()).toEqual([{ sheet: true, message: "Quit ssterm and disconnect 1 connected session?",
      detail: `${alpha} — ${endpoint(w.lab)}`, buttons: ["Cancel", "Quit"], defaultId: 0, cancelId: 0 }]);
    expect(desktop.errors).toEqual([]);
  } finally {
    await w.finish();
  }
});

test("scrollback: opening another session never trims the history of open panes", async ({ desktop }) => {
  test.setTimeout(240_000);
  const { page } = desktop;
  const w = await workspace(desktop, [{ label: alpha }, { label: bravo }, { label: charlie }]);
  try {
    const settings = page.getByRole("dialog", { name: "Settings" });
    await page.keyboard.press("Meta+Comma");
    await settings.getByLabel("Scrollback").fill("100000");
    await settings.getByLabel("Scrollback").press("Enter");
    await expect(settings).toContainText("A new terminal keeps up to 320,000 lines divided by the terminals then open");
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);

    // Three panes, each created with 100,000 lines (320,000 ÷ 3 is more), hold a marker under 90,000 lines.
    const panes: Locator[] = [];
    for (const [index, label] of [alpha, bravo, charlie].entries()) {
      const pane = await w.connect(label, { trust: index === 0 });
      await w.run(pane, 'echo "EARLY-$((5*9))"; seq 1 90000; echo "FILLED-$((2*5))"');
      panes.push(pane);
    }
    for (const pane of panes) await expect(w.screen(pane)).toContainText("FILLED-10", { timeout: 60_000 });

    // A fourth pane gets 80,000 lines; the three open panes keep 100,000, so no marker is trimmed.
    await w.connect(alpha);
    await expect(w.tabs).toHaveCount(4);
    for (const [index, pane] of panes.entries()) {
      await page.keyboard.press(`Meta+${index + 1}`);
      await expect(pane).toBeVisible();
      await w.search(pane, "EARLY-45", 1);
    }
    expect(desktop.errors).toEqual([]);
  } finally {
    await w.finish();
  }
});

test("visual: sidebar, 2- and 4-pane splits with PROD and a failed pane, ten long Thai tabs and titlebar regions at 960×640 and 1280×800", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const { app, page } = desktop;
  const prod = "ระบบจริง การชำระเงิน กรุงเทพ";
  const down = "เครื่องปิดอยู่ ทดสอบล้มเหลว";
  const long = (n: number) => `เซิร์ฟเวอร์สำรองข้อมูลระยะยาว ศูนย์ข้อมูลภาคเหนือ เชียงใหม่ ชุดที่ ${n}`;
  const w = await workspace(desktop, [
    { label: prod, environment: "PROD" }, { label: down, closed: true },
    ...Array.from({ length: 9 }, (_, index) => ({ label: long(index + 1), closed: true })),
  ]);
  const sizes = [[1280, 800], [960, 640]] as const;
  const evidence: Record<string, unknown> = {};
  const resize = async (width: number, height: number) => {
    await app.evaluate(({ BrowserWindow }, [width, height]) => { BrowserWindow.getAllWindows()[0].setContentSize(width, height); }, [width, height]);
    await expect.poll(() => page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe(`${width}x${height}`);
    // The sidebar panel can settle a frame or more after the window: measure once the layout held for 200 ms.
    let layout = "";
    await expect.poll(async () => layout === (layout = await page.evaluate(() => [...document.querySelectorAll("#app-sidebar, section[data-session-id]")]
      .map((element) => { const { x, width } = element.getBoundingClientRect(); return `${x},${width}`; }).join(" "))), { intervals: [200] }).toBe(true);
  };
  const shot = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  const noPageScroll = async () => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth
      ? { page: [document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth],
          widest: [...document.querySelectorAll("body *")].filter((element) => element.getBoundingClientRect().right > innerWidth + 0.5)
            .slice(0, 5).map((element) => `${element.tagName}.${element.className}`.slice(0, 120)) }
      : null);
    expect(wide, "no horizontal page scroll").toBeNull();
  };
  /** Every pane is visible, inside the window, usable and overlaps no other pane. */
  const tiled = async (panes: Locator[], label?: string) => {
    const boxes = [];
    if (label) evidence[`sizes-${label}`] = await Promise.all(panes.map(async (pane) => ({
      columns: Number(await pane.getAttribute("data-columns")),
      labelWidth: Math.round((await pane.locator(".pane-header .type-label").boundingBox())?.width ?? 0),
    })));
    for (const pane of panes) {
      await expect(pane).toBeVisible();
      const box = (await pane.boundingBox())!;
      const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
      // A merge always adds a column, so at 960×640 with the sidebar a quarter-width pane has ~17 columns.
      expect(Number(await pane.getAttribute("data-columns"))).toBeGreaterThanOrEqual(15);
      expect(Number(await pane.getAttribute("data-rows"))).toBeGreaterThanOrEqual(5);
      boxes.push(box);
    }
    for (const [i, one] of boxes.entries())
      for (const other of boxes.slice(i + 1))
        expect(one.x + one.width <= other.x + 0.5 || other.x + other.width <= one.x + 0.5
          || one.y + one.height <= other.y + 0.5 || other.y + other.height <= one.y + 0.5, `panes do not overlap: ${JSON.stringify([one, other])}`).toBe(true);
  };
  /** The pane header shows the server name and its outcome, and keeps every control inside the pane. */
  const readable = async (pane: Locator, label: string) => {
    const header = (await pane.locator(".pane-header").boundingBox())!;
    const name = (await pane.locator(".pane-header .type-label").boundingBox())?.width ?? 0;
    const id = await pane.getAttribute("data-session-id");
    // A truncated name (with its tooltip) is fine; a name squeezed to nothing is not.
    expect(name, `${label} ${id}: the server name is readable`).toBeGreaterThanOrEqual(48);
    if (await pane.locator(".pane-header [role=status]").textContent())
      expect((await pane.locator(".pane-header [role=status]").boundingBox())?.width ?? 0, `${label} ${id}: the outcome is readable`).toBeGreaterThanOrEqual(40);
    // The header may hide the endpoint in a narrow pane; the status bar then still shows all of it, unclipped.
    const target = pane.getByRole("group", { name: "Pane status", exact: true }).locator(".pane-status-target");
    await expect(target, `${label} ${id}: the status bar names the pane's target`).toHaveText((await pane.locator(".pane-header .host-target").textContent())!);
    const clip = await target.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    expect(clip.scroll, `${label} ${id}: the status bar target is not clipped`).toBeLessThanOrEqual(clip.client + 1);
    const [paneBox, targetBox] = [(await pane.boundingBox())!, (await target.boundingBox())!];
    expect(targetBox.y + targetBox.height, `${label} ${id}: the status bar target stays inside the pane`).toBeLessThanOrEqual(paneBox.y + paneBox.height + 0.5);
    for (const control of await pane.locator(".pane-header button, .pane-header .pane-badge, .pane-header .connection-status").all()) {
      const box = (await control.boundingBox())!;
      expect(box.x, `${label} ${id}: header controls stay inside the pane`).toBeGreaterThanOrEqual(header.x - 0.5);
      expect(box.x + box.width, `${label} ${id}: header controls stay inside the pane`).toBeLessThanOrEqual(header.x + header.width + 0.5);
    }
  };
  /** An ended pane's notice keeps its text beside the icon, with Reconnect under or beside it but never over it. */
  const notice = async (pane: Locator, label: string) => {
    const title = (await pane.locator(".live-terminal-notice [data-slot=alert-title]").boundingBox())!;
    const action = (await pane.getByRole("button", { name: "Reconnect", exact: true }).boundingBox())!;
    expect(title.height, `${label}: the notice title wraps to at most three lines`).toBeLessThanOrEqual(3 * 21);
    expect(action.y >= title.y + title.height - 0.5 || action.x >= title.x + title.width - 0.5, `${label}: Reconnect does not cover the text`).toBe(true);
  };
  /** SST-040/09: the bar is only a drag region beside the traffic lights; tabs and actions live in the page. */
  const titlebar = async (label: string) => {
    const lights = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getWindowButtonPosition?.() ?? null);
    const regions = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>("header.app-titlebar")!;
      const style = getComputedStyle(header);
      return {
        bar: style.getPropertyValue("-webkit-app-region") || (style as unknown as { webkitAppRegion?: string }).webkitAppRegion || "",
        height: header.getBoundingClientRect().height,
        controls: [...header.querySelectorAll('button, input, [role="tab"], [role="tablist"], [tabindex]')].map((element) => element.outerHTML.slice(0, 80)),
      };
    });
    expect(regions.bar, "the titlebar drags the window").toBe("drag");
    expect(regions.height).toBe(40);
    expect(regions.controls, "the titlebar holds no controls").toEqual([]);
    expect(lights, "macOS reports the traffic-light position").not.toBeNull();
    // The strip sits below the bar, so no tab can reach the traffic lights.
    const strip = await page.getByRole("tablist", { name: "Terminal tabs" }).boundingBox();
    expect(strip!.y, "the tab strip is below the titlebar").toBeGreaterThanOrEqual(regions.height);
    evidence[`titlebar-${label}`] = { lights, height: regions.height, stripTop: strip!.y };
  };
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

    // Two PROD panes side by side.
    const p1 = await w.connect(prod, { trust: true });
    let before = await w.ids();
    await page.keyboard.press("Meta+d");
    const p2 = await w.opened(before);
    await w.ready(p2);
    // The pane that receives typing is outlined; the other keeps a plain border.
    const outline = (pane: Locator) => pane.evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopColor, shadow: style.boxShadow };
    });
    // The new pane takes focus once Ready; wait until the previous one has let go of it.
    await expect.poll(async () => (await outline(p1)).shadow, { message: "the inactive pane has no outline" }).toBe("none");
    const [active, other] = [await outline(p2), await outline(p1)];
    expect(active.border, "the active pane is outlined").not.toBe(other.border);
    expect(active.shadow).not.toBe("none");
    for (const [width, height] of sizes) {
      await resize(width, height);
      await tiled([p1, p2], `two-${width}x${height}`);
      for (const pane of [p1, p2]) await readable(pane, `two-${width}x${height}`);
      for (const pane of [p1, p2]) await expect(pane.locator(".pane-header").getByText("PROD", { exact: true })).toBeVisible();
      await noPageScroll();
      await titlebar(`two-${width}x${height}`);
      await shot(`two-panes-${width}x${height}`);
    }

    // Four panes: a failed one merged in and another split down.
    const failed = await w.connect(down, { ready: false });
    await expect(failed).toHaveAttribute("data-phase", "failed", { timeout: 20_000 });
    await expect(failed.getByText("Couldn't connect: the server could not be reached", { exact: true })).toBeVisible();
    await page.keyboard.press("Meta+1");
    await w.menu(p1, "Add to this split");
    await page.getByRole("menuitem", { name: down }).click();
    await expect(w.tabs).toHaveCount(1);
    before = await w.ids();
    await w.menu(p2, "Split down");
    const p3 = await w.opened(before);
    await w.ready(p3);
    await expect(w.tabs.nth(0)).toContainText("+3 panes");
    for (const [width, height] of [...sizes].reverse()) {
      await resize(width, height);
      await tiled([p1, p2, p3, failed], `four-${width}x${height}`);
      await shot(`four-panes-${width}x${height}`);
      for (const pane of [p1, p2, p3, failed]) await readable(pane, `four-${width}x${height}`);
      await notice(failed, `four-${width}x${height}`);
      await expect(failed.getByText("Couldn't connect: the server could not be reached", { exact: true }),
        `four-${width}x${height}: the failed pane says why`).toBeVisible();
      await expect(failed.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
      for (const pane of [p1, p2, p3]) await expect(pane.locator(".pane-header").getByText("PROD", { exact: true })).toBeVisible();
      await expect(failed.getByText("PROD", { exact: true })).toHaveCount(0);
      await noPageScroll();

      // Ctrl+Cmd+S collapses and restores the sidebar; the panes keep fitting.
      const toggle = page.getByRole("button", { name: "Sidebar", exact: true });
      const sidebar = page.locator("#app-sidebar");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const open = (await sidebar.boundingBox())!.width;
      expect(open).toBeGreaterThanOrEqual(200);
      expect(open).toBeLessThanOrEqual(400);
      await p1.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Control+Meta+s");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeLessThan(1);
      await tiled([p1, p2, p3, failed], `four-collapsed-${width}x${height}`);
      await noPageScroll();
      await shot(`sidebar-collapsed-${width}x${height}`);
      await page.keyboard.press("Control+Meta+s");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(200);
      evidence[`sidebar-${width}x${height}`] = open;
    }

    // Ten tabs with long Thai labels scroll inside the strip; the page itself never scrolls sideways.
    for (let n = 1; n <= 9; n += 1) await w.connectInBackground(long(n));
    await expect(w.tabs).toHaveCount(10);
    const strip = page.getByRole("tablist", { name: "Terminal tabs" });
    for (const [width, height] of sizes) {
      // Show the split tab, then the last one; the resize afterwards keeps the selected tab and its close button in view.
      await page.keyboard.press("Meta+1");
      await expect(w.tabs.nth(0)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Meta+9");
      await expect(w.tabs.nth(9)).toHaveAttribute("aria-selected", "true");
      await resize(width, height);
      await expect(w.tabs.nth(9)).toHaveAttribute("title", long(9));
      const overflow = await strip.evaluate((element) => ({
        scroll: element.scrollWidth, client: element.clientWidth, style: getComputedStyle(element).overflowX,
      }));
      expect(overflow.scroll).toBeGreaterThan(overflow.client);
      expect(overflow.style).toBe("auto");
      const box = (await strip.boundingBox())!;
      for (const shown of [w.tabs.nth(9), strip.getByRole("button", { name: `Close ${long(9)}`, exact: true })]) {
        await expect.poll(async () => {
          const at = (await shown.boundingBox())!;
          return at.x >= box.x - 0.5 && at.x + at.width <= box.x + box.width + 0.5;
        }, { message: `${width}x${height}: the selected tab and its close button stay in the strip` }).toBe(true);
      }
      const settings = page.locator("#app-sidebar").getByRole("button", { name: "Settings", exact: true });
      await expect(settings).toBeInViewport({ ratio: 1 });
      await noPageScroll();
      await titlebar(`tabs-${width}x${height}`);
      await shot(`ten-tabs-${width}x${height}`);
      evidence[`tabs-${width}x${height}`] = overflow;
    }
    await testInfo.attach("visual-evidence", {
      body: JSON.stringify({ ...evidence, reducedMotion: true, platform: process.platform }), contentType: "application/json",
    });
    expect(desktop.errors).toEqual([]);
  } finally {
    await w.finish();
  }
});
