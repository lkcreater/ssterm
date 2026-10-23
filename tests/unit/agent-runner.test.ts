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
import type { AgentGate, AgentStepRecord, AgentToolRole, ToolResult } from "../../apps/desktop/src/main/agent-mcp.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import {
  AGENT_DISCLOSURE_VERSION, AGENT_MODELS, effectiveDefaultModel, channels, failure, isAgentState, isConfigureAgentRequest, isSendAgentRequest, isOpenAgentRequest,
  isCancelAgentTaskRequest, type AgentState,
} from "../../packages/contracts/src/index.ts";
import { classifyReadOnly, type SessionSnapshot } from "../../packages/services/src/index.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../packages/services/src/agent-terminal.ts";
import { APPROVAL_WAIT_MS } from "../../apps/desktop/src/main/agent-policy.ts";

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
  // The spike's variables, plus one addition (ticket 04): a per-call MCP wall clock above the approval wait and command timeout.
  assert.deepEqual({ ...CLAUDE_ENV }, { ...spike.CLAUDE_ENV, MCP_TOOL_TIMEOUT: "1800000" });
  assert.ok(Number(CLAUDE_ENV.MCP_TOOL_TIMEOUT) > APPROVAL_WAIT_MS + DEFAULT_AGENT_TIMEOUT_MS + 60_000);
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
  // SST-043: one answer in the user's language; English goals that name the report language; the sub agent follows it.
  assert.match(prompt, /always answer in the language of the user's latest message/u);
  assert.match(prompt, /delegate_task goals in English[^\n]*"Report in Thai\."/u);
  assert.match(prompt, /\(ssterm instructions sst-043-01\)/u);
  assert.match(agentInstructions("sub", { label: "db", endpoint: "db:22", environment: null }, ""), /final report in the language the task requests[^\n]*English/u);
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
  assert.deepEqual(parseAgentSettings(encode(valid)), { enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "high", instructions: "Prefer journalctl.", allowFullAllowOnProd: false, custom: null, disclosure: AGENT_DISCLOSURE_VERSION, customCheck: null },
    "a ticket 03 version 1 record reads with Full allow on PROD off");
  const v2 = { ...valid, version: 2, allowFullAllowOnProd: true };
  assert.equal(parseAgentSettings(encode(v2)).allowFullAllowOnProd, true);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(serializeAgentSettings(parseAgentSettings(encode(v2))))), { ...v2, version: 3, custom: null, customCheck: null }, "written as version 3");
  assert.equal(parseAgentSettings(encode({ ...valid, model: "claude-sonnet-5-5" })).model, effectiveDefaultModel("claude"), "an unverified model falls back");
  assert.equal(parseAgentSettings(encode({ ...valid, model: "claude-opus-5-5" })).model, "claude-opus-5-5", "verified by user decision 2026-10-23");
  assert.equal(AGENT_MODELS.claude.defaultModel, "claude-opus-5-5");
  assert.equal(AGENT_MODELS.claude.defaultEffort, "xhigh");
  assert.deepEqual([DEFAULT_AGENT_SETTINGS.model, DEFAULT_AGENT_SETTINGS.effort], ["claude-opus-5-5", "xhigh"], "the user's default applies (verified)");
  assert.equal(effectiveDefaultModel("claude"), "claude-opus-5-5");
  assert.deepEqual(parseAgentSettings(serializeAgentSettings({ ...DEFAULT_AGENT_SETTINGS })), DEFAULT_AGENT_SETTINGS);
  assert.equal(parseAgentSettings(encode({ ...valid, disclosure: 0 })).enabled, false);
  for (const bad of [undefined, new Uint8Array([0xff]), encode([]), encode({ ...valid, version: 2 }), encode({ ...valid, allowFullAllowOnProd: true }), encode({ ...v2, allowFullAllowOnProd: "yes" }), encode({ ...v2, version: 3 }), encode({ ...valid, provider: "codex" }),
    encode({ ...valid, apiKey: "x" }), encode({ ...valid, instructions: "a\u0007" }), encode({ ...valid, instructions: "x".repeat(4_001) }),
    encode({ ...valid, model: "-p" }), encode({ ...valid, effort: "ultra" })])
    assert.deepEqual(parseAgentSettings(bad), DEFAULT_AGENT_SETTINGS);
  const settings = { enabled: true, provider: "claude", model: "claude-custom:v1.2", effort: "max", instructions: "", allowFullAllowOnProd: false, custom: null };
  assert.ok(isConfigureAgentRequest({ owner, settings, consent: true }));
  for (const bad of [{ owner, settings: { ...settings, provider: "gemini" }, consent: true },
    { owner, settings: { ...settings, custom: { label: "x" } }, consent: true },
    { owner, settings: { ...settings, path: "/bin/sh" }, consent: true },
    { owner, settings: { ...settings, model: "--model" }, consent: true },
    { owner, settings: { ...settings, model: "a b" }, consent: true },
    { owner, settings: { ...settings, model: "x\u0001" }, consent: true },
    { owner, settings: { ...settings, effort: "huge" }, consent: true },
    { owner, settings: { ...settings, allowFullAllowOnProd: 1 }, consent: true },
    { owner, settings: { enabled: true, provider: "claude", model: "haiku", effort: "max", instructions: "" }, consent: true },
    { owner, settings }])
    assert.equal(isConfigureAgentRequest(bad), false);
  assert.equal(isSendAgentRequest({ owner, sessionId: "s1", text: "   " }), false);
  assert.equal(isSendAgentRequest({ owner, sessionId: "s1", text: "x".repeat(8_001) }), false);
  assert.equal(isOpenAgentRequest({ owner, sessionId: "../x", generation: 1 }), false);
  assert.equal(isCancelAgentTaskRequest({ owner, sessionId: "s1", taskId: "1" }), false);
});

