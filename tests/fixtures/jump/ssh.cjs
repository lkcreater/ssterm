"use strict";

// SST-030 test-only lab: three owned OpenSSH containers (bastion, inner, target) on a private Docker network. Only
// the bastion's published loopback port is used by the chain; its inner hops use Docker names (PermitOpen, set per run).
// The receipt is content-free: states, codes, labels and booleans. Each container has its own generated password.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID, randomBytes } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");
const runFile = promisify(execFile);

const docker = async (args) => (await runFile("docker", args, { timeout: 30_000 })).stdout.trim();
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function banner(port) {
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { socket.destroy(); done(false); }, 1_000);
    socket.once("data", (chunk) => { clearTimeout(timer); socket.destroy(); done(String(chunk).startsWith("SSH-")); });
    socket.once("error", () => { clearTimeout(timer); done(false); });
  });
}
/** Rewrites PermitOpen on a running lab and reloads sshd (SIGHUP re-executes it with the new configuration). */
async function permitOpen(lab, destinations) {
  await docker(["exec", lab.container, "sed", "-i", `s/^PermitOpen .*/PermitOpen ${destinations}/`, "/etc/ssh/sshd_config"]);
  await docker(["kill", "--signal", "HUP", lab.container]);
  await sleep(300);
  for (let i = 0; i < 50 && !(await banner(lab.port)); i += 1) await sleep(100);
}

async function startJumpLab() {
  const network = `ssterm-jump-${randomBytes(6).toString("hex")}`;
  await docker(["network", "create", "--label", "dev.ssterm.spike.fixture=true", network]);
  const labs = {};
  try {
    for (const name of ["bastion", "inner", "target"]) labs[name] = await startFixture();
    // `blocked` is another name for the target that no jump host may open.
    await docker(["network", "connect", "--alias", "inner", network, labs.inner.container]);
    await docker(["network", "connect", "--alias", "target", "--alias", "blocked", network, labs.target.container]);
    await docker(["network", "connect", "--alias", "bastion", network, labs.bastion.container]);
    await permitOpen(labs.bastion, "inner:22 target:22");
    await permitOpen(labs.inner, "target:22");
    // A marker that only the target has, so a session can prove where it landed.
    await docker(["exec", labs.target.container, "sh", "-c", "touch /home/fixture/ssterm-jump-target && chown fixture /home/fixture/ssterm-jump-target"]);
  } catch (error) {
    await stopJumpLab({ network, labs }).catch(() => undefined);
    throw error;
  }
  return { network, labs };
}
async function stopJumpLab(lab) {
  let failed = false;
  for (const fixture of Object.values(lab.labs)) {
    try { fixture.privateKey.fill(0); await fixture.dispose(); await fixture.assertCleaned(); } catch { failed = true; }
  }
  try { await docker(["network", "rm", lab.network]); } catch { failed = true; }
  if (failed) throw new Error("JUMP_LAB_CLEANUP_FAILED");
}

