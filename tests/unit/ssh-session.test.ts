import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import ssh2, { type Connection } from "ssh2";
import type { KeyMetadata, ResolvedHostConfig, SecretItem, SecretProvider, SecretRead } from "../../packages/domain/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { createSshConnection, preparePrivateKey } from "../../packages/adapters/src/ssh.ts";
import { createSavedHostSshAdapter, KnownHostPolicy, SessionRegistry, TransientSecrets, type SessionSnapshot } from "../../packages/services/src/index.ts";

const passphrase = Buffer.from("owned-fixture-passphrase");
const password = Buffer.from("owned-fixture-password");
const plainEd = Buffer.from(ssh2.utils.generateKeyPairSync("ed25519").private);
const encryptedEd = Buffer.from(ssh2.utils.generateKeyPairSync("ed25519", {
  passphrase, cipher: "aes256-cbc", rounds: 1,
}).private);
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const plainRsa = rsa.export({ type: "pkcs1", format: "pem" });
const encryptedRsa = rsa.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase });
const entity = { id: "fixture-key", vaultId: "fixture-vault", revision: 1, createdAt: "fixture", updatedAt: "fixture" };

function metadata(bytes: Uint8Array, phrase?: Uint8Array): KeyMetadata {
  const result = preparePrivateKey(bytes, phrase);
  assert(result.ok);
  const identity = result.key.identity;
  result.key.dispose();
  return { ...entity, ...identity, label: "Owned key", privateKeyRef: "fixture-private-ref", passphraseRef: phrase ? "fixture-phrase-ref" : null };
}
function config(port: number): ResolvedHostConfig {
  return {
    hostRef: { id: "fixture-host", revision: 1, label: "Owned SSH", groupId: null },
    address: "127.0.0.1", port: { value: port, source: { kind: "default" } }, environment: "PROD",
    auth: { selection: "identity", source: { kind: "default" }, key: null, identity: {
      ...entity, id: "fixture-identity", label: "Owned identity", username: "fixture",
      method: "password", passwordRef: "fixture-password-ref", keyId: null,
    } }, ancestry: [], catalogRevision: 1,
  };
}
async function until(check: () => boolean): Promise<void> {
  const limit = Date.now() + 5_000;
  while (!check() && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(check(), "Expected owned SSH fixture state within 5 seconds");
}
async function fixture(t: TestContext, options: { deny?: boolean; denyShell?: boolean; holdShell?: boolean; connectMs?: number } = {}) {
  const dir = mkdtempSync("/private/tmp/ssterm-ssh-session-");
  const opened = await openMetadata({ path: join(dir, "metadata.db") });
  assert(opened.ok);
  const repository = opened.value;
  const policy = new KnownHostPolicy({ repository });
  const clients: Connection[] = [];
  const methods: string[] = [];
  let shells = 0;
  let finishShell: (() => void) | undefined;
  const server = new ssh2.Server({ hostKeys: [plainEd] });
  server.on("connection", (client) => {
    clients.push(client);
    client.on("error", () => {});
    client.on("authentication", (auth) => {
      methods.push(auth.method);
      if (options.deny) { auth.reject(["password", "publickey", "keyboard-interactive"]); return; }
      if (auth.method === "password" && Buffer.from(auth.password).equals(password)) auth.accept();
      else if (auth.method === "publickey") auth.accept();
      else auth.reject(["password", "publickey"]);
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty?.());
      session.on("shell", (acceptShell, rejectShell) => {
        shells++;
        if (options.denyShell) { rejectShell?.(); return; }
        finishShell = () => { const channel = acceptShell(); channel.write("owned fixture output"); };
        if (!options.holdShell) finishShell();
      });
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const resolved = config(address.port);
  const reads: SecretItem[] = [];
  const returned: Uint8Array[] = [];
  let reader = async (_item: SecretItem): Promise<SecretRead> => ({ status: "present", value: Buffer.from(password) });
  const provider: SecretProvider = {
    async read(item) {
      reads.push(item);
      const result = await reader(item);
      if (result.status === "present") returned.push(result.value);
      return result;
    },
    async lookup() { return { status: "missing" }; },
    async write() { return { status: "confirmed" }; },
    async delete() { return { status: "missing" }; },
  };
  const registry = new SessionRegistry({
    resolve: () => ({ ok: true, value: resolved }),
    transient: new TransientSecrets(), adapter: createSavedHostSshAdapter({ provider, policy }),
    limits: { connectMs: options.connectMs ?? 10_000 },
  });
  const snapshots: SessionSnapshot[] = [];
  registry.subscribe("fixture-owner", (snapshot) => snapshots.push(snapshot));
  const current = () => registry.snapshot("fixture-owner")[0]!;
  t.after(async () => {
    await registry.dispose();
    for (const client of clients) client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    policy.dispose(); repository.close(); rmSync(dir, { recursive: true, force: true });
  });
  return {
    resolved, registry, methods, reads, returned, snapshots, current, clients, policy,
    shells: () => shells,
    finishShell: () => finishShell?.(),
    reader(read: typeof reader) { reader = read; },
    async connect() {
      assert(registry.connect("fixture-owner", "fixture-host").ok);
      await until(() => !!current().prompt || current().state === "Failed");
    },
    trust(decision: "accept-once" | "remember" | "reject" = "accept-once") {
      const snapshot = current(); assert(snapshot.prompt);
      assert(registry.answerPrompt("fixture-owner", snapshot.id, snapshot.generation, snapshot.prompt.id, { kind: "host-trust", decision }).ok);
    },
  };
}

test("single-key mature parser accepts guaranteed encrypted/plain Ed25519 OpenSSH and RSA PKCS1 formats", () => {
  for (const [bytes, phrase, algorithm] of [
    [plainEd, undefined, "ssh-ed25519"], [encryptedEd, passphrase, "ssh-ed25519"],
    [Buffer.from(plainRsa), undefined, "ssh-rsa"], [Buffer.from(encryptedRsa), passphrase, "ssh-rsa"],
  ] as const) {
    const parsed = preparePrivateKey(bytes, phrase);
    assert(parsed.ok);
    assert.equal(parsed.key.identity.algorithm, algorithm);
    assert.match(parsed.key.identity.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/u);
    parsed.key.dispose();
    if (phrase) {
      assert.deepEqual(preparePrivateKey(bytes), { ok: false, code: "credentials-required" });
      assert.deepEqual(preparePrivateKey(bytes, Buffer.from("wrong")), { ok: false, code: "invalid-private-key" });
    }
  }
  for (const bytes of [Buffer.from("not a key"), Buffer.from(rsa.export({ type: "pkcs8", format: "pem" })), Buffer.from(ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 }).private)])
    assert.deepEqual(preparePrivateKey(bytes), { ok: false, code: "unsupported-private-key" });
  for (const bytes of [Buffer.concat([plainEd, plainEd]), Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"), Buffer.alloc(0)])
    assert.deepEqual(preparePrivateKey(bytes), { ok: false, code: "invalid-private-key" });
});

test("actual wire trust precedes credential reads/authentication; Ready waits for shell and snapshots contain no secrets", async (t) => {
  const f = await fixture(t, { holdShell: true });
  await f.connect();
  assert.equal(f.current().state, "VerifyingHost");
  assert.equal(f.reads.length, 0); assert.deepEqual(f.methods, []);
  f.trust();
  await until(() => f.shells() === 1);
  assert.equal(f.current().state, "Authenticating");
  f.finishShell();
  await until(() => f.current().state === "Ready");
  assert.deepEqual(f.methods, ["password"]);
  assert(f.returned.every((value) => value.every((byte) => byte === 0)));
  const projection = JSON.stringify(f.snapshots);
  assert(!projection.includes(password.toString()) && !projection.includes("fixture-password-ref"));
  await f.registry.close("fixture-owner", f.current().id);
  assert.equal(f.current().cleanup, "complete");
});

test("host rejection and cancellation while trust is pending read/send no credentials", async (t) => {
  for (const end of ["reject", "cancel", "lock", "owner"] as const) {
    const f = await fixture(t);
    await f.connect();
    if (end === "reject") f.trust("reject");
    else if (end === "cancel") await f.registry.cancel("fixture-owner", f.current().id);
    else if (end === "lock") await f.registry.lock();
    else await f.registry.closeOwner("fixture-owner");
    await until(() => ["Closed", "Failed"].includes(f.current().state));
    assert.deepEqual(f.reads, []); assert.deepEqual(f.methods, []);
    if (end === "reject") assert.equal(f.current().error?.code, "host-key-untrusted");
  }
});

test("missing/locked/denied/unavailable/thrown credentials fail closed with finite outcomes and no auth attempt", async (t) => {
  for (const status of ["missing", "locked", "denied", "unavailable", "error", "throw", "oversize"] as const) {
    const f = await fixture(t);
    f.reader(async () => {
      if (status === "throw") throw new Error("fixture-sensitive-provider-detail");
      if (status === "oversize") return { status: "present", value: Buffer.alloc(16_385, 1) };
      if (status === "error") return { status: "error", code: "invalid" };
      return { status };
    });
    await f.connect(); f.trust();
    await until(() => f.current().state === "Failed" && f.current().cleanup === "complete");
    assert.equal(f.current().error?.code, status === "missing" ? "credentials-required" : "credentials-unavailable");
    assert.deepEqual(f.methods, []);
    assert(!JSON.stringify(f.current()).includes("fixture-sensitive"));
    assert(f.returned.every((value) => value.every((byte) => byte === 0)));
  }
});

test("late provider bytes after cancel/lock/owner teardown are wiped and never authenticate", async (t) => {
  for (const end of ["cancel", "lock", "owner"] as const) {
    const f = await fixture(t);
    let release!: (value: SecretRead) => void;
    f.reader(() => new Promise((resolve) => { release = resolve; }));
    await f.connect(); f.trust(); await until(() => f.reads.length === 1);
    if (end === "cancel") await f.registry.cancel("fixture-owner", f.current().id);
    else if (end === "lock") await f.registry.lock();
    else await f.registry.closeOwner("fixture-owner");
    const late = Buffer.from(password);
    release({ status: "present", value: late });
    await until(() => late.every((byte) => byte === 0));
    assert.deepEqual(f.methods, []); assert.equal(f.current().state, "Closed");
    assert.equal(f.current().cleanup, "complete");
  }
});

test("saved key formats authenticate only the selected method after exact public metadata validation", async (t) => {
  for (const [key, phrase] of [[plainEd, undefined], [encryptedEd, passphrase], [Buffer.from(plainRsa), undefined], [Buffer.from(encryptedRsa), passphrase]] as const) {
    const f = await fixture(t);
    f.resolved.auth.identity = { ...f.resolved.auth.identity!, method: "key", keyId: entity.id };
    f.resolved.auth.key = metadata(key, phrase);
    f.reader(async (item) => ({ status: "present", value: Buffer.from(item.kind === "passphrase" ? phrase! : key) }));
    await f.connect(); f.trust(); await until(() => f.current().state === "Ready");
    assert(f.methods.length >= 1 && f.methods.every((method) => method === "publickey"));
    assert.deepEqual(f.reads.map((item) => item.kind), phrase ? ["private-key", "passphrase"] : ["private-key"]);
    assert(f.returned.every((value) => value.every((byte) => byte === 0)));
  }
});

test("metadata mismatch, absent passphrase and malformed private key stop before any authentication", async (t) => {
  for (const fault of ["algorithm", "publicKey", "fingerprint", "passphrase", "malformed"] as const) {
    const f = await fixture(t);
    f.resolved.auth.identity = { ...f.resolved.auth.identity!, method: "key", keyId: entity.id };
    const saved = metadata(encryptedEd, passphrase);
    if (fault === "algorithm") saved.algorithm = "ssh-rsa";
    if (fault === "publicKey") saved.publicKey = metadata(plainEd).publicKey;
    if (fault === "fingerprint") saved.fingerprint = metadata(plainEd).fingerprint;
    if (fault === "passphrase") saved.passphraseRef = null;
    f.resolved.auth.key = saved;
    f.reader(async (item) => ({ status: "present", value: Buffer.from(item.kind === "passphrase" ? passphrase : fault === "malformed" ? "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----" : encryptedEd) }));
    await f.connect(); f.trust(); await until(() => f.current().state === "Failed");
    assert.equal(f.current().error?.code, fault === "passphrase" ? "credentials-required" : fault === "malformed" ? "invalid-private-key" : "key-mismatch");
    assert.deepEqual(f.methods, []);
  }
});

test("auth denial does not fall back; channel rejection has a finite error; remote close cleans resources", async (t) => {
  for (const mode of ["deny", "denyShell", "close"] as const) {
    const f = await fixture(t, { deny: mode === "deny", denyShell: mode === "denyShell" });
    await f.connect(); f.trust();
    if (mode === "close") {
      await until(() => f.current().state === "Ready"); f.clients[0]!.end();
      await until(() => f.current().state === "Closed");
    } else {
      await until(() => f.current().state === "Failed");
      assert.equal(f.current().error?.code, mode === "deny" ? "auth-denied" : "channel-open-failed");
    }
    await until(() => f.current().cleanup === "complete");
    assert.deepEqual(f.methods, ["password"]);
  }
});

test("a never-started or pre-aborted transport drains without allocating a socket", async () => {
  for (const abortFirst of [false, true]) {
    const controller = new AbortController(); if (abortFirst) controller.abort();
    const connection = createSshConnection({
      host: "127.0.0.1", port: 1, username: "fixture", signal: controller.signal,
      async verifyHost() { assert.fail("unexpected verification"); },
      async authenticate() { assert.fail("unexpected authentication"); },
      ready() { assert.fail("unexpected ready"); }, failed() { assert.fail("unexpected failure"); }, ended() { assert.fail("unexpected end"); },
    });
    connection.dispose(); connection.dispose(); connection.start(); await connection.drained;
  }
});

test("DNS and SSH handshake timeout failures are sanitized and drain without reading credentials", async (t) => {
  for (const [details, expected] of [
    [{ code: "ENOTFOUND", level: "client-socket" }, "dns"],
    [{ code: "EAI_AGAIN", level: "client-socket" }, "dns"],
    [{ code: "ETIMEDOUT", level: "client-socket" }, "timeout"],
    [{ level: "client-timeout" }, "timeout"],
  ] as const) {
    const f = await fixture(t);
    // Inject the same error/close events emitted by ssh2. No external DNS is queried.
    const mocked = t.mock.method(ssh2.Client.prototype, "connect", function (this: ssh2.Client) {
      queueMicrotask(() => {
        this.emit("error", Object.assign(new Error("fixture-sensitive-DNS-address-and-provider-detail"), details));
        this.emit("close");
      });
      return this;
    });
    try {
      await f.connect();
      await until(() => f.current().cleanup === "complete");
      assert.equal(f.current().state, "Failed");
      assert.equal(f.current().error?.code, expected);
      assert.deepEqual(f.reads, []);
      assert.deepEqual(f.methods, []);
      assert(!JSON.stringify(f.snapshots).includes("fixture-sensitive"));
    } finally { mocked.mock.restore(); }
  }
});

test("connection deadline tears down a real owned TCP peer withholding the SSH handshake", async (t) => {
  const f = await fixture(t, { connectMs: 50 });
  const sockets: Socket[] = [];
  let closed = false;
  const stalled = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("close", () => { closed = true; });
    // Consume the client's identification without sending the server identification.
    socket.resume();
  });
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => stalled.close(() => resolve()));
  });
  const address = stalled.address(); assert(address && typeof address !== "string");
  f.resolved.port.value = address.port;
  await f.connect();
  await until(() => f.current().cleanup === "complete" && closed);
  assert.equal(f.current().error?.code, "timeout");
  assert.equal(f.current().state, "Failed");
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.methods, []);
});

test("server rekey uses shared trust policy without another authentication transition and fails closed after revocation", async (t) => {
  const f = await fixture(t);
  await f.connect(); f.trust("remember");
  await until(() => f.current().state === "Ready");
  let rekeyed = false;
  f.clients[0]!.rekey(() => { rekeyed = true; });
  await until(() => rekeyed);
  assert.equal(f.current().state, "Ready");
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.methods, ["password"]);
  assert.equal(f.snapshots.filter((snapshot) => snapshot.state === "Authenticating").length, 1);

  const listed = f.policy.list(); assert(listed.ok);
  const row = listed.value[0]!;
  const revoke = f.policy.prepareRevoke("fixture-owner", row.id, row.revision); assert(revoke.ok);
  assert(f.policy.revoke("fixture-owner", revoke.value.token).ok);
  f.clients[0]!.rekey();
  await until(() => f.current().state === "Failed" && f.current().cleanup === "complete");
  assert.equal(f.current().error?.code, "host-key-untrusted");
  assert.equal(f.current().prompt, undefined);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.methods, ["password"]);
});