// ---------------------------------------------------------------------------------------------------------------
// The runner with a scripted CLI and a recording terminal endpoint.

interface FakeCli extends CliProcess { role: "main" | "sub"; args: string[]; env: Record<string, string>; cwd: string; stdin: (object | string)[]; emit(event: object): void; exit(): void; stopped: boolean; readonly killed: boolean }
function lab(options: { local?: boolean; team?: boolean; environment?: "DEV" | "PROD"; approvalMs?: number; stallMs?: number; interruptMs?: number } = {}) {
  const folder = temp();
  const clis: FakeCli[] = [];
  const issued: { credential: string; role?: AgentToolRole; record?: (step: AgentStepRecord) => void; admit?: (reserve: boolean) => string | undefined; gate?: AgentGate; revoked: boolean }[] = [];
  const snapshot: Partial<SessionSnapshot> = {
    id: "s1", kind: "terminal", generation: 1, state: "Ready", hostId: "h1", ...(options.local ? { local: { shell: "/bin/zsh", platform: "darwin" } as never } : {}),
    target: { label: "db", address: "db.example", port: 22, username: "ops", environment: options.environment ?? "PROD", hostRevision: 1, catalogRevision: 1, ...(options.team ? { source: "team" as const } : {}) },
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
    ...(options.approvalMs ? { approvalMs: options.approvalMs } : {}),
    ...(options.stallMs ? { stallMs: options.stallMs } : {}),
    ...(options.interruptMs ? { interruptMs: options.interruptMs } : {}),
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
    const settings = { enabled: true, provider: "claude" as const, model: "claude-haiku-5-5", effort: "xhigh" as const, instructions: "", allowFullAllowOnProd: false, custom: null };
    assert.deepEqual(await runner.configure(settings, false), { status: "consent-required" });
    assert.equal(stored(), undefined, "nothing saved without consent");
    setVersion("unsupported-version");
    assert.equal((await runner.configure(settings, true)).status, "provider-unavailable");
    setVersion("ready");
    const saved = await runner.configure(settings, true);
    assert.equal(saved.status, "saved");
    assert.deepEqual(JSON.parse(new TextDecoder().decode(stored())), { version: 3, enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "", allowFullAllowOnProd: false, custom: null, customCheck: null, disclosure: AGENT_DISCLOSURE_VERSION });
    assert.deepEqual(await runner.configure({ ...settings, model: "claude-sonnet-5-5" }, true), { status: "model-unverified" }, "A14: unverified models never run");
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
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "max", instructions: "Prefer journalctl.", allowFullAllowOnProd: false, custom: null }, true);
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
    assert.equal(sub.args[sub.args.indexOf("--allowedTools") + 1], "mcp__ssterm__propose_plan,mcp__ssterm__run_command,mcp__ssterm__read_output,mcp__ssterm__cancel");
    assert.deepEqual([sub.args[sub.args.indexOf("--model") + 1], sub.args[sub.args.indexOf("--effort") + 1]], ["claude-haiku-5-5", "max"], "sub agents use the conversation's choice");
    assert.deepEqual(sub.stdin, [{ type: "user", message: { role: "user", content: "Task task-1: df -h" } }]);
    const subGrant = issued.find((entry) => entry.record)!;
    assert.equal(subGrant.role, undefined, "the sub agent gets the terminal tools");
    subGrant.record!({ command: "df -h", status: "completed", exitCode: 0, output: "/dev/sda1 40%\n", truncated: false, via: "read-only" });
    subGrant.record!({ command: "rm -rf /", status: "refused", exitCode: null, output: "Refused in Read only mode", truncated: false, via: null });

    const waiting = call("get_task_status", { taskId: "task-1", wait: true });
    sub.emit(init(["mcp__ssterm__propose_plan", "mcp__ssterm__run_command", "mcp__ssterm__read_output", "mcp__ssterm__cancel"]));
    sub.emit({ type: "result", is_error: false, result: "Disk is at 40%." });
    sub.exit();
    const record = structured(await waiting);
    assert.deepEqual(record, {
      taskId: "task-1", goal: "df -h", status: "completed", limitReached: false, subAgentReport: "Disk is at 40%.", plan: null,
      commands: [
        { command: "df -h", status: "completed", exitCode: 0, output: "/dev/sda1 40%\n", truncated: false, via: "read-only" },
        { command: "rm -rf /", status: "refused", exitCode: null, output: "Refused in Read only mode", truncated: false, via: null },
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

test("SST-043: a sub agent's report reaches a waiting main agent at once; a lingering or crashed sub agent never leaves the turn waiting", async () => {
  const { runner, clis, issued, call, structured, last, cleanup } = lab({ interruptMs: 50 });
  try {
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "", allowFullAllowOnProd: false, custom: null }, true);
    await runner.open(owner, "s1", 1);
    await runner.send(owner, "s1", "which docker");
    await call("delegate_task", { goal: "which docker" });
    await call("delegate_task", { goal: "uptime" });
    const subs = () => clis.filter((cli) => cli.role === "sub");
    await until(() => subs().length === 1 && subs()[0]!.stdin.length === 1);
    // A read-only command that exits 1 is recorded like any other.
    issued.find((entry) => entry.record)!.record!({ command: "{ which docker podman; } </dev/null", status: "completed", exitCode: 1, output: "/usr/bin/docker\n", truncated: false, via: "read-only" });
    const waiting = call("get_task_status", { taskId: "task-1", wait: true });
    const started = Date.now();
    subs()[0]!.emit({ type: "result", is_error: false, result: "docker is installed; podman is not." });
    // The CLI has not exited, yet the waiting call returns the final record (waitMs is 2 s in this lab).
    const record = structured(await waiting);
    assert.ok(Date.now() - started < 1_000, "no wait for the CLI to exit");
    assert.equal(record.status, "completed");
    assert.equal(record.commands[0].exitCode, 1);
    await until(() => subs()[0]!.stopped);
    // The next task's sub agent crashes without a result: the task fails with a report, and the waiter returns.
    await until(() => subs().length === 2 && subs()[1]!.stdin.length === 1);
    const crashed = call("get_task_status", { taskId: "task-2", wait: true });
    subs()[1]!.exit();
    const failed = structured(await crashed);
    assert.equal(failed.status, "failed");
    assert.equal(failed.subAgentReport, "The sub agent CLI exited without a report.");
    // The main agent exits without a result: the turn ends with a notice, and the next message starts a new process
    // that is given the conversation so far.
    clis[0]!.exit();
    await until(() => last().conversations[0]!.status === "idle");
    assert.match(last().conversations[0]!.messages.at(-1)!.text, /^The agent CLI exited\. Your next message starts a new one/u);
    assert.deepEqual(await runner.send(owner, "s1", "and podman?"), { status: "sent" });
    await until(() => clis.filter((cli) => cli.role === "main").length === 2);
    const fresh = clis.filter((cli) => cli.role === "main")[1]!;
    const content = (fresh.stdin[0] as { message: { content: string } }).message.content;
    assert.match(content, /^The conversation so far \(kept by ssterm\):\n\nUser: which docker[^]*The user's new message:\nand podman\?$/u);
  } finally { await runner.dispose(); cleanup(); }
});

test("SST-043 Stop: cancels tasks with Ctrl+C, withdraws cards, interrupts the turn and drops what it still says; the watchdog stops a silent turn", async () => {
  const { runner, clis, issued, call, structured, last, cleanup } = lab({ interruptMs: 80, stallMs: 150 });
  try {
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "", allowFullAllowOnProd: false, custom: null }, true);
    await runner.open(owner, "s1", 1);
    assert.equal(runner.stopTurn(owner, "s1"), false, "nothing to stop while idle");
    await runner.send(owner, "s1", "restart nginx");
    await call("delegate_task", { goal: "restart nginx" });
    await call("delegate_task", { goal: "uptime" });
    await until(() => clis.length === 2 && clis[1]!.stdin.length === 1);
    const grant = issued.find((entry) => entry.gate)!;
    const card = grant.gate!.authorize("systemctl restart nginx", classifyReadOnly("systemctl restart nginx"), new AbortController().signal);
    await until(() => !!last().conversations[0]!.tasks[0]!.approval);
    const waiting = call("get_task_status", { taskId: "task-1", wait: true });
    assert.equal(runner.stopTurn(owner, "s1"), true);
    const view = last().conversations[0]!;
    assert.equal(view.status, "stopping", "M1: until the interrupted turn ends");
    assert.equal(runner.stopTurn(owner, "s1"), false);
    assert.deepEqual(view.tasks.map((task) => task.status), ["cancelled", "cancelled"]);
    const decided = await card;
    assert.match("refuse" in decided ? decided.refuse : "", /approval was withdrawn/u);
    assert.equal(grant.revoked, true, "the running task's credential is revoked (a running command gets Ctrl+C)");
    assert.equal(structured(await waiting).status, "cancelled");
    assert.equal(view.messages.at(-1)!.text, "Stopped by you. Running and queued tasks were cancelled and pending requests withdrawn.");
    const main = clis[0]!;
    assert.deepEqual(main.stdin.at(-1), { type: "control_request", request_id: "ssterm-stop-2", request: { subtype: "interrupt" } });
    // M1: a message sent before the interrupted turn ends is refused, never lost.
    assert.deepEqual(await runner.send(owner, "s1", "too early"), { status: "refused", reason: "busy" });
    assert.ok(!last().conversations[0]!.messages.some((message) => message.text === "too early"));
    // The interrupted turn ends with its result; what it said after Stop is not shown, and the process stays.
    main.emit({ type: "assistant", message: { content: [{ type: "text", text: "Restarted nginx." }] } });
    main.emit({ type: "result", is_error: true });
    assert.equal(last().conversations[0]!.status, "idle");
    await new Promise((done) => setTimeout(done, 120));
    assert.equal(main.stopped, false);
    assert.ok(!last().conversations[0]!.messages.some((message) => message.text === "Restarted nginx." || /with an error/u.test(message.text)));

    // The watchdog: a turn that stays silent is stopped with a notice; a CLI that ignores the interrupt is stopped.
    await runner.send(owner, "s1", "hello");
    assert.equal(last().conversations[0]!.status, "thinking");
    await until(() => last().conversations[0]!.status === "stopping");
    assert.match(last().conversations[0]!.messages.at(-1)!.text, /^Nothing came from the agent for 0 seconds, so ssterm stopped this turn/u);
    await until(() => last().conversations[0]!.status === "idle");
    await until(() => main.stopped);
    await until(() => /^The agent CLI was stopped/u.test(last().conversations[0]!.messages.at(-1)!.text));
    assert.match(last().conversations[0]!.messages.at(-1)!.text, /^The agent CLI was stopped\. Your next message starts a new one/u);
  } finally { await runner.dispose(); cleanup(); }
});

