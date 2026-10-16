import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import ssh2 from "ssh2";
import { CLEANUP_STALL_MS, createCatalogController, observeCommits } from "../../apps/desktop/src/main/catalog-controller.ts";
import { createIdentitiesController, secretNamespace } from "../../apps/desktop/src/main/identities.ts";
import { CatalogModule, SecretService, SessionRegistry, TransientSecrets } from "../../packages/services/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import { preparePrivateKey } from "../../packages/adapters/src/ssh.ts";
import type { MetadataRepository, StoreResult } from "../../packages/domain/src/index.ts";
import {
  failure, isCatalogPrepareResponse, isCatalogState, isChooseKeyFileResponse, isImportKeyResponse,
  type CatalogChangeIntent, type CatalogPrepareResponse, type CatalogState, type Owner, type Result,
} from "../../packages/contracts/src/index.ts";
import { MemorySecretProvider } from "../fixtures/secrets/memory-provider.ts";
import { ed25519 } from "./ssh-keys.ts";

const owner = { windowId: 1, generation: 1 };
const other = { windowId: 2, generation: 1 };
const encode = (text: string) => new TextEncoder().encode(text);
const PASSWORD = "fixture-identity-password";
const PASSPHRASE = "fixture-key-passphrase";
function value<T>(result: StoreResult<T> | Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}

const passphrase = Buffer.from(PASSPHRASE);
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const keys = {
  plainEd: ed25519().private,
  encryptedEd: ed25519({ passphrase, cipher: "aes256-cbc", rounds: 1 }).private,
  plainRsa: rsa.export({ type: "pkcs1", format: "pem" }) as string,
  encryptedRsa: rsa.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase }) as string,
  opensshRsa: ssh2.utils.generateKeyPairSync("rsa", { bits: 2048 }).private,
  encryptedOpensshRsa: ssh2.utils.generateKeyPairSync("rsa", { bits: 2048, passphrase, cipher: "aes256-cbc", rounds: 1 }).private,
  pkcs8: rsa.export({ type: "pkcs8", format: "pem" }) as string,
  publicKey: ed25519().public,
  ecdsa: ssh2.utils.generateKeyPairSync("ecdsa", { bits: 256 }).private,
  garbage: "not a key at all\n",
  truncated: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
};
const derived = (pem: string, phrase?: Uint8Array) => {
  const parsed = preparePrivateKey(Buffer.from(pem), phrase);
  assert.ok(parsed.ok);
  const identity = { ...parsed.key.identity };
  parsed.key.dispose();
  return identity;
};

