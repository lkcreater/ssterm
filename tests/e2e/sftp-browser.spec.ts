import { execFile } from "node:child_process";
import { mkdir, realpath, symlink, writeFile, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Locator, Page } from "@playwright/test";
import { test, expect, changeCatalog, type Desktop } from "./fixtures";

// Sessions authenticate with the lab password typed from main; keep automatic artifacts off.
// The visual check attaches explicit screenshots that show only fixture names, labels and the endpoint.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
interface Lab {
  host: string; port: number; username: string; password: string; directory: string; container: string; privateKey: Buffer;
  dispose(): Promise<void>; assertCleaned(): Promise<void>;
}

const ROOT = "/home/fixture/f04";
const THAI = "ไฟล์ทดสอบ.txt";
const EMOJI = "emoji-🚀.txt";
const NFC = "caf\u00e9.txt";
const NFD = "cafe\u0301.txt";
const ESC = "esc-\u001b[31mred.txt";
const LONG_DIR = "โฟลเดอร์ชื่อยาวมากสำหรับทดสอบการตัดข้อความ";
const LONG_FILE = "รายงานการตรวจสอบระบบเครือข่ายประจำไตรมาสที่สี่ของปีงบประมาณ";
const RAW = /[\u001b\u202e]/u;
// Seeded as the fixture user, so the chmod-000 directory really refuses it. Names are bytes: non-UTF-8 is possible.
const SEED = String.raw`
import os
r = b"${ROOT}"
for d in (b"sub", b"many", b"locked", "${LONG_DIR}".encode()):
    os.makedirs(r + b"/" + d)
for n in ["${THAI}", "${EMOJI}", "caf\u00e9.txt", "cafe\u0301.txt", "esc-\x1b[31mred.txt", "rlo-\u202etxt.exe", ".env", "sub/inner.txt"]:
    open(r + b"/" + n.encode(), "wb").write(b"x")
open(r + b"/bad-\xff\xfe.bin", "wb").write(b"x")
os.symlink(b"sub", r + b"/link-dir")
os.symlink(b"missing", r + b"/dangling")
os.symlink(b"loop", r + b"/loop")
os.symlink("${THAI}".encode(), r + b"/link-file")
os.chmod(r + b"/locked", 0)
for i in range(10000):
    open(r + b"/many/file-%05d" % i, "wb").close()
for i in range(12):
    open(r + b"/" + "${LONG_DIR}/${LONG_FILE}-%02d.txt".encode() % i, "wb").write(b"x" * (i * 999))
`;