test("SST-043: context share from the CLI's own usage report; model and effort from the panel apply from the next message; undelivered messages are not replayed", async () => {
  const { runner, clis, last, cleanup, setVersion, stored } = lab();
  try {
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "", allowFullAllowOnProd: false, custom: null }, true);
    await runner.open(owner, "s1", 1);
    await runner.send(owner, "s1", "hi");
    const main = clis[0]!;
    assert.deepEqual(await runner.setModel(owner, "s1", 1, "claude-opus-5-5", "max", false), { status: "refused", reason: "busy" });
    main.emit({ type: "assistant", message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "Hello." }],
      usage: { input_tokens: 1_000, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 4_000, output_tokens: 50 } } });
    assert.equal(last().conversations[0]!.context, null, "no window reported yet: nothing is guessed");
    main.emit({ type: "result", is_error: false, modelUsage: { "claude-haiku-5-5": { inputTokens: 1_000, contextWindow: 200_000 } } });
    assert.equal(last().conversations[0]!.context, 13);
    assert.equal(last().conversations[0]!.status, "idle");

    assert.deepEqual(await runner.setModel(owner, "s1", 1, "claude-sonnet-5-5", "max", false), { status: "refused", reason: "model-unverified" });
    assert.deepEqual(await runner.setModel(owner, "s1", 2, "claude-opus-5-5", "max", false), { status: "refused", reason: "ended" });
    assert.deepEqual(await runner.setModel(owner, "s1", 1, "claude-opus-5-5", "max", true), { status: "set" });
    assert.equal(JSON.parse(new TextDecoder().decode(stored())).model, "claude-opus-5-5", "Set as default saves it");
    assert.equal(JSON.parse(new TextDecoder().decode(stored())).effort, "max");
    await until(() => main.stopped);
    await tick();
    const view = last().conversations[0]!;
    assert.deepEqual([view.model, view.effort, view.context], ["claude-opus-5-5", "max", null]);
    assert.equal(view.messages.at(-1)!.text, "Model changed to Claude Opus 5.5 (effort max). It applies from your next message and is now the default.");
    assert.ok(!view.messages.some((message) => /The agent CLI (exited|was stopped)/u.test(message.text)), "the old process ends quietly");

    // L1: a message that never reached a CLI is not replayed to the next process.
    setVersion("unsupported-version");
    await runner.send(owner, "s1", "lost message");
    await until(() => last().conversations[0]!.status === "idle");
    setVersion("ready");
    await runner.send(owner, "s1", "and now");
    await until(() => clis.length === 2 && clis[1]!.stdin.length === 1);
    const fresh = clis[1]!;
    assert.deepEqual([fresh.args[fresh.args.indexOf("--model") + 1], fresh.args[fresh.args.indexOf("--effort") + 1]], ["claude-opus-5-5", "max"]);
    const content = (fresh.stdin[0] as { message: { content: string } }).message.content;
    assert.match(content, /User: hi\n\nAgent: Hello\.[^]*The user's new message:\nand now$/u);
    assert.doesNotMatch(content, /lost message/u);
  } finally { await runner.dispose(); cleanup(); }
});

