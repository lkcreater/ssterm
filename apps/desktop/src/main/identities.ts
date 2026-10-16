import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import {
  channels, failure, validateCatalogLabel, MAX_KEY_FILE_BYTES,
  isSetIdentityPasswordRequest, isChooseKeyFileRequest, isImportKeyRequest, isDiscardKeyImportRequest, isRenameKeyRequest,
  isKeyTargetRequest, isRetrySecretsRequest,
  type ChooseKeyFileRequest, type ChooseKeyFileResponse, type DeleteKeyResponse, type DiscardKeyImportRequest,
  type DiscardKeyImportResponse, type ErrorCode, type ForgetKeyPassphraseResponse, type ImportKeyRequest, type ImportKeyResponse,
  type KeyAlgorithm, type KeyFileProblem, type KeyTargetRequest, type Owner, type RenameKeyRequest, type RenameKeyResponse,
  type Result, type RetrySecretsResponse, type SecretStoreProblem, type SecretStoreReason, type SetIdentityPasswordRequest,
  type SetIdentityPasswordResponse,
} from "@ssterm/contracts";
import type { Id, MetadataChange, MetadataRepository, SecretKind, SecretOperation } from "@ssterm/domain";
import { preparePrivateKey } from "@ssterm/adapters/ssh";
import type { PendingReason, SecretResult, SecretService, SessionRegistry, TransientSecret, TransientSecrets } from "@ssterm/services";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";

type Secrets = Pick<SecretService, "storeSecret" | "cancel" | "removeSecrets" | "reconcile">;
interface HeldImport {
  importId: string;
  secret: TransientSecret;
  encrypted: boolean;
  busy: boolean;
}
export const KEY_IMPORT_TTL_MS = 5 * 60_000;
const TEST_NAMESPACE = /^dev\.ssterm\.test\.[0-9a-f-]{36}$/u;

/** Test profiles never touch the production Keychain namespace: no valid test namespace means no secret store (fail closed). */
export function secretNamespace(env: Readonly<Record<string, string | undefined>>, production: string): string | undefined {
  if (!env.SSTERM_TEST_USER_DATA) return production;
  const namespace = env.SSTERM_TEST_SECRET_NAMESPACE;
  return namespace && TEST_NAMESPACE.test(namespace) ? namespace : undefined;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const problem = (reason: SecretStoreReason): SecretStoreProblem => ({ status: "secret-store", reason });
const reasonOf = (reason: PendingReason): SecretStoreReason =>
  reason === "locked" || reason === "denied" || reason === "unavailable" ? reason : "unknown";
const storeError = (code: string): ErrorCode =>
  code === "conflict" || code === "constraint" ? "conflict" : code === "busy" ? "busy" : "unavailable";
const unresolved = (op: SecretOperation) => op.action !== "delete" && ["staged", "reconcile", "needs-input"].includes(op.state);
/** Buffer.alloc never shares the pooled slab, so wiping the copy wipes every byte of it. */
const owned = (bytes: Uint8Array): Buffer => {
  const copy = Buffer.alloc(bytes.length);
  copy.set(bytes);
  return copy;
};

/** Reads at most one byte past the bound so a file that grows after fstat is still refused. */
async function readKeyFile(path: string): Promise<Buffer | KeyFileProblem> {
  let handle: Awaited<ReturnType<typeof open>>;
  // Non-blocking so a FIFO or device cannot stall main before fstat rejects it.
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); } catch { return "unreadable"; }
  const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return "unreadable";
    if (stat.size > MAX_KEY_FILE_BYTES) return "too-large";
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > MAX_KEY_FILE_BYTES) return "too-large";
    }
    return length === 0 ? "invalid" : owned(buffer.subarray(0, length));
  } catch {
    return "unreadable";
  } finally {
    buffer.fill(0);
    await handle.close().catch(() => undefined);
  }
}
function suggestedLabel(path: string): string {
  const name = [...basename(path).replace(/[\u0000-\u001f\u007f]/gu, "").trim()].slice(0, 200).join("").trim();
  return validateCatalogLabel(name) ? "SSH key" : name;
}

