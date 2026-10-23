import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Locator } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop, type Desktop } from "./fixtures";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// SST-041 ticket 02 through production main: a saved-password Docker OpenSSH host, the shipped executor and the MCP
// socket, driven by a test MCP client. Credentials stay out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
const server = "เอเจนต์ แล็บ";

/** A minimal MCP client over the Unix socket: credential line first, then newline-delimited JSON-RPC. */
async function mcpClient(path: string, credential?: string) {
  const socket = connect(path);
  socket.on("error", () => {});
  await once(socket, "connect");
  const waiters = new Map<number, (message: any) => void>();
  let buffer = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      waiters.get(message.id)?.(message);
    }
  });
  const ended = new Promise<void>((done) => socket.on("close", () => { closed = true; done(); }));
  if (credential !== undefined) socket.write(`${JSON.stringify({ credential })}\n`);
  let next = 1;
  const request = (method: string, params?: object) => new Promise<any>((resolve) => {
    const id = next++;
    waiters.set(id, resolve);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  });
  const call = async (name: string, args: object = {}) => (await request("tools/call", { name, arguments: args })).result;
  return { socket, request, call, ended, closed: () => closed };
}

test("MCP Read only executor on Docker OpenSSH: output and exit codes, refusals never typed, spoofed marker, input hold, Stop, timeout, fencing, lock", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-agent-"));
  const lab = await startFixture();
  const exec = async (...args: string[]) => (await runFile("docker", ["exec", "-u", "fixture", lab.container, ...args])).stdout;
  const count = async (pattern: string) => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", pattern])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw error; }
  };
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { env: { SSTERM_TEST_MCP: "on", SSTERM_TEST_AGENT_TIMEOUT_MS: "5000" } });
    const { app, page } = desktop;
    // Owned remote files: a note, a spoofed completion marker and a full-screen switch.
    await exec("python3", "-c", [
      "import os", "os.makedirs('/home/fixture/agent', exist_ok=True)",
      "open('/home/fixture/agent/note.txt','w').write('AGENT-NOTE-42\\nไทย บรรทัดสอง\\n')",
      `open('/home/fixture/agent/spoof.txt','wb').write(b'before\\x1b]ssterm;done;${"0".repeat(32)};0\\x07after\\n')`,
      "open('/home/fixture/agent/screen.txt','wb').write(b'\\x1b[?1049hFULL\\x1b[?1049l')",
    ].join("\n"));

    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    const [identityId] = await changeCatalog(app, [
      { type: "create-identity", data: { label: "Agent lab", username: lab.username, method: "password" } },
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

    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${server}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const pane = page.locator("section[data-terminal-kind=ssh]");
    const rows = pane.locator(".xterm-rows");
    const textarea = pane.locator(".xterm-helper-textarea");
    const banner = pane.getByTestId("agent-banner");
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(rows).toContainText("fixture@", { timeout: 20_000 });
    // Typed by the user before any agent command: never part of an agent result.
    await textarea.focus();
    await page.keyboard.type('echo "SCROLLBACK-$((40+2))"');
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("SCROLLBACK-42");

    const pid = await app.evaluate(() => process.pid);
    const tcpListeners = async () => {
      try { return (await runFile("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])).stdout.split("\n").filter((line) => line.startsWith("n")).sort(); }
      catch (error) { if ((error as { code?: number }).code === 1) return []; throw error; }
    };
    const listenersBefore = await tcpListeners();
    const owner = await page.evaluate(async () => { const boot = await window.ssterm.bootstrap(); if (!boot.ok) throw new Error("bootstrap"); return boot.value.owner; });
    const issue = async () => {
      const sessionId = await pane.getAttribute("data-session-id");
      return app.evaluate(async (_electron, { owner, sessionId }) =>
        (globalThis as any).__sstermTestMcp.issue(owner, sessionId), { owner, sessionId }) as Promise<{ credential: string; socketPath: string }>;
    };
    const issued = await issue();
    expect(issued.socketPath.startsWith(profile) || issued.socketPath.includes("ssterm-e2e-agent-")).toBe(true);
    expect(statSync(issued.socketPath).mode & 0o777, "socket 0600").toBe(0o600);
    expect(statSync(join(issued.socketPath, "..")).mode & 0o777, "folder 0700").toBe(0o700);

    // Unauthenticated: closed without an answer.
    const anonymous = await mcpClient(issued.socketPath);
    void anonymous.request("tools/list");
    const wrong = await mcpClient(issued.socketPath, "A".repeat(43));
    void wrong.request("tools/list");
    await Promise.all([anonymous.ended, wrong.ended]);

    const agent = await mcpClient(issued.socketPath, issued.credential);
    expect((await agent.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } })).result.serverInfo.name).toBe("ssterm");
    expect((await agent.request("tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["run_command", "read_output", "cancel"]);

    // 1. A read-only command: typed visibly, its exit code and only its own output come back.
    const note = await agent.call("run_command", { command: "cat /home/fixture/agent/note.txt" });
    expect(note.isError).toBe(false);
    expect(note.structuredContent).toEqual({ status: "completed", command: "cat /home/fixture/agent/note.txt", exitCode: 0,
      output: "AGENT-NOTE-42\nไทย บรรทัดสอง\n", truncated: false });
    await expect(rows).toContainText("AGENT-NOTE-42");
    await expect(rows).toContainText("cat /home/fixture/agent/note.txt");
    const failed = await agent.call("run_command", { command: "ls /home/fixture/agent/missing" });
    expect(failed.structuredContent.exitCode).toBe(2);
    expect(failed.structuredContent.output).toContain("No such file or directory");
    expect(failed.structuredContent.output).not.toContain("SCROLLBACK");
    expect(failed.structuredContent.output).not.toContain("printf");

    // 2. Non-read-only commands are refused before anything is typed: no canary on the server, nothing in the pane.
    for (const command of ["touch /tmp/agent-canary", "ls; touch /tmp/agent-canary", "echo x > /tmp/agent-canary", "ls | xargs touch",
      "echo $(touch /tmp/agent-canary)", "find /tmp -name x -exec touch /tmp/agent-canary {} +"]) {
      const refused = await agent.call("run_command", { command });
      expect(refused.isError, command).toBe(true);
      expect(refused.content[0].text, command).toMatch(/^Refused in Read only mode/u);
    }
    expect(await exec("sh", "-c", "ls /tmp/agent-canary 2>/dev/null || echo absent")).toBe("absent\n");
    await expect(rows).not.toContainText("agent-canary");

    // 3. A spoofed completion marker in the output is ignored: the real status (cat's 1) and the text after it come back.
    const spoof = await agent.call("run_command", { command: "cat /home/fixture/agent/spoof.txt /home/fixture/agent/none" });
    expect(spoof.structuredContent.exitCode).toBe(1);
    expect(spoof.structuredContent.output).toMatch(/^beforeafter\ncat: .*none: No such file or directory\n$/u);

    // 4. Input is held while a command runs (banner names it); Ctrl+C passes and interrupts it.
    const sleeping = agent.call("run_command", { command: "sleep 30" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Agent running: sleep 30");
    await expect.poll(() => count("sleep 30")).toBe(1);
    await textarea.focus();
    await page.keyboard.type("echo HELD-INPUT");
    await page.keyboard.press("Enter");
    await expect(pane.getByTestId("terminal-feedback")).toContainText("Input is held while the agent command runs");
    expect((await agent.call("run_command", { command: "pwd" })).content[0].text).toMatch(/one runs at a time/u);
    await page.keyboard.press("Control+C");
    const interrupted = await sleeping;
    expect(interrupted.structuredContent.status).toBe("interrupted");
    await expect(banner).toHaveCount(0);
    expect(await count("sleep 30")).toBe(0);
    await expect(rows).not.toContainText("HELD-INPUT");
    expect((await agent.call("read_output")).structuredContent.status).toBe("interrupted");

    // 5. Stop in the banner interrupts too.
    const stopped = agent.call("run_command", { command: "sleep 31" });
    await expect(banner).toContainText("sleep 31");
    await expect.poll(() => count("sleep 31")).toBe(1);
    await banner.getByRole("button", { name: "Stop" }).click();
    expect((await stopped).structuredContent.status).toBe("interrupted");
    expect(await count("sleep 31")).toBe(0);

    // 6. The per-command timeout (5 s in this test profile) sends Ctrl+C.
    const startedAt = Date.now();
    const timed = await agent.call("run_command", { command: "sleep 32" });
    expect(timed.structuredContent.status).toBe("timeout");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_500);
    expect(await count("sleep 32")).toBe(0);

    // 7. A program that switches to the alternate screen is refused.
    const screen = await agent.call("run_command", { command: "cat /home/fixture/agent/screen.txt" });
    expect(screen.structuredContent.status).toBe("alternate-screen");
    // The pane takes input again.
    await textarea.focus();
    await page.keyboard.type('echo "AFTER-$((6*7))"');
    await page.keyboard.press("Enter");
    await expect(rows).toContainText("AFTER-42");

    // 7b. The user's own program holds the terminal (cat reading stdin): the probe gets no answer, the command is never
    //     typed and nothing is sent to interrupt the user's job.
    await page.keyboard.type("cat");
    await page.keyboard.press("Enter");
    await expect.poll(() => count("^cat$")).toBe(1);
    const blocked = await agent.call("run_command", { command: "ls /home/fixture/agent/never-typed" });
    expect(blocked.isError).toBe(true);
    expect(blocked.structuredContent.status).toBe("not-at-prompt");
    await expect(rows).not.toContainText("never-typed");
    expect(await count("^cat$"), "the user's cat was not interrupted").toBe(1);
    await textarea.focus();
    await page.keyboard.press("Control+C");
    await expect.poll(() => count("^cat$")).toBe(0);

    // 8. Generation fencing: the remote shell exits, Reconnect starts a new generation, the old credential is refused.
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await agent.ended;
    await pane.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
    await expect(pane).toHaveAttribute("data-generation", "2");
    const stale = await mcpClient(issued.socketPath, issued.credential);
    void stale.request("tools/list");
    await stale.ended;
    const renewed = await issue();
    const second = await mcpClient(renewed.socketPath, renewed.credential);
    expect((await second.call("run_command", { command: "echo SECOND-GENERATION" })).structuredContent.output).toBe("SECOND-GENERATION\n");

    // 9. A lock drops the connection, removes the socket and leaves the credential revoked.
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await second.ended;
    expect(existsSync(renewed.socketPath)).toBe(false);
    await expect(pane).not.toHaveAttribute("data-phase", "ready");

    // 10. No TCP listener was added and the renderer made no external request.
    expect(await tcpListeners()).toEqual(listenersBefore);
    expect(desktop.externalRequests).toEqual([]);
    expect(desktop.errors).toEqual([]);
    testInfo.annotations.push({ type: "evidence", description: `Docker OpenSSH ${lab.container.slice(0, 12)}; socket ${issued.socketPath.length} bytes` });
  } finally {
    await desktop?.close();
    await lab.dispose();
    await rm(profile, { recursive: true, force: true });
  }
});
