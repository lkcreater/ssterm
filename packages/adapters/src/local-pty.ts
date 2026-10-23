import { execFile } from "node:child_process";
import { closeSync, constants as fileConstants, openSync, write as writeFd } from "node:fs";
import { access, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { constants, homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import type { TerminalChannel, TerminalEnd, TerminalWrite } from "@ssterm/domain";
import type { LocalSessionAdapter, LocalSessionContext } from "@ssterm/services";

/**
 * Main-only construction seam; no option is accepted by the renderer. Main reads one test-profile-only flag into it:
 * `SSTERM_TEST_LOCAL_HOME` sets `home` (and so cwd) inside a validated test userData; nothing else comes from the environment.
 */
export interface LocalPtyOptions {
  shell?: string;
  args?: readonly string[];
  home?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  arch?: string;
  outputWindow?: number;
  inputBacklog?: number;
  loadPty?: () => Pick<typeof import("node-pty"), "spawn">;
}
const DEFAULT_OUTPUT_WINDOW = 262_144;
const DEFAULT_INPUT_BACKLOG = 524_288;
const MAX_CHUNK = 65_536;
const MAX_BUFFER = 1_048_576;
const nativePermits = new Set<object>();
const MAX_NATIVE_SESSIONS = 32;
// The guardian remains the PTY session leader after the interactive shell exits. Without it macOS
// clears a background job's controlling tty before main can discover it. Only a numeric status is
// written to the main-owned private file; argv is positional and never interpolated into shell code.
const GUARDIAN = 'status_file=$1; shift; "$@"; status=$?; umask 077; printf "%s" "$status" > "$status_file"; while :; do /bin/sleep 1; done';
const safe = (value: string | undefined) => typeof value === "string" && !value.includes("\0");

/** Deliberately excludes build, OAuth, Electron/Node injection, SSH agents and application secrets. */
export function localPtyEnvironment(source: Readonly<Record<string, string | undefined>>, home: string, shell: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "TZ", "USER", "LOGNAME", "TMPDIR"]) {
    const value = source[key];
    if (safe(value)) env[key] = value!;
  }
  env.PATH ||= "/usr/bin:/bin:/usr/sbin:/sbin";
  env.LANG ||= "en_US.UTF-8";
  env.HOME = home;
  env.SHELL = shell;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "ssterm";
  return env;
}

interface ProcessIdentity { pid: number; ppid: number; group: number; tty: string; state: string; born: string }
function processes(): Promise<ProcessIdentity[]> {
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,tty=,stat=,lstart="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 5_000 }, (error, stdout) => {
      if (error) { reject(new Error("local-process-inspection-failed")); return; }
      const result: ProcessIdentity[] = [];
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (match) result.push({ pid: Number(match[1]), ppid: Number(match[2]), group: Number(match[3]), tty: match[4]!, state: match[5]!, born: match[6]! });
      }
      resolve(result);
    });
  });
}
const same = (a: ProcessIdentity, b: ProcessIdentity) => a.pid === b.pid && a.born === b.born;
const running = (entry: ProcessIdentity) => !entry.state.includes("Z");
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Only signals captured identities, rechecked against ps before every escalation. Never signals the app's process group. */
function processOwner(root: number, tty: string, initial: ProcessIdentity[]) {
  const owned = new Map<number, ProcessIdentity>();
  const first = initial.find((entry) => entry.pid === root);
  // forkpty's spawn helper can be observed before it assigns the controlling tty. PID/birth/group
  // capture is already valid; tty ownership is used only alongside that same live session leader.
  if (!first || first.group !== root) throw new Error("local-process-ownership-unavailable");
  owned.set(root, first);
  const discover = (table: ProcessIdentity[]) => {
    const rootNow = table.find((entry) => entry.pid === root);
    const rootMatches = first && rootNow && same(first, rootNow);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of table) {
        if (entry.pid <= 1 || entry.pid === process.pid || owned.has(entry.pid)) continue;
        const parent = owned.get(entry.ppid);
        const parentNow = parent && table.find((candidate) => same(parent, candidate));
        // The original PTY's own process group also covers children reparented after a normal shell exit.
        if (parentNow || (rootMatches && (entry.group === root || entry.tty === tty))) {
          owned.set(entry.pid, entry); changed = true;
        }
      }
    }
    return table.filter((entry) => owned.has(entry.pid) && same(owned.get(entry.pid)!, entry) && running(entry));
  };
  discover(initial);
  return {
    observe: discover,
    async stop() {
      const deadline = Date.now() + 3_000;
      // Stop the captured tree first so an ordinary foreground/background child cannot fork between discovery and kill.
      let stopped = false;
      for (;;) {
        if (Date.now() > deadline) throw new Error("local-process-cleanup-pending");
        const live = discover(await processes());
        if (live.length === 0) return;
        for (const entry of live) { try { process.kill(entry.pid, "SIGSTOP"); } catch { /* Already exited. */ } }
        const expanded = discover(await processes());
        if (expanded.every((entry) => live.some((old) => same(entry, old)))) { stopped = true; break; }
      }
      if (stopped) {
        for (const entry of discover(await processes())) {
          try { process.kill(entry.pid, "SIGTERM"); process.kill(entry.pid, "SIGCONT"); } catch { /* Already exited. */ }
        }
      }
      await pause(150);
      for (;;) {
        if (Date.now() > deadline) throw new Error("local-process-cleanup-pending");
        const live = discover(await processes());
        if (live.length === 0) return;
        for (const entry of live) { try { process.kill(entry.pid, "SIGKILL"); } catch { /* Recheck actual disappearance. */ } }
        await pause(50);
      }
    },
  };
}

