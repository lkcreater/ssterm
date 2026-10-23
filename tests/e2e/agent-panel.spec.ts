import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop, showPane, type Desktop } from "./fixtures";
import { audit } from "./support/audit";

// SST-041 ticket 03 through production main and renderer: Settings › AI Agent consent, the AI Agent button and panel,
// and the agent runner launching a FAKE claude CLI (tests/fixtures/agent/fake-claude.mjs; no provider is contacted)
// that reaches ssterm's MCP endpoint through the shipped ssterm-mcp bridge. Docker OpenSSH fixture with a saved password.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
const server = "เอเจนต์ พาเนล";

const pgrep = async (pattern: string) => {
  try { return (await runFile("pgrep", ["-f", pattern])).stdout.trim().split("\n").filter(Boolean).length; }
  catch (error) { if ((error as { code?: number }).code === 1) return 0; throw error; }
};
async function openSettings(page: Page) {
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "AI Agent" }).click();
  return dialog;
}

test("AI Agent: consent gating, Ready SSH only, delegate → commands in the pane → summary from ssterm's record, queueing, cleanup on close/lock/session end", async ({}, testInfo) => {
  test.setTimeout(420_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-agent-panel-"));
  const home = join(profile, "agent-home");
  const localHome = join(profile, "local-home");
  await mkdir(home);
  await mkdir(localHome);
  await writeFile(join(localHome, ".zshrc"), "PS1='agent-local%# '\n");
  // The provider binary the test seam names: a wrapper running the fake CLI with this test's Node.
  const cli = join(profile, "claude");
  await writeFile(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve("tests/fixtures/agent/fake-claude.mjs")}' "$@"\n`, { mode: 0o755 });
  const lab = await startFixture();
  const remote = async (pattern: string) => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", pattern])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw error; }
  };
  const launches = () => existsSync(join(home, "fake-claude.log"))
    ? readFileSync(join(home, "fake-claude.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const socketPattern = `nc -U .*${profile.split("/").at(-1)}`;
  /** No CLI, bridge or residue left, and every run folder removed. */
  const expectCleaned = async (label: string) => {
    await expect.poll(() => pgrep("fake-claude.mjs"), { message: `${label}: CLI processes` }).toBe(0);
    await expect.poll(() => pgrep(socketPattern), { message: `${label}: bridges` }).toBe(0);
    await expect.poll(() => readdirSync(join(home, "Library/Caches/claude-cli-nodejs")).length, { message: `${label}: cache residue` }).toBe(0);
    await expect.poll(() => readdirSync(join(home, ".claude/sessions")).length, { message: `${label}: session residue` }).toBe(0);
    for (const launch of launches()) expect(existsSync(dirname(launch.cwd)), `${label}: run folder`).toBe(false);
  };
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { env: { SSTERM_TEST_AGENT_CLI: cli, SSTERM_TEST_AGENT_HOME: home, SSTERM_TEST_LOCAL_HOME: localHome } });
    const { app, page } = desktop;
    await runFile("docker", ["exec", "-u", "fixture", lab.container, "python3", "-c",
      "import os\nos.makedirs('/home/fixture/agent', exist_ok=True)\nopen('/home/fixture/agent/note.txt','w').write('AGENT-NOTE-42\\n')"]);
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    const [identityId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "Agent panel lab", username: lab.username, method: "password" } },
      { type: "create-host", data: { label: server, address: lab.host, environment: "PROD", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(server);
    expect(await app.evaluate(async ({ BrowserWindow }, { file, identityId }) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(async () => {
        const boot = await window.ssterm.bootstrap();
        const saved = await window.ssterm.setIdentityPassword({ owner: boot.value.owner, identityId: ${JSON.stringify(identityId)},
          expectedRevision: 1, value: new TextEncoder().encode(${JSON.stringify(value)}) });
        return saved.ok ? saved.value.status : saved.error.code; })()`);
    }, { file: secret, identityId })).toBe("saved");
    const pid = await app.evaluate(() => process.pid);
    const tcpListeners = async () => {
      try { return (await runFile("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])).stdout.split("\n").filter((line) => line.startsWith("n")).sort(); }
      catch (error) { if ((error as { code?: number }).code === 1) return []; throw error; }
    };
    const listenersBefore = await tcpListeners();

    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${server}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const pane = page.locator("section[data-terminal-kind=ssh]").first();
    const rows = pane.locator(".xterm-rows");
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });
    const sessionId = (await pane.getAttribute("data-session-id"))!;

    // 1. Off by default: no button, and main refuses to open or to turn on without consent.
    await expect(pane.getByRole("button", { name: "AI Agent" })).toHaveCount(0);
    const owner = await page.evaluate(async () => { const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("bootstrap"); return boot.value.owner; });
    expect(await page.evaluate(async ({ owner, sessionId }) => (await window.ssterm.openAgent({ owner, sessionId, generation: 1 })), { owner, sessionId }))
      .toEqual({ ok: true, value: { status: "refused", reason: "disabled" } });
    const settingsFor = (model: string) => ({ enabled: true, provider: "claude" as const, model, effort: "xhigh" as const, instructions: "", allowFullAllowOnProd: false, custom: null });
    expect(await page.evaluate(async ({ owner, settings }) => (await window.ssterm.configureAgent({ owner, consent: false, settings })), { owner, settings: settingsFor("claude-haiku-5-5") }))
      .toEqual({ ok: true, value: { status: "consent-required" } });
    // A14: only isolation-verified models run (claude-sonnet-5-5 is not verified); a custom ID must be a strict token.
    expect(await page.evaluate(async ({ owner, settings }) => (await window.ssterm.configureAgent({ owner, consent: true, settings })), { owner, settings: settingsFor("claude-sonnet-5-5") }))
      .toEqual({ ok: true, value: { status: "model-unverified" } });
    expect(await page.evaluate(async ({ owner, settings }) => (await window.ssterm.configureAgent({ owner, consent: true, settings })), { owner, settings: settingsFor("--dangerously") }))
      .toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(launches(), "nothing was launched").toEqual([]);

    // 2. Settings › AI Agent: the verified provider, codex disabled, the A3 disclosure, then consent.
    const settings = await openSettings(page);
    const agentSettings = settings.getByTestId("agent-settings");
    await expect(agentSettings.getByTestId("agent-providers")).toContainText("2.1.309 · Verified");
    await expect(agentSettings.getByTestId("agent-providers")).toContainText("Disabled: its isolation check failed");
    await agentSettings.getByRole("switch", { name: "Use the AI agent" }).click();
    const disclosure = agentSettings.getByTestId("agent-disclosure");
    for (const text of ["Anthropic", "retention and training terms", "full output", "user@host:port", "temporary working-folder path",
      "macOS version", "today's date", "account email", "Never sent by ssterm"]) await expect(disclosure).toContainText(text);
    const turnOn = agentSettings.getByRole("button", { name: "Turn on AI agent" });
    await expect(turnOn).toBeDisabled();
    await agentSettings.getByRole("checkbox", { name: "I understand what is sent to Anthropic" }).click();
    await turnOn.click();
    await expect(agentSettings.getByRole("switch", { name: "Use the AI agent" })).toBeChecked();
    // A14: the bundled list with full IDs and aliases; the default is Opus 5.5 (verified by user decision) at effort xhigh.
    await expect(agentSettings.getByRole("combobox", { name: "Model" })).toContainText("Claude Opus 5.5 (claude-opus-5-5, opus)");
    const effort = agentSettings.getByRole("group", { name: "Effort", exact: true });
    await expect(effort.getByRole("radio", { name: "xhigh" }).or(effort.getByRole("button", { name: "xhigh" }))).toHaveAttribute("aria-pressed", "true");
    await agentSettings.getByLabel("Custom model ID").fill("-p");
    await expect(agentSettings.getByText("Use letters, digits and . _ : - only, not starting with -.")).toBeVisible();
    await agentSettings.getByLabel("Custom model ID").fill("my-model");
    await agentSettings.getByRole("button", { name: "Use", exact: true }).click();
    await expect(agentSettings).toContainText("has not passed ssterm's isolation check");
    await agentSettings.getByLabel("Custom model ID").fill("");
    await agentSettings.getByLabel("Additional instructions").fill("Prefer journalctl over log files.");
    await agentSettings.getByRole("button", { name: "Save instructions" }).click();
    await expect(agentSettings.getByRole("button", { name: "Save instructions" })).toBeDisabled();
    await settings.getByRole("button", { name: "Done" }).click();
    await expect(settings).toHaveCount(0);
    const stored = JSON.parse(readFileSync(join(profile, "agent-settings.json"), "utf8"));
    expect(stored).toEqual({ version: 3, enabled: true, provider: "claude", model: "claude-opus-5-5", effort: "xhigh", instructions: "Prefer journalctl over log files.", allowFullAllowOnProd: false, custom: null, customCheck: null, disclosure: 1 });

    // 3. The button: Ready SSH panes only, never a local terminal.
    const agentButton = pane.getByRole("button", { name: "AI Agent" });
    await expect(agentButton).toBeVisible();
    await page.getByRole("button", { name: "New local terminal", exact: true }).first().click();
    const local = page.locator("section[data-terminal-kind=local]");
    await expect(local).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(local.getByRole("button", { name: "Pane actions" })).toBeVisible();
    await expect(local.getByRole("button", { name: "AI Agent" })).toHaveCount(0);
    await showPane(page, pane);

    // 4. The panel: non-modal, bound to this session, target/PROD header and the provider banner.
    await agentButton.click();
    const panel = page.getByTestId("agent-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-session-id", sessionId);
    await expect(panel.getByTestId("agent-target")).toContainText(server);
    await expect(panel.getByTestId("agent-target")).toContainText(`${lab.username}@${lab.host}:${lab.port}`);
    await expect(panel.getByTestId("agent-target")).toContainText("PROD");
    await expect(panel.getByTestId("agent-provider-banner")).toContainText("sent to Anthropic");
    await expect(panel.getByTestId("agent-model")).toHaveText("Claude Opus 5.5 · effort xhigh");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type('echo "PANEL-$((40+2))"');
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("PANEL-42");
    const panelBox = (await panel.boundingBox())!;
    const paneBox = (await pane.boundingBox())!;
    expect(paneBox.x + paneBox.width, "the panel sits beside the terminal, not over it").toBeLessThanOrEqual(panelBox.x + 1);

    // Ticket 04: every conversation starts in Auto; classification is labelled best effort. This one is switched to Read only.
    const modes = panel.getByTestId("agent-mode");
    await expect(modes).toHaveAttribute("data-mode", "auto");
    await expect(panel.getByTestId("agent-mode-note")).toContainText("Read-only classification is best effort");
    await modes.getByRole("button", { name: "Read only", exact: true }).click();
    await expect(modes).toHaveAttribute("data-mode", "read-only");
    await expect(modes.getByRole("button", { name: "Read only", exact: true })).toHaveAttribute("aria-pressed", "true");

    // 5. Chat → delegate_task → sub agent commands typed in the pane → summary from ssterm's record. Read only refuses touch.
    const composer = panel.getByLabel("Message to the agent");
    const messages = panel.getByTestId("agent-messages");
    await composer.fill("delegate:run:cat /home/fixture/agent/note.txt;;touch /tmp/agent-canary");
    await composer.press("Enter");
    await expect(messages).toContainText("Delegated task-1.", { timeout: 30_000 });
    await expect(messages).toContainText("Summary task-1 (completed): cat /home/fixture/agent/note.txt -> exit 0: AGENT-NOTE-42 | touch /tmp/agent-canary -> refused: Refused in Read only mode", { timeout: 30_000 });
    await expect(rows).toContainText("AGENT-NOTE-42");
    await expect(rows).toContainText("cat /home/fixture/agent/note.txt");
    await expect(rows).not.toContainText("agent-canary");
    expect(await runFile("docker", ["exec", lab.container, "sh", "-c", "ls /tmp/agent-canary 2>/dev/null || echo absent"]).then((out) => out.stdout)).toBe("absent\n");
    const card = panel.locator('[data-testid="agent-task"][data-task-id="task-1"]');
    await expect(card).toHaveAttribute("data-status", "completed");
    // SST-043: the card sits in the AI bubble of its turn, under the AI icon, as one summary line until expanded.
    const taskOne = page.locator('[data-testid="agent-task"][data-task-id="task-1"]');
    const bubble = messages.getByTestId("agent-ai-bubble").filter({ has: taskOne });
    await expect(bubble).toHaveCount(1);
    await expect(bubble).toContainText("Delegated task-1.");
    await expect(bubble).toContainText("Summary task-1 (completed)");
    const aiLabel = messages.locator("li[data-role=assistant]").filter({ has: taskOne }).getByTestId("agent-ai-label");
    await expect(aiLabel.locator("svg[aria-hidden=true]")).toHaveCount(1);
    await expect(aiLabel.locator(".sr-only")).toHaveText("Assistant");
    expect((await aiLabel.boundingBox())!.y + (await aiLabel.boundingBox())!.height, "the AI icon is above the bubble").toBeLessThanOrEqual((await bubble.boundingBox())!.y + 1);
    const summary = card.getByTestId("agent-task-summary");
    await expect(summary).toContainText("Finished");
    await expect(summary).toContainText("2 commands");
    expect((await summary.boundingBox())!.height, "one line").toBeLessThan(36);
    expect((await card.boundingBox())!.height, "nothing below the summary").toBeLessThan(48);
    await expect(card.getByTestId("agent-task-details")).toHaveCount(0);
    const expand = card.getByRole("button", { name: "Expand", exact: true });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expand.click();
    await expect(expand).toHaveAttribute("aria-expanded", "true");
    const record = card.getByTestId("agent-task-record");
    await expect(record.locator("li").nth(0)).toContainText("cat /home/fixture/agent/note.txt");
    await expect(record.locator("li").nth(0)).toContainText("Exit 0");
    await expect(record.locator("li").nth(0)).toContainText("AGENT-NOTE-42");
    await expect(record.locator("li").nth(0).locator("[data-via]")).toHaveAttribute("data-via", "read-only");
    await expect(record.locator("li").nth(1)).toContainText("Refused, not run");
    const report = card.getByTestId("agent-task-report");
    await expect(report).not.toContainText("Ran 2 command(s).");
    await report.getByRole("button", { name: "Sub agent report (unverified)" }).click();
    await expect(report).toContainText("Ran 2 command(s).");

    // SST-043: safe Markdown. A real table, bold and code; links are text with no href; no image, script or raw HTML.
    await composer.fill("markdown");
    await composer.press("Enter");
    const rich = messages.getByTestId("agent-ai-bubble").filter({ hasText: "Disk report with" });
    await expect(rich).toHaveCount(1, { timeout: 20_000 });
    const table = rich.locator("table");
    await expect(table).toHaveCount(1);
    await expect(table.locator("th")).toHaveText(["Mount", "Used", "Note"]);
    await expect(table.locator("tbody tr")).toHaveCount(2);
    await expect(table.locator("tbody tr").nth(1).locator("td")).toHaveText(["/var", "87%", "high"]);
    await expect(table.locator("td code")).toHaveText("ext4");
    expect(await table.locator("th").first().evaluate((cell) => getComputedStyle(cell).borderTopColor)).toBe("rgb(56, 56, 56)");
    await expect(rich.locator("strong").first()).toHaveText("bold text");
    await expect(rich.locator("p code")).toHaveText("inline-code");
    await expect(rich.locator("pre code")).toHaveText("df -h /var");
    await expect(rich).toContainText("See the runbook (https://example.invalid/runbook) or https://example.invalid/plain.");
    await expect(rich.locator("a, [href], [src], img, script, iframe, style, input")).toHaveCount(0);
    await expect(rich).toContainText("☑ backup done");
    await expect(rich).toContainText("☐ restart pending");
    await expect(rich.getByRole("region", { name: "Table: Mount, Used, Note" })).toHaveCount(1);
    await expect(rich).not.toContainText("__agentInjected");
    expect(await page.evaluate(() => (window as unknown as { __agentInjected?: string }).__agentInjected)).toBeUndefined();
    await expect(messages.locator("img, script, a")).toHaveCount(0);
    // Selectable text: a click on a link's text does nothing and the text can be selected.
    await rich.getByText("the runbook").click();
    expect(page.url()).not.toContain("example.invalid");
    expect(await rich.evaluate((element) => { getSelection()!.selectAllChildren(element); return getSelection()!.toString(); })).toContain("Disk report with");
    await page.evaluate(() => getSelection()!.removeAllRanges());
    expect((await audit(page)).findings, "Markdown bubble and expanded card").toEqual([]);
    await rich.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("agent-panel-markdown.png") });

    // SST-043: a Thai message gets a Thai answer; the bundled rules ask for the user's language and a report in it.
    await composer.fill("สวัสดี ช่วยตรวจดิสก์หน่อย");
    await composer.press("Enter");
    await expect(messages).toContainText("ตอบเป็นภาษาไทย: - Language: always answer in the language of the user's latest message", { timeout: 20_000 });
    await expect(messages).toContainText('Write delegate_task goals in English, and end each goal by naming the language of the user\'s latest message for the sub agent\'s final report, for example "Report in Thai."');
    await expect(messages.locator("li[data-role=user]").last()).toHaveText("You: สวัสดี ช่วยตรวจดิสก์หน่อย");

    // SST-043: the composer is a 3-row textarea; Shift+Enter adds a line and Enter sends the message intact.
    await expect(composer).toHaveAttribute("rows", "3");
    expect((await composer.boundingBox())!.height, "three rows tall").toBeGreaterThanOrEqual(70);
    await composer.fill("");
    await composer.pressSequentially("line one");
    await composer.press("Shift+Enter");
    await composer.pressSequentially("line two");
    await expect(composer).toHaveValue("line one\nline two");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect.poll(() => messages.locator("li[data-role=user]").last().evaluate((element) => element.textContent)).toBe("You: line one\nline two");
    await expect(messages).toContainText("Echo: line one line two", { timeout: 20_000 });
    // Rendered contrast, names and overflow with the panel, a finished card and its record open.
    const rendered = await audit(page);
    expect(rendered.findings).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("agent-panel.png") });
    // The CLIs saw exactly the production flags and environment, and only their own tools.
    const [main, sub] = launches();
    // The bridge the CLI started: the shipped file (Contents/Resources in a packaged run).
    const bridge = process.env.SSTERM_PACKAGED_EXECUTABLE
      ? join(dirname(dirname(process.env.SSTERM_PACKAGED_EXECUTABLE)), "Resources", "ssterm-mcp")
      : resolve("apps/desktop/resources/ssterm-mcp");
    expect(main).toMatchObject({ role: "main", problems: [], servers: ["ssterm"], server: "ssterm", instructions: true, model: "claude-opus-5-5", effort: "xhigh", bridge,
      tools: ["mcp__ssterm__delegate_task", "mcp__ssterm__get_task_status", "mcp__ssterm__cancel_task"] });
    expect(main.extra).toContain("Prefer journalctl over log files.");
    expect(main.language.join("\n")).toMatch(/always answer in the language of the user's latest message[^]*delegate_task goals in English[^]*"Report in Thai\."/u);
    expect(sub.language.join("\n")).toMatch(/final report in the language the task requests[^]*English/u);
    expect(sub).toMatchObject({ role: "sub", problems: [], servers: ["ssterm"], instructions: true, model: "claude-opus-5-5", effort: "xhigh", bridge,
      tools: ["mcp__ssterm__propose_plan", "mcp__ssterm__run_command", "mcp__ssterm__read_output", "mcp__ssterm__cancel"] });
    await expect.poll(() => readdirSync(join(home, ".claude/sessions")).filter((name) => name.startsWith(`${sub.pid}.`)).length, { message: "the finished sub agent's residue" }).toBe(0);

    // 6. One sub agent per session: the second task waits in the queue.
    await composer.fill("delegate:run:sleep 4||run:echo QUEUED-TASK");
    await composer.press("Enter");
    const second = panel.locator('[data-testid="agent-task"][data-task-id="task-2"]');
    const third = panel.locator('[data-testid="agent-task"][data-task-id="task-3"]');
    await expect(second).toHaveAttribute("data-status", "running", { timeout: 20_000 });
    await expect(third).toHaveAttribute("data-status", "queued");
    await expect(pane.getByTestId("agent-banner")).toContainText("Agent running: sleep 4");
    await expect(third).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
    await expect(second).toHaveAttribute("data-status", "completed");
    await expect(messages).toContainText("Summary task-3 (completed): echo QUEUED-TASK -> exit 0: QUEUED-TASK");
    await expect(rows).toContainText("QUEUED-TASK");
    expect(launches().filter((launch) => launch.role === "sub").length).toBe(3);

    // 7. Bound across tab switches: a second session becomes the active tab; the panel stays on the first.
    await page.locator("#app-sidebar").getByRole("button", { name: /^Servers/u }).click();
    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${server}`, exact: true }).click();
    const other = page.locator(`section[data-terminal-kind=ssh]:not([data-session-id="${sessionId}"])`);
    await expect(other).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(other).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-session-id", sessionId);
    await expect(panel.getByTestId("agent-target")).toContainText(server);
    // Both tabs carry the same server label; the first SSH tab is the first tab opened.
    await page.getByRole("tablist", { name: "Terminal tabs" }).locator('[data-tab-id="tab-1"]').click();
    await expect(pane).toBeVisible();

    // 8. Panel close while a task runs: the remote command is interrupted, every CLI stops, residue goes.
    await composer.fill("start:run:sleep 30");
    await composer.press("Enter");
    await expect(pane.getByTestId("agent-banner")).toContainText("Agent running: sleep 30", { timeout: 20_000 });
    await expect.poll(() => remote("sleep 30")).toBe(1);
    expect(await pgrep("fake-claude.mjs")).toBe(2);
    await panel.getByRole("button", { name: "Close AI Agent" }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(() => remote("sleep 30")).toBe(0);
    await expect(pane.getByTestId("agent-banner")).toHaveCount(0);
    await expectCleaned("panel close");
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type('echo "AFTER-$((6*7))"');
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("AFTER-42");

    // 9. Session end (the remote shell exits) ends the conversation.
    await agentButton.click();
    await expect(panel).toBeVisible();
    await composer.fill("hello");
    await composer.press("Enter");
    await expect(messages).toContainText("Echo: hello", { timeout: 20_000 });
    await expect.poll(() => pgrep("fake-claude.mjs")).toBe(1);
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await expect(pane).not.toHaveAttribute("data-phase", "ready");
    // SST-043: the panel closes with its session, with a toast.
    const toasts = page.locator("[data-slot=toast-viewport]");
    await expect(panel).toHaveCount(0);
    await expect(toasts).toContainText("Agent conversation ended with the session");
    await expectCleaned("session end");

    // 9b. A reconnect does not bring the old conversation back; Disconnect on the pane closes a new one the same way.
    await pane.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(panel).toHaveCount(0);
    await agentButton.click();
    await expect(panel).toBeVisible();
    await expect(messages).not.toContainText("Echo: hello");
    await composer.fill("hello again");
    await composer.press("Enter");
    await expect(messages).toContainText("Echo: hello again", { timeout: 20_000 });
    await pane.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.locator(`section[data-session-id="${sessionId}"]`)).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await expect(toasts).toContainText("Agent conversation ended with the session");
    await expectCleaned("disconnect");
    // The other session's pane (step 7) is the first SSH pane now; it was never bound and is still Ready.
    await expect(pane).toHaveAttribute("data-phase", "ready");

    // 10. Lock: a running conversation stops; the button goes with the Ready state.
    await showPane(page, pane);
    await agentButton.click();
    await composer.fill("start:run:sleep 31");
    await composer.press("Enter");
    await expect(pane.getByTestId("agent-banner")).toContainText("Agent running: sleep 31", { timeout: 20_000 });
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(pane).not.toHaveAttribute("data-phase", "ready");
    await expect(panel).toHaveCount(0);
    await expect(pane.getByRole("button", { name: "AI Agent" })).toHaveCount(0);
    await expect.poll(() => remote("sleep 31")).toBe(0);
    await expectCleaned("lock");

    // 11. ssterm itself made no network request and opened no TCP listener.
    expect(await tcpListeners()).toEqual(listenersBefore);
    expect(desktop.externalRequests).toEqual([]);
    expect(desktop.errors).toEqual([]);

    // 12. Quit while a task runs: every CLI group stops and its residue is removed before the app exits.
    await pane.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await agentButton.click();
    await composer.fill("start:run:sleep 32");
    await composer.press("Enter");
    await expect(pane.getByTestId("agent-banner")).toContainText("Agent running: sleep 32", { timeout: 20_000 });
    expect(await pgrep("fake-claude.mjs")).toBe(2);
    await desktop.close();
    expect(desktop.forcedKill(), "the quit finished on its own").toBe(false);
    await expectCleaned("quit");
    testInfo.annotations.push({ type: "evidence", description: `Docker OpenSSH ${lab.container.slice(0, 12)}; ${launches().length} fake CLI launches` });
  } finally {
    await desktop?.close();
    await lab.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});

test("AI Agent modes: Auto plan and per-command approvals on the fixture, Full allow opt-in and reset, PROD confirmations and the Settings gate, lock withdraws a pending card", async ({}, testInfo) => {
  test.setTimeout(420_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-agent-modes-"));
  const home = join(profile, "agent-home");
  await mkdir(home);
  const cli = join(profile, "claude");
  await writeFile(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve("tests/fixtures/agent/fake-claude.mjs")}' "$@"\n`, { mode: 0o755 });
  const lab = await startFixture();
  /** What the fixture actually has: the evidence that a command did or did not run. */
  const exists = async (path: string) => (await runFile("docker", ["exec", lab.container, "sh", "-c", `test -e ${path} && echo present || echo absent`])).stdout.trim();
  const dev = "โหมด DEV";
  const prod = "โหมด PROD";
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { env: { SSTERM_TEST_AGENT_CLI: cli, SSTERM_TEST_AGENT_HOME: home } });
    const { app, page } = desktop;
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    const [identityId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "Agent modes lab", username: lab.username, method: "password" } },
      { type: "create-host", data: { label: dev, address: lab.host, environment: "DEV", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
      { type: "create-host", data: { label: prod, address: lab.host, environment: "PROD", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(prod);
    expect(await app.evaluate(async ({ BrowserWindow }, { file, identityId }) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(async () => {
        const boot = await window.ssterm.bootstrap();
        const saved = await window.ssterm.setIdentityPassword({ owner: boot.value.owner, identityId: ${JSON.stringify(identityId)},
          expectedRevision: 1, value: new TextEncoder().encode(${JSON.stringify(value)}) });
        return saved.ok ? saved.value.status : saved.error.code; })()`);
    }, { file: secret, identityId })).toBe("saved");
    const owner = await page.evaluate(async () => { const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("bootstrap"); return boot.value.owner; });
    const settings = { enabled: true, provider: "claude" as const, model: "claude-haiku-5-5", effort: "low" as const, instructions: "", allowFullAllowOnProd: false, custom: null };
    expect(await page.evaluate(async ({ owner, settings }) => (await window.ssterm.configureAgent({ owner, consent: true, settings })).ok, { owner, settings })).toBe(true);

    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${dev}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const pane = page.locator("section[data-terminal-kind=ssh]").first();
    const rows = pane.locator(".xterm-rows");
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });
    const devId = (await pane.getAttribute("data-session-id"))!;

    // 1. Auto is the default. A plan card shows the goal, exact commands and the target; nothing outside read-only runs before approval.
    await pane.getByRole("button", { name: "AI Agent" }).click();
    const panel = page.getByTestId("agent-panel");
    const modes = panel.getByTestId("agent-mode");
    const composer = panel.getByLabel("Message to the agent");
    const messages = panel.getByTestId("agent-messages");
    await expect(modes).toHaveAttribute("data-mode", "auto");
    await expect(panel.getByTestId("agent-mode-note")).toContainText("Read-only classification is best effort");
    await composer.fill("delegate:plan:touch /tmp/agent-plan-a##run:touch /tmp/agent-plan-a;;touch /tmp/agent-out-a;;touch /tmp/agent-out-b");
    await composer.press("Enter");
    const plan = panel.getByTestId("agent-plan");
    await expect(plan).toHaveAttribute("data-status", "pending", { timeout: 30_000 });
    await expect(plan).toContainText("Fake plan");
    await expect(plan.getByRole("list", { name: "Plan commands" })).toHaveText("touch /tmp/agent-plan-a");
    await expect(plan).toContainText(`${lab.username}@${lab.host}:${lab.port}`);
    await expect(plan).toContainText("DEV");
    expect(await exists("/tmp/agent-plan-a")).toBe("absent");
    await expect(rows).not.toContainText("agent-plan-a");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // SST-043: a card waiting for a decision shows on the collapsed one-line task.
    const card = panel.locator('[data-testid="agent-task"][data-task-id="task-1"]');
    await expect(card).toHaveAttribute("data-expanded", "false");
    await plan.getByRole("button", { name: "Approve plan" }).click();
    // A decided plan moves into the expanded details.
    await expect(plan).toHaveCount(0);
    await card.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(plan).toHaveAttribute("data-status", "approved");

    // 2. The in-plan command runs; an out-of-plan one asks: Run runs it, Reject returns a refusal and sends nothing.
    const approval = panel.getByTestId("agent-approval");
    await expect(approval).toContainText("touch /tmp/agent-out-a", { timeout: 30_000 });
    await card.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(card).toHaveAttribute("data-expanded", "false");
    await expect(approval, "a pending approval is never hidden").toBeVisible();
    expect(await exists("/tmp/agent-plan-a")).toBe("present");
    expect(await exists("/tmp/agent-out-a")).toBe("absent");
    await approval.getByRole("button", { name: "Run", exact: true }).click();
    await expect(approval).toContainText("touch /tmp/agent-out-b", { timeout: 30_000 });
    expect(await exists("/tmp/agent-out-a")).toBe("present");
    await approval.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(messages).toContainText("touch /tmp/agent-out-b -> refused: Not run", { timeout: 30_000 });
    await expect(messages).toContainText("touch /tmp/agent-plan-a -> exit 0");
    await expect(messages).toContainText("touch /tmp/agent-out-a -> exit 0");
    expect(await exists("/tmp/agent-out-b")).toBe("absent");
    await expect(rows).not.toContainText("agent-out-b");
    await card.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(card.getByTestId("agent-task-summary")).toContainText("3 commands");
    await card.getByRole("button", { name: "Sub agent report (unverified)" }).click();
    await expect(card.getByTestId("agent-task-report")).toContainText("Plan approved. Ran 3 command(s).");
    const record = card.getByTestId("agent-task-record").locator("li");
    await expect(record.nth(0).locator("[data-via]")).toHaveAttribute("data-via", "plan");
    await expect(record.nth(1).locator("[data-via]")).toHaveAttribute("data-via", "approval");
    await expect(record.nth(2)).toHaveAttribute("data-step-status", "refused");
    await expect(record.nth(2).locator("[data-via]")).toHaveCount(0);
    expect((await audit(page)).findings).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("agent-modes-auto.png") });

    // 3. Full allow: an explicit warning step, then commands run without cards; a new conversation starts in Auto again.
    await modes.getByRole("button", { name: "Full allow", exact: true }).click();
    const warning = panel.getByTestId("agent-full-allow-step");
    await expect(warning).toContainText(`Allow every command on ${dev}?`);
    await expect(warning).not.toContainText("This is a PROD server.");
    await warning.getByRole("button", { name: "Cancel" }).click();
    await expect(warning).toHaveCount(0);
    await expect(modes).toHaveAttribute("data-mode", "auto");
    await modes.getByRole("button", { name: "Full allow", exact: true }).click();
    await warning.getByRole("button", { name: "Allow every command" }).click();
    await expect(modes).toHaveAttribute("data-mode", "full-allow");
    await composer.fill("delegate:run:touch /tmp/agent-full");
    await composer.press("Enter");
    await expect(messages).toContainText("touch /tmp/agent-full -> exit 0", { timeout: 30_000 });
    await expect(approval).toHaveCount(0);
    expect(await exists("/tmp/agent-full")).toBe("present");
    const fullCard = panel.locator('[data-testid="agent-task"][data-task-id="task-2"]');
    await fullCard.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(fullCard.getByTestId("agent-task-record").locator("[data-via]")).toHaveAttribute("data-via", "full-allow");
    await panel.getByRole("button", { name: "Close AI Agent" }).click();
    await pane.getByRole("button", { name: "AI Agent" }).click();
    await expect(modes).toHaveAttribute("data-mode", "auto");
    await panel.getByRole("button", { name: "Close AI Agent" }).click();

    // 4. PROD: Full allow unavailable until Settings allows it; plan and command approvals need the PROD confirmation step.
    await page.locator("#app-sidebar").getByRole("button", { name: /^Servers/u }).click();
    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${prod}`, exact: true }).click();
    const prodPane = page.locator(`section[data-terminal-kind=ssh]:not([data-session-id="${devId}"])`);
    const trust = page.getByTestId("host-trust-dialog");
    await expect(trust.or(prodPane.and(page.locator("[data-phase=ready]")))).toBeVisible({ timeout: 30_000 });
    if (await trust.isVisible()) await trust.getByRole("button", { name: "Remember", exact: true }).click();
    await expect(prodPane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(prodPane.locator(".xterm-rows")).toContainText("fixture@", { timeout: 20_000 });
    const prodId = (await prodPane.getAttribute("data-session-id"))!;
    await prodPane.getByRole("button", { name: "AI Agent" }).click();
    await expect(panel).toHaveAttribute("data-session-id", prodId);
    await expect(modes).toHaveAttribute("data-mode", "auto");
    await expect(modes.getByRole("button", { name: "Full allow", exact: true })).toBeDisabled();
    await expect(panel.getByTestId("agent-full-allow-off")).toContainText("Settings › AI Agent");
    const generation = Number(await prodPane.getAttribute("data-generation") ?? 1);
    expect(await page.evaluate(async (request) => (await window.ssterm.setAgentMode(request)), { owner, sessionId: prodId, generation, mode: "full-allow" as const, acknowledged: true }))
      .toEqual({ ok: true, value: { status: "refused", reason: "production" } });
    await composer.fill("delegate:plan:touch /tmp/agent-prod-a##run:touch /tmp/agent-prod-a;;touch /tmp/agent-prod-b");
    await composer.press("Enter");
    await expect(plan).toHaveAttribute("data-status", "pending", { timeout: 30_000 });
    await expect(plan).toContainText("PROD");
    const planId = (await plan.getAttribute("data-plan-id"))!;
    expect(await page.evaluate(async (request) => (await window.ssterm.decideAgent(request)), { owner, sessionId: prodId, generation, approvalId: planId, decision: "approve" as const, production: false }))
      .toEqual({ ok: true, value: { status: "refused", reason: "production" } });
    await plan.getByRole("button", { name: "Approve plan" }).click();
    const confirm = panel.getByTestId("agent-prod-confirm");
    await expect(confirm).toContainText(`Approve this plan on ${prod}?`);
    await expect(confirm).toContainText("This is a PROD server.");
    await expect(plan).toHaveAttribute("data-status", "pending");
    expect(await exists("/tmp/agent-prod-a")).toBe("absent");
    await confirm.getByRole("button", { name: "Approve plan on PROD" }).click();
    await expect(plan).toHaveCount(0);
    await panel.locator('[data-testid="agent-task"][data-task-id="task-1"]').getByRole("button", { name: "Expand", exact: true }).click();
    await expect(plan).toHaveAttribute("data-status", "approved");
    await expect(approval).toContainText("touch /tmp/agent-prod-b", { timeout: 30_000 });
    expect(await exists("/tmp/agent-prod-a")).toBe("present");
    await approval.getByRole("button", { name: "Run", exact: true }).click();
    await expect(confirm).toContainText(`Run this command on ${prod}?`);
    await expect(confirm).toContainText("This is a PROD server.");
    expect(await exists("/tmp/agent-prod-b")).toBe("absent");
    await confirm.getByRole("button", { name: "Run on PROD" }).click();
    await expect(messages).toContainText("touch /tmp/agent-prod-b -> exit 0", { timeout: 30_000 });
    expect(await exists("/tmp/agent-prod-b")).toBe("present");

    const dialog = await openSettings(page);
    const prodSwitch = dialog.getByRole("switch", { name: "Allow Full allow on PROD" });
    await expect(prodSwitch).not.toBeChecked();
    await prodSwitch.click();
    await expect(prodSwitch).toBeChecked();
    await dialog.getByRole("button", { name: "Done" }).click();
    expect(JSON.parse(readFileSync(join(profile, "agent-settings.json"), "utf8")).allowFullAllowOnProd).toBe(true);
    await modes.getByRole("button", { name: "Full allow", exact: true }).click();
    await expect(warning).toContainText(`Allow every command on ${prod}?`);
    await expect(warning).toContainText("This is a PROD server.");
    await warning.getByRole("button", { name: "Allow every command" }).click();
    await expect(modes).toHaveAttribute("data-mode", "full-allow");

    // 5. Lock while a command card waits: the card is withdrawn and nothing reaches the server.
    await modes.getByRole("button", { name: "Auto", exact: true }).click();
    await expect(modes).toHaveAttribute("data-mode", "auto");
    await composer.fill("delegate:run:touch /tmp/agent-lock");
    await composer.press("Enter");
    await expect(approval).toContainText("touch /tmp/agent-lock", { timeout: 30_000 });
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(panel).toHaveCount(0);
    await expect(approval).toHaveCount(0);
    await expect.poll(() => pgrep("fake-claude.mjs")).toBe(0);
    expect(await exists("/tmp/agent-lock")).toBe("absent");
    expect(desktop.externalRequests).toEqual([]);
    expect(desktop.errors).toEqual([]);
    testInfo.annotations.push({ type: "evidence", description: `Docker OpenSSH ${lab.container.slice(0, 12)}; DEV and PROD hosts on one fixture` });
  } finally {
    await desktop?.close();
    await lab.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});

test("AI Agent password handoff: listed programs only, card and banner with the command, wrong then right, echo-back withheld, held keys dropped, a composer draft keeps focus, read-only and unlisted prompts stopped, a waiting prompt refuses the probe, and the password reaches nothing", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-agent-pw-"));
  const home = join(profile, "agent-home");
  await mkdir(home);
  const cli = join(profile, "claude");
  await writeFile(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve("tests/fixtures/agent/fake-claude.mjs")}' "$@"\n`, { mode: 0o755 });
  const lab = await startFixture();
  // Fixture-only values, never the SSH password. The image has no sudo: a deterministic stand-in is installed as `sudo`
  // in the owned container. It prompts exactly like sudo, reads without echo (`read -s`) and allows three attempts;
  // with --ssterm-echo-back it prints the accepted entry back, plain and as base64 (the leak the redaction covers).
  const password = `PW-${randomUUID()}`;
  const wrong = `WRONG-${randomUUID()}`;
  const scripts: Record<string, string> = {
    "/usr/local/bin/sudo": [
      "#!/bin/bash",
      "echo_back=",
      'if [ "$1" = --ssterm-echo-back ]; then echo_back=1; shift; fi',
      "for attempt in 1 2 3; do",
      `  printf '[sudo] password for %s: ' "$(id -un)"`,
      "  IFS= read -r -s answer",
      "  printf '\\n'",
      `  if [ "$answer" = '${password}' ]; then`,
      '    if [ -n "$echo_back" ]; then echo "typed: $answer"; printf "%s" "$answer" | base64; fi',
      '    exec "$@"',
      "  fi",
      '  if [ "$attempt" -lt 3 ]; then echo "Sorry, try again."; fi',
      "done",
      "echo 'sudo: 3 incorrect password attempts' >&2",
      "exit 1",
    ].join("\n"),
    // Not a known prompting program: it would print back whatever is typed, so it must never get a handoff.
    "/usr/local/bin/ssterm-echo": ["#!/bin/bash", "printf 'Password: '", "IFS= read -r line", 'echo "you typed: $line"'].join("\n"),
  };
  for (const [path, body] of Object.entries(scripts))
    await runFile("docker", ["exec", lab.container, "sh", "-c", `echo ${Buffer.from(`${body}\n`).toString("base64")} | base64 -d > ${path} && chmod 0755 ${path}`]);
  await runFile("docker", ["exec", "-u", "fixture", lab.container, "python3", "-c",
    "import os\nos.makedirs('/home/fixture/agent', exist_ok=True)\nopen('/home/fixture/agent/note.txt','w').write('AGENT-NOTE-42\\n')\nopen('/home/fixture/agent/prompt.txt','w').write('Password: ')"]);
  const logs: string[] = [];
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { env: { SSTERM_TEST_AGENT_CLI: cli, SSTERM_TEST_AGENT_HOME: home } });
    const { app, page } = desktop;
    // Everything main and the renderer print, to prove the password is in none of it.
    app.process().stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
    app.process().stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
    page.on("console", (message) => logs.push(message.text()));
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    const [identityId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "Agent password lab", username: lab.username, method: "password" } },
      { type: "create-host", data: { label: server, address: lab.host, environment: "DEV", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(server);
    expect(await app.evaluate(async ({ BrowserWindow }, { file, identityId }) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(async () => {
        const boot = await window.ssterm.bootstrap();
        const saved = await window.ssterm.setIdentityPassword({ owner: boot.value.owner, identityId: ${JSON.stringify(identityId)},
          expectedRevision: 1, value: new TextEncoder().encode(${JSON.stringify(value)}) });
        return saved.ok ? saved.value.status : saved.error.code; })()`);
    }, { file: secret, identityId })).toBe("saved");
    const owner = await page.evaluate(async () => { const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("bootstrap"); return boot.value.owner; });
    const settings = { enabled: true, provider: "claude" as const, model: "claude-haiku-5-5", effort: "low" as const, instructions: "", allowFullAllowOnProd: false, custom: null };
    expect(await page.evaluate(async ({ owner, settings }) => (await window.ssterm.configureAgent({ owner, consent: true, settings })).ok, { owner, settings })).toBe(true);
    // Every agent and terminal state push the renderer receives.
    await page.evaluate(() => {
      const pushes: string[] = [];
      (window as unknown as { __pushes: string[] }).__pushes = pushes;
      window.ssterm.onAgentState((state) => pushes.push(JSON.stringify(state)));
      window.ssterm.onTerminalState((state) => pushes.push(JSON.stringify(state)));
    });
    const pushes = () => page.evaluate(() => (window as unknown as { __pushes: string[] }).__pushes);
    const handoffs = async () => (await pushes()).filter((push) => push.includes('"password":true')).length;

    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${server}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const pane = page.locator("section[data-terminal-kind=ssh]").first();
    const rows = pane.locator(".xterm-rows");
    const textarea = pane.locator(".xterm-helper-textarea");
    const banner = pane.getByTestId("agent-banner");
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });
    await pane.getByRole("button", { name: "AI Agent" }).click();
    const panel = page.getByTestId("agent-panel");
    const modes = panel.getByTestId("agent-mode");
    const composer = panel.getByLabel("Message to the agent");
    const messages = panel.getByTestId("agent-messages");
    const card = panel.getByTestId("agent-password");
    await modes.getByRole("button", { name: "Full allow", exact: true }).click();
    await panel.getByTestId("agent-full-allow-step").getByRole("button", { name: "Allow every command" }).click();
    await expect(modes).toHaveAttribute("data-mode", "full-allow");
    const calls = () => readFileSync(join(home, "fake-claude-calls.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const runResult = (command: string) => calls().filter((entry) => entry.name === "run_command" && entry.args.command === command).at(-1)!.result.structuredContent;

    // 1. sudo reaches its prompt: the run pauses, the card names the target and warns with the command, the banner says
    //    the agent cannot see it, and focus moves to the pane.
    await composer.fill("delegate:run:sudo cat /home/fixture/agent/note.txt");
    await composer.press("Enter");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText("Waiting for you to type the password in the terminal");
    await expect(card).toContainText(server);
    await expect(card).toContainText(`${lab.username}@${lab.host}:${lab.port}`);
    await expect(card.getByTestId("agent-password-warning")).toHaveText("Only type a password if you expected this prompt from sudo cat /home/fixture/agent/note.txt.");
    await expect(banner).toHaveAttribute("data-password", "true");
    await expect(banner).toContainText("Type your password in the terminal — ssterm does not pass what you type to the agent · only if you expected this prompt from sudo cat /home/fixture/agent/note.txt");
    await expect(banner.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(textarea).toBeFocused();
    await expect(rows).toContainText("[sudo] password for fixture:");
    await expect(panel.locator('[data-testid="agent-task"][data-task-id="task-1"]')).toHaveAttribute("data-status", "running");
    // Rendered contrast and names of the card and banner, before anything is typed.
    expect((await audit(page)).findings).toEqual([]);
    await textarea.focus();

    // 2. A wrong password: the prompt repeats and is handed off again. Keys go through CDP input into the pane.
    await page.keyboard.type(wrong);
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("Sorry, try again.");
    await expect(card).toBeVisible();
    await expect(banner).toHaveAttribute("data-password", "true");
    await expect(textarea).toBeFocused();

    // 3. The right one: the command completes and the agent gets its exit code and output, not the input.
    await page.keyboard.type(password);
    await page.keyboard.press("Enter");
    await expect(messages).toContainText("Summary task-1 (completed): sudo cat /home/fixture/agent/note.txt -> exit 0", { timeout: 30_000 });
    await expect(card).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    await expect(rows).toContainText("AGENT-NOTE-42");
    const task = panel.locator('[data-testid="agent-task"][data-task-id="task-1"]');
    await expect(task.getByTestId("agent-task-summary")).toContainText("1 command");
    await task.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(task.getByTestId("agent-task-record")).toContainText("AGENT-NOTE-42");
    await expect(task.getByTestId("agent-task-record")).toContainText("Exit 0");
    expect(runResult("sudo cat /home/fixture/agent/note.txt")).toEqual({ status: "completed", command: "sudo cat /home/fixture/agent/note.txt", exitCode: 0,
      output: "[sudo] password for fixture: \nSorry, try again.\n[sudo] password for fixture: \nAGENT-NOTE-42\n", truncated: false,
      passwordPrompts: 2, passwordHandedOff: true,
      note: "A password prompt was handed to the user, who typed in the terminal; what they typed is not included." });

    // 4. A listed program prints the entry back (plain and base64): the whole output is withheld. Keys typed right after
    //    Return are held and dropped, never replayed once the command ends.
    await composer.fill("delegate:run:sudo --ssterm-echo-back sleep 3");
    await composer.press("Enter");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(textarea).toBeFocused();
    await page.keyboard.type(password);
    await page.keyboard.press("Enter");
    await page.keyboard.type("echo REPLAY-$((2+3))");
    await page.keyboard.press("Enter");
    await expect(pane.getByTestId("terminal-feedback")).toContainText("Input is held");
    await expect(messages).toContainText("Summary task-2 (completed): sudo --ssterm-echo-back sleep 3 -> exit 0", { timeout: 30_000 });
    expect(runResult("sudo --ssterm-echo-back sleep 3")).toMatchObject({ status: "completed", exitCode: 0, passwordHandedOff: true,
      outputWithheld: true, output: "[ssterm: output withheld: it contained what you typed at a password prompt]\n" });
    await expect(rows).toContainText("typed: PW-");
    await page.waitForTimeout(1_000);
    await expect(rows).not.toContainText("REPLAY-5");

    // 5. An unsent message in the composer keeps focus there (the card alone shows); Stop in the banner still works at a
    //    password prompt: Ctrl+C, and the hold is back.
    await composer.fill("delegate:run:sudo true");
    await composer.press("Enter");
    await composer.fill("an unsent draft");
    await expect(banner).toHaveAttribute("data-password", "true", { timeout: 30_000 });
    await expect(card).toBeVisible();
    await page.waitForTimeout(300);
    await expect(composer).toBeFocused();
    await expect(textarea).not.toBeFocused();
    await composer.fill("");
    await banner.getByRole("button", { name: "Stop" }).click();
    await expect(messages).toContainText("Summary task-3 (completed): sudo true -> interrupted", { timeout: 30_000 });
    await expect(card).toHaveCount(0);

    // 6. A read-only step never reads the terminal (`cat -` ends at once) and a prompt-shaped line in it is stopped;
    //    a program that is not a known prompting program (and would echo the entry back) is stopped too. No handoff.
    const before = await handoffs();
    await composer.fill("delegate:run:tail -f /home/fixture/agent/prompt.txt;;cat -||run:ssterm-echo");
    await composer.press("Enter");
    await expect(messages).toContainText("Summary task-4 (completed): tail -f /home/fixture/agent/prompt.txt -> password-prompt-refused: Password: ^C | cat - -> exit 0", { timeout: 30_000 });
    await expect(messages).toContainText("Summary task-5 (completed): ssterm-echo -> password-prompt-refused", { timeout: 30_000 });
    expect(await handoffs(), "no card or banner handoff for either").toBe(before);
    expect(runResult("cat -")).toMatchObject({ status: "completed", exitCode: 0, output: "" });
    expect(runResult("ssterm-echo").note).toContain("starting with a known prompting program (sudo, su, ssh, scp, sftp, ssh-keygen, ssh-add, passwd, git, docker login)");
    await expect(rows).not.toContainText("you typed");
    const record = panel.locator('[data-testid="agent-task"][data-task-id="task-4"]');
    await record.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(record.getByTestId("agent-task-record").locator("li").first()).toContainText("Stopped: password prompt");

    // 7. A prompt left waiting by the user's own command: the agent's probe is refused, nothing is typed into it, and
    //    the user's first attempt is still the first (no "Sorry, try again." from a submitted probe line).
    await textarea.focus();
    await page.keyboard.type("clear");
    await page.keyboard.press("Enter");
    await expect(rows).not.toContainText("AGENT-NOTE-42");
    await page.keyboard.type("sudo echo USER-SUDO-$((40+2))");
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("[sudo] password for fixture:");
    await composer.fill("delegate:run:pwd");
    await composer.press("Enter");
    await expect(messages).toContainText("Summary task-6 (completed): pwd -> refused: The terminal is waiting at a password prompt, so nothing was typed", { timeout: 30_000 });
    await expect(rows).not.toContainText("ssterm;ready");
    await textarea.focus();
    await page.keyboard.type(password);
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("USER-SUDO-42");
    await expect(rows, "the probe never counted as an attempt").not.toContainText("Sorry, try again.");

    // 8. The password and the wrong attempt reached nothing ssterm sends or keeps: tool results, the CLIs' logs, state
    //    pushes, the panel (cards and records), main's and the renderer's output. (The pane itself showed the echo-back.)
    const everything = await pushes();
    expect(everything.some((push) => push.includes('"password":true'))).toBe(true);
    const b64 = Buffer.from(password).toString("base64");
    const places: [string, string][] = [
      ["tool results", readFileSync(join(home, "fake-claude-calls.log"), "utf8")],
      ["CLI launches", readFileSync(join(home, "fake-claude.log"), "utf8")],
      ["state pushes", everything.join("\n")],
      ["panel", (await panel.textContent()) ?? ""],
      ["logs", logs.join("\n")],
    ];
    for (const [where, text] of places)
      for (const [label, value] of [["password", password], ["base64 password", b64], ["wrong password", wrong]] as const)
        expect(text.includes(value), `${label} in ${where}`).toBe(false);
    expect(((await rows.textContent()) ?? "").includes(wrong), "read -s never echoed").toBe(false);
    expect(calls().filter((entry) => entry.role === "main").some((entry) => entry.name === "get_task_status")).toBe(true);
    expect(desktop.externalRequests).toEqual([]);
    expect(desktop.errors).toEqual([]);
    testInfo.annotations.push({ type: "evidence", description: `Docker OpenSSH ${lab.container.slice(0, 12)}; sudo stand-in installed in the owned container (no sudo in the image); no screenshots after entry` });
  } finally {
    await desktop?.close();
    await lab.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});

test("AI Agent turn control (SST-043): an exit-1 command still gets its reply; Stop ends a stalled turn and a running task; a crash leaves a notice, not a spinner; waiting cards are pinned above the composer", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-agent-turn-"));
  const home = join(profile, "agent-home");
  await mkdir(home);
  const cli = join(profile, "claude");
  await writeFile(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve("tests/fixtures/agent/fake-claude.mjs")}' "$@"\n`, { mode: 0o755 });
  const lab = await startFixture();
  const remote = async (pattern: string) => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", pattern])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw error; }
  };
  const exists = async (path: string) => (await runFile("docker", ["exec", lab.container, "sh", "-c", `test -e ${path} && echo present || echo absent`])).stdout.trim();
  const launches = () => readFileSync(join(home, "fake-claude.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { env: { SSTERM_TEST_AGENT_CLI: cli, SSTERM_TEST_AGENT_HOME: home } });
    const { app, page } = desktop;
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    const [identityId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "Agent turn lab", username: lab.username, method: "password" } },
      { type: "create-host", data: { label: server, address: lab.host, environment: "DEV", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(server);
    expect(await app.evaluate(async ({ BrowserWindow }, { file, identityId }) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(async () => {
        const boot = await window.ssterm.bootstrap();
        const saved = await window.ssterm.setIdentityPassword({ owner: boot.value.owner, identityId: ${JSON.stringify(identityId)},
          expectedRevision: 1, value: new TextEncoder().encode(${JSON.stringify(value)}) });
        return saved.ok ? saved.value.status : saved.error.code; })()`);
    }, { file: secret, identityId })).toBe("saved");
    const owner = await page.evaluate(async () => { const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("bootstrap"); return boot.value.owner; });
    const settings = { enabled: true, provider: "claude" as const, model: "claude-haiku-5-5", effort: "low" as const, instructions: "", allowFullAllowOnProd: false, custom: null };
    expect(await page.evaluate(async ({ owner, settings }) => (await window.ssterm.configureAgent({ owner, consent: true, settings })).ok, { owner, settings })).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 640));

    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${server}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const pane = page.locator("section[data-terminal-kind=ssh]").first();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(pane.locator(".xterm-rows")).toContainText("fixture@", { timeout: 20_000 });
    await pane.getByRole("button", { name: "AI Agent" }).click();
    const panel = page.getByTestId("agent-panel");
    const composer = panel.getByLabel("Message to the agent");
    const messages = panel.getByTestId("agent-messages");
    const progress = panel.getByTestId("agent-progress");
    const stop = panel.getByRole("button", { name: "Stop the agent" });
    const tray = panel.getByTestId("agent-tray");
    await expect(panel.getByTestId("agent-mode")).toHaveAttribute("data-mode", "auto");

    // 0. Scope 6: the disclosure and the mode help are icons; their text shows on hover and on keyboard focus.
    const tooltip = page.locator("[data-slot=tooltip-content]");
    const disclosureIcon = panel.getByRole("button", { name: "What is sent, and to whom" });
    await expect(disclosureIcon).toHaveAccessibleDescription(/sent to Anthropic through your claude CLI/u);
    await disclosureIcon.hover();
    await expect(tooltip).toContainText("Your messages, the agent's commands and their full output are sent to Anthropic through your claude CLI");
    await page.mouse.move(1, 1);
    await expect(tooltip).toHaveCount(0);
    const modeHelp = panel.getByRole("button", { name: "About Auto mode" });
    await panel.getByTestId("agent-mode").getByRole("button", { name: "Full allow", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(modeHelp).toBeFocused();
    await expect(tooltip).toContainText("Read-only commands run. Anything else runs only from a plan you approve");
    await expect(modeHelp).toHaveAccessibleDescription(/Read-only classification is best effort/u);
    await composer.focus();
    await expect(tooltip).toHaveCount(0);
    // No context share before the CLI reports one.
    await expect(panel.getByTestId("agent-context")).toHaveCount(0);

    // 1. A read-only command that exits 1 (`which` with a missing name, as on the reported server) still gets its reply.
    await composer.fill("delegate:run:which sh no-such-tool");
    await composer.press("Enter");
    await expect(messages).toContainText("Summary task-1 (completed): which sh no-such-tool -> exit 1", { timeout: 30_000 });
    // Scope 6: (1200 + 30000 + 800) of a 200000-token window, as the fake CLI reports it.
    await expect(panel.getByTestId("agent-context")).toHaveText("· 16% context");
    await expect(progress).toHaveCount(0);
    await expect(stop).toHaveCount(0);

    // 2. A turn that never ends: progress says what it waits for; Stop interrupts it (stream-json interrupt) and the same
    //    process answers the next message.
    await composer.fill("stall");
    await composer.press("Enter");
    await expect(progress).toContainText("Thinking…", { timeout: 20_000 });
    await stop.click();
    await expect(messages).toContainText("Stopped by you.");
    await expect(progress).toHaveCount(0);
    await expect.poll(() => launches().filter((entry) => entry.interrupt).length).toBe(1);
    await composer.fill("after stop");
    await composer.press("Enter");
    await expect(messages).toContainText("Echo: after stop", { timeout: 20_000 });
    expect(launches().filter((entry) => entry.role === "main" && entry.cwd).length, "the same main process").toBe(1);

    // 3. Waiting cards are pinned above the composer: visible and actionable with the conversation scrolled to the top.
    await composer.fill("delegate:run:touch /tmp/agent-tray-a");
    await composer.press("Enter");
    const pending = tray.getByTestId("agent-pending");
    await expect(pending).toHaveCount(1, { timeout: 30_000 });
    await expect(pending).toContainText("Task 2");
    await expect(pending.getByTestId("agent-approval")).toContainText("touch /tmp/agent-tray-a");
    await expect(pending).toContainText(`${lab.username}@${lab.host}:${lab.port}`);
    await expect(pending).toContainText("DEV");
    await expect(pending.getByRole("button", { name: "Reject" }), "a new card takes focus on its safe action").toBeFocused();
    await expect(progress).toContainText("Task 2 is waiting for your decision");
    const card = panel.locator('[data-testid="agent-task"][data-task-id="task-2"]');
    await expect(card.getByTestId("agent-task-waiting")).toHaveText("Waiting for you ↓");
    await expect(card.getByTestId("agent-approval")).toHaveCount(0);
    await expect(tray.getByTestId("agent-tray-count")).toHaveText("1 waiting for you");
    // No scrolling needed: with the conversation scrolled to the top the card's buttons are on screen.
    await messages.evaluate((element) => { element.scrollTop = 0; });
    await expect(pending.getByRole("button", { name: "Run", exact: true })).toBeInViewport();
    await expect(pending.getByRole("button", { name: "Reject", exact: true })).toBeInViewport();
    // Two waiting cards stack, oldest first, with a count; the tray never covers the composer.
    await panel.getByTestId("agent-mode").getByRole("button", { name: "Full allow", exact: true }).click();
    await expect(tray.getByTestId("agent-tray-count")).toHaveText("2 waiting for you");
    await expect(tray.locator("[data-testid=agent-pending], [data-testid=agent-full-allow-step]")).toHaveCount(2);
    expect(await tray.locator("[data-testid=agent-pending], [data-testid=agent-full-allow-step]").evaluateAll((cards) => cards.map((element) => element.getAttribute("data-testid"))))
      .toEqual(["agent-pending", "agent-full-allow-step"]);
    const trayBox = (await tray.boundingBox())!;
    expect(trayBox.y + trayBox.height, "the tray ends above the composer").toBeLessThanOrEqual((await composer.boundingBox())!.y);
    await expect(composer, "the composer stays on screen").toBeInViewport({ ratio: 1 });
    await expect(panel.getByRole("button", { name: "Send" })).toBeInViewport({ ratio: 1 });
    // Rendered contrast, names and overflow with the tray at 960×640.
    expect((await audit(page)).findings).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("agent-tray-960x640.png") });
    await tray.getByTestId("agent-full-allow-step").getByRole("button", { name: "Cancel" }).click();
    await expect(tray.getByTestId("agent-tray-count")).toHaveText("1 waiting for you");
    await pending.getByRole("button", { name: "Run", exact: true }).click();
    await expect(pending).toHaveCount(0);
    await expect(tray).toHaveCount(0);
    await expect(messages).toContainText("touch /tmp/agent-tray-a -> exit 0", { timeout: 30_000 });
    expect(await exists("/tmp/agent-tray-a")).toBe("present");
    await card.getByRole("button", { name: "Expand", exact: true }).click();
    await expect(card.getByTestId("agent-task-record").locator("[data-via]")).toHaveAttribute("data-via", "approval");

    // 4. Stop while a task runs: Ctrl+C reaches the command, the task is cancelled and the turn ends.
    await composer.fill("delegate:run:sleep 30");
    await composer.press("Enter");
    await expect(pane.getByTestId("agent-banner")).toContainText("Agent running: sleep 30", { timeout: 20_000 });
    await expect.poll(() => remote("sleep 30")).toBe(1);
    await expect(progress).toContainText("Waiting for task 3: run:sleep 30");
    await stop.click();
    await expect.poll(() => remote("sleep 30")).toBe(0);
    await expect(panel.locator('[data-testid="agent-task"][data-task-id="task-3"]')).toHaveAttribute("data-status", "cancelled");
    await expect(progress).toHaveCount(0);
    await expect(pane.getByTestId("agent-banner")).toHaveCount(0);

    // 5. A sub agent that crashes: the task fails with ssterm's note and the reply still comes.
    await composer.fill("delegate:crash");
    await composer.press("Enter");
    await expect(messages).toContainText("Summary task-4 (failed): no commands", { timeout: 30_000 });
    const crashed = panel.locator('[data-testid="agent-task"][data-task-id="task-4"]');
    await crashed.getByRole("button", { name: "Expand", exact: true }).click();
    await crashed.getByRole("button", { name: "Sub agent report (unverified)" }).click();
    await expect(crashed.getByTestId("agent-task-report")).toContainText("The sub agent CLI exited without a report.");

    // 6. The main CLI crashes without a result: a notice, no spinner; the next message starts a new process that is
    //    given the conversation so far.
    await composer.fill("crash");
    await composer.press("Enter");
    await expect(messages).toContainText("The agent CLI exited. Your next message starts a new one", { timeout: 20_000 });
    await expect(progress).toHaveCount(0);
    await composer.fill("after crash");
    await composer.press("Enter");
    await expect(messages).toContainText("Echo: The conversation so far (kept by ssterm):", { timeout: 20_000 });
    await expect(messages).toContainText("The user's new message: after crash");
    expect(launches().filter((entry) => entry.role === "main" && entry.cwd).length).toBe(2);

    // 7. Review H1: deeply nested replies show as plain text; the window, the panel and the terminal stay.
    for (const [message, sample] of [["deep-quote", ">>>>>>>>"], ["deep-emphasis", "********"]] as const) {
      await composer.fill(message);
      await composer.press("Enter");
      await expect(messages.locator("[data-plain]").filter({ hasText: sample })).toHaveCount(1, { timeout: 20_000 });
    }
    await expect(page.getByTestId("app-error")).toHaveCount(0);
    await expect(page.getByTestId("agent-panel-error")).toHaveCount(0);
    await expect(pane).toBeVisible();
    await expect(pane.locator(".xterm-rows")).toContainText("fixture@");

    // 8. Scope 6: model and effort from the panel apply from the next message (a new main process); "Also set as
    //    default" saves them once.
    const menu = panel.getByRole("button", { name: "Change model and effort" });
    const closeMenu = async () => { if (await page.getByRole("menu").isVisible()) await page.keyboard.press("Escape"); await expect(page.getByRole("menu")).toHaveCount(0); };
    await menu.click();
    await expect(page.getByRole("menuitemradio")).toHaveText(["Claude Opus 5.5", "Claude Haiku 5.5", "low", "medium", "high", "xhigh", "max"]);
    await page.getByRole("menuitemcheckbox", { name: "Also set as default" }).click();
    await page.getByRole("menuitemradio", { name: "Claude Opus 5.5" }).click();
    await closeMenu();
    await expect(messages).toContainText("Model changed to Claude Opus 5.5 (effort low). It applies from your next message and is now the default.");
    await expect(panel.getByTestId("agent-model")).toHaveText("Claude Opus 5.5 · effort low");
    await expect(panel.getByTestId("agent-context")).toHaveCount(0);
    const stored = () => JSON.parse(readFileSync(join(profile, "agent-settings.json"), "utf8"));
    expect(stored()).toMatchObject({ model: "claude-opus-5-5", effort: "low" });
    await menu.click();
    await page.getByRole("menuitemradio", { name: "max", exact: true }).click();
    await closeMenu();
    await expect(messages).toContainText("Model changed to Claude Opus 5.5 (effort max). It applies from your next message.");
    expect(stored().effort, "the default is saved only when asked").toBe("low");
    await composer.fill("after model change");
    await composer.press("Enter");
    await expect(messages).toContainText("The user's new message: after model change", { timeout: 20_000 });
    expect(launches().filter((entry) => entry.role === "main" && entry.cwd).at(-1)).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
    await expect(panel.getByTestId("agent-context")).toHaveText("· 16% context");
    expect(desktop.externalRequests).toEqual([]);
    expect(desktop.errors).toEqual([]);
    testInfo.annotations.push({ type: "evidence", description: `Docker OpenSSH ${lab.container.slice(0, 12)}; window 960×640` });
  } finally {
    await desktop?.close();
    await lab.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});