async function fixture(t: TestContext, options: { importTtlMs?: number } = {}) {
  const dir = mkdtempSync("/private/tmp/ssterm-identities-");
  const raw = value(await openMetadata({ path: join(dir, "catalog.sqlite") }));
  let changed = 0;
  let catalog: ReturnType<typeof createCatalogController> | undefined;
  const repo: MetadataRepository = observeCommits(raw, () => { changed += 1; catalog?.publishAll(); });
  const provider = new MemorySecretProvider();
  const transient = new TransientSecrets();
  const secrets = new SecretService({ repository: repo, provider, transient });
  let secretsOn = true;
  let cleanupQueued = 0;
  let skew = 0;
  catalog = createCatalogController({
    repository: repo, catalog: new CatalogModule({ repository: repo }), secretStore: () => secretsOn,
    cleanupQueued: () => { cleanupQueued += 1; }, now: () => Date.now() + skew,
  });
  const registry = new SessionRegistry({
    resolve: () => ({ ok: false, error: { code: "unavailable", message: "Configuration is unavailable." } }),
    adapter: { start: (context) => context.failed("subsystem-unavailable") },
    transient,
  });
  let checkAccess = async () => true;
  const sent: CatalogState[] = [];
  catalog.register(owner, (state) => sent.push(state));
  catalog.register(other, () => {});
  let picked: string | undefined;
  let pick: (owner: Owner) => Promise<string | undefined> = async () => picked;
  const identities = createIdentitiesController({
    repository: repo, secrets: () => (secretsOn ? secrets : undefined), transient, pickFile: (who) => pick(who),
    lock: registry, checkAccess: () => checkAccess(), ...options,
  });
  const responses: unknown[] = [];
  const record = <T>(result: T): T => { responses.push(result); return result; };
  t.after(async () => {
    await registry.dispose();
    identities.dispose();
    catalog!.dispose();
    transient.purgeAll();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const snapshot = () => value(repo.snapshot());
  const prepare = (intent: CatalogChangeIntent, who: Owner = owner) => value(catalog!.prepareCatalogChange({ owner: who, intent }));
  const preview = (intent: CatalogChangeIntent) => {
    const result = prepare(intent);
    assert.ok(isCatalogPrepareResponse(result));
    return result.kind === "preview" ? result : assert.fail(JSON.stringify(result));
  };
  const apply = (intent: CatalogChangeIntent) => value(catalog!.applyCatalogChange({ owner, token: preview(intent).token }));
  const state = () => {
    const current = value(catalog!.catalogState(owner));
    assert.ok(isCatalogState(current));
    responses.push(current);
    return current;
  };
  const file = (name: string, content: string | Buffer) => {
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };
  const choose = async (path: string | undefined, who: Owner = owner) => {
    picked = path;
    const result = record(await identities.chooseKeyFile({ owner: who }));
    if (result.ok) assert.ok(isChooseKeyFileResponse(result.value), JSON.stringify(result.value));
    return result;
  };
  const chosen = async (path: string) => {
    const result = value(await choose(path));
    return result.status === "chosen" ? result : assert.fail(JSON.stringify(result));
  };
  const importKey = async (importId: string, extra: { label?: string; passphrase?: string | null; save?: boolean; who?: Owner } = {}) => {
    const result = record(await identities.importKey({
      owner: extra.who ?? owner, importId, label: extra.label ?? "Lab key",
      passphrase: extra.passphrase ? encode(extra.passphrase) : null, savePassphrase: extra.save ?? false,
    }));
    if (result.ok) assert.ok(isImportKeyResponse(result.value), JSON.stringify(result.value));
    return result;
  };
  const passwordIdentity = (label = "Lab login") => apply({ type: "create-identity", data: { label, username: "fixture", method: "password" } }).createdIds[0]!;
  const identity = (id: string) => snapshot().identities.find((row) => row.id === id)!;
  const setPassword = async (identityId: string, expectedRevision: number, text = PASSWORD) =>
    record(await identities.setIdentityPassword({ owner, identityId, expectedRevision, value: encode(text) }));
  const unresolved = () => snapshot().secretOperations.filter((op) => op.action !== "delete" && ["staged", "reconcile", "needs-input"].includes(op.state));
  return {
    dir, raw, repo, provider, transient, secrets, catalog, identities, registry, sent, responses, record, snapshot, prepare, preview, apply, state,
    file, choose, chosen, importKey, passwordIdentity, identity, setPassword, unresolved,
    get changed() { return changed; }, get cleanupQueued() { return cleanupQueued; },
    secretsOff() { secretsOn = false; },
    /** Moves the catalog's stall clock; 0 restores real time. */
    skew(ms: number) { skew = ms; },
    setAccess(next: () => Promise<boolean>) { checkAccess = next; },
    setPick(next: typeof pick) { pick = next; },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** No reference, operation id, private key text or credential byte may appear in anything that crosses to the renderer. */
function assertPrivate(s: Fixture, extra: unknown[] = []) {
  const snapshot = s.snapshot();
  const forbidden = [
    snapshot.vault.id, ...snapshot.secretRefs.map((ref) => ref.id), ...snapshot.secretOperations.flatMap((op) => [op.operationId, op.intendedRef]),
    PASSWORD, PASSPHRASE, "PRIVATE KEY", s.dir,
  ];
  for (const json of [...s.sent, ...s.responses, ...extra].map((item) => JSON.stringify(item))) {
    for (const secret of forbidden) assert.equal(json.includes(secret), false, `${secret} crossed the boundary`);
    for (const field of ["passwordRef", "privateKeyRef", "passphraseRef", "operationId", "cleanupRefIds", "path"])
      assert.equal(json.includes(`"${field}"`), false, field);
  }
}

test("identity password: create, replace with old-ref cleanup, forget and delete clean the Keychain item; nothing secret crosses", async (t) => {
  const s = await fixture(t);
  const id = s.passwordIdentity();
  assert.deepEqual(s.state().identities.map((row) => [row.passwordSaved, row.pending, row.revision]), [[false, false, 1]]);
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "saved" });
  assert.equal(s.provider.items.size, 1);
  assert.deepEqual([...s.provider.items.values()].map((bytes) => bytes.toString()), [PASSWORD]);
  assert.deepEqual(s.state().identities.map((row) => [row.passwordSaved, row.revision]), [[true, 2]]);
  assert.deepEqual(s.state().secrets, { availability: "ready", cleanupPending: false });

  const firstRef = s.identity(id).passwordRef;
  assert.deepEqual(value(await s.setPassword(id, 2, "replacement-password")), { status: "saved" });
  assert.notEqual(s.identity(id).passwordRef, firstRef);
  assert.deepEqual([...s.provider.items.values()].map((bytes) => bytes.toString()), ["replacement-password"], "the old item was deleted");
  assert.deepEqual(await s.setPassword(id, 2), failure("conflict"), "a stale revision is refused");
  assert.deepEqual(await s.identities.setIdentityPassword({ owner, identityId: randomUUID(), expectedRevision: 1, value: encode("x") }), failure("conflict"));

  const forget = s.preview({ type: "update-identity", id, expectedRevision: 3, data: {}, forgetPassword: true });
  assert.equal(forget.impacts.identity?.removesSavedPassword, true);
  value(s.catalog.applyCatalogChange({ owner, token: forget.token }));
  assert.equal(s.cleanupQueued, 1, "an apply that queues cleanup triggers reconciliation");
  assert.equal(s.state().secrets.cleanupPending, false, "a deletion within its normal window does not raise the alert");
  s.skew(CLEANUP_STALL_MS);
  assert.equal(s.state().secrets.cleanupPending, true, "one still queued after the window does");
  s.skew(0);
  assert.equal(s.provider.items.size, 1);
  await s.secrets.reconcile();
  assert.equal(s.provider.items.size, 0);
  assert.equal(s.state().secrets.cleanupPending, false);

  assert.deepEqual(value(await s.setPassword(id, 4)), { status: "saved" });
  const keep = s.passwordIdentity("Other");
  const deletion = s.preview({ type: "delete-identity", id, expectedRevision: 5, disposition: { mode: "reassign", identityId: keep } });
  assert.deepEqual(deletion.impacts.identity, { directHostIds: [], directGroupIds: [], effectiveHostIds: [], removesSavedPassword: true });
  value(s.catalog.applyCatalogChange({ owner, token: deletion.token }));
  await s.secrets.reconcile();
  assert.equal(s.provider.items.size, 0);
  assert.equal(s.cleanupQueued, 2);
  assertPrivate(s);
});

test("method checks: a key or keyboard-interactive identity cannot save a password; no secret store answers unavailable", async (t) => {
  const s = await fixture(t);
  const ki = s.apply({ type: "create-identity", data: { label: "KI", username: "u", method: "keyboard-interactive" } }).createdIds[0]!;
  assert.deepEqual(await s.setPassword(ki, 1), failure("invalid-request"));
  s.secretsOff();
  const id = s.passwordIdentity();
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "secret-store", reason: "unavailable" });
  assert.deepEqual(s.state().secrets, { availability: "unavailable", cleanupPending: false });
  assert.deepEqual(await s.identities.chooseKeyFile({ owner }), failure("unavailable"));
  assert.equal(s.snapshot().secretOperations.length, 0);
});

