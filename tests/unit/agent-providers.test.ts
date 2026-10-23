// SST-041 ticket 06: the codex adapter (kept disabled) and custom CLI providers with their isolation check. The check
// runs the real fake CLI fixture (tests/fixtures/agent/fake-claude.mjs) through the shipped ssterm-mcp bridge and
// ssterm's local test endpoint; no provider is contacted.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, utimesSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLAUDE_ENV, cleanStateResidue, customEnv, CODEX_DISABLED_FEATURES, CODEX_FAILURES, CODEX_TOOL_TIMEOUT_SEC, cliBaseEnv, codexArgs, codexIsolationConfig, codexViolation, customArgs,
  parseCodexVersion, resolveClaude, resolveCustom, VERIFIED_CODEX_VERSIONS, type CliProcess,
} from "../../apps/desktop/src/main/agent-cli.ts";
import { checkCustomProvider, sanitizeReasons, sweepCheckSockets } from "../../apps/desktop/src/main/agent-check.ts";
import { createAgentRunner, DELEGATE_TOOLS, type AgentSettingsStore } from "../../apps/desktop/src/main/agent-runner.ts";
import { TOOLS, type AgentToolRole } from "../../apps/desktop/src/main/agent-mcp.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { AGENT_MODELS, customProviderProblem, isAgentSettingsView, isVerifiedAgentModel, type AgentCustomProvider, type AgentSettings } from "../../packages/contracts/src/index.ts";
import type { SessionSnapshot } from "../../packages/services/src/index.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../packages/services/src/agent-terminal.ts";
import { APPROVAL_WAIT_MS } from "../../apps/desktop/src/main/agent-policy.ts";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "ssterm-providers-test-")));
const SUB_TOOLS = ["propose_plan", "run_command", "read_output", "cancel"].map((tool) => `mcp__ssterm__${tool}`);
const BRIDGE = resolve("apps/desktop/resources/ssterm-mcp");
const FAKE = resolve("tests/fixtures/agent/fake-claude.mjs");
/** The claude production flags as a custom template (what a user would enter for a newer claude). */
const CLAUDE_TEMPLATE = ["-p", "--output-format", "stream-json", "--verbose", "--include-hook-events", "--input-format", "stream-json",
  "--no-session-persistence", "--restricted", "--strict-mcp-config", "--mcp-config", "{mcpConfigPath}", "--tools", "", "--allowedTools", "{allowedTools}",
  "--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "", "--disable-slash-commands",
  "--model", "{model}", "--effort", "{effort}", "--system-prompt-file", "{systemPromptFile}"];
const definition = (path: string, changes: Partial<AgentCustomProvider> = {}): AgentCustomProvider => ({
  label: "Fake CLI", path, args: [...CLAUDE_TEMPLATE], input: "stream-json", model: "fake-model-1", effort: "high",
  env: Object.entries(CLAUDE_ENV).map(([name, value]) => ({ name, value })), endpointEnv: "ANTHROPIC_BASE_URL", toolTimeoutSec: 60, ...changes,
});
/** A wrapper standing in for an installed CLI: its own version output (from a file) and the fake CLI with this Node. */
function wrapper(folder: string) {
  const path = join(folder, "fake-cli");
  const version = join(folder, "version.txt");
  writeFileSync(version, "2.1.309 (Claude Code)\n");
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then cat '${version}'; exit 0; fi\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(path, 0o755);
  return { path, version };
}
const roles = [
  { name: "main" as const, tools: DELEGATE_TOOLS, systemPrompt: "MAIN" },
  { name: "sub" as const, tools: TOOLS, systemPrompt: "SUB" },
];

