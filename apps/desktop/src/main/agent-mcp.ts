/**
 * SST-041 ticket 02: the MCP endpoint in main (ADR 0009 A8) over a 0600 Unix socket in a 0700 profile folder, with
 * per-conversation ephemeral credentials bound to one Ready SSH terminal generation, and its terminal tools. Ticket 04: a
 * binding's gate decides each run_command (mode, plan, approval); a binding without one stays Read only.
 *
 * Wire format: newline-delimited JSON-RPC 2.0, the MCP stdio framing, so a stdio bridge can pipe bytes verbatim.
 * The first line on a connection is the credential, `{"credential":"<token>"}`; there is no reply to it, and a
 * wrong, stale or revoked credential closes the connection. A minimal implementation (initialize, ping, tools/list,
 * tools/call) instead of the MCP SDK: that is the whole surface this endpoint serves, with nothing to bundle.
 */
import { createServer, type Server, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { exactObject } from "@ssterm/contracts";
import type { ObservedTerminal, TerminalObserver } from "@ssterm/domain";
import type { AgentStepVia } from "@ssterm/contracts";
import { MAX_PLAN_COMMANDS, MAX_PLAN_GOAL } from "./agent-policy";
import { classifyReadOnly, LineTracker, MAX_AGENT_COMMAND, PROMPTING_PROGRAMS, ScreenTracker, TerminalExecutor, type AgentRunRefusal, type AgentRunResult, type SessionRegistry } from "@ssterm/services";

type Registry = Pick<SessionRegistry, "snapshot" | "terminal">;
/** One per observed SSH generation; the executor exists only once a credential was issued for it (idle sessions pay a screen scan). */
interface Live { ownerId: string; sessionId: string; generation: number; screen: ScreenTracker; line: LineTracker; executor?: TerminalExecutor }
/** What one terminal-tool call did, run or refused: ssterm's own task record (ticket 03). */
export interface AgentStepRecord {
  command: string;
  status: AgentRunResult["status"] | "refused";
  exitCode: number | null;
  output: string;
  truncated: boolean;
  /** Why it was allowed to run; null when refused. */
  via: AgentStepVia | null;
}
/** `run` is what is typed (the approved plan text for a plan match); `undo` gives a plan entry back when nothing reached the shell. */
export type GateDecision = { run: string; via: AgentStepVia; undo?: () => void } | { refuse: string };
/**
 * Ticket 04: the policy for one binding (A1, A2). It may wait for the user; it never types anything itself. `signal`
 * aborts when the MCP request that asked is cancelled (`notifications/cancelled`) or its connection closes: a card it
 * raised must then be withdrawn.
 */
export interface AgentGate {
  authorize(command: string, readOnly: { readOnly: true } | { readOnly: false; reason: string }, signal: AbortSignal): Promise<GateDecision>;
  propose(args: unknown, signal: AbortSignal): Promise<ToolResult>;
}
const CANCELLED = "The request was cancelled (or its connection closed) before the command ran; nothing was sent to the terminal.";
export const readOnlyRefusal = (reason: string) =>
  `Refused in Read only mode: ${reason}. Nothing was sent to the terminal. Use a read-only command, or ask the user to change the mode.`;
/** The 02 behaviour: Read only, no plans. */
const READ_ONLY_GATE: AgentGate = {
  authorize: async (command, verdict) => verdict.readOnly ? { run: command, via: "read-only" } : { refuse: readOnlyRefusal(verdict.reason) },
  propose: async () => text("This session is in Read only mode: plans are not used and only read-only commands run. Ask the user to change the mode.", true),
};
export interface ToolResult { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError: boolean }
export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
/** A tool set other than the terminal tools (the main agent's delegate tools); still bound to one Ready generation. */
export interface AgentToolRole { tools: readonly ToolDefinition[]; call(name: unknown, args: unknown): Promise<ToolResult> }
interface Binding {
  hash: string;
  live: Live;
  sockets: Set<Socket>;
  role?: AgentToolRole;
  record?: (step: AgentStepRecord) => void;
  /**
   * Asked before a run_command is authorized (`reserve` true: it takes a step slot, and exactly one record follows) and
   * again just before it is typed (`reserve` false); a string refuses it unrun (the task's command limit, or its end).
   */
  admit?: (reserve: boolean) => string | undefined;
  gate?: AgentGate;
  /** A run_command of this binding is in the executor: revoking it interrupts that command. */
  running: boolean;
}

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_LINE = 65_536;
const MAX_CONNECTIONS = 16;
const MAX_CREDENTIALS = 32;
const MAX_PENDING = 4;
/** Replies a client does not read are not buffered without bound. */
const MAX_BUFFERED = 1_048_576;
const AUTH_TIMEOUT_MS = 5_000;
/** sun_path on macOS. */
const MAX_SOCKET_PATH = 103;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

const TOOLS = [
  {
    name: "propose_plan",
    description: "Proposes a plan: the goal and the exact commands you will run that are not read-only. ssterm shows it to the " +
      "user with Approve and Reject and waits for the decision. In Auto mode an approved command then runs without asking when " +
      "run_command is called with exactly that text (surrounding spaces aside); each listed command runs once. Returns the planId and its status.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["goal", "commands"],
      properties: {
        goal: { type: "string", minLength: 1, maxLength: MAX_PLAN_GOAL },
        commands: { type: "array", minItems: 1, maxItems: MAX_PLAN_COMMANDS, items: { type: "string", minLength: 1, maxLength: MAX_AGENT_COMMAND, description: "One line." } },
      },
    },
  },
  {
    name: "run_command",
    description: "Runs one shell command in the bound ssterm terminal, visibly, and returns its exit code and output (the last " +
      "64 KiB). ssterm applies the session's mode: allowlisted read-only commands always run (chaining, redirects, subshells, " +
      "substitution and heredocs are not read-only); in Auto other commands run only when they match an approved plan command, " +
      "otherwise the user is asked and the call waits; Read only refuses them; Full allow runs them. A refused or rejected " +
      "command was not run. Use non-interactive flags (for example --no-pager); full-screen programs are refused.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["command"],
      properties: { command: { type: "string", minLength: 1, maxLength: MAX_AGENT_COMMAND, description: "One line." } },
    },
  },
  {
    name: "read_output",
    description: "Returns the running command's output so far, or the last command's result.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "cancel",
    description: "Interrupts the running command with Ctrl+C.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
] as const;