test("provider failures are typed problems, cancelled at once and never published", async (t) => {
  const s = await fixture(t);
  const id = s.passwordIdentity();
  for (const [faults, reason] of [
    [[{ op: "write", status: "unavailable" }], "unavailable"],
    [[{ op: "write", status: "denied" }], "denied"],
    [[{ op: "write", status: "unknown" }, { op: "write", status: "unknown" }], "unknown"],
    [[{ op: "write", status: "unknown" }, { op: "lookup", status: "locked" }], "locked"],
    [[{ op: "write", status: "error" }], "unknown"],
  ] as const) {
    s.provider.inject(...faults);
    assert.deepEqual(value(await s.setPassword(id, 1)), { status: "secret-store", reason }, reason);
    assert.deepEqual(s.unresolved(), [], "the failed write was cancelled");
    assert.equal(s.provider.items.size, 0);
    assert.equal(s.identity(id).passwordRef, null);
    assert.equal(s.identity(id).revision, 1);
  }
  // A failure whose cancel cannot resolve may still have written: never claim nothing was saved.
  s.provider.inject({ op: "write", status: "unavailable" }, { op: "lookup", status: "unavailable" });
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "secret-store", reason: "unknown" });
  assert.equal(s.unresolved().length, 1);
  assert.deepEqual(value(await s.identities.retrySecrets()), { status: "retried" });
  assert.deepEqual(s.unresolved(), []);
  // An ambiguous write that did land is found by the cancel lookup and deleted.
  s.provider.inject({ op: "write", status: "unknown", apply: true }, { op: "lookup", status: "unavailable" });
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "secret-store", reason: "unavailable" });
  assert.equal(s.provider.items.size, 0);
  assert.deepEqual(s.unresolved(), []);
  assertPrivate(s);
});

