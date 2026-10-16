"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, generateKeyPairSync, createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { EventEmitter } = require("node:events");
const { utils } = require("../../../node_modules/ssh2");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");
const run = promisify(execFile);

/** External fixture: credentials enter only via real SecretService + isolated Keychain. */
async function runSavedHostSmoke(production, tempDirectory) {
  const {
    openMetadata, CatalogModule, SecretService, TransientSecrets,
    KeychainSecretProvider, clearTestNamespace, createSavedHostSessions,
  } = production;
  const directory = fs.mkdtempSync(path.join(tempDirectory, "ssterm-auth-runtime-"));
  const namespace = `dev.ssterm.test.${randomUUID()}`;
  const transient = new TransientSecrets();
  const power = new EventEmitter();
  const requireTrue = (value, code) => {
    if (!value) throw new Error(`AUTH_FIXTURE_${code}`);
  };
  const value = (result) => {
    requireTrue(result.ok, `OPERATION_${result.error?.code || "FAILED"}`);
    return result.value;
  };
  let lab, repository, runtime;
  const ownedBytes = [];
  let result, leftovers;
  try {
    lab = await startFixture();
    repository = value(await openMetadata({ path: path.join(directory, "catalog.sqlite") }));
    const provider = new KeychainSecretProvider(namespace);
    let reads = 0;
    const readBuffers = [];
    const trackedProvider = {
      async read(item) {
        reads += 1;
        const read = await provider.read(item);
        if (read.status === "present") readBuffers.push(read.value);
        return read;
      },
      lookup: (item) => provider.lookup(item),
      write: (item, bytes) => provider.write(item, bytes),
      delete: (item) => provider.delete(item),
    };
    const service = new SecretService({ repository, provider, transient });
    const catalog = new CatalogModule({ repository });
    const perform = (intent) => value(catalog.apply(value(catalog.prepare(intent)).token));
    const secret = async (request) => {
      const published = await service.storeSecret(request);
      requireTrue(published.status === "published", "SECRET_PUBLICATION");
      return published;
    };
    const passwordIdentity = randomUUID();
    const passwordBytes = Buffer.from(lab.password);
    ownedBytes.push(passwordBytes, lab.privateKey);
    await secret({ kind: "password", owner: { type: "identity", id: passwordIdentity, expectedRevision: null },
      value: passwordBytes,
      publish: (ref) => [{ type: "create-identity", id: passwordIdentity,
        data: { label: "รหัสทดสอบ", username: lab.username, method: "password", passwordRef: ref } }],
    });
    const groupId = perform({ type: "create-group", data: {
      label: "Inherited auth", auth: { mode: "value", identityId: passwordIdentity },
      port: { mode: "value", port: lab.port },
    } }).createdIds[0];
    const hostId = perform({ type: "create-host", data: {
      label: "ระบบทดสอบ กรุงเทพ", address: lab.host, groupId, environment: "PROD",
    } }).createdIds[0];
    const updateHost = (data) => {
      const host = value(repository.snapshot()).hosts.find((row) => row.id === hostId);
      perform({ type: "update-host", id: hostId, expectedRevision: host.revision, data });
    };

    const plainEdFile = path.join(directory, "client_ed25519");
    fs.writeFileSync(plainEdFile, lab.privateKey, { mode: 0o600 });
    try {
      await run("ssh-keygen", ["-p", "-P", lab.passphrase, "-N", "", "-f", plainEdFile], { timeout: 10_000 });
    } catch { throw new Error("AUTH_FIXTURE_KEY_CONVERSION"); }
    const plainEd = fs.readFileSync(plainEdFile);
    ownedBytes.push(plainEd);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPlain = rsa.privateKey.export({ type: "pkcs1", format: "pem" });
    const rsaEncrypted = rsa.privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: lab.passphrase });
    const formats = [
      { name: "openssh-ed25519-encrypted", bytes: lab.privateKey, passphrase: lab.passphrase },
      { name: "openssh-ed25519", bytes: plainEd },
      { name: "pem-rsa-pkcs1", bytes: Buffer.from(rsaPlain) },
      { name: "pem-rsa-pkcs1-encrypted", bytes: Buffer.from(rsaEncrypted), passphrase: lab.passphrase },
    ];
    const keyIdentities = [];
    for (const format of formats) {
      ownedBytes.push(format.bytes);
      const parsedMany = utils.parseKey(format.bytes, format.passphrase);
      const parsed = Array.isArray(parsedMany) ? parsedMany[0] : parsedMany;
      requireTrue(!(parsed instanceof Error) && parsed.isPrivateKey(), "GENERATED_PRIVATE_KEY");
      const wire = parsed.getPublicSSH();
      const publicKey = `${parsed.type} ${wire.toString("base64")}`;
      if (format.name === "pem-rsa-pkcs1") {
        // Append only this generated public key to the owned lab account.
        try {
          await run("docker", ["exec", lab.container, "sh", "-c",
            'printf "%s\\n" "$1" >> /home/fixture/.ssh/authorized_keys', "fixture-key", publicKey], { timeout: 10_000 });
        } catch { throw new Error("AUTH_FIXTURE_PUBLIC_KEY_INSTALL"); }
      }
      const keyId = randomUUID();
      await secret({ kind: "private-key", owner: { type: "key", id: keyId, expectedRevision: null }, value: format.bytes,
        publish: (ref) => [{ type: "create-key", id: keyId, data: {
          label: format.name, algorithm: parsed.type, publicKey,
          fingerprint: `SHA256:${createHash("sha256").update(wire).digest("base64").replace(/=+$/u, "")}`,
          privateKeyRef: ref,
        } }],
      });
      if (format.passphrase) {
        const bytes = Buffer.from(format.passphrase);
        ownedBytes.push(bytes);
        await secret({ kind: "passphrase", owner: { type: "key", id: keyId, expectedRevision: 1 }, value: bytes });
      }
      keyIdentities.push({ name: format.name, id: perform({ type: "create-identity", data: {
        label: format.name, username: lab.username, method: "key", keyId,
      } }).createdIds[0] });
    }
    runtime = createSavedHostSessions({ repository, provider: trackedProvider, transient, power });
    const registry = runtime.registry;
    const owner = "window:991:1";
    const events = [];
    registry.subscribe(owner, (snapshot) => events.push(snapshot));
    const waitFor = async (id, predicate) => {
      for (let count = 0; count < 2000; count++) {
        const snapshot = registry.snapshot(owner, id)[0];
        if (predicate(snapshot)) return snapshot;
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error("AUTH_FIXTURE_STATE_TIMEOUT");
    };
    const attempt = async (decision = "remember") => {
      const before = reads;
      const opened = value(registry.connect(owner, hostId));
      let sawPrompt = false;
      const remove = registry.subscribe(owner, (snapshot) => {
        if (snapshot.id !== opened.id || !snapshot.prompt || sawPrompt) return;
        sawPrompt = true;
        requireTrue(reads === before, "CREDENTIALS_BEFORE_TRUST");
        queueMicrotask(() => {
          const prompt = snapshot.prompt;
          value(registry.answerPrompt(owner, opened.id, snapshot.generation, prompt.id,
            { kind: "host-trust", decision }));
        });
      });
      try {
        const state = await waitFor(opened.id, (s) => s.state === "Ready" || (s.state === "Failed" && s.cleanup !== "pending"));
        return { id: opened.id, state, sawPrompt, reads: reads - before };
      } finally { remove(); }
    };
    const close = async (entry) => {
      value(await registry.close(owner, entry.id));
      requireTrue(registry.snapshot(owner, entry.id)[0].cleanup === "complete", "CLEANUP");
      value(registry.forget(owner, entry.id));
    };
    const rejected = await attempt("reject");
    requireTrue(rejected.sawPrompt && rejected.state.error.code === "host-key-untrusted" && rejected.reads === 0, "REJECT_BEFORE_AUTH");
    await close(rejected);
    const password = await attempt();
    requireTrue(password.sawPrompt && password.state.state === "Ready" && password.reads === 1, "PASSWORD_READY");
    requireTrue(password.state.target.username === lab.username, "CAPTURED_TARGET");
    await close(password);
    const matched = await attempt();
    requireTrue(!matched.sawPrompt && matched.state.state === "Ready", "REMEMBERED_MATCH");
    await close(matched);
    const supported = [];
    for (const identity of keyIdentities) {
      updateHost({ auth: { mode: "value", identityId: identity.id } });
      const connected = await attempt();
      requireTrue(connected.state.state === "Ready", `KEY_${identity.name}_${connected.state.error?.code || "NOT_READY"}`);
      supported.push(identity.name);
      await close(connected);
    }
    updateHost({ auth: { mode: "inherit" } });
    const identity = value(repository.snapshot()).identities.find((row) => row.id === passwordIdentity);
    const badPassword = Buffer.from(`wrong-${randomUUID()}`);
    ownedBytes.push(badPassword);
    await secret({ kind: "password", owner: { type: "identity", id: passwordIdentity, expectedRevision: identity.revision },
      oldRef: identity.passwordRef, value: badPassword });
    const denied = await attempt();
    requireTrue(denied.state.state === "Failed" && denied.state.error.code === "auth-denied", "BAD_AUTH");
    await close(denied);
    const replaced = value(repository.snapshot()).identities.find((row) => row.id === passwordIdentity);
    await secret({ kind: "password", owner: { type: "identity", id: passwordIdentity, expectedRevision: replaced.revision },
      oldRef: replaced.passwordRef, value: passwordBytes });
    const fresh = await attempt();
    requireTrue(fresh.state.state === "Ready", "FRESH_SECRET_REFERENCE");
    await close(fresh);
    await lab.rotateHostKey();
    const changed = await attempt("reject");
    requireTrue(changed.sawPrompt && changed.state.error.code === "host-key-changed" && changed.reads === 0, "CHANGED_BEFORE_AUTH");
    await close(changed);
    const replacement = await attempt("replace");
    requireTrue(replacement.state.state === "Ready", "EXPLICIT_REPLACEMENT");
    power.emit("lock-screen");
    await waitFor(replacement.id, (s) => s.state === "Closed" && s.cleanup === "complete");
    requireTrue(!registry.connect(owner, hostId).ok, "LOCK_BLOCKS_CONNECT");
    const serialized = JSON.stringify(events);
    const databaseBytes = fs.readdirSync(directory).filter((name) => name.startsWith("catalog.sqlite"))
      .map((name) => fs.readFileSync(path.join(directory, name)));
    requireTrue(![lab.password, lab.passphrase, badPassword.toString(), "PRIVATE KEY", "passwordRef", "privateKeyRef"].some((needle) => serialized.includes(needle)), "PUBLIC_EVENT_PRIVACY");
    requireTrue(!databaseBytes.some((bytes) => [lab.password, lab.passphrase, badPassword.toString(), "PRIVATE KEY"].some((needle) => bytes.includes(Buffer.from(needle)))), "DATABASE_PRIVACY");
    requireTrue(readBuffers.every((bytes) => bytes.every((byte) => byte === 0)), "PROVIDER_BUFFER_WIPE");
    result = { password: true, supported, inheritedAuth: true, rememberedMatch: true,
      rejectBeforeCredentialRead: true, changedBeforeCredentialRead: true, explicitReplacement: true,
      badAuth: true, latestSecretReference: true, lockCleanup: true, safeEvents: true,
      noPlaintextMetadata: true, providerBuffersWiped: true };
  } finally {
    let cleanupFailed = false;
    const clean = async (action) => {
      try { await action(); } catch { cleanupFailed = true; }
    };
    // A failed cleanup must not leave the remaining owned credentials/resources behind.
    for (const bytes of ownedBytes) bytes.fill(0);
    await clean(() => runtime?.shutdown());
    await clean(() => transient.purgeAll());
    await clean(() => repository?.close());
    await clean(async () => { leftovers = await clearTestNamespace(namespace); });
    if (lab) {
      lab.privateKey.fill(0);
      await clean(() => lab.dispose());
      await clean(() => lab.assertCleaned());
    }
    await clean(() => fs.rmSync(directory, { recursive: true, force: true }));
    requireTrue(!cleanupFailed, "CLEANUP_FAILED");
  }
  requireTrue(leftovers === 0, "KEYCHAIN_LEFTOVERS");
  return { ...result, leftoverItems: leftovers, fixtureCleaned: true };
}

module.exports = { runSavedHostSmoke };
