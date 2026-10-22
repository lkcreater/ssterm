import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop, showPane, type Desktop } from "./fixtures";
import { renderedContrast } from "./support/transfer-fixture";

// Passwords stay in the owned lab directory and main's test Keychain; decrypted snippets never enter traces.
test.use({ trace: "off", screenshot: "off", video: "off" });
const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
const alpha = "เครื่องผลิต อัลฟา";
const bravo = "เครื่องพัฒนา บราโว";
const down = "เครื่องปิด ชาร์ลี";
interface Lab {
  host: string; port: number; username: string; password: string; directory: string; container: string; privateKey: Buffer;
  dispose(): Promise<void>; assertCleaned(): Promise<void>;
}
const panes = (page: Page) => page.locator("section[data-session-id]");
const ids = (page: Page) => panes(page).evaluateAll(elements => elements.map(element => element.getAttribute("data-session-id")!));
const terminal = (page: Page, id: string) => page.locator(`section[data-session-id="${id}"]`);
async function owner(page: Page) {
  const result = await page.evaluate(() => window.ssterm.bootstrap());
  if (!result.ok) throw new Error("bootstrap failed");
  return result.value.owner;
}
async function ready(pane: Locator) {
  await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
  await expect(pane.locator(".xterm-rows")).toContainText("fixture@", { timeout: 20_000 });
}
async function openTools(page: Page) {
  await page.getByRole("button", { name: /^Terminals/u }).click();
  await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
  const tools = page.getByTestId("workspace-tools");
  await expect(tools).toBeVisible();
  return tools;
}
async function closeTools(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("workspace-tools")).toHaveCount(0);
}
async function chooseSnippet(page: Page, tools: Locator, control: "Saved snippet" | "Snippet to prepare", label: string) {
  await tools.getByRole("combobox", { name: control, exact: true }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
async function saveSnippet(page: Page, label: string, body: string) {
  const result = await page.evaluate(async ({ owner, label, body }) => window.ssterm.saveSnippet({
    owner, snippetId: null, expectedRevision: null, label, body, tagIds: [],
  }), { owner: await owner(page), label, body });
  if (!result.ok || result.value.status !== "saved") throw new Error("fixture snippet save failed");
  return result.value.snippetId;
}

/** Observe the shipped input handler, without retaining commands or replacing production terminal resources. */
async function observeMain(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> })._invokeHandlers;
    const write = handlers.get("ssterm:write-terminal")!;
    const open = handlers.get("ssterm:open-snippet")!;
    if (!write || !open) throw new Error("shipped handlers unavailable");
    const state = { writes: [] as { sessionId: string; generation: number; accepted: boolean }[], held: false, pending: 0,
      releases: [] as (() => void)[] };
    ipcMain.removeHandler("ssterm:write-terminal");
    ipcMain.handle("ssterm:write-terminal", async (...args: any[]) => {
      const result = await write(...args);
      state.writes.push({ sessionId: args[1].sessionId, generation: args[1].generation, accepted: !!result.ok });
      return result;
    });
    ipcMain.removeHandler("ssterm:open-snippet");
    ipcMain.handle("ssterm:open-snippet", async (...args: any[]) => {
      const result = await open(...args);
      if (state.held) {
        state.pending += 1;
        await new Promise<void>(done => state.releases.push(done));
        state.pending -= 1;
      }
      return result;
    });
    (globalThis as any).__workspaceToolsEvidence = state;
  });
}
const writes = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__workspaceToolsEvidence.writes as { sessionId: string; generation: number; accepted: boolean }[]);
const holdDecrypt = (app: ElectronApplication, held: boolean) => app.evaluate((_electron, held) => {
  const state = (globalThis as any).__workspaceToolsEvidence;
  state.held = held;
  if (!held) for (const release of state.releases.splice(0)) release();
}, held);
const decryptPending = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__workspaceToolsEvidence.pending as number);

