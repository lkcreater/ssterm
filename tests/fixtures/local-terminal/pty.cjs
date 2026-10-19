/* Owned startup-free local PTYs using the shipped adapter/controller. Never the user's home or environment. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

async function startLocalTerminalFixture(production, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssterm-local-pty-"));
  fs.chmodSync(directory, 0o700);
  const transient = new production.TransientSecrets();
  const runtime = production.createDesktopSessions({
    resolve: () => { throw new Error("LOCAL_FIXTURE_MUST_NOT_RESOLVE_HOST"); },
    transient,
    power: options.power,
    localAdapter: production.createLocalPtyAdapter({
      shell: "/bin/bash", args: ["--noprofile", "--norc", "-i"], home: directory, cwd: directory,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    }),
  });
  const { registry } = runtime;
  const ownerId = production.sessionOwnerId(options.owner);
  const receipts = new Map();
  const receipt = (id, generation) => {
    const key = `${id}:${generation}`;
    if (!receipts.has(key)) receipts.set(key, { frames: 0, bytes: 0, consecutive: true, writes: 0, writtenBytes: 0 });
    return receipts.get(key);
  };
  const terminals = production.createTerminalController({ registry, checkAccess: async () => !cleaned });
  const controller = {
    ...terminals,
    register(owner, send) {
      terminals.register(owner, (channel, frame) => {
        if (channel === production.channels.terminalOutput) {
          const entry = receipt(frame.sessionId, frame.generation);
          entry.consecutive &&= frame.sequence === entry.frames;
          entry.frames += 1;
          entry.bytes += frame.bytes.byteLength;
        }
        send(channel, frame);
      });
    },
    writeTerminal(request) {
      const bytes = request.bytes.byteLength;
      const result = terminals.writeTerminal(request);
      if (result.ok) {
        const entry = receipt(request.sessionId, request.generation);
        entry.writes += 1;
        entry.writtenBytes += bytes;
      }
      return result;
    },
  };
  controller.register(options.owner, options.send);
  let cleaned = false;
  const sessions = () => registry.snapshot(ownerId).map((session) => ({
    id: session.id, generation: session.generation, state: session.state, cleanup: session.cleanup,
    hostId: session.hostId, target: session.target ?? null, local: session.local ?? null,
    error: session.error?.code ?? null, end: session.end ?? null,
  }));
  const pids = new Set();
  const collect = () => {
    for (const name of fs.readdirSync(directory).filter((name) => /^owned-[a-z0-9-]+\.pid$/u.test(name))) {
      const text = fs.readFileSync(path.join(directory, name), "utf8").trim();
      if (/^[1-9]\d*$/u.test(text)) pids.add(Number(text));
    }
    return [...pids];
  };
  const alive = () => collect().filter((pid) => {
    const status = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    if (status.error || (status.status !== 0 && status.status !== 1)) throw new Error("LOCAL_FIXTURE_PROCESS_CHECK_FAILED");
    return status.status === 0 && status.stdout.trim() !== "" && !status.stdout.trim().startsWith("Z");
  });
  return {
    controller, runtime, registry, sessions,
    alive,
    frames(id, generation) { return { ...receipt(id, generation) }; },
    replayLines() {
      try { return fs.readFileSync(path.join(directory, "replay"), "utf8").trim().split("\n").filter(Boolean).length; }
      catch (error) { if (error.code === "ENOENT") return 0; throw error; }
    },
    revokeOwner() { controller.revokeOwner(options.owner); runtime.revokeOwner(options.owner); },
    async cleanup() {
      if (cleaned) return { fixtureCleaned: true, remainingProcesses: 0 };
      collect();
      await controller.dispose();
      await runtime.shutdown();
      transient.purgeAll();
      const remaining = alive();
      // Preserve cleanup evidence before the runner removes the isolated home. A failed assertion must
      // still terminate only PIDs explicitly written by this fixture's shells, never an unowned process.
      if (remaining.length) {
        for (const pid of remaining) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
        throw new Error("LOCAL_FIXTURE_PROCESS_LEAK");
      }
      fs.rmSync(directory, { recursive: true, force: true });
      cleaned = true;
      return { fixtureCleaned: true, remainingProcesses: 0 };
    },
  };
}
module.exports = { startLocalTerminalFixture };