/** Main-only identity credentials and key import. Secret bytes, file paths, refs and operation ids never leave main. */
export function createIdentitiesController(options: {
  repository: Pick<MetadataRepository, "snapshot" | "commit">;
  secrets: () => Secrets | undefined;
  transient: TransientSecrets;
  /** A native open dialog parented to the owner's window; undefined when cancelled. */
  pickFile: (owner: Owner) => Promise<string | undefined>;
  /** The workspace lock. Absent: never locked. */
  lock?: Pick<SessionRegistry, "locked" | "lockEpoch" | "unlock">;
  /** Whether a locked workspace may unlock. Absent: never. */
  checkAccess?: () => Promise<boolean>;
  importTtlMs?: number;
}) {
  const dialogs = new Map<string, object>();
  const imports = new Map<string, HeldImport>();
  let disposed = false;
  const snapshot = () => {
    const current = options.repository.snapshot();
    return current.ok ? current.value : undefined;
  };
  const drop = (key: string) => {
    imports.get(key)?.secret.dispose();
    imports.delete(key);
  };
  /** Never leave a write the user was told failed half-finished in the journal. */
  async function settle(service: Secrets, result: SecretResult): Promise<true | SecretStoreProblem | ErrorCode> {
    switch (result.status) {
      case "published": return true;
      case "pending": {
        // "Nothing was saved" holds only once the cancel resolved; otherwise the write may still have landed.
        const cancelled = await service.cancel(result.operationId).catch(() => undefined);
        return problem(cancelled?.status === "cancelled" ? reasonOf(result.reason) : "unknown");
      }
      // The owner moved or vanished between staging and publication.
      case "cancelled": return "conflict";
      default: return result.code === "invalid" ? problem("unknown") : storeError(result.code);
    }
  }
  /** One unresolved operation per owner slot: cancel leftovers before staging or removing. */
  async function clearSlots(service: Secrets, ownerId: Id, kind?: SecretKind): Promise<SecretStoreProblem | undefined> {
    for (const op of snapshot()?.secretOperations ?? []) {
      if (op.ownerId !== ownerId || (kind && op.kind !== kind) || !unresolved(op)) continue;
      const cancelled = await service.cancel(op.operationId);
      if (cancelled.status === "pending") return problem(reasonOf(cancelled.reason));
    }
    return undefined;
  }
  /**
   * Domain Lock: these explicit user actions are the unlock. `since` is the lock epoch on arrival, so an action
   * that predates a later lock never unlocks or proceeds after it (the same rule as Reconnect).
   */
  async function unlocked(since: number): Promise<boolean> {
    const lock = options.lock;
    if (!lock) return true;
    if (lock.locked && options.checkAccess) await lock.unlock(options.checkAccess, since);
    return !disposed && !lock.locked && lock.lockEpoch === since;
  }
  const lockEpoch = () => options.lock?.lockEpoch ?? 0;
  const keyTarget = (request: KeyTargetRequest) => {
    const key = snapshot()?.keys.find((row) => row.id === request.keyId);
    return key && key.revision === request.expectedRevision ? key : undefined;
  };

  return {
    async setIdentityPassword(request: SetIdentityPasswordRequest): Promise<Result<SetIdentityPasswordResponse>> {
      const since = lockEpoch();
      if (disposed || !(await unlocked(since))) return failure("unavailable");
      const service = options.secrets();
      if (!service) return ok(problem("unavailable"));
      const current = () => snapshot()?.identities.find((row) => row.id === request.identityId && row.revision === request.expectedRevision);
      const identity = current();
      if (!identity) return failure("conflict");
      if (identity.method !== "password") return failure("invalid-request");
      const blocked = await clearSlots(service, identity.id, "password");
      if (blocked) return ok(blocked);
      if (lockEpoch() !== since) return failure("unavailable");
      const oldRef = current()?.passwordRef;
      if (oldRef === undefined) return failure("conflict");
      const value = owned(request.value);
      try {
        const settled = await settle(service, await service.storeSecret({
          kind: "password", owner: { type: "identity", id: identity.id, expectedRevision: request.expectedRevision }, oldRef, value,
        }));
        return settled === true ? ok({ status: "saved" }) : typeof settled === "string" ? failure(settled) : ok(settled);
      } finally { value.fill(0); }
    },

    async chooseKeyFile(request: ChooseKeyFileRequest): Promise<Result<ChooseKeyFileResponse>> {
      if (disposed || !options.secrets()) return failure("unavailable");
      const key = sessionOwnerId(request.owner);
      if (dialogs.has(key) || imports.get(key)?.busy) return failure("busy");
      const token = {};
      dialogs.set(key, token);
      let bytes: Buffer | KeyFileProblem | undefined;
      try {
        let path: string | undefined;
        try { path = await options.pickFile({ ...request.owner }); } catch { path = undefined; }
        if (path && dialogs.get(key) === token) bytes = await readKeyFile(path);
        // Revocation (reload, close, quit) during the dialog removes the token.
        if (disposed || dialogs.get(key) !== token) return failure("stale-owner");
        if (!path || bytes === undefined) return ok({ status: "cancelled" });
        if (typeof bytes === "string") return ok({ status: "rejected", problem: bytes });
        const parsed = preparePrivateKey(bytes);
        let algorithm: KeyAlgorithm | null = null, fingerprint: string | null = null;
        if (parsed.ok) {
          algorithm = parsed.key.identity.algorithm as KeyAlgorithm;
          fingerprint = parsed.key.identity.fingerprint;
          parsed.key.dispose();
        } else if (parsed.code !== "credentials-required")
          return ok({ status: "rejected", problem: parsed.code === "unsupported-private-key" ? "unsupported" : "invalid" });
        if (imports.get(key)?.busy) return failure("busy");
        drop(key);
        const importId = randomUUID();
        imports.set(key, {
          importId, secret: options.transient.hold(bytes, options.importTtlMs ?? KEY_IMPORT_TTL_MS), encrypted: !parsed.ok, busy: false,
        });
        return ok({ status: "chosen", importId, suggestedLabel: suggestedLabel(path), encrypted: !parsed.ok, algorithm, fingerprint });
      } finally {
        if (dialogs.get(key) === token) dialogs.delete(key);
        if (bytes instanceof Buffer) bytes.fill(0);
      }
    },

    async importKey(request: ImportKeyRequest): Promise<Result<ImportKeyResponse>> {
      const since = lockEpoch();
      if (disposed) return failure("unavailable");
      if (validateCatalogLabel(request.label)) return failure("invalid-request");
      const key = sessionOwnerId(request.owner);
      if (!(await unlocked(since))) {
        // A lock that arrived meanwhile already purged the held bytes; the import is over.
        if (lockEpoch() !== since) drop(key);
        return failure("unavailable");
      }
      const held = imports.get(key);
      if (!held || held.importId !== request.importId) return ok({ status: "expired" });
      if (held.busy) return failure("busy");
      if (held.secret.disposed) {
        imports.delete(key);
        return ok({ status: "expired" });
      }
      if (!held.encrypted && request.passphrase !== null) return failure("invalid-request");
      if (held.encrypted && request.passphrase === null) return ok({ status: "wrong-passphrase" });
      const service = options.secrets();
      if (!service) return ok(problem("unavailable"));
      held.busy = true;
      // Controller-owned copies: a lock purge disposes the held view, never these.
      const bytes = held.secret.use(owned);
      const phrase = request.passphrase && owned(request.passphrase);
      try {
        const parsed = preparePrivateKey(bytes, phrase ?? undefined);
        if (!parsed.ok && held.encrypted && parsed.code !== "unsupported-private-key") return ok({ status: "wrong-passphrase" });
        // Single use from here on.
        if (imports.get(key) === held) drop(key);
        if (!parsed.ok) return ok({ status: "rejected", problem: parsed.code === "unsupported-private-key" ? "unsupported" : "invalid" });
        const { algorithm, publicKey, fingerprint } = parsed.key.identity;
        parsed.key.dispose();
        const keyId = randomUUID();
        const stored = await settle(service, await service.storeSecret({
          kind: "private-key", owner: { type: "key", id: keyId, expectedRevision: null }, value: bytes,
          publish: (ref): MetadataChange[] => [{
            type: "create-key", id: keyId, data: { label: request.label, algorithm, publicKey, fingerprint, privateKeyRef: ref },
          }],
        }));
        if (stored !== true) return typeof stored === "string" ? failure(stored) : ok(stored);
        let passphrase: Extract<ImportKeyResponse, { status: "imported" }>["passphrase"] = { status: "not-saved" };
        // The key is published; a lock during its write only stops the second, optional write.
        if (request.savePassphrase && phrase && lockEpoch() !== since) passphrase = problem("locked");
        else if (request.savePassphrase && phrase) {
          const saved = await settle(service, await service.storeSecret({
            kind: "passphrase", owner: { type: "key", id: keyId, expectedRevision: 1 }, oldRef: null, value: phrase,
          }));
          passphrase = saved === true ? { status: "saved" } : typeof saved === "string" ? problem("unknown") : saved;
        }
        return ok({ status: "imported", keyId, fingerprint, passphrase });
      } finally {
        bytes.fill(0);
        phrase?.fill(0);
        held.busy = false;
      }
    },

    discardKeyImport(request: DiscardKeyImportRequest): Result<DiscardKeyImportResponse> {
      const key = sessionOwnerId(request.owner);
      const held = imports.get(key);
      if (held?.importId === request.importId && !held.busy) drop(key);
      return ok({ status: "discarded" });
    },

    renameKey(request: RenameKeyRequest): Result<RenameKeyResponse> {
      if (disposed) return failure("unavailable");
      if (validateCatalogLabel(request.label)) return failure("invalid-request");
      const current = options.repository.snapshot();
      if (!current.ok) return failure("unavailable");
      if (!keyTarget(request)) return failure("conflict");
      const committed = options.repository.commit({
        expectedCatalogRevision: current.value.catalogRevision,
        changes: [{ type: "update-key", id: request.keyId, expectedRevision: request.expectedRevision, data: { label: request.label } }],
      });
      return committed.ok ? ok({ status: "renamed" }) : failure(storeError(committed.error.code));
    },

    async forgetKeyPassphrase(request: KeyTargetRequest): Promise<Result<ForgetKeyPassphraseResponse>> {
      const since = lockEpoch();
      if (disposed || !(await unlocked(since))) return failure("unavailable");
      const service = options.secrets();
      if (!service) return ok(problem("unavailable"));
      if (!keyTarget(request)) return failure("conflict");
      const blocked = await clearSlots(service, request.keyId, "passphrase");
      if (blocked) return ok(blocked);
      if (lockEpoch() !== since) return failure("unavailable");
      const key = keyTarget(request);
      if (!key) return failure("conflict");
      if (key.passphraseRef === null) return ok({ status: "forgotten", cleanup: "cleaned" });
      const removed = await service.removeSecrets(
        [{ type: "update-key", id: key.id, expectedRevision: key.revision, data: { passphraseRef: null } }], [key.passphraseRef]);
      if (removed.status === "failed") return failure(storeError(removed.code));
      return ok({ status: "forgotten", cleanup: removed.cleanup.every((row) => row.status === "cleaned") ? "cleaned" : "pending" });
    },

    async deleteKey(request: KeyTargetRequest): Promise<Result<DeleteKeyResponse>> {
      const since = lockEpoch();
      if (disposed || !(await unlocked(since))) return failure("unavailable");
      const service = options.secrets();
      if (!service) return ok(problem("unavailable"));
      const users = () => (snapshot()?.identities ?? []).filter((row) => row.keyId === request.keyId).map((row) => row.id);
      if (!keyTarget(request)) return failure("conflict");
      if (users().length) return ok({ status: "in-use", identityIds: users() });
      const blocked = await clearSlots(service, request.keyId);
      if (blocked) return ok(blocked);
      if (lockEpoch() !== since) return failure("unavailable");
      const key = keyTarget(request);
      if (!key) return failure("conflict");
      // Re-checked after the await; the repository also refuses a key an identity still references.
      if (users().length) return ok({ status: "in-use", identityIds: users() });
      const refs = [key.privateKeyRef, key.passphraseRef].filter((ref): ref is Id => ref !== null);
      const removed = await service.removeSecrets([{ type: "delete-key", id: key.id, expectedRevision: key.revision }], refs);
      if (removed.status === "failed") return failure(storeError(removed.code));
      return ok({ status: "deleted", cleanup: removed.cleanup.every((row) => row.status === "cleaned") ? "cleaned" : "pending" });
    },

    /** Resolves unfinished journal rows, then cancels identity/key writes whose input is gone so their slots unblock. */
    async retrySecrets(): Promise<Result<RetrySecretsResponse>> {
      const since = lockEpoch();
      if (disposed || !(await unlocked(since))) return failure("unavailable");
      const service = options.secrets();
      if (!service) return ok(problem("unavailable"));
      await service.reconcile();
      for (const op of snapshot()?.secretOperations ?? [])
        if (op.state === "needs-input" && (op.ownerType === "identity" || op.ownerType === "key")) await service.cancel(op.operationId);
      return ok({ status: "retried" });
    },

    /** A catalog apply queued Keychain deletions; while locked they wait for the next unlock, retry or startup. */
    cleanupQueued(): void {
      if (disposed || options.lock?.locked) return;
      void options.secrets()?.reconcile().catch(() => undefined);
    },
    revokeOwner(owner: Owner): void {
      const key = sessionOwnerId(owner);
      dialogs.delete(key);
      drop(key);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      dialogs.clear();
      for (const key of [...imports.keys()]) drop(key);
    },
  };
}
export type IdentitiesController = ReturnType<typeof createIdentitiesController>;

