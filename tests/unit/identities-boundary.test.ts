import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { identityChannels, registerIdentityHandlers, type IdentitiesController } from "../../apps/desktop/src/main/identities.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import {
  channels, failure, isSetIdentityPasswordRequest, isImportKeyRequest, isChooseKeyFileRequest, isDiscardKeyImportRequest,
  isRenameKeyRequest, isKeyTargetRequest, isRetrySecretsRequest, isSetIdentityPasswordResponse, isChooseKeyFileResponse,
  isImportKeyResponse, isForgetKeyPassphraseResponse, isDeleteKeyResponse, isRetrySecretsResponse, MAX_CREDENTIAL_BYTES,
  type Result,
} from "../../packages/contracts/src/index.ts";

const owner = { windowId: 1, generation: 1 };
const id = () => randomUUID();
const fingerprint = `SHA256:${"A".repeat(43)}`;

test("identity request guards: exact keys, owner, ids and 1..16 KiB Uint8Array credentials", () => {
  const identityId = id(), importId = id(), keyId = id();
  for (const size of [1, MAX_CREDENTIAL_BYTES])
    assert.ok(isSetIdentityPasswordRequest({ owner, identityId, expectedRevision: 1, value: new Uint8Array(size) }), String(size));
  for (const request of [
    { owner, identityId, expectedRevision: 1, value: new Uint8Array(0) },
    { owner, identityId, expectedRevision: 1, value: new Uint8Array(MAX_CREDENTIAL_BYTES + 1) },
    { owner, identityId, expectedRevision: 1, value: [1, 2] },
    { owner, identityId, expectedRevision: 1, value: new ArrayBuffer(4) },
    { owner, identityId, expectedRevision: 1, value: "secret" },
    { owner, identityId, expectedRevision: 0, value: new Uint8Array(1) },
    { owner, identityId: "identity", expectedRevision: 1, value: new Uint8Array(1) },
    { owner, identityId, expectedRevision: 1, value: new Uint8Array(1), passwordRef: id() },
    { identityId, expectedRevision: 1, value: new Uint8Array(1) },
  ]) assert.equal(isSetIdentityPasswordRequest(request), false, JSON.stringify(request));

  assert.ok(isImportKeyRequest({ owner, importId, label: "k", passphrase: null, savePassphrase: false }));
  assert.ok(isImportKeyRequest({ owner, importId, label: "k", passphrase: new Uint8Array(3), savePassphrase: true }));
  for (const request of [
    { owner, importId, label: "k", passphrase: null, savePassphrase: true },
    { owner, importId, label: "k", passphrase: new Uint8Array(0), savePassphrase: false },
    { owner, importId, label: "k", passphrase: new Uint8Array(MAX_CREDENTIAL_BYTES + 1), savePassphrase: false },
    { owner, importId, label: "k".repeat(2049), passphrase: null, savePassphrase: false },
    { owner, importId, label: "k", passphrase: null },
    { owner, importId, label: "k", passphrase: null, savePassphrase: false, path: "/etc" },
    { owner, importId: "import", label: "k", passphrase: null, savePassphrase: false },
  ]) assert.equal(isImportKeyRequest(request), false, JSON.stringify(request));

  assert.ok(isChooseKeyFileRequest({ owner }) && isRetrySecretsRequest({ owner }));
  assert.equal(isChooseKeyFileRequest({ owner, defaultPath: "/" }), false);
  assert.ok(isDiscardKeyImportRequest({ owner, importId }));
  assert.ok(isRenameKeyRequest({ owner, keyId, expectedRevision: 2, label: "x" }));
  assert.equal(isRenameKeyRequest({ owner, keyId, expectedRevision: 2 }), false);
  assert.ok(isKeyTargetRequest({ owner, keyId, expectedRevision: 1 }));
  assert.equal(isKeyTargetRequest({ owner, keyId, expectedRevision: 1, force: true }), false);

  assert.ok(isSetIdentityPasswordResponse({ status: "saved" }));
  assert.equal(isSetIdentityPasswordResponse({ status: "secret-store", reason: "Keychain says no" }), false);
  assert.ok(isChooseKeyFileResponse({ status: "chosen", importId, suggestedLabel: "id_ed25519", encrypted: false, algorithm: "ssh-ed25519", fingerprint }));
  for (const response of [
    { status: "chosen", importId, suggestedLabel: "id", encrypted: true, algorithm: "ssh-rsa", fingerprint },
    { status: "chosen", importId, suggestedLabel: "id", encrypted: false, algorithm: null, fingerprint: null },
    { status: "chosen", importId, suggestedLabel: "a\nb", encrypted: true, algorithm: null, fingerprint: null },
    { status: "chosen", importId, suggestedLabel: "id", encrypted: true, algorithm: null, fingerprint: null, path: "/x" },
    { status: "rejected", problem: "ENOENT" },
  ]) assert.equal(isChooseKeyFileResponse(response), false, JSON.stringify(response));
  assert.ok(isImportKeyResponse({ status: "imported", keyId, fingerprint, passphrase: { status: "secret-store", reason: "unknown" } }));
  assert.equal(isImportKeyResponse({ status: "imported", keyId, fingerprint, passphrase: "saved" }), false);
  assert.ok(isForgetKeyPassphraseResponse({ status: "forgotten", cleanup: "pending" }));
  assert.ok(isDeleteKeyResponse({ status: "in-use", identityIds: [id()] }));
  assert.equal(isDeleteKeyResponse({ status: "in-use", identityIds: [] }), false);
  assert.ok(isRetrySecretsResponse({ status: "retried" }));
});

