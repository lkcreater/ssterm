import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import {
  channels, failure, validateCatalogLabel, isOpenSnippetRequest, isSaveSnippetRequest, isDeleteSnippetRequest,
  MAX_SNIPPET_BODY_BYTES,
  type DeleteSnippetRequest, type DeleteSnippetResponse, type ErrorCode, type OpenSnippetRequest, type OpenSnippetResponse,
  type Result, type SaveSnippetRequest, type SaveSnippetResponse, type SnippetKeyReason, type SnippetProtectionProblem,
} from "@ssterm/contracts";
import type { MetadataRepository } from "@ssterm/domain";
import type { KeyUnavailable, PendingReason, SecretService, SessionRegistry } from "@ssterm/services";
import type { WindowBoundary } from "./boundary";

type Secrets = Pick<SecretService, "saveSnippet" | "openSnippet" | "deleteSnippet" | "initializeContentKey">;
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const storeError = (code: string): ErrorCode =>
  code === "conflict" || code === "constraint" ? "conflict" : code === "busy" ? "busy" : "unavailable";
const keyReason = (reason: KeyUnavailable | PendingReason): SnippetKeyReason =>
  reason === "missing" || reason === "locked" || reason === "denied" || reason === "error" ? reason : "unavailable";
/** A lone surrogate cannot round-trip through UTF-8, so the stored body would differ from what the user typed. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Main-only snippet persistence. Bodies are sealed by the SecretService with the vault content key; plaintext reaches
 * the renderer only as the answer to an explicit open, and nothing here runs, sends or logs a body.
 */
