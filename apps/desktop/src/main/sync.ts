import type { MetadataRepository } from "@ssterm/domain";
import type { IpcMain } from "electron";
import {
  channels,
  failure,
  isSyncCommandRequest,
  isSyncStateRequest,
  isSyncView,
  isSyncReply,
  type SyncReply,
  type SyncView,
  type Owner,
} from "@ssterm/contracts";
import type { SyncClient } from "@ssterm/services/sync";
import type { WindowBoundary } from "./boundary";

/** Borrow the catalog; enforce the active-resource policy synchronously at the actual commit, after async preparation. */
export function guardSyncCatalog(
  repository: MetadataRepository,
  canApply: () => boolean,
): MetadataRepository {
  return {
    snapshot: () => repository.snapshot(),
    commit: (request) =>
      canApply()
        ? repository.commit(request)
        : {
            ok: false,
            error: {
              code: "conflict",
              message: "Stop active tunnels before applying sync changes.",
            },
          },
    backup: (request) => repository.backup(request),
    close: () => {},
  };
}

export const syncChannels = Object.freeze([
  channels.syncState,
  channels.syncCommand,
]);
type Draft = {
  owner: Owner;
  kit: Uint8Array;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
};
/** The renderer gets only bounded status, explicit review and public enrollment text. Recovery paths stay in main. */
export function registerSyncHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: Pick<WindowBoundary, "authorizeOwner">;
  client: () => SyncClient | undefined;
  /** Existing catalog policy: stop active/starting/stopping tunnels before changing their configuration graph. */
  canApply?: () => boolean;
  saveKit(
    owner: Owner,
    kit: Uint8Array,
    current: () => boolean,
  ): Promise<boolean>;
  openKit(
    owner: Owner,
    current: () => boolean,
  ): Promise<Uint8Array | undefined>;
}): { dispose(): void; purge(): void } {
  const drafts = new Map<string, Draft>();
  const activeWindows = new Set<number>();
  const purge = () => {
    for (const draft of drafts.values()) {
      clearTimeout(draft.timer);
      draft.kit.fill(0);
    }
    drafts.clear();
  };
  const view = (client: SyncClient): SyncView | undefined => {
    try {
      const state: unknown = client.state();
      return isSyncView(state) ? structuredClone(state) : undefined;
    } catch {
      return undefined;
    }
  };
  options.ipc.handle(channels.syncState, (event, ...args: unknown[]) => {
    const request = args[0];
    const authorized = options.boundary.authorizeOwner(
      event,
      request && typeof request === "object" && "owner" in request
        ? request.owner
        : undefined,
    );
    if (!authorized.ok) return authorized;
    if (args.length !== 1 || !isSyncStateRequest(request))
      return failure("invalid-request");
    const client = options.client();
    if (!client) return failure("unavailable");
    client.unlock();
    const state = view(client);
    return state ? { ok: true, value: state } : failure("unavailable");
  });
  options.ipc.handle(
    channels.syncCommand,
    async (event, ...args: unknown[]) => {
      const request = args[0];
      const owner =
        request && typeof request === "object" && "owner" in request
          ? request.owner
          : undefined;
      const authorized = options.boundary.authorizeOwner(event, owner);
      if (!authorized.ok) return authorized;
      if (args.length !== 1 || !isSyncCommandRequest(request))
        return failure("invalid-request");
      const client = options.client();
      if (!client) return failure("unavailable");
      const stillOwner = () => options.boundary.authorizeOwner(event, owner).ok;
      if (activeWindows.has(authorized.value.windowId)) return failure("busy");
      activeWindows.add(authorized.value.windowId);
      client.unlock();
      const epoch = client.lifecycleEpoch();
      const current = () => client.lifecycleEpoch() === epoch && stillOwner();
      let detail: SyncReply["detail"] = { kind: "none" };
      let outcome: SyncReply["outcome"] = "ok";
      let code: string | null = null;
      try {
        const a = request.action;
        let result: { ok: boolean; code?: string; value?: unknown };
        switch (a.type) {
          case "create":
            result = await client.create(a);
            break;
          case "begin-join": {
            const r = await client.beginJoin(a);
            result = r;
            if (r.ok)
              detail = {
                kind: "text",
                text: r.value.candidateText,
                fingerprint: null,
              };
            break;
          }
          case "challenge": {
            const r = await client.challengeEnrollment(a);
            result = r;
            if (r.ok)
              detail = {
                kind: "text",
                text: r.value.challengeText,
                fingerprint: r.value.fingerprint,
              };
            break;
          }
          case "prove": {
            const r = await client.proveEnrollment(a);
            result = r;
            if (r.ok)
              detail = {
                kind: "text",
                text: r.value.proofText,
                fingerprint: r.value.fingerprint,
              };
            break;
          }
          case "approve":
            result = await client.approveEnrollment(a);
            break;
          case "resume":
            result = await client.resume(a);
            break;
          case "cancel-setup":
            result = await client.cancelSetup();
            break;
          case "finish-join":
            result = await client.finishJoin();
            break;
          case "fetch":
            result = await client.fetch();
            break;
          case "publish":
            result = await client.publish();
            break;
          case "review": {
            const r = await client.review(a);
            result = r;
            if (r.ok) detail = { kind: "review", review: r.value };
            break;
          }
          case "apply":
            if (options.canApply?.() === false) {
              result = { ok: false, code: "active-tunnels" };
              break;
            }
            result = await client.apply(a);
            break;
          case "rotate":
            result = await client.rotate(a);
            break;
          case "create-recovery": {
            purge();
            const r = await client.createRecovery();
            result = r;
            if (!r.ok) break;
            try {
              let saved: boolean;
              try {
                saved = await options.saveKit(
                  authorized.value,
                  r.value.kit,
                  current,
                );
              } catch {
                client.cancelRecovery();
                throw new Error("Recovery save unavailable.");
              }
              if (!current()) {
                client.lock();
                return failure("unauthorized");
              }
              if (!saved) {
                client.cancelRecovery();
                outcome = "cancelled";
                break;
              }
              const confirmationToken = r.value.confirmationToken;
              const timer = setTimeout(() => {
                const expired = drafts.get(confirmationToken);
                expired?.kit.fill(0);
                drafts.delete(confirmationToken);
              }, 300_000);
              timer.unref();
              drafts.set(confirmationToken, {
                owner: authorized.value,
                kit: Uint8Array.from(r.value.kit),
                expires: Date.now() + 300_000,
                timer,
              });
              detail = {
                kind: "recovery",
                confirmationToken: r.value.confirmationToken,
                secret: r.value.secret,
                saved,
              };
            } finally {
              r.value.kit.fill(0);
            }
            break;
          }
          case "confirm-recovery": {
            const draft = drafts.get(a.confirmationToken);
            if (draft && draft.expires <= Date.now()) {
              clearTimeout(draft.timer);
              draft.kit.fill(0);
              drafts.delete(a.confirmationToken);
            }
            if (
              !draft ||
              draft.expires <= Date.now() ||
              draft.owner.windowId !== authorized.value.windowId ||
              draft.owner.generation !== authorized.value.generation
            )
              return failure("conflict");
            drafts.delete(a.confirmationToken);
            clearTimeout(draft.timer);
            try {
              result = await client.confirmRecovery({ ...a, kit: draft.kit });
            } finally {
              draft.kit.fill(0);
            }
            break;
          }
          case "recover": {
            const kit = await options.openKit(authorized.value, current);
            if (!current()) {
              kit?.fill(0);
              return failure("unauthorized");
            }
            if (!kit)
              return {
                ok: true,
                value: {
                  state: view(client),
                  outcome: "cancelled",
                  code: null,
                  detail,
                },
              };
            try {
              result = await client.recover({ ...a, kit });
            } finally {
              kit.fill(0);
            }
            break;
          }
          case "logout":
            purge();
            result = await client.logout(a);
            break;
        }
        if (!result.ok) {
          outcome = "failed";
          code =
            typeof result.code === "string" &&
            /^[a-z-]{1,64}$/.test(result.code)
              ? result.code
              : "unavailable";
          detail = { kind: "none" };
        }
        if (!stillOwner() || (a.type !== "logout" && !current())) {
          purge();
          client.lock();
          return failure("unauthorized");
        }
        const state = view(client);
        const reply = { state, outcome, code, detail };
        return isSyncReply(reply)
          ? { ok: true, value: reply }
          : failure("unavailable");
      } catch {
        return failure("unavailable");
      } finally {
        activeWindows.delete(authorized.value.windowId);
      }
    },
  );
  return {
    purge,
    dispose() {
      purge();
      for (const channel of syncChannels) options.ipc.removeHandler(channel);
    },
  };
}