test("identity IPC: owning main frame, one valid argument, and credential bytes wiped only after the awaited operation", async () => {
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send() {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } };
  let release!: () => void;
  const observed: number[][] = [];
  let mode: "wait" | "throw" = "wait";
  const controller = {
    async setIdentityPassword(request: { value: Uint8Array }) {
      if (mode === "throw") throw new Error("/private/path secret");
      await new Promise<void>((resolve) => { release = resolve; });
      observed.push([...request.value]);
      return { ok: true, value: { status: "saved" } };
    },
    async importKey(request: { passphrase: Uint8Array | null }) {
      observed.push([...request.passphrase!]);
      return { ok: true, value: { status: "wrong-passphrase" } };
    },
    async chooseKeyFile() { return { ok: true, value: { status: "cancelled" } }; },
  } as unknown as IdentitiesController;
  let current: IdentitiesController | undefined = controller;
  const unregister = registerIdentityHandlers({ ipc: ipc as unknown as Pick<IpcMain, "handle" | "removeHandler">, boundary, controller: () => current });
  const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event as IpcMainInvokeEvent, ...args) as Promise<Result<unknown>>;
  const event = { sender, senderFrame: mainFrame };
  const password = (bytes = [1, 2, 3]) => ({ owner, identityId: id(), expectedRevision: 1, value: new Uint8Array(bytes) });
  try {
    assert.deepEqual([...handlers.keys()].sort(), [...identityChannels].sort());
    assert.equal(identityChannels.length, 8);

    const accepted = password();
    const pending = invoke(channels.setIdentityPassword, event, accepted);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual([...accepted.value], [1, 2, 3], "bytes stay intact while the operation is in flight");
    release();
    assert.deepEqual(await pending, { ok: true, value: { status: "saved" } });
    assert.deepEqual(observed.at(-1), [1, 2, 3]);
    assert.deepEqual([...accepted.value], [0, 0, 0], "wiped after the await");

    const passphrase = { owner, importId: id(), label: "k", passphrase: new Uint8Array([9, 9]), savePassphrase: false };
    assert.deepEqual(await invoke(channels.importKey, event, passphrase), { ok: true, value: { status: "wrong-passphrase" } });
    assert.deepEqual(observed.at(-1), [9, 9]);
    assert.deepEqual([...passphrase.passphrase], [0, 0]);

    for (const [eventValue, request, extra, expected] of [
      [{ sender: { ...sender }, senderFrame: mainFrame }, password(), [], failure("unauthorized")],
      [{ sender, senderFrame: { url: mainFrame.url } }, password(), [], failure("unauthorized")],
      [event, { ...password(), owner: { windowId: 2, generation: 1 } }, [], failure("unauthorized")],
      [event, { ...password(), owner: { ...owner, generation: 9 } }, [], failure("stale-owner")],
      [event, password(), [password()], failure("invalid-request")],
      [event, { ...password(), extra: 1 }, [], failure("invalid-request")],
      [event, password(Array(MAX_CREDENTIAL_BYTES + 1).fill(7)), [], failure("invalid-request")],
    ] as const) {
      assert.deepEqual(await invoke(channels.setIdentityPassword, eventValue, request, ...extra), expected);
      for (const arg of [request, ...extra]) assert.ok((arg as { value: Uint8Array }).value.every((byte) => byte === 0), "rejected bytes are wiped");
    }
    mode = "throw";
    const thrown = password();
    assert.deepEqual(await invoke(channels.setIdentityPassword, event, thrown), failure("unavailable"), "no upstream text crosses");
    assert.ok(thrown.value.every((byte) => byte === 0));
    current = undefined;
    const missing = password();
    assert.deepEqual(await invoke(channels.setIdentityPassword, event, missing), failure("unavailable"));
    assert.ok(missing.value.every((byte) => byte === 0));
    current = controller;
    assert.deepEqual(await invoke(channels.chooseKeyFile, event, { owner }), { ok: true, value: { status: "cancelled" } });
    assert.deepEqual(await invoke(channels.chooseKeyFile, event), failure("invalid-request"));
  } finally {
    unregister();
    assert.equal(handlers.size, 0);
    boundary.dispose();
  }
});
