import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  appLockRequestGuards, channels, failure,
  type AppLockStatus, type AttemptResponse, type GoogleSignInResponse, type Owner, type RegenerateRecoveryResponse,
  type Result, type SetupPasswordResponse, type UnlockOfflineResponse,
} from "@ssterm/contracts";
import {
  beginAuthorization, completeAuthorization, googleReachable, OAuthError, redirectUri, GOOGLE_CALLBACK_PATH, GOOGLE_ENDPOINTS, GOOGLE_LOOPBACK_PORT,
  type AppLockService, type GoogleClient, type GoogleEndpoints, type GooglePurpose,
} from "@ssterm/services";
import { waitForOAuthCallback } from "@ssterm/adapters/oauth-loopback";
import type { WindowBoundary } from "./boundary";

/** How long the loopback listener waits for Google's redirect. */
export const GOOGLE_SIGN_IN_MS = 5 * 60_000;
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const UNLOCKED: AppLockStatus = {
  phase: "unlocked", method: null, username: null, googleEmail: null, googleAvailable: false, recovering: false, elevated: false, retryAfterMs: 0,
};

/** Reads the Google client compiled into this build, or a test override (honoured only with a test profile). */
export function googleConfiguration(env: Readonly<Record<string, string | undefined>>, built: unknown):
  { client: GoogleClient; endpoints: GoogleEndpoints } | undefined {
  const parse = (value: unknown) => {
    const v = value as { clientId?: unknown; clientSecret?: unknown } | null;
    return v && typeof v.clientId === "string" && /^[\w.-]+\.apps\.googleusercontent\.com$/u.test(v.clientId) && typeof v.clientSecret === "string"
      ? { clientId: v.clientId, clientSecret: v.clientSecret } : undefined;
  };
  if (env.SSTERM_TEST_USER_DATA && env.SSTERM_TEST_GOOGLE) {
    try {
      const test = JSON.parse(env.SSTERM_TEST_GOOGLE) as Record<string, unknown>;
      const client = parse(test);
      const loopback = (url: unknown) => typeof url === "string" && /^http:\/\/127\.0\.0\.1:\d+\//u.test(url);
      if (!client || !loopback(test.authorization) || !loopback(test.token) || !loopback(test.jwks) || typeof test.issuer !== "string") return undefined;
      return { client, endpoints: { authorization: test.authorization as string, token: test.token as string, jwks: test.jwks as string, issuers: [test.issuer] } };
    } catch { return undefined; }
  }
  const client = parse(built);
  return client ? { client, endpoints: GOOGLE_ENDPOINTS } : undefined;
}

/** Test profiles run unlocked unless a spec opts in; production always locks. */
export function appLockEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return !env.SSTERM_TEST_USER_DATA || env.SSTERM_TEST_APP_LOCK === "on";
}

