import ssh2, { type AnyAuthMethod, type ClientChannel, type ParsedKey, type TerminalModes } from "ssh2";
import type { HostKeyIdentity, TerminalChannel, TerminalEnd } from "@ssterm/domain";
import { decodeHostPublicKey } from "./host-key.ts";

export interface PreparedPrivateKey {
  readonly identity: HostKeyIdentity;
  dispose(): void;
}
const keys = new WeakMap<PreparedPrivateKey, ParsedKey>();
// RFC 8160 IUTF8 (opcode 42) = 1, then TTY_OP_END. ssh2 1.17's named-mode table lacks IUTF8 and silently
// drops unknown keys, so the pre-encoded bytes are passed through; without it Backspace splits UTF-8 characters.
const IUTF8_MODES = Buffer.from([42, 0, 0, 0, 1, 0]) as unknown as TerminalModes;
export type PrivateKeyResult =
  | { ok: true; key: PreparedPrivateKey }
  | { ok: false; code: "credentials-required" | "invalid-private-key" | "unsupported-private-key" };

/** Main-only, single-key allowlist. Parsing/decryption belongs to ssh2, never a custom decoder. */
export function preparePrivateKey(bytes: Uint8Array, passphrase?: Uint8Array): PrivateKeyResult {
  if (!bytes.length || bytes.length > 1_048_576)
    return { ok: false, code: "invalid-private-key" };
  const raw = Buffer.from(bytes);
  const phrase = passphrase === undefined ? undefined : Buffer.from(passphrase);
  try {
    const text = raw.toString("utf8").trim();
    const header = /^-----BEGIN (OPENSSH|RSA) PRIVATE KEY-----\r?\n/u.exec(text);
    if (!header) return { ok: false, code: "unsupported-private-key" };
    const footer = `-----END ${header[1]} PRIVATE KEY-----`;
    if (!text.endsWith(footer) || (text.match(/-----BEGIN /gu)?.length ?? 0) !== 1 || (text.match(/-----END /gu)?.length ?? 0) !== 1)
      return { ok: false, code: "invalid-private-key" };
    const result = ssh2.utils.parseKey(raw, phrase);
    if (result instanceof Error)
      return { ok: false, code: phrase === undefined && /no passphrase given/iu.test(result.message) ? "credentials-required" : "invalid-private-key" };
    // ssh2 returns an array for OpenSSH private files, including single-key files.
    const parsed = Array.isArray(result) ? result.length === 1 ? result[0] as ParsedKey : undefined : result;
    if (!parsed || !parsed.isPrivateKey()) return { ok: false, code: "invalid-private-key" };
    if (parsed.type !== (header[1] === "OPENSSH" ? "ssh-ed25519" : "ssh-rsa"))
      return { ok: false, code: "unsupported-private-key" };
    const identity = decodeHostPublicKey(parsed.getPublicSSH());
    if (!identity) return { ok: false, code: "invalid-private-key" };
    const key: PreparedPrivateKey = Object.freeze({ identity, dispose() { keys.delete(key); } });
    keys.set(key, parsed);
    return { ok: true, key };
  } catch {
    return { ok: false, code: "invalid-private-key" };
  } finally {
    raw.fill(0);
    phrase?.fill(0);
  }
}

export type SshCredential =
  | { type: "password"; password: Buffer; dispose(): void }
  | { type: "publickey"; key: PreparedPrivateKey; dispose(): void }
  | {
      type: "keyboard-interactive";
      respond(fields: readonly { echo: boolean }[], finish: (answers: readonly Uint8Array[]) => void): Promise<void>;
      dispose(): void;
    };
export type SshFailure = "auth-denied" | "timeout" | "dns" | "network" | "channel-open-failed" | "resource-limit";
type AuthResponse = AnyAuthMethod | false | { type: "password"; username: string; password: Buffer };
export interface SshResource {
  dispose(): void;
  readonly drained: Promise<void>;
}
function failure(error: unknown): SshFailure {
  const value = error as { level?: unknown; code?: unknown } | null;
  if (value?.level === "client-authentication") return "auth-denied";
  if (value?.level === "client-timeout" || value?.code === "ETIMEDOUT") return "timeout";
  if (value?.code === "ENOTFOUND" || value?.code === "EAI_AGAIN") return "dns";
  return "network";
}

