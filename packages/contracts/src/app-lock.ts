import { z } from "zod";

/** Local app lock (SST-039, ADR 0004). Shared by the renderer forms and main's re-validation. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 64;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 1024;
/** Days a successful Google sign-in still unlocks while Google cannot be reached. */
export const GOOGLE_OFFLINE_GRACE_DAYS = 7;
/** 6 groups of 5 Crockford base32 characters (150 bits). */
export const RECOVERY_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/u;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
export const usernameSchema = z.string()
  .trim()
  .min(USERNAME_MIN, `Use at least ${USERNAME_MIN} characters.`)
  .max(USERNAME_MAX, `Use ${USERNAME_MAX} characters or fewer.`)
  .refine((value) => !CONTROL.test(value), "Remove control characters.");
export const passwordSchema = z.string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .max(PASSWORD_MAX, `Use ${PASSWORD_MAX} characters or fewer.`);
/** First-run (or re-setup) form: username, password and its confirmation. */
export const passwordSetupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  confirmPassword: z.string().max(PASSWORD_MAX),
}).refine((value) => value.password === value.confirmPassword, { path: ["confirmPassword"], message: "The passwords do not match." });
export type PasswordSetup = z.infer<typeof passwordSetupSchema>;
/** Normalizes spacing, case and lookalikes (I/L→1, O→0) before matching the pattern. */
export const recoveryCodeSchema = z.string().max(64).transform((value) => {
  const plain = value.toUpperCase().replace(/[\s-]/gu, "").replace(/[IL]/gu, "1").replace(/O/gu, "0");
  return plain.match(/.{1,5}/gu)?.join("-") ?? "";
}).pipe(z.string().regex(RECOVERY_CODE_PATTERN, "Enter the 30-character recovery code."));

export type AppLockMethod = "password" | "google";
export type AppLockPhase = "unavailable" | "setup" | "locked" | "unlocked";
export interface AppLockStatus {
  phase: AppLockPhase;
  method: AppLockMethod | null;
  /** Password mode: the configured user name, so the unlock form can prefill it. */
  username: string | null;
  /** Google mode: the bound account's address. */
  googleEmail: string | null;
  /** A Google client is configured in this build. */
  googleAvailable: boolean;
  /** `setup` after a recovery code was accepted (rather than a first launch). */
  recovering: boolean;
  /** Settings may re-configure (a recent confirmation). */
  elevated: boolean;
  /** Milliseconds until another attempt is accepted. */
  retryAfterMs: number;
}
export type AppLockFieldErrors = Partial<Record<"username" | "password" | "confirmPassword", string>>;
export type GoogleFailure = "cancelled" | "timeout" | "port-in-use" | "wrong-account" | "denied" | "network" | "invalid-response" | "unavailable" | "not-allowed";

const owner = z.strictObject({ windowId: z.number().int().positive().safe(), generation: z.number().int().positive().safe() });
const text = (max: number) => z.string().max(max);
export const appLockRequestSchemas = {
  state: z.strictObject({ owner }),
  setupPassword: z.strictObject({ owner, username: text(4 * USERNAME_MAX), password: text(PASSWORD_MAX), confirmPassword: text(PASSWORD_MAX) }),
  unlockPassword: z.strictObject({ owner, username: text(4 * USERNAME_MAX), password: text(PASSWORD_MAX) }),
  confirmPassword: z.strictObject({ owner, password: text(PASSWORD_MAX) }),
  google: z.strictObject({ owner, purpose: z.enum(["setup", "unlock", "confirm"]) }),
  cancelGoogle: z.strictObject({ owner }),
  unlockOffline: z.strictObject({ owner }),
  recover: z.strictObject({ owner, code: text(64) }),
  regenerateRecovery: z.strictObject({ owner }),
  /** Lock workspace (SST-040): session lock for the whole process, then back to the gate. */
  lockNow: z.strictObject({ owner }),
} as const;
export type AppLockStateRequest = z.infer<typeof appLockRequestSchemas.state>;
export type SetupPasswordRequest = z.infer<typeof appLockRequestSchemas.setupPassword>;
export type UnlockPasswordRequest = z.infer<typeof appLockRequestSchemas.unlockPassword>;
export type ConfirmPasswordRequest = z.infer<typeof appLockRequestSchemas.confirmPassword>;
export type GoogleSignInRequest = z.infer<typeof appLockRequestSchemas.google>;
export type CancelGoogleRequest = z.infer<typeof appLockRequestSchemas.cancelGoogle>;
export type UnlockOfflineRequest = z.infer<typeof appLockRequestSchemas.unlockOffline>;
export type RecoverRequest = z.infer<typeof appLockRequestSchemas.recover>;
export type RegenerateRecoveryRequest = z.infer<typeof appLockRequestSchemas.regenerateRecovery>;
export type LockNowRequest = z.infer<typeof appLockRequestSchemas.lockNow>;

export type SetupPasswordResponse =
  | { status: "configured"; recoveryCode: string }
  | { status: "invalid"; fields: AppLockFieldErrors }
  | { status: "not-allowed" }
  | { status: "store-unavailable" };
export type AttemptResponse =
  | { status: "unlocked" | "confirmed" | "recovered" }
  | { status: "rejected"; retryAfterMs: number }
  | { status: "not-allowed" }
  | { status: "store-unavailable" };
export type GoogleSignInResponse =
  | { status: "configured"; recoveryCode: string }
  | { status: "unlocked" | "confirmed" }
  | { status: "failed"; code: GoogleFailure; graceAvailable: boolean };