test("an unresolved slot blocks catalog edits, is pre-cancelled before restaging, and retrySecrets clears needs-input", async (t) => {
  const s = await fixture(t);
  const id = s.passwordIdentity();
  // Both writes and the immediate cancel stay ambiguous: the operation remains unresolved.
  const stuck = () => s.provider.inject({ op: "write", status: "unknown" }, { op: "write", status: "unknown" },
    { op: "lookup", status: "missing" }, { op: "lookup", status: "unavailable" });
  stuck();
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "secret-store", reason: "unknown" });
  assert.equal(s.unresolved().length, 1);
  assert.equal(s.state().identities[0]!.pending, true);
  assert.deepEqual(s.catalog.prepareCatalogChange({ owner, intent: { type: "update-identity", id, expectedRevision: 1, data: { label: "x" } } }),
    failure("busy"));

  s.provider.inject({ op: "lookup", status: "unavailable" });
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "secret-store", reason: "unavailable" }, "the pre-cancel could not resolve");
  assert.equal(s.unresolved().length, 1);
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "saved" }, "the leftover is cancelled, then the new value is stored");
  assert.deepEqual(s.unresolved(), []);
  assert.equal(s.provider.items.size, 1);

  // Leave a reconcile row, let retry move it to needs-input (nothing was written) and cancel it.
  stuck();
  assert.deepEqual(value(await s.setPassword(id, 2, "next")), { status: "secret-store", reason: "unknown" });
  assert.equal(s.unresolved().length, 1);
  assert.deepEqual(value(await s.identities.retrySecrets()), { status: "retried" });
  assert.deepEqual(s.unresolved(), []);
  assert.equal(s.state().identities[0]!.pending, false);
  assert.equal(s.identity(id).revision, 2);
  assertPrivate(s);
});