test("codex: builders port the spike's codexArgs; the credential stays out of argv; the tool timeout is above the approval wait", async () => {
  const spike = await import("../../spikes/ai-cli-isolation/scripts/run.mjs" as string) as {
    codexArgs(cwd: string, server: { command: string; args: string[] }, prompt: string): string[]; codexIsolationConfig(): string[]; CODEX_DISABLED_FEATURES: string[];
  };
  assert.deepEqual(codexIsolationConfig(), spike.codexIsolationConfig());
  assert.deepEqual([...CODEX_DISABLED_FEATURES], spike.CODEX_DISABLED_FEATURES);
  const ours = codexArgs({ cwd: "/run/cwd", bridge: "/b/ssterm-mcp", tools: SUB_TOOLS, systemPrompt: "SYSTEM \"quoted\"\nline", model: "gpt-5.6-luna", effort: "low" });
  const theirs = spike.codexArgs("/run/cwd", { command: "/bin/sh", args: ["/b/ssterm-mcp"] }, "PROMPT");
  // The spike's flags in order up to its MCP server block (4 pairs and the prompt).
  assert.deepEqual(ours.slice(0, theirs.length - 9), theirs.slice(0, theirs.length - 9));
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules"]) assert.ok(ours.includes(flag), flag);
  assert.equal(ours[ours.indexOf("-s") + 1], "read-only");
  for (const pair of theirs.slice(theirs.length - 9, -1).filter((item) => item !== "-c" && !item.includes("enabled_tools"))) assert.ok(ours.includes(pair), pair);
  assert.ok(ours.includes('mcp_servers.ssterm.enabled_tools=["propose_plan","run_command","read_output","cancel"]'));
  assert.ok(ours.includes('mcp_servers.ssterm.env_vars=["SSTERM_MCP_SOCKET","SSTERM_MCP_CREDENTIAL"]'), "the credential reaches the bridge through the environment");
  assert.ok(ours.includes('developer_instructions="SYSTEM \\"quoted\\"\\nline"'), "a TOML basic string");
  assert.equal(ours.at(-1), "-", "the prompt is read from stdin, never argv");
  assert.ok(CODEX_TOOL_TIMEOUT_SEC * 1_000 > APPROVAL_WAIT_MS + DEFAULT_AGENT_TIMEOUT_MS + 60_000, "a call outlives the approval wait and the command timeout");
  assert.ok(ours.includes(`mcp_servers.ssterm.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`));
  assert.throws(() => codexArgs({ cwd: "/c", bridge: "/b", tools: SUB_TOOLS, systemPrompt: "", model: "-p", effort: "low" }), /model/u);
  assert.throws(() => codexArgs({ cwd: "/c", bridge: "/b", tools: SUB_TOOLS, systemPrompt: "", model: "m", effort: "max" }), /model/u, "codex has no max effort");
  assert.throws(() => codexArgs({ cwd: "/c", bridge: "/b", tools: ["shell"], systemPrompt: "", model: "m", effort: "low" }), /tools/u);

  // Its events: anything but messages, reasoning, todo lists and ssterm's own allowed MCP tools is a local tool.
  const item = (type: string, extra: object = {}) => ({ type: "item.started", item: { id: "i", type, ...extra } });
  for (const bad of [item("command_execution", { command: "ls" }), item("file_change"), item("web_search"), item("mcp_tool_call", { server: "decoy", tool: "lookup" }),
    item("mcp_tool_call", { server: "ssterm", tool: "delegate_task" }), { type: "item.completed" }])
    assert.ok(codexViolation(bad, SUB_TOOLS), JSON.stringify(bad));
  for (const good of [item("agent_message", { text: "hi" }), item("reasoning"), item("mcp_tool_call", { server: "ssterm", tool: "run_command" }), { type: "turn.completed" }, { type: "thread.started" }])
    assert.equal(codexViolation(good, SUB_TOOLS), undefined, JSON.stringify(good));
});