/** Pinned node-pty 1.1.0 Unix-only seam. Its public write() has an unbounded hidden queue and no drain callback. */
interface NativePty extends IPty {
  _fd: number;
  _pty: string;
  _socket: import("node:tty").ReadStream;
  destroy(): void;
  on(event: "error", callback: () => void): unknown;
}

export function createLocalPtyAdapter(options: LocalPtyOptions = {}): LocalSessionAdapter {
  const shell = options.shell ?? "/bin/zsh";
  const args = [...(options.args ?? ["-l"])];
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? home;
  const env = localPtyEnvironment(options.env ?? process.env, home, shell);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const outputWindow = options.outputWindow ?? DEFAULT_OUTPUT_WINDOW;
  const inputBacklog = options.inputBacklog ?? DEFAULT_INPUT_BACKLOG;
  if (!Number.isSafeInteger(outputWindow) || outputWindow < 1 || outputWindow > MAX_BUFFER || !Number.isSafeInteger(inputBacklog) || inputBacklog < 1 || inputBacklog > 2_097_152)
    throw new RangeError("invalid-terminal-bounds");
  return {
    metadata: Object.freeze({ shell, platform: "darwin" as const }),
    async start(context: LocalSessionContext) {
      if (context.signal.aborted) return;
      if (platform !== "darwin" || arch !== "arm64") { context.failed("local-unsupported"); return; }
      let native: NativePty | undefined;
      let directory: string | undefined;
      let adopted = false;
      let unadoptedCleaned = false;
      const permit = {};
      try {
        if (nativePermits.size >= MAX_NATIVE_SESSIONS) { context.failed("resource-limit"); return; }
        nativePermits.add(permit);
        const { spawn } = (options.loadPty ?? (() => createRequire(import.meta.url)("node-pty") as typeof import("node-pty")))();
        await access(shell, fileConstants.X_OK);
        if (!(await stat(cwd)).isDirectory()) throw new Error("invalid-local-cwd");
        // Inspection must be available before creating a process whose cleanup depends on it.
        await processes();
        if (context.signal.aborted) return;
        directory = await mkdtemp(join(tmpdir(), "ssterm-local-session-"));
        const statusFile = join(directory, "exit-status");
        await writeFile(statusFile, "", { flag: "wx", mode: 0o600 });
        const statusIdentity = await stat(statusFile);
        native = spawn("/bin/sh", ["-c", GUARDIAN, "ssterm-local-guardian", statusFile, shell, ...args], { name: "xterm-256color", cols: 80, rows: 24, cwd, env, encoding: null, handleFlowControl: false }) as NativePty;
        native.pause();
        const channel = createChannel(native, context, outputWindow, inputBacklog, statusFile, directory, statusIdentity);
        adopted = true;
        void channel.drained.then(() => nativePermits.delete(permit));
        if (!context.own(channel)) { channel.dispose(); return; }
        await channel.initialize();
        if (context.signal.aborted || !context.ready(channel)) channel.dispose();
      } catch {
        if (native && !adopted) {
          try {
            // Even an unsupported pinned native shape can have already spawned the guardian. Obtain
            // an independent process identity and controlling tty before killing it; a failed probe
            // retains the permit rather than granting unlimited new native resources.
            let fallback: ReturnType<typeof processOwner> | undefined;
            for (let attempt = 0; attempt < 20 && !fallback; attempt++) {
              const table = await processes();
              const first = table.find((entry) => entry.pid === native!.pid && entry.ppid === process.pid && entry.group === native!.pid && /^ttys\d+$/.test(entry.tty));
              if (first) fallback = processOwner(first.pid, first.tty, table); else await pause(25);
            }
            if (fallback) { await fallback.stop(); unadoptedCleaned = true; }
          } catch { /* Retain the native permit if actual process death cannot be confirmed. */ }
          try { native.destroy(); } catch { /* Failure remains quarantined. */ }
        }
        if (!context.signal.aborted) context.failed("local-spawn-failed");
      } finally {
        if (!adopted && (!native || unadoptedCleaned)) {
          nativePermits.delete(permit);
          if (directory) await rm(directory, { force: true, recursive: true });
        }
      }
    },
  };
}