test("key import matrix: supported formats derive metadata in main; unsupported, invalid and unreadable files are typed", async (t) => {
  const s = await fixture(t);
  for (const [name, pem, phrase, algorithm, save] of [
    ["id_ed25519", keys.plainEd, undefined, "ssh-ed25519", false],
    ["id_ed25519_enc", keys.encryptedEd, PASSPHRASE, "ssh-ed25519", true],
    ["id_rsa", keys.plainRsa, undefined, "ssh-rsa", false],
    ["id_rsa_enc", keys.encryptedRsa, PASSPHRASE, "ssh-rsa", false],
  ] as const) {
    const expected = derived(pem, phrase ? encode(phrase) : undefined);
    const picked = await s.chosen(s.file(name, pem));
    assert.equal(picked.suggestedLabel, name);
    assert.equal(picked.encrypted, !!phrase);
    assert.deepEqual([picked.algorithm, picked.fingerprint], phrase ? [null, null] : [algorithm, expected.fingerprint]);
    if (phrase) {
      assert.deepEqual(value(await s.importKey(picked.importId, { passphrase: "wrong" })), { status: "wrong-passphrase" });
      assert.deepEqual(value(await s.importKey(picked.importId)), { status: "wrong-passphrase" }, "an encrypted key needs its passphrase");
    } else assert.deepEqual(await s.importKey(picked.importId, { passphrase: "unused" }), failure("invalid-request"));
    assert.deepEqual(await s.importKey(picked.importId, { label: " ", passphrase: phrase ?? null }), failure("invalid-request"));
    const imported = value(await s.importKey(picked.importId, { label: name, passphrase: phrase ?? null, save }));
    if (imported.status !== "imported") assert.fail(JSON.stringify(imported));
    assert.equal(imported.fingerprint, expected.fingerprint);
    assert.deepEqual(imported.passphrase, { status: save ? "saved" : "not-saved" });
    const key = s.snapshot().keys.find((row) => row.id === imported.keyId)!;
    assert.deepEqual({ algorithm: key.algorithm, publicKey: key.publicKey, fingerprint: key.fingerprint }, expected, "metadata equals the derived key");
    assert.equal(key.label, name);
    assert.equal(key.passphraseRef !== null, save);
    const stored = [...s.provider.items.entries()];
    assert.ok(stored.some(([account, bytes]) => account.endsWith(key.privateKeyRef) && bytes.toString() === pem));
    if (save) assert.ok(stored.some(([account, bytes]) => account.endsWith(key.passphraseRef!) && bytes.toString() === PASSPHRASE));
    assert.deepEqual(value(await s.importKey(picked.importId, { passphrase: phrase ?? null })), { status: "expired" }, "single use");
  }
  assert.equal(s.transient.size, 0, "no import is held after use");
  assert.deepEqual(s.state().keys.map((key) => [key.label, key.algorithm, key.passphraseSaved]),
    [["id_ed25519", "ssh-ed25519", false], ["id_ed25519_enc", "ssh-ed25519", true], ["id_rsa", "ssh-rsa", false], ["id_rsa_enc", "ssh-rsa", false]]);

  const encryptedRsa = await s.chosen(s.file("openssh_rsa_enc", keys.encryptedOpensshRsa));
  assert.equal(encryptedRsa.encrypted, true);
  assert.deepEqual(value(await s.importKey(encryptedRsa.importId, { passphrase: PASSPHRASE })), { status: "rejected", problem: "unsupported" });
  assert.deepEqual(value(await s.importKey(encryptedRsa.importId, { passphrase: PASSPHRASE })), { status: "expired" });

  const fifo = join(s.dir, "fifo");
  execFileSync("mkfifo", [fifo]);
  mkdirSync(join(s.dir, "directory"));
  for (const [path, problem] of [
    [s.file("openssh_rsa", keys.opensshRsa), "unsupported"],
    [s.file("pkcs8.pem", keys.pkcs8), "unsupported"],
    [s.file("id_ed25519.pub", keys.publicKey), "unsupported"],
    [s.file("id_ecdsa", keys.ecdsa), "unsupported"],
    [s.file("garbage", keys.garbage), "unsupported"],
    [s.file("truncated", keys.truncated), "invalid"],
    [s.file("empty", ""), "invalid"],
    [s.file("huge", Buffer.alloc(64 * 1024 + 1, 0x41)), "too-large"],
    [join(s.dir, "directory"), "unreadable"],
    [fifo, "unreadable"],
    [join(s.dir, "missing"), "unreadable"],
  ] as const) assert.deepEqual(value(await s.choose(path)), { status: "rejected", problem }, path);
  const exact = await s.chosen(s.file("exact", Buffer.concat([Buffer.from(keys.plainEd), Buffer.alloc(64 * 1024 - keys.plainEd.length, 0x0a)])));
  assert.equal(exact.encrypted, false, "exactly 64 KiB is accepted");
  assert.deepEqual(value(await s.choose(undefined)), { status: "cancelled" });
  assert.equal(s.transient.size, 1);
  s.identities.discardKeyImport({ owner, importId: exact.importId });
  assert.equal(s.transient.size, 0);
  assertPrivate(s);
});

test("imports are owner-bound, single use, replaced by a new choice and wiped by TTL, lock purge, discard and revocation", async (t) => {
  const s = await fixture(t, { importTtlMs: 50 });
  const path = s.file("id_ed25519", keys.plainEd);
  const first = await s.chosen(path);
  assert.deepEqual(value(await s.importKey(first.importId, { who: other })), { status: "expired" }, "another owner cannot use it");
  const second = await s.chosen(path);
  assert.equal(s.transient.size, 1);
  assert.deepEqual(value(await s.importKey(first.importId)), { status: "expired" }, "a new choice replaces the old import");
  assert.deepEqual(value(s.identities.discardKeyImport({ owner, importId: second.importId })), { status: "discarded" });
  assert.deepEqual(value(await s.importKey(second.importId)), { status: "expired" });

  const ttl = await s.chosen(path);
  await delay(80);
  assert.deepEqual(value(await s.importKey(ttl.importId)), { status: "expired" });
  const locked = await s.chosen(path);
  s.transient.purgeAll();
  assert.deepEqual(value(await s.importKey(locked.importId)), { status: "expired" });
  const revoked = await s.chosen(path);
  s.identities.revokeOwner(owner);
  assert.deepEqual(value(await s.importKey(revoked.importId)), { status: "expired" });
  assert.equal(s.transient.size, 0);

  // One open dialog per owner; revocation while it is open discards whatever it returns.
  let release!: (path: string | undefined) => void;
  s.setPick(() => new Promise((resolve) => { release = resolve; }));
  const open = s.identities.chooseKeyFile({ owner });
  assert.deepEqual(await s.identities.chooseKeyFile({ owner }), failure("busy"));
  s.identities.revokeOwner(owner);
  release(path);
  assert.deepEqual(await open, failure("stale-owner"));
  assert.equal(s.transient.size, 0);
  s.setPick(async (who) => { assert.deepEqual(who, owner); return path; });
  assert.equal(value(await s.identities.chooseKeyFile({ owner })).status, "chosen");
  s.identities.dispose();
  assert.equal(s.transient.size, 0);
  assert.deepEqual(await s.identities.chooseKeyFile({ owner }), failure("unavailable"));
  assertPrivate(s);
});