export function createSnippetsController(options: {
  repository: Pick<MetadataRepository, "snapshot" | "commit">;
  secrets: () => Secrets | undefined;
  /** The workspace lock. Absent: never locked. */
  lock?: Pick<SessionRegistry, "locked" | "lockEpoch" | "unlock">;
  /** Whether a locked workspace may unlock. Absent: never. */
  checkAccess?: () => Promise<boolean>;
}) {
  let disposed = false;
  const lockEpoch = () => options.lock?.lockEpoch ?? 0;
  /** The explicit action is the unlock; one that predates a later lock never proceeds (identities rule). */
  async function unlocked(since: number): Promise<boolean> {
    const lock = options.lock;
    if (!lock) return !disposed;
    if (lock.locked && options.checkAccess) await lock.unlock(options.checkAccess, since);
    return !disposed && !lock.locked && lock.lockEpoch === since;
  }
  /** Still the same unlocked period the request started in. */
  const current = (since: number) => () => !disposed && lockEpoch() === since && !options.lock?.locked;
  const snippet = (id: string) => {
    const current = options.repository.snapshot();
    return current.ok ? current.value.snippets.find((row) => row.id === id) : undefined;
  };
  const protection = (result: { status: string; reason?: KeyUnavailable }): SnippetProtectionProblem =>
    result.status === "corrupt" ? { status: "corrupt" } : result.status === "unsupported" ? { status: "unsupported" }
      : { status: "key-unavailable", reason: keyReason(result.reason ?? "unavailable") };

  return {
    async openSnippet(request: OpenSnippetRequest): Promise<Result<OpenSnippetResponse>> {
      const since = lockEpoch();
      if (disposed || !(await unlocked(since))) return failure("unavailable");
      const service = options.secrets();
      if (!service) return ok({ status: "key-unavailable", reason: "unavailable" });
      if (snippet(request.snippetId)?.revision !== request.expectedRevision) return failure("conflict");
      const opened = await service.openSnippet(request.snippetId);
      if (opened.status === "failed") return failure(storeError(opened.code));
      if (opened.status === "not-found") return failure("conflict");
      if (opened.status !== "open") return ok(protection(opened));
      try {
        // A lock or an edit that landed meanwhile wins: no plaintext for a superseded request.
        if (disposed || lockEpoch() !== since || options.lock?.locked) return failure("unavailable");
        if (snippet(request.snippetId)?.revision !== request.expectedRevision) return failure("conflict");
        if (opened.body.disposed) return failure("unavailable");
        // Only a decoder rejection means the authenticated bytes are not text this app wrote.
        let bytes: Uint8Array | undefined;
        try {
          const body = opened.body.use((value) => {
            bytes = value;
            return decoder.decode(value);
          });
          return ok({ status: "open", revision: request.expectedRevision, body });
        } catch (error) {
          return bytes && error instanceof TypeError ? ok({ status: "corrupt" }) : failure("unavailable");
        }
      } finally { opened.body.dispose(); }
    },

    async saveSnippet(request: SaveSnippetRequest): Promise<Result<SaveSnippetResponse>> {
      const since = lockEpoch();
      if (disposed || !(await unlocked(since))) return failure("unavailable");
      const labelCode = validateCatalogLabel(request.label);
      if (labelCode) return ok({ status: "invalid", field: "label", code: labelCode });
      if (LONE_SURROGATE.test(request.body)) return ok({ status: "invalid", field: "body", code: "invalid-text" });
      const snapshot = options.repository.snapshot();
      if (!snapshot.ok) return failure("unavailable");
      const tags = new Set(snapshot.value.tags.map((tag) => tag.id));
      if (request.tagIds.some((id) => !tags.has(id))) return ok({ status: "invalid", field: "tag", code: "not-found" });
      const creating = request.snippetId === null;
      if (!creating && !snapshot.value.snippets.some((row) => row.id === request.snippetId && row.revision === request.expectedRevision))
        return failure("conflict");
      const service = options.secrets();
      if (!service) return ok({ status: "key-unavailable", reason: "unavailable" });
      const body = Buffer.from(request.body, "utf8");
      try {
        if (body.length > MAX_SNIPPET_BODY_BYTES) return ok({ status: "invalid", field: "body", code: "too-large" });
        const id = request.snippetId ?? randomUUID();
        const save = () => service.saveSnippet({
          id, label: request.label.trim(), body, tagIds: [...request.tagIds], fence: current(since),
          ...(request.expectedRevision === null ? {} : { expectedRevision: request.expectedRevision }),
        });
        let saved = await save();
        // The first snippet of a vault creates its content key; an existing key is never replaced.
        if (saved.status === "key-unavailable" && saved.reason === "uninitialized" && creating) {
          if (disposed || lockEpoch() !== since) return failure("unavailable");
          const key = await service.initializeContentKey();
          if (key.status === "pending") return ok({ status: "key-unavailable", reason: keyReason(key.reason) });
          // `constraint`: snippets exist without a key reference; nothing the user can fix by retrying.
          if (key.status === "failed") return key.code === "constraint" ? ok({ status: "key-unavailable", reason: "error" }) : failure(storeError(key.code));
          if (key.status === "cancelled") return ok({ status: "key-unavailable", reason: "unavailable" });
          if (disposed || lockEpoch() !== since) return failure("unavailable");
          saved = await save();
        }
        if (saved.status === "failed")
          return failure(saved.code === "invalid" ? "invalid-request" : saved.code === "fenced" ? "unavailable" : storeError(saved.code));
        if (saved.status !== "saved") return ok(protection(saved));
        const row = saved.snapshot.snippets.find((value) => value.id === id);
        return row ? ok({ status: "saved", snippetId: id, revision: row.revision }) : failure("unavailable");
      } finally { body.fill(0); }
    },

    async deleteSnippet(request: DeleteSnippetRequest): Promise<Result<DeleteSnippetResponse>> {
      const since = lockEpoch();
      if (disposed || !(await unlocked(since))) return failure("unavailable");
      if (snippet(request.snippetId)?.revision !== request.expectedRevision) return failure("conflict");
      const service = options.secrets();
      // Deletion needs no key, so it also works while the Keychain is unavailable.
      const fence = current(since);
      const deleted = service
        ? await service.deleteSnippet(request.snippetId, request.expectedRevision, fence)
        : (() => {
          if (!fence()) return { ok: false as const, error: { code: "fenced" as const } };
          const snapshot = options.repository.snapshot();
          return snapshot.ok ? options.repository.commit({
            expectedCatalogRevision: snapshot.value.catalogRevision,
            changes: [{ type: "delete-snippet", id: request.snippetId, expectedRevision: request.expectedRevision }],
          }) : snapshot;
        })();
      if (deleted.ok) return ok({ status: "deleted" });
      return failure(deleted.error.code === "fenced" ? "unavailable" : storeError(deleted.error.code));
    },

    dispose(): void {
      disposed = true;
    },
  };
}
export type SnippetsController = ReturnType<typeof createSnippetsController>;

/** Every IPC channel `registerSnippetHandlers` owns. */
export const snippetChannels = Object.freeze([channels.openSnippet, channels.saveSnippet, channels.deleteSnippet]);

export function registerSnippetHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => SnippetsController | undefined;
}): () => void {
  const handle = <T>(channel: string, validate: (value: unknown) => value is T,
    run: (controller: SnippetsController, request: T) => Promise<unknown>) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        return await run(controller, request);
      } catch { return failure("unavailable"); }
    });
  };
  handle(channels.openSnippet, isOpenSnippetRequest, (controller, request) => controller.openSnippet(request));
  handle(channels.saveSnippet, isSaveSnippetRequest, (controller, request) => controller.saveSnippet(request));
  handle(channels.deleteSnippet, isDeleteSnippetRequest, (controller, request) => controller.deleteSnippet(request));
  return () => { for (const channel of snippetChannels) options.ipc.removeHandler(channel); };
}
