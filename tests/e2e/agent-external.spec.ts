import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop, type Desktop } from "./fixtures";
import { expectDrawerPlaced } from "./support/drawer";

// SST-041 ticket 07 through production main and renderer: Settings › AI Agent › External MCP clients, the pairing and
// binding drawers, the bound pane's banner and the external cards, with a test MCP client speaking JSON-RPC over the
// bundled ssterm-mcp bridge (stdio), started exactly as the configuration shown in Settings says. Docker OpenSSH fixture.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
const server = "ลูกข่าย ภายนอก";
const PAIRING_MS = 12_000;
/** The bundled bridge: inside the app's Resources when packaged. */
const bridgePath = () => process.env.SSTERM_PACKAGED_EXECUTABLE
  ? join(process.env.SSTERM_PACKAGED_EXECUTABLE, "../../Resources/ssterm-mcp") : join(process.cwd(), "apps/desktop/resources/ssterm-mcp");
/** Whether the login Keychain holds this test namespace's item for an external client. */
async function clientItem(namespace: string, clientId: string): Promise<boolean> {
  const { stdout } = await runFile("security", ["dump-keychain"], { maxBuffer: 64 * 1024 * 1024 });
  const items = stdout.split(/^keychain: /mu);
  return items.some((item) => item.includes(`"svce"<blob>="${namespace}"`) && item.includes(`"acct"<blob>="mcp-client/v1/${clientId}"`));
}