/** Every IPC channel `registerIdentityHandlers` owns. */
export const identityChannels = Object.freeze([
  channels.setIdentityPassword, channels.chooseKeyFile, channels.importKey, channels.discardKeyImport, channels.renameKey,
  channels.forgetKeyPassphrase, channels.deleteKey, channels.retrySecrets,
]);

/** IPC owns the deserialized credential bytes and erases them once the awaited operation has settled. */
function wipe(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const field of ["value", "passphrase"])
    if (field in value) {
      const bytes = (value as Record<string, unknown>)[field];
      if (bytes instanceof Uint8Array) bytes.fill(0);
    }
}

export function registerIdentityHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => IdentitiesController | undefined;
}): () => void {
  const handle = <T>(channel: string, validate: (value: unknown) => value is T,
    run: (controller: IdentitiesController, request: T) => unknown) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        // Awaited here so the finally below wipes only after the controller is done with the bytes.
        return await run(controller, request);
      } catch { return failure("unavailable"); }
      finally { for (const arg of args) wipe(arg); }
    });
  };
  handle(channels.setIdentityPassword, isSetIdentityPasswordRequest, (controller, request) => controller.setIdentityPassword(request));
  handle(channels.chooseKeyFile, isChooseKeyFileRequest, (controller, request) => controller.chooseKeyFile(request));
  handle(channels.importKey, isImportKeyRequest, (controller, request) => controller.importKey(request));
  handle(channels.discardKeyImport, isDiscardKeyImportRequest, (controller, request) => controller.discardKeyImport(request));
  handle(channels.renameKey, isRenameKeyRequest, (controller, request) => controller.renameKey(request));
  handle(channels.forgetKeyPassphrase, isKeyTargetRequest, (controller, request) => controller.forgetKeyPassphrase(request));
  handle(channels.deleteKey, isKeyTargetRequest, (controller, request) => controller.deleteKey(request));
  handle(channels.retrySecrets, isRetrySecretsRequest, (controller) => controller.retrySecrets());
  return () => { for (const channel of identityChannels) options.ipc.removeHandler(channel); };
}