export function createAppLockController(options: {
  /** Undefined: the lock is disabled (test profiles only). */
  service: AppLockService | undefined;
  google: { client: GoogleClient; endpoints: GoogleEndpoints } | undefined;
  openExternal(url: string): Promise<void>;
  /** Test seam: the loopback port. */
  port?: number;
  fetch?: typeof fetch;
}) {
  let signIn: AbortController | undefined;
  const service = options.service;
  const status = (): AppLockStatus => (service ? service.status() : UNLOCKED);
  const failed = (code: Extract<GoogleSignInResponse, { status: "failed" }>["code"], purpose: GooglePurpose): Result<GoogleSignInResponse> =>
    ok({ status: "failed", code, graceAvailable: purpose === "unlock" && !!service?.graceAvailable() });

  return {
    open(): boolean { return !service || service.unlocked; },
    /** An unreadable record is read again on each request, so the lock screen's Retry works without a relaunch. */
    async state(): Promise<Result<AppLockStatus>> {
      if (service && service.status().phase === "unavailable") await service.load();
      return ok(status());
    },
    async setupPassword(input: { username: string; password: string; confirmPassword: string }): Promise<Result<SetupPasswordResponse>> {
      if (!service) return ok({ status: "not-allowed" });
      return ok(await service.setupPassword(input));
    },
    async unlockPassword(username: string, password: string): Promise<Result<AttemptResponse>> {
      if (!service) return ok({ status: "not-allowed" });
      return ok(await service.unlockPassword(username, password));
    },
    async confirmPassword(password: string): Promise<Result<AttemptResponse>> {
      if (!service) return ok({ status: "not-allowed" });
      return ok(await service.confirmPassword(password));
    },
    async recover(code: string): Promise<Result<AttemptResponse>> {
      if (!service) return ok({ status: "not-allowed" });
      return ok(await service.recover(code));
    },
    async regenerate(): Promise<Result<RegenerateRecoveryResponse>> {
      if (!service) return ok({ status: "not-allowed" });
      return ok(await service.regenerateRecovery());
    },
    /** The 7-day grace applies only while Google really cannot be reached. */
    async unlockOffline(): Promise<Result<UnlockOfflineResponse>> {
      if (!service || !options.google) return ok({ status: "failed", code: "not-allowed" });
      if (!service.graceAvailable()) return ok(service.unlockOffline());
      if (await googleReachable(options.google.endpoints, options.fetch)) return ok({ status: "failed", code: "online" });
      return ok(service.unlockOffline());
    },
    /** System browser + loopback redirect; one sign-in at a time. Resolves when it completes, fails or is cancelled. */
    async google(purpose: GooglePurpose): Promise<Result<GoogleSignInResponse>> {
      const google = options.google;
      if (!service || !google) return failed("unavailable", purpose);
      if (!service.googleAllowed(purpose)) return failed("not-allowed", purpose);
      if (signIn) return failed("not-allowed", purpose);
      const controller = new AbortController();
      signIn = controller;
      try {
        const hint = status().googleEmail ?? undefined;
        const port = options.port ?? GOOGLE_LOOPBACK_PORT;
        const request = beginAuthorization(google.client, google.endpoints, purpose === "setup" ? undefined : hint, redirectUri(port));
        let opened = true;
        const callback = await waitForOAuthCallback({
          port, path: GOOGLE_CALLBACK_PATH, state: request.state, timeoutMs: GOOGLE_SIGN_IN_MS,
          signal: controller.signal,
          listening: () => {
            options.openExternal(request.url).catch(() => { opened = false; controller.abort(); });
          },
        });
        if (callback.status !== "code") {
          if (!opened) return failed("unavailable", purpose);
          return failed(callback.status === "failed" ? "unavailable" : callback.status, purpose);
        }
        let identity;
        try {
          identity = await completeAuthorization({
            client: google.client, code: callback.code, verifier: request.verifier, nonce: request.nonce,
            endpoints: google.endpoints, fetch: options.fetch, redirect: request.redirect,
          });
        } catch (error) {
          return failed(error instanceof OAuthError ? error.code : "invalid-response", purpose);
        }
        const result = await service.completeGoogle(purpose, identity);
        if (result.status === "configured") return ok({ status: "configured", recoveryCode: result.recoveryCode });
        if (result.status === "unlocked" || result.status === "confirmed") return ok({ status: result.status });
        return failed(result.status === "wrong-account" ? "wrong-account" : result.status === "not-allowed" ? "not-allowed" : "unavailable", purpose);
      } finally {
        if (signIn === controller) signIn = undefined;
      }
    },
    cancelGoogle(): Result<{ status: "cancelled" }> {
      signIn?.abort();
      return ok({ status: "cancelled" });
    },
    dispose(): void { signIn?.abort(); },
  };
}
export type AppLockController = ReturnType<typeof createAppLockController>;

export const appLockChannels = Object.freeze([
  channels.appLockState, channels.setupAppLockPassword, channels.unlockAppLock, channels.confirmAppLockPassword, channels.googleSignIn,
  channels.cancelGoogleSignIn, channels.unlockAppLockOffline, channels.recoverAppLock, channels.regenerateRecoveryCode,
]);

/** Served before unlock: owner-checked (not lock-gated) and zod-validated; secrets are never echoed or logged. */
export function registerAppLockHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => AppLockController | undefined;
}): () => void {
  const handle = <T extends { owner: Owner }>(channel: string, validate: (value: unknown) => value is T, run: (controller: AppLockController, request: T) => unknown) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeLockOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        return await run(controller, request);
      } catch { return failure("unavailable"); }
    });
  };
  const g = appLockRequestGuards;
  handle(channels.appLockState, g.state, (c) => c.state());
  handle(channels.setupAppLockPassword, g.setupPassword, (c, r) => c.setupPassword({ username: r.username, password: r.password, confirmPassword: r.confirmPassword }));
  handle(channels.unlockAppLock, g.unlockPassword, (c, r) => c.unlockPassword(r.username, r.password));
  handle(channels.confirmAppLockPassword, g.confirmPassword, (c, r) => c.confirmPassword(r.password));
  handle(channels.googleSignIn, g.google, (c, r) => c.google(r.purpose));
  handle(channels.cancelGoogleSignIn, g.cancelGoogle, (c) => c.cancelGoogle());
  handle(channels.unlockAppLockOffline, g.unlockOffline, (c) => c.unlockOffline());
  handle(channels.recoverAppLock, g.recover, (c, r) => c.recover(r.code));
  handle(channels.regenerateRecoveryCode, g.regenerateRecovery, (c) => c.regenerate());
  return () => { for (const channel of appLockChannels) options.ipc.removeHandler(channel); };
}