test("a lock blocks identity Keychain actions until an explicit one unlocks it; automatic cleanup waits", async (t) => {
  const s = await fixture(t);
  const id = s.passwordIdentity();
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "saved" });
  await s.registry.lock();
  s.setAccess(async () => false);
  assert.deepEqual(await s.setPassword(id, 2, "next"), failure("unavailable"), "no access, no unlock");
  assert.equal(s.registry.locked, true);
  assert.deepEqual(await s.identities.retrySecrets(), failure("unavailable"));

  // A catalog apply still commits while locked, but its queued Keychain deletion waits for an unlock.
  value(s.catalog.applyCatalogChange({ owner, token: s.preview({ type: "update-identity", id, expectedRevision: 2, data: {}, forgetPassword: true }).token }));
  s.identities.cleanupQueued();
  await delay(20);
  assert.equal(s.provider.items.size, 1, "reconciliation is deferred while locked");

  s.setAccess(async () => true);
  assert.deepEqual(value(await s.identities.retrySecrets()), { status: "retried" }, "Retry is the explicit unlock");
  assert.equal(s.registry.locked, false);
  assert.equal(s.provider.items.size, 0);
  await s.registry.lock();
  assert.deepEqual(value(await s.setPassword(id, 3)), { status: "saved" }, "so is saving a password");
  assert.equal(s.registry.locked, false);
  s.identities.cleanupQueued();
  assertPrivate(s);
});

test("a lock during an import aborts it and wipes the held file; one during the key write skips only the passphrase", async (t) => {
  const s = await fixture(t);
  await s.registry.lock();
  const picked = await s.chosen(s.file("id_ed25519", keys.plainEd));
  let release!: (allowed: boolean) => void;
  s.setAccess(() => new Promise((resolve) => { release = resolve; }));
  const importing = s.importKey(picked.importId);
  await delay(5);
  void s.registry.lock();
  release(true);
  assert.deepEqual(await importing, failure("unavailable"), "an import that predates the lock never proceeds after it");
  assert.equal(s.registry.locked, true);
  assert.equal(s.provider.items.size, 0);
  assert.equal(s.transient.size, 0);
  s.setAccess(async () => true);
  assert.deepEqual(value(await s.importKey(picked.importId)), { status: "expired" });

  const encrypted = await s.chosen(s.file("id_ed25519_enc", keys.encryptedEd));
  const write = s.provider.write.bind(s.provider);
  s.provider.write = async (item, bytes) => {
    void s.registry.lock();
    return write(item, bytes);
  };
  const imported = value(await s.importKey(encrypted.importId, { passphrase: PASSPHRASE, save: true }));
  assert.deepEqual(imported.status === "imported" && imported.passphrase, { status: "secret-store", reason: "locked" });
  assert.deepEqual([...s.provider.items.values()].map((bytes) => bytes.toString()), [keys.encryptedEd],
    "the key bytes are the controller's own copy, intact after the lock purge");
  assert.equal(s.snapshot().keys[0]!.passphraseRef, null);
});