async function runJumpRuntime(production, options) {
  const directory = fs.mkdtempSync(path.join(options.tempDirectory, "ssterm-jump-runtime-"));
  const namespace = `dev.ssterm.test.${randomUUID()}`;
  const transient = new production.TransientSecrets();
  const ownerId = production.sessionOwnerId(options.owner);
  const receipt = {};
  let lab, repository, runtime;
  const value = (result) => {
    if (!result.ok) throw new Error(`JUMP_FIXTURE_${result.error?.code || "FAILED"}`);
    return result.value;
  };
  try {
    lab = await startJumpLab();
    const { bastion, inner, target } = lab.labs;
    repository = value(await production.openMetadata({ path: path.join(directory, "catalog.sqlite") }));
    const provider = new production.KeychainSecretProvider(namespace);
    const service = new production.SecretService({ repository, provider, transient });
    const catalog = new production.CatalogModule({ repository });
    const perform = (intent) => value(catalog.apply(value(catalog.prepare(intent)).token));
    const identity = async (label, username, secret) => {
      const id = randomUUID();
      const bytes = Buffer.from(secret);
      try {
        const published = await service.storeSecret({
          kind: "password", owner: { type: "identity", id, expectedRevision: null }, value: bytes,
          publish: (ref) => [{ type: "create-identity", id, data: { label, username, method: "password", passwordRef: ref } }],
        });
        if (published.status !== "published") throw new Error("JUMP_FIXTURE_SECRET");
      } finally { bytes.fill(0); }
      return id;
    };
    const host = (label, address, port, identityId, extra = {}) => perform({ type: "create-host", data: {
      label, address, port: { mode: "value", port }, auth: { mode: "value", identityId }, ...extra,
    } }).createdIds[0];
    const ids = {
      bastion: await identity("Bastion identity", bastion.username, bastion.password),
      inner: await identity("Inner identity", inner.username, inner.password),
      target: await identity("Target identity", target.username, target.password),
      wrong: await identity("Wrong identity", bastion.username, `${bastion.password}-wrong`),
    };
    const hosts = {};
    hosts.bastion = host("Bastion", bastion.host, bastion.port, ids.bastion);
    hosts.inner = host("Inner", "inner", 22, ids.inner, { jumpHostId: hosts.bastion });
    hosts.oneHop = host("Target via bastion", "target", 22, ids.target, { jumpHostId: hosts.bastion, environment: "PROD" });
    hosts.twoHops = host("Target via inner", "target", 22, ids.target, { jumpHostId: hosts.inner });
    hosts.badBastion = host("Bastion (wrong password)", bastion.host, bastion.port, ids.wrong);
    hosts.viaBad = host("Target via bad bastion", "target", 22, ids.target, { jumpHostId: hosts.badBastion });
    hosts.blocked = host("Blocked target", "blocked", 22, ids.target, { jumpHostId: hosts.bastion });

    runtime = production.createSavedHostSessions({ repository, provider, transient, power: new (require("node:events").EventEmitter)() });
    const registry = runtime.registry;
    const prompts = [];
    registry.subscribe(ownerId, (snapshot) => {
      const prompt = snapshot.prompt;
      if (prompt?.kind !== "host-trust") return;
      prompts.push(`${prompt.hop ? prompt.hop.label : "target"}@${prompt.endpointHost}:${prompt.endpointPort}`);
      queueMicrotask(() => registry.answerPrompt(ownerId, snapshot.id, snapshot.generation, prompt.id, { kind: "host-trust", decision: "remember" }));
    });
    const outcome = async (hostId, kind = "sftp") => {
      const started = value(registry.connect(ownerId, hostId, kind));
      const since = performance.now();
      for (;;) {
        const row = registry.snapshot(ownerId).find((item) => item.id === started.id);
        if (row && ["Ready", "Failed", "Closed"].includes(row.state)) return row;
        if (performance.now() - since > 60_000) return { ...row, state: "timeout" };
        await sleep(25);
      }
    };
    /** Ready over SFTP, landed on the target (its marker is listed), then closed with cleanup complete. */
    const reach = async (hostId) => {
      const row = await outcome(hostId);
      if (row.state !== "Ready") return `${row.state}/${row.error?.code ?? "-"}`;
      const sftp = registry.sftp(ownerId, row.id, row.generation);
      const listed = sftp ? await sftp.list(sftp.home) : { ok: false };
      const landed = listed.ok && listed.value.entries.some((entry) => entry.name === "ssterm-jump-target");
      await registry.close(ownerId, row.id, row.generation);
      await registry.settled(ownerId, row.id, row.generation);
      const cleanup = registry.snapshot(ownerId).find((item) => item.id === row.id)?.cleanup;
      registry.forget(ownerId, row.id, row.generation);
      return `Ready/${landed ? "target" : "elsewhere"}/${cleanup}`;
    };
    const failed = async (hostId) => {
      const row = await outcome(hostId);
      await registry.settled(ownerId, row.id, row.generation).catch(() => undefined);
      const cleanup = registry.snapshot(ownerId).find((item) => item.id === row.id)?.cleanup;
      registry.forget(ownerId, row.id, row.generation);
      return `${row.state}/${row.error?.code ?? "-"}/${cleanup}`;
    };

    receipt.oneHop = await reach(hosts.oneHop);
    receipt.oneHopPrompts = prompts.splice(0);
    receipt.twoHops = await reach(hosts.twoHops);
    // Bastion and target were remembered above; only the new inner hop asks.
    receipt.twoHopsPrompts = prompts.splice(0);
    receipt.viaBad = await failed(hosts.viaBad);
    receipt.blocked = await failed(hosts.blocked);
    receipt.knownHosts = repository.snapshot().value.knownHosts.map((row) => `${row.endpointHost}:${row.endpointPort}`).sort();
    // A terminal through two hops reaches Ready too.
    const terminal = await outcome(hosts.twoHops, "terminal");
    receipt.terminalTwoHops = terminal.state;
    await registry.close(ownerId, terminal.id, terminal.generation);
    receipt.sessionsLeft = registry.snapshot(ownerId).filter((row) => !["Closed", "Failed"].includes(row.state)).length;
  } finally {
    let failedCleanup = false;
    const clean = async (action) => { try { await action(); } catch { failedCleanup = true; } };
    await clean(() => runtime?.shutdown());
    await clean(() => transient.purgeAll());
    await clean(() => repository?.close());
    await clean(async () => { receipt.leftoverItems = await production.clearTestNamespace(namespace); });
    if (lab) await clean(() => stopJumpLab(lab));
    await clean(() => fs.rmSync(directory, { recursive: true, force: true }));
    receipt.labCleaned = !failedCleanup;
  }
  return receipt;
}

module.exports = { runJumpRuntime, startJumpLab, stopJumpLab };
