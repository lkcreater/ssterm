"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes, generateKeyPairSync, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { Server, utils } = require("../../../node_modules/ssh2");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");

/** External owned servers; authentication always runs through the shipped saved-host adapter. */
async function startCredentialFixture(production, options) {
  const directory = fs.mkdtempSync(path.join(options.tempDirectory, "ssterm-credentials-runtime-"));
  const namespace = `dev.ssterm.test.${randomUUID()}`;
  const transient = new production.TransientSecrets();
  const power = new EventEmitter();
  const ownerId = production.sessionOwnerId(options.owner);
  const entries = [];
  const clients = new Set();
  const timers = new Set();
  const events = [];
  const secrets = [randomBytes(24).toString("hex"), randomBytes(24).toString("hex")];
  const observations = { zeroRounds: 0, firstRounds: 0, secondRounds: 0, shells: 0, rejectedMethods: 0 };
  let lab, repository, runtime, server, controller, unsubscribe;
  let current, cleaned = false;
  const requireTrue = (condition, code) => {
    if (!condition) throw new Error(`CREDENTIAL_FIXTURE_${code}`);
  };
  const value = (result) => {
    requireTrue(result.ok, `OPERATION_${result.error?.code || "FAILED"}`);
    return result.value;
  };
  const cleanup = async () => {
    if (cleaned) return { fixtureCleaned: true, leftoverItems: 0 };
    let failed = false, leftovers = -1;
    const clean = async (action) => { try { await action(); } catch { failed = true; } };
    await clean(() => controller?.dispose());
    await clean(() => unsubscribe?.());
    await clean(() => runtime?.shutdown());
    for (const timer of timers) clearTimeout(timer);
    for (const client of clients) await clean(() => { client.end(); client._sock?.destroy(); });
    await clean(() => server && new Promise((done, reject) => {
      const deadline = setTimeout(() => reject(new Error("CREDENTIAL_FIXTURE_SERVER_CLEANUP_TIMEOUT")), 3_000);
      server.close(() => { clearTimeout(deadline); done(); });
    }));
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
    secrets.push(lab.passphrase, lab.password);
    repository = value(await production.openMetadata({ path: path.join(directory, "catalog.sqlite") }));
    const provider = new production.KeychainSecretProvider(namespace);
    const service = new production.SecretService({ repository, provider, transient });
    const catalog = new production.CatalogModule({ repository });
    const perform = (intent) => value(catalog.apply(value(catalog.prepare(intent)).token));
    const parsedMany = utils.parseKey(lab.privateKey, lab.passphrase);
    const parsed = Array.isArray(parsedMany) ? parsedMany[0] : parsedMany;
    requireTrue(!(parsed instanceof Error), "PRIVATE_KEY");
    const wire = parsed.getPublicSSH();
    const keyId = randomUUID();
    const published = await service.storeSecret({
      kind: "private-key", owner: { type: "key", id: keyId, expectedRevision: null }, value: lab.privateKey,
      publish: (ref) => [{ type: "create-key", id: keyId, data: {
        label: "Owned encrypted Ed25519", algorithm: parsed.type,
        publicKey: `${parsed.type} ${wire.toString("base64")}`,
        fingerprint: `SHA256:${createHash("sha256").update(wire).digest("base64").replace(/=+$/u, "")}`,
        privateKeyRef: ref,
      } }],
    });
    requireTrue(published.status === "published", "SECRET_PUBLICATION");
    const keyIdentity = perform({ type: "create-identity", data: {
      label: "Owned passphrase prompt", username: lab.username, method: "key", keyId,
    } }).createdIds[0];
    const hosts = {};
    hosts.passphrase = perform({ type: "create-host", data: {
      label: "ระบบทดสอบ กรุงเทพ", address: lab.host, environment: "PROD",
      port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: keyIdentity },
    } }).createdIds[0];

    const passwordIdentity = perform({ type: "create-identity", data: {
      label: "Owned unsaved password", username: lab.username, method: "password",
    } }).createdIds[0];
    hosts.password = perform({ type: "create-host", data: {
      label: "ระบบทดสอบ รหัสผ่าน", address: lab.host, environment: "PROD",
      port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: passwordIdentity },
    } }).createdIds[0];

    const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
    server = new Server({ hostKeys: [hostKey] }, (client) => {
      clients.add(client);
      client.on("error", () => {});
      client.once("close", () => clients.delete(client));
      client.on("authentication", (auth) => {
        if (auth.method === "none") return auth.reject(["keyboard-interactive"]);
        if (auth.method !== "keyboard-interactive") {
          observations.rejectedMethods += 1;
          return auth.reject(["keyboard-interactive"]);
        }
        const mode = auth.username;
        const first = () => {
          observations.firstRounds += 1;
          auth.prompt([
            { prompt: "Remote instruction must never render: Password <script>", echo: false },
            { prompt: "Remote instruction must never render: account", echo: true },
          ], "Untrusted remote title", "Untrusted remote instruction", (answers) => {
            if (answers instanceof Error) return;
            if (mode === "exhaust") {
              // A fourth nonempty round must be rejected before a fourth UI prompt appears.
              let round = 1;
              const again = () => {
                round += 1;
                auth.prompt([{ prompt: "Untrusted retry", echo: false }], (responses) => { if (responses instanceof Error) return; if (round < 5) again(); else auth.accept(); });
              };
              again();
              return;
            }
            if (answers.length !== 2 || answers[0] !== secrets[0] || answers[1] !== secrets[1]) {
              auth.reject(["keyboard-interactive"]);
              return;
            }
            const second = () => {
              observations.secondRounds += 1;
              auth.prompt([{ prompt: "Untrusted one-time code", echo: false }], (responses) => {
                if (responses instanceof Error) return;
                if (responses.length === 1 && responses[0] === secrets[0]) auth.accept();
                else auth.reject(["keyboard-interactive"]);
              });
            };
            if (mode === "delayed") {
              const timer = setTimeout(() => { timers.delete(timer); if (clients.has(client)) second(); }, 1_000);
              timers.add(timer);
            } else second();
          });
        };
        if (mode === "keyboard" || mode === "zero") {
          auth.prompt([], "Untrusted notice", "Untrusted notice", (answers) => {
            if (answers instanceof Error) return;
            if (answers.length !== 0) return auth.reject(["keyboard-interactive"]);
            observations.zeroRounds += 1;
            if (mode === "zero") auth.accept(); else first();
          });
        } else first();
      });
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("pty", (accept) => accept());
          session.on("shell", (accept) => { observations.shells += 1; const stream = accept(); stream.on("error", () => {}); stream.on("data", () => {}); });
        });
      });
    });
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const port = server.address().port;
    for (const mode of ["keyboard", "zero", "exhaust", "delayed", "timeout"]) {
      const identityId = perform({ type: "create-identity", data: {
        label: `Owned ${mode}`, username: mode, method: "keyboard-interactive",
      } }).createdIds[0];
      hosts[mode] = perform({ type: "create-host", data: {
        label: `ระบบทดสอบ ${mode}`, address: "127.0.0.1", environment: "PROD",
        port: { mode: "value", port }, auth: { mode: "value", identityId },
      } }).createdIds[0];
    }
    runtime = production.createSavedHostSessions({ repository, provider, transient, power, limits: { promptMs: 15_000 } });
    const registry = runtime.registry;
    unsubscribe = registry.subscribe(ownerId, (snapshot) => {
      events.push(snapshot);
      if (snapshot.prompt?.kind === "host-trust") {
        queueMicrotask(() => registry.answerPrompt(ownerId, snapshot.id, snapshot.generation, snapshot.prompt.id,
          { kind: "host-trust", decision: "remember" }));
      }
    });
    controller = production.createCredentialsController({ registry });
    controller.register(options.owner, options.send);
    const status = () => ({
      current: current?.id ?? null,
      sessions: registry.snapshot(ownerId).map((s) => ({ id: s.id, generation: s.generation, state: s.state,
        error: s.error?.code ?? null, cleanup: s.cleanup,
        prompt: s.prompt?.kind === "credentials" ? s.prompt : null })),
      observations: { ...observations },
    });
    return {
      controller,
      connect(mode) {
        requireTrue(Object.hasOwn(hosts, mode), "MODE");
        current = value(registry.connect(ownerId, hosts[mode])); entries.push(current);
        return status();
      },
      async close(id = current?.id) { if (id) value(await registry.close(ownerId, id)); return status(); },
      reconnect() { current = value(registry.reconnect(ownerId, current.id)); return status(); },
      lock() { power.emit("lock-screen"); return status(); },
      status,
      // Only fixed test operations cross Playwright. Generated answers never enter its arguments/results/traces.
      async fill(webContents, mode) {
        const values = mode === "wrong" ? ["owned-wrong-response"] : mode === "password" ? [lab.password] : mode === "passphrase" ? [lab.passphrase]
          : mode === "first" ? secrets.slice(0, 2) : [secrets[0]];
        const pending = registry.snapshot(ownerId).find((session) => session.prompt?.kind === "credentials");
        if (!pending) return false;
        const script = `(() => {
          const dialogs = [...document.querySelectorAll('[data-testid="credential-prompt-dialog"]')];
          if (dialogs.length !== 1) return false;
          const dialog = dialogs[0];
          if (!dialog.textContent.includes(${JSON.stringify(pending.target.label)}) || !dialog.textContent.includes(${JSON.stringify(`Attempt ${pending.prompt.attempt} of 3`)})) return false;
          const inputs = [...dialog.querySelectorAll('input')];
          if (inputs.length !== ${values.length} || inputs.some((input) => input.disabled)) return false;
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          const values = ${JSON.stringify(values)};
          inputs.forEach((input, index) => { set.call(input, values[index]); input.dispatchEvent(new Event('input', { bubbles: true })); });
          return true; })()`;
        return webContents.executeJavaScript(script);
      },
      privacy() {
        const serialized = JSON.stringify(events);
        const database = fs.readdirSync(directory).filter((name) => name.startsWith("catalog.sqlite"))
          .map((name) => fs.readFileSync(path.join(directory, name)));
        return {
          safeEvents: !secrets.some((secret) => serialized.includes(secret)) && !serialized.includes("PRIVATE KEY"),
          noPlaintextMetadata: !database.some((bytes) => secrets.some((secret) => bytes.includes(Buffer.from(secret))) || bytes.includes(Buffer.from("PRIVATE KEY"))),
          unsavedPassphrase: value(repository.snapshot()).keys.every((key) => !key.passphraseRef),
          rejectedMethods: observations.rejectedMethods,
        };
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw new Error(error.message?.startsWith("CREDENTIAL_FIXTURE_") ? error.message : "CREDENTIAL_FIXTURE_START_FAILED");
  }
}
module.exports = { startCredentialFixture };
