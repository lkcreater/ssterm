import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { connect as connectTcp, createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import ssh2, { type Connection, type KeyboardAuthContext, type ServerChannel, type Session, type WindowChangeInfo } from "ssh2";
import type { KeyMetadata, ResolvedHostConfig, SecretItem, SecretProvider, SecretRead } from "../../packages/domain/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { createSshConnection, preparePrivateKey, TERMINAL_OUTPUT_WINDOW, TERMINAL_INPUT_BACKLOG, TERMINAL_BUFFER_LIMIT, TERMINAL_CHUNK_LIMIT, terminalBounds, type TerminalBounds, sshKeepalive, type SshKeepalive } from "../../packages/adapters/src/ssh.ts";
import { MAX_TERMINAL_WRITE } from "../../packages/contracts/src/index.ts";
import { createSavedHostSessions } from "../../apps/desktop/src/main/ssh.ts";
import { ed25519 } from "./ssh-keys.ts";
import { createSavedHostSshAdapter, KnownHostPolicy, SecretService, SessionRegistry, TransientSecrets, type SessionSnapshot } from "../../packages/services/src/index.ts";

const passphrase = Buffer.from("owned-fixture-passphrase");
const password = Buffer.from("owned-fixture-password");
const plainEd = Buffer.from(ed25519().private);
const encryptedEd = Buffer.from(ed25519({ passphrase, cipher: "aes256-cbc", rounds: 1 }).private);
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
function credentials(snapshot: SessionSnapshot) {
  const prompt = snapshot.prompt;
  return prompt?.kind === "credentials" ? prompt : undefined;
}
function answerCredentials(registry: SessionRegistry, snapshot: SessionSnapshot, values: readonly string[]): void {
  const prompt = snapshot.prompt;
  assert(prompt?.kind === "credentials");
  assert.equal(values.length, prompt.fields.length);
  const input = values.map((value, index) => ({ id: prompt.fields[index]!.id, value: Buffer.from(value) }));
  try {
    assert(registry.answerPrompt("fixture-owner", snapshot.id, snapshot.generation, prompt.id, { kind: "credentials", values: input }).ok);
  } finally { for (const field of input) field.value.fill(0); }
}
async function fixture(t: TestContext, options: { deny?: boolean; denyShell?: boolean; holdShell?: boolean; connectMs?: number; promptMs?: number; terminal?: TerminalBounds; keepalive?: SshKeepalive; interactive?: (auth: KeyboardAuthContext) => void; shell?: (channel: ServerChannel, session: Session) => void } = {}) {
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
      if (auth.method === "keyboard-interactive" && options.interactive) { options.interactive(auth); return; }
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
        finishShell = () => {
          const channel = acceptShell();
          if (options.shell) options.shell(channel, session); else channel.write("owned fixture output");
        };
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
    transient: new TransientSecrets(), adapter: createSavedHostSshAdapter({ provider, policy, terminal: options.terminal, keepalive: options.keepalive }),
    limits: { connectMs: options.connectMs ?? 10_000, promptMs: options.promptMs ?? 60_000 },
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

test("an OpenSSH bcrypt cost above 256 rounds is refused from the header before ssh2 runs it", () => {
  const pem = (rounds: number) => ed25519({ passphrase, cipher: "aes256-ctr", rounds }).private;
  /** Rewrites only the kdfoptions rounds field of a real file. */
  const withRounds = (text: string, rounds: number) => {
    const lines = text.trim().split("\n");
    const body = Buffer.from(lines.slice(1, -1).join(""), "base64");
    let at = 15;
    for (let skip = 0; skip < 2; skip++) at += 4 + body.readUInt32BE(at);
    const options = at + 4;
    body.writeUInt32BE(rounds, options + 4 + body.readUInt32BE(options));
    return Buffer.from(`${lines[0]}\n${body.toString("base64").match(/.{1,70}/gu)!.join("\n")}\n${lines.at(-1)}\n`);
  };
  const sixteen = pem(16);
  for (const rounds of [257, 1_000_000, 0]) {
    const crafted = withRounds(sixteen, rounds);
    const started = performance.now();
    assert.deepEqual(preparePrivateKey(crafted, passphrase), { ok: false, code: "unsupported-private-key" }, String(rounds));
    assert.deepEqual(preparePrivateKey(crafted), { ok: false, code: "unsupported-private-key" }, "refused before a passphrase is asked");
    assert.ok(performance.now() - started < 50, `${rounds} rounds took ${performance.now() - started} ms`);
  }
  for (const text of [sixteen, pem(100)]) {
    const parsed = preparePrivateKey(Buffer.from(text), passphrase);
    assert(parsed.ok);
    parsed.key.dispose();
  }
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
  for (const status of ["locked", "denied", "unavailable", "error", "throw", "oversize"] as const) {
    const f = await fixture(t);
    f.reader(async () => {
      if (status === "throw") throw new Error("fixture-sensitive-provider-detail");
      if (status === "oversize") return { status: "present", value: Buffer.alloc(16_385, 1) };
      if (status === "error") return { status: "error", code: "invalid" };
      return { status };
    });
    await f.connect(); f.trust();
    await until(() => f.current().state === "Failed" && f.current().cleanup === "complete");
    assert.equal(f.current().error?.code, "credentials-unavailable");
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
    await f.connect(); f.trust();
    if (fault === "passphrase") {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await until(() => f.current().state === "AwaitingInput" && f.current().prompt?.kind === "credentials" && credentials(f.current())?.attempt === attempt);
        answerCredentials(f.registry, f.current(), ["wrong-fixture-phrase"]);
      }
    }
    await until(() => f.current().state === "Failed");
    assert.equal(f.current().error?.code, fault === "passphrase" || fault === "malformed" ? "invalid-private-key" : "key-mismatch");
    assert.deepEqual(f.methods, []);
  }
});

test("auth denial does not fall back; channel rejection has a finite error; connection loss after Ready fails and cleans resources", async (t) => {
  for (const mode of ["deny", "denyShell", "close"] as const) {
    const f = await fixture(t, { deny: mode === "deny", denyShell: mode === "denyShell" });
    await f.connect(); f.trust();
    if (mode === "close") {
      await until(() => f.current().state === "Ready"); f.clients[0]!.end();
      await until(() => f.current().state === "Failed");
      assert.equal(f.current().error?.code, "network");
      assert.equal(f.current().end, undefined);
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

test("missing saved passwords prompt transiently after trust without storing an answer", async (t) => {
  for (const missing of ["reference", "provider"] as const) {
    const f = await fixture(t);
    if (missing === "reference") f.resolved.auth.identity = { ...f.resolved.auth.identity!, passwordRef: null };
    else f.reader(async () => ({ status: "missing" }));
    await f.connect(); assert.deepEqual(f.reads, []); f.trust();
    await until(() => f.current().state === "AwaitingInput");
    const prompt = f.current().prompt;
    assert(prompt?.kind === "credentials");
    assert.equal(prompt.purpose, "password"); assert.equal(prompt.attempt, 1);
    answerCredentials(f.registry, f.current(), [password.toString()]);
    await until(() => f.current().state === "Ready");
    assert.deepEqual(f.methods, ["password"]);
    assert(!JSON.stringify(f.snapshots).includes(password.toString()));
  }
});

test("incorrect saved and entered passphrases retry locally, and a correct answer opens the selected key", async (t) => {
  const f = await fixture(t);
  f.resolved.auth.identity = { ...f.resolved.auth.identity!, method: "key", keyId: entity.id };
  f.resolved.auth.key = metadata(encryptedEd, passphrase);
  f.reader(async (item) => ({ status: "present", value: Buffer.from(item.kind === "passphrase" ? "incorrect-saved-phrase" : encryptedEd) }));
  await f.connect(); f.trust();
  for (const [index, phrase] of ["incorrect-entered-phrase", passphrase.toString()].entries()) {
    await until(() => f.current().state === "AwaitingInput" && f.current().prompt?.kind === "credentials" && credentials(f.current())?.attempt === index + 1);
    assert.deepEqual(f.methods, []);
    assert.equal(f.current().prompt?.kind === "credentials" && credentials(f.current())?.purpose, "passphrase");
    answerCredentials(f.registry, f.current(), [phrase]);
  }
  await until(() => f.current().state === "Ready");
  assert(f.methods.every((method) => method === "publickey"));
  assert(f.returned.every((value) => value.every((byte) => byte === 0)));
});

test("credential prompt cancel, timeout, lock and owner close fence late answers", async (t) => {
  for (const end of ["cancel", "timeout", "lock", "owner"] as const) {
    const f = await fixture(t, { promptMs: end === "timeout" ? 50 : 60_000 });
    f.resolved.auth.identity = { ...f.resolved.auth.identity!, passwordRef: null };
    await f.connect(); f.trust(); await until(() => f.current().state === "AwaitingInput");
    const snapshot = f.current(); assert(snapshot.prompt);
    if (end === "cancel") assert(f.registry.cancelPrompt("fixture-owner", snapshot.id, snapshot.generation, snapshot.prompt.id).ok);
    else if (end === "lock") await f.registry.lock();
    else if (end === "owner") await f.registry.closeOwner("fixture-owner");
    await until(() => ["Failed", "Closed"].includes(f.current().state) && f.current().cleanup === "complete");
    if (end === "cancel" || end === "timeout") assert.equal(f.current().error?.code, end === "cancel" ? "prompt-cancelled" : "timeout");
    assert(!f.registry.answerPrompt("fixture-owner", snapshot.id, snapshot.generation, snapshot.prompt.id, { kind: "credentials", values: [{ id: "password", value: Buffer.from(password) }] }).ok);
    assert.deepEqual(f.methods, []);
  }
});

test("keyboard-interactive supports zero-field and multiple echo-aware rounds without exposing upstream text", async (t) => {
  const received: string[][] = [];
  const f = await fixture(t, {
    interactive(auth) {
      auth.prompt([], "fixture-sensitive-title", "fixture-sensitive-instructions", (empty) => {
        assert.deepEqual(empty, []);
        auth.prompt([{ prompt: "fixture-sensitive-OTP", echo: false }, { prompt: "fixture-sensitive-public", echo: true }], "fixture-sensitive-title", (first) => {
          received.push(first);
          auth.prompt([{ prompt: "fixture-sensitive-final", echo: false }], "fixture-sensitive-title", (second) => { received.push(second); auth.accept(); });
        });
      });
    },
  });
  f.resolved.auth.identity = { ...f.resolved.auth.identity!, method: "keyboard-interactive", passwordRef: null };
  await f.connect(); f.trust();
  await until(() => f.current().state === "AwaitingInput");
  let prompt = f.current().prompt; assert(prompt?.kind === "credentials");
  assert.equal(prompt.purpose, "keyboard-interactive");
  assert.deepEqual(prompt.fields, [{ id: "response-1", echo: false }, { id: "response-2", echo: true }]);
  answerCredentials(f.registry, f.current(), ["fixture-otp", "fixture-account"]);
  await until(() => f.current().state === "AwaitingInput" && f.current().prompt?.kind === "credentials" && credentials(f.current())?.attempt === 2);
  prompt = f.current().prompt; assert(prompt?.kind === "credentials");
  assert.deepEqual(prompt.fields, [{ id: "response-1", echo: false }]);
  answerCredentials(f.registry, f.current(), ["fixture-final"]);
  await until(() => f.current().state === "Ready");
  assert.deepEqual(received, [["fixture-otp", "fixture-account"], ["fixture-final"]]);
  assert.deepEqual(f.methods, ["keyboard-interactive"]); assert.deepEqual(f.reads, []);
  assert(!/fixture-sensitive|fixture-otp|fixture-account|fixture-final/u.test(JSON.stringify(f.snapshots)));
});

test("keyboard-interactive rejects excessive fields/rounds and server denial without authentication fallback", async (t) => {
  for (const mode of ["fields", "rounds", "deny"] as const) {
    const f = await fixture(t, {
      interactive(auth) {
        let count = 0;
        const ask = () => {
          count++;
          auth.prompt(Array.from({ length: mode === "fields" ? 9 : 1 }, () => ({ prompt: "fixture-untrusted-text", echo: false })), "fixture-title", () => {
            if (mode === "deny") auth.reject(["password", "keyboard-interactive"]);
            else if (count < 4) ask();
          });
        };
        ask();
      },
    });
    f.resolved.auth.identity = { ...f.resolved.auth.identity!, method: "keyboard-interactive" };
    await f.connect(); f.trust();
    if (mode !== "fields") {
      for (let round = 1; round <= (mode === "rounds" ? 3 : 1); round++) {
        await until(() => f.current().state === "AwaitingInput" && f.current().prompt?.kind === "credentials" && credentials(f.current())?.attempt === round);
        answerCredentials(f.registry, f.current(), ["fixture-response"]);
      }
    }
    await until(() => f.current().state === "Failed" && f.current().cleanup === "complete");
    assert.equal(f.current().error?.code, mode === "deny" ? "auth-denied" : "resource-limit");
    assert.deepEqual(f.methods, ["keyboard-interactive"]);
  }
});

test("a late passphrase provider response after abort is wiped and never starts authentication", async (t) => {
  const f = await fixture(t);
  f.resolved.auth.identity = { ...f.resolved.auth.identity!, method: "key", keyId: entity.id };
  f.resolved.auth.key = metadata(encryptedEd, passphrase);
  let release!: (value: SecretRead) => void;
  f.reader(async (item) => item.kind === "private-key" ? { status: "present", value: Buffer.from(encryptedEd) } : new Promise((resolve) => { release = resolve; }));
  await f.connect(); f.trust(); await until(() => f.reads.length === 2);
  await f.registry.cancel("fixture-owner", f.current().id);
  const late = Buffer.from(passphrase); release({ status: "present", value: late });
  await until(() => late.every((byte) => byte === 0));
  assert(f.returned.every((value) => value.every((byte) => byte === 0)));
  assert.deepEqual(f.methods, []); assert.equal(f.current().cleanup, "complete");
});

test("simultaneous credential prompts keep their captured session target and reject crossed answers", async (t) => {
  const f = await fixture(t);
  f.resolved.auth.identity = { ...f.resolved.auth.identity!, passwordRef: null };
  assert(f.registry.connect("fixture-owner", "fixture-host").ok);
  assert(f.registry.connect("fixture-owner", "fixture-host").ok);
  await until(() => f.registry.snapshot("fixture-owner").filter((session) => session.prompt?.kind === "host-trust").length === 2);
  for (const snapshot of f.registry.snapshot("fixture-owner")) {
    assert(snapshot.prompt);
    assert(f.registry.answerPrompt("fixture-owner", snapshot.id, snapshot.generation, snapshot.prompt.id, { kind: "host-trust", decision: "accept-once" }).ok);
  }
  await until(() => f.registry.snapshot("fixture-owner").every((session) => session.state === "AwaitingInput"));
  const [first, second] = f.registry.snapshot("fixture-owner"); assert(first?.prompt && second?.prompt);
  assert(!f.registry.answerPrompt("fixture-owner", first.id, first.generation, second.prompt.id, { kind: "credentials", values: [{ id: "password", value: Buffer.from(password) }] }).ok);
  answerCredentials(f.registry, second, [password.toString()]);
  await until(() => f.registry.snapshot("fixture-owner").find((session) => session.id === second.id)?.state === "Ready");
  assert.equal(f.registry.snapshot("fixture-owner").find((session) => session.id === first.id)?.state, "AwaitingInput");
  answerCredentials(f.registry, first, [password.toString()]);
  await until(() => f.registry.snapshot("fixture-owner").every((session) => session.state === "Ready"));
});

test("missing private keys and unavailable stored passphrases never become credential prompts", async (t) => {
  for (const outcome of ["missing-key", "locked-phrase", "denied-phrase", "unavailable-phrase"] as const) {
    const f = await fixture(t);
    f.resolved.auth.identity = { ...f.resolved.auth.identity!, method: "key", keyId: entity.id };
    f.resolved.auth.key = metadata(encryptedEd, passphrase);
    f.reader(async (item) => {
      if (outcome === "missing-key") return { status: "missing" };
      if (item.kind === "private-key") return { status: "present", value: Buffer.from(encryptedEd) };
      return { status: outcome === "locked-phrase" ? "locked" : outcome === "denied-phrase" ? "denied" : "unavailable" };
    });
    await f.connect(); f.trust();
    await until(() => f.current().state === "Failed" && f.current().cleanup === "complete");
    assert.equal(f.current().error?.code, outcome === "missing-key" ? "credentials-required" : "credentials-unavailable");
    assert(!f.snapshots.some((snapshot) => snapshot.prompt?.kind === "credentials"));
    assert.deepEqual(f.methods, []);
  }
});

test("cancelled and timed-out keyboard challenges never send late responses", async (t) => {
  for (const end of ["cancel", "timeout"] as const) {
    let responses = 0;
    const f = await fixture(t, {
      promptMs: end === "timeout" ? 50 : 60_000,
      interactive(auth) { auth.prompt([{ prompt: "fixture-sensitive-otp", echo: false }], "fixture-title", () => { responses++; auth.accept(); }); },
    });
    f.resolved.auth.identity = { ...f.resolved.auth.identity!, method: "keyboard-interactive" };
    await f.connect(); f.trust(); await until(() => f.current().state === "AwaitingInput");
    const snapshot = f.current(); assert(snapshot.prompt);
    if (end === "cancel") assert(f.registry.cancelPrompt("fixture-owner", snapshot.id, snapshot.generation, snapshot.prompt.id).ok);
    await until(() => f.current().state === "Failed" && f.current().cleanup === "complete");
    assert.equal(f.current().error?.code, end === "cancel" ? "prompt-cancelled" : "timeout");
    assert(!f.registry.answerPrompt("fixture-owner", snapshot.id, snapshot.generation, snapshot.prompt.id, { kind: "credentials", values: [{ id: "response-1", value: Buffer.from("late-owned-otp") }] }).ok);
    assert.equal(responses, 0);
    assert.deepEqual(f.methods, ["keyboard-interactive"]);
  }
});

const owner = "fixture-owner";
async function readyStream(f: Awaited<ReturnType<typeof fixture>>) {
  await f.connect(); f.trust(); await until(() => f.current().state === "Ready");
  const { id, generation } = f.current();
  const stream = f.registry.terminal(owner, id, generation);
  assert(stream);
  return stream;
}
const length = (chunks: readonly Uint8Array[]) => chunks.reduce((total, chunk) => total + chunk.length, 0);

for (const credit of [TERMINAL_OUTPUT_WINDOW, 65_536]) test(`terminal output is held until open, then merges stdout/stderr in arrival order as owned chunks with consecutive sequences and bounded credit (window ${credit})`, async (t) => {
  let server!: ServerChannel;
  const f = await fixture(t, { terminal: { outputWindow: credit }, shell(channel) { server = channel; channel.write("pre-open|"); } });
  const stream = await readyStream(f);
  await delay(50);
  const chunks: Uint8Array[] = [], sequences: number[] = [];
  let unacked = 0, maxUnacked = 0, largest = 0;
  stream.open((chunk, sequence) => {
    chunks.push(chunk); sequences.push(sequence);
    unacked += chunk.length; maxUnacked = Math.max(maxUnacked, unacked); largest = Math.max(largest, chunk.length);
  });
  stream.open(() => assert.fail("a second consumer must be ignored"));
  const settle = async (expected: string) => {
    await until(() => Buffer.concat(chunks).toString() === expected);
    stream.ack(unacked); unacked = 0;
  };
  await settle("pre-open|");
  server.write("A"); await settle("pre-open|A");
  server.stderr.write("B"); await settle("pre-open|AB");
  server.write("C"); await settle("pre-open|ABC");

  const bulk = Buffer.from(Array.from({ length: 300_000 }, (_, index) => `${String(index).padStart(10, "0")}\n`).join(""));
  assert(bulk.length >= 3 * 1_048_576);
  const expected = Buffer.concat([Buffer.from("pre-open|ABC"), bulk]);
  server.write(bulk);
  let stalls = 0;
  while (length(chunks) < expected.length) {
    await until(() => unacked >= credit || length(chunks) === expected.length);
    if (unacked >= credit) {
      const held = length(chunks);
      await delay(30);
      assert.equal(length(chunks), held, "output must stop while the credit window is exhausted");
      stalls++;
    }
    stream.ack(unacked); unacked = 0;
  }
  assert(stalls >= 10, `expected repeated credit pauses, saw ${stalls}`);
  assert(maxUnacked <= credit + largest);
  assert(Buffer.concat(chunks).equals(expected));
  assert.deepEqual(sequences, sequences.map((_, index) => index));
  assert(chunks.every((chunk) => chunk.byteOffset === 0 && chunk.buffer.byteLength === chunk.byteLength));
});

test("terminal input reaches the remote in call order from owned copies", async (t) => {
  const inbound: Buffer[] = [];
  const f = await fixture(t, { shell(channel) { channel.on("data", (data: Buffer) => inbound.push(Buffer.from(data))); } });
  const stream = await readyStream(f);
  let expected = "";
  for (let index = 0; index < 1000; index++) {
    const bytes = Buffer.from(`${index},`);
    expected += `${index},`;
    assert.equal(stream.write(bytes), "ok");
    bytes.fill(0);
  }
  await until(() => length(inbound) >= expected.length);
  assert.equal(Buffer.concat(inbound).toString(), expected);
});

test("maximum-size writes are accepted whole or refused with nothing queued, and writes after the remote end are closed", async (t) => {
  // An idle session always takes one maximum write, so a bracketed paste is never split.
  assert(TERMINAL_INPUT_BACKLOG >= MAX_TERMINAL_WRITE);
  let server!: ServerChannel;
  const f = await fixture(t, { shell(channel) { server = channel; channel.pause(); } });
  const stream = await readyStream(f);
  stream.open(() => {});
  const accepted: Buffer[] = [];
  let result: string = "ok";
  for (let index = 0; index < 256 && result === "ok"; index++) {
    const bytes = Buffer.alloc(MAX_TERMINAL_WRITE, (index % 250) + 1);
    result = stream.write(bytes);
    if (result === "ok") accepted.push(Buffer.from(bytes));
    bytes.fill(0);
  }
  assert.equal(result, "busy");
  assert(accepted.length >= 1, "the first maximum write on an idle session is accepted");
  assert.equal(stream.write(Buffer.alloc(MAX_TERMINAL_WRITE, 0xff)), "busy");
  const inbound: Buffer[] = [];
  server.on("data", (data: Buffer) => inbound.push(Buffer.from(data)));
  server.resume();
  const sent = Buffer.concat(accepted);
  await until(() => length(inbound) >= sent.length);
  await delay(30);
  assert(Buffer.concat(inbound).equals(sent), "accepted input arrives intact and refused input is never sent");
  server.end();
  await until(() => f.current().state === "Closed");
  assert.deepEqual(f.current().end, { kind: "eof" });
  assert.equal(stream.write(Buffer.from("late")), "closed");
});

test("main validates terminal stream bounds when the saved-host composition is constructed", async (t) => {
  const dir = mkdtempSync("/private/tmp/ssterm-ssh-bounds-");
  const opened = await openMetadata({ path: join(dir, "metadata.db") });
  assert(opened.ok);
  t.after(() => { opened.value.close(); rmSync(dir, { recursive: true, force: true }); });
  const build = (terminal: TerminalBounds) => createSavedHostSessions({
    repository: opened.value, transient: new TransientSecrets(), power: new EventEmitter(), terminal,
  });
  for (const terminal of [
    { outputWindow: 65_535 }, { outputWindow: 1_048_577 }, { outputWindow: 131_072.5 }, { outputWindow: Number.NaN },
    { inputBacklog: MAX_TERMINAL_WRITE - 1 }, { inputBacklog: 2_097_153 }, { inputBacklog: "524288" as unknown as number },
  ]) assert.throws(() => build(terminal), RangeError, JSON.stringify(terminal));
  for (const terminal of [{}, { outputWindow: 65_536, inputBacklog: MAX_TERMINAL_WRITE }, { outputWindow: 1_048_576, inputBacklog: 2_097_152 }]) {
    const runtime = build(terminal);
    await runtime.shutdown();
  }
  // The adapter applies the same ranges wherever defaults are applied, and returns a frozen copy.
  for (const terminal of [{ inputBacklog: 0 }, { inputBacklog: 2_097_153 }, { outputWindow: 65_535 }, { outputWindow: null as unknown as number }])
    assert.throws(() => terminalBounds(terminal), RangeError, JSON.stringify(terminal));
  assert.throws(() => createSshConnection({
    host: "127.0.0.1", port: 22, username: "u", signal: new AbortController().signal, terminal: { inputBacklog: 1.5 },
    verifyHost: async () => false, authenticate: async () => undefined, ready: () => false, failed() {}, ended() {},
  }), RangeError);
  const caller = { inputBacklog: 1 };
  const copy = terminalBounds(caller);
  caller.inputBacklog = 9e9;
  assert.deepEqual(copy, { outputWindow: TERMINAL_OUTPUT_WINDOW, inputBacklog: 1 });
  assert(Object.isFrozen(copy));
});

test("the input backlog counts bytes ssh2 already queued on its TCP socket", async (t) => {
  const connect = ssh2.Client.prototype.connect;
  const sshClients: ssh2.Client[] = [];
  t.mock.method(ssh2.Client.prototype, "connect", function (this: ssh2.Client, ...args: Parameters<typeof connect>) {
    sshClients.push(this);
    return connect.apply(this, args);
  });
  const f = await fixture(t, { terminal: { inputBacklog: MAX_TERMINAL_WRITE } });
  const stream = await readyStream(f);
  const socket = (sshClients[0] as unknown as { _sock: { writableLength: number } })._sock;
  Object.defineProperty(socket, "writableLength", { configurable: true, get: () => 1 });
  assert.equal(stream.write(Buffer.alloc(MAX_TERMINAL_WRITE)), "busy", "a full socket queue refuses a write the channel alone would take");
  assert.equal(stream.write(Buffer.alloc(MAX_TERMINAL_WRITE - 1)), "ok");
});

// A peer that ignores flow control: the server's own view of the client window is overridden, so it never waits.
async function hostileFixture(t: TestContext, send: (channel: ServerChannel, stopped: () => boolean) => void) {
  let stopped = false;
  const f = await fixture(t, { terminal: { outputWindow: 65_536 }, shell(channel) {
    channel.on("error", () => {});
    channel.on("close", () => { stopped = true; });
    send(channel, () => stopped);
  } });
  const stream = await readyStream(f);
  let delivered = 0, frames = 0;
  // The consumer never acknowledges, so the adapter pauses after one window.
  stream.open((chunk) => { delivered += chunk.length; frames++; });
  try { await until(() => f.current().state === "Failed"); } finally { stopped = true; }
  return { f, delivered: () => delivered, frames: () => frames };
}

test("a peer that overruns the SSH window fails the session with resource-limit before buffering past the cap", async (t) => {
  const block = Buffer.alloc(32_767, 0x61);
  const total = 64 * 1_048_576;
  let written = 0;
  const h = await hostileFixture(t, (channel, stopped) => {
    channel.write("x"); // the client window then never lands exactly on 0, where ssh2 drops data silently
    setTimeout(() => {
      (channel as unknown as { outgoing: { window: number } }).outgoing.window = 1e12;
      const pump = () => {
        if (stopped() || written >= total) return;
        for (let index = 0; index < 8; index++) { channel.write(block); written += block.length; }
        setImmediate(pump);
      };
      pump();
    }, 50);
  });
  assert.equal(h.f.current().error?.code, "resource-limit");
  assert(h.delivered() <= 65_536 + 32_768, `delivered ${h.delivered()}`);
  // Flow control would stop a compliant peer near 4 MiB; this one was cut off long before its 64 MiB.
  assert(written > TERMINAL_BUFFER_LIMIT && written < total / 2, `peer wrote ${written} bytes before the failure`);
  await until(() => h.f.current().cleanup === "complete");
});

test("many tiny packets held behind exhausted credit fail with resource-limit at the chunk cap", async (t) => {
  const one = Buffer.from("x");
  let written = 0;
  const h = await hostileFixture(t, (channel, stopped) => {
    const pump = () => {
      if (stopped()) return;
      for (let index = 0; index < 2_000; index++) { channel.write(one); written++; }
      setImmediate(pump);
    };
    pump();
  });
  assert.equal(h.f.current().error?.code, "resource-limit");
  assert.equal(h.frames(), 65_536, "one window of 1-byte frames, then output pauses");
  // The trip happens on the first chunk over the cap; anything beyond was still in flight.
  assert(written > 65_536 + TERMINAL_CHUNK_LIMIT && written < 65_536 + 3 * TERMINAL_CHUNK_LIMIT, `peer wrote ${written} packets`);
  await until(() => h.f.current().cleanup === "complete");
});

test("a compliant flood held by a stalled consumer never trips the buffering caps", async (t) => {
  let server!: ServerChannel;
  const f = await fixture(t, { shell(channel) { server = channel; } });
  const stream = await readyStream(f);
  const chunks: Uint8Array[] = [];
  let unacked = 0;
  stream.open((chunk) => { chunks.push(chunk); unacked += chunk.length; });
  const bulk = Buffer.from(Array.from({ length: 1_000_000 }, (_, index) => `${String(index).padStart(15, "0")}\n`).join(""));
  server.write(bulk);
  await until(() => unacked >= TERMINAL_OUTPUT_WINDOW);
  // Stall long enough for ssh2 to fill its high-water mark and the window it granted.
  await delay(1_000);
  assert.equal(f.current().state, "Ready");
  while (length(chunks) < bulk.length) {
    stream.ack(unacked); unacked = 0;
    await delay(1);
  }
  assert.equal(f.current().state, "Ready");
  assert(Buffer.concat(chunks).equals(bulk));
});

test("resize sends a remote window-change with columns and rows in order", async (t) => {
  const sizes: WindowChangeInfo[] = [];
  const f = await fixture(t, {
    shell(_channel, session) { session.on("window-change", (accept, _reject, info) => { sizes.push(info); accept?.(); }); },
  });
  const stream = await readyStream(f);
  stream.resize(120, 40);
  await until(() => sizes.length === 1);
  assert.deepEqual({ cols: sizes[0]!.cols, rows: sizes[0]!.rows }, { cols: 120, rows: 40 });
});

test("the shell PTY request carries IUTF8 enabled so the remote line discipline erases whole UTF-8 characters", async (t) => {
  // ssh2's server parser discards modes it has no name for (IUTF8 included), so the encoded request is observed client-side.
  const { prototype } = createRequire(import.meta.url)("ssh2/lib/protocol/Protocol.js") as { prototype: { pty(...args: unknown[]): unknown } };
  const original = prototype.pty;
  const requested: unknown[] = [];
  prototype.pty = function (this: unknown, ...args: unknown[]) { requested.push(args[6]); return original.apply(this, args); };
  t.after(() => { prototype.pty = original; });
  const f = await fixture(t);
  await readyStream(f);
  assert.equal(requested.length, 1);
  assert.ok(Buffer.isBuffer(requested[0]));
  assert.deepEqual([...(requested[0] as Buffer)], [42, 0, 0, 0, 1, 0]);
});

test("remote exit status, signal and EOF end the session only after the final output chunk, even while output is held", async (t) => {
  for (const [mode, expected] of [
    ["status", { kind: "exit", code: 7 }],
    ["signal", { kind: "signal", signal: "SIGKILL" }],
    ["eof", { kind: "eof" }],
  ] as const) {
    let server!: ServerChannel;
    const f = await fixture(t, { shell(channel) { server = channel; } });
    const stream = await readyStream(f);
    const log: string[] = [];
    f.registry.subscribe(owner, (snapshot) => { if (snapshot.end && !log.includes("end")) log.push("end"); });
    server.write(Buffer.alloc(TERMINAL_OUTPUT_WINDOW * 2, 0x61));
    server.write("tail");
    if (mode === "status") server.exit(7);
    else if (mode === "signal") server.exit("KILL", false, "fixture-sensitive-signal-text");
    server.end();
    await delay(50);
    assert.equal(f.current().state, "Ready", "an unviewed stream holds the remote end");
    const chunks: Uint8Array[] = [];
    let unacked = 0, acking = false;
    stream.open((chunk) => {
      chunks.push(chunk); log.push("output");
      if (acking) stream.ack(chunk.length); else unacked += chunk.length;
    });
    await until(() => unacked >= TERMINAL_OUTPUT_WINDOW);
    await delay(30);
    assert.equal(f.current().state, "Ready", "a credit-paused stream holds the remote end");
    acking = true; stream.ack(unacked);
    await until(() => f.current().state === "Closed" && f.current().cleanup === "complete");
    assert.deepEqual(f.current().end, expected);
    assert.equal(f.current().error, undefined);
    assert.equal(log.indexOf("end"), log.length - 1);
    assert(Buffer.concat(chunks).toString().endsWith("tail"));
    assert.equal(length(chunks), TERMINAL_OUTPUT_WINDOW * 2 + 4);
    assert.equal(stream.write(Buffer.from("late")), "closed");
    assert(!JSON.stringify(f.snapshots).includes("fixture-sensitive"));
  }
});

test("an exit received before connection loss is still reported as the remote end", async (t) => {
  let server!: ServerChannel;
  const f = await fixture(t, { shell(channel) { server = channel; channel.write("unviewed output"); } });
  await readyStream(f);
  server.exit(7);
  f.clients[0]!.end();
  await until(() => f.current().state === "Closed" && f.current().cleanup === "complete");
  assert.deepEqual(f.current().end, { kind: "exit", code: 7 });
  assert.equal(f.current().error, undefined);
});

test("local close has no remote end and revokes the stream; reconnect yields a fresh stream that lock revokes", async (t) => {
  const f = await fixture(t);
  await f.connect();
  const { id } = f.current();
  assert.equal(f.registry.terminal(owner, id, 1), undefined, "not Ready");
  f.trust(); await until(() => f.current().state === "Ready");
  const first = f.registry.terminal(owner, id, 1);
  assert(first);
  assert.equal(f.registry.terminal("other-owner", id, 1), undefined);
  assert.equal(f.registry.terminal(owner, id, 2), undefined);
  await f.registry.close(owner, id);
  assert.equal(f.current().state, "Closed");
  assert.equal(f.current().end, undefined);
  assert.equal(f.current().target?.label, "Owned SSH");
  assert.equal(f.registry.terminal(owner, id, 1), undefined);
  assert.equal(first.write(Buffer.from("late")), "closed");

  assert(f.registry.reconnect(owner, id).ok);
  await until(() => !!f.current().prompt); f.trust();
  await until(() => f.current().state === "Ready");
  assert.equal(f.current().generation, 2);
  assert.equal(f.registry.terminal(owner, id, 1), undefined, "stale generation");
  const second = f.registry.terminal(owner, id, 2);
  assert(second && second !== first);
  const sequences: number[] = [];
  second.open((_chunk, sequence) => sequences.push(sequence));
  await until(() => sequences.length > 0);
  assert.equal(sequences[0], 0);
  await f.registry.lock();
  assert.equal(f.registry.terminal(owner, id, 2), undefined, "locked");
});

test("keepalive detects a silently frozen path as timeout without tripping on a healthy idle session", async (t) => {
  const f = await fixture(t, { keepalive: { intervalMs: 100, countMax: 2 } });
  // Owned in-process TCP hop that can stop forwarding in both directions without closing either socket,
  // like a paused peer behind a proxy that keeps ACKing.
  let frozen = false;
  const sockets: Socket[] = [];
  const target = f.resolved.port.value;
  const proxy = createServer((inbound) => {
    const outbound = connectTcp(target, "127.0.0.1");
    sockets.push(inbound, outbound);
    for (const [from, to] of [[inbound, outbound], [outbound, inbound]] as const) {
      from.on("error", () => {});
      from.on("data", (data) => { if (!frozen) to.write(data); });
      from.on("close", () => to.destroy());
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const address = proxy.address(); assert(address && typeof address !== "string");
  f.resolved.port.value = address.port;
  await f.connect(); f.trust();
  await until(() => f.current().state === "Ready");
  await delay(600);
  assert.equal(f.current().state, "Ready", "answered keepalives never fail an idle session");
  frozen = true;
  const frozenAt = performance.now();
  await until(() => f.current().state === "Failed");
  const elapsed = performance.now() - frozenAt;
  assert.equal(f.current().error?.code, "timeout");
  assert(elapsed < 1_000, `detected in ${Math.round(elapsed)} ms`);
  await until(() => f.current().cleanup === "complete");
  // sockets[0] is the proxy's side of the client connection: it closes once the client's FIN arrives.
  await until(() => sockets[0]!.destroyed);
});

test("keepalive does not trip while output is held for credit from a flooding server", async (t) => {
  let server!: ServerChannel;
  const f = await fixture(t, { keepalive: { intervalMs: 100, countMax: 2 }, shell(channel) { server = channel; } });
  const stream = await readyStream(f);
  let unacked = 0;
  stream.open((chunk) => { unacked += chunk.length; });
  const bulk = Buffer.alloc(8 * 1_048_576, 0x78);
  server.write(bulk);
  await until(() => unacked >= TERMINAL_OUTPUT_WINDOW);
  // Never acknowledged: ten keepalive intervals pass while the flood is held behind exhausted credit.
  await delay(1_000);
  assert.equal(f.current().state, "Ready", "keepalive replies are read while output is credit-paused");
  assert.equal(f.current().error, undefined);
});

test("keepalive is validated where defaults are applied and when main composes saved hosts", async (t) => {
  assert.deepEqual(sshKeepalive(), { intervalMs: 15_000, countMax: 3 });
  for (const keepalive of [{ intervalMs: 100, countMax: 1 }, { intervalMs: 300_000, countMax: 10 }])
    assert(Object.isFrozen(sshKeepalive(keepalive)));
  const invalid: SshKeepalive[] = [
    { intervalMs: 99 }, { intervalMs: 300_001 }, { intervalMs: 150.5 }, { intervalMs: Number.NaN }, { intervalMs: "1000" as unknown as number },
    { countMax: 0 }, { countMax: 11 }, { countMax: 2.5 }, { countMax: null as unknown as number },
  ];
  for (const keepalive of invalid) assert.throws(() => sshKeepalive(keepalive), { name: "RangeError", message: "invalid-keepalive" }, JSON.stringify(keepalive));
  assert.throws(() => createSshConnection({
    host: "127.0.0.1", port: 22, username: "u", signal: new AbortController().signal, keepalive: { countMax: 0 },
    verifyHost: async () => false, authenticate: async () => undefined, ready: () => false, failed() {}, ended() {},
  }), RangeError);
  const dir = mkdtempSync("/private/tmp/ssterm-ssh-keepalive-");
  const opened = await openMetadata({ path: join(dir, "metadata.db") });
  assert(opened.ok);
  t.after(() => { opened.value.close(); rmSync(dir, { recursive: true, force: true }); });
  const build = (keepalive: SshKeepalive) => createSavedHostSessions({
    repository: opened.value, transient: new TransientSecrets(), power: new EventEmitter(), keepalive,
  });
  for (const keepalive of invalid) assert.throws(() => build(keepalive), RangeError, JSON.stringify(keepalive));
  await build({ intervalMs: 1_000, countMax: 2 }).shutdown();
});

test("without a secure store, main still composes saved hosts: unsaved passwords prompt and saved refs fail closed", async (t) => {
  const f = await fixture(t);
  const dir = mkdtempSync("/private/tmp/ssterm-ssh-unavailable-");
  const opened = await openMetadata({ path: join(dir, "metadata.db") });
  assert(opened.ok);
  const repository = opened.value;
  const runtime = createSavedHostSessions({ repository, transient: new TransientSecrets(), power: new EventEmitter() });
  t.after(async () => { await runtime.shutdown(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  // The password was saved during an earlier launch whose secure store worked.
  const saved = randomUUID(), promptOnly = randomUUID(), promptHost = randomUUID(), savedHost = randomUUID();
  const earlier = new SecretService({ repository, transient: new TransientSecrets(), provider: {
    async read() { return { status: "missing" }; }, async lookup() { return { status: "missing" }; },
    async write() { return { status: "confirmed" }; }, async delete() { return { status: "confirmed" }; },
  } });
  const stored = await earlier.storeSecret({
    kind: "password", owner: { type: "identity", id: saved, expectedRevision: null }, value: Buffer.from(password),
    publish: (ref) => [{ type: "create-identity", id: saved, data: { label: "Saved", username: "fixture", method: "password", passwordRef: ref } }],
  });
  assert.equal(stored.status, "published");
  const port = { mode: "value", port: f.resolved.port.value } as const;
  const before = repository.snapshot();
  assert(before.ok);
  const committed = repository.commit({ expectedCatalogRevision: before.value.catalogRevision, changes: [
    { type: "create-identity", id: promptOnly, data: { label: "Prompt", username: "fixture", method: "password" } },
    { type: "create-host", id: promptHost, data: { label: "Prompt", address: "127.0.0.1", port, auth: { mode: "value", identityId: promptOnly } } },
    { type: "create-host", id: savedHost, data: { label: "Saved", address: "127.0.0.1", port, auth: { mode: "value", identityId: saved } } },
  ] });
  assert(committed.ok, JSON.stringify(committed));
  const { registry } = runtime;
  const savedRecords: SessionSnapshot[] = [];
  registry.subscribe("saved-owner", (snapshot) => savedRecords.push(snapshot));
  for (const [owner, hostId] of [["prompt-owner", promptHost], ["saved-owner", savedHost]] as const) {
    assert(registry.connect(owner, hostId).ok);
    await until(() => !!registry.snapshot(owner)[0]?.prompt || registry.snapshot(owner)[0]?.state === "Failed");
    const trust = registry.snapshot(owner)[0]!;
    assert.equal(trust.prompt?.kind, "host-trust", trust.error?.code);
    assert(registry.answerPrompt(owner, trust.id, trust.generation, trust.prompt.id, { kind: "host-trust", decision: "accept-once" }).ok);
  }
  const promptState = () => registry.snapshot("prompt-owner")[0]!;
  await until(() => promptState().prompt?.kind === "credentials");
  assert.equal(credentials(promptState())?.purpose, "password");
  const savedState = () => registry.snapshot("saved-owner")[0]!;
  await until(() => savedState().state === "Failed" && savedState().cleanup === "complete");
  assert.equal(savedState().error?.code, "credentials-unavailable");
  assert(!savedRecords.some((snapshot) => snapshot.prompt?.kind === "credentials"));
  assert.deepEqual(f.methods, []);
});

test("an SFTP-kind session opens only the sftp subsystem: no PTY or shell, and a refusal is subsystem-unavailable", async (t) => {
  const f = await fixture(t);
  const result = f.registry.connect("fixture-owner", "fixture-host", "sftp");
  assert(result.ok);
  await until(() => !!f.current().prompt);
  f.trust();
  await until(() => f.current().state === "Failed" && f.current().cleanup === "complete");
  assert.equal(f.current().kind, "sftp");
  assert.equal(f.current().error?.code, "subsystem-unavailable");
  assert.deepEqual(f.methods, ["password"]);
  assert.equal(f.shells(), 0);
});