test("close, lock and session end stop every CLI, revoke credentials, refuse pending calls and drop the conversation", async () => {
  for (const end of ["close", "lock", "session", "isolation", "owner"] as const) {
    const { runner, clis, issued, call, last, snapshot, cleanup } = lab();
    try {
      await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "", allowFullAllowOnProd: false, custom: null }, true);
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
  assert.deepEqual(await call(channels.configureAgent, { owner: ownerOne, settings: { enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "", allowFullAllowOnProd: false, custom: null }, consent: false }), { ok: true, value: { status: "consent-required" } });
  assert.deepEqual(await call(channels.openAgent, { owner: ownerOne, sessionId: "s1", generation: 1 }, "extra"), failure("invalid-request"));
  assert.deepEqual(await call(channels.sendAgent, { owner: ownerOne, sessionId: "s1", text: "" }), failure("invalid-request"));
  assert.deepEqual(await call(channels.agentState, { owner: { windowId: 1, generation: 9 } }), failure("stale-owner"));
  const forged = { sender, senderFrame: { url: "https://evil.example/" } } as unknown as IpcMainInvokeEvent;
  assert.equal(((await handlers.get(channels.agentState)!(forged, { owner: ownerOne })) as { ok: boolean }).ok, false);
  // Ticket 04: mode and decision channels, owner-checked and bound to a live conversation generation.
  const decision = { owner: ownerOne, sessionId: "s1", generation: 1, approvalId: "plan-0123abcd-1", decision: "approve", production: true };
  assert.deepEqual(await call(channels.setAgentMode, { owner: ownerOne, sessionId: "s1", generation: 1, mode: "full-allow", acknowledged: true }), { ok: true, value: { status: "refused", reason: "ended" } });
  assert.deepEqual(await call(channels.setAgentMode, { owner: ownerOne, sessionId: "s1", generation: 1, mode: "yolo", acknowledged: true }), failure("invalid-request"));
  assert.deepEqual(await call(channels.decideAgent, decision), { ok: true, value: { status: "refused", reason: "stale" } });
  assert.deepEqual(await call(channels.decideAgent, { ...decision, approvalId: "plan-1" }), failure("invalid-request"));
  assert.deepEqual(await call(channels.decideAgent, decision, "extra"), failure("invalid-request"));
  assert.deepEqual(await call(channels.decideAgent, { ...decision, owner: { windowId: 1, generation: 9 } }), failure("stale-owner"));
  assert.equal(((await handlers.get(channels.decideAgent)!(forged, decision)) as { ok: boolean }).ok, false);
  open = false;
  assert.deepEqual(await call(channels.agentSettings, { owner: ownerOne }), failure("unauthorized"), "the app lock answers first");
  assert.deepEqual(await call(channels.decideAgent, decision), failure("unauthorized"));
  assert.deepEqual(await call(channels.setAgentMode, { owner: ownerOne, sessionId: "s1", generation: 1, mode: "auto", acknowledged: false }), failure("unauthorized"));
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
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "", allowFullAllowOnProd: false, custom: null }, true);
    await runner.open(owner, "s1", 1);
    await runner.send(owner, "s1", "go");
    await call("delegate_task", { goal: "many" });
    await until(() => clis.length === 2);
    const grant = issued.find((entry) => entry.record)!;
    const big = "x".repeat(60_000) + "END";
    for (let i = 0; i < 64; i++) {
      assert.equal(grant.admit!(true), undefined);
      grant.record!({ command: `cat f${i}`, status: "completed", exitCode: 0, output: big, truncated: false, via: "read-only" });
    }
    assert.match(grant.admit!(true)!, /limit of 64 commands; nothing more was sent/u);
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
    assert.deepEqual(taskRecord({ id: "task-9", goal: "g", status: "queued", subAgentReport: null, limitReached: false, steps: [], plan: null, approval: null, afterMessage: 0 }).commands, []);
  } finally { await runner.dispose(); cleanup(); }
});