/** A stdio MCP client: the bridge process, newline-delimited JSON-RPC on its stdin/stdout. */
function stdioClient(config: { command: string; args: string[]; env: Record<string, string> }) {
  const child: ChildProcess = spawn(config.command, config.args, { env: { PATH: "/usr/bin:/bin", ...config.env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiters = new Map<number, (message: any) => void>();
  const lines: any[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      lines.push(message);
      waiters.get(message.id)?.(message);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  let next = 1;
  const request = (method: string, params?: object) => new Promise<any>((resolve) => {
    const id = next++;
    waiters.set(id, resolve);
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
  const call = async (name: string, args: object = {}) => (await request("tools/call", { name, arguments: args })).result;
  const initialize = () => request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  let code: number | null | undefined;
  void exited.then((value) => { code = value; });
  /**
   * ssterm closed the connection: nc (macOS base system) notices only when the client writes next, so the client keeps
   * writing (pings) until the bridge has exited, as an MCP client's next request would.
   */
  const gone = async () => {
    for (let i = 0; i < 40 && code === undefined; i++) {
      if (child.stdin!.writable) child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10_000 + i, method: "ping" })}\n`);
      await new Promise((done) => setTimeout(done, 250));
    }
    return exited;
  };
  child.stdin!.on("error", () => undefined);
  return { child, request, call, initialize, exited, gone, lines, stderr: () => stderr, stop: () => { child.stdin!.end(); child.kill(); } };
}

async function openAgentSettings(page: Page) {
  await page.locator("#app-sidebar").getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "AI Agent" }).click();
  return { dialog, section: dialog.getByTestId("external-clients") };
}

test("External MCP clients over the bundled stdio bridge: off by default, pairing approval, wrong/expired tokens, binding drawer, Auto plan, Read only, second client isolation, revoke, lock and re-binding", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-ext-"));
  const lab = await startFixture();
  const exec = async (...args: string[]) => (await runFile("docker", ["exec", "-u", "fixture", lab.container, ...args])).stdout;
  const exists = async (path: string) => (await exec("sh", "-c", `test -e ${path} && echo yes || echo no`)).trim() === "yes";
  const clients: ReturnType<typeof stdioClient>[] = [];
  let desktop: Desktop | undefined;
  try {
    // Review M1: the ssterm agent (a FAKE claude CLI, never contacting a provider) is on too, to show a session has a
    // conversation or an external binding, never both.
    const home = join(profile, "agent-home");
    await mkdir(home);
    const cli = join(profile, "claude");
    await writeFile(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve("tests/fixtures/agent/fake-claude.mjs")}' "$@"\n`, { mode: 0o755 });
    desktop = await launchDesktop(profile, { env: { SSTERM_TEST_PAIRING_MS: String(PAIRING_MS), SSTERM_TEST_AGENT_CLI: cli, SSTERM_TEST_AGENT_HOME: home } });
    const { app, page } = desktop;
    await exec("python3", "-c", "import os\nos.makedirs('/home/fixture/ext', exist_ok=True)\nopen('/home/fixture/ext/note.txt','w').write('EXTERNAL-NOTE-7\\n')");
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    const [identityId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "External lab", username: lab.username, method: "password" } },
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
    const pid = await app.evaluate(() => process.pid);
    const tcpListeners = async () => {
      try { return (await runFile("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])).stdout.split("\n").filter((line) => line.startsWith("n")).sort(); }
      catch (error) { if ((error as { code?: number }).code === 1) return []; throw error; }
    };
    const listenersBefore = await tcpListeners();
    const owner = await page.evaluate(async () => { const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("bootstrap"); return boot.value.owner; });
    const socketPath = join(realpathSync(profile), "mcp", "ssterm.sock");
    expect(await page.evaluate(async (owner) => window.ssterm.configureAgent({ owner, consent: true, settings: {
      enabled: true, provider: "claude", model: "claude-opus-5-5", effort: "xhigh", instructions: "", allowFullAllowOnProd: false, custom: null } }), owner))
      .toMatchObject({ ok: true, value: { status: "saved" } });

    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${server}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const pane = page.locator("section[data-terminal-kind=ssh]");
    const rows = pane.locator(".xterm-rows");
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });

    // 1. Off by default: no socket, pairing refused, nothing to connect to.
    expect(existsSync(socketPath)).toBe(false);
    expect(await page.evaluate(async (owner) => window.ssterm.updateExternalClients({ owner, action: { type: "pair" } }), owner))
      .toEqual({ ok: true, value: { status: "refused", reason: "disabled" } });
    let { dialog, section } = await openAgentSettings(page);
    const toggle = section.getByRole("switch", { name: "Allow external MCP clients" });
    await expect(toggle).not.toBeChecked();
    await expect(section.getByRole("button", { name: "Pair new client" })).toHaveCount(0);

    // 2. On: the 0600 socket in a 0700 folder; Pair new client shows the one-time token and the client configuration once.
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => existsSync(socketPath)).toBe(true);
    expect(statSync(socketPath).mode & 0o777, "socket 0600").toBe(0o600);
    expect(statSync(join(socketPath, "..")).mode & 0o777, "folder 0700").toBe(0o700);
    const pair = async (name: string) => {
      await section.getByRole("button", { name: "Pair new client" }).click();
      const pairing = section.getByTestId("external-pairing");
      await expect(pairing).toBeVisible();
      await pairing.getByLabel("Client name").fill(name);
      const token = (await pairing.getByTestId("external-pairing-token").textContent())!;
      const config = JSON.parse((await pairing.getByTestId("external-config").textContent())!).mcpServers.ssterm;
      expect(config.env.SSTERM_MCP_PAIRING_TOKEN).toBe(token);
      expect(config.env.SSTERM_MCP_CLIENT_NAME).toBe(name);
      await pairing.getByRole("button", { name: "Done" }).click();
      await expect(pairing).toHaveCount(0);
      return { token, config: config as { command: string; args: string[]; env: Record<string, string> } };
    };
    const first = await pair("E2E Client");
    expect(first.config.command).toBe("/bin/sh");
    // The bridge inside the app (Contents/Resources when packaged), the profile socket, secrets only in the environment.
    expect(first.config.args).toEqual([bridgePath()]);
    expect(first.config.env.SSTERM_MCP_SOCKET).toBe(socketPath);
    expect(first.config.env.SSTERM_MCP_CREDENTIAL_FILE).toMatch(/\/\.config\/ssterm-mcp\/e2e-client-[0-9a-f]{6}\.credential$/u);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    /** The configuration from Settings, with the credential file inside this test's profile (never the real home). */
    const launch = (config: typeof first.config, file: string, extra: Record<string, string> = {}) => {
      const client = stdioClient({ ...config, env: { ...config.env, SSTERM_MCP_CREDENTIAL_FILE: join(profile, file), ...extra } });
      clients.push(client);
      return client;
    };
    const request = page.getByTestId("external-request");

    // 3. A wrong token: the connection closes, the bridge says so, and nothing is asked.
    const wrong = launch(first.config, "wrong/cred", { SSTERM_MCP_PAIRING_TOKEN: "W".repeat(43) });
    void wrong.initialize();
    expect(await wrong.gone()).not.toBe(0);
    expect(wrong.stderr()).toContain("pairing was refused or expired");
    expect(wrong.stderr()).toContain("pairing was refused or expired");
    expect(wrong.lines).toEqual([]);
    expect(existsSync(join(profile, "wrong/cred"))).toBe(false);
    await expect(request).toHaveCount(0);

    // 4. Pairing: the client initializes at once and waits; the user approves its name; the bridge keeps the credential.
    const a = launch(first.config, "a/cred");
    const initialized = a.initialize();
    await expect(request).toBeVisible();
    await expect(request).toHaveAttribute("data-kind", "pair");
    await expect(request.getByRole("heading", { name: "Pair E2E Client?" })).toBeVisible();
    await expectDrawerPlaced(page, "pair request");
    await request.getByRole("button", { name: "Approve" }).click();
    expect((await initialized).result.serverInfo.name).toBe("ssterm");
    expect(statSync(join(profile, "a/cred")).mode & 0o777, "credential file 0600").toBe(0o600);
    expect((await a.request("tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["propose_plan", "run_command", "read_output", "cancel"]);
    // No session listing: an unknown tool; read_output without a binding does not ask.
    expect((await a.call("list_sessions")).content[0].text).toMatch(/^Unknown tool/u);
    expect((await a.call("read_output")).content[0].text).toMatch(/No terminal is bound/u);
    await expect(request).toHaveCount(0);

    // 5. Binding: the first command asks; the user picks the Ready SSH session; the command runs visibly.
    const reading = a.call("run_command", { command: "cat /home/fixture/ext/note.txt" });
    await expect(request).toHaveAttribute("data-kind", "bind");
    await expect(request.getByRole("heading", { name: "E2E Client wants to control a terminal" })).toBeVisible();
    await expectDrawerPlaced(page, "bind request");
    await request.getByRole("radio", { name: new RegExp(server, "u") }).click();
    await request.getByRole("button", { name: "Allow this session" }).click();
    const note = await reading;
    expect(note.isError).toBe(false);
    expect(note.structuredContent).toMatchObject({ status: "completed", exitCode: 0, output: "EXTERNAL-NOTE-7\n" });
    await expect(rows).toContainText("EXTERNAL-NOTE-7");
    const banner = pane.getByTestId("external-banner");
    await expect(banner).toContainText("Controlled by E2E Client · Auto");
    const panel = page.getByTestId("external-panel");
    await expect(panel).toBeVisible();
    const binding = panel.getByTestId("external-binding");
    await expect(binding).toHaveAttribute("data-mode", "auto");

    // 6. Auto: a plan card in the non-modal panel; the approved command runs (its effect is on the server).
    const proposing = a.call("propose_plan", { goal: "Create a marker", commands: ["touch /home/fixture/ext/created.txt"] });
    const plan = binding.getByTestId("agent-plan");
    await expect(plan).toHaveAttribute("data-status", "pending");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await plan.getByRole("button", { name: "Approve plan" }).click();
    expect((await proposing).structuredContent.status).toBe("approved");
    expect(await exists("/home/fixture/ext/created.txt")).toBe(false);
    const created = await a.call("run_command", { command: "touch /home/fixture/ext/created.txt" });
    expect(created.structuredContent).toMatchObject({ status: "completed", exitCode: 0 });
    expect(await exists("/home/fixture/ext/created.txt")).toBe(true);
    await expect(plan).toContainText("used");

    // 7. Read only: anything else is refused before it is typed.
    await binding.getByRole("group", { name: "Mode for E2E Client" }).getByRole("radio", { name: "Read only" }).or(
      binding.getByRole("group", { name: "Mode for E2E Client" }).getByRole("button", { name: "Read only" })).click();
    await expect(binding).toHaveAttribute("data-mode", "read-only");
    await expect(banner).toContainText("Read only");
    const refused = await a.call("run_command", { command: "touch /home/fixture/ext/never.txt" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/^Refused in Read only mode/u);
    expect(await exists("/home/fixture/ext/never.txt")).toBe(false);
    await expect(rows).not.toContainText("never.txt");

    // 7b. Review M1: an externally bound session gets no ssterm agent conversation.
    const sessionId = (await pane.getAttribute("data-session-id"))!;
    const generation = Number(await pane.getAttribute("data-generation"));
    expect(await page.evaluate(async (request) => window.ssterm.openAgent(request), { owner, sessionId, generation }))
      .toEqual({ ok: true, value: { status: "refused", reason: "external" } });
    await pane.getByRole("button", { name: "AI Agent" }).click();
    await expect(page.getByText("An external MCP client controls this session")).toBeVisible();
    await expect(page.getByTestId("agent-panel")).toHaveCount(0);

    // 8. An expired token is refused.
    ({ dialog, section } = await openAgentSettings(page));
    const expiring = await pair("Late Client");
    await dialog.getByRole("button", { name: "Done" }).click();
    await page.waitForTimeout(PAIRING_MS + 500);
    const late = launch(expiring.config, "late/cred");
    void late.initialize();
    expect(await late.gone()).not.toBe(0);
    await expect(request).toHaveCount(0);

    // 9. A second client never sees the first one's binding: its request lists no session (the only one is bound).
    //    Settings stays open meanwhile: the pairing drawer comes on top of it and Settings is usable afterwards.
    ({ dialog, section } = await openAgentSettings(page));
    const second = await pair("Second Client");
    const b = launch(second.config, "b/cred");
    const bInit = b.initialize();
    await expect(request.getByRole("heading", { name: "Pair Second Client?" })).toBeVisible();
    await request.getByRole("button", { name: "Approve" }).click();
    await bInit;
    await expect(request).toHaveCount(0);
    await expect(section.getByTestId("external-client-list")).toContainText("Second Client");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await b.call("read_output")).content[0].text).toMatch(/No terminal is bound/u);
    const bAsk = b.call("run_command", { command: "uptime" });
    await expect(request.getByRole("heading", { name: "Second Client wants to control a terminal" })).toBeVisible();
    await expect(request.getByRole("radio")).toHaveCount(0);
    await expect(request).toContainText("No connected SSH session can be chosen");
    await request.getByRole("button", { name: "Deny" }).click();
    expect((await bAsk).content[0].text).toMatch(/denied/u);

    // 10. Revoke: the first client's connection drops, its binding ends, its Keychain item goes, and its stored credential
    //     is refused at once (the bridge says so).
    ({ dialog, section } = await openAgentSettings(page));
    const list = section.getByTestId("external-client-list");
    const row = list.getByRole("listitem").filter({ hasText: "E2E Client" });
    const firstId = (await row.getAttribute("data-client-id"))!;
    const secondId = (await list.getByRole("listitem").filter({ hasText: "Second Client" }).getAttribute("data-client-id"))!;
    expect(await clientItem(desktop.secretNamespace, firstId)).toBe(true);
    await expect(row).toContainText("Last used");
    await expect(row).not.toContainText("Last used never");
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await row.getByRole("button", { name: "Revoke E2E Client" }).click();
    await expect(list.getByRole("listitem").filter({ hasText: "E2E Client" })).toHaveCount(0);
    await a.gone();
    await expect(banner).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done" }).click();
    expect(await clientItem(desktop.secretNamespace, firstId), "the revoked client's Keychain item is deleted").toBe(false);
    expect(await clientItem(desktop.secretNamespace, secondId), "the other client's item stays").toBe(true);
    const revoked = launch(first.config, "a/cred");
    void revoked.initialize();
    expect(await revoked.exited).toBe(77);
    expect(revoked.stderr()).toContain("refused this credential");
    expect(revoked.lines).toEqual([]);

    // 10b. Review M1: a session with an open ssterm agent conversation is not offered to a client.
    await pane.getByRole("button", { name: "AI Agent" }).click();
    const agentPanel = page.getByTestId("agent-panel");
    await expect(agentPanel).toBeVisible();
    const blocked = b.call("run_command", { command: "uptime" });
    await expect(request.getByRole("heading", { name: "Second Client wants to control a terminal" })).toBeVisible();
    await expect(request.getByRole("radio")).toHaveCount(0);
    await expect(request).toContainText("open AI Agent conversation");
    await request.getByRole("button", { name: "Deny" }).click();
    expect((await blocked).content[0].text).toMatch(/denied/u);
    await agentPanel.getByRole("button", { name: "Close AI Agent" }).click();
    await expect(agentPanel).toHaveCount(0);

    // 11. Lock: the second client binds, then a lock drops its connection and binding; after reconnecting, its credential
    //     still connects but the next command needs a new binding.
    const bound = b.call("run_command", { command: "echo SECOND-CLIENT" });
    await request.getByRole("radio", { name: new RegExp(server, "u") }).click();
    await request.getByRole("button", { name: "Allow this session" }).click();
    expect((await bound).structuredContent.output).toBe("SECOND-CLIENT\n");
    await expect(banner).toContainText("Controlled by Second Client");
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await b.gone();
    await expect(pane).not.toHaveAttribute("data-phase", "ready");
    await expect(banner).toHaveCount(0);
    await pane.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    const again = launch(second.config, "b/cred", { SSTERM_MCP_PAIRING_TOKEN: "" });
    expect((await again.initialize()).result.serverInfo.name).toBe("ssterm");
    expect((await again.call("read_output")).content[0].text).toMatch(/No terminal is bound/u); // The old binding is gone.
    const rebound = again.call("run_command", { command: "echo REBOUND-CLIENT" });
    await expect(request).toHaveAttribute("data-kind", "bind");
    await request.getByRole("radio", { name: new RegExp(server, "u") }).click();
    await request.getByRole("button", { name: "Allow this session" }).click();
    expect((await rebound).structuredContent.output).toBe("REBOUND-CLIENT\n");

    // 12. Stop on the banner ends the binding; the next command asks again (denied here).
    await banner.getByRole("button", { name: "Stop" }).click();
    await expect(banner).toHaveCount(0);
    const afterStop = again.call("run_command", { command: "uptime" });
    await expect(request).toHaveAttribute("data-kind", "bind");
    await request.getByRole("button", { name: "Deny" }).click();
    expect((await afterStop).isError).toBe(true);

    // 13. No TCP listener, no external request, no renderer error.
    expect(await tcpListeners()).toEqual(listenersBefore);
    expect(desktop.externalRequests).toEqual([]);
    expect(desktop.errors).toEqual([]);
    testInfo.annotations.push({ type: "evidence", description: `Docker OpenSSH ${lab.container.slice(0, 12)}; bridge ${first.config.args[0]}` });
  } finally {
    for (const client of clients) client.stop();
    // Teardown empties the test Keychain namespace and fails on leftovers.
    await desktop?.close();
    await lab.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});

test("External MCP clients under the app lock: Lock workspace drops the client; its credential is refused while locked and connects again after unlock, unbound", async () => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-ext-lock-"));
  const clients: ReturnType<typeof stdioClient>[] = [];
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { env: { SSTERM_TEST_APP_LOCK: "on" } });
    const { page } = desktop;
    const password = "external client lock passphrase 2026";
    await page.getByLabel("User name", { exact: true }).fill("alice");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("button", { name: "Create password" }).click();
    const code = page.getByTestId("recovery-code");
    await expect(code).toBeVisible();
    await code.getByRole("checkbox", { name: "I saved the recovery code" }).click();
    await code.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("hosts-page")).toBeVisible();

    const owner = await page.evaluate(async () => { const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("bootstrap"); return boot.value.owner; });
    expect(await page.evaluate(async (owner) => window.ssterm.updateExternalClients({ owner, action: { type: "enable", enabled: true } }), owner))
      .toMatchObject({ ok: true, value: { status: "saved" } });
    const paired = await page.evaluate(async (owner) => window.ssterm.updateExternalClients({ owner, action: { type: "pair" } }), owner);
    if (!paired.ok || paired.value.status !== "saved" || !paired.value.pairing) throw new Error("pairing token");
    const env = { SSTERM_MCP_SOCKET: paired.value.view.socketPath, SSTERM_MCP_CREDENTIAL_FILE: join(profile, "client/cred"),
      SSTERM_MCP_PAIRING_TOKEN: paired.value.pairing.token, SSTERM_MCP_CLIENT_NAME: "Locked Client" };
    const launch = () => { const client = stdioClient({ command: "/bin/sh", args: [bridgePath()], env }); clients.push(client); return client; };
    const request = page.getByTestId("external-request");
    const first = launch();
    const initialized = first.initialize();
    await expect(request.getByRole("heading", { name: "Pair Locked Client?" })).toBeVisible();
    await request.getByRole("button", { name: "Approve" }).click();
    expect((await initialized).result.serverInfo.name).toBe("ssterm");

    // Lock workspace: the connection drops; while locked the stored credential is refused at once.
    await page.getByRole("button", { name: "Lock workspace" }).click();
    await expect(page.getByTestId("app-lock").getByRole("heading", { name: "Unlock ssterm" })).toBeVisible();
    await first.gone();
    const locked = launch();
    void locked.initialize();
    expect(await locked.exited).toBe(77);
    expect(locked.stderr()).toContain("refused this credential");

    // After unlock the credential connects again, with no binding.
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    const again = launch();
    expect((await again.initialize()).result.serverInfo.name).toBe("ssterm");
    expect((await again.call("read_output")).content[0].text).toMatch(/No terminal is bound/u);
    expect(desktop.externalRequests).toEqual([]);
    expect(desktop.errors).toEqual([]);
  } finally {
    for (const client of clients) client.stop();
    await desktop?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
