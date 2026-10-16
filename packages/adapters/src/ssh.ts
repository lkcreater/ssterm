import ssh2, { type AnyAuthMethod, type ParsedKey } from "ssh2";
import type { HostKeyIdentity } from "@ssterm/domain";
import { decodeHostPublicKey } from "./host-key.ts";

export interface PreparedPrivateKey {
  readonly identity: HostKeyIdentity;
  dispose(): void;
}
const keys = new WeakMap<PreparedPrivateKey, ParsedKey>();
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
  | { type: "publickey"; key: PreparedPrivateKey; dispose(): void };
export type SshFailure = "auth-denied" | "timeout" | "dns" | "network" | "channel-open-failed";
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
  ready(channel: SshResource): boolean;
  failed(code: SshFailure): void;
  ended(): void;
}): SshResource & { start(): void } {
  const client = new ssh2.Client();
  let disposed = false, started = false, verified = false, attempted = false, ready = false;
  let credential: SshCredential | undefined;
  let terminal: SshResource | undefined;
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
              else {
                const key = keys.get(loaded.key);
                if (key) respond({ type: "publickey", username: options.username, key });
                else respond(false);
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
  client.on("error", (error: unknown) => { clearCredential(); fail(failure(error)); });
  client.on("close", () => {
    clearCredential();
    // A paused readable may defer its channel close event until data is consumed.
    // The socket close is the authoritative fence for all its SSH channels.
    terminalClosed?.();
    resolveDrain();
    if (live()) { if (ready) options.ended(); else fail("network"); }
  });
  client.on("ready", () => {
    clearCredential();
    if (!live()) return;
    try {
      client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (error, channel) => {
        if (error) { fail("channel-open-failed"); return; }
        channel.pause();
        channel.stderr.pause();
        let channelDisposed = false;
        let channelDrain!: () => void;
        const channelResource: SshResource = {
          drained: new Promise<void>((resolve) => { channelDrain = resolve; }),
          dispose() { if (!channelDisposed) { channelDisposed = true; channel.destroy(); } },
        };
        terminalClosed = channelDrain;
        channel.on("error", () => fail("network"));
        channel.on("close", () => { channelDrain(); if (live() && ready) options.ended(); });
        terminal = channelResource;
        if (!live()) { channelResource.dispose(); return; }
        ready = true;
        if (!options.ready(channelResource)) channelResource.dispose();
      });
    } catch { fail("channel-open-failed"); }
  });
  options.signal.addEventListener("abort", resource.dispose, { once: true });
  if (options.signal.aborted) resource.dispose();
  return resource;
}
