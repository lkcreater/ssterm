// SST-041 ticket 03 E2E: a deterministic stand-in for the claude CLI. It contacts no provider. It checks the flags and
// environment ssterm launches it with, leaves the metadata residue the real CLI leaves (so ssterm's cleanup is
// observable), starts the MCP server from --mcp-config exactly as claude would (the ssterm-mcp bridge), and calls the
// ssterm tools from scripted chat messages:
//   main agent:  "delegate:<goal>||<goal>"  delegate each goal, wait for each record, summarize from it
//                "start:<goal>"              delegate without waiting
//                anything else              echoed
//   sub agent:   goal "run:<command>;;<command>" runs each command with run_command
// Every launch appends one JSON line to $HOME/fake-claude.log.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("2.1.309 (Claude Code)\n");
  process.exit(0);
}
const home = process.env.HOME;
const log = (entry) => appendFileSync(join(home, "fake-claude.log"), `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const value = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };

// The production flags (spike ticket 01) and the allowlisted environment.
const problems = [];
for (const flag of ["-p", "--verbose", "--include-hook-events", "--no-session-persistence", "--restricted", "--strict-mcp-config", "--disable-slash-commands"])
  if (!argv.includes(flag)) problems.push(`missing ${flag}`);
for (const [flag, expected] of [["--output-format", "stream-json"], ["--input-format", "stream-json"], ["--tools", ""], ["--setting-sources", ""],
  ["--permission-mode", "dontAsk"], ["--permission-prompts", "none"]])
  if (value(flag) !== expected) problems.push(`${flag} is ${JSON.stringify(value(flag))}`);
const required = { CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1", CLAUDE_CODE_DISABLE_ATTACHMENTS: "1", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", TERM: "dumb", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
for (const [name, expected] of Object.entries(required)) if (process.env[name] !== expected) problems.push(`env ${name}`);
const allowedEnv = new Set(["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "TERM", "CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_SKIP_PROMPT_HISTORY", "CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING", "ENABLE_CLAUDEAI_MCP_SERVERS",
  "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_DISABLE_FILE_MENTIONS", "CLAUDE_CODE_DISABLE_ATTACHMENTS",
  // Set by the OS or Node for any process, never by ssterm.
  "__CF_USER_TEXT_ENCODING", "PWD", "SHLVL", "_", "OLDPWD"]);
const extraEnv = Object.keys(process.env).filter((name) => !allowedEnv.has(name));
if (extraEnv.length) problems.push(`extra env ${extraEnv.join(",")}`);
const cwd = process.cwd();
const cwdEntries = (await import("node:fs")).readdirSync(cwd);
if (cwdEntries.length) problems.push("cwd not empty");
const allowed = (value("--allowedTools") ?? "").split(",");
const role = allowed.includes("mcp__ssterm__delegate_task") ? "main" : "sub";
const prompt = value("--system-prompt") ?? "";

// Residue the real CLI leaves; ssterm must remove it after the run.
const cache = join(home, "Library", "Caches", "claude-cli-nodejs", cwd.replace(/[^A-Za-z0-9]/gu, "-"), "mcp-logs-ssterm");
mkdirSync(cache, { recursive: true });
writeFileSync(join(cache, "run.jsonl"), `${JSON.stringify({ cwd, event: "connected" })}\n`);
mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, cwd }));
writeFileSync(join(home, ".claude", "sessions", `${process.pid}.fake.key`), "k");

// The MCP server exactly as configured: one stdio server named ssterm.
const config = JSON.parse(readFileSync(value("--mcp-config"), "utf8"));
const servers = Object.keys(config.mcpServers ?? {});
const server = config.mcpServers.ssterm;
const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"] });
const waiting = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  waiting.get(message.id)?.(message);
  waiting.delete(message.id);
});
const request = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const call = async (name, args) => (await request("tools/call", { name, arguments: args })).result;
const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "2.1.309" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
const tools = (await request("tools/list", {})).result.tools.map((tool) => `mcp__ssterm__${tool.name}`);
log({ role, cwd, problems, allowed, tools, servers, server: init.result?.serverInfo?.name, instructions: prompt.includes("ssterm instructions sst-041"),
  model: value("--model"), effort: value("--effort"), bridge: server.args[0],
  extra: prompt.includes("Additional instructions from the user") ? prompt.slice(prompt.indexOf("Additional instructions")) : null });
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
// What the verified claude 2.1.309 reports: built-in plugins and agent definitions, no skills or slash commands.
emit({ type: "system", subtype: "init", tools, mcp_servers: servers.map((name) => ({ name, status: "connected" })),
  plugins: [{ name: "cc-plugin-agents-md", path: "builtin" }], skills: [], slash_commands: [], agents: ["claude", "Explore", "general-purpose", "Plan", "statusline-setup"] });
const say = (text) => emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
if (problems.length) { say(`FAKE PROBLEMS: ${problems.join("; ")}`); emit({ type: "result", subtype: "error", is_error: true }); }

async function main(text) {
  if (text.startsWith("delegate:")) {
    const ids = [];
    for (const goal of text.slice(9).split("||")) ids.push((await call("delegate_task", { goal })).structuredContent.taskId);
    say(`Delegated ${ids.join(", ")}.`);
    for (const taskId of ids) {
      const record = (await call("get_task_status", { taskId, wait: true })).structuredContent;
      const lines = record.commands.map((step) => `${step.command} -> ${step.status === "completed" ? `exit ${step.exitCode}` : step.status}: ${step.output.split("\n")[0]}`);
      say(`Summary ${taskId} (${record.status}): ${lines.join(" | ") || "no commands"}`);
    }
  } else if (text.startsWith("start:")) {
    say(`Started ${(await call("delegate_task", { goal: text.slice(6) })).structuredContent.taskId}.`);
  } else say(`Echo: ${text}`);
  emit({ type: "result", subtype: "success", is_error: false, result: "done" });
}
async function sub(text) {
  const goal = text.replace(/^Task task-\d+: /u, "");
  const commands = goal.startsWith("run:") ? goal.slice(4).split(";;") : [];
  for (const command of commands) await call("run_command", { command });
  emit({ type: "result", subtype: "success", is_error: false, result: `Ran ${commands.length} command(s).` });
}

let chain = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  const text = typeof message.message?.content === "string" ? message.message.content : "";
  chain = chain.then(() => (role === "main" ? main(text) : sub(text)));
});
input.on("close", () => { void chain.then(() => { child.kill(); process.exit(0); }); });
