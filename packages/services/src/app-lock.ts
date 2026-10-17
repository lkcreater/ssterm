import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import {
  GOOGLE_OFFLINE_GRACE_DAYS, passwordSetupErrors, recoveryCodeSchema,
  type AppLockFieldErrors, type AppLockMethod, type AppLockStatus,
} from "@ssterm/contracts";

/** The record store (Keychain in production); see ADR 0004. */
export interface AppLockStore {
  read(): Promise<{ status: "present"; value: Uint8Array } | { status: "missing" } | { status: "unavailable" } | { status: "error" }>;
  write(value: Uint8Array): Promise<"confirmed" | "unknown" | "invalid">;
}
export interface ScryptParams { N: number; r: number; p: number }
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const KEY_BYTES = 32;
const ELEVATED_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 30_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface Verifier { salt: string; hash: string; N: number; r: number; p: number }
interface LockRecord {
  v: 1;
  method: AppLockMethod;
  username: string | null;
  password: Verifier | null;
  recovery: Verifier;
  google: { sub: string; email: string; lastSignInAt: number } | null;
  createdAt: number;
}
/** Non-secret marker in the profile: the lock was configured (with a copy of the recovery verifier). */
interface Marker { v: 1; configured: true; recovery: Verifier }
export interface GoogleIdentity { sub: string; email: string }
export type GooglePurpose = "setup" | "unlock" | "confirm";
type Phase = "loading" | AppLockStatus["phase"];