test("the conversation limit holds across concurrent opens; one open per session at a time", async () => {
  const { runner, cleanup } = lab();
  try {
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "", allowFullAllowOnProd: false, custom: null }, true);
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

// ---------------------------------------------------------------------------------------------------------------
// Ticket 04: modes, plans, approvals and PROD gates, enforced in main whatever the agent's instructions say.

const verdict = (command: string) => classifyReadOnly(command);
/** An MCP request that is never cancelled. */
const live = () => new AbortController().signal;
async function startTask(fixture: ReturnType<typeof lab>, settings: Partial<{ allowFullAllowOnProd: boolean }> = {}) {
  await fixture.runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "", allowFullAllowOnProd: false, custom: null, ...settings }, true);
  await fixture.runner.open(owner, "s1", 1);
  await fixture.runner.send(owner, "s1", "go");
  await fixture.call("delegate_task", { goal: "work" });
  await until(() => fixture.issued.some((entry) => entry.gate));
  return fixture.issued.find((entry) => entry.gate)!.gate!;
}
const task = (fixture: ReturnType<typeof lab>) => fixture.last().conversations[0]!.tasks[0]!;
/** Approval ids carry the conversation's nonce (L4); it is read from the first card. */
let nonce = "";
const id = (kind: "plan" | "command", n: number) => `${kind}-${nonce}-${n}`;
const learnNonce = (fixture: ReturnType<typeof lab>) => {
  const current = task(fixture);
  nonce = /^(?:plan|command)-([0-9a-f]{8})-\d+$/u.exec((current.plan ?? current.approval)!.id)![1]!;
};
const refusal = (decision: Awaited<ReturnType<AgentGate["authorize"]>>) => "refuse" in decision ? decision.refuse : "";

