'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { pipeline } = require('node:stream/promises');
const { StringDecoder } = require('node:string_decoder');
const { startFixture, portIsOpen } = require('./fixture.cjs');
const { connect, deadline, BoundedBuffer, fault } = require('./connection.cjs');
const { createReport, safeCode } = require('./report.cjs');

const HASH = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const trust = () => 'accept-once';

async function expectCode(promise, code) {
  try { const unexpected = await promise; await unexpected?.close?.(); throw fault('expected-rejection-missing'); }
  catch (error) { assert.equal(error.code, code); return error; }
}

async function usingSession(fixture, options, work) {
  const session = await connect(fixture, options);
  try { return await work(session); }
  finally { await session.close(); await session.close(); }
}

async function blackhole(work) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try { return await work(port); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.equal(await portIsOpen(port), false);
  }
}

async function ptyProbe(session) {
  const channel = await session.shell();
  const collector = new BoundedBuffer(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let text = '';
  let exitCode;
  const result = new Promise((resolve, reject) => {
    channel.on('data', (chunk) => {
      try { collector.append(chunk); text += decoder.write(chunk); }
      catch (error) { channel.destroy(); reject(error); }
    });
    channel.on('exit', (code) => { exitCode = code; });
    channel.once('error', () => reject(fault('pty-failed')));
    channel.once('close', () => { text += decoder.end(); resolve(); });
  });
  // Resize is sent before the command; shell executes stty on the remote PTY.
  channel.setWindow(41, 111, 0, 0);
  channel.write("stty -echo; stty size; printf '\\163\\163\\164\\145\\162\\155\\055\\165\\164\\146\\070\\072ไทย😀\\n'; exit 7\n");
  await deadline(result, 8_000, () => channel.destroy());
  assert.match(text, /(?:^|[\r\n])41 111[\r\n]/);
  assert.match(text, /ssterm-utf8:ไทย😀[\r\n]/);
  assert.equal(exitCode, 7);
  return { rows: 41, columns: 111, exitCode, unicodeBytes: true };
}

async function sftpProbe(session, fixture) {
  const sftp = await session.sftp();
  const data = crypto.randomBytes(192 * 1024 + 17);
  const localInput = path.join(fixture.directory, 'upload.bin');
  const localOutput = path.join(fixture.directory, 'download.bin');
  const remote = '/home/fixture/ssterm-owned-transfer.bin';
  await fs.writeFile(localInput, data);
  // Use streaming reads/writes so a file need not fit an unbounded app queue.
  const { createReadStream, createWriteStream } = require('node:fs');
  await deadline(pipeline(createReadStream(localInput), sftp.createWriteStream(remote, { flags: 'wx', mode: 0o600 })), 8_000, () => sftp.destroy());
  await deadline(pipeline(sftp.createReadStream(remote), createWriteStream(localOutput, { flags: 'wx', mode: 0o600 })), 8_000, () => sftp.destroy());
  const downloaded = await fs.readFile(localOutput);
  assert.equal(HASH(downloaded), HASH(data));
  assert.equal(downloaded.length, data.length);
  await deadline(new Promise((resolve, reject) => sftp.unlink(remote, (error) => error ? reject(fault('sftp-unlink-failed')) : resolve())), 3_000, () => sftp.destroy());
  sftp.end();
  return { bytes: data.length, sha256Matched: true, overwritePolicy: 'exclusive-create', remotePartialPolicy: 'fixture-owned path deleted on fixture teardown' };
}

function requestHTTP(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
      const collector = new BoundedBuffer(16 * 1024);
      response.on('data', (data) => {
        try { collector.append(data); } catch (error) { request.destroy(); reject(error); }
      });
      response.once('error', () => reject(fault('tunnel-http-failed')));
      response.once('end', () => resolve({ status: response.statusCode, body: collector.value().toString('utf8') }));
    });
    request.setTimeout(5_000, () => { request.destroy(); reject(fault('timeout')); });
    request.once('error', () => reject(fault('tunnel-http-failed')));
  });
}

