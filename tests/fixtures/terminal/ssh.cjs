"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");
const runFile = promisify(execFile);

/** Docker action on the owned lab container. Its argv/stderr never carry credentials, but are still not surfaced. */
async function docker(args) {
  try { return (await runFile("docker", args, { timeout: 30_000 })).stdout; }
  catch (error) {
    // `pgrep -c` exits 1 when it counts zero.
    if (args[2] === "pgrep" && error.code === 1) return error.stdout;
    throw new Error("TERMINAL_FIXTURE_DOCKER_FAILED");
  }
}

/**
 * Owned Docker OpenSSH host reached only through the shipped saved-host adapter and terminal controller.
 * Options beyond the original ones: `lab` (an externally owned lab from startFixture, never disposed here),
 * `keepalive`/`limits` (main-only bounds), `power` (an emitter such as powerMonitor), `autoTrust: false`
 * (leave host-trust prompts to the caller) and `promptLabel` (a host whose identity has no saved password).
 */
async function startTerminalFixture(production, options) {
  const directory = fs.mkdtempSync(path.join(options.tempDirectory, "ssterm-terminal-runtime-"));
  const namespace = `dev.ssterm.test.${randomUUID()}`;
  const transient = new production.TransientSecrets();
  const power = options.power ?? new EventEmitter();
  const ownedLab = !options.lab;
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
  let lab, repository, runtime, controller, unsubscribe, current, second, recorder, cleaned = false;
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
    await clean(() => recorder?.dispose());
    await clean(() => transient.purgeAll());
    await clean(() => repository?.close());
    await clean(async () => { leftovers = await production.clearTestNamespace(namespace); });
    if (lab && ownedLab) {
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
    lab = options.lab ?? await startFixture();
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
    // Optional host whose identity has no saved password, so authentication prompts for one.
    const promptHostId = options.promptLabel ? perform({ type: "create-host", data: {
      label: options.promptLabel, address: lab.host, environment: "DEV",
      port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: perform({ type: "create-identity", data: {
        label: "Owned unsaved password", username: lab.username, method: "password",
      } }).createdIds[0] },
    } }).createdIds[0] : null;
    // SST-034: an owned recorder (temporary root, this namespace's vault key) when the caller asks for capture.
    if (options.recording) {
      recorder = production.createRecorder({ files: production.createRecordingFiles({ root: path.join(directory, "recordings") }),
        keys: () => service.recording, ...(options.recording.limits ? { limits: options.recording.limits } : {}) });
      await recorder.ready;
      const configured = await recorder.configure({ logs: true, history: true, logDays: 30, logMiB: 10_240, historyDays: 180, historyMiB: 8 });
      requireTrue(configured.status === "saved", "RECORDING_CONFIGURE");
    }
    runtime = production.createSavedHostSessions({ repository, provider, transient, power,
      ...(recorder ? { observeTerminal: recorder.observe } : {}),
      ...(options.keepalive ? { keepalive: options.keepalive } : {}), ...(options.limits ? { limits: options.limits } : {}) });
    const registry = runtime.registry;
    unsubscribe = registry.subscribe(ownerId, (snapshot) => {
      if (options.autoTrust !== false && snapshot.prompt?.kind === "host-trust") {
        queueMicrotask(() => registry.answerPrompt(ownerId, snapshot.id, snapshot.generation, snapshot.prompt.id,
          { kind: "host-trust", decision: "remember" }));
      }
    });
    // Reconnect after a lock is the explicit unlock; the owned catalog and namespace stay available.
    const terminals = production.createTerminalController({ registry, checkAccess: async () => !cleaned, ...(recorder ? { recording: recorder } : {}) });
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
      // The owned catalog and the PROD host, for fixtures that add their own rows (e.g. tunnel rules).
      repository,
      /**
       * SST-034 receipts for the newest log: its state, the exported length, and the gap records (count and bytes).
       * The export is read for its length and markers only, then removed.
       */
      async recordingReceipt() {
        requireTrue(recorder, "NO_RECORDER");
        const log = recorder.state().logs[0];
        if (!log) return null;
        const destination = path.join(directory, `export-${randomUUID()}.log`);
        const outcome = await recorder.export({ kind: "log", id: log.id }, destination);
        if (outcome.status !== "saved") return { state: log.state, outcome: outcome.status };
        const text = fs.readFileSync(destination).toString("latin1");
        fs.rmSync(destination, { force: true });
        const markers = [...text.matchAll(/\r\n\[ssterm: (\d+) bytes not recorded\]\r\n/gu)];
        const markerBytes = markers.reduce((sum, match) => sum + match[0].length, 0);
        return { state: log.state, outcome: outcome.status, exportBytes: text.length, recordedBytes: text.length - markerBytes,
          gaps: markers.length, gapBytes: markers.reduce((sum, match) => sum + Number(match[1]), 0), incomplete: outcome.incomplete };
      },
      hostId,
      runtime,
      ownerId,
      connect() { current = value(registry.connect(ownerId, hostId)); return status(); },
      reconnect() { current = value(registry.reconnect(ownerId, current.id)); return status(); },
      async close() { value(await registry.close(ownerId, current.id)); return status(); },
      connectSecond() {
        requireTrue(secondHostId, "NO_SECOND_HOST");
        second = value(registry.connect(ownerId, secondHostId));
        return status(second);
      },
      connectPrompt() {
        requireTrue(promptHostId, "NO_PROMPT_HOST");
        current = value(registry.connect(ownerId, promptHostId));
        return status();
      },
      status: () => status(),
      sessions: () => registry.snapshot(ownerId).map((snapshot) => status(snapshot)),
      registry,
      policy: runtime.policy,
      // The composition main uses when a window's owner is revoked (navigation or renderer crash).
      revokeOwner: (owner) => runtime.revokeOwner(owner),
      knownHosts() {
        const listed = runtime.policy.list();
        return listed.ok ? listed.value.length : -1;
      },
      pause: () => docker(["pause", lab.container]).then(() => true),
      unpause: () => docker(["unpause", lab.container]).then(() => true),
      async stop() {
        if (ownedLab) await lab.stopTransport();
        else await docker(["stop", "--time", "1", lab.container]);
        return true;
      },
      // Server-side interactive shells (`sshd: fixture@pts/N`); 0 once every session is reaped.
      shells: async () => Number((await docker(["exec", lab.container, "pgrep", "-c", "-f", "sshd: fixture@"])).trim()),
      frames(generation) {
        return { ...receipt(`${current.id}:${generation}`) };
      },
      /** Write receipts for every session, keyed by label order: current (first host) then second. */
      writes() {
        const of = (session) => session ? { ...receipt(`${session.id}:${registry.snapshot(ownerId, session.id)[0]?.generation ?? 0}`) }.writes : 0;
        return { current: of(current), second: of(second) };
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