test("Auto (the default): read-only runs; plan commands run once each after approval; anything else waits for its own card", async () => {
  const fixture = lab({ environment: "DEV", approvalMs: 150 });
  const { runner } = fixture;
  try {
    const gate = await startTask(fixture);
    assert.deepEqual([fixture.last().conversations[0]!.mode, fixture.last().conversations[0]!.fullAllowAvailable], ["auto", true]);
    assert.deepEqual(await gate.authorize("cat /etc/hostname", verdict("cat /etc/hostname"), live()), { run: "cat /etc/hostname", via: "read-only" });

    // Nothing outside read-only runs before the plan is approved: a card is raised instead.
    const proposing = gate.propose({ goal: "Restart nginx", commands: ["systemctl restart nginx", "touch /tmp/a"] }, live());
    await tick();
    learnNonce(fixture);
    const plan = task(fixture).plan!;
    assert.deepEqual(plan, { id: id("plan", 1), goal: "Restart nginx", status: "pending", commands: [{ command: "systemctl restart nginx", ran: false }, { command: "touch /tmp/a", ran: false }] });
    assert.ok(isAgentState(fixture.last()));
    assert.equal(((await gate.propose({ goal: "Other", commands: ["ls"] }, live())) as ToolResult).isError, true, "one pending plan at a time");
    assert.deepEqual(runner.decide(owner, "s1", 2, id("plan", 1), "approve", false), { status: "refused", reason: "stale" }, "bound to the generation");
    assert.deepEqual(runner.decide(owner, "s2", 1, id("plan", 1), "approve", false), { status: "refused", reason: "stale" }, "bound to the session");
    assert.deepEqual(runner.decide({ windowId: 2, generation: 1 }, "s1", 1, id("plan", 1), "approve", false), { status: "refused", reason: "stale" }, "bound to the owner");
    assert.deepEqual(runner.decide(owner, "s1", 1, id("command", 1), "approve", false), { status: "refused", reason: "stale" });
    assert.deepEqual(runner.decide(owner, "s1", 1, `plan-${nonce === "00000000" ? "00000001" : "00000000"}-1`, "approve", false), { status: "refused", reason: "stale" }, "another conversation's nonce");
    assert.deepEqual(runner.decide(owner, "s1", 1, id("plan", 1), "approve", false), { status: "applied" });
    assert.deepEqual(runner.decide(owner, "s1", 1, id("plan", 1), "reject", false), { status: "refused", reason: "stale" }, "decided once");
    const approved = (await proposing).structuredContent as Record<string, unknown>;
    assert.deepEqual([approved.planId, approved.status], [id("plan", 1), "approved"]);

    const first = await gate.authorize("  systemctl restart nginx\t", verdict("systemctl restart nginx"), live());
    assert.deepEqual([("run" in first) && first.run, ("via" in first) && first.via], ["systemctl restart nginx", "plan"], "the approved text runs");
    assert.equal(task(fixture).plan!.commands[0]!.ran, true);
    // The executor gave it back (nothing reached the shell): it may run again.
    if ("undo" in first) first.undo!();
    assert.equal(task(fixture).plan!.commands[0]!.ran, false);
    assert.equal((await gate.authorize("systemctl restart nginx", verdict("systemctl restart nginx"), live()) as { via: string }).via, "plan");

    // Used up, and a trailing chain: each asks the user.
    const again = gate.authorize("systemctl restart nginx", verdict("systemctl restart nginx"), live());
    await tick();
    assert.deepEqual(task(fixture).approval, { id: id("command", 2), command: "systemctl restart nginx" });
    assert.match(refusal(await gate.authorize("touch /tmp/b", verdict("touch /tmp/b"), live())), /already waiting for the user's approval/u, "one command card at a time");
    assert.deepEqual(runner.decide(owner, "s1", 1, id("command", 2), "reject", false), { status: "applied" });
    assert.match(refusal(await again), /^Not run: [^]*The user rejected it\.[^]*Nothing was sent/u);
    assert.equal(task(fixture).approval, null);

    const chained = gate.authorize("touch /tmp/a; rm -rf /", verdict("touch /tmp/a; rm -rf /"), live());
    await tick();
    assert.equal(task(fixture).approval!.command, "touch /tmp/a; rm -rf /", "not matched to the plan's touch /tmp/a");
    assert.match(refusal(await chained), /expired/u, "the wait is bounded");
    assert.equal(task(fixture).approval, null);

    const asked = gate.authorize("touch /tmp/c ", verdict("touch /tmp/c"), live());
    await tick();
    assert.deepEqual(runner.decide(owner, "s1", 1, task(fixture).approval!.id, "approve", false), { status: "applied" });
    assert.deepEqual(await asked, { run: "touch /tmp/c", via: "approval" });
    assert.match(refusal(await gate.authorize("echo x\nrm -rf /", verdict("echo x\nrm -rf /"), live())), /more than one line/u, "never a card for an unshowable command");
    const planned = await gate.authorize("touch /tmp/a", verdict("touch /tmp/a"), live());
    assert.deepEqual(["run" in planned && planned.run, "via" in planned && planned.via], ["touch /tmp/a", "plan"]);

    // A new proposal replaces the plan: the old approval no longer applies.
    const replacing = gate.propose({ goal: "More", commands: ["touch /tmp/z"] }, live());
    await tick();
    assert.equal(task(fixture).plan!.id, id("plan", 5));
    assert.deepEqual(runner.decide(owner, "s1", 1, id("plan", 5), "reject", false), { status: "applied" });
    assert.equal(((await replacing).structuredContent as { status: string }).status, "rejected");
    const after = gate.authorize("touch /tmp/a", verdict("touch /tmp/a"), live());
    await tick();
    assert.ok(task(fixture).approval, "the rejected plan grants nothing");
    runner.cancelTask(owner, "s1", "task-1");
    assert.match(refusal(await after), /withdrawn|ended/u, "cancelling the task withdraws its card");
    assert.deepEqual(runner.decide(owner, "s1", 1, id("command", 6), "approve", false), { status: "refused", reason: "stale" });
  } finally { await runner.dispose(); fixture.cleanup(); }
});

test("Read only and Full allow: mode changes withdraw pending cards; Full allow needs the warning acknowledged and resets with a new conversation", async () => {
  const fixture = lab({ environment: "DEV" });
  const { runner } = fixture;
  try {
    const gate = await startTask(fixture);
    const pending = gate.authorize("touch /tmp/a", verdict("touch /tmp/a"), live());
    await tick();
    assert.deepEqual(runner.setMode(owner, "s1", 1, "read-only", false), { status: "set" });
    assert.match(refusal(await pending), /withdrawn/u, "a mode change withdraws the card");
    assert.equal(fixture.last().conversations[0]!.mode, "read-only");
    assert.match(refusal(await gate.authorize("touch /tmp/a", verdict("touch /tmp/a"), live())), /^Refused in Read only mode: `touch`/u);
    assert.equal(task(fixture).approval, null, "Read only never asks");
    assert.equal(((await gate.propose({ goal: "g", commands: ["touch /tmp/a"] }, live())) as ToolResult).isError, true);
    assert.deepEqual(await gate.authorize("uptime", verdict("uptime"), live()), { run: "uptime", via: "read-only" });

    assert.deepEqual(runner.setMode(owner, "s1", 1, "full-allow", false), { status: "refused", reason: "acknowledge" });
    assert.deepEqual(runner.setMode(owner, "s1", 2, "full-allow", true), { status: "refused", reason: "ended" });
    assert.deepEqual(runner.setMode(owner, "s1", 1, "full-allow", true), { status: "set" });
    assert.deepEqual(await gate.authorize("touch /tmp/a", verdict("touch /tmp/a"), live()), { run: "touch /tmp/a", via: "full-allow" });
    assert.deepEqual(await gate.authorize(" \ttouch /tmp/a ", verdict("touch /tmp/a"), live()), { run: "touch /tmp/a", via: "full-allow" }, "L2: the normalized line is typed");
    assert.deepEqual(await gate.authorize("df -h", verdict("df -h"), live()), { run: "df -h", via: "read-only" });
    assert.match(refusal(await gate.authorize("touch a\rrm b", verdict("touch a\rrm b"), live())), /more than one line/u, "still one line");
    assert.equal(((await gate.propose({ goal: "g", commands: ["touch /tmp/a"] }, live())).structuredContent as { status: string }).status, "not-needed");

    // A new conversation (panel close, reconnect, new session) starts in Auto again.
    await runner.close(owner, "s1");
    await runner.open(owner, "s1", 1);
    assert.equal(fixture.last().conversations[0]!.mode, "auto");
    assert.equal(fixture.clis.filter((cli) => !cli.stopped).length, 0);
  } finally { await runner.dispose(); fixture.cleanup(); }
});

test("PROD: Full allow needs the Settings option and still the warning; approving a plan or a command needs the PROD confirmation", async () => {
  const fixture = lab({ environment: "PROD" });
  const { runner } = fixture;
  try {
    const gate = await startTask(fixture);
    assert.equal(fixture.last().conversations[0]!.fullAllowAvailable, false);
    assert.deepEqual(runner.setMode(owner, "s1", 1, "full-allow", true), { status: "refused", reason: "production" }, "off by default");

    const proposing = gate.propose({ goal: "Restart", commands: ["systemctl restart nginx"] }, live());
    await tick();
    learnNonce(fixture);
    assert.deepEqual(runner.decide(owner, "s1", 1, id("plan", 1), "approve", false), { status: "refused", reason: "production" });
    assert.equal(task(fixture).plan!.status, "pending", "still waiting");
    assert.deepEqual(runner.decide(owner, "s1", 1, id("plan", 1), "approve", true), { status: "applied" });
    assert.equal(((await proposing).structuredContent as { status: string }).status, "approved");

    const asked = gate.authorize("touch /tmp/prod", verdict("touch /tmp/prod"), live());
    await tick();
    assert.deepEqual(runner.decide(owner, "s1", 1, id("command", 2), "approve", false), { status: "refused", reason: "production" });
    assert.deepEqual(runner.decide(owner, "s1", 1, id("command", 2), "approve", true), { status: "applied" });
    assert.deepEqual(await asked, { run: "touch /tmp/prod", via: "approval" });
    const rejected = gate.authorize("touch /tmp/prod2", verdict("touch /tmp/prod2"), live());
    await tick();
    assert.deepEqual(runner.decide(owner, "s1", 1, id("command", 3), "reject", false), { status: "applied" }, "rejecting needs no confirmation");
    assert.match(refusal(await rejected), /rejected/u);

    const saved = await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "", allowFullAllowOnProd: true, custom: null }, false);
    assert.equal(saved.status === "saved" && saved.view.settings.allowFullAllowOnProd, true);
    assert.equal(fixture.last().conversations[0]!.fullAllowAvailable, true);
    assert.deepEqual(runner.setMode(owner, "s1", 1, "full-allow", false), { status: "refused", reason: "acknowledge" }, "still the warning step");
    assert.deepEqual(runner.setMode(owner, "s1", 1, "full-allow", true), { status: "set" });
    assert.equal((await gate.authorize("touch /tmp/x", verdict("touch /tmp/x"), live()) as { via: string }).via, "full-allow");
    // Turning the option off returns PROD conversations to Auto at once.
    await runner.configure({ enabled: true, provider: "claude", model: "claude-haiku-5-5", effort: "low", instructions: "", allowFullAllowOnProd: false, custom: null }, false);
    assert.equal(fixture.last().conversations[0]!.mode, "auto");
    assert.match(fixture.last().conversations[0]!.messages.at(-1)!.text, /back in Auto/u);
    const back = gate.authorize("touch /tmp/x", verdict("touch /tmp/x"), live());
    await tick();
    assert.ok(task(fixture).approval, "asks again");
    void runner.close(owner, "s1");
    assert.match(refusal(await back), /withdrawn|ended/u);
  } finally { await runner.dispose(); fixture.cleanup(); }
});

