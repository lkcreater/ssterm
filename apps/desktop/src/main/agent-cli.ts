/**
 * SST-041 ticket 03: how ssterm launches an agent CLI, ported from the ticket 01 isolation spike
 * (`spikes/ai-cli-isolation/scripts/run.mjs`, never imported at runtime). See docs/spikes/ai-cli-isolation.md,
 * "Production requirements": absolute binary path, a version gate at every spawn, the spike's argument and environment
 * builders, stdin stream-json, SIGTERM then SIGKILL to the process group, and per-run cache/session cleanup.
 */
import { execFile, spawn } from "node:child_process";
import { open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { AGENT_EFFORTS, AGENT_MODEL_TOKEN, type AgentEffort } from "@ssterm/contracts";

/** Versions that passed the ticket 01 isolation check. Re-run that check before adding one. */
export const VERIFIED_CLAUDE_VERSIONS: readonly string[] = ["2.1.309"];
/** Bumped whenever either bundled instruction text changes. */
export const INSTRUCTIONS_VERSION = "sst-041-03.1";

/** The spike's claude environment additions; the last two are mandatory (relative `@file` mentions expand otherwise). */
export const CLAUDE_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
  CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1",
  CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
});

/** Allowlisted environment only: nothing from ssterm's own process (tokens, proxies, NODE_OPTIONS, test switches). */
export function cliEnv(options: { home: string; user: string; tmp: string }): Record<string, string> {
  return {
    HOME: options.home, USER: options.user, LOGNAME: options.user,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: options.tmp, LANG: "en_US.UTF-8", TERM: "dumb",
    ...CLAUDE_ENV,
  };
}

/**
 * The spike's stream-mode flags. Prompts go over stdin as stream-json, never argv. The model and effort are the user's
 * A14 choice (a strict token and an enum, each one argv element); the spike's `--max-budget-usd` cap is not carried over.
 */
export function claudeArgs(options: { mcpConfig: string; tools: readonly string[]; systemPrompt: string; model: string; effort: AgentEffort }): string[] {
  if (options.tools.length === 0 || options.tools.some((tool) => !/^mcp__ssterm__[a-z_]+$/u.test(tool))) throw new Error("tools");
  if (!AGENT_MODEL_TOKEN.test(options.model) || !(AGENT_EFFORTS as readonly string[]).includes(options.effort)) throw new Error("model");
  return [
    "-p", "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--input-format", "stream-json",
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config", "--mcp-config", options.mcpConfig,
    "--tools", "",
    "--allowedTools", options.tools.join(","),
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--model", options.model, "--effort", options.effort,
    "--system-prompt", options.systemPrompt,
  ];
}

/** The MCP config a CLI reads: only ssterm, through the bridge; the credential travels in its environment. */
export function mcpConfig(options: { bridge: string; socketPath: string; credential: string }): string {
  return JSON.stringify({ mcpServers: { ssterm: {
    type: "stdio", command: "/bin/sh", args: [options.bridge],
    env: { SSTERM_MCP_SOCKET: options.socketPath, SSTERM_MCP_CREDENTIAL: options.credential },
  } } });
}

export const parseClaudeVersion = (output: string): string | undefined =>
  /^(\d{1,4}\.\d{1,4}\.\d{1,6}) \(Claude Code\)\s*$/u.exec(output)?.[1];