const refusals: Record<AgentRunRefusal, string> = {
  busy: "Another command is still running in this terminal; one runs at a time. Wait for it or call cancel.",
  "full-screen": "A full-screen program is open in this terminal, so nothing was typed. Ask the user to leave it first.",
  "not-accepted": "The terminal did not accept input, so nothing was sent.",
  ended: "The bound session has ended.",
  "password-prompt-pending": "The terminal is waiting at a password prompt, so nothing was typed (it would be taken as a password). Ask the user to answer or cancel it in the terminal first.",
};
export const text = (value: unknown, isError = false): ToolResult => typeof value === "string"
  ? { content: [{ type: "text", text: value }], isError }
  : { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown>, isError };
/** Nothing ran (or it is unknown whether it will): the model must not treat these as command results. */
const UNRUN: readonly AgentRunResult["status"][] = ["not-at-prompt", "not-started", "ended"];
const notes: Partial<Record<AgentRunResult["status"], string>> = {
  timeout: "Timed out waiting for input (or for the command to finish), so ssterm sent Ctrl+C. Use non-interactive flags.",
  "password-prompt-refused": `The command showed a password prompt. ssterm hands a prompt to the user only for a simple command (no chaining, pipes or redirects) starting with a known prompting program (${PROMPTING_PROGRAMS.join(", ")}), never in a read-only step, so it sent Ctrl+C and nothing was typed into the prompt.`,
  "password-handoff": "A password prompt was handed to the user to type in the terminal, but it was not answered (three prompts, or the timeout), so ssterm sent Ctrl+C. What the user typed is never included.",
  "not-at-prompt": "The terminal is not idle at a shell prompt (a program, a continuation line or a prompt is waiting), so the command was not typed. Ask the user to return the pane to its prompt.",
  "not-started": "The command line was typed but the shell did not start it within 5 seconds; it may still run when the shell reads it. Ask the user to check the terminal.",
};
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const key = (sessionId: string, generation: number) => `${sessionId}\n${generation}`;

