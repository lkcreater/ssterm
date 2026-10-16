import { resolve } from "node:path";
import type { Locator } from "@playwright/test";
import { test, expect, showPane } from "./fixtures";

// The sessions authenticate with a Keychain-held fixture password; keep terminal content out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

const label = "ระบบทดสอบ อินพุต";
const secondLabel = "เครื่องสำรอง อินพุต";
const hex = (text: string) => Buffer.from(text, "utf8").toString("hex");
// xterm rows concatenate without separators, so "exact" means no further hex byte follows.
const exactHex = (value: string) => new RegExp(`HEX=${value}(?![0-9a-f]{2})`);
// Prints the bytes the remote line discipline delivered to `read`, after a marker proving `read` has started.
const readHex = (tag: string) =>
  String.raw`echo "READ-${tag}-$((1+0))"; read -r x; printf 'HEX=%s\n' "$(printf '%s' "$x"|od -An -tx1|tr -d ' \n')"`;

test("terminal input, Unicode, clipboard, links and search reach only the focused real session", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
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
      owner: parameters.owner, label: parameters.label, secondLabel: parameters.secondLabel, tempDirectory: app.getPath("temp"),
      send: (channel: string, value: unknown) => { if (!window.webContents.isDestroyed()) window.webContents.send(channel, value); },
    });
    for (const channel of [...production.terminalChannels, production.channels.openLink]) ipcMain.removeHandler(channel);
    const disposeTerminal = production.registerTerminalHandlers({ ipc: ipcMain, boundary, controller: () => fixture.controller });
    // Shipped link handler with a recording opener: no confirmation box and no browser ever opens.
    const opened: { href: string; sameWindow: boolean }[] = [];
    const disposeLinks = production.registerLinkHandlers({ ipc: ipcMain, boundary,
      open: async (href: string, sender: Electron.WebContents) => { opened.push({ href, sameWindow: sender === window.webContents }); return false; } });
    (globalThis as any).__sstermTerminalFixture = { fixture, opened, disposeHandlers: () => { disposeTerminal(); disposeLinks(); } };
  }, { owner, label, secondLabel, fixturePath: resolve("tests/fixtures/terminal/ssh.cjs") });

  const operate = (method: "connect" | "connectSecond" | "status"): Promise<{ state: string; generation: number }> => app.evaluate(async (_electron, method) => {
    await new Promise<void>((done) => setImmediate(done));
    return (globalThis as any).__sstermTerminalFixture.fixture[method]();
  }, method);
  const opened = () => app.evaluate(() => (globalThis as any).__sstermTerminalFixture.opened as { href: string; sameWindow: boolean }[]);
  // By attribute: a pane in a background tab is hidden (and inert) until its tab is shown.
  const paneA = page.locator(`section[aria-label="Terminal for ${label}"]`);
  const paneB = page.locator(`section[aria-label="Terminal for ${secondLabel}"]`);
  const screenA = paneA.locator(".xterm-rows");
  const textarea = (pane: Locator) => pane.locator(".xterm-helper-textarea");
  const feedback = (pane: Locator) => pane.getByTestId("terminal-feedback");
  const run = async (command: string, pane = paneA) => {
    await showPane(page, pane);
    await textarea(pane).focus();
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
  };
  // The cursor row ends in the prompt only once readline is reading again, after it re-enabled
  // bracketed paste (readline writes ESC[?2004h before the prompt).
  const idle = (pane = paneA) => expect(pane.locator(".xterm-rows > div:has(.xterm-cursor)"), "the shell is waiting at an empty prompt").toHaveText(/\$\s*$/);
  const ready = async (pane: Locator) => {
    await expect(pane).toHaveAttribute("data-phase", "ready");
    await expect(pane.locator(".xterm-rows"), "remote prompt is rendered").toContainText("fixture@");
  };
  // Synthetic clipboard events: the real macOS pasteboard is never read or written.
  const paste = (pane: Locator, text: string) => textarea(pane).evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  const confirm = page.getByTestId("paste-confirm-dialog");
  // xterm's screen layer takes pointer events, so act at the text's coordinates.
  const at = async (text: Locator, x: number) => {
    // xterm replaces row spans when it redraws (e.g. link hover underline), so a resolved span can detach.
    let box: Awaited<ReturnType<Locator["boundingBox"]>> = null;
    await expect.poll(async () => (box = await text.boundingBox()) !== null, { message: "text has a layout box" }).toBe(true);
    return [box!.x + x, box!.y + box!.height / 2] as const;
  };
  const cmdClick = async (x: number, y: number) => {
    await page.keyboard.down("Meta");
    try { await page.mouse.click(x, y); } finally { await page.keyboard.up("Meta"); }
  };
  let cleaned = false;
  try {
    await operate("connect");
    await ready(paneA);
    await expect(paneA.getByText("PROD", { exact: true })).toBeVisible();

    // 1. Locale and IUTF8. ssterm sends no LANG; the fixture opts in.
    await run("export LANG=C.UTF-8");
    await run('echo "CHARMAP=$(locale charmap)"');
    await expect(screenA).toContainText("CHARMAP=UTF-8");
    await run(String.raw`echo "MODE=$(stty -a | grep -oE -- '-?iutf8')"`);
    await expect(screenA, "the PTY requested IUTF8").toContainText("MODE=iutf8");

    // 2. Thai typing is byte-identical; Backspace removes a whole Thai character (IUTF8).
    await run(readHex("thai"));
    await expect(screenA).toContainText("READ-thai-1");
    await page.keyboard.type("สวัสดี");
    await page.keyboard.press("Enter");
    await expect(screenA, "typed Thai arrives as its exact UTF-8 bytes").toContainText(exactHex(hex("สวัสดี")));
    await run(readHex("erase"));
    await expect(screenA).toContainText("READ-erase-1");
    await page.keyboard.type("ทดสอบ");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect(screenA, "Backspace erased exactly one Thai character").toContainText(exactHex(hex("ทดสอ")));

    // 3. IME composition commits once.
    await run(readHex("ime"));
    await expect(screenA).toContainText("READ-ime-1");
    await textarea(paneA).focus();
    await app.evaluate(async ({ BrowserWindow }) => {
      const debug = BrowserWindow.getAllWindows()[0].webContents.debugger;
      debug.attach("1.3");
      try {
        await debug.sendCommand("Input.imeSetComposition", { text: "日", selectionStart: 1, selectionEnd: 1 });
        await debug.sendCommand("Input.imeSetComposition", { text: "日本", selectionStart: 2, selectionEnd: 2 });
        await debug.sendCommand("Input.insertText", { text: "日本" });
      } finally { debug.detach(); }
    });
    await page.keyboard.press("Enter");
    await expect(screenA, "the composed text arrives exactly once").toContainText(exactHex(hex("日本")));

    // 4. Unicode width: xterm's cursor position (DSR) equals glibc wcwidth for the same remote string.
    const sample = "ที่ 日本 😀 👩‍💻";
    const escaped = [...Buffer.from(sample)].map((byte) => `\\x${byte.toString(16)}`).join("");
    await run(`s=$'${escaped}'; ` + String.raw`printf '\r%s' "$s"; IFS='[;' read -rs -d R -p $'\e[6n' _ r c; echo; echo "XTERM=$((c-1)) GLIBC=$(printf '%s' "$s"|wc -L)"`);
    await expect(screenA, "rendered width equals glibc width").toContainText(/XTERM=(\d+) GLIBC=\1(?!\d)/);
    const widths = (await screenA.textContent())!.match(/XTERM=(\d+) GLIBC=(\d+)/)!;
    expect(Number(widths[1])).toBeGreaterThan(0);

    // 5a. PROD multiline paste: Cancel sends nothing.
    await idle();
    await paste(paneA, "echo PC$((3+4))\necho PD$((4+4))");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("This is a production target.");
    await expect(confirm, "bash had bracketed paste on").not.toContainText("not in bracketed paste mode");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(textarea(paneA), "focus returns to the terminal").toBeFocused();
    await run("echo CANCELLED-$((5+5))");
    await expect(screenA).toContainText("CANCELLED-10");
    await expect(screenA, "a cancelled paste never reached the shell").not.toContainText("echo PC$((3+4))");
    await expect(screenA).not.toContainText("PC7");

    // 5b. Accepted bracketed paste waits for Enter.
    await idle();
    await paste(paneA, "echo PA$((1+1))\necho PB$((1+2))");
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Paste 2 lines" }).click();
    await expect(confirm).toBeHidden();
    await expect(feedback(paneA)).toContainText(`Pasted 2 lines into ${label}`);
    // Had the first newline executed, PA2 would print before the second line is echoed.
    await expect(screenA, "the whole paste is in the line editor").toContainText("echo PB$((1+2))");
    await expect(screenA, "no pasted line ran before Enter").not.toContainText("PA2");
    await expect(textarea(paneA)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(screenA).toContainText("PA2");
    await expect(screenA).toContainText("PB3");

    // 5c. An embedded end-of-paste sequence is stripped before anything is sent.
    await run(readHex("inject"));
    await expect(screenA).toContainText("READ-inject-1");
    await paste(paneA, "A\u001b[201~B");
    await expect(confirm).toContainText("Control characters were removed from the clipboard text.");
    await confirm.getByRole("button", { name: "Paste 1 line" }).click();
    await expect(confirm).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(screenA, "the remote received no ESC").toContainText(exactHex(hex("A[201~B")));

    // 5d. Over 256 KiB (UTF-8 bytes, fewer UTF-16 units) is refused and nothing is sent.
    await idle();
    await paste(paneA, "ก".repeat(90_000));
    await expect(feedback(paneA)).toContainText("Paste refused: the text is larger than 256 KiB. Nothing was sent.");
    await expect(confirm).toBeHidden();
    // A delivered paste would prefix this command and make it fail.
    await run("echo OVERSIZE-$((6+6))");
    await expect(screenA, "the refused paste left the line editor empty").toContainText("OVERSIZE-12");

    // 6. Copy the selection through a synthetic copy event.
    await run("echo COPY-$((11*11))");
    const copied = screenA.getByText("COPY-121", { exact: false }).last();
    await expect(copied).toBeVisible();
    await page.mouse.dblclick(...await at(copied, 6));
    const clipboard = await textarea(paneA).evaluate((element) => {
      const data = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
      return data.getData("text/plain");
    });
    expect(clipboard, "the copy carries the selected remote marker").toContain("COPY-121");
    await expect(feedback(paneA)).toContainText(`Copied ${[...clipboard].length} characters`);

    // 7. Links open only on Cmd+click and only through main's validated handler.
    await run(String.raw`printf 'https://example.invalid/plain-%s\n' LINK; printf '\e]8;;https://example.invalid/osc-%s\e\\OSC8-%s\e]8;;\e\\\n' 8 LINK`);
    const pointer = paneA.locator(".xterm-screen");
    const plain = screenA.getByText("plain-LINK", { exact: false }).last();
    await expect(plain).toBeVisible();
    const plainAt = await at(plain, 20);
    await page.mouse.move(...plainAt);
    await expect(pointer, "the plain URL is recognized").toHaveClass(/xterm-cursor-pointer/);
    await page.mouse.click(...plainAt);
    await cmdClick(...plainAt);
    await expect.poll(opened, { message: "only the Cmd+click reached the opener" })
      .toEqual([{ href: "https://example.invalid/plain-LINK", sameWindow: true }]);
    const osc = screenA.getByText("OSC8-LINK", { exact: false }).last();
    const oscAt = await at(osc, 6);
    await page.mouse.move(...oscAt);
    await expect(pointer, "the OSC 8 link is recognized").toHaveClass(/xterm-cursor-pointer/);
    await page.mouse.click(...oscAt);
    await cmdClick(...oscAt);
    await expect.poll(opened).toEqual([
      { href: "https://example.invalid/plain-LINK", sameWindow: true },
      { href: "https://example.invalid/osc-8", sameWindow: true },
    ]);
    const rejected = await page.evaluate(async (owner) => {
      const script = await window.ssterm.openLink({ owner, url: "javascript:alert(1)" });
      const stale = await window.ssterm.openLink({ owner: { ...owner, generation: owner.generation + 1 }, url: "https://example.invalid/" });
      return [script.ok ? "ok" : script.error.code, stale.ok ? "ok" : stale.error.code];
    }, owner);
    expect(rejected[0], "javascript: is refused by main").toBe("invalid-request");
    expect(rejected[1], "another owner cannot open links").not.toBe("ok");
    expect(await opened(), "refused links never reach the opener").toHaveLength(2);

    // 8. Search finds remote output and never sends input.
    await run("echo FIND-$((7*7))");
    await expect(screenA).toContainText("FIND-49");
    await idle();
    await textarea(paneA).focus();
    await page.keyboard.press("Meta+f");
    const search = paneA.getByRole("search");
    const query = paneA.getByRole("searchbox", { name: `Search terminal output for ${label}` });
    await expect(query).toBeFocused();
    await page.keyboard.type("FIND-49");
    await expect(search).toHaveAttribute("data-search-count", /^[1-9]\d*$/);
    await page.keyboard.press("Escape");
    await expect(search).toBeHidden();
    await expect(textarea(paneA), "Esc returns focus to the terminal").toBeFocused();
    // Search text in the line editor would prefix this command and make it fail.
    await run("echo SEARCHED-$((1+1))");
    await expect(screenA, "the search query never reached the shell").toContainText("SEARCHED-2");

    // 9. A second stacked pane receives only its own typing and paste.
    await operate("connectSecond");
    await ready(paneB);
    const screenB = paneB.locator(".xterm-rows");
    await expect(paneB.getByText("PROD", { exact: true })).toHaveCount(0);
    await run("export LANG=C.UTF-8", paneB);
    await run("echo BTYPED-$((20+22))", paneB);
    await expect(screenB).toContainText("BTYPED-42");
    await idle(paneB);
    await paste(paneB, "echo BPASTE-$((3*3))\necho BLINE-$((4*4))");
    // DEV target with bracketed paste on: no confirmation, no Enter added.
    await expect(feedback(paneB)).toContainText(`Pasted 2 lines into ${secondLabel}`);
    await expect(confirm).toBeHidden();
    await expect(screenB).toContainText("echo BLINE-$((4*4))");
    await expect(screenB).not.toContainText("BPASTE-9");
    await page.keyboard.press("Enter");
    await expect(screenB).toContainText("BPASTE-9");
    await expect(screenB).toContainText("BLINE-16");
    await run("echo ASTILL-$((1+2))");
    await expect(screenA).toContainText("ASTILL-3");
    await expect(screenA, "pane A never saw pane B's input").not.toContainText("BTYPED");
    await expect(screenA).not.toContainText("BPASTE");
    await expect(screenB, "pane B never saw pane A's input").not.toContainText("ASTILL");

    expect(dialogs, "no page dialog was raised").toEqual([]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), "no window opened").toBe(1);
    expect(desktop.errors).toEqual([]);
    await testInfo.attach("terminal-input-evidence", {
      body: JSON.stringify({ widths: { xterm: Number(widths[1]), glibc: Number(widths[2]) }, opened: await opened(), platform: process.platform }),
      contentType: "application/json",
    });
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
      await testInfo.attach("terminal-input-failure-state", { body: JSON.stringify(diagnostics), contentType: "application/json" });
    }
  }
});