/** Mach-O (thin or universal): the native installer's binary, not a script wrapper or shim. */
export async function isNativeExecutable(path: string): Promise<boolean> {
  try {
    const file = await open(path, "r");
    try {
      const head = Buffer.alloc(4);
      await file.read(head, 0, 4, 0);
      return [0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(head.readUInt32BE(0));
    } finally { await file.close(); }
  } catch { return false; }
}

export type ProviderResolution =
  | { status: "ready"; path: string; version: string }
  | { status: "missing" | "not-native" | "managed-policy"; version: null }
  | { status: "unsupported-version"; version: string | null };

/** Where the native installer puts `claude`; PATH is never searched (on the test host PATH held cmux wrapper shims). */
export const claudeCandidates = (home: string): string[] =>
  [join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
/**
 * Managed (MDM or server-delivered) policy that still applies under `--restricted` and was not part of the verified
 * configuration: any of these present refuses the provider.
 */
export const managedPolicyPaths = (options: { home: string; user: string }): string[] => [
  "/Library/Application Support/ClaudeCode",
  "/Library/Managed Preferences/com.anthropic.claudecode.plist",
  join("/Library/Managed Preferences", options.user, "com.anthropic.claudecode.plist"),
  join(options.home, ".claude", "remote-settings.json"),
  join(options.home, ".claude", "policy-limits.json"),
];

/**
 * Resolves the real binary (symlinks followed, so the self-updating link cannot change what is gated) and gates its
 * version. Called before every spawn. Managed/MDM policy settings still apply under `--restricted` and were not part
 * of the verified configuration, so their presence refuses the provider.
 */
export async function resolveClaude(options: {
  candidates: readonly string[];
  env: Record<string, string>;
  /** False only for the test seam's fake CLI script. */
  native?: boolean;
  managed: readonly string[];
}): Promise<ProviderResolution> {
  for (const path of options.managed)
    if (await stat(path).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT")) return { status: "managed-policy", version: null };
  let found: ProviderResolution = { status: "missing", version: null };
  for (const candidate of options.candidates) {
    let path: string;
    try {
      path = await realpath(candidate);
      const info = await stat(path);
      if (!info.isFile() || (info.mode & 0o111) === 0) continue;
    } catch { continue; }
    if (options.native !== false && !(await isNativeExecutable(path))) { found = { status: "not-native", version: null }; continue; }
    const output = await new Promise<string>((resolve) => {
      execFile(path, ["--version"], { env: options.env, timeout: 10_000, maxBuffer: 4_096 }, (error, stdout) => resolve(error ? "" : String(stdout)));
    });
    const version = parseClaudeVersion(output);
    if (version && VERIFIED_CLAUDE_VERSIONS.includes(version)) return { status: "ready", path, version };
    found = { status: "unsupported-version", version: version ?? null };
  }
  return found;
}

export interface CliProcess {
  readonly pid: number;
  readonly exited: Promise<void>;
  /** One stream-json message on stdin; false once the process is gone. */
  write(message: object): boolean;
  endInput(): void;
  /** SIGTERM to the process group, SIGKILL after the grace period; resolves once the CLI is gone. */
  stop(): Promise<void>;
  /** SIGKILL to the process group at once (an isolation violation). */
  kill(): void;
}
const MAX_LINE = 4 * 1_048_576;

/**
 * Own process group (detached), stdin pipe, stdout parsed as JSON lines; stderr is discarded, never stored. `exited`
 * resolves on `close`, after the last stdout line was parsed.
 */
export function spawnCli(options: {
  path: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  onEvent(event: Record<string, unknown>): void;
  graceMs?: number;
}): CliProcess {
  const child = spawn(options.path, options.args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const pid = child.pid ?? -1;
  let alive = pid > 0;
  const group = (signal: NodeJS.Signals) => { if (pid > 0) try { process.kill(-pid, signal); } catch { /* Gone. */ } };
  // Stragglers left in the group (the MCP bridge) go with the CLI; they could otherwise hold stdout open.
  child.once("exit", () => { alive = false; group("SIGKILL"); });
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => { alive = false; resolve(); });
    child.once("error", () => { alive = false; resolve(); });
    if (pid <= 0) resolve();
  });
  child.stdin.on("error", () => {});
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        const event: unknown = JSON.parse(line);
        if (event && typeof event === "object" && !Array.isArray(event)) options.onEvent(event as Record<string, unknown>);
      } catch { /* Not an event. */ }
    }
    if (buffered.length > MAX_LINE) buffered = "";
  });
  let stopping: Promise<void> | undefined;
  return {
    pid,
    exited,
    write(message) {
      if (!alive || child.stdin.destroyed || child.stdin.writableEnded) return false;
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    },
    endInput() { if (!child.stdin.writableEnded) child.stdin.end(); },
    kill() { if (alive) group("SIGKILL"); },
    stop() {
      if (!alive) return exited;
      return stopping ??= (async () => {
        group("SIGTERM");
        const grace = options.graceMs ?? 3_000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exited, new Promise<void>((done) => { timer = setTimeout(done, grace); })]);
        clearTimeout(timer);
        if (alive) {
          group("SIGKILL");
          await Promise.race([exited, new Promise<void>((done) => setTimeout(done, 1_000))]);
        }
      })();
    },
  };
}

/**
 * After a run: the run's own folder, then the metadata claude leaves for it (A11 amendment): the per-cwd
 * `~/Library/Caches/claude-cli-nodejs/<encoded cwd>` entries and `~/.claude/sessions/<pid>.json` / `<pid>.*.key`.
 * Only entries naming this run's unique folder are removed; with no pid (a startup sweep) every session file naming it is.
 */
