"use strict";

// Test-only runtime evidence for local forwarding through the shipped saved-host composition (out/main/ssh.js).
// Returns content-free receipts (booleans, counts, codes, milliseconds). The fixture's sshd permits forwarding
// only to 127.0.0.1:8080, where a container-local HTTP server answers `ssterm-fixture-ok`.
const http = require("node:http");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { startFixture, portIsOpen } = require("../../../spikes/ssh-compat/src/fixture.cjs");
const { startTerminalFixture } = require("../terminal/ssh.cjs");

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}
/** One bounded GET through the tunnel: status and whether the body is the fixture's marker. */
function get(port) {
  return new Promise((done) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/", agent: false, timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body = (body + chunk).slice(0, 16_384); });
      response.on("end", () => done({ status: response.statusCode, fixtureBody: body === "ssterm-fixture-ok\n" }));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => done({ status: 0, fixtureBody: false }));
  });
}

async function runTunnelRuntime(production, options) {
  const lab = await startFixture();
  const receipt = {};
  let terminal, service;
  try {
    terminal = await startTerminalFixture(production, {
      owner: options.owner, label: "อุโมงค์ทดสอบ", tempDirectory: options.tempDirectory, send: () => {}, power: options.power, lab,
    });
    const { registry, repository, hostId, ownerId } = terminal;
    const until = async (read, expected, limit = 20_000) => {
      const since = performance.now();
      for (;;) {
        if ((await read()) === expected) return Math.round(performance.now() - since);
        if (performance.now() - since > limit) return -1;
        await sleep(25);
      }
    };
    const rule = async (bindPort, destinationPort = 8080) => {
      const id = randomUUID();
      const current = repository.snapshot();
      if (!current.ok) throw new Error("TUNNEL_FIXTURE_SNAPSHOT");
      const saved = repository.commit({ expectedCatalogRevision: current.value.catalogRevision, changes: [{
        type: "create-tunnel-rule", id,
        data: { label: "Fixture HTTP", hostId, bindPort, destinationHost: "127.0.0.1", destinationPort },
      }] });
      if (!saved.ok) throw new Error(`TUNNEL_FIXTURE_RULE_${saved.error.code}`);
      return { id, bindPort };
    };
    const make = () => new production.TunnelService({ registry, repository, listen: production.listenLocal });
    service = make();
    const tunnelSessions = () => registry.snapshot(ownerId).filter((row) => row.kind === "tunnel").length;
    const state = (svc, id) => {
      const row = svc.snapshot(ownerId).find((value) => value.ruleId === id);
      return row ? `${row.state}/${row.error ?? "-"}` : "none";
    };

    // 1. Saving a rule starts nothing; the default bind is loopback.
    const http1 = await rule(await freePort());
    const stored = repository.snapshot().value.tunnelRules.find((row) => row.id === http1.id);
    receipt.defaultBind = `${stored.type}/${stored.bindAddress}`;
    receipt.listenerAfterSave = await portIsOpen(http1.bindPort);
    receipt.sessionsAfterSave = tunnelSessions();

    // 2. Start: starting until SSH is Ready, then HTTP over the tunnel.
    const started = await service.start(ownerId, http1.id);
    receipt.startState = started.ok ? started.value.state : started.code;
    receipt.runningMs = await until(() => state(service, http1.id), "running/-");
    receipt.http = await get(http1.bindPort);
    receipt.httpAgain = await get(http1.bindPort);
    receipt.counters = (({ totalConnections, failedConnections }) => ({ totalConnections, failedConnections }))(service.snapshot(ownerId)[0]);
    receipt.fenceKind = registry.terminal(ownerId, registry.snapshot(ownerId).find((row) => row.kind === "tunnel").id, 1) === undefined;

    // 3. Port collision: typed, before any SSH session; the running tunnel is unaffected.
    const clash = await rule(http1.bindPort);
    const sessionsBefore = tunnelSessions();
    const collided = await service.start(ownerId, clash.id);
    receipt.collision = collided.ok ? "started" : collided.code;
    receipt.collisionAddedSession = tunnelSessions() !== sessionsBefore;
    receipt.httpAfterCollision = (await get(http1.bindPort)).status;

    // 4. A destination the server refuses closes that local connection only.
    const refusedRule = await rule(await freePort(), 9);
    await service.start(ownerId, refusedRule.id);
    await until(() => state(service, refusedRule.id), "running/-");
    receipt.refusedDestination = (await get(refusedRule.bindPort)).status;
    receipt.refusedCounted = await until(() => service.snapshot(ownerId).find((row) => row.ruleId === refusedRule.id).failedConnections, 1, 5_000) >= 0;
    receipt.refusedStillRunning = state(service, refusedRule.id);
    await service.stop(ownerId, refusedRule.id);

    // 5. Stop with an open local connection: listener gone, socket closed, session forgotten.
    const held = net.connect({ host: "127.0.0.1", port: http1.bindPort });
    held.on("error", () => undefined);
    const heldClosed = new Promise((done) => held.once("close", () => done(true)));
    held.write("GET / HTTP/1.1\r\nHost: fixture\r\n");
    receipt.heldActive = await until(() => service.snapshot(ownerId).find((row) => row.ruleId === http1.id).activeConnections, 1, 5_000) >= 0;
    const stopped = await service.stop(ownerId, http1.id);
    receipt.stop = stopped.ok;
    receipt.heldClosed = await Promise.race([heldClosed, sleep(2_000).then(() => false)]);
    receipt.listenerAfterStop = await portIsOpen(http1.bindPort);
    receipt.sessionsAfterStop = tunnelSessions();

    // 6. Lock: the tunnel fails as locked and its listener closes; a start while locked is refused.
    await service.start(ownerId, http1.id);
    await until(() => state(service, http1.id), "running/-");
    options.power.emit("lock-screen");
    receipt.lockedState = await until(() => state(service, http1.id), "failed/locked", 5_000) >= 0 ? "failed/locked" : state(service, http1.id);
    receipt.listenerAfterLock = await portIsOpen(http1.bindPort);
    const whileLocked = await service.start(ownerId, http1.id);
    receipt.startWhileLocked = whileLocked.ok ? "started" : whileLocked.code;
    receipt.listenerAfterLockedStart = await portIsOpen(http1.bindPort);
    receipt.unlocked = await registry.unlock(async () => true);

    // 7. Quit path: dispose closes a running tunnel's listener.
    await service.start(ownerId, http1.id);
    await until(() => state(service, http1.id), "running/-");
    await service.dispose();
    receipt.listenerAfterDispose = await portIsOpen(http1.bindPort);
    receipt.sessionsAfterDispose = tunnelSessions();

    // 8. Transport loss: stopping the server fails the tunnel and closes its listener.
    service = make();
    await service.start(ownerId, http1.id);
    await until(() => state(service, http1.id), "running/-");
    receipt.httpBeforeLoss = (await get(http1.bindPort)).status;
    await terminal.stop();
    receipt.lossFailedMs = await until(() => service.snapshot(ownerId)[0]?.state, "failed", 60_000);
    receipt.lossError = service.snapshot(ownerId)[0]?.error;
    receipt.listenerAfterLoss = await portIsOpen(http1.bindPort);
  } finally {
    let failed = false;
    try { await service?.dispose(); } catch { failed = true; }
    try { receipt.cleanup = await terminal?.cleanup(); } catch { failed = true; }
    lab.privateKey.fill(0);
    try { await lab.dispose(); await lab.assertCleaned(); } catch { failed = true; }
    receipt.labCleaned = !failed;
  }
  return receipt;
}

module.exports = { runTunnelRuntime };
