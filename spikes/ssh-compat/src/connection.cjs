'use strict';

const { Client } = require('ssh2');
const crypto = require('node:crypto');
const net = require('node:net');
const { once } = require('node:events');

class SpikeError extends Error {
  constructor(code) { super(code); this.name = 'SpikeError'; this.code = code; }
}
const fault = (code) => new SpikeError(code);
const fingerprint = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

function deadline(promise, milliseconds = 8_000, cleanup = () => {}) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => { cleanup(); reject(fault('timeout')); }, milliseconds);
  })]).finally(() => clearTimeout(timer));
}

class BoundedBuffer {
  constructor(limit = 256 * 1024) { this.limit = limit; this.bytes = 0; this.chunks = []; }
  append(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes + bytes.length > this.limit) throw fault('resource-limit');
    this.bytes += bytes.length;
    this.chunks.push(bytes);
  }
  value() { return Buffer.concat(this.chunks, this.bytes); }
}

class Session {
  constructor(client, closed, details) {
    this.client = client;
    this.closed = closed;
    this.details = details;
    this.resources = new Set();
    this.disposed = false;
    this.closePromise = undefined;
    client.once('close', () => {
      this.disposed = true;
      for (const resource of this.resources) resource.destroy?.();
      this.resources.clear();
    });
  }
  own(resource) {
    if (this.disposed) { resource.destroy?.(); throw fault('closed'); }
    this.resources.add(resource);
    resource.once('close', () => this.resources.delete(resource));
    resource.on('error', () => {});
    return resource;
  }
  async channel(open) {
    if (this.disposed) throw fault('closed');
    // A late callback is rejected by own() after timeout/disposal; no orphan channel.
    return deadline(new Promise((resolve, reject) => open((error, resource) => {
      if (error) { reject(fault('channel-open-failed')); return; }
      try { resolve(this.own(resource)); } catch (failure) { reject(failure); }
    })), 8_000, () => this.close());
  }
  async exec(command, { limit = 256 * 1024 } = {}) {
    const stream = await this.channel((callback) => this.client.exec(command, callback));
    const output = new BoundedBuffer(limit);
    const errors = new BoundedBuffer(16 * 1024);
    let status;
    return deadline(new Promise((resolve, reject) => {
      const collect = (buffer) => (chunk) => {
        try { buffer.append(chunk); } catch (error) { stream.destroy(); reject(error); }
      };
      stream.on('data', collect(output));
      stream.stderr.on('data', collect(errors));
      stream.on('exit', (code) => { status = code; });
      stream.once('error', () => reject(fault('channel-failed')));
      stream.once('close', () => resolve({ output: output.value(), stderr: errors.value(), status }));
    }), 8_000, () => stream.destroy());
  }
  async shell() {
    return this.channel((callback) => this.client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, callback));
  }
  async sftp() { return this.channel((callback) => this.client.sftp(callback)); }
  async tunnel() {
    if (this.disposed) throw fault('closed');
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      if (this.disposed) { socket.destroy(); return; }
      this.client.forwardOut('127.0.0.1', socket.remotePort || 0, '127.0.0.1', 8080, (error, channel) => {
        if (error || socket.destroyed || this.disposed) { channel?.destroy(); socket.destroy(); return; }
        try { this.own(channel); } catch { channel.destroy(); socket.destroy(); return; }
        channel.once('close', () => socket.destroy());
        socket.once('close', () => channel.destroy());
        // Stream pipes propagate backpressure instead of unbounded JS arrays.
        socket.pipe(channel).pipe(socket);
      });
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await deadline(listening, 3_000, () => server.close());
    const port = server.address().port;
    let stop;
    const close = () => {
      if (stop) return stop;
      stop = new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return stop;
    };
    const resource = { destroy: close, once: (...args) => server.once(...args), on: (...args) => server.on(...args) };
    try { this.own(resource); } catch (error) { await close(); throw error; }
    this.client.once('close', close);
    server.once('close', () => this.client.removeListener('close', close));
    return { host: '127.0.0.1', port, close };
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.disposed = true;
    this.closePromise = (async () => {
      for (const resource of this.resources) resource.destroy?.();
      this.client.end();
      const timer = setTimeout(() => this.client.destroy(), 500);
      await this.closed;
      clearTimeout(timer);
      this.resources.clear();
    })();
    return this.closePromise;
  }
}

