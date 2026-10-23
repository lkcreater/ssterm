import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import {
  CLAUDE_ENV, claudeArgs, cliEnv, isNativeExecutable, mcpConfig, parseClaudeVersion, removeRunResidue, resolveClaude, spawnCli,
  agentInstructions, managedPolicyPaths, sweepStaleRuns, type CliProcess,
} from "../../apps/desktop/src/main/agent-cli.ts";
import {
  createAgentRunner, DEFAULT_AGENT_SETTINGS, DELEGATE_TOOLS, parseAgentSettings, registerAgentHandlers, serializeAgentSettings,
  agentChannels, isolationViolation, taskRecord, type AgentSettingsStore,
} from "../../apps/desktop/src/main/agent-runner.ts";
import type { AgentStepRecord, AgentToolRole, ToolResult } from "../../apps/desktop/src/main/agent-mcp.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import {
  AGENT_DISCLOSURE_VERSION, AGENT_MODELS, effectiveDefaultModel, channels, failure, isAgentState, isConfigureAgentRequest, isSendAgentRequest, isOpenAgentRequest,
  isCancelAgentTaskRequest, type AgentState,
} from "../../packages/contracts/src/index.ts";
import type { SessionSnapshot } from "../../packages/services/src/index.ts";

const owner = { windowId: 1, generation: 1 };
/** An init event shaped like the verified claude 2.1.309 one. */
const init = (tools: string[], extra: object = {}) => ({ type: "system", subtype: "init", tools, mcp_servers: [{ name: "ssterm", status: "connected" }],
  plugins: [{ name: "cc-plugin-agents-md", path: "builtin" }], skills: [], slash_commands: [], agents: ["claude", "Explore", "general-purpose", "Plan", "statusline-setup"], ...extra });
const ownerId = sessionOwnerId(owner);
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done)); };
const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 5)); assert.ok(check()); };
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "ssterm-agent-test-")));

test("spawn builders match the spike exports, minus its cost limits; the environment is allowlisted with the mandatory claude variables", async () => {
  const spike = await import("../../spikes/ai-cli-isolation/scripts/run.mjs" as string) as { CLAUDE_ENV: Record<string, string>; claudeArgs(config: string, prompt: string | null, mode: string): string[] };
  assert.deepEqual({ ...CLAUDE_ENV }, spike.CLAUDE_ENV);
  assert.equal(CLAUDE_ENV.CLAUDE_CODE_DISABLE_FILE_MENTIONS, "1");
  assert.equal(CLAUDE_ENV.CLAUDE_CODE_DISABLE_ATTACHMENTS, "1");
  const ours = claudeArgs({ mcpConfig: "/x/mcp.json", tools: ["mcp__ssterm__delegate_task", "mcp__ssterm__cancel_task"], systemPrompt: "SYSTEM", model: "claude-haiku-5-5", effort: "xhigh" });
  const theirs = spike.claudeArgs("/x/mcp.json", null, "stream");
  const strip = (args: string[], flags: string[]) => args.filter((_, at) => !flags.includes(args[at]!) && !flags.includes(args[at - 1]!));
  const values = ["--allowedTools", "--system-prompt", "--model", "--effort"];
  assert.deepEqual(strip(ours, values).sort(), strip(theirs, [...values, "--max-budget-usd"]).sort());
  assert.deepEqual([ours[ours.indexOf("--model") + 1], ours[ours.indexOf("--effort") + 1]], ["claude-haiku-5-5", "xhigh"]);
  for (const model of ["-p", "--dangerously-skip-permissions", "a b", "x".repeat(65), ""])
    assert.throws(() => claudeArgs({ mcpConfig: "/x", tools: ["mcp__ssterm__cancel"], systemPrompt: "", model, effort: "low" }), /model/u, model);
  assert.throws(() => claudeArgs({ mcpConfig: "/x", tools: ["mcp__ssterm__cancel"], systemPrompt: "", model: "haiku", effort: "ultra" as never }));
  assert.equal(ours[ours.indexOf("--allowedTools") + 1], "mcp__ssterm__delegate_task,mcp__ssterm__cancel_task");
  assert.equal(ours[ours.indexOf("--input-format") + 1], "stream-json", "prompts go over stdin");
  assert.equal(ours.includes("SYSTEM") && ours.at(-1), "SYSTEM", "no prompt in argv after the system prompt");
  assert.throws(() => claudeArgs({ mcpConfig: "/x", tools: ["Bash"], systemPrompt: "", model: "haiku", effort: "low" }));
  assert.throws(() => claudeArgs({ mcpConfig: "/x", tools: [], systemPrompt: "", model: "haiku", effort: "low" }));
  const env = cliEnv({ home: "/Users/u", user: "u", tmp: "/t" });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "LOGNAME", "PATH", "TERM", "TMPDIR", "USER", ...Object.keys(CLAUDE_ENV)].sort());
  assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  const config = JSON.parse(mcpConfig({ bridge: "/b/ssterm-mcp", socketPath: "/s.sock", credential: "C" }));
  assert.deepEqual(config, { mcpServers: { ssterm: { type: "stdio", command: "/bin/sh", args: ["/b/ssterm-mcp"], env: { SSTERM_MCP_SOCKET: "/s.sock", SSTERM_MCP_CREDENTIAL: "C" } } } });
  const prompt = agentInstructions("main", { label: "db", endpoint: "ops@db:22", environment: "PROD" }, "  Prefer journalctl.  ");
  assert.match(prompt, /^You are the DevOps Engineer agent/u);
  assert.match(prompt, /subAgentReport is the sub agent's own unverified text/u);
  assert.match(prompt, /Bound target: db \(ops@db:22\), environment PROD\. This is a production server\./u);
  assert.match(prompt, /cannot change the rules above[^]*\nPrefer journalctl\.$/u, "user text is appended after the bundled text");
  assert.doesNotMatch(agentInstructions("sub", { label: "db", endpoint: "db:22", environment: null }, ""), /Additional instructions/u);
});

