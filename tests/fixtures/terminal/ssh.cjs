"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");

/** Owned Docker OpenSSH host reached only through the shipped saved-host adapter and terminal controller. */
async function startTerminalFixture(production, options) {
  const directory = fs.mkdtempSync(path.join(options.tempDirectory, "ssterm-terminal-runtime-"));
  const namespace = `dev.ssterm.test.${randomUUID()}`;
  const transient = new production.TransientSecrets();
  const power = new EventEmitter();
  const ownerId = production.sessionOwnerId(options.owner);
  // Receipts only, never content: per generation frame/ack/write counts and byte totals, whether
  // sequences were consecutive from 0, and main-clock times. `mark` restarts the timed fields so one
  // phase (e.g. a flood) is measured on its own: max unacknowledged, first/last frame and last ack.
  const frames = new Map();
  const receipt = (key) => {
    let entry = frames.get(key);
    if (!entry) {
      entry = { count: 0, bytes: 0, consecutive: true, acks: 0, ackedBytes: 0, writes: 0, writtenBytes: 0, largestWrite: 0,
        maxUnacked: 0, firstFrameAt: null, lastFrameAt: null, lastAckAt: null };
      frames.set(key, entry);
    }
    return entry;
  };
  let lab, repository, runtime, controller, unsubscribe, current, second, cleaned = false;
  const requireTrue = (condition, code) => {
    if (!condition) throw new Error(`TERMINAL_FIXTURE_${code}`);
  };
  const value = (result) => {
    requireTrue(result.ok, `OPERATION_${result.error?.code || "FAILED"}`);
    return result.value;
  };
  const record = (send) => (channel, frame) => {
    if (channel === production.channels.terminalOutput) {
      const entry = receipt(`${frame.sessionId}:${frame.generation}`);
      entry.consecutive &&= frame.sequence === entry.count;
      entry.count += 1;
      entry.bytes += frame.bytes.byteLength;
      entry.maxUnacked = Math.max(entry.maxUnacked, entry.bytes - entry.ackedBytes);
      entry.lastFrameAt = performance.now();
      entry.firstFrameAt ??= entry.lastFrameAt;
    }
    send(channel, frame);
  };
  const cleanup = async () => {
    if (cleaned) return { fixtureCleaned: true, leftoverItems: 0 };
    let failed = false, leftovers = -1;
    const clean = async (action) => { try { await action(); } catch { failed = true; } };
    await clean(() => controller?.dispose());
    await clean(() => unsubscribe?.());
    await clean(() => runtime?.shutdown());
    await clean(() => transient.purgeAll());
    await clean(() => repository?.close());
    await clean(async () => { leftovers = await production.clearTestNamespace(namespace); });
    if (lab) {
      lab.privateKey.fill(0);
      await clean(() => lab.dispose());
      await clean(() => lab.assertCleaned());
    }
    await clean(() => fs.rmSync(directory, { recursive: true, force: true }));
    requireTrue(!failed && leftovers === 0, "CLEANUP_FAILED");
    cleaned = true;
    return { fixtureCleaned: true, leftoverItems: leftovers };
  };
  try {
    lab = await startFixture();
    repository = value(await production.openMetadata({ path: path.join(directory, "catalog.sqlite") }));
    const provider = new production.KeychainSecretProvider(namespace);
    const service = new production.SecretService({ repository, provider, transient });
    const catalog = new production.CatalogModule({ repository });
    const perform = (intent) => value(catalog.apply(value(catalog.prepare(intent)).token));
    const identityId = randomUUID();
    const password = Buffer.from(lab.password);
    try {
      const published = await service.storeSecret({
        kind: "password", owner: { type: "identity", id: identityId, expectedRevision: null }, value: password,
        publish: (ref) => [{ type: "create-identity", id: identityId,
          data: { label: "Owned terminal password", username: lab.username, method: "password", passwordRef: ref } }],
      });
      requireTrue(published.status === "published", "SECRET_PUBLICATION");
    } finally { password.fill(0); }
    const hostId = perform({ type: "create-host", data: {
      label: options.label, address: lab.host, environment: "PROD",
      port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId },
    } }).createdIds[0];
    // Optional second (DEV) host on the same owned server, so two panes can run side by side.
    const secondHostId = options.secondLabel ? perform({ type: "create-host", data: {
      label: options.secondLabel, address: lab.host, environment: "DEV",
      port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId },
    } }).createdIds[0] : null;
    runtime = production.createSavedHostSessions({ repository, provider, transient, power });
    const registry = runtime.registry;
    unsubscribe = registry.subscribe(ownerId, (snapshot) => {
      if (snapshot.prompt?.kind === "host-trust") {
        queueMicrotask(() => registry.answerPrompt(ownerId, snapshot.id, snapshot.generation, snapshot.prompt.id,
          { kind: "host-trust", decision: "remember" }));
      }
    });
    const terminals = production.createTerminalController({ registry });
    // IPC handlers re-register the invoking sender on every call, so the recorder wraps that path too.
    controller = {
      ...terminals,
      register: (owner, send) => terminals.register(owner, record(send)),
      ackTerminal(request) {
        const result = terminals.ackTerminal(request);
        if (result.ok) {
          const entry = receipt(`${request.sessionId}:${request.generation}`);
          entry.acks += 1;
          entry.ackedBytes += request.bytes;
          entry.lastAckAt = performance.now();
        }
        return result;
      },
      writeTerminal(request) {
        // The IPC handler wipes the bytes after this returns, so only the length is read, first.
        const length = request?.bytes?.byteLength ?? 0;
        const result = terminals.writeTerminal(request);
        if (result.ok) {
          const entry = receipt(`${request.sessionId}:${request.generation}`);
          entry.writes += 1;
          entry.writtenBytes += length;
          entry.largestWrite = Math.max(entry.largestWrite, length);
        }
        return result;
      },
    };
    controller.register(options.owner, options.send);
    const status = (session = current) => {
      const snapshot = session && registry.snapshot(ownerId, session.id)[0];
      return snapshot ? {
        id: snapshot.id, generation: snapshot.generation, state: snapshot.state, cleanup: snapshot.cleanup,
        error: snapshot.error?.code ?? null, end: snapshot.end ? { ...snapshot.end } : null,
      } : null;
    };
    return {
      controller,
      connect() { current = value(registry.connect(ownerId, hostId)); return status(); },
      reconnect() { current = value(registry.reconnect(ownerId, current.id)); return status(); },
      async close() { value(await registry.close(ownerId, current.id)); return status(); },
      connectSecond() {
        requireTrue(secondHostId, "NO_SECOND_HOST");
        second = value(registry.connect(ownerId, secondHostId));
        return status(second);
      },
      status: () => status(),
      frames(generation) {
        return { ...receipt(`${current.id}:${generation}`) };
      },
      mark(generation) {
        const entry = receipt(`${current.id}:${generation}`);
        Object.assign(entry, { maxUnacked: entry.bytes - entry.ackedBytes, firstFrameAt: null, lastFrameAt: null, lastAckAt: null });
        return { ...entry };
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw new Error(error.message?.startsWith("TERMINAL_FIXTURE_") ? error.message : "TERMINAL_FIXTURE_START_FAILED");
  }
}
module.exports = { startTerminalFixture };
