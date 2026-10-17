"use strict";

// Test-only runtime evidence for local forwarding through the shipped saved-host composition (out/main/ssh.js).
// Returns content-free receipts (booleans, counts, codes, milliseconds). The fixture's sshd permits forwarding
// only to 127.0.0.1:8080, where a container-local HTTP server answers `ssterm-fixture-ok`.
const http = require("node:http");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
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

/** SOCKS5 CONNECT (IPv4 or domain), then one HTTP GET over it: the reply code and whether the body is the marker. */
function socksGet(port, host, targetPort, asDomain = false) {
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let stage = 0;
    const finish = (value) => { socket.destroy(); done(value); };
    const timer = setTimeout(() => finish({ reply: -1, status: 0, fixtureBody: false }), 8_000);
    socket.on("error", () => undefined);
    socket.on("close", () => { clearTimeout(timer); finish(result()); });
    const result = () => {
      const reply = buffer.length >= 4 ? buffer[3] : -1;
      const text = buffer.subarray(12).toString("utf8");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/u.exec(text)?.[1] ?? 0);
      return { reply: stage >= 2 ? reply : -1, status, fixtureBody: text.endsWith("\r\n\r\nssterm-fixture-ok\n") };
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]).subarray(0, 32_768);
      if (stage === 0 && buffer.length >= 2) {
        stage = 1;
        const address = !asDomain && /^\d+\.\d+\.\d+\.\d+$/u.test(host) ? [1, ...host.split(".").map(Number)] : [3, host.length, ...Buffer.from(host)];
        socket.write(Buffer.from([5, 1, 0, ...address, targetPort >> 8, targetPort & 0xff]));
      }
      if (stage === 1 && buffer.length >= 12) {
        stage = 2;
        if (buffer[3] !== 0) return finish(result());
        socket.write("GET / HTTP/1.0\r\nHost: fixture\r\n\r\n");
      }
    });
    socket.write(Buffer.from([5, 1, 0]));
  });
}
/** Runs inside the fixture container: one GET to the server-side listener (the remote rule), body or an error tag. */
function containerGet(container, port) {
  const script = `import urllib.request\ntry:\n print(urllib.request.urlopen('http://127.0.0.1:${Number(port)}/', timeout=5).read().decode(), end='')\nexcept Exception as e:\n print('ERR', type(e).__name__, end='')`;
  return new Promise((done) => execFile("docker", ["exec", container, "python3", "-c", script], { timeout: 20_000 }, (_error, stdout) => done(String(stdout))));
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
    const rule = async (bindPort, destinationPort = 8080, extra = {}) => {
      const id = randomUUID();
      const current = repository.snapshot();
      if (!current.ok) throw new Error("TUNNEL_FIXTURE_SNAPSHOT");
      const saved = repository.commit({ expectedCatalogRevision: current.value.catalogRevision, changes: [{
        type: "create-tunnel-rule", id,
        data: { label: "Fixture HTTP", hostId, bindPort, destinationHost: "127.0.0.1", destinationPort, ...extra },
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

    // 8. Dynamic (SOCKS5): loopback proxy; the server opens each CONNECT (PermitOpen allows only 127.0.0.1:8080).
    service = make();
    const socks = await rule(await freePort(), null, { type: "dynamic", destinationHost: null, destinationPort: null });
    await service.start(ownerId, socks.id);
    receipt.socksRunning = await until(() => state(service, socks.id), "running/-") >= 0;
    receipt.socksIpv4 = await socksGet(socks.bindPort, "127.0.0.1", 8080);
    receipt.socksDomain = await socksGet(socks.bindPort, "127.0.0.1", 8080, true);
    receipt.socksRefused = (await socksGet(socks.bindPort, "127.0.0.1", 9)).reply;
    receipt.socksStillRunning = state(service, socks.id);
    await service.stop(ownerId, socks.id);
    receipt.socksListenerAfterStop = await portIsOpen(socks.bindPort);

    // 9. Remote: the server listens on loopback (assigned port) and this Mac opens the destination.
    const local = http.createServer((_request, response) => response.end("ssterm-remote-ok\n"));
    await new Promise((done) => local.listen(0, "127.0.0.1", done));
    try {
      const remote = await rule(0, local.address().port, { type: "remote" });
      await service.start(ownerId, remote.id);
      receipt.remoteRunning = await until(() => state(service, remote.id), "running/-") >= 0;
      const assigned = service.snapshot(ownerId).find((row) => row.ruleId === remote.id)?.remotePort ?? 0;
      receipt.remoteAssigned = assigned > 0;
      receipt.remoteGet = await containerGet(lab.container, assigned);
      receipt.remoteCounted = service.snapshot(ownerId).find((row) => row.ruleId === remote.id)?.totalConnections;
      await service.stop(ownerId, remote.id);
      receipt.remoteAfterStop = (await containerGet(lab.container, assigned)).startsWith("ERR");
      receipt.remoteSessionsAfterStop = tunnelSessions();
      // A server port already in use (sshd's own 22) cannot be listened on: typed refusal, session closed.
      const privileged = await rule(22, local.address().port, { type: "remote" });
      await service.start(ownerId, privileged.id);
      receipt.remotePrivileged = await until(() => state(service, privileged.id), "failed/remote-bind-refused", 20_000) >= 0 ? "failed/remote-bind-refused" : state(service, privileged.id);
      receipt.remoteSessionsAfterRefusal = await until(() => tunnelSessions(), 0, 10_000) >= 0 ? 0 : tunnelSessions();
      await service.stop(ownerId, privileged.id);
      // A public request with GatewayPorts no: recorded as observed (the server decides, never this Mac).
      const wildcard = await rule(0, local.address().port, { type: "remote", bindAddress: "0.0.0.0" });
      await service.start(ownerId, wildcard.id);
      await until(() => /^(running|failed)\//u.test(state(service, wildcard.id)), true, 20_000);
      receipt.remoteWildcard = state(service, wildcard.id);
      const wildPort = service.snapshot(ownerId).find((row) => row.ruleId === wildcard.id)?.remotePort;
      receipt.remoteWildcardLoopback = wildPort ? await containerGet(lab.container, wildPort) : "none";
      await service.stop(ownerId, wildcard.id);
    } finally {
      await new Promise((done) => local.close(done));
    }
    await service.dispose();

    // 10. Transport loss: stopping the server fails the tunnel and closes its listener.
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