test("codex: the version gate keeps 0.163.0 (and every version) disabled, with the ticket 01 reasons shown in Settings", async () => {
  const folder = temp();
  try {
    const codex = join(folder, "codex");
    writeFileSync(codex, "#!/bin/sh\necho 'codex-cli 0.163.0'\n");
    chmodSync(codex, 0o755);
    assert.deepEqual(VERIFIED_CODEX_VERSIONS, []);
    const env = cliBaseEnv({ home: folder, user: "u", tmp: folder });
    const found = await resolveClaude({ candidates: [codex], env, native: false, managed: [], parse: parseCodexVersion, verified: VERIFIED_CODEX_VERSIONS });
    assert.deepEqual(found, { status: "unsupported-version", version: "0.163.0" });
    assert.equal(parseCodexVersion("codex-cli 0.163.0\n"), "0.163.0");
    for (const bad of ["0.163.0", "codex 0.163.0", "codex-cli 0.163.0 extra"]) assert.equal(parseCodexVersion(bad), undefined);
    assert.equal(AGENT_MODELS.codex.models.some((model) => model.verified), false);
    assert.equal(isVerifiedAgentModel("codex", "gpt-5.6-luna"), false);
    let asked = 0;
    const runner = harness(folder, { resolveCodex: async () => { asked += 1; return found; } });
    const view = await runner.settingsView();
    assert.ok(isAgentSettingsView(view));
    const entry = view.providers.find((provider) => provider.id === "codex")!;
    assert.deepEqual([entry.status, entry.version], ["disabled", null]);
    assert.equal(asked, 0, "while no version is verified, codex is not even run for --version");
    for (const reason of CODEX_FAILURES) assert.ok(entry.reasons.includes(reason), reason);
    assert.match(entry.reasons.join(" "), /AGENTS\.md[^]*apply_patch[^]*multi_agent/u);
    assert.deepEqual(await runner.configure({ ...base, provider: "codex", model: "gpt-5.6-luna" }, true), { status: "model-unverified" }, "no codex model is verified either");
    await runner.dispose();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("custom definitions: absolute real binaries only, no shells or interpreters, whitelisted placeholders, no prompt in argv, no secrets in the environment", () => {
  const good = definition("/opt/tools/my-agent");
  assert.equal(customProviderProblem(good), undefined);
  const problems: [Partial<AgentCustomProvider>, RegExp][] = [
    [{ path: "my-agent" }, /absolute path/u], [{ path: "~/bin/agent" }, /absolute path/u], [{ path: "/opt/../bin/agent" }, /absolute path/u],
    [{ path: "/opt//agent" }, /absolute path/u], [{ path: "/opt/agent\n" }, /absolute path/u],
    [{ path: "/bin/sh" }, /shell/u], [{ path: "/bin/zsh" }, /shell/u], [{ path: "/usr/bin/env" }, /shell/u], [{ path: "/opt/homebrew/bin/node" }, /interpreter/u],
    [{ path: "/usr/bin/python3" }, /interpreter/u], [{ path: "/usr/bin/osascript" }, /shell/u],
    [{ args: ["--mcp-config", "{mcpConfigPath}", "{prompt}"] }, /Unknown placeholder \{prompt\}/u],
    [{ args: ["--mcp-config", "{mcpConfigPath}", "--key={credential}"] }, /Unknown placeholder \{credential\}/u],
    [{ args: ["--mcp-config", "{mcpConfigPath}", "{}"] }, /Unknown placeholder/u],
    [{ args: ["--mcp-config", "/tmp/mine.json"] }, /\{mcpConfigPath\}/u],
    [{ args: ["--mcp-config", "{mcpConfigPath}", "a\nb"] }, /one line/u],
    [{ args: ["--mcp-config", "{mcpConfigPath}", "\u0007"] }, /one line/u],
    [{ args: ["{mcpConfigPath}", ...Array.from({ length: 64 }, () => "x")] }, /At most 64/u],
    [{ input: "shell" as never }, /prompts/u],
    [{ model: "-p" }, /model/u], [{ model: "a b" }, /model/u], [{ effort: "ultra" as never }, /effort/u],
    [{ env: [{ name: "PATH", value: "/tmp" }] }, /set by ssterm/u], [{ env: [{ name: "SSTERM_MCP_CREDENTIAL", value: "x" }] }, /set by ssterm/u],
    [{ env: [{ name: "DYLD_INSERT_LIBRARIES", value: "/x.dylib" }] }, /could load code/u], [{ env: [{ name: "NODE_OPTIONS", value: "--require x" }] }, /could load code/u],
    [{ env: [{ name: "OPENAI_API_KEY", value: "sk" }] }, /secret/u], [{ env: [{ name: "GITHUB_TOKEN", value: "t" }] }, /secret/u],
    [{ env: [{ name: "lower", value: "x" }] }, /NAME=value/u], [{ env: [{ name: "A", value: "x\ny" }] }, /NAME=value/u],
    [{ env: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }, /twice/u],
    [{ endpointEnv: "anthropic_base_url" }, /endpoint/u], [{ endpointEnv: "CLAUDE_CODE_DISABLE_FILE_MENTIONS" }, /endpoint/u],
    [{ label: "" }, /Name/u],
  ];
  for (const [changes, pattern] of problems) assert.match(customProviderProblem({ ...good, ...changes }) ?? "", pattern, JSON.stringify(changes));
  assert.match(customProviderProblem({ ...good, extra: 1 }) ?? "", /malformed/u);

  // Substitution: ssterm's own values, each token stays one argv element, literal braces stay.
  const args = customArgs({ ...good, args: ["--mcp-config={mcpConfigPath}", "{model}", "--allowed", "{allowedTools}", "--effort", "{effort}", "{systemPromptFile}", "{\"a\":1}", ""] },
    { mcpConfigPath: "/r/mcp.json", systemPromptFile: "/r/system prompt.txt", tools: SUB_TOOLS });
  assert.deepEqual(args, ["--mcp-config=/r/mcp.json", "fake-model-1", "--allowed", SUB_TOOLS.join(","), "--effort", "high", "/r/system prompt.txt", "{\"a\":1}", ""]);
  assert.throws(() => customArgs(good, { mcpConfigPath: "/r/mcp.json", systemPromptFile: "/r/s", tools: ["Bash"] }), /tools/u);
  assert.throws(() => customArgs(good, { mcpConfigPath: "relative.json", systemPromptFile: "/r/s", tools: SUB_TOOLS }), /path/u);
  assert.throws(() => customArgs({ ...good, path: "/bin/sh" }, { mcpConfigPath: "/r/m", systemPromptFile: "/r/s", tools: SUB_TOOLS }), /definition/u);
});

test("isolation check: the fake CLI passes; an extra local tool fails with its evidence; no endpoint means no run without consent; residue is removed", async () => {
  const folder = temp();
  const home = join(folder, "home");
  const tmp = join(folder, "tmp");
  for (const dir of [home, tmp]) mkdirp(dir);
  try {
    const { path } = wrapper(folder);
    const check = (changes: Partial<AgentCustomProvider>, live = false) => checkCustomProvider({
      definition: definition(path, changes), path, bridge: BRIDGE, tmp, home, profile: "/profile/check", live, roles, timeoutMs: 30_000,
      env: (runTmp) => cliBaseEnv({ home, user: "u", tmp: runTmp }),
    });
    const launches = () => existsSync(join(home, "fake-claude.log")) ? readFileSync(join(home, "fake-claude.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];

    assert.deepEqual(await check({}), { status: "passed", reasons: [] });
    const [main, sub] = launches();
    assert.deepEqual([main.role, sub.role], ["main", "sub"]);
    assert.deepEqual(main.tools, DELEGATE_TOOLS.map((tool) => `mcp__ssterm__${tool.name}`), "the stub served the role's tools through the bridge");
    assert.deepEqual(sub.tools, SUB_TOOLS);
    assert.deepEqual([main.model, main.effort], ["fake-model-1", "high"]);

    const one = await check({ input: "one-shot", args: CLAUDE_TEMPLATE.filter((_, at) => at !== 5 && at !== 6) });
    assert.deepEqual(one, { status: "passed", reasons: [] }, "one-shot prompts (plain text on stdin) are checked the same way");

    const bad = await check({ args: [...CLAUDE_TEMPLATE, "--fake-extra-tool"] });
    assert.equal(bad.status, "failed");
    const reasons = bad.reasons.join("\n");
    for (const expected of [/Main agent: it offered tools outside ssterm's allowlist: Bash, Read, Write\./u, /Sub agent: it offered tools outside/u,
      /its provider request offered Bash, Read, Write/u, /a local file was read/u, /a local shell command ran/u, /pwned-write/u, /pwned-shell/u])
      assert.match(reasons, expected);

    const before = launches().length;
    const offline = await check({ endpointEnv: null });
    assert.equal(offline.status, "unverifiable");
    assert.match(offline.reasons[0]!, /needs a live call/u);
    assert.equal(launches().length, before, "nothing was launched without the consent");
    // With the per-run consent the live path runs (the fake contacts no provider; it completes without using a local tool),
    // and passes only as the weaker live-only status. Claude Code never gets a live-only check.
    const liveOnly = await check({ endpointEnv: null }, true);
    assert.equal(liveOnly.status, "passed-live-unverified-requests");
    assert.match(liveOnly.reasons[0]!, /could not see what the CLI sent/u);
    assert.equal(launches().length, before + 2);

    // A binary that never speaks the protocol.
    const mute = join(folder, "mute");
    writeFileSync(mute, "#!/bin/sh\nexit 0\n");
    chmodSync(mute, 0o755);
    const silent = await checkCustomProvider({ definition: definition(mute), path: mute, bridge: BRIDGE, tmp, home, profile: "/p", live: false, roles, timeoutMs: 10_000,
      env: (runTmp) => cliBaseEnv({ home, user: "u", tmp: runTmp }) });
    assert.equal(silent.status, "failed");
    assert.match(silent.reasons.join("\n"), /did not load ssterm's MCP server[^]*no init event/u);

    assert.deepEqual(readdirSync(tmp), [], "every check folder is removed");
    assert.deepEqual(readdirSync(join(home, "Library", "Caches", "claude-cli-nodejs")), [], "the fake's cache residue is removed");
    assert.deepEqual(readdirSync(join(home, ".claude", "sessions")), [], "and its session files");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------------------------
// The runner: the check before first use, re-check on version or hash change, and a one-shot custom provider.

const owner = { windowId: 1, generation: 1 };
const ownerId = sessionOwnerId(owner);
const base: AgentSettings = { enabled: false, provider: "claude", model: "claude-haiku-5-5", effort: "xhigh", instructions: "", allowFullAllowOnProd: false, custom: null };
const mkdirp = (path: string) => mkdirSync(path, { recursive: true });
function harness(folder: string, extra: Partial<Parameters<typeof createAgentRunner>[0]> = {}) {
  let stored: Uint8Array | undefined;
  const store: AgentSettingsStore = {
    read: async () => stored ? { status: "present", value: stored } : { status: "missing" },
    write: async (value) => { stored = value; return "confirmed"; },
  };
  const snapshot: Partial<SessionSnapshot> = { id: "s1", kind: "terminal", generation: 1, state: "Ready", hostId: "h1",
    target: { label: "db", address: "db.example", port: 22, username: "ops", environment: "DEV", hostRevision: 1, catalogRevision: 1 } };
  const issued: { credential: string; role?: AgentToolRole }[] = [];
  const home = join(folder, "home");
  const tmp = join(folder, "tmp");
  for (const dir of [home, tmp]) mkdirp(dir);
  const runner = createAgentRunner({
    terminals: {
      issue: async (_owner, _session, use = {}) => { const entry = { credential: `cred-${issued.length + 1}`, ...use }; issued.push(entry); return { credential: entry.credential, socketPath: "/tmp/s.sock" }; },
      revoke: () => {},
    },
    registry: () => ({ snapshot: (id: string, session?: string) => id === ownerId && session === "s1" ? [snapshot as SessionSnapshot] : [] }),
    store, bridge: BRIDGE, tmp, home, profile: "/profile/one", checkTimeoutMs: 30_000,
    resolve: async () => ({ status: "missing", version: null }),
    env: (runTmp) => cliBaseEnv({ home, user: "u", tmp: runTmp }),
    ...extra,
  });
  return Object.assign(runner, { stored: () => stored && JSON.parse(new TextDecoder().decode(stored)), issued, home });
}

test("custom provider: checked before first use, stays disabled when it fails, and is re-checked when its version output or binary hash changes", async () => {
  const folder = temp();
  try {
    const { path, version } = wrapper(folder);
    const runner = harness(folder);
    const custom = definition(path);
    const status = async () => (await runner.settingsView()).providers.find((provider) => provider.id === "custom")!;
    assert.equal((await status()).status, "not-configured");
    assert.equal((await runner.configure({ ...base, custom }, false)).status, "saved", "saving a definition while off needs no check");
    assert.deepEqual(await status(), { id: "custom", status: "check-required", version: "2.1.309 (Claude Code)", reasons: ["It has not passed an isolation check yet."] });
    assert.deepEqual(await runner.open(owner, "s1", 1), { status: "refused", reason: "disabled" });

    // Turning it on runs the check first (no live call).
    const on = await runner.configure({ ...base, enabled: true, provider: "custom", custom }, true);
    assert.equal(on.status, "saved");
    assert.equal((await status()).status, "ready");
    const record = runner.stored().customCheck;
    assert.equal(record.status, "passed");
    assert.equal(runner.stored().version, 3);
    assert.deepEqual(runner.stored().custom, custom, "the definition is stored with the settings (no secrets)");

    // The version output changes: the provider is disabled until it is checked again; opening runs that check.
    writeFileSync(version, "2.1.310 (Claude Code)\n");
    assert.deepEqual(await status(), { id: "custom", status: "check-required", version: "2.1.310 (Claude Code)", reasons: ["Its definition, binary or version output changed since its last isolation check."] });
    assert.deepEqual(await runner.open(owner, "s1", 1), { status: "opened" });
    assert.notEqual(runner.stored().customCheck.fingerprint, record.fingerprint);
    assert.equal((await status()).status, "ready");
    await runner.close(owner, "s1");

    // The binary's bytes change (same version output): the same.
    appendFileSync(path, "# updated\n");
    assert.equal((await status()).status, "check-required");
    const checked = await runner.checkProvider(false);
    assert.equal(checked.providers.find((provider) => provider.id === "custom")!.status, "ready");

    // A definition that offers a local tool fails its check and cannot be turned on; the panel cannot open it.
    const unsafe = definition(path, { args: [...CLAUDE_TEMPLATE, "--fake-extra-tool"] });
    const refused = await runner.configure({ ...base, enabled: true, provider: "custom", custom: unsafe }, true);
    assert.equal(refused.status, "provider-unavailable");
    assert.deepEqual(runner.stored().custom, custom, "nothing was saved");
    await runner.configure({ ...base, enabled: false, provider: "custom", custom: unsafe }, false);
    const failed = await runner.checkProvider(false);
    const entry = failed.providers.find((provider) => provider.id === "custom")!;
    assert.equal(entry.status, "check-failed");
    assert.match(entry.reasons.join(" "), /outside ssterm's allowlist: Bash/u);
    assert.ok(isAgentSettingsView(failed));
    await runner.dispose();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("custom provider, one-shot: one process per message with the template's arguments and environment, the prompt and history on stdin, tasks outlive a turn", async () => {
  const folder = temp();
  try {
    interface Fake extends CliProcess { args: string[]; env: Record<string, string>; stdin: (object | string)[]; ended: boolean; emit(event: object): void; exit(): void }
    const clis: Fake[] = [];
    const custom = definition("/opt/tools/one-shot", { input: "one-shot", args: ["--mcp", "{mcpConfigPath}", "--tools={allowedTools}", "-m", "{model}"], env: [{ name: "AGENT_MODE", value: "quiet" }] });
    const runner = harness(folder, {
      resolveCustom: async () => ({ status: "found", path: "/opt/tools/one-shot", version: "1.0", fingerprint: "a".repeat(64), claude: false }),
      check: async () => ({ status: "passed", reasons: [] }),
      spawn: (spec) => {
        let done!: () => void;
        const exited = new Promise<void>((resolve) => { done = resolve; });
        const cli: Fake = {
          pid: 91_000 + clis.length, exited, args: spec.args, env: spec.env, stdin: [], ended: false,
          write(message) { cli.stdin.push(message); return true; }, endInput() { cli.ended = true; },
          stop: async () => { done(); await exited; }, kill: () => done(),
          emit: (event) => spec.onEvent(event as Record<string, unknown>), exit: () => done(),
        };
        clis.push(cli);
        return cli;
      },
    });
    assert.equal((await runner.configure({ ...base, enabled: true, provider: "custom", custom }, true)).status, "saved");
    assert.deepEqual(await runner.open(owner, "s1", 1), { status: "opened" });
    const conversation = async () => (await runner.state(owner)).conversations[0]!;
    assert.deepEqual([(await conversation()).provider, (await conversation()).model, (await conversation()).effort], ["custom", "fake-model-1", "high"]);
    await runner.send(owner, "s1", "check disk");
    const first = clis[0]!;
    assert.equal(first.args[0], "--mcp");
    assert.match(first.args[1]!, /ssterm-agent-[0-9a-f]{16}\/mcp\.json$/u);
    assert.deepEqual(first.args.slice(2), ["--tools=mcp__ssterm__delegate_task,mcp__ssterm__get_task_status,mcp__ssterm__cancel_task", "-m", "fake-model-1"]);
    assert.equal(first.env.AGENT_MODE, "quiet");
    assert.equal(first.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
    assert.equal(first.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS, undefined, "only the definition's own additions, not claude's");
    assert.deepEqual(Object.keys(first.env).sort(), ["AGENT_MODE", "HOME", "LANG", "LOGNAME", "PATH", "TERM", "TMPDIR", "USER"]);
    assert.deepEqual(first.stdin, ["check disk"], "plain text on stdin, never argv");
    assert.equal(first.ended, true);
    assert.ok(!first.args.join(" ").includes("check disk"));
    // A task started in this turn keeps running after the turn's process exits.
    await runner.issued[0]!.role!.call("delegate_task", { goal: "uptime" });
    first.emit({ type: "system", subtype: "init", tools: DELEGATE_TOOLS.map((tool) => `mcp__ssterm__${tool.name}`), mcp_servers: [{ name: "ssterm" }], plugins: [], skills: [], slash_commands: [], agents: [] });
    first.emit({ type: "assistant", message: { content: [{ type: "text", text: "Disk is fine." }] } });
    first.emit({ type: "result", subtype: "success", is_error: false, result: "done" });
    assert.equal((await conversation()).status, "thinking", "a one-shot turn ends when its process exits");
    first.exit();
    for (let i = 0; i < 50 && (await conversation()).status !== "idle"; i++) await new Promise((done) => setTimeout(done, 5));
    const after = await conversation();
    assert.equal(after.status, "idle");
    assert.equal(after.tasks[0]!.status, "running", "tasks outlive a one-shot turn");
    assert.ok(!after.messages.some((message) => message.role === "notice"));
    await runner.send(owner, "s1", "and memory?");
    const second = clis.filter((cli) => cli.args[2]!.includes("delegate_task")).at(-1)!;
    assert.notEqual(second, first);
    assert.deepEqual(second.stdin, ["The conversation so far (kept by ssterm):\n\nUser: check disk\n\nAgent: Disk is fine.\n\nThe user's new message:\nand memory?"]);
    await runner.dispose();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("review fixes: Claude Code as a custom provider keeps claude's controls; state residue is found and removed; reasons are sanitized; symlinked interpreters, ignored or foreign endpoints and timeouts never pass", async () => {
  const folder = temp();
  const home = join(folder, "home");
  const tmp = join(folder, "tmp");
  for (const dir of [home, tmp]) mkdirp(dir);
  try {
    const { path } = wrapper(folder);
    const env = cliBaseEnv({ home, user: "u", tmp });
    // M1: the version output says Claude Code: managed policy refuses it, the spike's flags are required, claude's variables win.
    const managed = join(folder, "managed-settings.json");
    writeFileSync(managed, "{}");
    assert.equal((await resolveCustom(definition(path), env, { candidates: [], managed: [managed] })).status, "managed-policy");
    const weak = await resolveCustom(definition(path, { args: CLAUDE_TEMPLATE.filter((token) => token !== "--restricted") }), env);
    assert.deepEqual(weak.status === "invalid" && weak.reason, "This is Claude Code, so it needs ssterm's verified isolation flags: --restricted.");
    const bypass = await resolveCustom(definition(path, { args: [...CLAUDE_TEMPLATE, "--dangerously-skip-permissions"] }), env);
    assert.match(bypass.status === "invalid" ? bypass.reason : "", /not --dangerously-skip-permissions/u);
    const found = await resolveCustom(definition(path), env);
    assert.ok(found.status === "found" && found.claude);
    mkdirp(join(folder, "renamed"));
    const other = wrapper(join(folder, "renamed"));
    writeFileSync(other.version, "my-agent 1.0\n");
    const byPath = await resolveCustom(definition(other.path), env, { candidates: [other.path], managed: [] });
    assert.ok(byPath.status === "found" && byPath.claude, "a claude install path counts as Claude Code whatever it prints");
    const overridden = definition(path, { env: [{ name: "MCP_TOOL_TIMEOUT", value: "1" }, { name: "CLAUDE_CODE_DISABLE_FILE_MENTIONS", value: "0" }] });
    assert.deepEqual([customEnv(overridden, env, true).MCP_TOOL_TIMEOUT, customEnv(overridden, env, true).CLAUDE_CODE_DISABLE_FILE_MENTIONS], ["1800000", "1"]);
    const claudeLive = await checkCustomProvider({ definition: definition(path, { endpointEnv: null }), path, bridge: BRIDGE, tmp, home, profile: "/p", live: true, claude: true, roles,
      env: (runTmp) => cliBaseEnv({ home, user: "u", tmp: runTmp }) });
    assert.equal(claudeLive.status, "unverifiable");
    assert.match(claudeLive.reasons[0]!, /live-only check is not accepted/u);

    // L9: a symlink to an interpreter is refused by its real path.
    symlinkSync("/bin/sh", join(folder, "agent-link"));
    const linked = await resolveCustom(definition(join(folder, "agent-link")), env);
    assert.deepEqual(linked.status === "invalid" && linked.reason, "The binary resolves to a shell, env or a script interpreter.");

    const check = (changes: Partial<AgentCustomProvider>, timeoutMs = 30_000, binary = path) => checkCustomProvider({
      definition: definition(binary, changes), path: binary, bridge: BRIDGE, tmp, home, profile: "/p", live: false, roles, timeoutMs,
      env: (runTmp) => cliBaseEnv({ home, user: "u", tmp: runTmp }) });
    const ignored = await check({ endpointEnv: "OTHER_BASE_URL" });
    assert.equal(ignored.status, "unverifiable");
    assert.match(ignored.reasons.join(" "), /no request reached ssterm's local test endpoint through OTHER_BASE_URL/u);
    const foreign = await check({ args: [...CLAUDE_TEMPLATE, "--fake-openai"] });
    assert.equal(foreign.status, "unverifiable");
    assert.match(foreign.reasons.join(" "), /not Anthropic Messages requests/u);
    const hang = join(folder, "hang");
    writeFileSync(hang, "#!/bin/sh\nexec /bin/sleep 30\n");
    chmodSync(hang, 0o755);
    const slow = await check({}, 1_000, hang);
    assert.notEqual(slow.status, "passed");
    assert.match(slow.reasons.join(" "), /did not finish within 1 seconds/u);

    // M1: a CLI that saves a transcript fails, and the transcript is removed.
    const saved = await check({ args: [...CLAUDE_TEMPLATE, "--fake-transcript"] });
    assert.equal(saved.status, "failed");
    assert.match(saved.reasons.join(" "), /it saved conversation state \(~\/\.claude\/projects\//u);
    assert.deepEqual(readdirSync(join(home, ".claude", "projects")), []);

    // The scan: the run's own folder and file go; a shared history keeps the user's lines and loses the run's.
    const tag = "ssterm-agent-0123456789abcdef";
    const history = join(home, ".claude", "history.jsonl");
    writeFileSync(history, '{"display":"mine"}\n');
    utimesSync(history, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const since = Date.now();
    appendFileSync(history, `{"project":"/tmp/${tag}/cwd"}\n`);
    mkdirp(join(home, ".gemini", "tmp", `x-${tag}`));
    const hits = await cleanStateResidue({ home, tags: [tag], since });
    assert.equal(hits.length, 2);
    assert.equal(readFileSync(history, "utf8"), '{"display":"mine"}\n');
    assert.deepEqual(readdirSync(join(home, ".gemini", "tmp")), []);
    assert.deepEqual(await cleanStateResidue({ home, tags: [tag], since }), [], "nothing left");

    // L1: reasons are single lines, at most 200 characters and 8 entries.
    const clean = sanitizeReasons([..."abcdefghij"].map((letter) => `${letter}\u0007\n${"x".repeat(300)}`));
    assert.equal(clean.length, 8);
    assert.ok(clean.every((reason) => reason.length <= 200 && !/[\u0000-\u001f]/u.test(reason)));
    const runner = harness(folder, { resolveCustom: async () => ({ status: "found", path, version: "v", fingerprint: "b".repeat(64), claude: false }),
      check: async () => ({ status: "failed", reasons: Array.from({ length: 20 }, (_, at) => `bad\u001b[31m ${at} ${"y".repeat(400)}`) }) });
    await runner.configure({ ...base, custom: definition("/opt/tools/x") }, false);
    const view = await runner.checkProvider(false);
    const reasons = view.providers.find((provider) => provider.id === "custom")!.reasons;
    assert.equal(reasons.length, 8);
    assert.ok(reasons.every((reason) => reason.length <= 200 && !reason.includes("\u001b")));
    assert.ok(isAgentSettingsView(view));
    await runner.dispose();

    // L4: stale check socket folders are swept; fresh ones and others are kept.
    const sockets = join(folder, "sockets");
    mkdirp(join(sockets, "ssterm-check-AbC123"));
    mkdirp(join(sockets, "ssterm-check-ZzZ999"));
    mkdirp(join(sockets, "other"));
    utimesSync(join(sockets, "ssterm-check-AbC123"), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    assert.equal(await sweepCheckSockets(sockets), 1);
    assert.deepEqual(readdirSync(sockets).sort(), ["other", "ssterm-check-ZzZ999"]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("L2: a custom provider's card expires before its client stops waiting, saying so; lock stops an in-flight check", async () => {
  const folder = temp();
  try {
    const clis: { args: string[]; done(): void }[] = [];
    let checkSignal: AbortSignal | undefined;
    let pendingCheck = false;
    const runner = harness(folder, {
      resolveCustom: async () => ({ status: "found", path: "/opt/tools/x", version: "1", fingerprint: (pendingCheck ? "d" : "c").repeat(64), claude: false }),
      check: async (options) => {
        if (!pendingCheck) return { status: "passed", reasons: [] };
        checkSignal = options.signal;
        await new Promise<void>((done) => options.signal!.addEventListener("abort", () => done()));
        return { status: "unverifiable", reasons: ["stopped"] };
      },
      spawn: (spec) => {
        let done!: () => void;
        const exited = new Promise<void>((resolve) => { done = resolve; });
        clis.push({ args: spec.args, done });
        return { pid: 92_000 + clis.length, exited, write: () => true, endInput() {}, stop: async () => { done(); await exited; }, kill: () => done() };
      },
    });
    const custom = definition("/opt/tools/x", { toolTimeoutSec: 10, args: ["--mcp", "{mcpConfigPath}", "{allowedTools}"] });
    assert.equal((await runner.configure({ ...base, enabled: true, provider: "custom", custom }, true)).status, "saved");
    assert.deepEqual(await runner.open(owner, "s1", 1), { status: "opened" });
    await runner.send(owner, "s1", "go");
    await runner.issued[0]!.role!.call("delegate_task", { goal: "touch /tmp/x" });
    for (let i = 0; i < 100 && !runner.issued.some((entry) => (entry as { gate?: unknown }).gate); i++) await new Promise((done) => setTimeout(done, 10));
    const gate = (runner.issued.find((entry) => (entry as { gate?: unknown }).gate) as unknown as { gate: { authorize(command: string, verdict: object, signal: AbortSignal): Promise<{ refuse?: string }> } }).gate;
    const started = Date.now();
    const decision = await gate.authorize("touch /tmp/x", { readOnly: false, reason: "writes" }, new AbortController().signal);
    const waited = Date.now() - started;
    assert.ok(waited >= 4_500 && waited < 7_000, `expired 5 s before the 10 s client timeout (${waited} ms)`);
    assert.match(decision.refuse ?? "", /stops waiting for a tool call after 10 seconds, so the card expired just before that \(the agent stopped waiting\)/u);

    // A check in flight when the workspace locks: its CLI is stopped and it ends unverified.
    pendingCheck = true;
    const running = runner.checkProvider(false);
    for (let i = 0; i < 100 && !checkSignal; i++) await new Promise((done) => setTimeout(done, 5));
    await runner.lock();
    assert.equal(checkSignal?.aborted, true);
    const view = await running;
    assert.equal(view.providers.find((provider) => provider.id === "custom")!.status, "unverifiable");
    assert.deepEqual((await runner.state(owner)).conversations, [], "a failed re-check (and the lock) ends custom conversations");
    await runner.dispose();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
