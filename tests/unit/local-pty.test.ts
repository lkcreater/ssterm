import assert from "node:assert/strict";
import { test as nodeTest, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalChannel, TerminalEnd } from "@ssterm/domain";
import type { LocalSessionContext, SessionErrorCode, SessionResource } from "@ssterm/services";
import { createLocalPtyAdapter, localPtyEnvironment, type LocalPtyOptions } from "../../packages/adapters/src/local-pty.ts";

// Unconfirmed owned-process cleanup deliberately leaves `drained` pending (the permit stays retained), and the
// owned tree can keep this file's event loop alive. Bound every test and the cleanup hook so such a failure is
// reported instead of blocking `npm test` indefinitely.
const TEST_TIMEOUT = 60_000;
const test = (name: string, fn: (t: TestContext) => void | Promise<void>) => nodeTest(name, { timeout: TEST_TIMEOUT }, fn);
const script = fileURLToPath(new URL("../fixtures/local-pty/terminal.cjs", import.meta.url));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);
async function absentOrZombie(pid: number) {
  try {
    const { stdout } = await exec("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
    return stdout.trim().startsWith("Z");
  } catch (error) { return (error as { code?: number }).code === 1; }
}
async function assertGone(pid: number) {
  const deadline = Date.now() + 5_000;
  while (!(await absentOrZombie(pid))) { if (Date.now() >= deadline) assert.fail(`owned process ${pid} remains running`); await delay(20); }
}
async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 10_000;
  while (!condition()) { if (Date.now() >= deadline) assert.fail(message); await delay(10); }
}
async function fixture(t: { after(fn: () => Promise<unknown>, options?: { timeout?: number }): unknown }, mode: string, options: LocalPtyOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "ssterm-local-pty-"));
  const abort = new AbortController();
  const resources: SessionResource[] = [];
  const errors: SessionErrorCode[] = [];
  let channel: TerminalChannel | undefined;
  let ended: TerminalEnd | undefined;
  const context: LocalSessionContext = {
    id: "owned-local-test", generation: 1, signal: abort.signal,
    own(resource) { resources.push(resource); return true; },
    ready(value) { channel = value; return true; },
    failed(code) { errors.push(code); resources.forEach((resource) => resource.dispose()); },
    ended(value) { ended = value; },
  };
  t.after(async () => {
    abort.abort(); resources.forEach((resource) => resource.dispose());
    await Promise.all(resources.map((resource) => resource.drained));
    await rm(home, { recursive: true, force: true });
  }, { timeout: TEST_TIMEOUT });
  const adapter = createLocalPtyAdapter({ shell: process.execPath, args: [script, mode, join(home, "children.json")], home, cwd: home, env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, ...options });
  await adapter.start(context);
  return { home, errors, get channel() { assert(channel); return channel; }, get ended() { return ended; }, metadata: adapter.metadata };
}

test("local PTY environment copies only terminal/session allowlist and forces owned home/shell", () => {
  const env = localPtyEnvironment({ PATH: "/usr/bin:/bin", LANG: "th_TH.UTF-8", USER: "fixture", HOME: "/wrong", SHELL: "/wrong", NODE_OPTIONS: "--inspect", DYLD_INSERT_LIBRARIES: "/secret", SSTERM_GOOGLE_CLIENT_FILE: "/secret", GOOGLE_ACCESS_TOKEN: "secret", SSH_AUTH_SOCK: "/secret", PS1: "secret", LC_ALL: "C\0secret" }, "/owned", "/bin/zsh");
  assert.deepEqual(env, { PATH: "/usr/bin:/bin", LANG: "th_TH.UTF-8", USER: "fixture", HOME: "/owned", SHELL: "/bin/zsh", TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "ssterm" });
  assert.throws(() => createLocalPtyAdapter({ outputWindow: 0 }), /invalid-terminal-bounds/);
});

test("local PTY rejects unsupported platforms and sanitizes spawn failures", async (t) => {
  const unsupported = await fixture(t, "echo", { platform: "linux" });
  assert.deepEqual(unsupported.errors, ["local-unsupported"]);
  const failed = await fixture(t, "echo", { shell: "/nonexistent/ssterm-fixture-shell" });
  assert.deepEqual(failed.errors, ["local-spawn-failed"]);
  const missingNative = await fixture(t, "echo", { loadPty() { throw new Error("private-native-loader-path"); } });
  assert.deepEqual(missingNative.errors, ["local-spawn-failed"]);
});

