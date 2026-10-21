/** Main-only bounded team transport, independent of personal sync. */
import { createHash } from "node:crypto";
import { frame } from "./sync-crypto.ts";
import { validSyncEndpoint } from "./sync-transport.ts";
import {
  SYNC_HTTP_MAX,
  isSyncChallenge,
  isSyncOperationPublication,
  type SyncOperationPublication,
  syncHash,
  syncObject,
  syncInteger,
  syncTransportCodes,
  syncUuid,
  type SyncTransportResult,
} from "../../domain/src/sync.ts";
import * as T from "../../domain/src/team.ts";
export interface TeamTransport {
  operation(
    domain: "metadata" | "credentials",
    hash: string,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<SyncOperationPublication>>;
  info(signal?: AbortSignal): Promise<SyncTransportResult<T.TeamInfo>>;
  policies(
    afterGeneration: number,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T.TeamPoliciesResponse>>;
  publish(
    request: T.TeamPublishRequest,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T.TeamReceipt>>;
  state(
    request: T.TeamStateRequest,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T.TeamState>>;
  writeMetadata(
    request: T.TeamWriteRequest,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T.TeamWriteReceipt>>;
  writeCredentials(
    request: T.TeamWriteRequest,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T.TeamWriteReceipt>>;
  connect(
    request: T.TeamConnectRequest,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T.TeamConnectGrant>>;
  audit(
    after: number,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T.TeamAuditPage>>;
  events(
    events: T.TeamClientEvent[],
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<{ accepted: number }>>;
  recovery(
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T.TeamRecoveryResponse>>;
}
export interface TeamTransportOptions {
  endpoint: T.TeamEndpoint;
  principalId: string;
  deviceId: string;
  readToken(): Promise<Uint8Array>;
  signRequest(
    transcript: Uint8Array,
  ): Promise<{ deviceId: string; signature: Uint8Array }>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export function validTeamEndpoint(e: T.TeamEndpoint): boolean {
  return (
    T.isTeamScope(e.scope) &&
    validSyncEndpoint({ url: e.url, scope: T.teamMetadataScope(e.scope) })
  );
}
export function teamRequestTranscript(
  method: string,
  path: string,
  scope: T.TeamScope,
  principalId: string,
  nonce: string,
  body: Uint8Array,
  deviceId: string,
): Buffer {
  return frame(
    "ssterm-team-http-v1",
    method,
    path,
    scope.deploymentId,
    scope.accountId,
    scope.teamId,
    principalId,
    deviceId,
    nonce,
    createHash("sha256").update(body).digest("hex"),
  );
}
export function createTeamTransport(
  options: TeamTransportOptions,
): TeamTransport {
  if (
    !validTeamEndpoint(options.endpoint) ||
    !syncUuid(options.principalId) ||
    !syncUuid(options.deviceId)
  )
    throw new Error("Invalid team endpoint");
  const origin = new URL(options.endpoint.url).origin,
    scope = { ...options.endpoint.scope },
    fetcher = options.fetch ?? globalThis.fetch;
  async function request<T>(
    method: string,
    path: string,
    body: string,
    validator: (v: unknown) => v is T,
    signed: boolean,
    signal?: AbortSignal,
  ): Promise<SyncTransportResult<T>> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) return { ok: false, code: "cancelled" };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, options.timeoutMs ?? 15000);
    timer.unref();
    try {
      if (Buffer.byteLength(body) > SYNC_HTTP_MAX)
        return { ok: false, code: "too-large" };
      const headers: Record<string, string> = { Accept: "application/json" };
      if (body) headers["Content-Type"] = "application/json";
      if (path !== "/team/v1/info") {
        const token = await options.readToken();
        try {
          if (token.length !== 32 || controller.signal.aborted)
            return {
              ok: false,
              code: controller.signal.aborted ? "cancelled" : "unauthorized",
            };
          headers.Authorization = `Bearer ${Buffer.from(token).toString("base64url")}`;
          headers["X-SSTerm-Deployment"] = scope.deploymentId;
          headers["X-SSTerm-Account"] = scope.accountId;
          headers["X-SSTerm-Team"] = scope.teamId;
          headers["X-SSTerm-Principal"] = options.principalId;
        } finally {
          token.fill(0);
        }
      }
      if (signed) {
        const challenge = await request(
          "GET",
          "/team/v1/challenge",
          "",
          isSyncChallenge,
          false,
          controller.signal,
        );
        if (!challenge.ok) return challenge;
        if (
          challenge.value.expiresAt <= Math.floor(Date.now() / 1000) ||
          challenge.value.expiresAt > Math.floor(Date.now() / 1000) + 60
        )
          return { ok: false, code: "invalid" };
        const signedRequest = await options.signRequest(
          teamRequestTranscript(
            method,
            path,
            scope,
            options.principalId,
            challenge.value.nonce,
            Buffer.from(body),
            options.deviceId,
          ),
        );
        try {
          if (
            signedRequest.deviceId !== options.deviceId ||
            signedRequest.signature.length !== 64
          )
            return { ok: false, code: "invalid" };
          if (controller.signal.aborted)
            return { ok: false, code: "cancelled" };
          headers["X-SSTerm-Device"] = signedRequest.deviceId;
          headers["X-SSTerm-Nonce"] = challenge.value.nonce;
          headers["X-SSTerm-Signature"] = Buffer.from(
            signedRequest.signature,
          ).toString("base64url");
        } finally {
          signedRequest.signature.fill(0);
        }
      }
      const response = await fetcher(`${origin}${path}`, {
        method,
        headers,
        body: method === "GET" ? undefined : body,
        redirect: "manual",
        signal: controller.signal,
        credentials: "omit",
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return { ok: false, code: "unavailable" };
      }
      if (
        !response.headers.get("content-type")?.startsWith("application/json")
      ) {
        await response.body?.cancel();
        return { ok: false, code: "invalid" };
      }
      const contentLength = response.headers.get("content-length");
      if (
        contentLength &&
        (!/^\d+$/.test(contentLength) || Number(contentLength) > SYNC_HTTP_MAX)
      ) {
        await response.body?.cancel();
        return { ok: false, code: "too-large" };
      }
      const reader = response.body?.getReader();
      if (!reader) return { ok: false, code: "invalid" };
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > SYNC_HTTP_MAX) {
          await reader.cancel();
          return { ok: false, code: "too-large" };
        }
        parts.push(value);
      }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(parts),
      );
      const parsed: unknown = JSON.parse(raw);
      if (JSON.stringify(parsed) !== raw) return { ok: false, code: "invalid" };
      if (
        syncObject(parsed, ["ok", "code"]) &&
        parsed.ok === false &&
        syncTransportCodes.includes(parsed.code as never)
      )
        return {
          ok: false,
          code: parsed.code as (typeof syncTransportCodes)[number],
        };
      if (
        !response.ok ||
        !syncObject(parsed, ["ok", "value"]) ||
        parsed.ok !== true ||
        !validator(parsed.value)
      )
        return { ok: false, code: "invalid" };
      return { ok: true, value: parsed.value };
    } catch {
      return { ok: false, code: signal?.aborted ? "cancelled" : "unavailable" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  const invalid = <V>(): Promise<SyncTransportResult<V>> =>
    Promise.resolve({ ok: false, code: "invalid" });
  return {
    operation: (domain, hash, s) =>
      (domain === "metadata" || domain === "credentials") && syncHash(hash)
        ? request(
            "GET",
            `/team/v1/operations/${domain}/${hash}`,
            "",
            isSyncOperationPublication,
            true,
            s,
          )
        : invalid(),
    info: (s) => request("GET", "/team/v1/info", "", T.isTeamInfo, false, s),
    policies: (n, s) =>
      syncInteger(n, 0, 0xffffffff)
        ? request(
            "GET",
            `/team/v1/policies/${n}`,
            "",
            T.isTeamPoliciesResponse,
            false,
            s,
          )
        : invalid(),
    publish: (v, s) =>
      T.isTeamPublishRequest(v)
        ? request(
            "POST",
            "/team/v1/publish",
            JSON.stringify(v),
            T.isTeamReceipt,
            false,
            s,
          )
        : invalid(),
    state: (v, s) =>
      T.isTeamStateRequest(v)
        ? request(
            "POST",
            "/team/v1/state",
            JSON.stringify(v),
            T.isTeamState,
            true,
            s,
          )
        : invalid(),
    writeMetadata: (v, s) =>
      T.isTeamWriteRequest(v)
        ? request(
            "POST",
            "/team/v1/metadata",
            JSON.stringify(v),
            T.isTeamWriteReceipt,
            true,
            s,
          )
        : invalid(),
    writeCredentials: (v, s) =>
      T.isTeamWriteRequest(v)
        ? request(
            "POST",
            "/team/v1/credentials",
            JSON.stringify(v),
            T.isTeamWriteReceipt,
            true,
            s,
          )
        : invalid(),
    connect: (v, s) =>
      T.isTeamConnectRequest(v)
        ? request(
            "POST",
            "/team/v1/connect",
            JSON.stringify(v),
            T.isTeamConnectGrant,
            true,
            s,
          )
        : invalid(),
    audit: (n, s) =>
      syncInteger(n, 0)
        ? request("GET", `/team/v1/audit/${n}`, "", T.isTeamAuditPage, true, s)
        : invalid(),
    events: (events, s) =>
      T.isTeamEventsRequest({ events })
        ? request(
            "POST",
            "/team/v1/events",
            JSON.stringify({ events }),
            T.isTeamEventsReceipt,
            true,
            s,
          )
        : invalid(),
    recovery: (s) =>
      request(
        "GET",
        "/team/v1/recovery",
        "",
        T.isTeamRecoveryResponse,
        false,
        s,
      ),
  };
}
