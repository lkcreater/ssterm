"use strict";

// Test-only runtime evidence for SFTP sessions through the shipped saved-host composition (out/main/ssh.js).
// Returns content-free receipts (booleans, counts, codes, milliseconds); file bytes and names stay here.
const { createHash, randomBytes } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");
const { startTerminalFixture } = require("../terminal/ssh.cjs");
const runFile = promisify(execFile);

const ROOT = "/home/fixture/sftp";
const THAI = "ไฟล์ทดสอบ.txt";
const EMOJI = "emoji-🚀.txt";
// Seeded as the fixture user, so the chmod-000 directory really refuses it. Names are bytes, so non-UTF-8 is possible.
const SEED = String.raw`
import os
r = b"/home/fixture/sftp"
d = r + b"/dir"
os.makedirs(d)
for name in ["${THAI}", "${EMOJI}"]:
    open(os.path.join(d, name.encode()), "w").write("x")
open(d + b"/bad-\xff\xfe.bin", "wb").write(b"x")
os.symlink(r + b"/dir", d + b"/to-dir")
os.symlink(r + b"/missing", d + b"/dangling")
os.symlink(b"loop", d + b"/loop")
os.makedirs(r + b"/locked")
os.chmod(r + b"/locked", 0)
for count in (10000, 10050):
    target = r + b"/k%d" % count
    os.makedirs(target)
    for i in range(count):
        open(target + b"/f%05d" % i, "wb").close()
open(r + b"/existing.txt", "w").write("keep")
open(r + b"/big.bin", "wb").write(os.urandom(4 * 1024 * 1024))
`;
// Open server descriptors under the test tree (file and directory handles of every sftp-server process).
const HANDLES = String.raw`
import os
n = 0
for p in filter(str.isdigit, os.listdir("/proc")):
    try:
        for f in os.listdir("/proc/%s/fd" % p):
            try:
                n += os.readlink("/proc/%s/fd/%s" % (p, f)).startswith("/home/fixture/sftp")
            except OSError:
                pass
    except OSError:
        pass
print(n)
`;