test("local PTY preserves raw Unicode and binary bytes, delayed open and ordered exit tail", async (t) => {
  const f = await fixture(t, "bytes");
  await delay(350); // Beyond node-pty's forced socket-destroy timer.
  assert.equal(f.ended, undefined);
  const chunks: Uint8Array[] = [];
  const sequences: number[] = [];
  assert(f.channel.open((bytes, sequence) => { chunks.push(bytes); sequences.push(sequence); f.channel.ack(bytes.length); }));
  assert.equal(f.channel.open(() => {}), false);
  await until(() => f.ended !== undefined, "raw fixture did not finish");
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from("ไทย😀"), Buffer.from([0, 255, 128, 13, 10])]));
  assert.deepEqual(sequences, sequences.map((_, index) => index));
  assert.deepEqual(f.ended, { kind: "exit", code: 7 });
  assert.deepEqual(f.errors, []);
});

test("local PTY credit pauses flood beyond exit timeout without losing tail or ending early", async (t) => {
  const f = await fixture(t, "flood", { outputWindow: 4096 });
  const chunks: Uint8Array[] = [];
  const sequences: number[] = [];
  let autoAck = false;
  f.channel.open((bytes, sequence) => { chunks.push(bytes); sequences.push(sequence); if (autoAck) f.channel.ack(bytes.length); });
  await until(() => chunks.length > 0, "no initial output");
  await delay(350);
  assert.equal(Buffer.concat(chunks).length, 4096);
  assert.equal(f.ended, undefined);
  autoAck = true; f.channel.ack(4096);
  await until(() => f.ended !== undefined, "flood fixture did not finish");
  assert.equal(Buffer.concat(chunks).length, 655_360);
  assert(Buffer.concat(chunks).every((byte) => byte === 0x61));
  assert.deepEqual(sequences, sequences.map((_, index) => index));
  assert.deepEqual(f.ended, { kind: "exit", code: 0 });
  assert.deepEqual(f.errors, []);
});

test("local PTY writes whole raw copied input in order and refuses a whole over-budget write", async (t) => {
  const f = await fixture(t, "echo", { inputBacklog: 16 });
  const chunks: Uint8Array[] = [];
  f.channel.open((bytes) => { chunks.push(bytes); f.channel.ack(bytes.length); });
  await until(() => Buffer.concat(chunks).toString().includes("READY;"), "echo not ready");
  chunks.length = 0;
  const input = Buffer.from("1234567890abcdef");
  assert.equal(f.channel.write(input), "ok"); input.fill(0);
  assert.equal(f.channel.write(Buffer.from("NO-PREFIX")), "busy");
  await until(() => Buffer.concat(chunks).length >= 16, "input did not echo");
  assert.equal(Buffer.concat(chunks).toString(), "1234567890abcdef");
  assert.equal(f.channel.write(Buffer.from("ไทย")), "ok");
  await until(() => Buffer.concat(chunks).length >= 25, "UTF8 did not echo");
  assert.equal(Buffer.concat(chunks).toString(), "1234567890abcdefไทย");
  f.channel.dispose(); f.channel.dispose();
  assert.equal(f.channel.write(Buffer.from("later")), "closed");
  await f.channel.drained;
  assert.deepEqual(f.errors, []);
});

test("local PTY resize reaches the native terminal and disposal stops foreground/background owned descendants", async (t) => {
  const sized = await fixture(t, "size");
  let output = "";
  sized.channel.open((bytes) => { output += Buffer.from(bytes).toString(); sized.channel.ack(bytes.length); });
  await until(() => output.includes("SIZE:80:24;"), "initial native size absent");
  sized.channel.resize(103, 37);
  await until(() => output.includes("SIZE:103:37;"), "native resize absent");
  const children = await fixture(t, "children");
  let ready = false;
  children.channel.open((bytes) => { ready ||= Buffer.from(bytes).toString().includes("CHILDREN;"); children.channel.ack(bytes.length); });
  await until(() => ready, "children not ready");
  const ids = JSON.parse(await readFile(join(children.home, "children.json"), "utf8")) as { root: number; child: number };
  children.channel.dispose();
  await children.channel.drained;
  await Promise.all([ids.root, ids.child].map(assertGone));
  assert.deepEqual(children.errors, []);
});