test("keys: rename, forget passphrase, delete refused while in use, then delete with cleanup and retry", async (t) => {
  const s = await fixture(t);
  const picked = await s.chosen(s.file("id_ed25519_enc", keys.encryptedEd));
  const imported = value(await s.importKey(picked.importId, { passphrase: PASSPHRASE, save: true }));
  if (imported.status !== "imported") assert.fail(JSON.stringify(imported));
  const keyId = imported.keyId;
  assert.equal(s.provider.items.size, 2);
  const using = s.apply({ type: "create-identity", data: { label: "Key login", username: "u", method: "key", keyId } }).createdIds[0]!;
  assert.deepEqual(s.state().identities.find((row) => row.id === using), {
    id: using, revision: 1, label: "Key login", username: "u", method: "key", passwordSaved: false, keyId, pending: false,
  });

  assert.deepEqual(value(s.identities.renameKey({ owner, keyId, expectedRevision: 2, label: " Renamed " })), { status: "renamed" });
  assert.equal(s.state().keys[0]!.label, "Renamed");
  assert.deepEqual(s.identities.renameKey({ owner, keyId, expectedRevision: 2, label: "x" }), failure("conflict"));
  assert.deepEqual(s.identities.renameKey({ owner, keyId, expectedRevision: 3, label: "a\u0007" }), failure("invalid-request"));

  assert.deepEqual(value(await s.identities.deleteKey({ owner, keyId, expectedRevision: 3 })), { status: "in-use", identityIds: [using] });
  assert.deepEqual(value(await s.identities.forgetKeyPassphrase({ owner, keyId, expectedRevision: 3 })), { status: "forgotten", cleanup: "cleaned" });
  assert.equal(s.provider.items.size, 1);
  assert.equal(s.state().keys[0]!.passphraseSaved, false);
  assert.deepEqual(value(await s.identities.forgetKeyPassphrase({ owner, keyId, expectedRevision: 4 })), { status: "forgotten", cleanup: "cleaned" },
    "forgetting nothing is a no-op");
  assert.deepEqual(await s.identities.forgetKeyPassphrase({ owner, keyId, expectedRevision: 3 }), failure("conflict"));

  s.apply({ type: "update-identity", id: using, expectedRevision: 1, data: { method: "keyboard-interactive" } });
  s.provider.inject({ op: "delete", status: "unavailable" });
  assert.deepEqual(value(await s.identities.deleteKey({ owner, keyId, expectedRevision: 4 })), { status: "deleted", cleanup: "pending" });
  assert.deepEqual(s.state().keys, []);
  assert.equal(s.state().secrets.cleanupPending, false);
  s.skew(CLEANUP_STALL_MS);
  assert.equal(s.state().secrets.cleanupPending, true, "the failed deletion is still queued after the window");
  s.skew(0);
  assert.equal(s.provider.items.size, 1);
  assert.deepEqual(value(await s.identities.retrySecrets()), { status: "retried" });
  assert.equal(s.provider.items.size, 0);
  assert.equal(s.state().secrets.cleanupPending, false);
  assert.deepEqual(await s.identities.deleteKey({ owner, keyId, expectedRevision: 4 }), failure("conflict"));
  s.secretsOff();
  assert.deepEqual(value(await s.identities.deleteKey({ owner, keyId, expectedRevision: 4 })), { status: "secret-store", reason: "unavailable" });
  assert.deepEqual(value(await s.identities.retrySecrets()), { status: "secret-store", reason: "unavailable" });
  assertPrivate(s);
});

