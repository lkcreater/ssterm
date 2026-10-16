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
  // Receipts only: per generation frame count, byte total and whether sequences were consecutive from 0.
  const frames = new Map();
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
      const key = `${frame.sessionId}:${frame.generation}`;
      const entry = frames.get(key) ?? { count: 0, bytes: 0, consecutive: true };
      entry.consecutive &&= frame.sequence === entry.count;
      entry.count += 1;
      entry.bytes += frame.bytes.byteLength;
      frames.set(key, entry);
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
    controller = { ...terminals, register: (owner, send) => terminals.register(owner, record(send)) };
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
        return frames.get(`${current.id}:${generation}`) ?? { count: 0, bytes: 0, consecutive: true };
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw new Error(error.message?.startsWith("TERMINAL_FIXTURE_") ? error.message : "TERMINAL_FIXTURE_START_FAILED");
  }
}
module.exports = { startTerminalFixture };