function algorithmSummary(handshake) {
  if (!handshake) return null;
  return { kex: handshake.kex, hostKey: handshake.serverHostKey,
    clientToServer: { cipher: handshake.cs?.cipher, mac: handshake.cs?.mac, compression: handshake.cs?.compress },
    serverToClient: { cipher: handshake.sc?.cipher, mac: handshake.sc?.mac, compression: handshake.sc?.compress } };
}

async function runProbes({ runtime = 'node' } = {}) {
  const report = createReport(runtime);
  let fixture;
  let failed = false;
  const probe = async (name, action) => {
    const started = Date.now();
    try {
      const evidence = await action();
      report.cases.push({ name, status: 'passed', milliseconds: Date.now() - started, ...(evidence ? { evidence } : {}) });
    } catch (error) {
      report.cases.push({ name, status: 'failed', milliseconds: Date.now() - started, code: safeCode(error) });
      failed = true;
    }
  };
  try {
    assert.equal(report.optionalNativeBindingLoaded, false);
    fixture = await startFixture();
    let trustedFingerprint;
    await probe('unknown-key-rejected-before-auth', async () => {
      const rejected = await expectCode(connect(fixture), 'host-key-untrusted');
      assert.equal(rejected.observation.authenticationStarted, false);
      return { authenticationStarted: false };
    });
    await probe('explicit-trust-password-auth', async () => usingSession(fixture, {
      onUnknown: (request) => { trustedFingerprint = request.fingerprint; return trust(); }
    }, async (session) => {
      assert.equal(session.details.trustRequests, 1);
      assert.equal(session.details.authenticationStarted, true);
      report.algorithms = algorithmSummary(session.details.handshake);
      const result = await session.exec("printf 'password-auth-ok'");
      assert.equal(result.output.toString(), 'password-auth-ok');
      assert.equal(result.status, 0);
      return { explicitDecision: true };
    }));
    if (!trustedFingerprint) throw fault('trust-baseline-missing');
    const known = { knownFingerprint: trustedFingerprint };
    await probe('encrypted-openssh-ed25519-key-auth', async () => usingSession(fixture, { ...known, auth: 'key' }, async (session) => {
      assert.equal(session.details.trustRequests, 0);
      const result = await session.exec("printf 'key-auth-ok'");
      assert.equal(result.output.toString(), 'key-auth-ok');
      return { encryptedKey: true, format: 'OpenSSH Ed25519' };
    }));
    await probe('keyboard-interactive-pam-auth', async () => usingSession(fixture, { ...known, auth: 'keyboard' }, async (session) => {
      assert.ok(session.details.prompts >= 1);
      assert.equal((await session.exec("printf 'interactive-auth-ok'")).output.toString(), 'interactive-auth-ok');
      return { challengeRounds: session.details.prompts };
    }));
    await probe('pty-input-resize-unicode-exit', async () => usingSession(fixture, known, ptyProbe));
    await probe('sftp-upload-download-integrity', async () => usingSession(fixture, known, (session) => sftpProbe(session, fixture)));
    await probe('loopback-local-forward-http-and-stop', async () => usingSession(fixture, known, async (session) => {
      const tunnel = await session.tunnel();
      assert.equal(tunnel.host, '127.0.0.1');
      try {
        const response = await requestHTTP(tunnel.port);
        assert.equal(response.status, 200);
        assert.equal(response.body, 'ssterm-fixture-ok\n');
      } finally { await tunnel.close(); await tunnel.close(); }
      assert.equal(await portIsOpen(tunnel.port), false);
      return { loopbackOnly: true, destination: 'fixture-loopback:8080', bodyMatched: true, listenerClosed: true };
    }));
    await probe('bad-password-denied', async () => expectCode(connect(fixture, { ...known, badPassword: true }), 'auth-denied'));
    await probe('handshake-timeout-cleanup', async () => blackhole(async (port) => expectCode(connect({ ...fixture, port }, { timeout: 300 }), 'timeout')));
    await probe('cancel-before-connect', async () => {
      const controller = new AbortController(); controller.abort();
      await expectCode(connect(fixture, { ...known, signal: controller.signal }), 'cancelled');
    });
    await probe('cancel-during-handshake', async () => blackhole(async (port) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 50);
      try { await expectCode(connect({ ...fixture, port }, { signal: controller.signal }), 'cancelled'); }
      finally { clearTimeout(timer); }
    }));
    await probe('cancel-pending-trust-decision', async () => {
      const controller = new AbortController();
      await expectCode(connect(fixture, { signal: controller.signal, onUnknown: () => { controller.abort(); return new Promise(() => {}); } }), 'cancelled');
    });
    await probe('cancel-pending-auth-prompt', async () => {
      const controller = new AbortController();
      const rejected = await expectCode(connect(fixture, { ...known, auth: 'keyboard', signal: controller.signal, onPrompt: () => { controller.abort(); return new Promise(() => {}); } }), 'cancelled');
      assert.ok(rejected.observation.prompts >= 1);
      return { promptObserved: true };
    });
    await probe('ordered-output-and-bounded-collector', async () => usingSession(fixture, known, async (session) => {
      const result = await session.exec("python3 -c 'import sys; sys.stdout.buffer.write(bytes(range(256))*128)'", { limit: 64 * 1024 });
      const sequence = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
      assert.deepEqual(result.output, Buffer.concat(Array.from({ length: 128 }, () => sequence)));
      return { bytes: result.output.length, ordered: true, collectorLimit: 64 * 1024 };
    }));
    await probe('output-resource-limit-is-explicit', async () => usingSession(fixture, known, async (session) => {
      await expectCode(session.exec("python3 -c 'import sys; sys.stdout.buffer.write(b\"x\"*262144)'", { limit: 4096 }), 'resource-limit');
    }));
    await probe('repeated-session-disposal', async () => {
      for (let count = 0; count < 3; count++) {
        const session = await connect(fixture, known);
        assert.equal((await session.exec('true')).status, 0);
        await Promise.all([session.close(), session.close()]);
        await expectCode(session.exec('true'), 'closed');
        assert.equal(session.resources.size, 0);
      }
      return { cycles: 3, idempotent: true };
    });
    await probe('actual-host-key-rotation-blocks-before-auth', async () => {
      await fixture.rotateHostKey();
      const rejected = await expectCode(connect(fixture, known), 'host-key-changed');
      assert.equal(rejected.observation.authenticationStarted, false);
      await usingSession(fixture, { onUnknown: trust }, async (session) => {
        assert.notEqual(session.details.fingerprint, trustedFingerprint);
        assert.equal((await session.exec('true')).status, 0);
      });
      return { sameEndpoint: true, differentServerKey: true, replacementRequiresExplicitDecision: true };
    });
    await probe('transport-loss-closes-session-and-tunnel', async () => {
      const session = await connect(fixture, { onUnknown: trust });
      let tunnel;
      try {
        tunnel = await session.tunnel();
        await fixture.stopTransport();
        await deadline(session.closed, 5_000, () => session.client.destroy());
        // Cleanup is triggered by transport loss, before an explicit tunnel stop.
        for (let count = 0; count < 20 && await portIsOpen(tunnel.port); count++) await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(await portIsOpen(tunnel.port), false);
        await tunnel.close();
      } finally { await session.close(); }
      return { lostTransportObserved: true, loopbackListenerClosed: true };
    });
  } catch (error) {
    failed = true;
    report.cases.push({ name: fixture ? 'harness' : 'fixture-start', status: 'failed', code: safeCode(error) });
  } finally {
    if (fixture) await probe('owned-fixture-container-keys-and-ports-cleaned', async () => {
      await fixture.dispose(); await fixture.dispose(); await fixture.assertCleaned();
      return { containerRemoved: true, tempDirectoryRemoved: true, hostPortClosed: true };
    });
  }
  if (failed) {
    const failure = fault('mandatory-probes-failed');
    failure.report = report;
    throw failure;
  }
  return report;
}

module.exports = { runProbes };