test("catalog identity intents: field errors, identity impacts through groups, and key-method rules", async (t) => {
  const s = await fixture(t);
  const fields = (intent: CatalogChangeIntent) => {
    const result: CatalogPrepareResponse = s.prepare(intent);
    return result.kind === "invalid" ? result.fields : assert.fail(JSON.stringify(result));
  };
  assert.deepEqual(fields({ type: "create-identity", data: { label: "", username: " ", method: "password" } }),
    [{ field: "label", code: "empty" }, { field: "username", code: "empty" }]);
  assert.deepEqual(fields({ type: "create-identity", data: { label: "L", username: "a\u0001", method: "password" } }), [{ field: "username", code: "control" }]);
  assert.deepEqual(fields({ type: "create-identity", data: { label: "L", username: "u".repeat(257), method: "password" } }), [{ field: "username", code: "too-long" }]);
  assert.deepEqual(fields({ type: "create-identity", data: { label: "L", username: "u", method: "key" } }), [{ field: "keyId", code: "required" }]);
  assert.deepEqual(fields({ type: "create-identity", data: { label: "L", username: "u", method: "key", keyId: randomUUID() } }), [{ field: "keyId", code: "not-found" }]);
  assert.deepEqual(s.catalog.prepareCatalogChange({ owner, intent: { type: "create-identity", data: { label: "L", username: "u", method: "password", keyId: randomUUID() } } }),
    failure("invalid-request"), "a key on a non-key identity is refused by the module");

  const id = s.passwordIdentity();
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "saved" });
  assert.deepEqual(fields({ type: "update-identity", id, expectedRevision: 2, data: { method: "key" } }), [{ field: "keyId", code: "required" }]);
  assert.deepEqual(fields({ type: "delete-identity", id, expectedRevision: 2, disposition: { mode: "reassign", identityId: id } }),
    [{ field: "identity", code: "not-found" }]);
  assert.deepEqual(s.catalog.prepareCatalogChange({ owner, intent: { type: "delete-identity", id, expectedRevision: 1, disposition: { mode: "detach" } } }),
    failure("conflict"));

  const group = s.apply({ type: "create-group", data: { label: "G", auth: { mode: "value", identityId: id } } }).createdIds[0]!;
  const inherited = s.apply({ type: "create-host", data: { label: "Inherited", address: "a.example", groupId: group } }).createdIds[0]!;
  const direct = s.apply({ type: "create-host", data: { label: "Direct", address: "b.example", auth: { mode: "value", identityId: id } } }).createdIds[0]!;
  s.apply({ type: "create-host", data: { label: "Unrelated", address: "c.example" } });
  const rename = s.preview({ type: "update-identity", id, expectedRevision: 2, data: { label: "Renamed" } });
  const impact = rename.impacts.identity!;
  assert.deepEqual({ ...impact, effectiveHostIds: [...impact.effectiveHostIds].sort() },
    { directHostIds: [direct], directGroupIds: [group], effectiveHostIds: [inherited, direct].sort(), removesSavedPassword: false });
  const detach = s.preview({ type: "delete-identity", id, expectedRevision: 2, disposition: { mode: "detach" } });
  assert.equal(detach.impacts.identity?.removesSavedPassword, true);
  value(s.catalog.applyCatalogChange({ owner, token: detach.token }));
  const after = s.state();
  assert.deepEqual(after.hosts.find((row) => row.id === direct)!.auth, { mode: "clear" });
  assert.deepEqual(after.groups.find((row) => row.id === group)!.auth, { mode: "clear" });
  assert.equal(s.preview({ type: "create-tag", data: { label: "t" } }).impacts.identity, null);
  assertPrivate(s);
});

test("the commit observer republishes once per turn for every writer and never for a failed commit", async (t) => {
  const s = await fixture(t);
  const before = s.changed;
  const published = s.sent.length;
  const tag = (label: string) => value(s.repo.commit({ expectedCatalogRevision: s.snapshot().catalogRevision, changes: [{ type: "create-tag", id: randomUUID(), data: { label } }] }));
  tag("a"); tag("b"); tag("c");
  assert.equal(s.changed, before, "nothing runs synchronously");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.changed, before + 1, "three commits coalesce into one republish");
  assert.equal(s.sent.length, published + 1);
  assert.deepEqual(s.sent.at(-1)!.tags.map((row) => row.label), ["a", "b", "c"]);
  assert.equal(s.repo.commit({ expectedCatalogRevision: 1, changes: [] }).ok, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.changed, before + 1);

  // A SecretService write (not a catalog apply) also reaches the renderer.
  const id = s.passwordIdentity();
  await new Promise((resolve) => setImmediate(resolve));
  const seen = s.sent.length;
  assert.deepEqual(value(await s.setPassword(id, 1)), { status: "saved" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(s.sent.length > seen);
  assert.equal(s.sent.at(-1)!.identities[0]!.passwordSaved, true);
});

test("the Keychain namespace honours a test namespace only for a test profile and otherwise fails closed", () => {
  const production = "dev.ssterm.desktop.secrets";
  const test = `dev.ssterm.test.${randomUUID()}`;
  assert.equal(secretNamespace({}, production), production);
  assert.equal(secretNamespace({ SSTERM_TEST_SECRET_NAMESPACE: test }, production), production, "ignored outside a test profile");
  assert.equal(secretNamespace({ SSTERM_TEST_USER_DATA: "/tmp/p", SSTERM_TEST_SECRET_NAMESPACE: test }, production), test);
  for (const namespace of [undefined, "", production, "dev.ssterm.test.x", `dev.ssterm.test.${randomUUID()}x`, `other.${randomUUID()}`])
    assert.equal(secretNamespace({ SSTERM_TEST_USER_DATA: "/tmp/p", SSTERM_TEST_SECRET_NAMESPACE: namespace }, production), undefined, String(namespace));
});