/** Own before start(). One selected authentication attempt; no implicit none/agent/interactive fallback. */
export function createSshConnection(options: {
  host: string;
  port: number;
  username: string;
  signal: AbortSignal;
  verifyHost(publicKey: Uint8Array, initial: boolean): Promise<boolean>;
  authenticate(): Promise<SshCredential | undefined>;
  ready(terminal: TerminalChannel): boolean;
  failed(code: SshFailure): void;
  /** Defaults and validation: `terminalBounds`. */
  terminal?: TerminalBounds;
  /** Remote end only, after every preceding output chunk reached the consumer. */
  ended(end: TerminalEnd): void;
}): SshResource & { start(): void } {
  const bounds = terminalBounds(options.terminal);
  const client = new ssh2.Client();
  let disposed = false, started = false, verified = false, attempted = false, ready = false;
  let credential: SshCredential | undefined;
  let terminal: ReturnType<typeof createTerminal> | undefined;
  let terminalClosed: (() => void) | undefined;
  let resolveDrain!: () => void;
  const drained = new Promise<void>((resolve) => { resolveDrain = resolve; });
  const live = () => !disposed && !options.signal.aborted;
  const clearCredential = () => { credential?.dispose(); credential = undefined; };
  const fail = (code: SshFailure) => { if (live()) options.failed(code); };
  const resource = {
    drained,
    dispose() {
      if (disposed) return;
      disposed = true;
      options.signal.removeEventListener("abort", resource.dispose);
      clearCredential();
      terminal?.dispose();
      client.destroy();
      // ssh2 emits no close if connect has never allocated a socket.
      if (!started) resolveDrain();
    },
    start() {
      if (started || !live()) return;
      started = true;
      try {
        client.connect({
          host: options.host,
          port: options.port,
          username: options.username,
          readyTimeout: 120_000,
          tryKeyboard: false,
          hostVerifier: (publicKey: Buffer, verify: (allowed: boolean) => void) => {
            const respond = (allowed: boolean) => {
              try { verify(allowed); } catch { fail("network"); }
            };
            if (!live()) { respond(false); return; }
            const initial = !verified;
            void options.verifyHost(publicKey, initial).then((allowed) => {
              if (!live()) { respond(false); return; }
              if (allowed) verified = true;
              respond(allowed);
            }, () => { respond(false); fail("network"); });
          },
          authHandler: (_methods, _partial, next) => {
            // @types/ssh2 omits the supported false sentinel and Buffer passwords.
            const respond = (method: AuthResponse) => {
              try { (next as (value: AuthResponse) => void)(method); }
              catch { clearCredential(); fail("network"); }
            };
            if (!live() || !verified || attempted) { respond(false); return; }
            attempted = true;
            void options.authenticate().then((loaded) => {
              if (!live()) { loaded?.dispose(); respond(false); return; }
              if (!loaded) { respond(false); return; }
              credential = loaded;
              if (loaded.type === "password") respond({ type: "password", username: options.username, password: loaded.password });
              else if (loaded.type === "publickey") {
                const key = keys.get(loaded.key);
                if (key) respond({ type: "publickey", username: options.username, key });
                else respond(false);
              } else {
                respond({
                  type: "keyboard-interactive", username: options.username,
                  prompt(_name, _instructions, _language, prompts, finish) {
                    if (!live()) return;
                    // Upstream labels/instructions never leave the transport. ssh2
                    // handles zero-field rounds itself before invoking this callback.
                    void loaded.respond(prompts.map(({ echo }) => ({ echo: echo === true })), (answers) => {
                      if (!live()) return;
                      try {
                        // ssh2's info-response encoder requires strings. Borrowed bytes
                        // are converted only for this synchronous protocol write.
                        finish(answers.map((answer) => Buffer.from(answer.buffer, answer.byteOffset, answer.byteLength).toString("utf8")));
                      } catch { fail("network"); }
                    }).catch(() => fail("network"));
                  },
                });
              }
            }, () => { respond(false); fail("network"); });
          },
        });
      } catch {
        fail("network");
        resource.dispose();
        resolveDrain();
      }
    },
  };
  client.on("error", (error: unknown) => {
    clearCredential();
    // A reset after the remote exit still ends with that exit, as on close (G1).
    const exit = ready ? terminal?.exited() : undefined;
    if (!exit) fail(failure(error)); else if (live()) options.ended(exit);
  });
  client.on("close", () => {
    clearCredential();
    // A paused readable may defer its channel close event until data is consumed.
    // The socket close is the authoritative fence for all its SSH channels.
    terminalClosed?.();
    resolveDrain();
    if (!live()) return;
    // ssh2 reports socket loss before any channel close, and sshd keeps TCP open after a
    // remote exit, so only an exit already received makes this a remote end.
    const exit = ready ? terminal?.exited() : undefined;
    if (exit) options.ended(exit); else fail("network");
  });
  client.on("ready", () => {
    clearCredential();
    if (!live()) return;
    try {
      client.shell({ term: "xterm-256color", cols: 80, rows: 24, modes: IUTF8_MODES }, (error, channel) => {
        if (error) { fail("channel-open-failed"); return; }
        // Must precede the data listeners, which would otherwise start flowing mode.
        channel.pause();
        channel.stderr.pause();
        let channelDrain!: () => void;
        const channelDrained = new Promise<void>((resolve) => { channelDrain = resolve; });
        terminalClosed = channelDrain;
        channel.on("error", () => fail("network"));
        channel.on("close", () => channelDrain());
        const opened = createTerminal(channel, channelDrained, {
          closed: (end) => { if (live() && ready) options.ended(end); },
          overflowed: () => fail("resource-limit"),
          // ssh2-internal: bytes ssh2 already handed to the TCP socket are no longer in channel.writableLength.
          socketBacklog: () => (client as unknown as { _sock?: { writableLength?: number } })._sock?.writableLength ?? 0,
        }, bounds);
        terminal = opened;
        if (!live()) { opened.dispose(); return; }
        ready = true;
        if (!options.ready(opened)) opened.dispose();
      });
    } catch { fail("channel-open-failed"); }
  });
  options.signal.addEventListener("abort", resource.dispose, { once: true });
  if (options.signal.aborted) resource.dispose();
  return resource;
}