async function docker(args) {
  try { return (await runFile("docker", args, { timeout: 60_000 })).stdout; }
  catch (error) {
    // `pgrep -c` exits 1 when it counts zero.
    if (args.includes("pgrep") && error.code === 1) return error.stdout;
    throw new Error("SFTP_FIXTURE_DOCKER_FAILED");
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const code = (result) => (result.ok ? "ok" : result.code);

/**
 * One owned Docker lab, one saved host (password in a fresh dev.ssterm.test namespace), a terminal session and
 * an SFTP session on it. `power` is Electron's powerMonitor, so the lock scenario uses the real event path.
 */
async function runSftpRuntime(production, options) {
  const lab = await startFixture();
  const receipt = {};
  let terminal;
  try {
    const exec = (...args) => docker(["exec", "-u", "fixture", lab.container, ...args]);
    const python = async (script) => (await exec("python3", "-c", script)).trim();
    // sshd makes its session processes non-dumpable: reading their descriptors needs ptrace rights (privileged exec).
    const serverHandles = async () => Number((await docker(["exec", "--privileged", lab.container, "python3", "-c", HANDLES])).trim());
    const count = async (pattern) => Number((await docker(["exec", lab.container, "pgrep", "-c", "-f", pattern])).trim());
    // internal-sftp runs as `sshd: fixture@internal-sftp` beside its connection's `sshd: fixture@notty`.
    const sftpProcesses = async () => (await count("sshd: fixture@internal-sftp")) + (await count("sshd: fixture@notty"));
    const until = async (read, expected, limit = 2_000) => {
      const since = performance.now();
      for (;;) {
        if ((await read()) === expected) return Math.round(performance.now() - since);
        if (performance.now() - since > limit) return -1;
        await sleep(20);
      }
    };
    let since = performance.now();
    await python(SEED);
    receipt.seedMs = Math.round(performance.now() - since);

    let trustPrompts = 0;
    terminal = await startTerminalFixture(production, {
      owner: options.owner, label: "ระบบไฟล์ทดสอบ", tempDirectory: options.tempDirectory, send: () => {},
      power: options.power, lab,
    });
    const { registry } = terminal;
    const ownerId = production.sessionOwnerId(options.owner);
    registry.subscribe(ownerId, (snapshot) => { if (snapshot.prompt?.kind === "host-trust") trustPrompts += 1; });
    const snapshot = (id) => registry.snapshot(ownerId, id)[0];
    const state = (id) => {
      const current = snapshot(id);
      return current && `${current.state}/${current.cleanup === "pending" ? "cleaning" : current.error?.code ?? "-"}`;
    };
    const settle = async (id, expected, limit = 20_000) => until(() => state(id), expected, limit);

    // Terminal first: it remembers the host key, which the SFTP session then reuses without a prompt.
    const shell = terminal.connect();
    receipt.terminalReadyMs = await settle(shell.id, "Ready/-");
    let output = "";
    const stream = registry.terminal(ownerId, shell.id, shell.generation);
    stream.open((chunk) => { output = (output + Buffer.from(chunk).toString("utf8")).slice(-4096); stream.ack(chunk.byteLength); });
    // The marker is computed remotely, so the echoed command line never satisfies its own check.
    const echo = async (n) => {
      stream.write(Buffer.from(`echo "SFTP-ECHO-$((${n}+1))"\n`));
      return (await until(() => output.includes(`SFTP-ECHO-${n + 1}`), true, 5_000)) >= 0;
    };
    receipt.terminalEchoBefore = await echo(40);

    since = performance.now();
    const first = registry.connect(ownerId, snapshot(shell.id).hostId, "sftp");
    if (!first.ok) throw new Error(`SFTP_FIXTURE_CONNECT_${first.error.code}`);
    const sftpId = first.value.id;
    receipt.sftpKind = first.value.kind;
    receipt.sftpReady = await settle(sftpId, "Ready/-") >= 0;
    receipt.sftpReadyMs = Math.round(performance.now() - since);
    receipt.trustPrompts = trustPrompts;
    receipt.terminalFenceRefusesSftp = registry.terminal(ownerId, sftpId, 1) === undefined;
    receipt.sftpFenceRefusesTerminal = registry.sftp(ownerId, shell.id, shell.generation) === undefined;
    const sftp = registry.sftp(ownerId, sftpId, 1);
    receipt.home = sftp.home;
    receipt.serverSftpProcesses = await count("sshd: fixture@internal-sftp");

    // Directory with Unicode, a non-UTF-8 name and three kinds of symlink.
    const dir = `${ROOT}/dir`;
    const listed = await sftp.list(dir);
    receipt.list = code(listed);
    if (listed.ok) {
      const named = (name) => listed.value.entries.find((entry) => entry.name === name);
      const lossy = listed.value.entries.filter((entry) => !entry.addressable);
      receipt.listCount = listed.value.entries.length;
      receipt.listSkipped = listed.value.skipped;
      receipt.listTruncated = listed.value.truncated;
      receipt.thaiListed = named(THAI)?.type === "file" && named(THAI).addressable;
      receipt.emojiListed = named(EMOJI)?.type === "file" && named(EMOJI).addressable;
      receipt.lossyCount = lossy.length;
      receipt.lossyStat = lossy[0] ? code(await sftp.stat(`${dir}/${lossy[0].name}`)) : "missing";
      receipt.symlinkTypes = ["to-dir", "dangling", "loop"].map((name) => named(name)?.type ?? "missing");
    }
    const thai = await sftp.stat(`${dir}/${THAI}`);
    receipt.thaiStat = thai.ok ? `${thai.value.type}:${thai.value.size}` : thai.code;
    const emoji = await sftp.stat(`${dir}/${EMOJI}`);
    receipt.emojiStat = emoji.ok ? `${emoji.value.type}:${emoji.value.size}` : emoji.code;
    const toDir = await sftp.stat(`${dir}/to-dir`);
    receipt.toDirStat = toDir.ok ? toDir.value.type : toDir.code;
    const toDirLstat = await sftp.lstat(`${dir}/to-dir`);
    receipt.toDirLstat = toDirLstat.ok ? toDirLstat.value.type : toDirLstat.code;
    receipt.danglingStat = code(await sftp.stat(`${dir}/dangling`));
    receipt.loopStat = code(await sftp.stat(`${dir}/loop`));
    const loopLstat = await sftp.lstat(`${dir}/loop`);
    receipt.loopLstat = loopLstat.ok ? loopLstat.value.type : loopLstat.code;
    receipt.relativeRealpath = code(await sftp.realpath("."));
    const home = await sftp.realpath("/home/fixture/sftp/dir/../dir/to-dir");
    receipt.realpathFollows = home.ok && home.value === dir;
    receipt.lockedList = code(await sftp.list(`${ROOT}/locked`));

    // Large directories: exactly the cap, and past it.
    for (const size of [10000, 10050]) {
      since = performance.now();
      const result = await sftp.list(`${ROOT}/k${size}`);
      receipt[`k${size}`] = result.ok
        ? { entries: result.value.entries.length, truncated: result.value.truncated, skipped: result.value.skipped,
          ms: Math.round(performance.now() - since) }
        : result.code;
    }

    // Exclusive create: an existing destination is refused; a new one round-trips its bytes.
    receipt.existingCreate = code(await sftp.openWrite(`${ROOT}/existing.txt`, { mode: 0o600 }));
    receipt.existingKept = (await exec("cat", `${ROOT}/existing.txt`)) === "keep";
    const data = randomBytes(300_000);
    const created = await sftp.openWrite(`${ROOT}/created.bin`, { mode: 0o600 });
    receipt.create = code(created);
    if (created.ok) {
      const writes = [];
      for (let at = 0; at < data.length; at += 32_768) writes.push(code(await created.value.write(at, data.subarray(at, at + 32_768))));
      receipt.writes = writes.every((result) => result === "ok") ? writes.length : writes.find((result) => result !== "ok");
      receipt.writeClose = code(await created.value.close());
      receipt.writeCloseAgain = code(await created.value.close());
      receipt.writeAfterClose = code(await created.value.write(0, data.subarray(0, 1)));
    }
    const createdStat = await sftp.stat(`${ROOT}/created.bin`);
    receipt.createdStat = createdStat.ok ? `${createdStat.value.size}:${createdStat.value.permissions?.toString(8)}` : createdStat.code;
    const readAll = async (path, chunk = 65_536) => {
      const reader = await sftp.openRead(path);
      if (!reader.ok) return reader.code;
      const parts = [];
      for (let at = 0; ;) {
        const part = await reader.value.read(at, chunk);
        if (!part.ok) { await reader.value.close(); return part.code; }
        if (part.value === null) break;
        parts.push(Buffer.from(part.value));
        at += part.value.byteLength;
      }
      await reader.value.close();
      return Buffer.concat(parts);
    };
    const readBack = await readAll(`${ROOT}/created.bin`);
    receipt.readBackEqual = Buffer.isBuffer(readBack) && readBack.equals(data);
    receipt.serverHashEqual = (await exec("sha256sum", `${ROOT}/created.bin`)).split(" ")[0] === sha(data);

    // Abort a read in the middle of a file, then an open; the session and the same reader keep working.
    const big = await sftp.openRead(`${ROOT}/big.bin`);
    receipt.bigOpen = code(big);
    if (big.ok) {
      const parts = [];
      receipt.serverHandlesWhileOpen = await serverHandles();
      for (let at = 0; at < 131_072; at += 65_536) parts.push(Buffer.from((await big.value.read(at, 65_536)).value));
      const abort = new AbortController();
      const pending = big.value.read(131_072, 65_536, abort.signal);
      since = performance.now();
      abort.abort();
      const aborted = await pending;
      receipt.abortedRead = code(aborted);
      receipt.abortSettleMs = Math.round(performance.now() - since);
      for (let at = 131_072; ;) {
        const part = await big.value.read(at, 65_536);
        if (!part.ok) { receipt.readAfterAbort = part.code; break; }
        if (part.value === null) { receipt.readAfterAbort = "ok"; break; }
        parts.push(Buffer.from(part.value));
        at += part.value.byteLength;
      }
      receipt.bigHashEqual = (await exec("sha256sum", `${ROOT}/big.bin`)).split(" ")[0] === sha(Buffer.concat(parts));
      receipt.bigClose = code(await big.value.close());
    }
    const openAbort = new AbortController();
    const opening = sftp.openRead(`${ROOT}/big.bin`, openAbort.signal);
    openAbort.abort();
    receipt.abortedOpen = code(await opening);
    receipt.statAfterAbort = code(await sftp.stat(`${ROOT}/big.bin`));
    // The late HANDLE of the aborted open is closed, so no server descriptor stays open under the test tree.
    receipt.serverHandlesZeroMs = await until(serverHandles, 0);

    // Closing SFTP leaves the terminal on the same host Ready, and the server reaps the SFTP processes.
    since = performance.now();
    const closed = await registry.close(ownerId, sftpId);
    receipt.closeMs = Math.round(performance.now() - since);
    receipt.close = closed.ok ? state(sftpId) : closed.error.code;
    receipt.opAfterClose = code(await sftp.stat(ROOT));
    receipt.fenceAfterClose = registry.sftp(ownerId, sftpId, 1) === undefined;
    receipt.sftpProcessesGoneMs = await until(sftpProcesses, 0);
    receipt.terminalAfterClose = state(shell.id);
    receipt.terminalEchoAfter = await echo(41);
    receipt.terminalProcesses = await count("sshd: fixture@pts/");

    // Reconnect keeps the kind; a lock closes both sessions; after unlock, Reconnect is still SFTP.
    const second = registry.reconnect(ownerId, sftpId);
    receipt.reconnectKind = second.ok ? second.value.kind : second.error.code;
    receipt.reconnectReady = await settle(sftpId, "Ready/-") >= 0;
    const resumed = registry.sftp(ownerId, sftpId, 2);
    receipt.reconnectList = resumed ? code(await resumed.list(resumed.home)) : "missing";
    options.power.emit("lock-screen");
    receipt.opAfterLock = resumed ? code(await resumed.stat(resumed.home)) : "missing";
    receipt.lockedSftp = await settle(sftpId, "Closed/locked", 5_000) >= 0 ? "Closed/locked" : state(sftpId);
    receipt.lockedTerminal = await settle(shell.id, "Closed/locked", 5_000) >= 0 ? "Closed/locked" : state(shell.id);
    receipt.lockedProcessesGoneMs = await until(async () => (await sftpProcesses()) + (await count("sshd: fixture@pts/")), 0);
    receipt.reconnectWhileLocked = (() => { const result = registry.reconnect(ownerId, sftpId); return result.ok ? "ok" : result.error.code; })();
    receipt.unlocked = await registry.unlock(async () => true);
    const third = registry.reconnect(ownerId, sftpId);
    receipt.unlockReconnectKind = third.ok ? third.value.kind : third.error.code;
    receipt.unlockReconnectReady = await settle(sftpId, "Ready/-") >= 0;
    receipt.trustPromptsTotal = trustPrompts;
    await registry.close(ownerId, sftpId);
    receipt.finalProcessesGoneMs = await until(sftpProcesses, 0);
  } finally {
    let failed = false;
    try { receipt.cleanup = await terminal?.cleanup(); } catch { failed = true; }
    lab.privateKey.fill(0);
    try { await lab.dispose(); await lab.assertCleaned(); } catch { failed = true; }
    receipt.labCleaned = !failed;
  }
  return receipt;
}

module.exports = { runSftpRuntime };