/** Two actual servers, each with a distinct password, reached through saved-host production main. */
async function setup(initial: Desktop) {
  let desktop = initial;
  const labs: Lab[] = [];
  const finish = async () => {
    let failure: unknown;
    try { await desktop.close(); } catch (error) { failure = error; }
    for (const lab of labs) {
      lab.privateKey.fill(0);
      try { await lab.dispose(); await lab.assertCleaned(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
  try {
    labs.push(await startFixture());
    labs.push(await startFixture());
    const hosts: string[] = [];
    const identityIds: string[] = [];
    for (const [index, lab] of labs.entries()) {
      const [identityId, hostId] = await changeCatalog(desktop.app, [
        { type: "create-identity", data: { label: `Workspace lab ${index}`, username: lab.username, method: "password" } },
        { type: "create-host", data: { label: index === 0 ? alpha : bravo, address: lab.host,
          environment: index === 0 ? "PROD" : "DEV", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
      ]);
      hosts.push(hostId!);
      identityIds.push(identityId!);
      const file = join(lab.directory, "workspace-password");
      await writeFile(file, lab.password, { mode: 0o600 });
      // Read in main and invoke the actual bridge, returning status only; no password enters the runner protocol.
      const saved = await desktop.app.evaluate(async ({ BrowserWindow }, { file, identityId }) => {
        const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
        return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(async () => {
          const boot = await window.ssterm.bootstrap();
          const state = await window.ssterm.catalogState({ owner: boot.value.owner });
          const identity = state.value.identities.find(row => row.id === ${JSON.stringify(identityId)});
          const result = await window.ssterm.setIdentityPassword({ owner: boot.value.owner, identityId: identity.id,
            expectedRevision: identity.revision, value: new TextEncoder().encode(${JSON.stringify(value)}) });
          return result.ok ? result.value.status : result.error.code;
        })()`);
      }, { file, identityId });
      expect(saved).toBe("saved");
    }
    const [downId] = await changeCatalog(desktop.app, [{ type: "create-host", data: { label: down, address: "127.0.0.1",
      port: { mode: "value", port: 1 }, auth: { mode: "value", identityId: identityIds[0] } } }]);
    // Refused loopback endpoint is deliberate; it remains a failed target alongside successful peers.
    hosts.push(downId!);
    await desktop.page.reload();
    await observeMain(desktop.app);
    return {
      get desktop() { return desktop; }, labs, hosts, finish,
      async relaunch() {
        const { profile, secretNamespace } = desktop;
        await desktop.close({ keepSecrets: true });
        desktop = await launchDesktop(profile, { secretNamespace });
        await observeMain(desktop.app);
        return desktop;
      },
      async connect(label: string, trust = false) {
        const { page } = desktop;
        const before = await ids(page);
        await page.getByRole("button", { name: /^All servers/u }).click();
        await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${label}`, exact: true }).click();
        if (trust) await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
        let id = "";
        await expect.poll(async () => id = (await ids(page)).find(id => !before.includes(id)) ?? "").not.toBe("");
        const pane = terminal(page, id);
        await ready(pane);
        return pane;
      },
      async shells() {
        return Promise.all(labs.map(async lab => {
          try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", "sshd: fixture@"])).stdout.trim()); }
          catch (error) { if ((error as { code?: number }).code === 1) return 0; throw new Error("owned shell count unavailable"); }
        }));
      },
    };
  } catch (error) { await finish().catch(() => undefined); throw error; }
}

async function templates(page: Page) {
  const response = await page.evaluate(async owner => window.ssterm.workspaceTemplates({ owner }), await owner(page));
  if (!response.ok) throw new Error("template listing failed");
  return response.value.templates;
}

test("templates persist configuration across relaunch, restore fresh tabs/splits/focus without writes, append safely and report missing references", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const w = await setup(desktop);
  try {
    let { app, page } = w.desktop;
    await saveSnippet(page, "ตรวจสอบ ไทย", 'echo "TEMPLATE-$((6*7))"');
    const a = await w.connect(alpha, true);
    const beforeSplit = await ids(page);
    await a.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+d");
    let splitId = "";
    await expect.poll(async () => splitId = (await ids(page)).find(id => !beforeSplit.includes(id)) ?? "").not.toBe("");
    await ready(terminal(page, splitId));
    const separator = page.getByRole("separator", { name: "Resize panes left and right" });
    await separator.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "60");
    await terminal(page, splitId).locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+Shift+Enter");
    await expect(a).toBeHidden();
    await w.connect(bravo, true);
    await page.keyboard.press("Meta+1");
    const original = await ids(page);
    let tools = await openTools(page);
    await tools.getByLabel("Template name", { exact: true }).fill("ห้องทำงาน ไทย");
    await chooseSnippet(page, tools, "Saved snippet", "ตรวจสอบ ไทย");
    await expect(tools.getByRole("checkbox", { name: "Prepare saved snippet", exact: true })).not.toBeChecked();
    await tools.getByRole("button", { name: "Save workspace template", exact: true }).click();
    await expect(tools.getByRole("button", { name: "Restore ห้องทำงาน ไทย", exact: true })).toBeVisible();
    const [saved] = await templates(page);
    expect(saved!.configuration.tabs).toHaveLength(2);
    expect(saved!.configuration.activeTab).toBe(0);
    expect(saved!.configuration.tabs[0]!.mode).toBe("focus");
    expect(saved!.configuration.tabs[0]!.root).toMatchObject({ kind: "split", direction: "row" });
    expect(saved!.configuration.tabs[0]!.root.kind === "split" && saved!.configuration.tabs[0]!.root.ratio).toBeCloseTo(0.6);
    expect(saved!.configuration.snippetId).not.toBeNull();
    const serialized = JSON.stringify(saved!.configuration);
    for (const sessionId of original) expect(serialized).not.toContain(sessionId);
    expect(serialized).not.toContain("TEMPLATE");
    expect(await writes(app)).toEqual([]);

    // Same binary, profile and namespace: saved references survive, live sessions do not.
    ({ app, page } = await w.relaunch());
    await expect(panes(page)).toHaveCount(0);
    tools = await openTools(page);
    await expect(tools.getByRole("checkbox", { name: "Prepare saved snippet", exact: true })).not.toBeChecked();
    expect((await templates(page))[0]!.configuration).toEqual(saved!.configuration);
    await tools.getByRole("button", { name: "Restore ห้องทำงาน ไทย", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("3 of 3 targets ready", { timeout: 30_000 });
    const restored = await ids(page);
    expect(restored).toHaveLength(3);
    for (const id of restored) expect(original).not.toContain(id);
    for (const id of restored) await ready(terminal(page, id));
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toHaveValue("");
    await expect(tools.getByTestId("broadcast-armed")).toHaveCount(0);
    expect(await writes(app), "restoring configuration never sends commands").toEqual([]);
    await closeTools(page);
    const tabs = page.getByRole("tablist", { name: "Terminal tabs" }).getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("group", { name: "Focused pane", exact: true })).toBeVisible();
    await page.keyboard.press("Meta+Shift+Enter");
    await expect(page.getByRole("separator", { name: "Resize panes left and right" })).toHaveAttribute("aria-valuenow", "60");
    expect(await panes(page).filter({ visible: true }).count()).toBe(2);

    // A second restore appends fresh sessions and leaves the existing xterm nodes mounted.
    await terminal(page, restored[0]!).evaluate(element => element.setAttribute("data-restoration-sentinel", "kept"));
    tools = await openTools(page);
    await tools.getByRole("checkbox", { name: "Prepare saved snippet", exact: true }).check();
    await tools.getByRole("button", { name: "Restore ห้องทำงาน ไทย", exact: true }).click();
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toHaveValue('echo "TEMPLATE-$((6*7))"', { timeout: 30_000 });
    await expect(tools.getByTestId("broadcast-armed")).toHaveCount(0);
    await expect(panes(page)).toHaveCount(6);
    for (const id of restored) expect(await ids(page)).toContain(id);
    await expect(terminal(page, restored[0]!)).toHaveAttribute("data-restoration-sentinel", "kept");
    expect(await writes(app)).toEqual([]);
    await closeTools(page);
    await expect(tabs).toHaveCount(4);

    // 960×640, reduced motion: safe empty composer, a right-edge drawer inside the window, readable labels and keyboard close.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 640));
    await expect.poll(() => page.evaluate(() => `${innerWidth}x${innerHeight}`)).toBe("960x640");
    tools = await openTools(page);
    await expect(tools.getByLabel("Template name", { exact: true })).toBeFocused();
    const bounds = await tools.evaluate(element => {
      const b = element.getBoundingClientRect();
      return { fits: b.left >= 0 && b.top >= 0 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5,
        overflow: element.scrollWidth - element.clientWidth };
    });
    expect(bounds).toEqual({ fits: true, overflow: 0 });
    expect(Math.abs(await tools.evaluate(element => innerWidth - element.getBoundingClientRect().right)), "right edge").toBeLessThanOrEqual(0.5);
    expect((await renderedContrast(tools.locator("h2").first())).ratio).toBeGreaterThanOrEqual(4.5);
    expect((await renderedContrast(tools.locator("p.text-muted-foreground").first())).ratio).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: testInfo.outputPath("workspace-tools-960x640-empty.png"), animations: "disabled" });
    await tools.getByRole("checkbox", { name: new RegExp(`^${alpha} · Session `, "u") }).first().check();
    await tools.getByRole("checkbox", { name: new RegExp(`^${bravo} · Session `, "u") }).first().check();
    await tools.getByRole("button", { name: "Prepare targets", exact: true }).click();
    const visibleTargets = tools.getByRole("list", { name: "Captured targets", exact: true });
    await visibleTargets.scrollIntoViewIfNeeded();
    await expect(visibleTargets).toContainText("PROD");
    for (const text of [visibleTargets.locator("span.font-medium").first(), visibleTargets.locator(".host-target").first()])
      expect((await renderedContrast(text)).ratio).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: testInfo.outputPath("workspace-targets-960x640-empty.png"), animations: "disabled" });
    await closeTools(page);
    await expect(page.locator('section[data-active="true"] .xterm-helper-textarea')).toBeFocused().catch(async error => {
      await testInfo.attach("focus-after-tools", { contentType: "application/json", body: JSON.stringify(await page.evaluate(() => ({
        focusedPane: document.activeElement?.closest("section[data-session-id]")?.getAttribute("data-session-id"),
        focusedControl: document.activeElement?.getAttribute("aria-label"),
        activePane: document.querySelector('section[data-active="true"]')?.getAttribute("data-session-id"),
      }))) });
      throw error;
    });

    // Deleted snippet references and deleted hosts both stop restore visibly, with no substitution.
    const deletedSnippet = await page.evaluate(async ({ owner, snippetId }) => {
      const state = await window.ssterm.catalogState({ owner });
      if (!state.ok) return false;
      const snippet = state.value.snippets.find(snippet => snippet.id === snippetId)!;
      const result = await window.ssterm.deleteSnippet({ owner, snippetId, expectedRevision: snippet.revision });
      return result.ok;
    }, { owner: await owner(page), snippetId: saved!.configuration.snippetId! });
    expect(deletedSnippet).toBe(true);
    tools = await openTools(page);
    await tools.getByRole("checkbox", { name: "Prepare saved snippet", exact: true }).check();
    await tools.getByRole("button", { name: "Restore ห้องทำงาน ไทย", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("missing saved snippet");
    await expect(panes(page)).toHaveCount(6);
    await tools.getByRole("checkbox", { name: "Prepare saved snippet", exact: true }).uncheck();
    await tools.getByRole("button", { name: "Restore ห้องทำงาน ไทย", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("3 of 3 targets ready", { timeout: 30_000 });
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("saved snippet is missing");
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toHaveValue("");
    await expect(panes(page)).toHaveCount(9);
    await closeTools(page);
    await changeCatalog(app, [{ type: "delete-host", id: w.hosts[0], expectedRevision: "current" }]);
    await page.reload();
    const beforeMissing = await ids(page);
    tools = await openTools(page);
    await tools.getByRole("button", { name: "Restore ห้องทำงาน ไทย", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("Missing saved hosts");
    expect(await ids(page)).toEqual(beforeMissing);
    expect(await writes(app)).toEqual([]);
    await tools.getByRole("button", { name: "Delete ห้องทำงาน ไทย", exact: true }).click();
    await expect(tools.getByRole("button", { name: "Restore ห้องทำงาน ไทย", exact: true })).toHaveCount(0);
    expect(await templates(page)).toEqual([]);
    expect(w.desktop.errors).toEqual([]);
    expect(w.desktop.externalRequests).toEqual([]);
  } finally { await w.finish(); }
});

async function selectExisting(tools: Locator, label: string) {
  await tools.getByRole("checkbox", { name: new RegExp(`^${label} · Session `, "u") }).check();
}
async function prepareExisting(page: Page, labels: string[]) {
  const tools = await openTools(page);
  for (const label of labels) await selectExisting(tools, label);
  await tools.getByRole("button", { name: "Prepare targets", exact: true }).click();
  await expect(tools.getByTestId("workspace-tools-feedback")).toContainText(`${labels.length} existing targets captured`);
  return tools;
}
async function arm(tools: Locator) {
  await tools.getByRole("button", { name: "Arm broadcast", exact: true }).click();
  await expect(tools.getByTestId("broadcast-armed")).toBeVisible();
}

test("broadcast captures recipients through delayed decrypt, arms explicitly, separates Insert/Run, refuses stale generations and purges late text on lock", async ({ desktop }) => {
  test.setTimeout(300_000);
  const w = await setup(desktop);
  try {
    const { app, page } = w.desktop;
    const snippet = 'echo "CAPTURE-$((5*5))"';
    await saveSnippet(page, "Captured recipients", snippet);
    const a = await w.connect(alpha, true);
    const b = await w.connect(bravo, true);
    const originalIds = await ids(page);
    const aId = (await a.getAttribute("data-session-id"))!;
    const bId = (await b.getAttribute("data-session-id"))!;
    let tools = await prepareExisting(page, [bravo]);
    expect(await ids(page), "Existing mode opens no sessions").toEqual(originalIds);
    await chooseSnippet(page, tools, "Snippet to prepare", "Captured recipients");
    await holdDecrypt(app, true);
    await tools.getByRole("button", { name: "Load snippet to composer", exact: true }).click();
    await expect.poll(() => decryptPending(app)).toBe(1);
    await expect(tools.getByRole("checkbox", { name: new RegExp(`^${alpha} · Session `, "u") })).toBeDisabled();
    // Deliberately change workspace selection behind the modal while the production decrypt reply waits.
    await page.locator('[role="tablist"][aria-label="Terminal tabs"] [role="tab"]').nth(0).evaluate((element: HTMLElement) => element.click());
    await holdDecrypt(app, false);
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toHaveValue(snippet);
    await expect(tools.getByRole("list", { name: "Captured targets", exact: true })).toContainText(bravo);
    await expect(tools.getByRole("list", { name: "Captured targets", exact: true })).not.toContainText(alpha);
    expect(await writes(app)).toEqual([]);
    await arm(tools);
    await tools.getByRole("button", { name: "Disarm", exact: true }).click();
    await expect(tools.getByRole("button", { name: "Run on targets", exact: true })).toBeDisabled();
    expect(await writes(app)).toEqual([]);
    await arm(tools);
    await tools.getByRole("button", { name: "Run on targets", exact: true }).click();
    await expect(tools.getByTestId("multi-target-results")).toContainText("Bytes accepted");
    await expect(b.locator(".xterm-rows")).toContainText("CAPTURE-25");
    await expect(a.locator(".xterm-rows")).not.toContainText("CAPTURE-25");
    expect(await writes(app)).toEqual([{ sessionId: bId, generation: Number(await b.getAttribute("data-generation")), accepted: true }]);
    await closeTools(page);

    // Multi-target Insert puts text at both prompts without Enter; no arithmetic output exists yet.
    tools = await prepareExisting(page, [alpha, bravo]);
    await expect(tools.getByRole("list", { name: "Captured targets", exact: true })).toContainText("PROD");
    await tools.getByLabel("Multi-target input", { exact: true }).fill('echo "INSERT-$((3+4))"');
    const beforeInsert = (await writes(app)).length;
    await arm(tools);
    await tools.getByRole("button", { name: "Insert without Enter", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("2 of 2 targets accepted bytes");
    await expect(a.locator(".xterm-rows")).not.toContainText("INSERT-7");
    await expect(b.locator(".xterm-rows")).not.toContainText("INSERT-7");
    expect((await writes(app)).length).toBe(beforeInsert + 2);
    await closeTools(page);
    for (const pane of [a, b]) {
      await showPane(page, pane);
      await pane.locator(".xterm-helper-textarea").focus();
      await page.keyboard.press("Enter");
      await expect(pane.locator(".xterm-rows")).toContainText("INSERT-7");
    }
    // Ordinary typing remains local after arming has ended.
    await showPane(page, a);
    await a.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type('echo "LOCAL-$((9*9))"');
    await page.keyboard.press("Enter");
    await expect(a.locator(".xterm-rows")).toContainText("LOCAL-81");
    await expect(b.locator(".xterm-rows")).not.toContainText("LOCAL-81");

    tools = await prepareExisting(page, [alpha, bravo]);
    await tools.getByLabel("Multi-target input", { exact: true }).fill('echo "MULTI-$((6*7))"');
    const beforeRun = (await writes(app)).length;
    await arm(tools);
    await tools.getByRole("button", { name: "Run on targets", exact: true }).click();
    const confirm = page.getByTestId("multi-target-confirm");
    await expect(confirm).toContainText(alpha);
    await expect(confirm).toContainText(bravo);
    await expect(confirm).toContainText("PROD");
    // A step inside the same drawer, not a stacked dialog; Esc and Cancel leave it without sending.
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(tools.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(tools).toBeVisible();
    await arm(tools);
    await tools.getByRole("button", { name: "Run on targets", exact: true }).click();
    await tools.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await writes(app)).length).toBe(beforeRun);
    await arm(tools);
    await tools.getByRole("button", { name: "Run on targets", exact: true }).click();
    // A double click: the second click lands on the footer Close that replaces Confirm Run and must not abort the send.
    await tools.getByRole("button", { name: "Confirm Run", exact: true }).dblclick();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("2 of 2 targets accepted bytes");
    await expect(tools).toBeVisible();
    await expect(tools.getByLabel("Multi-target input", { exact: true }), "focus returns to a usable control").toBeFocused();
    for (const pane of [a, b]) await expect(pane.locator(".xterm-rows")).toContainText("MULTI-42");
    expect((await writes(app)).length).toBe(beforeRun + 2);

    // An explicitly reconnected generation is no longer the captured recipient, even under the same ID.
    await tools.getByLabel("Multi-target input", { exact: true }).fill('echo "STALE-$((2*8))"');
    const generation = Number(await b.getAttribute("data-generation"));
    const closed = await page.evaluate(async target => window.ssterm.closeTerminal(target), {
      owner: await owner(page), sessionId: bId, generation,
    });
    expect(closed.ok).toBe(true);
    await expect(b).toHaveAttribute("data-phase", "closed");
    const reconnected = await page.evaluate(async target => window.ssterm.reconnectTerminal(target), {
      owner: await owner(page), sessionId: bId, generation,
    });
    expect(reconnected.ok).toBe(true);
    await expect(b).toHaveAttribute("data-generation", String(generation + 1));
    await ready(b);
    const beforeStale = (await writes(app)).length;
    await arm(tools);
    await tools.getByRole("button", { name: "Run on targets", exact: true }).click();
    await tools.getByRole("button", { name: "Confirm Run", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("1 of 2 targets accepted bytes");
    await expect(tools.getByTestId("multi-target-results")).toContainText("refused");
    await expect(a.locator(".xterm-rows")).toContainText("STALE-16");
    await expect(b.locator(".xterm-rows")).not.toContainText("STALE-16");
    const staleReceipts = (await writes(app)).slice(beforeStale);
    expect(staleReceipts.map(receipt => receipt.sessionId)).toEqual([aId]);

    // A cancellation discards a reply which already decrypted, and keeps Ready sessions available.
    await tools.getByRole("button", { name: "Reset targets", exact: true }).click();
    await selectExisting(tools, bravo);
    await tools.getByRole("button", { name: "Prepare targets", exact: true }).click();
    await chooseSnippet(page, tools, "Snippet to prepare", "Captured recipients");
    await holdDecrypt(app, true);
    await tools.getByRole("button", { name: "Load snippet to composer", exact: true }).click();
    await expect.poll(() => decryptPending(app)).toBe(1);
    const beforeCancel = (await writes(app)).length;
    await tools.getByRole("button", { name: "Cancel operation", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("Cancelled");
    await holdDecrypt(app, false);
    await expect(tools.getByRole("button", { name: "Cancel operation", exact: true })).toHaveCount(0);
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toHaveValue("");
    await ready(b);
    expect((await writes(app)).length).toBe(beforeCancel);

    // A screen lock resets the composer and fences another late decrypt response.
    await holdDecrypt(app, true);
    await tools.getByRole("button", { name: "Load snippet to composer", exact: true }).click();
    await expect.poll(() => decryptPending(app)).toBe(1);
    const beforeLock = (await writes(app)).length;
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toHaveValue("");
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toBeDisabled();
    await expect(tools.getByTestId("broadcast-armed")).toHaveCount(0);
    await holdDecrypt(app, false);
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toHaveValue("");
    await expect.poll(() => decryptPending(app)).toBe(0);
    expect((await writes(app)).length).toBe(beforeLock);
    expect(await page.locator("textarea").evaluateAll(elements => elements.some(element => (element as HTMLTextAreaElement).value.includes("CAPTURE")))).toBe(false);
    await expect.poll(w.shells, { timeout: 10_000 }).toEqual([0, 0]);
    expect(w.desktop.errors).toEqual([]);
  } finally {
    await holdDecrypt(w.desktop.app, false).catch(() => undefined);
    await w.finish();
  }
});

test("New mode creates fresh real sessions, exposes partial failure and cancels only operation-created connecting sessions", async ({ desktop }) => {
  test.setTimeout(240_000);
  const w = await setup(desktop);
  let paused = false;
  try {
    const { app, page } = w.desktop;
    await w.connect(alpha, true);
    // Bravo is deliberately untrusted: its real trust prompt must remain usable above Workspace tools.
    const before = await ids(page);
    let tools = await openTools(page);
    await tools.getByRole("button", { name: "New sessions", exact: true }).click();
    for (const label of [alpha, bravo, down]) await tools.getByRole("checkbox", { name: label, exact: true }).check();
    await tools.getByRole("button", { name: "Prepare targets", exact: true }).click();
    const trust = page.getByTestId("host-trust-dialog");
    await expect(trust).toContainText(bravo);
    await trust.getByRole("button", { name: "Remember", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("2 of 3 targets ready", { timeout: 30_000 });
    await expect(tools.getByRole("list", { name: "Connection preparation", exact: true })).toContainText("failed");
    const created = (await ids(page)).filter(id => !before.includes(id));
    expect(created).toHaveLength(3);
    expect(await panes(page).evaluateAll(elements => elements.filter(element => element.getAttribute("data-phase") === "failed").length)).toBe(1);
    expect(await writes(app)).toEqual([]);
    for (const id of before) await ready(terminal(page, id));
    await closeTools(page);

    // Pause only our second container to hold a genuine SSH handshake while the first reaches Ready.
    await runFile("docker", ["pause", w.labs[1]!.container]);
    paused = true;
    const beforeCancel = await ids(page);
    tools = await openTools(page);
    await tools.getByRole("button", { name: "New sessions", exact: true }).click();
    for (const label of [alpha, bravo]) await tools.getByRole("checkbox", { name: label, exact: true }).check();
    await tools.getByRole("button", { name: "Prepare targets", exact: true }).click();
    const progress = tools.getByRole("list", { name: "Connection preparation", exact: true });
    await expect(progress.getByRole("listitem").filter({ hasText: alpha })).toContainText("ready", { timeout: 20_000 });
    await expect(progress.getByRole("listitem").filter({ hasText: bravo })).toContainText("connecting");
    const pending = (await ids(page)).filter(id => !beforeCancel.includes(id));
    expect(pending).toHaveLength(2);
    await tools.getByRole("button", { name: "Cancel operation", exact: true }).click();
    await expect(tools.getByTestId("workspace-tools-feedback")).toContainText("Cancelled");
    await expect(tools.getByRole("button", { name: "Cancel operation", exact: true })).toHaveCount(0);
    const cancelledPane = panes(page).filter({ hasText: bravo }).filter({ has: page.locator(".live-terminal-notice") });
    await expect(cancelledPane).toHaveCount(1);
    const phases = await Promise.all(pending.map(id => terminal(page, id).getAttribute("data-phase")));
    expect(phases.sort()).toEqual(["closed", "ready"]);
    for (const id of before) await expect(terminal(page, id)).toHaveAttribute("data-phase", "ready");
    await runFile("docker", ["unpause", w.labs[1]!.container]);
    paused = false;
    expect(await writes(app)).toEqual([]);
    await expect(tools.getByLabel("Multi-target input", { exact: true })).toHaveValue("");
    expect(w.desktop.errors).toEqual([]);
    expect(w.desktop.externalRequests).toEqual([]);
  } finally {
    if (paused) await runFile("docker", ["unpause", w.labs[1]!.container]).catch(() => undefined);
    await w.finish();
  }
});