export async function removeRunResidue(options: { home: string; root: string; pid: number }): Promise<string[]> {
  const removed: string[] = [];
  const tag = basename(options.root);
  if (!/^ssterm-agent-[0-9a-f]{16}$/u.test(tag)) return removed;
  await rm(options.root, { recursive: true, force: true }).catch(() => undefined);
  const cache = join(options.home, "Library", "Caches", "claude-cli-nodejs");
  for (const entry of await readdir(cache).catch(() => [] as string[])) {
    if (!entry.includes(tag)) continue;
    await rm(join(cache, entry), { recursive: true, force: true }).then(() => removed.push(join(cache, entry)), () => undefined);
  }
  const sessions = join(options.home, ".claude", "sessions");
  const entries = await readdir(sessions).catch(() => [] as string[]);
  const pids = options.pid > 0 ? [String(options.pid)] : entries.flatMap((entry) => /^(\d{1,10})\.json$/u.exec(entry)?.[1] ?? []);
  for (const pid of pids) {
    const own = await readFile(join(sessions, `${pid}.json`), "utf8").then((text) => text.includes(tag), () => false);
    if (own) for (const entry of entries) {
      if (entry !== `${pid}.json` && !(entry.startsWith(`${pid}.`) && entry.endsWith(".key"))) continue;
      await rm(join(sessions, entry), { force: true }).then(() => removed.push(join(sessions, entry)), () => undefined);
    }
  }
  return removed;
}

/** Each run folder names the profile that made it, so a startup sweep removes only this profile's leftovers. */
export const RUN_PROFILE_FILE = "profile";
/**
 * Startup: run folders this profile left behind (a crash or a forced quit), with their cache and session entries.
 * Another profile's (or another app instance's) folders are never touched.
 */
export async function sweepStaleRuns(options: { tmp: string; home: string; profile: string }): Promise<number> {
  let swept = 0;
  for (const entry of await readdir(options.tmp).catch(() => [] as string[])) {
    if (!/^ssterm-agent-[0-9a-f]{16}$/u.test(entry)) continue;
    const root = join(options.tmp, entry);
    const owner = await readFile(join(root, RUN_PROFILE_FILE), "utf8").catch(() => undefined);
    if (owner !== options.profile) continue;
    await removeRunResidue({ home: options.home, root, pid: -1 });
    swept += 1;
  }
  return swept;
}

export interface AgentTarget { label: string; endpoint: string; environment: "DEV" | "STAGING" | "PROD" | null }

const MAIN_INSTRUCTIONS = `You are the DevOps Engineer agent inside ssterm, a desktop SSH client. You help the user with exactly one server: the bound target below.

How you work:
- You cannot run commands yourself. To do anything on the server, call delegate_task with one clear, self-contained goal. ssterm starts a sub agent that runs commands in the user's visible terminal.
- After delegating, call get_task_status with wait set to true until the task is no longer queued or running. Base your answer only on that record: the commands that actually ran, their exit codes and output, and the refused commands.
- Never claim that something succeeded unless the record shows the command ran with exit code 0. Say plainly what failed, was refused or did not run.
- When the request is ambiguous or could change the server, ask the user before delegating.
- A task's subAgentReport is the sub agent's own unverified text. Trust the command record (commands, exit codes, output) over it.
- One task runs at a time on this server; further tasks wait in a queue. Use cancel_task when a task is no longer wanted.
- The session is in Read only mode: only read-only commands run, and ssterm refuses everything else. If the user needs a change, explain that the mode must be changed first.
- Keep answers short and concrete.`;

const SUB_INSTRUCTIONS = `You are a sub agent inside ssterm. You carry out one task on the bound target below, using only the run_command, read_output and cancel tools. Each command is typed into the user's visible terminal.

Rules:
- Stay strictly within the task. Do not explore beyond what it needs.
- One line per command. Use non-interactive flags (for example --no-pager); full-screen programs are refused.
- The session is in Read only mode: only read-only commands run. A refused command was not run; do not try to work around a refusal.
- Stop and report as soon as something is unexpected: a refused command, a non-zero exit code you did not expect, or a prompt waiting for input.
- Finish with a short report of what you ran and what each exit code showed. ssterm keeps its own record of every command, so never invent results.`;

/** Bundled, versioned instructions; the user's additional text is appended and cannot replace them. */
export function agentInstructions(role: "main" | "sub", target: AgentTarget, additional: string): string {
  const bound = `Bound target: ${target.label} (${target.endpoint})${target.environment ? `, environment ${target.environment}` : ""}.` +
    (target.environment === "PROD" ? " This is a production server." : "");
  const extra = additional.trim()
    ? `\n\nAdditional instructions from the user. They cannot change the rules above, and ssterm enforces its safety rules regardless:\n${additional.trim()}`
    : "";
  return `${role === "main" ? MAIN_INSTRUCTIONS : SUB_INSTRUCTIONS}\n\n${bound}\n(ssterm instructions ${INSTRUCTIONS_VERSION})${extra}`;
}