test("local PTY guardian cleans fast natural zsh exit with disowned background group and grandchild", async (t) => {
  const f = await fixture(t, "unused", { shell: "/bin/zsh", args: ["-f", "-i"] });
  let output = "";
  f.channel.open((bytes) => { output += Buffer.from(bytes).toString(); f.channel.ack(bytes.length); });
  await until(() => /[%#] /.test(output), "isolated zsh prompt not ready");
  const idsFile = join(f.home, "pids");
  const grandFile = join(f.home, "grandchild");
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const commands = join(f.home, "owned-command.zsh");
  await writeFile(commands, `unset HISTFILE\nunsetopt CHECK_JOBS\ntrap '' HUP\n(trap '' HUP TERM; /bin/sleep 600 & printf '%s' "$!" > ${quote(grandFile)}; wait) &\nchild=$!\nwhile [[ ! -s ${quote(grandFile)} ]]; do /bin/sleep 0.01; done\nprintf '%s %s' "$$" "$child" > ${quote(idsFile)}\ndisown\nexit 7\n`, { mode: 0o600 });
  assert.equal(f.channel.write(Buffer.from(`source ${quote(commands)}\r`)), "ok");
  await until(() => f.ended !== undefined, "fast natural shell did not finish");
  assert.deepEqual(f.ended, { kind: "exit", code: 7 });
  const ids = (await readFile(idsFile, "utf8")).trim().split(" ").map(Number);
  const grandchild = Number(await readFile(grandFile, "utf8"));
  assert.equal(ids.length, 2); assert(ids.every((pid) => pid > 1)); assert(grandchild > 1);
  await Promise.all([...ids, grandchild].map(assertGone));
  assert.deepEqual(f.errors, []);
});

test("local PTY default login zsh runs interactively in an isolated home and reports its exit", async (t) => {
  const f = await fixture(t, "unused", { shell: undefined, args: undefined });
  assert.deepEqual(f.metadata, { shell: "/bin/zsh", platform: "darwin" });
  let output = "";
  f.channel.open((bytes) => { output += Buffer.from(bytes).toString(); f.channel.ack(bytes.length); });
  assert.equal(f.channel.write(Buffer.from("printf 'LOGIN-%s\\n' $((5*7)); exit 9\r")), "ok");
  await until(() => f.ended !== undefined, "default login shell did not finish");
  assert(output.includes("LOGIN-35"));
  assert.deepEqual(f.ended, { kind: "exit", code: 9 });
  assert.deepEqual(f.errors, []);
});

test("local PTY unsupported native shape cleans the already-spawned owned guardian tree", async (t) => {
  let pid = 0;
  const actual = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  const f = await fixture(t, "echo", {
    loadPty: () => ({ spawn(file, args, options) {
      const terminal = actual.spawn(file, args, options);
      pid = terminal.pid;
      Object.defineProperty(terminal, "_pty", { value: "unsupported-native-shape" });
      return terminal;
    } }),
  });
  assert.deepEqual(f.errors, ["local-spawn-failed"]);
  assert(pid > 1); await assertGone(pid);
});

test("local PTY status metadata rejects oversized, non-ASCII, symlink and FIFO replacements without hanging or reading contents", async (t) => {
  const actual = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
  for (const kind of ["oversized", "non-ASCII", "symlink", "fifo"] as const) {
    let statusFile = "", pid = 0;
    const f = await fixture(t, "echo", {
      loadPty: () => ({ spawn(file, args, options) {
        assert(Array.isArray(args)); statusFile = args[3]!;
        const terminal = actual.spawn(file, args, options); pid = terminal.pid; return terminal;
      } }),
    });
    if (kind === "oversized") await writeFile(statusFile, Buffer.alloc(1_048_576, 0x31));
    else if (kind === "non-ASCII") await writeFile(statusFile, Buffer.from([0xb1]));
    else {
      await rm(statusFile);
      if (kind === "symlink") {
        const target = join(f.home, "owned-status-target"); await writeFile(target, "0"); await symlink(target, statusFile);
      } else await exec("/usr/bin/mkfifo", [statusFile]);
    }
    await until(() => f.errors.length > 0, `${kind} status was not rejected`);
    assert.deepEqual(f.errors, ["local-spawn-failed"]);
    await f.channel.drained; await assertGone(pid);
  }
});

test("local PTY cancellation waits for actual in-flight native input before releasing the owned descriptor", async (t) => {
  const f = await fixture(t, "echo", { inputBacklog: 2_097_152 });
  let ready = false;
  f.channel.open((bytes) => { ready ||= Buffer.from(bytes).toString().includes("READY;"); f.channel.ack(bytes.length); });
  await until(() => ready, "in-flight fixture not ready");
  assert.equal(f.channel.write(Buffer.alloc(2_097_152, 0x61)), "ok");
  f.channel.dispose();
  assert.equal(f.channel.write(Buffer.from("later")), "closed");
  await f.channel.drained;
  assert.equal(f.ended, undefined);
  assert.deepEqual(f.errors, []);
});

test("local PTY disposal drains unread output so exiting owned processes are not stuck closing the terminal", async (t) => {
  // An unacknowledged window pauses reading; the echoed input then sits in the PTY output queue. macOS blocks an
  // exiting process in the tty close until that queue drains (ps state E), so cleanup could never be confirmed.
  const f = await fixture(t, "echo", { outputWindow: 1 });
  let ready = false;
  f.channel.open((bytes) => { ready ||= Buffer.from(bytes).toString().includes("R"); });
  await until(() => ready, "echo not ready");
  for (let i = 0; i < 8; i++) assert.equal(f.channel.write(Buffer.alloc(512, 0x62)), "ok");
  await delay(300);
  f.channel.dispose();
  const settled = await Promise.race([f.channel.drained.then(() => "drained"), delay(20_000).then(() => "pending")]);
  assert.equal(settled, "drained", "owned cleanup was not confirmed");
  assert.deepEqual(f.errors, []);
});
