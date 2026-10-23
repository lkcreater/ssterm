import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop, type Desktop } from "./fixtures";
import { audit } from "./support/audit";

// SST-041 ticket 06 through production main and renderer: Settings › AI Agent shows codex disabled with the ticket 01
// reasons; a custom CLI provider (the FAKE CLI fixture, tests/fixtures/agent/fake-claude.mjs, behind an owned wrapper)
// is defined in the form, fails its isolation check while it offers local tools, passes once it does not, is re-checked
// after its binary changes, and runs the 03/04 agent flow (plan approval) on the Docker OpenSSH fixture. A sub agent
// whose MCP client times a tool call out after 3 s and cancels it leaves no card that could run later. (A client that
// times out silently is covered by expiring cards before the definition's client tool timeout: unit-tested.)
// No provider is contacted: the check points the fake at ssterm's local test endpoint.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
const server = "ผู้ให้บริการเอง";
const CLAUDE_ENV = ["CLAUDE_CODE_DISABLE_CLAUDE_MDS=1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
  "CLAUDE_CODE_SKIP_PROMPT_HISTORY=1", "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1", "ENABLE_CLAUDEAI_MCP_SERVERS=false", "DISABLE_TELEMETRY=1",
  "DISABLE_ERROR_REPORTING=1", "CLAUDE_CODE_DISABLE_FILE_MENTIONS=1", "CLAUDE_CODE_DISABLE_ATTACHMENTS=1", "MCP_TOOL_TIMEOUT=1800000"];
const TEMPLATE = ["-p", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--input-format", "stream-json",
  "--no-session-persistence", "--restricted", "--strict-mcp-config", "--mcp-config", "{mcpConfigPath}", "--tools", "", "--allowedTools", "{allowedTools}",
  "--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "", "--disable-slash-commands",
  "--model", "{model}", "--effort", "{effort}", "--system-prompt-file", "{systemPromptFile}"];

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