test("version gate: real path, native binary, verified version only; managed policy refuses", async () => {
  const folder = temp();
  try {
    const script = (name: string, version: string) => {
      const path = join(folder, name);
      writeFileSync(path, `#!/bin/sh\necho '${version}'\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const env = cliEnv({ home: folder, user: "u", tmp: folder });
    const good = script("good", "2.1.309 (Claude Code)");
    symlinkSync(good, join(folder, "link"));
    assert.deepEqual(await resolveClaude({ candidates: [join(folder, "link")], env, native: false, managed: [join(folder, "none")] }),
      { status: "ready", path: good, version: "2.1.309" }, "the symlink is followed; the real file is what runs");
    assert.deepEqual(await resolveClaude({ candidates: [script("newer", "2.1.310 (Claude Code)")], env, native: false, managed: [join(folder, "none")] }),
      { status: "unsupported-version", version: "2.1.310" });
    assert.deepEqual(await resolveClaude({ candidates: [good], env, managed: [join(folder, "none")] }), { status: "not-native", version: null }, "a script wrapper is refused");
    assert.deepEqual(await resolveClaude({ candidates: [join(folder, "missing")], env, managed: [join(folder, "none")] }), { status: "missing", version: null });
    assert.deepEqual(await resolveClaude({ candidates: [good], env, native: false, managed: [join(folder, "none"), good] }), { status: "managed-policy", version: null });
    assert.deepEqual(managedPolicyPaths({ home: "/Users/u", user: "u" }), [
      "/Library/Application Support/ClaudeCode", "/Library/Managed Preferences/com.anthropic.claudecode.plist",
      "/Library/Managed Preferences/u/com.anthropic.claudecode.plist", "/Users/u/.claude/remote-settings.json", "/Users/u/.claude/policy-limits.json",
    ]);
    assert.equal(await isNativeExecutable(process.execPath), true);
    assert.equal(await isNativeExecutable(good), false);
    assert.equal(parseClaudeVersion("2.1.309 (Claude Code)\n"), "2.1.309");
    for (const bad of ["2.1.309", "v2.1.309 (Claude Code)", "2.1.309 (Claude Code) extra"]) assert.equal(parseClaudeVersion(bad), undefined);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("stop: SIGTERM to the process group, then SIGKILL for anything that ignores it", async () => {
  const folder = temp();
  const events: Record<string, unknown>[] = [];
  const cli = spawnCli({
    path: "/bin/sh", cwd: folder, env: { PATH: "/usr/bin:/bin" }, graceMs: 300,
    args: ["-c", "trap '' TERM; /bin/sleep 60 & echo \"{\\\"child\\\":$!}\"; while :; do /bin/sleep 1; done"],
    onEvent: (event) => events.push(event),
  });
  try {
    while (!events.length) await new Promise((done) => setTimeout(done, 20));
    const child = events[0]!.child as number;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.ok(alive(cli.pid) && alive(child));
    const started = Date.now();
    await cli.stop();
    assert.ok(Date.now() - started >= 250, "the grace period passed before SIGKILL");
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(alive(child), false, "the background child in the group is gone too");
    assert.equal(cli.write({ type: "user" }), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("residue cleanup removes only this run's folder, cache entries and session files", async () => {
  const home = temp();
  const root = join(home, "ssterm-agent-0123456789abcdef");
  try {
    mkdirSync(join(root, "cwd"), { recursive: true });
    const cache = join(home, "Library", "Caches", "claude-cli-nodejs");
    mkdirSync(join(cache, `-private-var-T-ssterm-agent-0123456789abcdef-cwd`, "mcp-logs-ssterm"), { recursive: true });
    mkdirSync(join(cache, "-Users-u-project"), { recursive: true });
    const sessions = join(home, ".claude", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "4242.json"), JSON.stringify({ cwd: `${root}/cwd` }));
    writeFileSync(join(sessions, "4242.abc.key"), "k");
    writeFileSync(join(sessions, "4243.json"), JSON.stringify({ cwd: "/Users/u/project" }));
    writeFileSync(join(sessions, "4243.abc.key"), "k");
    const removed = await removeRunResidue({ home, root, pid: 4242 });
    assert.equal(removed.length, 3);
    assert.equal(existsSync(root), false);
    assert.deepEqual(readdirSync(cache), ["-Users-u-project"]);
    assert.deepEqual(readdirSync(sessions).sort(), ["4243.abc.key", "4243.json"]);
    // Another pid's entry naming another cwd, and a folder that is not a run folder, are never touched.
    assert.deepEqual(await removeRunResidue({ home, root: join(home, ".claude"), pid: 4243 }), []);
    assert.ok(existsSync(join(home, ".claude")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("settings: a versioned allowlist record; anything else, or consent to an older disclosure, reads as off", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const valid = { version: 1, enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "high", instructions: "Prefer journalctl.", disclosure: AGENT_DISCLOSURE_VERSION };
  assert.deepEqual(parseAgentSettings(encode(valid)), { enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "high", instructions: "Prefer journalctl.", disclosure: AGENT_DISCLOSURE_VERSION });
  assert.equal(parseAgentSettings(encode({ ...valid, model: "claude-opus-5-5" })).model, effectiveDefaultModel("claude"), "an unverified model falls back");
  assert.equal(AGENT_MODELS.claude.defaultModel, "claude-opus-5-5");
  assert.equal(AGENT_MODELS.claude.defaultEffort, "xhigh");
  assert.deepEqual([DEFAULT_AGENT_SETTINGS.model, DEFAULT_AGENT_SETTINGS.effort], ["claude-haiku-5-5", "xhigh"], "the user's default applies once verified");
  assert.deepEqual(parseAgentSettings(serializeAgentSettings({ ...DEFAULT_AGENT_SETTINGS })), DEFAULT_AGENT_SETTINGS);
  assert.equal(parseAgentSettings(encode({ ...valid, disclosure: 0 })).enabled, false);
  for (const bad of [undefined, new Uint8Array([0xff]), encode([]), encode({ ...valid, version: 2 }), encode({ ...valid, provider: "codex" }),
    encode({ ...valid, apiKey: "x" }), encode({ ...valid, instructions: "a\u0007" }), encode({ ...valid, instructions: "x".repeat(4_001) }),
    encode({ ...valid, model: "-p" }), encode({ ...valid, effort: "ultra" })])
    assert.deepEqual(parseAgentSettings(bad), DEFAULT_AGENT_SETTINGS);
  const settings = { enabled: true, provider: "claude", model: "claude-custom:v1.2", effort: "max", instructions: "" };
  assert.ok(isConfigureAgentRequest({ owner, settings, consent: true }));
  for (const bad of [{ owner, settings: { ...settings, provider: "codex" }, consent: true },
    { owner, settings: { ...settings, path: "/bin/sh" }, consent: true },
    { owner, settings: { ...settings, model: "--model" }, consent: true },
    { owner, settings: { ...settings, model: "a b" }, consent: true },
    { owner, settings: { ...settings, model: "x\u0001" }, consent: true },
    { owner, settings: { ...settings, effort: "huge" }, consent: true },
    { owner, settings }])
    assert.equal(isConfigureAgentRequest(bad), false);
  assert.equal(isSendAgentRequest({ owner, sessionId: "s1", text: "   " }), false);
  assert.equal(isSendAgentRequest({ owner, sessionId: "s1", text: "x".repeat(8_001) }), false);
  assert.equal(isOpenAgentRequest({ owner, sessionId: "../x", generation: 1 }), false);
  assert.equal(isCancelAgentTaskRequest({ owner, sessionId: "s1", taskId: "1" }), false);
});

// ---------------------------------------------------------------------------------------------------------------
// The runner with a scripted CLI and a recording terminal endpoint.

interface FakeCli extends CliProcess { role: "main" | "sub"; args: string[]; env: Record<string, string>; cwd: string; stdin: object[]; emit(event: object): void; exit(): void; stopped: boolean; readonly killed: boolean }
function lab(options: { local?: boolean; team?: boolean } = {}) {
  const folder = temp();
  const clis: FakeCli[] = [];
  const issued: { credential: string; role?: AgentToolRole; record?: (step: AgentStepRecord) => void; admit?: () => string | undefined; revoked: boolean }[] = [];
  const snapshot: Partial<SessionSnapshot> = {
    id: "s1", kind: "terminal", generation: 1, state: "Ready", hostId: "h1", ...(options.local ? { local: { shell: "/bin/zsh", platform: "darwin" } as never } : {}),
    target: { label: "db", address: "db.example", port: 22, username: "ops", environment: "PROD", hostRevision: 1, catalogRevision: 1, ...(options.team ? { source: "team" as const } : {}) },
  };
  let stored: Uint8Array | undefined;
  const store: AgentSettingsStore = {
    read: async () => stored ? { status: "present", value: stored } : { status: "missing" },
    write: async (value) => { stored = value; return "confirmed"; },
  };
  let version: "ready" | "unsupported-version" = "ready";
  const states: AgentState[] = [];
  const runner = createAgentRunner({
    terminals: {
      issue: async (_owner, _session, use = {}) => {
        if (snapshot.state !== "Ready") return undefined;
        const entry = { credential: `cred-${issued.length + 1}`, ...use, revoked: false };
        issued.push(entry);
        return { credential: entry.credential, socketPath: "/tmp/s.sock" };
      },
      revoke: (credential) => { const entry = issued.find((candidate) => candidate.credential === credential); if (entry) entry.revoked = true; },
    },
    registry: () => ({ snapshot: (id: string, session?: string) => id === ownerId && /^s\d+$/u.test(session ?? "") ? [{ ...snapshot, id: session } as SessionSnapshot] : [] }),
    store, bridge: "/b/ssterm-mcp", tmp: folder, home: folder, profile: "/profile/one", waitMs: 2_000,
    resolve: async () => version === "ready" ? { status: "ready", path: "/fake/claude", version: "2.1.309" } : { status: "unsupported-version", version: "9.9.9" },
    env: (tmp) => cliEnv({ home: folder, user: "u", tmp }),
    spawn: (spec) => {
      let resolveExit!: () => void;
      const exited = new Promise<void>((done) => { resolveExit = done; });
      const tools = spec.args[spec.args.indexOf("--allowedTools") + 1]!;
      let killed = false;
      const cli: FakeCli = {
        pid: 90_000 + clis.length, exited, role: tools.includes("delegate_task") ? "main" : "sub", args: spec.args, env: spec.env, cwd: spec.cwd,
        stdin: [], stopped: false,
        write(message) { if (cli.stopped) return false; cli.stdin.push(message); return true; },
        endInput() {},
        stop: async () => { cli.stopped = true; resolveExit(); await exited; },
        kill: () => { killed = true; cli.stopped = true; resolveExit(); },
        get killed() { return killed; },
        emit: (event) => spec.onEvent(event as Record<string, unknown>),
        exit: () => { cli.stopped = true; resolveExit(); },
      };
      clis.push(cli);
      return cli;
    },
  });
  runner.register(owner, (state) => states.push(state));
  const call = async (name: string, args: unknown): Promise<ToolResult> => issued.find((entry) => entry.role)!.role!.call(name, args);
  const structured = (result: ToolResult) => result.structuredContent as Record<string, any>;
  const last = () => states.at(-1)!;
  return {
    runner, clis, issued, snapshot, states, call, structured, last, folder,
    setVersion: (next: typeof version) => { version = next; },
    stored: () => stored,
    cleanup: () => rmSync(folder, { recursive: true, force: true }),
  };
}

test("consent gating, session eligibility and the version gate decide whether a conversation opens", async () => {
  const { runner, cleanup, setVersion, stored } = lab();
  const local = lab({ local: true });
  const team = lab({ team: true });
  try {
    assert.deepEqual(await runner.open(owner, "s1", 1), { status: "refused", reason: "disabled" }, "off by default");
    const settings = { enabled: true, provider: "claude" as const, model: "claude-haiku-5-5", effort: "xhigh" as const, instructions: "" };
    assert.deepEqual(await runner.configure(settings, false), { status: "consent-required" });
    assert.equal(stored(), undefined, "nothing saved without consent");
    setVersion("unsupported-version");
    assert.equal((await runner.configure(settings, true)).status, "provider-unavailable");
    setVersion("ready");
    const saved = await runner.configure(settings, true);
    assert.equal(saved.status, "saved");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(stored())), { version: 1, enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "", disclosure: AGENT_DISCLOSURE_VERSION });
    assert.deepEqual(await runner.configure({ ...settings, model: "claude-opus-5-5" }, true), { status: "model-unverified" }, "A14: unverified models never run");
    assert.deepEqual(await runner.configure({ ...settings, model: "my-custom-model" }, true), { status: "model-unverified" }, "custom IDs are never verified");
    assert.equal((await runner.configure({ ...settings, instructions: "Be brief." }, false)).status, "saved", "already consented");
    assert.deepEqual(await runner.open(owner, "s1", 2), { status: "refused", reason: "session" }, "stale generation");
    assert.deepEqual(await runner.open(owner, "s1", 1), { status: "opened" });
    for (const other of [local, team]) {
      await other.runner.configure(settings, true);
      assert.deepEqual(await other.runner.open(owner, "s1", 1), { status: "refused", reason: "session" }, "local and Team-managed terminals are excluded");
    }
    await runner.configure({ ...settings, enabled: false }, false);
    assert.equal((await runner.state(owner)).conversations.length, 0, "turning it off ends every conversation");
    assert.equal((await runner.configure(settings, false)).status, "consent-required", "turning it off withdrew the consent");
  } finally { cleanup(); local.cleanup(); team.cleanup(); }
});

test("main agent: delegate tools only; one sub agent at a time with the rest queued; the task record backs cards and get_task_status", async () => {
  const { runner, clis, issued, call, structured, last, cleanup, folder } = lab();
  try {
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "max", instructions: "Prefer journalctl." }, true);
    await runner.open(owner, "s1", 1);
    assert.deepEqual(await runner.send(owner, "s1", "check disk"), { status: "sent" });
    const main = clis[0]!;
    assert.equal(main.role, "main");
    assert.equal(main.args[main.args.indexOf("--allowedTools") + 1], "mcp__ssterm__delegate_task,mcp__ssterm__get_task_status,mcp__ssterm__cancel_task");
    assert.deepEqual([main.args[main.args.indexOf("--model") + 1], main.args[main.args.indexOf("--effort") + 1]], ["claude-haiku-5-5", "max"], "A14 choice at open");
    assert.equal(readFileSync(join(main.cwd, "..", "profile"), "utf8"), "/profile/one", "the run folder names its profile");
    assert.match(main.args[main.args.indexOf("--system-prompt") + 1]!, /Bound target: db \(ops@db\.example:22\), environment PROD[^]*Prefer journalctl\.$/u);
    assert.deepEqual(readdirSync(main.cwd), [], "an empty working folder");
    assert.ok(main.cwd.startsWith(folder) && /ssterm-agent-[0-9a-f]{16}\/cwd$/u.test(main.cwd));
    const configPath = main.args[main.args.indexOf("--mcp-config") + 1]!;
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).mcpServers.ssterm.env.SSTERM_MCP_CREDENTIAL, "cred-1");
    assert.ok(!main.args.join(" ").includes("cred-1"), "the credential never appears in argv");
    assert.deepEqual(main.stdin, [{ type: "user", message: { role: "user", content: "check disk" } }]);
    assert.deepEqual(issued[0]!.role!.tools, DELEGATE_TOOLS);
    assert.deepEqual(await runner.send(owner, "s1", "again"), { status: "refused", reason: "busy" }, "one turn at a time");

    const first = structured(await call("delegate_task", { goal: "df -h" }));
    const second = structured(await call("delegate_task", { goal: "uptime" }));
    assert.deepEqual([first, second], [{ taskId: "task-1", status: "running" }, { taskId: "task-2", status: "queued" }]);
    const subs = () => clis.filter((cli) => cli.role === "sub");
    await until(() => subs().length === 1 && subs()[0]!.stdin.length === 1);
    await tick();
    assert.equal(subs().length, 1, "one sub agent at a time");
    const sub = subs()[0]!;
    assert.equal(sub.args[sub.args.indexOf("--allowedTools") + 1], "mcp__ssterm__run_command,mcp__ssterm__read_output,mcp__ssterm__cancel");
    assert.deepEqual([sub.args[sub.args.indexOf("--model") + 1], sub.args[sub.args.indexOf("--effort") + 1]], ["claude-haiku-5-5", "max"], "sub agents use the conversation's choice");
    assert.deepEqual(sub.stdin, [{ type: "user", message: { role: "user", content: "Task task-1: df -h" } }]);
    const subGrant = issued.find((entry) => entry.record)!;
    assert.equal(subGrant.role, undefined, "the sub agent gets the terminal tools");
    subGrant.record!({ command: "df -h", status: "completed", exitCode: 0, output: "/dev/sda1 40%\n", truncated: false });
    subGrant.record!({ command: "rm -rf /", status: "refused", exitCode: null, output: "Refused in Read only mode", truncated: false });

    const waiting = call("get_task_status", { taskId: "task-1", wait: true });
    sub.emit(init(["mcp__ssterm__run_command", "mcp__ssterm__read_output", "mcp__ssterm__cancel"]));
    sub.emit({ type: "result", is_error: false, result: "Disk is at 40%." });
    sub.exit();
    const record = structured(await waiting);
    assert.deepEqual(record, {
      taskId: "task-1", goal: "df -h", status: "completed", limitReached: false, subAgentReport: "Disk is at 40%.",
      commands: [
        { command: "df -h", status: "completed", exitCode: 0, output: "/dev/sda1 40%\n", truncated: false },
        { command: "rm -rf /", status: "refused", exitCode: null, output: "Refused in Read only mode", truncated: false },
      ],
    });
    await tick();
    const card = last().conversations[0]!.tasks[0]!;
    assert.deepEqual({ goal: card.goal, status: card.status, subAgentReport: card.subAgentReport, steps: card.steps }, { goal: record.goal, status: record.status, subAgentReport: record.subAgentReport, steps: record.commands }, "the card shows the same record");
    assert.equal(subGrant.revoked, true, "the sub agent's credential ends with its task");
    await until(() => subs().length === 2 && !!subs()[1]!.stdin.length);
    assert.equal(subs().length, 2, "the queued task starts next");
    assert.equal(last().conversations[0]!.tasks[1]!.status, "running");

    // Cancel: the running sub agent stops and its credential (which interrupts a running command) is revoked.
    const cancelled = structured(await call("cancel_task", { taskId: "task-2" }));
    assert.deepEqual(cancelled, { cancelled: true, status: "cancelled" });
    await tick();
    assert.equal(subs()[1]!.stopped, true);
    assert.equal(issued.filter((entry) => entry.record)[1]!.revoked, true);
    assert.equal((await call("get_task_status", { taskId: "task-9" })).isError, true);
    assert.equal((await call("delegate_task", { goal: "x", extra: 1 })).isError, true);
    assert.equal((await call("run_command", { command: "ls" })).isError, true, "the main agent has no command tool");

    main.emit({ type: "assistant", message: { content: [{ type: "text", text: "Disk is at 40% (exit 0)." }, { type: "tool_use", name: "x" }] } });
    main.emit({ type: "result", is_error: false });
    await tick();
    const view = last().conversations[0]!;
    assert.equal(view.status, "idle");
    assert.deepEqual(view.messages.map((message) => [message.role, message.text]), [["user", "check disk"], ["assistant", "Disk is at 40% (exit 0)."]]);
    assert.ok(isAgentState(last()));
  } finally { await runner.dispose(); cleanup(); }
});

test("close, lock and session end stop every CLI, revoke credentials, refuse pending calls and drop the conversation", async () => {
  for (const end of ["close", "lock", "session", "isolation", "owner"] as const) {
    const { runner, clis, issued, call, last, snapshot, cleanup } = lab();
    try {
      await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "" }, true);
      await runner.open(owner, "s1", 1);
      await runner.send(owner, "s1", "hello");
      await call("delegate_task", { goal: "uptime" });
      await call("delegate_task", { goal: "df" });
      await until(() => clis.length === 2 && clis[1]!.stdin.length === 1);
      const pending = call("get_task_status", { taskId: "task-1", wait: true });
      if (end === "close") await runner.close(owner, "s1");
      else if (end === "lock") await runner.lock();
      else if (end === "owner") runner.revokeOwner(owner);
      else if (end === "isolation") clis[0]!.emit(init(["Bash", "mcp__ssterm__delegate_task"]));
      else { snapshot.state = "Closed"; runner.observe({ ownerId, sessionId: "s1", generation: 1, local: false, hostId: "h1", label: "db", endpoint: null, environment: "PROD" })!.end(); }
      const refused = await pending;
      assert.equal(refused.isError, true, end);
      assert.match(refused.content[0]!.text, /conversation has ended/u);
      await tick();
      assert.ok(clis.every((cli) => cli.stopped), `${end}: every CLI stopped`);
      if (end === "isolation") assert.ok(clis[0]!.killed, "an isolation violation is SIGKILLed at once");
      assert.ok(issued.every((entry) => entry.revoked), `${end}: every credential revoked`);
      if (end !== "owner") assert.deepEqual(last().conversations, [], end);
      assert.deepEqual(await runner.send(owner, "s1", "more"), { status: "refused", reason: "ended" });
      assert.equal((await call("delegate_task", { goal: "x" })).isError, true);
      assert.deepEqual(runner.pids(), []);
    } finally { await runner.dispose(); cleanup(); }
  }
});

test("agent IPC: owner-authorized, app-lock gated, exactly one valid argument", async (t) => {
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send() {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  let open = true;
  boundary.setAccessGate(() => open);
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } };
  const fixture = lab();
  t.after(fixture.cleanup);
  const unregister = registerAgentHandlers({ ipc, boundary, runner: () => fixture.runner });
  assert.deepEqual([...handlers.keys()].sort(), [...agentChannels].sort());
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  const ownerOne = { windowId: 1, generation: 1 };
  assert.deepEqual(await call(channels.openAgent, { owner: ownerOne, sessionId: "s1", generation: 1 }), { ok: true, value: { status: "refused", reason: "disabled" } });
  assert.deepEqual(await call(channels.configureAgent, { owner: ownerOne, settings: { enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "" }, consent: false }), { ok: true, value: { status: "consent-required" } });
  assert.deepEqual(await call(channels.openAgent, { owner: ownerOne, sessionId: "s1", generation: 1 }, "extra"), failure("invalid-request"));
  assert.deepEqual(await call(channels.sendAgent, { owner: ownerOne, sessionId: "s1", text: "" }), failure("invalid-request"));
  assert.deepEqual(await call(channels.agentState, { owner: { windowId: 1, generation: 9 } }), failure("stale-owner"));
  const forged = { sender, senderFrame: { url: "https://evil.example/" } } as unknown as IpcMainInvokeEvent;
  assert.equal(((await handlers.get(channels.agentState)!(forged, { owner: ownerOne })) as { ok: boolean }).ok, false);
  open = false;
  assert.deepEqual(await call(channels.agentSettings, { owner: ownerOne }), failure("unauthorized"), "the app lock answers first");
  open = true;
  assert.deepEqual(await call(channels.sendAgent, { owner: ownerOne, sessionId: "s1", text: "hi" }), { ok: true, value: { status: "refused", reason: "ended" } });
  assert.deepEqual(await call(channels.closeAgent, { owner: ownerOne, sessionId: "s1" }), { ok: true, value: { accepted: true } });
  unregister();
  assert.equal(handlers.size, 0);
});

test("isolation detector mirrors the spike: hooks, extra tools/servers, non-builtin plugins, skills, commands or agents, and a partial init fail closed", () => {
  const allowed = ["mcp__ssterm__run_command"];
  assert.equal(isolationViolation(init(allowed), allowed), undefined);
  assert.equal(isolationViolation({ type: "assistant" }, allowed), undefined);
  for (const [event, reason] of [
    [{ type: "system", subtype: "hook_started", hook_name: "SessionStart" }, /hook/u],
    [init(["Bash", ...allowed]), /tools/u],
    [init(allowed, { mcp_servers: [{ name: "ssterm" }, { name: "decoy" }] }), /MCP server/u],
    [init(allowed, { plugins: [{ name: "evil", path: "/Users/u/.claude/plugins/evil" }] }), /plugin/u],
    [init(allowed, { skills: ["deploy"] }), /skills/u],
    [init(allowed, { slash_commands: ["leak"] }), /skills or slash/u],
    [init(allowed, { agents: ["claude", "my-agent"] }), /agent/u],
    [{ type: "system", subtype: "init", tools: allowed, mcp_servers: [] }, /did not report/u],
  ] as const) assert.match(isolationViolation(event as Record<string, unknown>, allowed) ?? "", reason, JSON.stringify(event).slice(0, 80));
});

test("bounded records: a task stops at its command limit unrun; cards show a 4 KiB tail; get_task_status stays under its budget", async () => {
  const { runner, clis, issued, call, structured, last, cleanup } = lab();
  try {
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "" }, true);
    await runner.open(owner, "s1", 1);
    await runner.send(owner, "s1", "go");
    await call("delegate_task", { goal: "many" });
    await until(() => clis.length === 2);
    const grant = issued.find((entry) => entry.record)!;
    const big = "x".repeat(60_000) + "END";
    for (let i = 0; i < 64; i++) {
      assert.equal(grant.admit!(), undefined);
      grant.record!({ command: `cat f${i}`, status: "completed", exitCode: 0, output: big, truncated: false });
    }
    assert.match(grant.admit!()!, /limit of 64 commands; nothing more was sent/u);
    const view = last().conversations[0]!.tasks[0]!;
    assert.equal(view.limitReached, true);
    assert.equal(view.steps.length, 64);
    assert.ok(view.steps.every((step) => step.output.length < 4_200 && step.output.endsWith("END") && step.truncated));
    assert.ok(isAgentState(last()));
    const record = structured(await call("get_task_status", { taskId: "task-1" }));
    assert.equal(record.limitReached, true);
    assert.ok(JSON.stringify(record).length < 300_000, "under the endpoint's buffer");
    assert.equal(record.commands.at(-1).output, big, "the newest commands are complete");
    assert.match(record.commands[0].output, /^\[ssterm: output shortened/u);
    assert.deepEqual(taskRecord({ id: "task-9", goal: "g", status: "queued", subAgentReport: null, limitReached: false, steps: [] }).commands, []);
  } finally { await runner.dispose(); cleanup(); }
});

test("the conversation limit holds across concurrent opens; one open per session at a time", async () => {
  const { runner, cleanup } = lab();
  try {
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "" }, true);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => runner.open(owner, `s${i + 1}`, 1)));
    assert.equal(results.filter((result) => result.status === "opened").length, 8);
    assert.equal(results.filter((result) => result.status === "refused" && result.reason === "limit").length, 2);
    const same = await Promise.all([runner.open(owner, "s20", 1), runner.open(owner, "s20", 1)]);
    assert.deepEqual(same.map((result) => result.status).sort(), ["refused", "refused"], "the limit is already full");
    await runner.close(owner, "s1");
    const pair = await Promise.all([runner.open(owner, "s21", 1), runner.open(owner, "s21", 1)]);
    assert.deepEqual(pair.map((result) => result.status).sort(), ["opened", "refused"]);
  } finally { await runner.dispose(); cleanup(); }
});

test("startup sweep removes only this profile's leftover run folders and their residue", async () => {
  const home = temp();
  try {
    const mine = join(home, "ssterm-agent-00000000000000aa");
    const theirs = join(home, "ssterm-agent-00000000000000bb");
    for (const [root, profile] of [[mine, "/profile/one"], [theirs, "/profile/two"]] as const) {
      mkdirSync(join(root, "cwd"), { recursive: true });
      writeFileSync(join(root, "profile"), profile);
      mkdirSync(join(home, "Library", "Caches", "claude-cli-nodejs", `-T-${root.split("/").at(-1)}-cwd`), { recursive: true });
    }
    mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
    writeFileSync(join(home, ".claude", "sessions", "77.json"), JSON.stringify({ cwd: `${mine}/cwd` }));
    writeFileSync(join(home, ".claude", "sessions", "77.a.key"), "k");
    assert.equal(await sweepStaleRuns({ tmp: home, home, profile: "/profile/one" }), 1);
    assert.equal(existsSync(mine), false);
    assert.ok(existsSync(theirs), "another profile's run is never touched");
    assert.deepEqual(readdirSync(join(home, "Library", "Caches", "claude-cli-nodejs")), ["-T-ssterm-agent-00000000000000bb-cwd"]);
    assert.deepEqual(readdirSync(join(home, ".claude", "sessions")), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