export type UnlockOfflineResponse = { status: "unlocked" } | { status: "failed"; code: "online" | "expired" | "not-allowed" };
export type RegenerateRecoveryResponse = { status: "regenerated"; recoveryCode: string } | { status: "not-allowed" } | { status: "store-unavailable" };
/**
 * `not-allowed`: the app lock is off (test profiles) or no sign-in is configured yet, so there is no gate to return to.
 * `busy`: a sign-in change or new recovery code is being saved (briefly); nothing was locked, try again.
 */
export type LockNowResponse = { status: "locked" | "not-allowed" | "busy" };

const recoveryCode = z.string().regex(RECOVERY_CODE_PATTERN);
const fields = z.strictObject({ username: z.string().max(200).optional(), password: z.string().max(200).optional(), confirmPassword: z.string().max(200).optional() });
const statusSchema = z.strictObject({
  phase: z.enum(["unavailable", "setup", "locked", "unlocked"]),
  method: z.enum(["password", "google"]).nullable(),
  username: z.string().max(4 * USERNAME_MAX).nullable(),
  googleEmail: z.string().max(320).nullable(),
  googleAvailable: z.boolean(),
  recovering: z.boolean(),
  elevated: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().max(60_000),
});
const retry = z.number().int().nonnegative().max(60_000);
const responseSchemas = {
  status: statusSchema,
  setup: z.union([
    z.strictObject({ status: z.literal("configured"), recoveryCode }),
    z.strictObject({ status: z.literal("invalid"), fields }),
    z.strictObject({ status: z.enum(["not-allowed", "store-unavailable"]) }),
  ]),
  attempt: z.union([
    z.strictObject({ status: z.enum(["unlocked", "confirmed", "recovered", "not-allowed", "store-unavailable"]) }),
    z.strictObject({ status: z.literal("rejected"), retryAfterMs: retry }),
  ]),
  google: z.union([
    z.strictObject({ status: z.literal("configured"), recoveryCode }),
    z.strictObject({ status: z.enum(["unlocked", "confirmed"]) }),
    z.strictObject({
      status: z.literal("failed"),
      code: z.enum(["cancelled", "timeout", "port-in-use", "wrong-account", "denied", "network", "invalid-response", "unavailable", "not-allowed"]),
      graceAvailable: z.boolean(),
    }),
  ]),
  offline: z.union([
    z.strictObject({ status: z.literal("unlocked") }),
    z.strictObject({ status: z.literal("failed"), code: z.enum(["online", "expired", "not-allowed"]) }),
  ]),
  regenerate: z.union([
    z.strictObject({ status: z.literal("regenerated"), recoveryCode }),
    z.strictObject({ status: z.enum(["not-allowed", "store-unavailable"]) }),
  ]),
  ok: z.strictObject({ status: z.literal("cancelled") }),
  lockNow: z.strictObject({ status: z.enum(["locked", "not-allowed", "busy"]) }),
};
const guard = <T>(schema: z.ZodType<T>) => (value: unknown): value is T => schema.safeParse(value).success;
export const isAppLockStatus = guard<AppLockStatus>(statusSchema);
export const isSetupPasswordResponse = guard<SetupPasswordResponse>(responseSchemas.setup as z.ZodType<SetupPasswordResponse>);
export const isAttemptResponse = guard<AttemptResponse>(responseSchemas.attempt as z.ZodType<AttemptResponse>);
export const isGoogleSignInResponse = guard<GoogleSignInResponse>(responseSchemas.google as z.ZodType<GoogleSignInResponse>);
export const isUnlockOfflineResponse = guard<UnlockOfflineResponse>(responseSchemas.offline as z.ZodType<UnlockOfflineResponse>);
export const isRegenerateRecoveryResponse = guard<RegenerateRecoveryResponse>(responseSchemas.regenerate as z.ZodType<RegenerateRecoveryResponse>);
export const isCancelGoogleResponse = guard<{ status: "cancelled" }>(responseSchemas.ok);
export const isLockNowResponse = guard<LockNowResponse>(responseSchemas.lockNow);
export const appLockRequestGuards = {
  state: guard<AppLockStateRequest>(appLockRequestSchemas.state),
  setupPassword: guard<SetupPasswordRequest>(appLockRequestSchemas.setupPassword),
  unlockPassword: guard<UnlockPasswordRequest>(appLockRequestSchemas.unlockPassword),
  confirmPassword: guard<ConfirmPasswordRequest>(appLockRequestSchemas.confirmPassword),
  google: guard<GoogleSignInRequest>(appLockRequestSchemas.google),
  cancelGoogle: guard<CancelGoogleRequest>(appLockRequestSchemas.cancelGoogle),
  unlockOffline: guard<UnlockOfflineRequest>(appLockRequestSchemas.unlockOffline),
  recover: guard<RecoverRequest>(appLockRequestSchemas.recover),
  regenerateRecovery: guard<RegenerateRecoveryRequest>(appLockRequestSchemas.regenerateRecovery),
  lockNow: guard<LockNowRequest>(appLockRequestSchemas.lockNow),
};
/** Field messages for the setup form (renderer) and main's re-validation. */
export function passwordSetupErrors(value: { username: string; password: string; confirmPassword: string }): AppLockFieldErrors | null {
  const parsed = passwordSetupSchema.safeParse(value);
  if (parsed.success) return null;
  const errors: AppLockFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if ((field === "username" || field === "password" || field === "confirmPassword") && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}