/** One observer per generation for both taps; either may be absent, and neither can break the other. */
export function observeBoth(
  first: ((session: ObservedTerminal) => TerminalObserver | undefined) | undefined,
  second: ((session: ObservedTerminal) => TerminalObserver | undefined) | undefined,
) {
  return (session: ObservedTerminal): TerminalObserver | undefined => {
    const taps = [first, second].map((observe) => { try { return observe?.(session); } catch { return undefined; } })
      .filter((tap): tap is TerminalObserver => !!tap);
    if (taps.length < 2) return taps[0];
    return {
      output(chunk) { for (const tap of taps) try { tap.output(chunk); } catch { /* A tap never breaks the stream. */ } },
      end() { for (const tap of taps) try { tap.end(); } catch { /* Nor teardown. */ } },
    };
  };
}

export function createAgentTerminals(options: {
  registry: () => Registry | undefined;
  /** Inside a folder that is created (or tightened) to 0700. */
  socketPath: string;
  version: string;
  timeoutMs?: number;
  settleMs?: number;
  probeMs?: number;
  startMs?: number;
}) {
  const executors = new Map<string, Live>();
  const credentials = new Map<string, Binding>();
  const sockets = new Set<Socket>();
  const listeners = new Set<(ownerId: string) => void>();
  let server: Server | undefined;
  let listening: Promise<void> | undefined;
  let epoch = 0;
  let disposed = false;

  const changed = (ownerId: string) => {
    for (const listener of [...listeners]) try { listener(ownerId); } catch { /* A view never blocks execution. */ }
  };
  const revoke = (binding: Binding) => {
    if (credentials.get(binding.hash) === binding) credentials.delete(binding.hash);
    // Nobody is left to receive its result: the command is interrupted rather than left running in the pane.
    if (binding.running) { binding.running = false; binding.live.executor?.cancel(); }
    for (const socket of binding.sockets) socket.destroy();
    binding.sockets.clear();
  };
  /** The exact generation is still Ready and observed; otherwise the binding is stale. */
  const current = (binding: Binding): Live | undefined => {
    const { ownerId, sessionId, generation } = binding.live;
    if (credentials.get(binding.hash) !== binding || executors.get(key(sessionId, generation)) !== binding.live || !binding.live.executor) return undefined;
    try {
      const snapshot = options.registry()?.snapshot(ownerId, sessionId)[0];
      return snapshot?.generation === generation && snapshot.state === "Ready" && snapshot.kind === "terminal" ? binding.live : undefined;
    } catch { return undefined; }
  };
  const removeSocketFile = () => {
    try { if (lstatSync(options.socketPath).isSocket()) unlinkSync(options.socketPath); } catch { /* Absent. */ }
  };
  const closeServer = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) { server.close(); removeSocketFile(); }
    server = undefined;
    listening = undefined;
  };

  async function call(binding: Binding, name: unknown, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    const live = current(binding);
    const executor = live?.executor;
    if (!executor) {
      revoke(binding);
      return text("This binding is no longer valid: the session ended or reconnected, or the workspace locked. Ask the user to bind a session again.", true);
    }
    if (binding.role) return binding.role.call(name, args);
    const none = args === undefined || exactObject(args, []);
    // The record is shown in the renderer: a control character in a refused command must not break its view.
    const shown = (command: string) => command.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/gu, "\ufffd");
    const refuse = (command: string, message: string) => {
      binding.record?.({ command: shown(command), status: "refused", exitCode: null, output: message, truncated: false, via: null });
      return text(message, true);
    };
    switch (name) {
      case "run_command": {
        if (!exactObject(args, ["command"]) || typeof args.command !== "string" || args.command.length > MAX_AGENT_COMMAND)
          return text("run_command takes exactly one string argument, `command`.", true);
        const limit = binding.admit?.(true);
        if (limit !== undefined) return text(limit, true);
        // From here every path records exactly one step (the slot admit reserved).
        let decision: GateDecision;
        try { decision = await (binding.gate ?? READ_ONLY_GATE).authorize(args.command, classifyReadOnly(args.command), signal); }
        catch { decision = { refuse: "ssterm could not decide on this command; nothing was sent to the terminal." }; }
        if ("refuse" in decision) return refuse(args.command, decision.refuse);
        const command = decision.run;
        // An approval may have waited past the request, the task, the session, a reconnect or a lock.
        const late = signal.aborted ? CANCELLED : binding.admit?.(false);
        if (late !== undefined) { decision.undo?.(); return refuse(command, late); }
        const still = current(binding)?.executor;
        if (!still) {
          decision.undo?.();
          revoke(binding);
          return refuse(command, "This binding is no longer valid: the session ended or reconnected, or the workspace locked. Nothing was sent.");
        }
        // A read-only step reads nothing from the terminal (stdin is /dev/null) and never gets a password handoff.
        const started = still.run(command, { readOnly: decision.via === "read-only" });
        if (typeof started === "string") { decision.undo?.(); return refuse(command, refusals[started]); }
        binding.running = true;
        const result = await started.finally(() => { binding.running = false; });
        if (result.status === "not-at-prompt") decision.undo?.();
        binding.record?.({ command: shown(command), status: result.status, exitCode: result.exitCode, output: result.output, truncated: result.truncated, via: decision.via });
        const note = notes[result.status] ?? (result.passwordPrompts
          ? "A password prompt was handed to the user, who typed in the terminal; what they typed is not included." : undefined);
        return text(note ? { ...result, note } : result, UNRUN.includes(result.status));
      }
      case "propose_plan": return (binding.gate ?? READ_ONLY_GATE).propose(args, signal);
      case "read_output": {
        if (!none) return text("read_output takes no arguments.", true);
        const running = executor.peek();
        if (running) return text({ status: "running", exitCode: null, ...running });
        return text(executor.last ?? { status: "none" });
      }
      case "cancel":
        if (!none) return text("cancel takes no arguments.", true);
        return text({ cancelled: executor.cancel() });
      default:
        return text(`Unknown tool: ${typeof name === "string" ? name.slice(0, 64) : "?"}.`, true);
    }
  }

  function accept(socket: Socket) {
    if (disposed || sockets.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    sockets.add(socket);
    let binding: Binding | undefined;
    let buffered = "";
    let pending = 0;
    /** In-flight tools/call requests of this connection, aborted by `notifications/cancelled` or the connection closing. */
    const inFlight = new Map<string | number, AbortController>();
    const timer = setTimeout(() => { if (!binding) socket.destroy(); }, AUTH_TIMEOUT_MS);
    socket.on("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
      binding?.sockets.delete(socket);
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    });
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    const reply = (message: object) => {
      if (socket.destroyed) return;
      if (socket.writableLength > MAX_BUFFERED) { socket.destroy(); return; }
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };
    const authenticate = (line: string) => {
      let found: Binding | undefined;
      try {
        const value: unknown = JSON.parse(line);
        if (exactObject(value, ["credential"]) && typeof value.credential === "string" && TOKEN.test(value.credential))
          found = credentials.get(digest(value.credential));
      } catch { /* Not JSON. */ }
      if (!found || !current(found)) { socket.destroy(); return; }
      clearTimeout(timer);
      binding = found;
      found.sockets.add(socket);
    };
    const handle = (line: string, bound: Binding) => {
      if (credentials.get(bound.hash) !== bound) { socket.destroy(); return; }
      let message: unknown;
      try { message = JSON.parse(line); } catch { reply({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { reply({ id: null, error: { code: -32600, message: "Invalid Request" } }); return; }
      const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
      // Notifications (no id) need no answer; `notifications/initialized` is one.
      if (id === undefined) {
        const requestId = (params as { requestId?: unknown } | undefined)?.requestId;
        if (method === "notifications/cancelled" && (typeof requestId === "string" || typeof requestId === "number")) inFlight.get(requestId)?.abort();
        return;
      }
      if ((typeof id !== "string" && typeof id !== "number") || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0" || typeof method !== "string") {
        reply({ id: null, error: { code: -32600, message: "Invalid Request" } });
        return;
      }
      const request = (params ?? {}) as Record<string, unknown>;
      switch (method) {
        case "initialize": {
          const asked = request.protocolVersion;
          reply({ id, result: {
            protocolVersion: typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "ssterm", version: options.version },
          } });
          return;
        }
        case "ping": reply({ id, result: {} }); return;
        case "tools/list": reply({ id, result: { tools: bound.role?.tools ?? TOOLS } }); return;
        case "tools/call": {
          if (pending >= MAX_PENDING) { reply({ id, error: { code: -32000, message: "Too many calls in progress." } }); return; }
          if (inFlight.has(id)) { reply({ id, error: { code: -32600, message: "A request with this id is in progress." } }); return; }
          pending += 1;
          const controller = new AbortController();
          inFlight.set(id, controller);
          void call(bound, request.name, request.arguments, controller.signal).then(
            (result) => reply({ id, result }),
            () => reply({ id, error: { code: -32603, message: "Internal error" } }),
          ).finally(() => {
            pending -= 1;
            if (inFlight.get(id) === controller) inFlight.delete(id);
          });
          return;
        }
        default: reply({ id, error: { code: -32601, message: "Method not found" } });
      }
    };
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0 && !socket.destroyed) {
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        if (binding) handle(line, binding);
        else authenticate(line);
      }
      if (buffered.length > MAX_LINE) socket.destroy();
    });
  }

  /** Lazily, so no socket exists until a conversation is bound. */
  function listen(): Promise<void> {
    if (listening) return listening;
    const path = options.socketPath;
    listening = new Promise<void>((resolve, reject) => {
      if (Buffer.byteLength(path) > MAX_SOCKET_PATH) throw new Error("socket-path-too-long");
      const folder = dirname(path);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const stat = lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("socket-folder");
      chmodSync(folder, 0o700);
      removeSocketFile();
      const created = createServer(accept);
      created.maxConnections = MAX_CONNECTIONS;
      created.once("error", reject);
      created.once("listening", () => {
        chmodSync(path, 0o600);
        created.off("error", reject);
        created.on("error", () => {});
        resolve();
      });
      server = created;
      // bind() is synchronous inside listen(): the socket file is never created group- or world-accessible.
      const umask = process.umask(0o177);
      try { created.listen(path); } finally { process.umask(umask); }
    });
    listening.catch(() => closeServer());
    return listening;
  }

  return {
    /** Registry tap per Ready SSH terminal generation (local terminals are excluded, A10). */
    observe(session: ObservedTerminal): TerminalObserver | undefined {
      if (disposed || session.local) return undefined;
      const { ownerId, sessionId, generation } = session;
      const live: Live = { ownerId, sessionId, generation, screen: new ScreenTracker(), line: new LineTracker() };
      executors.set(key(sessionId, generation), live);
      return {
        // Until a credential exists only the screen state and the current line are tracked (a full-screen program or a
        // waiting password prompt refuses the first run).
        output: (chunk) => {
          if (live.executor) return live.executor.output(chunk);
          live.screen.feed(chunk);
          live.line.feed(chunk);
        },
        end: () => {
          if (executors.get(key(sessionId, generation)) === live) executors.delete(key(sessionId, generation));
          for (const binding of [...credentials.values()]) if (binding.live === live) revoke(binding);
          live.executor?.end();
        },
      };
    },
    /** The pane banner: the command an agent is running in this exact generation, and whether it waits for a password. */
    status(ownerId: string, sessionId: string, generation: number): { command: string; password?: true } | undefined {
      const live = executors.get(key(sessionId, generation));
      const executor = live?.ownerId === ownerId ? live.executor : undefined;
      const command = executor?.running;
      return command === undefined ? undefined : { command, ...(executor!.password ? { password: true as const } : {}) };
    },
    /**
     * User input to a pane: the bytes that may be written, or undefined to hold it (A9). At a handed-off password prompt
     * (A4) input passes up to and including Return; the rest of that write is dropped.
     */
    input(ownerId: string, sessionId: string, generation: number, bytes: Uint8Array): Uint8Array | undefined {
      const live = executors.get(key(sessionId, generation));
      return live?.ownerId === ownerId && live.executor ? live.executor.input(bytes) : bytes;
    },
    onChange(listener: (ownerId: string) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /**
     * A new per-conversation credential for one Ready SSH terminal (not local, not Team-managed). By default it serves
     * the terminal tools, reporting each call to `record`; with a `role` it serves that tool set instead (ticket 03's
     * main agent), under the same generation and Ready checks.
     */
    async issue(ownerId: string, sessionId: string, use: { role?: AgentToolRole; record?: (step: AgentStepRecord) => void; admit?: (reserve: boolean) => string | undefined; gate?: AgentGate } = {}): Promise<{ credential: string; socketPath: string } | undefined> {
      if (disposed || credentials.size >= MAX_CREDENTIALS) return undefined;
      const since = epoch;
      const bindable = () => {
        try {
          const snapshot = options.registry()?.snapshot(ownerId, sessionId)[0];
          if (!snapshot || snapshot.kind !== "terminal" || snapshot.state !== "Ready" || snapshot.local || snapshot.target?.source === "team") return undefined;
          const live = executors.get(key(sessionId, snapshot.generation));
          return live?.ownerId === ownerId ? live : undefined;
        } catch { return undefined; }
      };
      if (!bindable()) return undefined;
      try { await listen(); } catch { return undefined; }
      const live = bindable();
      if (!live || since !== epoch || disposed) return undefined;
      const { ownerId: owner, sessionId: id, generation } = live;
      live.executor ??= new TerminalExecutor({
        write: (bytes) => {
          try { return options.registry()?.terminal(owner, id, generation)?.write(bytes) ?? "closed"; }
          catch { return "closed"; }
        },
        screen: live.screen,
        line: live.line,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.settleMs ? { settleMs: options.settleMs } : {}),
        ...(options.probeMs ? { probeMs: options.probeMs } : {}),
        ...(options.startMs ? { startMs: options.startMs } : {}),
        onChange: () => changed(owner),
      });
      const credential = randomBytes(32).toString("base64url");
      const hash = digest(credential);
      credentials.set(hash, { hash, live, sockets: new Set(), running: false, ...(use.role ? { role: use.role } : {}), ...(use.record ? { record: use.record } : {}), ...(use.admit ? { admit: use.admit } : {}), ...(use.gate ? { gate: use.gate } : {}) });
      return { credential, socketPath: options.socketPath };
    },
    /**
     * Ends one conversation's credential and its connections, and interrupts a command it is running. Credentials
     * otherwise live until their generation ends or the workspace locks (at most 32 at once).
     */
    revoke(credential: string): void {
      const binding = TOKEN.test(credential) ? credentials.get(digest(credential)) : undefined;
      if (binding) revoke(binding);
    },
    /** Lock workspace, screen lock or suspend: every credential is revoked and every connection dropped. */
    lock() {
      epoch += 1;
      for (const binding of [...credentials.values()]) revoke(binding);
      closeServer();
    },
    dispose() {
      disposed = true;
      epoch += 1;
      for (const binding of [...credentials.values()]) revoke(binding);
      closeServer();
      for (const live of executors.values()) live.executor?.end();
      executors.clear();
      listeners.clear();
    },
  };
}
export type AgentTerminals = ReturnType<typeof createAgentTerminals>;