function derive(secret: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((done, fail) => scrypt(secret.normalize("NFC"), salt, KEY_BYTES, { ...params, maxmem: 128 * params.N * params.r * 2 },
    (error, key) => (error ? fail(error) : done(key))));
}
async function makeVerifier(secret: string, params: ScryptParams): Promise<Verifier> {
  const salt = randomBytes(32);
  const hash = await derive(secret, salt, params);
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), ...params };
}
async function verify(secret: string, verifier: Verifier): Promise<boolean> {
  const expected = Buffer.from(verifier.hash, "base64");
  const actual = await derive(secret, Buffer.from(verifier.salt, "base64"), { N: verifier.N, r: verifier.r, p: verifier.p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
/** 30 Crockford base32 characters (150 bits) in groups of five. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(30);
  const chars = [...bytes].map((byte) => CROCKFORD[byte & 31]).join("");
  return chars.match(/.{5}/gu)!.join("-");
}
/** Only the parameters this build writes are accepted, so a tampered record cannot demand gigabytes per attempt. */
function isVerifier(value: unknown, params: ScryptParams): value is Verifier {
  const v = value as Verifier;
  return !!v && typeof v.salt === "string" && typeof v.hash === "string" && v.salt.length <= 64 && v.hash.length <= 64 &&
    v.N === params.N && v.r === params.r && v.p === params.p;
}
function parseMarker(bytes: Uint8Array, params: ScryptParams): Marker | undefined {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Marker;
    return value.v === 1 && value.configured === true && isVerifier(value.recovery, params) ? value : undefined;
  } catch { return undefined; }
}
function parse(bytes: Uint8Array, params: ScryptParams): LockRecord | undefined {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as LockRecord;
    const methodOk = value.method === "password" ? isVerifier(value.password, params) && typeof value.username === "string"
      : value.method === "google" ? !!value.google && typeof value.google.sub === "string" && typeof value.google.email === "string" &&
        Number.isFinite(value.google.lastSignInAt) : false;
    return value.v === 1 && methodOk && isVerifier(value.recovery, params) ? value : undefined;
  } catch { return undefined; }
}

/**
 * Local app lock state for one app process (ADR 0004). Main consults `unlocked` before serving any other IPC.
 * Secrets arrive as strings from the validated IPC request and are only hashed; nothing here logs or returns them.
 */
export class AppLockService {
  #phase: Phase = "loading";
  #record: LockRecord | undefined;
  /** Set when the profile says a lock was configured but its Keychain record is gone or unreadable as a record. */
  #marker: Marker | undefined;
  #recovering = false;
  #elevatedUntil = 0;
  #failures = 0;
  #nextAttemptAt = 0;
  #busy = false;
  constructor(private readonly options: {
    store: AppLockStore | undefined;
    /** Profile marker (a file next to the database); never holds a secret. */
    marker?: AppLockStore;
    googleAvailable: boolean;
    now?: () => number;
    params?: ScryptParams;
  }) {}
  #now() { return this.options.now?.() ?? Date.now(); }
  get #params(): ScryptParams { return this.options.params ?? SCRYPT_PARAMS; }
  get unlocked(): boolean { return this.#phase === "unlocked"; }

  /**
   * Missing record + no marker: first launch (setup). Missing or corrupt record + marker: the lock was configured, so
   * only the recovery code (checked against the marker) leads to a new setup. An unreadable Keychain stays
   * unavailable and may be retried.
   */
  async load(): Promise<void> {
    if (this.#phase === "unlocked") return;
    const store = this.options.store;
    if (!store) { this.#phase = "unavailable"; return; }
    const read = await store.read().catch(() => ({ status: "error" as const }));
    if (read.status === "unavailable" || read.status === "error") { this.#phase = "unavailable"; return; }
    if (read.status === "present") {
      this.#record = parse(read.value, this.#params);
      read.value.fill(0);
      if (this.#record) { this.#phase = "locked"; return; }
    }
    const marker = await this.options.marker?.read().catch(() => ({ status: "error" as const }));
    this.#marker = marker?.status === "present" ? parseMarker(marker.value, this.#params) : undefined;
    if (this.#marker) this.#phase = "locked";
    else if (read.status === "missing" && (!marker || marker.status === "missing")) this.#phase = "setup";
    else this.#phase = "unavailable";
  }

  status(): AppLockStatus {
    const record = this.#record;
    const phase = this.#phase === "loading" ? "unavailable" : this.#recovering ? "setup" : this.#phase;
    return {
      phase,
      method: record?.method ?? null,
      username: record?.method === "password" ? record.username : null,
      googleEmail: record?.method === "google" ? record.google!.email : null,
      googleAvailable: this.options.googleAvailable,
      recovering: this.#recovering,
      elevated: this.#elevated(),
      retryAfterMs: Math.max(0, Math.min(60_000, this.#nextAttemptAt - this.#now())),
    };
  }
  #elevated(): boolean { return this.#phase === "unlocked" && this.#now() < this.#elevatedUntil; }
  /** First launch, an accepted recovery code, or a recent confirmation in Settings. */
  #mayConfigure(): boolean { return this.#phase === "setup" || this.#recovering || this.#elevated(); }

  /** Exponential backoff per process: 1, 2, 4 … 30 s after each failure. */
  #throttled(): number { return Math.max(0, this.#nextAttemptAt - this.#now()); }
  #fail(): { status: "rejected"; retryAfterMs: number } {
    this.#failures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.#failures - 1));
    this.#nextAttemptAt = this.#now() + delay;
    return { status: "rejected", retryAfterMs: delay };
  }
  #succeed() { this.#failures = 0; this.#nextAttemptAt = 0; }
  /** One verification at a time, so parallel guesses cannot bypass the backoff. */
  async #exclusive<T>(busy: T, task: () => Promise<T>): Promise<T> {
    if (this.#busy) return busy;
    this.#busy = true;
    try { return await task(); } finally { this.#busy = false; }
  }
  /** An uncertain write is read back before it is reported, so a record the user never saw cannot lock them out. */
  async #save(record: LockRecord): Promise<boolean> {
    const store = this.options.store;
    if (!store) return false;
    const bytes = Buffer.from(JSON.stringify(record), "utf8");
    try {
      const written = await store.write(bytes).catch(() => "unknown" as const);
      if (written === "confirmed") return true;
      if (written !== "unknown") return false;
      const back = await store.read().catch(() => ({ status: "error" as const }));
      const same = back.status === "present" && Buffer.from(back.value).equals(bytes);
      if (back.status === "present") back.value.fill(0);
      return same;
    } finally { bytes.fill(0); }
  }
  /** Best effort: the marker only hardens against a deleted Keychain record. */
  async #mark(record: LockRecord): Promise<void> {
    const marker: Marker = { v: 1, configured: true, recovery: record.recovery };
    await this.options.marker?.write(Buffer.from(JSON.stringify(marker), "utf8")).catch(() => undefined);
    this.#marker = undefined;
  }
  async #configure(record: Omit<LockRecord, "v" | "recovery" | "createdAt">): Promise<string | undefined> {
    const code = newRecoveryCode();
    const next: LockRecord = { v: 1, ...record, recovery: await makeVerifier(code, this.#params), createdAt: this.#now() };
    if (!(await this.#save(next))) return undefined;
    await this.#mark(next);
    this.#record = next;
    this.#phase = "unlocked";
    this.#recovering = false;
    this.#elevatedUntil = 0;
    this.#succeed();
    return code;
  }

  async setupPassword(input: { username: string; password: string; confirmPassword: string }):
    Promise<{ status: "configured"; recoveryCode: string } | { status: "invalid"; fields: AppLockFieldErrors } | { status: "not-allowed" | "store-unavailable" }> {
    if (!this.#mayConfigure()) return { status: "not-allowed" };
    const fields = passwordSetupErrors(input);
    if (fields) return { status: "invalid", fields };
    type Result = { status: "configured"; recoveryCode: string } | { status: "not-allowed" | "store-unavailable" };
    return this.#exclusive<Result>({ status: "not-allowed" }, async () => {
      const code = await this.#configure({
        method: "password", username: input.username.trim(),
        password: await makeVerifier(input.password, this.#params), google: null,
      });
      return code ? { status: "configured" as const, recoveryCode: code } : { status: "store-unavailable" as const };
    });
  }

  async unlockPassword(username: string, password: string) {
    const record = this.#record;
    if (this.#phase !== "locked" || this.#recovering || record?.method !== "password") return { status: "not-allowed" as const };
    const wait = this.#throttled();
    if (wait) return { status: "rejected" as const, retryAfterMs: wait };
    return this.#exclusive({ status: "rejected" as const, retryAfterMs: 1000 }, async () => {
      // Both checks always run, so timing does not reveal which one failed.
      const nameOk = username.trim().normalize("NFC") === record.username!.normalize("NFC");
      const passwordOk = await verify(password, record.password!);
      if (!nameOk || !passwordOk) return this.#fail();
      this.#succeed();
      this.#phase = "unlocked";
      return { status: "unlocked" as const };
    });
  }

  async confirmPassword(password: string) {
    const record = this.#record;
    if (this.#phase !== "unlocked" || record?.method !== "password") return { status: "not-allowed" as const };
    const wait = this.#throttled();
    if (wait) return { status: "rejected" as const, retryAfterMs: wait };
    return this.#exclusive({ status: "rejected" as const, retryAfterMs: 1000 }, async () => {
      if (!(await verify(password, record.password!))) return this.#fail();
      this.#succeed();
      this.#elevatedUntil = this.#now() + ELEVATED_MS;
      return { status: "confirmed" as const };
    });
  }

  /** A correct code allows a new setup (password or Google); the old record stays until that succeeds. */
  async recover(code: string) {
    const verifier = this.#record?.recovery ?? this.#marker?.recovery;
    if (this.#phase !== "locked" || !verifier) return { status: "not-allowed" as const };
    const wait = this.#throttled();
    if (wait) return { status: "rejected" as const, retryAfterMs: wait };
    const parsed = recoveryCodeSchema.safeParse(code);
    return this.#exclusive({ status: "rejected" as const, retryAfterMs: 1000 }, async () => {
      if (!parsed.success || !(await verify(parsed.data, verifier))) return this.#fail();
      this.#succeed();
      this.#recovering = true;
      return { status: "recovered" as const };
    });
  }

  async regenerateRecovery() {
    const record = this.#record;
    if (!this.#elevated() || !record) return { status: "not-allowed" as const };
    type Result = { status: "regenerated"; recoveryCode: string } | { status: "not-allowed" | "store-unavailable" };
    return this.#exclusive<Result>({ status: "not-allowed" }, async () => {
      const code = newRecoveryCode();
      const next = { ...record, recovery: await makeVerifier(code, this.#params) };
      if (!(await this.#save(next))) return { status: "store-unavailable" as const };
      await this.#mark(next);
      this.#record = next;
      this.#elevatedUntil = 0;
      return { status: "regenerated" as const, recoveryCode: code };
    });
  }

  /** Whether a Google sign-in for this purpose may start (checked before opening the browser). */
  googleAllowed(purpose: GooglePurpose): boolean {
    if (!this.options.googleAvailable) return false;
    if (purpose === "setup") return this.#mayConfigure();
    if (purpose === "unlock") return this.#phase === "locked" && !this.#recovering && this.#record?.method === "google";
    return this.#phase === "unlocked" && this.#record?.method === "google";
  }
  /** Called with a verified ID token's identity. Only the bound account unlocks or confirms. */
  async completeGoogle(purpose: GooglePurpose, identity: GoogleIdentity):
    Promise<{ status: "configured"; recoveryCode: string } | { status: "unlocked" | "confirmed" } | { status: "wrong-account" | "not-allowed" | "store-unavailable" }> {
    if (!this.googleAllowed(purpose)) return { status: "not-allowed" };
    const now = this.#now();
    if (purpose === "setup") {
      const code = await this.#configure({ method: "google", username: null, password: null, google: { ...identity, lastSignInAt: now } });
      return code ? { status: "configured", recoveryCode: code } : { status: "store-unavailable" };
    }
    const record = this.#record!;
    if (record.google!.sub !== identity.sub) return { status: "wrong-account" };
    const next = { ...record, google: { sub: record.google!.sub, email: identity.email, lastSignInAt: now } };
    // The sign-in itself succeeded; failing to record its time only shortens the offline grace.
    if (await this.#save(next)) this.#record = next;
    if (purpose === "unlock") {
      this.#phase = "unlocked";
      return { status: "unlocked" };
    }
    this.#elevatedUntil = now + ELEVATED_MS;
    return { status: "confirmed" };
  }
  /** Offline grace: a Google sign-in within the last GOOGLE_OFFLINE_GRACE_DAYS (by the local clock). */
  graceAvailable(): boolean {
    const record = this.#record;
    if (this.#phase !== "locked" || this.#recovering || record?.method !== "google") return false;
    const age = this.#now() - record.google!.lastSignInAt;
    return age >= 0 && age < GOOGLE_OFFLINE_GRACE_DAYS * 86_400_000;
  }
  /** The caller has confirmed Google is unreachable. */
  unlockOffline(): { status: "unlocked" } | { status: "failed"; code: "expired" | "not-allowed" } {
    if (this.#phase !== "locked" || this.#record?.method !== "google") return { status: "failed", code: "not-allowed" };
    if (!this.graceAvailable()) return { status: "failed", code: "expired" };
    this.#phase = "unlocked";
    return { status: "unlocked" };
  }
}
