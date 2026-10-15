'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const runFile = promisify(execFile);
const IMAGE = 'ssterm-ssh-fixture:m0';
const LABEL = 'dev.ssterm.spike.fixture';

async function docker(args, options = {}) {
  return runFile('docker', args, { timeout: 30_000, maxBuffer: 128 * 1024, ...options });
}

async function containerExists(container) {
  try {
    await docker(['inspect', '--format', '{{.Id}}', container]);
    return true;
  } catch (error) {
    if (/No such (?:object|container):/i.test(error.stderr || '')) return false;
    throw new Error('FIXTURE_DOCKER_STATUS_UNAVAILABLE');
  }
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function hasSSHBanner(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('data', (data) => done(data.toString('ascii').startsWith('SSH-2.0-')));
    socket.once('error', () => done(false));
    socket.once('end', () => done(false));
  });
}

async function waitForPort(port, expected = true) {
  for (let count = 0; count < 80; count++) {
    if (expected ? await hasSSHBanner(port) : !await portIsOpen(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(expected ? 'FIXTURE_NOT_READY' : 'FIXTURE_PORT_LEAK');
}

async function startFixture() {
  const requestedRunId = process.env.SSTERM_SPIKE_RUN_ID;
  const runId = /^[a-f0-9-]{36}$/.test(requestedRunId || '') ? requestedRunId : crypto.randomUUID();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `ssterm-ssh-spike-${runId}-`));
  await fs.chmod(directory, 0o700);
  const password = crypto.randomBytes(24).toString('hex');
  const passphrase = crypto.randomBytes(24).toString('hex');
  const keyFile = path.join(directory, 'client_ed25519');
  let container;
  let port;
  let destroyed = false;
  let stopped = false;
  const cleanup = async () => {
    if (destroyed) return;
    let failure;
    if (container) {
      try { await docker(['rm', '--force', container]); }
      catch {
        try {
          if (await containerExists(container)) failure = 'FIXTURE_CONTAINER_CLEANUP_FAILED';
        } catch { failure = 'FIXTURE_DOCKER_STATUS_UNAVAILABLE'; }
      }
    }
    // Erase owned credentials even when the Docker daemon cannot be reached.
    try { await fs.rm(directory, { recursive: true, force: true }); }
    catch { failure = 'FIXTURE_KEY_CLEANUP_FAILED'; }
    if (port) {
      try { await waitForPort(port, false); }
      catch { failure = failure || 'FIXTURE_PORT_LEAK'; }
    }
    if (failure) throw new Error(failure);
    destroyed = true;
  };
  try {
    await runFile('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'ssterm-owned-fixture', '-f', keyFile], { timeout: 10_000 });
    const publicKey = (await fs.readFile(`${keyFile}.pub`, 'utf8')).trim();
    const name = `ssterm-spike-${crypto.randomBytes(8).toString('hex')}`;
    container = name; // Claim the generated name before run so interrupted creation can be removed.
    const { stdout } = await docker(['run', '--detach', '--name', name,
      '--label', `${LABEL}=true`, '--label', `dev.ssterm.spike.run-id=${runId}`,
      '--publish', '127.0.0.1::22',
      '--env', 'FIXTURE_PASSWORD', '--env', 'FIXTURE_PUBLIC_KEY', IMAGE],
    { env: { ...process.env, FIXTURE_PASSWORD: password, FIXTURE_PUBLIC_KEY: publicKey } });
    container = stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('FIXTURE_CONTAINER_ID_INVALID');
    const binding = (await docker(['port', container, '22/tcp'])).stdout.trim();
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!match) throw new Error('FIXTURE_BINDING_INVALID');
    port = Number(match[1]);
    await waitForPort(port);
    const privateKey = await fs.readFile(keyFile);
    return {
      host: '127.0.0.1', port, username: 'fixture', password, passphrase, privateKey,
      directory, container,
      async rotateHostKey() {
        if (destroyed || stopped) throw new Error('FIXTURE_CLOSED');
        await docker(['exec', container, 'ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', '/etc/ssh/ssh_host_ed25519_key.next']);
        for (const suffix of ['', '.pub']) {
          await docker(['exec', container, 'mv', `/etc/ssh/ssh_host_ed25519_key.next${suffix}`, `/etc/ssh/ssh_host_ed25519_key${suffix}`]);
        }
        await docker(['kill', '--signal', 'HUP', container]);
        // HUP re-execs sshd; the probe verifies the newly negotiated key at the same endpoint.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await waitForPort(port);
      },
      async stopTransport() {
        await docker(['stop', '--time', '1', container]);
        stopped = true;
        await waitForPort(port, false);
      },
      dispose: cleanup,
      async assertCleaned() {
        let exists = true;
        try { await fs.access(directory); } catch { exists = false; }
        if (exists || await portIsOpen(port)) throw new Error('FIXTURE_RESOURCE_LEAK');
        if (await containerExists(container)) throw new Error('FIXTURE_CONTAINER_LEAK');
      }
    };
  } catch (error) {
    await cleanup();
    // Child-process errors may include fixture password/key argv/env: never expose their text.
    throw new Error(error.message?.startsWith('FIXTURE_') ? error.message : 'FIXTURE_START_FAILED');
  }
}

module.exports = { startFixture, portIsOpen };
