import type { IpcMain } from "electron";
import {
  channels,
  failure,
  isTeamStateRequest,
  isTeamCommandRequest,
  isTeamView,
  isTeamReply,
  type TeamReply,
  type Owner,
} from "@ssterm/contracts";
import type { TeamClient } from "@ssterm/services/team";
import type { WindowBoundary } from "./boundary";
export function registerTeamHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: Pick<WindowBoundary, "authorizeOwner">;
  client: () => TeamClient | undefined;
  lockSessions?(): void;
  saveKit(
    owner: Owner,
    kit: Uint8Array,
    current: () => boolean,
  ): Promise<boolean>;
  openKit(
    owner: Owner,
    current: () => boolean,
  ): Promise<Uint8Array | undefined>;
}) {
  const active = new Set<number>();
  const drafts = new Map<
    string,
    {
      owner: Owner;
      kit: string;
      expires: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const purge = () => {
    for (const d of drafts.values()) clearTimeout(d.timer);
    drafts.clear();
  };
  const view = (client: TeamClient) => {
    const value = client.state();
    return isTeamView(value) ? structuredClone(value) : undefined;
  };
  options.ipc.handle(channels.teamState, (event, ...args: unknown[]) => {
    const request = args[0];
    const auth = options.boundary.authorizeOwner(
      event,
      request && typeof request === "object" && "owner" in request
        ? request.owner
        : undefined,
    );
    if (!auth.ok) return auth;
    if (args.length !== 1 || !isTeamStateRequest(request))
      return failure("invalid-request");
    const client = options.client();
    if (!client) return failure("unavailable");
    const state = view(client);
    return state ? { ok: true, value: state } : failure("unavailable");
  });
  options.ipc.handle(
    channels.teamCommand,
    async (event, ...args: unknown[]) => {
      const request = args[0];
      const auth = options.boundary.authorizeOwner(
        event,
        request && typeof request === "object" && "owner" in request
          ? request.owner
          : undefined,
      );
      if (!auth.ok) return auth;
      if (args.length !== 1 || !isTeamCommandRequest(request))
        return failure("invalid-request");
      const client = options.client();
      if (!client) return failure("unavailable");
      if (active.has(auth.value.windowId)) return failure("busy");
      active.add(auth.value.windowId);
      client.unlock();
      const epoch = client.lifecycleEpoch();
      const current = () =>
        client.lifecycleEpoch() === epoch &&
        options.boundary.authorizeOwner(event, request.owner).ok;
      let detail: TeamReply["detail"] = { kind: "none" };
      let outcome: TeamReply["outcome"] = "ok";
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
          case "finish-join":
            result = await client.finishJoin();
            break;
          case "fetch":
            result = await client.fetch();
            break;
          case "invite": {
            const r = await client.invitePrincipal(a);
            result = r;
            if (r.ok) detail = { kind: "invitation", invitation: r.value };
            break;
          }
          case "reissue-token": {
            const r = await client.reissuePrincipalToken(a);
            result = r;
            if (r.ok) detail = { kind: "invitation", invitation: r.value };
            break;
          }
          case "save-host":
            result = await client.saveHost(a);
            break;
          case "delete-host":
            result = await client.deleteHost(a);
            break;
          case "share-password":
            try {
              const password = new TextDecoder("utf-8", { fatal: true }).decode(
                a.password,
              );
              result = await client.sharePassword({ ...a, password });
            } finally {
              a.password.fill(0);
            }
            break;
          case "detach-password":
            result = await client.detachPassword(a);
            break;
          case "change-role":
            result = await client.changeRole(a);
            break;
          case "revoke-principal":
            result = await client.revokePrincipal(a);
            break;
          case "audit": {
            const r = await client.audit(a);
            result = r;
            if (r.ok) detail = { kind: "audit", page: r.value };
            break;
          }
          case "resume":
            result = await client.resume(a);
            break;
          case "cancel-setup":
            result = await client.cancelSetup();
            break;
          case "logout":
            options.lockSessions?.();
            purge();
            result = await client.logout(a);
            break;
          case "create-recovery": {
            purge();
            const r = await client.createRecovery();
            result = r;
            if (!r.ok) break;
            const bytes = new TextEncoder().encode(r.value.kit);
            let saved = false;
            try {
              saved = await options.saveKit(auth.value, bytes, current);
            } finally {
              bytes.fill(0);
            }
            if (!current()) {
              client.cancelRecovery();
              return failure("unauthorized");
            }
            if (!saved) {
              client.cancelRecovery();
              outcome = "cancelled";
              break;
            }
            if (r.value.expiresAt <= Date.now()) {
              client.cancelRecovery();
              return failure("conflict");
            }
            const key = r.value.confirmationToken;
            const timer = setTimeout(() => {
              drafts.delete(key);
              client.cancelRecovery();
            }, r.value.expiresAt - Date.now());
            timer.unref();
            drafts.set(key, {
              owner: auth.value,
              kit: r.value.kit,
              expires: r.value.expiresAt,
              timer,
            });
            detail = {
              kind: "recovery",
              confirmationToken: key,
              secret: r.value.secret,
              saved: true,
            };
            break;
          }
          case "confirm-recovery": {
            const d = drafts.get(a.confirmationToken);
            if (
              !d ||
              d.expires <= Date.now() ||
              d.owner.windowId !== auth.value.windowId ||
              d.owner.generation !== auth.value.generation
            )
              return failure("conflict");
            drafts.delete(a.confirmationToken);
            clearTimeout(d.timer);
            result = await client.confirmRecovery({ ...a, kit: d.kit });
            break;
          }
          case "recover": {
            const bytes = await options.openKit(auth.value, current);
            if (!current()) {
              bytes?.fill(0);
              return failure("unauthorized");
            }
            if (!bytes) {
              result = { ok: true };
              outcome = "cancelled";
              break;
            }
            try {
              result = await client.recover({
                ...a,
                kit: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
              });
            } finally {
              bytes.fill(0);
            }
            break;
          }
        }
        if (!result.ok) {
          outcome = "failed";
          code =
            result.code && /^[a-z-]{1,64}$/.test(result.code)
              ? result.code
              : "unavailable";
          detail = { kind: "none" };
        }
        if (
          !options.boundary.authorizeOwner(event, request.owner).ok ||
          (a.type !== "logout" && !current())
        ) {
          purge();
          client.lock();
          return failure("unauthorized");
        }
        const reply = { state: view(client), outcome, code, detail };
        return isTeamReply(reply)
          ? { ok: true, value: reply }
          : failure("unavailable");
      } catch {
        client.cancelRecovery();
        return failure("unavailable");
      } finally {
        if (request.action.type === "share-password")
          request.action.password.fill(0);
        active.delete(auth.value.windowId);
      }
    },
  );
  return {
    purge,
    dispose() {
      purge();
      options.ipc.removeHandler(channels.teamState);
      options.ipc.removeHandler(channels.teamCommand);
    },
  };
}