/** Default unacknowledged output credit and queued input bytes per session (SST-014 measured). */
export const TERMINAL_OUTPUT_WINDOW = 262_144;
export const TERMINAL_INPUT_BACKLOG = 524_288;
export interface TerminalBounds { outputWindow?: number; inputBacklog?: number }
const within = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
/** Applies the defaults and returns a validated frozen copy, so a caller's later mutation cannot reach a session. */
export function terminalBounds(bounds: TerminalBounds = {}): Readonly<Required<TerminalBounds>> {
  const { outputWindow = TERMINAL_OUTPUT_WINDOW, inputBacklog = TERMINAL_INPUT_BACKLOG } = bounds;
  if (!within(outputWindow, 65_536, 1_048_576) || !within(inputBacklog, 1, 2_097_152))
    throw new RangeError("invalid-terminal-bounds");
  return Object.freeze({ outputWindow, inputBacklog });
}
// ssh2 does not enforce its own receive window (an overrun leaves it negative and keeps buffering), so a
// hostile peer could grow a paused readable without bound, and tiny packets cost ~210 B of heap each.
// A compliant peer on one stream stays under 4 MiB (ssh2's 2 MiB high-water mark plus one 2 MiB window
// granted before push reported backpressure). ssh2 shares one window between stdout and stderr, so heavy
// interleaved stderr while paused can exceed it too; OpenSSH PTY sessions send no stderr.
export const TERMINAL_BUFFER_LIMIT = 4_718_592;
export const TERMINAL_CHUNK_LIMIT = 65_536;