test("pending cards are withdrawn on panel close, lock, session end and owner revoke; their ids are then stale", async () => {
  for (const end of ["close", "lock", "session", "owner"] as const) {
    const fixture = lab({ environment: "DEV" });
    const { runner, snapshot } = fixture;
    try {
      const gate = await startTask(fixture);
      const plan = gate.propose({ goal: "g", commands: ["touch /tmp/a"] }, live());
      const command = gate.authorize("touch /tmp/b", verdict("touch /tmp/b"), live());
      await tick();
      learnNonce(fixture);
      if (end === "close") await runner.close(owner, "s1");
      else if (end === "lock") await runner.lock();
      else if (end === "owner") runner.revokeOwner(owner);
      else { snapshot.state = "Closed"; runner.observe({ ownerId, sessionId: "s1", generation: 1, local: false, hostId: "h1", label: "db", endpoint: null, environment: "DEV" })!.end(); }
      assert.notEqual(((await plan).structuredContent as { status: string }).status, "approved", end);
      assert.ok("refuse" in (await command), end);
      for (const stale of [id("plan", 1), id("command", 2)]) assert.deepEqual(runner.decide(owner, "s1", 1, stale, "approve", false), { status: "refused", reason: "stale" }, `${end} ${stale}`);
    } finally { await runner.dispose(); fixture.cleanup(); }
  }
});