async function keychainCount(service: string): Promise<number> {
  const { stdout } = await runFile("security", ["dump-keychain"], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").filter((line) => line.includes(`"svce"<blob>="${service}"`)).length;
}
async function fixtureContainers(): Promise<number> {
  const { stdout } = await runFile("docker", ["ps", "-aq", "--filter", "label=dev.ssterm.spike.fixture"]);
  return stdout.trim() ? stdout.trim().split("\n").length : 0;
}

/**
 * A runner-owned seeded lab and saved servers whose identities use the password method with nothing saved:
 * every connection asks, and main types the lab password into the prompt so it never crosses Playwright.
 */
async function lab(desktop: Desktop, servers: { label: string; prod?: boolean; username?: string }[]) {
  const { app, page } = desktop;
  const lab: Lab = await startFixture();
  const count = async (pattern: string) => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", pattern])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw new Error("Process count unavailable"); }
  };
  const finish = async () => {
    try {
      await desktop.close();
      expect(await count("sshd: fixture@"), "no server session outlives the app").toBe(0);
    } finally {
      lab.privateKey.fill(0);
      await lab.dispose();
      await lab.assertCleaned();
    }
    expect(await keychainCount(desktop.secretNamespace), "teardown emptied the namespace").toBe(0);
    expect(await fixtureContainers(), "no fixture containers remain").toBe(0);
  };
  try {
    await runFile("docker", ["exec", "-u", "fixture", lab.container, "python3", "-c", SEED], { timeout: 120_000 });
    await writeFile(join(lab.directory, "password"), lab.password, { mode: 0o600 });
    await changeCatalog(app, servers.flatMap(({ label, prod, username }, index) => [
      { type: "create-identity", data: { label: `Lab ${index}`, username: username ?? lab.username, method: "password" } },
      { type: "create-host", data: {
        label, address: lab.host, environment: prod ? "PROD" : null,
        port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: `$${index * 2}` },
      } },
    ]));
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(servers[0]!.label);
  } catch (error) {
    await finish().catch(() => undefined);
    throw error;
  }
  const credentials = page.getByTestId("credential-prompt-dialog");
  return {
    lab, count, finish, credentials,
    endpoint: `${lab.username}@${lab.host}:${lab.port}`,
    /** SFTP connections: `sshd: fixture@notty` per connection, `internal-sftp` per subsystem. */
    sftpProcesses: async () => (await count("sshd: fixture@notty")) + (await count("sshd: fixture@internal-sftp")),
    /** Answers the one open password prompt for `label`. */
    async password(label: string) {
      await expect(credentials).toBeVisible({ timeout: 20_000 });
      await expect(credentials).toContainText(label);
      await expect.poll(() => app.evaluate(async ({ BrowserWindow }, file) => {
        const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
        return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
          const dialogs = [...document.querySelectorAll('[data-testid="credential-prompt-dialog"]')];
          if (dialogs.length !== 1) return false;
          const inputs = [...dialogs[0].querySelectorAll('input')];
          if (inputs.length !== 1 || inputs[0].disabled) return false;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], ${JSON.stringify(value)});
          inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
          return true; })()`);
      }, join(lab.directory, "password")), { message: "main typed the lab password" }).toBe(true);
      await credentials.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(credentials).toHaveCount(0);
    },
    /** Views the server: opens its host drawer (making it the current row) and closes it again. */
    async select(label: string) {
      await page.getByRole("button", { name: /^All servers/u }).click();
      await page.getByTestId("hosts-page").locator("button[data-host-id]", { hasText: label }).click();
      await expect(page.getByTestId("server-editor").getByLabel("Name")).toHaveValue(label);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("server-editor")).toHaveCount(0);
    },
  };
}

function pane(page: Page, kind: "local" | "remote") {
  const section = page.locator(`section[data-pane="${kind}"]`);
  const list = section.locator('[role="listbox"].file-list');
  return {
    section, list,
    rows: list.locator('[role="option"]'),
    row: (name: string) => list.locator(`[role="option"][data-name=${JSON.stringify(name)}]`),
    /** Raw-name match in the page, for names a CSS or text selector would normalize or escape. */
    names: () => list.locator('[role="option"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-name"))),
    error: section.locator("[data-error]"),
    notice: section.locator(".files-notice"),
    current: section.locator('nav [aria-current="location"]'),
    button: (name: string) => section.getByRole("button", { name, exact: true }),
    hidden: section.getByRole("button", { name: "Show hidden files", exact: true }),
    async goto(path: string) {
      await section.getByRole("button", { name: "Go to path", exact: true }).click();
      const box = section.getByRole("textbox", { name: "Go to path" });
      await box.fill(path);
      await box.press("Enter");
    },
    async at(path: string) {
      await expect(list).toHaveAttribute("data-path", path, { timeout: 20_000 });
      await expect(list).not.toHaveAttribute("aria-busy", "true");
    },
  };
}

/** Intercepts the next copy event in the page: the app's text is kept, nothing reaches the system clipboard. */
async function interceptCopy(page: Page) {
  await page.evaluate(() => {
    getSelection()?.removeAllRanges();
    delete (window as { copied?: string }).copied;
    addEventListener("copy", (event) => {
      const data = new DataTransfer();
      Object.defineProperty(event, "clipboardData", { value: data });
      // Not cancelled and with no selection, so the default copy writes nothing.
      event.preventDefault = () => {};
      setTimeout(() => { (window as { copied?: string }).copied = data.getData("text/plain"); });
    }, { capture: true, once: true });
  });
  return () => expect.poll(() => page.evaluate(() => (window as { copied?: string }).copied));
}

const noOverflow = (element: Locator) => element.evaluate((node) => node.scrollWidth <= node.clientWidth);

test("Files browses a real OpenSSH server and This Mac: hostile names, links, permissions, 10,000 entries, keyboard, copy, reconnect, lock, close", async ({ desktop }, testInfo) => {
  test.setTimeout(360_000);
  const { app, page, profile } = desktop;
  const label = "คลังไฟล์ ผลิตจริง";
  const w = await lab(desktop, [{ label, prod: true }]);
  try {
    // Open files from the server's ⋯ menu on Servers: trust, password, Ready at the remote home.
    await w.select(label);
    await page.getByTestId("hosts-page").getByRole("button", { name: `Actions for ${label}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Open files", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Files");
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    await w.password(label);
    const remote = pane(page, "remote");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(pane(page, "local").list, "the first local listing never takes focus").not.toBeFocused();
    await expect(remote.section).toHaveAttribute("aria-label", `Remote files on ${label}`);
    await expect(remote.section.locator(".pane-header")).toContainText(label);
    await expect(remote.section.locator(".pane-header").getByText("PROD", { exact: true })).toBeVisible();
    await expect(remote.section.locator(".host-target")).toHaveText(w.endpoint);
    await remote.at("/home/fixture");
    await expect(remote.list, "the remote list takes focus once Ready").toBeFocused();
    expect(await w.sftpProcesses(), "one SFTP connection and subsystem").toBe(2);

    // Go to path: a missing path is refused in place; the seeded folder opens.
    await remote.goto(`${ROOT}/nope`);
    await expect(remote.section.locator(".files-goto-error")).toHaveText("Nothing exists at that path.");
    await remote.section.getByRole("textbox", { name: "Go to path" }).press("Escape");
    await remote.goto(ROOT);
    await remote.at(ROOT);
    await expect(remote.current).toHaveText("f04");

    // Unicode names are listed verbatim; NFC and NFD twins stay two rows.
    const names = await remote.names();
    for (const name of [THAI, EMOJI, NFC, NFD, "link-dir", "dangling", "loop", "link-file", "locked", "many", "sub"])
      expect(names, `listed: ${name}`).toContain(name);
    expect(names, "hidden by default").not.toContain(".env");
    await expect(remote.section.locator(".files-footer-count")).toHaveText("15 items (1 hidden)");
    // Control and bidi characters are shown escaped and marked; no raw one reaches the DOM.
    expect(names).toContain("esc-\\u{1B}[31mred.txt");
    expect(names).toContain("rlo-\\u{202E}txt.exe");
    const escaped = remote.list.locator('[role="option"][data-escaped]');
    await expect(escaped).toHaveCount(2);
    for (const row of await escaped.all()) await expect(row).toHaveAccessibleName(/^\S+, contains hidden characters(?!\w)/u);
    // Each option is named as one phrase: no space before a comma.
    await expect(remote.row("sub")).toHaveAccessibleName(/^sub, folder(?!\w)/u);
    await expect(remote.row("link-dir")).toHaveAccessibleName(/^link-dir, Link(?!\w)/u);
    expect(await remote.section.evaluate((node, raw) => new RegExp(raw, "u").test(node.outerHTML), RAW.source), "no raw ESC/RLO in the DOM").toBe(false);
    // The non-UTF-8 name is unreadable: never selected or opened.
    const unreadable = remote.list.locator('[role="option"][aria-disabled="true"]');
    await expect(unreadable).toHaveCount(1);
    await expect(unreadable).toContainText("(unreadable name)");
    await expect(unreadable).not.toHaveAttribute("data-name");
    await unreadable.click({ force: true });
    await expect(unreadable).toHaveAttribute("aria-selected", "false");
    await unreadable.dblclick({ force: true });
    await page.keyboard.press("Enter");
    await remote.at(ROOT);
    await expect(remote.section.locator("[data-testid=file-detail]"), "no detail for an unreadable name").toHaveCount(0);

    // A link to a folder is entered at the link's own path; Backspace and Cmd+Up go back up.
    await remote.row("link-dir").click();
    await page.keyboard.press("Enter");
    await remote.at(`${ROOT}/link-dir`);
    await expect(remote.current).toHaveText("link-dir");
    await expect(remote.row("inner.txt")).toBeVisible();
    await page.keyboard.press("Backspace");
    await remote.at(ROOT);
    await remote.row("sub").dblclick();
    await remote.at(`${ROOT}/sub`);
    await remote.list.focus();
    await page.keyboard.press("Meta+ArrowUp");
    await remote.at(ROOT);
    // Dangling and looping links say so; a link to a file selects it.
    for (const name of ["dangling", "loop"]) {
      await remote.row(name).click();
      await page.keyboard.press("Enter");
      await expect(remote.row(name)).toHaveAttribute("data-broken", "true");
      await expect(remote.row(name).locator(".file-link")).toHaveText("Broken link");
      await expect(remote.row(name)).toHaveAccessibleName(new RegExp(`^${name}, Broken link(?!\\w)`, "u"));
      await expect(remote.notice).toContainText(`${name}: Broken link`);
    }
    await remote.button("Refresh").click();
    await remote.at(ROOT);
    await expect(remote.list.locator("[data-broken]"), "Refresh forgets broken links").toHaveCount(0);
    await expect(remote.notice).toBeEmpty();
    await remote.row("link-file").click();
    await page.keyboard.press("Escape");
    await expect(remote.row("link-file")).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Enter");
    await expect(remote.row("link-file")).toHaveAttribute("aria-selected", "true");
    await remote.at(ROOT);

    // A permission-denied folder explains itself and offers Go up.
    await remote.row("locked").dblclick();
    await expect(remote.error).toHaveAttribute("data-error", "permission-denied");
    await expect(remote.error).toContainText("You don't have permission to open this folder.");
    await expect(remote.current).toHaveText("locked");
    await remote.error.getByRole("button", { name: "Go up" }).click();
    await remote.at(ROOT);
    await expect(remote.list, "focus stays in the pane").toBeFocused();

    // Hidden files: the toggle reveals .env.
    await remote.hidden.click();
    await expect(remote.hidden).toHaveAttribute("aria-pressed", "true");
    await expect(remote.row(".env")).toBeVisible();
    await expect(remote.section.locator(".files-footer-count")).toHaveText("16 items");
    await remote.hidden.click();
    await expect(remote.row(".env")).toHaveCount(0);

    // Cmd+C copies the selected rows' full raw paths (control characters included) to the copy event only.
    await remote.row(THAI).click();
    await remote.list.locator('[role="option"]').filter({ hasText: "esc-" }).click({ modifiers: ["Meta"] });
    const copied = await interceptCopy(page);
    await page.keyboard.press("Meta+c");
    await copied().toBeTruthy();
    const paths = (await page.evaluate(() => (window as { copied?: string }).copied))!.split("\n").sort();
    expect(paths).toEqual([`${ROOT}/${ESC}`, `${ROOT}/${THAI}`].sort());
    await expect(remote.notice).toHaveText("Copied 2 paths");
    await expect(remote.section.locator("[data-testid=file-detail]"), "the cursor row's full name").toContainText("esc-\\u{1B}[31mred.txt");
    // Edit > Copy and Edit > Select All arrive as commands, not keys.
    const menuCopied = await interceptCopy(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.copy());
    await menuCopied().toBeTruthy();
    expect((await page.evaluate(() => (window as { copied?: string }).copied))!.split("\n").sort()).toEqual(paths);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.selectAll());
    await expect(remote.list.locator('[role="option"][aria-selected="true"]')).toHaveCount(14);
    expect(await page.evaluate(() => getSelection()?.toString() ?? ""), "no page text is selected").toBe("");
    await page.keyboard.press("Escape");

    // 10,000 entries render as a window; type-ahead reaches the last one.
    await remote.row("many").dblclick();
    await remote.at(`${ROOT}/many`);
    await expect(remote.list).toHaveAttribute("data-count", "10000");
    await expect(remote.section.locator(".files-footer-count")).toContainText("10,000 items");
    const rendered = await remote.rows.count();
    expect(rendered, "windowed rows").toBeLessThan(100);
    await page.keyboard.type("file-09999");
    const cursor = remote.list.locator('[role="option"][data-cursor]');
    await expect(cursor).toHaveAttribute("data-name", "file-09999");
    await expect(cursor).toHaveAttribute("aria-posinset", "10000");
    await expect(cursor).toHaveAttribute("aria-setsize", "10000");
    await expect(cursor).toBeInViewport();
    expect(await remote.rows.count()).toBeLessThan(100);

    // Keyboard only: Tab into the list, arrows, Enter, Backspace, Shift+Cmd+G and Shift+Cmd+period.
    await remote.button("Refresh").focus();
    for (let i = 0; i < 6 && !(await remote.list.evaluate((node) => node === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(remote.list).toBeFocused();
    // Within a second of typing, Backspace edits the type-ahead text; after it, Backspace goes up.
    await page.waitForTimeout(1_100);
    await page.keyboard.press("Backspace");
    await remote.at(ROOT);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await expect(remote.list.locator('[role="option"][data-cursor]')).toHaveAttribute("aria-posinset", "2");
    await page.keyboard.type("sub");
    await expect(remote.list.locator('[role="option"][data-cursor]')).toHaveAttribute("data-name", "sub");
    await page.keyboard.press("Enter");
    await remote.at(`${ROOT}/sub`);
    await page.keyboard.press("Meta+Shift+g");
    const box = remote.section.getByRole("textbox", { name: "Go to path" });
    await expect(box).toBeFocused();
    await page.keyboard.type(`${ROOT}/${THAI}`);
    await page.keyboard.press("Meta+ArrowUp");
    await expect(box, "Cmd+Up stays a text shortcut").toBeFocused();
    await expect(remote.list).toHaveAttribute("data-path", `${ROOT}/sub`);
    await page.keyboard.press("Enter");
    await remote.at(ROOT);
    await expect(remote.list, "focus returns to the list").toBeFocused();
    await expect(remote.row(THAI), "a typed file opens its folder with it selected").toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Meta+Shift+Period");
    await expect(remote.hidden).toHaveAttribute("aria-pressed", "true");
    await expect(remote.row(".env")).toBeVisible();
    await page.keyboard.press("Meta+Shift+Period");
    await expect(remote.hidden).toHaveAttribute("aria-pressed", "false");

    // This Mac: a temporary folder under the test profile, opened by typed path.
    const local = pane(page, "local");
    const folder = join(profile, "local-f04");
    await mkdir(join(folder, "sub"), { recursive: true });
    await mkdir(join(folder, "locked"));
    await mkdir(join(folder, LONG_DIR));
    for (const name of [NFD, THAI, "sub/inner.txt", ...Array.from({ length: 6 }, (_, i) => `${LONG_DIR}/${LONG_FILE}-${i}.txt`)])
      await writeFile(join(folder, name), "x");
    await symlink("sub", join(folder, "link-dir"));
    await symlink("missing", join(folder, "dangling"));
    await symlink(THAI, join(folder, "link-file"));
    await chmod(join(folder, "locked"), 0);
    const real = await realpath(folder);
    try {
      await local.at(await realpath(process.env.HOME!));
      await local.goto(folder);
      await local.at(real);
      const localNames = await local.names();
      expect(localNames, "APFS keeps the NFD name verbatim").toContain(NFD);
      expect(localNames).not.toContain(NFC);
      expect(localNames).toContain(THAI);
      await local.row("link-dir").dblclick();
      await local.at(`${real}/link-dir`);
      await expect(local.current).toHaveText("link-dir");
      await page.keyboard.press("Backspace");
      await local.at(real);
      await local.row("dangling").dblclick();
      await expect(local.row("dangling")).toHaveAttribute("data-broken", "true");
      await local.row("link-file").dblclick();
      await expect(local.row("link-file")).toHaveAttribute("aria-selected", "true");
      await local.row("locked").dblclick();
      await expect(local.error).toHaveAttribute("data-error", "permission-denied");
      await local.error.getByRole("button", { name: "Go up" }).click();
      await local.at(real);
    } finally {
      await chmod(join(folder, "locked"), 0o700);
    }

    // Visuals with long Thai names: no horizontal overflow at 960×640 and 1280×800.
    await remote.goto(`${ROOT}/${LONG_DIR}`);
    await remote.at(`${ROOT}/${LONG_DIR}`);
    await local.goto(join(real, LONG_DIR));
    await local.at(`${real}/${LONG_DIR}`);
    const shots: string[] = [];
    for (const [width, height] of [[960, 640], [1280, 800]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height]);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page fits at ${width}`).toBe(true);
      for (const side of [local, remote]) {
        expect(await noOverflow(side.list), `list fits at ${width}`).toBe(true);
        expect(await noOverflow(side.section.locator(".files-toolbar")), `toolbar fits at ${width}`).toBe(true);
        // Middle truncation: the head shrinks behind an ellipsis; the differing tail stays whole.
        const [first, second] = [side.rows.nth(0), side.rows.nth(1)];
        expect(await first.locator(".file-name-head").evaluate((node) => node.scrollWidth > node.clientWidth), `long name truncates at ${width}`).toBe(true);
        const visible = (row: Locator) => row.evaluate((node) => {
          const head = node.querySelector<HTMLElement>(".file-name-head")!;
          const tail = node.querySelector<HTMLElement>(".file-name-tail")!;
          const cell = node.querySelector<HTMLElement>(".file-name")!.getBoundingClientRect();
          const box = tail.getBoundingClientRect();
          // The laid-out text, unclipped; scrollWidth rounds away a sub-pixel overflow that still ellipsizes.
          const range = document.createRange();
          range.selectNodeContents(tail);
          const whole = range.getBoundingClientRect().width <= box.width + 0.01 && box.right <= cell.right + 0.5;
          return { head: head.textContent, tail: whole ? tail.textContent : null };
        });
        const [a, b] = [await visible(first), await visible(second)];
        expect(a.head!.length, "the two names share a prefix longer than 40 characters").toBeGreaterThan(40);
        expect(a.head, "same prefix").toBe(b.head);
        expect(a.tail, `the tail is fully shown at ${width}`).not.toBeNull();
        expect(a.tail, `two long names sharing a prefix read differently at ${width}`).not.toBe(b.tail);
        // Modified dates and the current folder are never clipped without an ellipsis.
        for (const cell of await first.locator(".file-modified > span").all())
          if (await cell.isVisible()) expect(await noOverflow(cell), `modified date fits at ${width}`).toBe(true);
        const crumbs = side.section.locator(".files-crumbs");
        const [nav, current] = [await crumbs.boundingBox(), await side.current.boundingBox()];
        expect(current!.x + current!.width, `current folder inside the path bar at ${width}`).toBeLessThanOrEqual(nav!.x + nav!.width + 0.5);
        expect(current!.x, `current folder starts inside the path bar at ${width}`).toBeGreaterThanOrEqual(nav!.x - 0.5);
        await expect(side.current).toHaveAttribute("title", side === local ? `${real}/${LONG_DIR}` : `${ROOT}/${LONG_DIR}`);
        // The footer names the focused row in full.
        await first.click();
        const fullName = (await first.getAttribute("data-name"))!;
        const detail = side.section.locator("[data-testid=file-detail]");
        await expect(detail).toContainText(fullName);
        expect(await detail.evaluate((node) => node.scrollHeight <= node.clientHeight + 1), `the footer shows the whole name at ${width}`).toBe(true);
      }
      const shot = `files-${width}x${height}`;
      await testInfo.attach(shot, { body: await page.screenshot(), contentType: "image/png" });
      shots.push(shot);
    }

    // Disconnect, then Reconnect: a new generation lists the same folder.
    await remote.goto(ROOT);
    await remote.at(ROOT);
    // Hold only the close reply: main can publish Closed before renderer busy clears.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers;
      const original = handlers.get("ssterm:close-sftp")!;
      const gate = new Promise<void>((resolve) => { (globalThis as any).__sstermReleaseSftpClose = resolve; });
      ipcMain.removeHandler("ssterm:close-sftp");
      ipcMain.handle("ssterm:close-sftp", async (event, ...args) => {
        const reply = await original(event, ...args);
        await gate;
        return reply;
      });
    });
    await remote.button("Disconnect").focus();
    await page.keyboard.press("Enter");
    await expect(remote.section).toHaveAttribute("data-phase", "closed");
    await expect(remote.section.getByRole("button", { name: "Reconnect" })).toBeDisabled();
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await app.evaluate(() => { (globalThis as any).__sstermReleaseSftpClose(); });
    await expect(remote.section.getByRole("button", { name: "Reconnect" }), "focus moves to Reconnect").toBeFocused();
    await expect.poll(w.sftpProcesses, { message: "Disconnect reaped the SFTP processes", timeout: 10_000 }).toBe(0);
    await page.keyboard.press("Enter");
    await w.password(label);
    await expect(remote.section).toHaveAttribute("data-generation", "2");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await remote.at(ROOT);
    await expect(remote.list, "focus returns to the list once Ready").toBeFocused();

    // Lock closes the session with a locked outcome; Reconnect (the explicit unlock) brings it back to the same folder.
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(remote.section).toHaveAttribute("data-phase", "closed", { timeout: 10_000 });
    await expect(remote.section.locator(".pane-outcome")).toHaveText("Closed because ssterm locked (screen lock or sleep)");
    await expect.poll(w.sftpProcesses, { message: "the lock reaped the SFTP processes", timeout: 10_000 }).toBe(0);
    await remote.section.getByRole("button", { name: "Reconnect" }).click();
    await w.password(label);
    await expect(remote.section).toHaveAttribute("data-generation", "3");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await remote.at(ROOT);

    // Disconnect and Close pane return the picker; nothing is left on the server.
    await remote.button("Disconnect").click();
    await remote.button("Close pane").click();
    await expect(page.locator('section[data-pane="remote"][data-session-id]')).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Server to browse" })).toBeVisible();
    await expect.poll(w.sftpProcesses, { message: "closing reaped the SFTP processes", timeout: 10_000 }).toBe(0);
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("sftp-browser-evidence", {
      body: JSON.stringify({ port: w.lab.port, rendered, shots, platform: process.platform }),
      contentType: "application/json",
    });
  } finally {
    await app.evaluate(() => { (globalThis as any).__sstermReleaseSftpClose?.(); }).catch(() => undefined);
    await w.finish();
  }
});

test("Open in SFTP from a terminal pane uses that pane's saved host; closing SFTP leaves the terminal Ready", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { page } = desktop;
  const alpha = "เซิร์ฟเวอร์ อัลฟา";
  const bravo = "เซิร์ฟเวอร์ บราโว";
  // Same endpoint; bravo's identity has a user the server does not know, so opening bravo could never reach Ready.
  const w = await lab(desktop, [{ label: alpha, prod: true }, { label: bravo, username: "nobody-here" }]);
  try {
    await w.select(alpha);
    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${alpha}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    await w.password(alpha);
    const terminal = page.locator(`section[aria-label="Terminal for ${alpha}"]`);
    await expect(terminal).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    const screen = terminal.locator(".xterm-rows");
    await expect(screen).toContainText("fixture@", { timeout: 20_000 });

    // Viewing bravo first makes sure the menu captures the pane's host, not the last one viewed.
    await w.select(bravo);
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await terminal.getByRole("button", { name: "Pane actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open in SFTP" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Files");
    await expect(page.getByTestId("host-trust-dialog"), "the remembered key is reused").toHaveCount(0);
    await w.password(alpha);
    const remote = pane(page, "remote");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(remote.section).toHaveAttribute("aria-label", `Remote files on ${alpha}`);
    await expect(remote.section.locator(".pane-header").getByText("PROD", { exact: true })).toBeVisible();
    await expect(remote.section.locator(".host-target")).toHaveText(w.endpoint);
    await remote.at("/home/fixture");
    // The remote pane header names the server (SST-040/09 removed the global status bar).
    const status = remote.section.locator(".pane-header");
    await expect(status).toContainText(alpha);
    await expect(status).not.toContainText(bravo);
    expect(await w.sftpProcesses()).toBe(2);
    expect(await w.count("sshd: fixture@pts/")).toBe(1);

    // Opening the server already shown just shows it: same session, no new connection.
    const sessionId = (await remote.section.getAttribute("data-session-id"))!;
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await terminal.getByRole("button", { name: "Pane actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open in SFTP" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Files");
    await expect(remote.section).toHaveAttribute("data-session-id", sessionId);
    await expect(remote.section).toHaveAttribute("data-phase", "ready");
    expect(await w.sftpProcesses()).toBe(2);

    // Closing SFTP reaps its server processes; the terminal stays Ready and echoes.
    await remote.button("Disconnect").click();
    await remote.button("Close pane").click();
    await expect(page.locator('section[data-pane="remote"][data-session-id]')).toHaveCount(0);
    await expect.poll(w.sftpProcesses, { message: "closing reaped the SFTP processes", timeout: 10_000 }).toBe(0);
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await expect(terminal).toHaveAttribute("data-phase", "ready");
    await terminal.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type('echo "AFTER-SFTP-$((40+2))"');
    await page.keyboard.press("Enter");
    await expect(screen).toContainText("AFTER-SFTP-42");
    expect(await w.count("sshd: fixture@pts/")).toBe(1);
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("sftp-identity-evidence", {
      body: JSON.stringify({ port: w.lab.port, platform: process.platform }),
      contentType: "application/json",
    });
  } finally {
    // finish() quits the app and asserts no `sshd: fixture@` process remains.
    await w.finish();
  }
});