function createChannel(native: NativePty, context: LocalSessionContext, outputWindow: number, inputBacklog: number, statusFile: string, directory: string, statusIdentity: { dev: number; ino: number }): TerminalChannel & { initialize(): Promise<void> } {
  let output: ((bytes: Uint8Array, sequence: number) => void) | undefined;
  let sequence = 0, unacked = 0, buffered = 0, queuedInput = 0;
  let disposed = false, exit: TerminalEnd | undefined, ended = false, pumping = false;
  let writing = false, destroyed = false;
  let childStatus: number | undefined, stopping: Promise<void> | undefined;
  const chunks: Buffer[] = [], inputs: { bytes: Buffer; offset: number }[] = [];
  let owner: ReturnType<typeof processOwner> | undefined;
  let initialization: Promise<void>;
  let drain!: () => void;
  const drained = new Promise<void>((resolve) => { drain = resolve; });
  let inputIdle!: () => void;
  let inputDone = Promise.resolve();
  const socket = native._socket;
  if (!Number.isInteger(native._fd) || native._fd < 0 || !socket || typeof native.destroy !== "function") throw new Error("unsupported-local-pty");
  if (!/^\/dev\/ttys\d+$/.test(native._pty)) throw new Error("unsupported-local-pty");
  // macOS /dev/fd duplicates the descriptor. Keep the allocation alive until the owned tree is dead;
  // native ReadStream closure or exit can never recycle the fd used by an in-flight input callback.
  const fd = openSync(`/dev/fd/${native._fd}`, "r+");
  let inputFdOpen = true;
  const closeInputFd = () => {
    if (!inputFdOpen) return;
    // Never retry close on a possibly recycled descriptor, including after a close error.
    inputFdOpen = false;
    closeSync(fd);
  };
  const destroySocket = socket.destroy.bind(socket);
  // node-pty 1.1.0 has a 200ms exit timeout which otherwise destroys an intentionally credit-paused
  // ReadStream and silently loses the tail. Delay only that no-error forced destroy; real EOF/EIO,
  // errors and explicit disposal retain the original destruction path. This is tested beyond 200ms.
  socket.destroy = ((error?: Error) => {
    if (!disposed && !error && (output === undefined || unacked >= outputWindow || buffered > 0)) return socket;
    return destroySocket(error);
  }) as typeof socket.destroy;
  const fail = () => { if (!disposed) context.failed("resource-limit"); dispose(); };
  const finish = () => {
    if (!disposed && output && exit && buffered === 0 && !ended) { ended = true; context.ended(exit); }
  };
  const flow = () => {
    if (disposed || !output || unacked >= outputWindow || buffered > 0) native.pause();
    else native.resume();
  };
  const pump = () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!disposed && output && chunks.length > 0 && unacked < outputWindow) {
        const first = chunks[0]!;
        const count = Math.min(first.length, MAX_CHUNK, outputWindow - unacked);
        const copy = new Uint8Array(first.subarray(0, count));
        if (count === first.length) chunks.shift(); else chunks[0] = first.subarray(count);
        buffered -= count; unacked += count;
        output(copy, sequence++);
      }
    } finally { pumping = false; }
    flow(); finish();
  };
  const flushInput = () => {
    if (writing || disposed || inputs.length === 0) return;
    const head = inputs[0]!;
    writing = true;
    writeFd(fd, head.bytes, head.offset, head.bytes.length - head.offset, null, (error, count) => {
      writing = false;
      if (disposed) { for (const entry of inputs) entry.bytes.fill(0); inputs.length = 0; queuedInput = 0; inputIdle(); return; }
      if (error && (error.code === "EAGAIN" || error.code === "EINTR")) { setImmediate(flushInput); return; }
      if (error || count === 0) {
        if (childStatus !== undefined) { for (const entry of inputs) entry.bytes.fill(0); inputs.length = 0; queuedInput = 0; inputIdle(); return; }
        context.failed("local-spawn-failed"); dispose(); return;
      }
      queuedInput -= count; head.offset += count;
      if (head.offset === head.bytes.length) { head.bytes.fill(0); inputs.shift(); }
      if (inputs.length === 0) inputIdle(); else flushInput();
    });
  };
  const data = native.onData((value) => {
    if (disposed) return;
    if (!Buffer.isBuffer(value)) { fail(); return; }
    native.pause();
    if (buffered + value.length > MAX_BUFFER) { fail(); return; }
    if (value.length > 0) { chunks.push(Buffer.from(value)); buffered += value.length; }
    pump();
  });
  const exited = native.onExit(({ exitCode, signal }) => {
    if (disposed) return;
    const signalName = signal && Object.entries(constants.signals).find(([, value]) => value === signal)?.[0];
    exit = childStatus !== undefined ? { kind: "exit", code: childStatus } : signalName ? { kind: "signal", signal: signalName } : { kind: "exit", code: exitCode };
    finish();
  });
  native.on("error", () => { if (!disposed) { context.failed("local-spawn-failed"); dispose(); } });
  const stopOwned = () => stopping ??= (async () => {
    await initialization;
    if (!owner) throw new Error("local-process-ownership-unavailable");
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await owner.stop(); return; } catch { if (attempt === 2) throw new Error("local-process-cleanup-pending"); await pause(250); }
    }
  })();
  let readingStatus = false;
  let pendingStatus: Promise<void> = Promise.resolve();
  const statusPoll = setInterval(() => {
    if (disposed || childStatus !== undefined || readingStatus) return;
    readingStatus = true;
    pendingStatus = (async () => {
      const handle = await open(statusFile, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.dev !== statusIdentity.dev || info.ino !== statusIdentity.ino || info.size > 3) throw new Error("invalid-local-exit-status");
        const bytes = Buffer.alloc(4);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead === 0) return;
        const value = bytes.subarray(0, bytesRead).toString("latin1");
        if (!/^\d{1,3}$/.test(value) || Number(value) > 255) throw new Error("invalid-local-exit-status");
        if (disposed || childStatus !== undefined) return;
        // POSIX wait status is numeric (128+n may mean a signal or an explicit shell exit); do not
        // invent an exact signal from this shell convention.
        childStatus = Number(value);
        clearInterval(statusPoll);
        void stopOwned().catch(() => { if (!disposed) { context.failed("local-spawn-failed"); dispose(); } });
      } finally { await handle.close(); }
    })().catch(() => { if (!disposed) { context.failed("local-spawn-failed"); dispose(); } }).finally(() => { readingStatus = false; });
  }, 100);
  const dispose = () => {
    if (disposed) return;
    disposed = true; output = undefined; chunks.length = 0; buffered = 0;
    clearInterval(statusPoll);
    data.dispose(); exited.dispose(); native.pause();
    for (const entry of inputs) if (!writing || entry !== inputs[0]) entry.bytes.fill(0);
    if (!writing) { inputs.length = 0; queuedInput = 0; inputIdle?.(); }
    void (async () => {
      try {
        await initialization;
        // Stop retrying writes before touching the descriptor. Wait for the actual fs.write callback
        // before node-pty closes its fd, so a reused fd can never receive a late retry.
        await inputDone;
        await pendingStatus;
        for (const entry of inputs) entry.bytes.fill(0);
        inputs.length = 0;
        await stopOwned();
        if (!destroyed) { destroyed = true; native.destroy(); }
        closeInputFd();
        await rm(directory, { recursive: true, force: true });
        drain();
      } catch {
        // Inspection retries are exhausted. Release avoidable IO resources, without claiming that
        // unknown process death is confirmed or allowing the native admission permit to be reused.
        await inputDone;
        await pendingStatus;
        if (!destroyed) { destroyed = true; try { native.destroy(); } catch { /* Retry process cleanup. */ } }
        try { closeInputFd(); } catch { /* Do not retry close on a potentially recycled fd. */ }
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        // Failed ownership cannot be promoted into cleanup success. The global native permit remains
        // retained and the registry reports its bounded drain timeout instead of enabling unlimited retries.
      }
    })();
  };
  initialization = processes().then((table) => { owner = processOwner(native.pid, native._pty.slice(5), table); });
  return {
    drained,
    initialize: () => initialization,
    open(sink) { if (disposed || output) return false; output = sink; pump(); return true; },
    ack(bytes) { if (!disposed && Number.isSafeInteger(bytes) && bytes > 0) { unacked = Math.max(0, unacked - bytes); pump(); } },
    write(bytes): TerminalWrite {
      if (disposed || exit || childStatus !== undefined) return "closed";
      if (queuedInput + bytes.length > inputBacklog) return "busy";
      if (bytes.length === 0) return "ok";
      if (inputs.length === 0 && !writing) inputDone = new Promise<void>((resolve) => { inputIdle = resolve; });
      inputs.push({ bytes: Buffer.from(bytes), offset: 0 }); queuedInput += bytes.length; flushInput(); return "ok";
    },
    resize(columns, rows) { if (!disposed && !exit) { try { native.resize(columns, rows); } catch { context.failed("local-spawn-failed"); dispose(); } } },
    dispose,
  };
}