async function connect(endpoint, options = {}) {
  if (endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) throw fault('invalid-fixture-endpoint');
  if (options.signal?.aborted) throw fault('cancelled');
  const client = new Client();
  const details = { handshake: null, fingerprint: null, prompts: 0, trustRequests: 0, authenticationStarted: false };
  const closed = new Promise((resolve) => client.once('close', resolve));
  client.on('error', () => {}); // Every client retains an error listener through disposal.
  client.on('handshake', (negotiated) => { details.handshake = negotiated; });
  let trustError;
  let settled = false;
  let timer;
  let abort;
  const ready = new Promise((resolve, reject) => {
    const fail = (code) => {
      if (settled) return;
      settled = true;
      client.destroy();
      const failure = fault(code);
      failure.observation = { authenticationStarted: details.authenticationStarted, trustRequests: details.trustRequests, prompts: details.prompts };
      reject(failure);
    };
    abort = () => fail('cancelled');
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => fail('timeout'), options.timeout || 5_000);
    client.once('error', (error) => fail(trustError || (error.level === 'client-authentication' ? 'auth-denied' : error.level === 'client-timeout' ? 'timeout' : 'transport-failed')));
    client.once('close', () => fail(trustError || 'transport-closed'));
    client.once('ready', () => {
      if (settled) { client.destroy(); return; }
      settled = true;
      resolve(new Session(client, closed, details));
    });
    client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
      details.prompts++;
      if (settled || prompts.length > 4) { finish([]); return; }
      Promise.resolve().then(() => options.onPrompt?.({ count: prompts.length })).then(() => {
        if (!settled) finish(prompts.map(() => endpoint.password));
      }, () => fail('prompt-cancelled'));
    });
    const mode = options.auth || 'password';
    const config = {
      host: endpoint.host, port: endpoint.port, username: endpoint.username,
      readyTimeout: options.timeout || 5_000,
      keepaliveInterval: 1_000, keepaliveCountMax: 2,
      authHandler: (methodsLeft, _partial, next) => {
        if (methodsLeft?.includes(mode === 'key' ? 'publickey' : mode === 'keyboard' ? 'keyboard-interactive' : 'password') === false) { next(false); return; }
        details.authenticationStarted = true;
        const type = mode === 'key' ? 'publickey' : mode === 'keyboard' ? 'keyboard-interactive' : 'password';
        if (details.authAttempted) { next(false); return; }
        details.authAttempted = true;
        if (type === 'publickey') next({ type, username: endpoint.username, key: endpoint.privateKey, passphrase: endpoint.passphrase });
        else if (type === 'password') next({ type, username: endpoint.username, password: options.badPassword ? 'ssterm-deliberately-wrong' : endpoint.password });
        else next({ type, username: endpoint.username,
          prompt: (...args) => client.emit('keyboard-interactive', ...args) });
      },
      hostVerifier: (key, verify) => {
        details.fingerprint = fingerprint(key);
        if (options.knownFingerprint) {
          const accepted = options.knownFingerprint === details.fingerprint;
          if (!accepted) trustError = 'host-key-changed';
          verify(accepted);
          return;
        }
        details.trustRequests++;
        if (!options.onUnknown) { trustError = 'host-key-untrusted'; verify(false); return; }
        Promise.resolve().then(() => options.onUnknown({ fingerprint: details.fingerprint, algorithm: 'ssh-ed25519' })).then((decision) => {
          if (settled) return;
          const accepted = decision === 'accept-once';
          if (!accepted) trustError = 'host-key-untrusted';
          verify(accepted);
        }, () => { if (!settled) { trustError = 'host-key-untrusted'; verify(false); } });
      }
    };
    try { client.connect(config); } catch { fail('invalid-config'); }
  });
  try { return await ready; }
  catch (error) { await deadline(closed, 2_000, () => client.destroy()).catch(() => {}); throw error; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}

module.exports = { connect, deadline, BoundedBuffer, SpikeError, fault };