test("AI Agent providers: codex disabled with reasons; a custom provider's isolation check fails with an extra tool and passes without, is re-checked after a binary change, runs the plan flow, and a client that cancels its timed-out tool call leaves no card", async ({}, testInfo) => {
  test.setTimeout(420_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-agent-custom-"));
  const home = join(profile, "agent-home");
  await mkdir(home);
  // The custom provider's binary: an owned wrapper (version output and the fake CLI with this test's Node).
  const cli = join(profile, "fake-cli");
  await writeFile(cli, `#!/bin/sh\nif [ "$1" = --version ]; then echo 'fake-cli 1.0'; exit 0; fi\nexec '${process.execPath}' '${resolve("tests/fixtures/agent/fake-claude.mjs")}' "$@"\n`, { mode: 0o755 });
  const lab = await startFixture();
  const exists = async (path: string) => (await runFile("docker", ["exec", lab.container, "sh", "-c", `test -e ${path} && echo present || echo absent`])).stdout.trim();
  const launches = () => existsSync(join(home, "fake-claude.log"))
    ? readFileSync(join(home, "fake-claude.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  let desktop: Desktop | undefined;
  try {
    // No claude test seam: claude is "not found", so only the custom provider can run.
    desktop = await launchDesktop(profile, { env: { SSTERM_TEST_AGENT_HOME: home } });
    const { app, page } = desktop;
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    const [identityId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "Custom provider lab", username: lab.username, method: "password" } },
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

    // 1. codex: disabled, with the ticket 01 reasons; it cannot be chosen.
    let settings = await openSettings(page);
    let agent = settings.getByTestId("agent-settings");
    const codex = agent.getByTestId("agent-codex-status");
    await expect(codex).toContainText("Disabled: its isolation check failed.");
    for (const reason of ["No codex version has passed ssterm's isolation check.", "codex-cli 0.163.0 failed", "$CODEX_HOME/AGENTS.md is sent",
      "apply_patch cannot be removed", "multi_agent sub-agent tools stay exposed"]) await expect(codex).toContainText(reason);
    await expect(agent.getByRole("group", { name: "Provider" }).getByRole("button", { name: "codex" })
      .or(agent.getByRole("radio", { name: "codex" }))).toBeDisabled();
    expect(await page.evaluate(async (owner) => (await window.ssterm.configureAgent({ owner, consent: true, settings: {
      enabled: true, provider: "codex", model: "gpt-5.6-luna", effort: "low", instructions: "", allowFullAllowOnProd: false, custom: null } })), owner))
      .toEqual({ ok: true, value: { status: "model-unverified" } });

    // 2. A custom provider that offers local tools: its check fails with the evidence, and it cannot be turned on.
    const form = agent.getByTestId("agent-custom-provider");
    const status = agent.getByTestId("agent-custom-status");
    await form.getByLabel("Name", { exact: true }).fill("Fake CLI");
    await form.getByLabel("Binary (absolute path)").fill("fake-cli");
    await form.getByLabel("Arguments (one per line)").fill([...TEMPLATE, "--fake-extra-tool"].join("\n"));
    await expect(form.getByText("The binary must be an absolute path")).toBeVisible();
    await form.getByLabel("Binary (absolute path)").fill("/bin/sh");
    await expect(form.getByText("The binary cannot be a shell")).toBeVisible();
    await form.getByLabel("Binary (absolute path)").fill(cli);
    await form.getByLabel("Model ({model})").fill("fake-model-1");
    await form.getByRole("button", { name: "high", exact: true }).click();
    await form.getByLabel("Environment additions (NAME=value per line)").fill([...CLAUDE_ENV, "OPENAI_API_KEY=sk"].join("\n"));
    await expect(form.getByText("OPENAI_API_KEY looks like a secret")).toBeVisible();
    await form.getByLabel("Environment additions (NAME=value per line)").fill(CLAUDE_ENV.join("\n"));
    await form.getByLabel("Test endpoint variable").fill("ANTHROPIC_BASE_URL");
    await form.getByRole("button", { name: "Save provider" }).click();
    await expect(status).toHaveAttribute("data-status", "check-required");
    await expect(status).toContainText("fake-cli 1.0");
    await form.getByRole("button", { name: "Run isolation check" }).click();
    await expect(status).toHaveAttribute("data-status", "check-failed", { timeout: 60_000 });
    for (const reason of ["Main agent: it offered tools outside ssterm's allowlist: Bash, Read, Write.", "Sub agent: it offered tools outside ssterm's allowlist",
      "a local file was read", "a local shell command ran"]) await expect(status).toContainText(reason);
    const stored = JSON.parse(readFileSync(join(profile, "agent-settings.json"), "utf8"));
    expect(stored).toMatchObject({ version: 3, enabled: false, custom: { label: "Fake CLI", path: cli, input: "stream-json", model: "fake-model-1", effort: "high",
      endpointEnv: "ANTHROPIC_BASE_URL" }, customCheck: { status: "failed", version: "fake-cli 1.0" } });
    expect(stored.custom.args).toEqual([...TEMPLATE, "--fake-extra-tool"]);
    expect(launches().map((launch) => launch.role), "both roles were run, against the local endpoint only").toEqual(["main", "sub"]);
    const provider = agent.getByRole("group", { name: "Provider" });
    await provider.getByRole("button", { name: "Custom" }).or(provider.getByRole("radio", { name: "Custom" })).click();
    await agent.getByRole("switch", { name: "Use the AI agent" }).click();
    await expect(agent.getByTestId("agent-disclosure")).toContainText("your custom CLI provider");
    await agent.getByRole("checkbox", { name: "I understand what is sent to this provider" }).click();
    await expect(agent.getByRole("button", { name: "Turn on AI agent" })).toBeDisabled();
    expect(await page.evaluate(async (owner) => (await window.ssterm.openAgent({ owner, sessionId: "none", generation: 1 })), owner))
      .toEqual({ ok: true, value: { status: "refused", reason: "disabled" } });
    await agent.getByRole("button", { name: "Cancel" }).click();

    // 3. Without the extra tool the check passes, and the agent can be turned on with it.
    await form.getByLabel("Arguments (one per line)").fill(TEMPLATE.join("\n"));
    await form.getByRole("button", { name: "Save provider" }).click();
    await expect(status).toHaveAttribute("data-status", "check-required");
    await expect(status).toContainText("changed since its last isolation check");
    await form.getByRole("button", { name: "Run isolation check" }).click();
    await expect(status).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
    await expect(status).toContainText("Passed ssterm's isolation check");
    await agent.getByRole("switch", { name: "Use the AI agent" }).click();
    await agent.getByRole("checkbox", { name: "I understand what is sent to this provider" }).click();
    await agent.getByRole("button", { name: "Turn on AI agent" }).click();
    await expect(agent.getByRole("switch", { name: "Use the AI agent" })).toBeChecked();
    await expect(agent.getByLabel("Custom model ID"), "claude-only controls are hidden for a custom provider").toHaveCount(0);
    expect((await audit(page)).findings).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("agent-custom-settings.png") });
    await settings.getByRole("button", { name: "Done" }).click();
    expect(JSON.parse(readFileSync(join(profile, "agent-settings.json"), "utf8"))).toMatchObject({ enabled: true, provider: "custom", customCheck: { status: "passed" } });

    // 4. The 03/04 flow through the custom provider: plan approval, then the summary from ssterm's record.
    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${server}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const pane = page.locator("section[data-terminal-kind=ssh]").first();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(pane.locator(".xterm-rows")).toContainText("fixture@", { timeout: 20_000 });
    const sessionId = (await pane.getAttribute("data-session-id"))!;
    await pane.getByRole("button", { name: "AI Agent" }).click();
    const panel = page.getByTestId("agent-panel");
    const composer = panel.getByLabel("Message to the agent");
    const messages = panel.getByTestId("agent-messages");
    await expect(panel.getByTestId("agent-provider-banner")).toContainText("custom CLI provider");
    await expect(panel.getByTestId("agent-model")).toHaveText("fake-model-1 · effort high");
    await expect(panel.getByTestId("agent-mode")).toHaveAttribute("data-mode", "auto");
    const checked = launches().length;
    await composer.fill("delegate:plan:touch /tmp/agent-custom-a##run:touch /tmp/agent-custom-a");
    await composer.press("Enter");
    const plan = panel.getByTestId("agent-plan");
    await expect(plan).toHaveAttribute("data-status", "pending", { timeout: 30_000 });
    expect(await exists("/tmp/agent-custom-a")).toBe("absent");
    await plan.getByRole("button", { name: "Approve plan" }).click();
    await expect(messages).toContainText("Summary task-1 (completed): touch /tmp/agent-custom-a -> exit 0", { timeout: 30_000 });
    expect(await exists("/tmp/agent-custom-a")).toBe("present");
    const runs = launches().slice(checked);
    expect(runs.map((launch) => launch.role)).toEqual(["main", "sub"]);
    for (const launch of runs) expect(launch).toMatchObject({ problems: [], servers: ["ssterm"], instructions: true, model: "fake-model-1", effort: "high" });
    await panel.getByRole("button", { name: "Close AI Agent" }).click();
    await expect.poll(() => pgrep("fake-claude.mjs")).toBe(0);

    // 5. The binary changes: Settings shows it needs a new check, and opening the panel runs that check first.
    await appendFile(cli, "# updated\n");
    settings = await openSettings(page);
    agent = settings.getByTestId("agent-settings");
    await expect(agent.getByTestId("agent-custom-status")).toHaveAttribute("data-status", "check-required");
    await expect(agent.getByTestId("agent-custom-status")).toContainText("changed since its last isolation check");
    // A client with a 3 s tool-call timeout (saving the changed definition while on runs its check before it is used).
    await agent.getByTestId("agent-custom-provider").getByLabel("Arguments (one per line)").fill([...TEMPLATE, "--fake-tool-timeout-ms", "3000"].join("\n"));
    await agent.getByTestId("agent-custom-provider").getByRole("button", { name: "Save provider" }).click();
    // A changed definition in use is a different CLI: its disclosure is acknowledged again before it is saved and checked.
    await expect(agent.getByTestId("agent-disclosure").first()).toContainText("your custom CLI provider");
    await agent.getByRole("checkbox", { name: "I understand what is sent to this provider" }).click();
    await agent.getByRole("button", { name: "Save and use this provider" }).click();
    await expect(agent.getByTestId("agent-custom-status")).toHaveAttribute("data-status", "ready", { timeout: 60_000 });
    await settings.getByRole("button", { name: "Done" }).click();
    const checksBefore = launches().length;
    await pane.getByRole("button", { name: "AI Agent" }).click();
    await expect(panel).toHaveAttribute("data-session-id", sessionId);

    // 6. The sub agent's out-of-plan command raises a card; its client gives up after 3 s and cancels the call: the card
    //    is withdrawn, the command never runs, and approving the old card later is refused as stale.
    await composer.fill("delegate:run:touch /tmp/agent-custom-timeout");
    await composer.press("Enter");
    const approval = panel.getByTestId("agent-approval");
    await expect(approval).toContainText("touch /tmp/agent-custom-timeout", { timeout: 30_000 });
    const approvalId = (await approval.getAttribute("data-approval-id"))!;
    await expect(approval).toHaveCount(0, { timeout: 15_000 });
    const card = panel.locator('[data-testid="agent-task"][data-task-id="task-1"]');
    await expect(card).toHaveAttribute("data-status", "completed", { timeout: 30_000 });
    await expect(card.getByTestId("agent-task-summary")).toContainText("1 command");
    await card.getByRole("button", { name: "Expand", exact: true }).click();
    const step = card.getByTestId("agent-task-record").locator("li").first();
    await expect(step).toHaveAttribute("data-step-status", "refused");
    await expect(step).toContainText("The approval was withdrawn");
    await expect(messages).toContainText("Summary task-1 (completed)", { timeout: 30_000 });
    const generation = Number(await pane.getAttribute("data-generation") ?? 1);
    expect(await page.evaluate(async (request) => (await window.ssterm.decideAgent(request)),
      { owner, sessionId, generation, approvalId, decision: "approve" as const, production: false }))
      .toEqual({ ok: true, value: { status: "refused", reason: "stale" } });
    await page.waitForTimeout(1_000);
    expect(await exists("/tmp/agent-custom-timeout")).toBe("absent");
    const calls = readFileSync(join(home, "fake-claude-calls.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.name === "run_command" && call.args.command === "touch /tmp/agent-custom-timeout").at(-1).result.timedOut).toBe(true);
    expect(launches().length - checksBefore, "no extra check: the saved definition was already checked").toBe(2);
    await panel.getByRole("button", { name: "Close AI Agent" }).click();
    await expect.poll(() => pgrep("fake-claude.mjs")).toBe(0);
    expect(desktop.externalRequests).toEqual([]);
    expect(desktop.errors).toEqual([]);
    testInfo.annotations.push({ type: "evidence", description: `Docker OpenSSH ${lab.container.slice(0, 12)}; ${launches().length} fake CLI launches (checks and runs)` });
  } finally {
    await desktop?.close();
    await lab.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});