test("M1/L3: an aborted request withdraws its card; every admitted call keeps its record slot, also after the task ended", async () => {
  const fixture = lab({ environment: "DEV" });
  const { runner } = fixture;
  try {
    const gate = await startTask(fixture);
    const request = new AbortController();
    const asked = gate.authorize("touch /tmp/a", verdict("touch /tmp/a"), request.signal);
    await tick();
    learnNonce(fixture);
    assert.ok(task(fixture).approval);
    request.abort();
    assert.match(refusal(await asked), /withdrawn/u);
    assert.equal(task(fixture).approval, null, "the card is gone");
    assert.deepEqual(runner.decide(owner, "s1", 1, id("command", 1), "approve", false), { status: "refused", reason: "stale" });
    const planRequest = new AbortController();
    const proposing = gate.propose({ goal: "g", commands: ["touch /tmp/a"] }, planRequest.signal);
    await tick();
    planRequest.abort();
    assert.equal(((await proposing).structuredContent as { status: string }).status, "cancelled");
    const aborted = new AbortController();
    aborted.abort();
    assert.match(refusal(await gate.authorize("touch /tmp/b", verdict("touch /tmp/b"), aborted.signal)), /withdrawn/u, "no card for an already cancelled request");
    assert.equal(task(fixture).approval, null);

    // Slots: 63 recorded, one admitted and still waiting; the 65th is refused before anything else.
    const grant = fixture.issued.find((entry) => entry.gate)!;
    for (let i = 0; i < 63; i++) {
      assert.equal(grant.admit!(true), undefined);
      grant.record!({ command: `uptime ${i}`, status: "completed", exitCode: 0, output: "", truncated: false, via: "read-only" });
    }
    assert.equal(grant.admit!(true), undefined, "the 64th slot");
    assert.match(grant.admit!(true)!, /limit of 64 commands/u, "a waiting call holds its slot");
    // The task ends while that call is in flight: the late check refuses it, and its record is still kept.
    runner.cancelTask(owner, "s1", "task-1");
    assert.match(grant.admit!(false)!, /task has ended/u);
    grant.record!({ command: "sleep 30", status: "interrupted", exitCode: null, output: "^C", truncated: false, via: "read-only" });
    const view = task(fixture);
    assert.equal(view.steps.length, 64);
    assert.deepEqual([view.steps.at(-1)!.command, view.steps.at(-1)!.status], ["sleep 30", "interrupted"], "not dropped after the cancel");
  } finally { await runner.dispose(); fixture.cleanup(); }
});