/** Every ssh2 stream quirk lives here: callers see ordered owned chunks, credit, a bounded input backlog and one end. */
function createTerminal(
  channel: ClientChannel,
  drained: Promise<void>,
  { closed, overflowed, socketBacklog }: { closed(end: TerminalEnd): void; overflowed(): void; socketBacklog(): number },
  { outputWindow, inputBacklog }: Readonly<Required<TerminalBounds>>,
): TerminalChannel & { exited(): TerminalEnd | undefined } {
  let output: ((chunk: Uint8Array, sequence: number) => void) | undefined;
  // `buffered`: chunks pushed into either readable and not yet emitted as data.
  let unacked = 0, sequence = 0, buffered = 0, disposed = false, finished = false, pendingCloses = 2;
  let exitSeen: TerminalEnd | undefined;
  const flow = () => {
    const open = output !== undefined && !disposed && unacked < outputWindow;
    for (const stream of [channel, channel.stderr]) {
      if (open) stream.resume(); else stream.pause();
    }
  };
  // ponytail: stdout/stderr interleave in arrival order while flowing, but chunks buffered during a
  // credit pause drain per stream. OpenSSH PTY sessions send no extended data; add a merged arrival
  // queue if a non-PTY channel ever needs strict cross-stream order.
  const deliver = (data: Buffer) => {
    buffered--;
    // An empty CHANNEL_DATA would become a frame the contract rejects, i.e. a sequence gap.
    if (disposed || !output || data.length === 0) return;
    unacked += data.length;
    // ssh2 hands out views of pooled packet buffers; the consumer gets an exact-length copy.
    // ponytail: one frame and one acknowledgement per ssh2 chunk, measured adequate (38–50 MiB/s end to end).
    // Upgrade path: merge chunks per tick, flushing before end/socket close and dropping on dispose.
    output(new Uint8Array(data), sequence++);
    if (unacked >= outputWindow) flow();
  };
  // ssh2 emits each close only after its readable drained, and both drain only with credit,
  // so the end follows every delivered chunk.
  const settle = () => {
    if (--pendingCloses > 0) return;
    finished = true;
    closed(exitSeen ?? { kind: "eof" });
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    output = undefined;
    channel.destroy();
  };
  // ssh2 delivers every CHANNEL_DATA through push, so this sees each chunk before it is buffered.
  for (const stream of [channel, channel.stderr]) {
    const push = stream.push.bind(stream);
    stream.push = (chunk: Buffer | null) => {
      if (chunk === null) return push(chunk);
      if (disposed) return false;
      // Counted first: a flowing readable emits data synchronously inside push.
      if (chunk.length > 0) buffered++;
      const result = push(chunk);
      if (buffered > TERMINAL_CHUNK_LIMIT || channel.readableLength + channel.stderr.readableLength > TERMINAL_BUFFER_LIMIT) {
        overflowed();
        dispose();
        return false;
      }
      return result;
    };
  }
  channel.on("data", deliver);
  channel.stderr.on("data", deliver);
  channel.on("exit", (code: unknown, signal: unknown) => { exitSeen = exitOf(code, signal); });
  channel.once("close", settle);
  channel.stderr.once("close", settle);
  return {
    drained,
    exited: () => exitSeen,
    open(sink) {
      if (output || disposed) return false;
      output = sink;
      flow();
      return true;
    },
    ack(bytes) {
      unacked = Math.max(0, unacked - bytes);
      flow();
    },
    write(bytes) {
      if (disposed || finished || !channel.writable) return "closed";
      // All or nothing: a refused write queues no prefix, so a bracketed paste is never cut.
      if (channel.writableLength + socketBacklog() + bytes.byteLength > inputBacklog) return "busy";
      channel.write(Buffer.from(bytes));
      return "ok";
    },
    resize(columns, rows) {
      if (!disposed && !finished) channel.setWindow(rows, columns, 0, 0);
    },
    dispose,
  };
}

/** ssh2 exit args: (status) or (null, "SIG<NAME>", dumped, description). The description is server text and is dropped. */
function exitOf(code: unknown, signal: unknown): TerminalEnd {
  if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 0xffff_ffff) return { kind: "exit", code };
  if (typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(signal)) return { kind: "signal", signal };
  return { kind: "eof" };
}
