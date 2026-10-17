import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:net";
import {
  appLockRequestGuards, isAppLockStatus, isGoogleSignInResponse, passwordSetupErrors, recoveryCodeSchema, RECOVERY_CODE_PATTERN,
} from "../../packages/contracts/src/index.ts";
import { AppLockService, type AppLockStore } from "../../packages/services/src/app-lock.ts";
import { beginAuthorization, completeAuthorization, OAuthError, verifyIdToken, GOOGLE_REDIRECT_URI } from "../../packages/services/src/google-oauth.ts";
import { waitForOAuthCallback } from "../../packages/adapters/src/oauth-loopback.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { appLockEnabled, createAppLockController, googleConfiguration } from "../../apps/desktop/src/main/app-lock.ts";

const FAST = { N: 1024, r: 8, p: 1 };
class MemoryStore implements AppLockStore {
  value: Uint8Array | undefined;
  mode: "ok" | "unavailable" | "unknown" = "ok";
  async read() {
    if (this.mode === "unavailable") return { status: "unavailable" as const };
    return this.value ? { status: "present" as const, value: Uint8Array.from(this.value) } : { status: "missing" as const };
  }
  async write(value: Uint8Array) {
    if (this.mode !== "ok") return "unknown" as const;
    this.value = Uint8Array.from(value);
    return "confirmed" as const;
  }
}
async function service(store: AppLockStore, clock = { now: 1_000_000 }, googleAvailable = true) {
  const instance = new AppLockService({ store, googleAvailable, now: () => clock.now, params: FAST });
  await instance.load();
  return instance;
}
const SETUP = { username: " alice ", password: "correct horse battery", confirmPassword: "correct horse battery" };

test("zod schemas: username, password length, confirmation, recovery-code normalization; strict IPC requests", () => {
  assert.equal(passwordSetupErrors(SETUP), null);
  assert.deepEqual(passwordSetupErrors({ username: "al", password: "short", confirmPassword: "other" }), {
    username: "Use at least 3 characters.", password: "Use at least 12 characters.", confirmPassword: "The passwords do not match.",
  });
  assert.equal(passwordSetupErrors({ ...SETUP, username: "a\tb c" })?.username, "Remove control characters.");
  assert.equal(passwordSetupErrors({ ...SETUP, username: "x".repeat(65) })?.username, "Use 64 characters or fewer.");
  const parsed = recoveryCodeSchema.safeParse("abcde fghjk mnpqr stvwx yz012 3456o");
  assert.ok(parsed.success);
  assert.equal(parsed.data, "ABCDE-FGHJK-MNPQR-STVWX-YZ012-34560");
  assert.equal(recoveryCodeSchema.safeParse("ABCDE").success, false);
  const owner = { windowId: 1, generation: 1 };
  assert.ok(appLockRequestGuards.unlockPassword({ owner, username: "a", password: "b" }));
  assert.equal(appLockRequestGuards.unlockPassword({ owner, username: "a", password: "b", extra: 1 }), false);
  assert.equal(appLockRequestGuards.google({ owner, purpose: "delete" }), false);
  assert.equal(isAppLockStatus({ phase: "unlocked" }), false);
  assert.equal(isGoogleSignInResponse({ status: "configured", recoveryCode: "nope" }), false);
});

test("password lock: setup once, verifiers only at rest, relaunch locks, backoff, username and password both required", async () => {
  const store = new MemoryStore();
  const clock = { now: 1_000_000 };
  const first = await service(store, clock);
  assert.equal(first.status().phase, "setup");
  assert.equal(first.unlocked, false);
  assert.deepEqual(await first.setupPassword({ ...SETUP, confirmPassword: "nope" }), { status: "invalid", fields: { confirmPassword: "The passwords do not match." } });
  const configured = await first.setupPassword(SETUP);
  assert.equal(configured.status, "configured");
  const code = (configured as { recoveryCode: string }).recoveryCode;
  assert.match(code, RECOVERY_CODE_PATTERN);
  assert.equal(first.unlocked, true);
  const raw = Buffer.from(store.value!).toString();
  assert.ok(!raw.includes("correct horse") && !raw.includes(code), "no plaintext secret at rest");
  assert.deepEqual(await first.setupPassword(SETUP), { status: "not-allowed" }, "an unlocked app cannot re-configure without confirmation");

  const second = await service(store, clock);
  assert.equal(second.status().phase, "locked");
  assert.equal(second.status().username, "alice");
  assert.deepEqual(await second.unlockPassword("alice", "wrong password!!"), { status: "rejected", retryAfterMs: 1000 });
  assert.deepEqual(await second.unlockPassword("alice", SETUP.password), { status: "rejected", retryAfterMs: 1000 }, "throttled even when correct");
  clock.now += 1000;
  assert.deepEqual(await second.unlockPassword("bob", SETUP.password), { status: "rejected", retryAfterMs: 2000 });
  clock.now += 2000;
  assert.deepEqual(await second.unlockPassword(" alice ", SETUP.password), { status: "unlocked" });
  assert.equal(second.status().retryAfterMs, 0);
});

test("recovery code allows a new setup and is replaced; Settings confirmation grants a short window to regenerate", async () => {
  const store = new MemoryStore();
  const clock = { now: 5_000_000 };
  const code = ((await (await service(store, clock)).setupPassword(SETUP)) as { recoveryCode: string }).recoveryCode;
  const locked = await service(store, clock);
  assert.equal((await locked.recover("AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA")).status, "rejected");
  clock.now += 1000;
  assert.deepEqual(await locked.recover(code.toLowerCase().replace(/-/gu, " ")), { status: "recovered" });
  assert.equal(locked.status().phase, "setup");
  assert.equal(locked.status().recovering, true);
  assert.equal(locked.unlocked, false, "a recovery code alone does not unlock");
  const next = await locked.setupPassword({ username: "alice", password: "another long secret", confirmPassword: "another long secret" });
  const newCode = (next as { recoveryCode: string }).recoveryCode;
  assert.notEqual(newCode, code);
  const again = await service(store, clock);
  assert.equal((await again.recover(code)).status, "rejected", "the old code no longer works");
  clock.now += 1000;
  assert.deepEqual(await again.unlockPassword("alice", "another long secret"), { status: "unlocked" });
  assert.deepEqual(await again.regenerateRecovery(), { status: "not-allowed" });
  assert.deepEqual(await again.confirmPassword("another long secret"), { status: "confirmed" });
  assert.equal(again.status().elevated, true);
  assert.equal((await again.regenerateRecovery()).status, "regenerated");
  clock.now += 3 * 60_000;
  assert.equal(again.status().elevated, false, "the confirmation window expires");
});

test("Google lock: bound account only, last sign-in recorded, 7-day offline grace; unavailable and corrupt stores stay closed", async () => {
  const store = new MemoryStore();
  const clock = { now: 10 * 86_400_000 };
  const first = await service(store, clock);
  assert.equal(first.googleAllowed("setup"), true);
  const configured = await first.completeGoogle("setup", { sub: "123", email: "a@example.com" });
  assert.equal(configured.status, "configured");
  const second = await service(store, clock);
  assert.equal(second.status().method, "google");
  assert.equal(second.status().googleEmail, "a@example.com");
  assert.deepEqual(await second.completeGoogle("unlock", { sub: "999", email: "x@example.com" }), { status: "wrong-account" });
  assert.equal(second.unlocked, false);
  clock.now += 6 * 86_400_000;
  assert.equal(second.graceAvailable(), true);
  clock.now += 2 * 86_400_000;
  assert.equal(second.graceAvailable(), false);
  assert.deepEqual(second.unlockOffline(), { status: "failed", code: "expired" });
  assert.deepEqual(await second.completeGoogle("unlock", { sub: "123", email: "a@example.com" }), { status: "unlocked" });
  const third = await service(store, clock);
  assert.equal(third.graceAvailable(), true, "a successful unlock refreshed the grace");
  assert.deepEqual(third.unlockOffline(), { status: "unlocked" });

  const unavailable = new MemoryStore();
  unavailable.mode = "unavailable";
  assert.equal((await service(unavailable)).status().phase, "unavailable");
  const corrupt = new MemoryStore();
  corrupt.value = Buffer.from("{\"v\":1,\"method\":\"password\"}");
  const closed = await service(corrupt);
  assert.equal(closed.status().phase, "unavailable");
  assert.equal(closed.unlocked, false);
  assert.equal((await service(undefined as unknown as AppLockStore)).status().phase, "unavailable");
});

/** A fake Google: RS256 keys, a token endpoint that checks PKCE, and an ID token for `sub`. */
function fakeGoogle(sub = "123") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const clientId = "test.apps.googleusercontent.com";
  let pending: { challenge: string; nonce: string; redirect: string } | undefined;
  const token = (claims: Record<string, unknown>, kid = "k1") => {
    const head = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  const claims = (nonce: string) => ({ iss: "https://accounts.google.com", aud: clientId, sub, email: "a@example.com", email_verified: true, nonce, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) });
  const fetcher = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/certs")) return new Response(JSON.stringify({ keys: [jwk] }));
    const form = new URLSearchParams(String(init?.body));
    const verifier = form.get("code_verifier") ?? "";
    if (!pending || createHash("sha256").update(verifier).digest("base64url") !== pending.challenge || form.get("redirect_uri") !== pending.redirect)
      return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ id_token: token(claims(pending.nonce)) }));
  };
  const authorize = (url: string) => {
    const params = new URL(url).searchParams;
    pending = { challenge: params.get("code_challenge")!, nonce: params.get("nonce")!, redirect: params.get("redirect_uri")! };
    return params.get("state")!;
  };
  return { jwk, clientId, token, claims, fetcher, authorize };
}

test("Google OAuth: PKCE S256, ID token signature/issuer/audience/expiry/nonce checks", async () => {
  const google = fakeGoogle();
  const client = { clientId: google.clientId, clientSecret: "s" };
  const request = beginAuthorization(client);
  const url = new URL(request.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:55411/oauth/callback");
  assert.equal(GOOGLE_REDIRECT_URI, "http://127.0.0.1:55411/oauth/callback");
  assert.equal(url.searchParams.get("scope"), "openid email");
  google.authorize(request.url);
  assert.deepEqual(await completeAuthorization({ client, code: "c", verifier: request.verifier, nonce: request.nonce, fetch: google.fetcher as typeof fetch }), { sub: "123", email: "a@example.com" });
  await assert.rejects(completeAuthorization({ client, code: "c", verifier: "wrong", nonce: request.nonce, fetch: google.fetcher as typeof fetch }), (e: unknown) => e instanceof OAuthError && e.code === "denied");
  await assert.rejects(completeAuthorization({ client, code: "c", verifier: request.verifier, nonce: request.nonce, fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch }), (e: unknown) => e instanceof OAuthError && e.code === "network");
  const expect = { clientId: google.clientId, nonce: "n", keys: [google.jwk], issuers: ["https://accounts.google.com"], now: Date.now() };
  const good = google.claims("n");
  assert.equal(verifyIdToken(google.token(good), expect).sub, "123");
  for (const [name, token] of [
    ["audience", google.token({ ...good, aud: "other" })],
    ["issuer", google.token({ ...good, iss: "https://evil.example" })],
    ["nonce", google.token({ ...good, nonce: "x" })],
    ["expired", google.token({ ...good, exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["unknown key", google.token(good, "k2")],
    ["unverified email", google.token({ ...good, email_verified: false })],
    ["tampered", (() => { const t = google.token(good).split("."); t[1] = Buffer.from(JSON.stringify({ ...good, sub: "666" })).toString("base64url"); return t.join("."); })()],
  ] as const) assert.throws(() => verifyIdToken(token, expect), OAuthError, name);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test("loopback callback: 127.0.0.1 only, wrong state ignored, denial, timeout, cancel and a busy port", async () => {
  const port = await freePort();
  const pending = waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 5_000 });
  await new Promise((done) => setTimeout(done, 50));
  assert.equal((await fetch(`http://127.0.0.1:${port}/oauth/callback?state=X&code=evil`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/other?state=S&code=c`)).status, 404);
  const page = await fetch(`http://127.0.0.1:${port}/oauth/callback?state=S&code=good`);
  assert.ok(!(await page.text()).includes("good"), "the page never echoes the code");
  assert.deepEqual(await pending, { status: "code", code: "good" });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/oauth/callback`), "the listener is closed afterwards");
  const denied = waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 5_000 });
  await new Promise((done) => setTimeout(done, 50));
  await fetch(`http://127.0.0.1:${port}/oauth/callback?state=S&error=access_denied`);
  assert.deepEqual(await denied, { status: "denied" });
  assert.deepEqual(await waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 50 }), { status: "timeout" });
  const abort = new AbortController();
  const cancelled = waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 5_000, signal: abort.signal });
  abort.abort();
  assert.deepEqual(await cancelled, { status: "cancelled" });
  const blocker = createServer();
  await new Promise<void>((done) => blocker.listen(port, "127.0.0.1", done));
  try {
    assert.deepEqual(await waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 1_000 }), { status: "port-in-use" });
  } finally { await new Promise<void>((done) => blocker.close(() => done())); }
});

test("controller: the browser round trip unlocks the bound account; the gate closes feature IPC until unlock", async () => {
  const google = fakeGoogle();
  const port = await freePort();
  const store = new MemoryStore();
  const lock = await service(store);
  const controller = createAppLockController({
    service: lock,
    google: { client: { clientId: google.clientId, clientSecret: "s" }, endpoints: { authorization: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://t/token", jwks: "https://t/certs", issuers: ["https://accounts.google.com"] } },
    port,
    fetch: google.fetcher as typeof fetch,
    // The "browser": follows the authorization URL straight to the loopback redirect.
    openExternal: async (url) => { const state = google.authorize(url); void fetch(`http://127.0.0.1:${port}/oauth/callback?state=${state}&code=abc`); },
  });
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send() {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  boundary.setAccessGate(() => controller.open());
  const event = { sender, senderFrame: mainFrame };
  const owner = { windowId: 1, generation: 1 };
  assert.deepEqual(boundary.authorizeOwner(event, owner), { ok: false, error: { code: "unauthorized", message: "The request is not authorized." } });
  assert.equal(boundary.authorizeLockOwner(event, owner).ok, true);
  const configured = await controller.google("setup");
  assert.ok(configured.ok && configured.value.status === "configured");
  assert.equal(boundary.authorizeOwner(event, owner).ok, true);
  assert.equal(appLockEnabled({}), true);
  assert.equal(appLockEnabled({ SSTERM_TEST_USER_DATA: "/tmp/x" }), false);
  assert.equal(appLockEnabled({ SSTERM_TEST_USER_DATA: "/tmp/x", SSTERM_TEST_APP_LOCK: "on" }), true);
  assert.equal(googleConfiguration({}, null), undefined);
  assert.equal(googleConfiguration({ SSTERM_TEST_GOOGLE: "{}" }, null), undefined, "test overrides need a test profile");
  assert.equal(googleConfiguration({ SSTERM_TEST_USER_DATA: "/tmp/x", SSTERM_TEST_GOOGLE: JSON.stringify({ clientId: "a.apps.googleusercontent.com", clientSecret: "s", authorization: "https://evil/", token: "x", jwks: "y", issuer: "i" }) }, null), undefined, "test endpoints must be loopback");
  assert.equal(googleConfiguration({}, { clientId: "a.apps.googleusercontent.com", clientSecret: "s" })?.endpoints.token, "https://oauth2.googleapis.com/token");
});

test("hardening: a deleted Keychain record with the profile marker needs the recovery code; tampered parameters, uncertain writes", async () => {
  const store = new MemoryStore();
  const marker = new MemoryStore();
  const clock = { now: 9_000_000 };
  const make = async () => {
    const instance = new AppLockService({ store, marker, googleAvailable: false, now: () => clock.now, params: FAST });
    await instance.load();
    return instance;
  };
  const code = ((await (await make()).setupPassword(SETUP)) as { recoveryCode: string }).recoveryCode;
  assert.ok(marker.value, "the marker is written with the record");
  assert.ok(!Buffer.from(marker.value!).toString().includes(code), "the marker holds only a verifier");
  store.value = undefined;
  const missing = await make();
  assert.equal(missing.status().phase, "locked", "not first-run setup");
  assert.equal(missing.status().method, null);
  assert.deepEqual(await missing.setupPassword(SETUP), { status: "not-allowed" });
  assert.deepEqual(await missing.recover(code), { status: "recovered" });
  assert.equal((await missing.setupPassword(SETUP)).status, "configured");

  // A record demanding other scrypt parameters is not trusted (no gigabyte-sized attempts).
  const record = JSON.parse(Buffer.from(store.value!).toString());
  record.password.N = 2 ** 20;
  store.value = Buffer.from(JSON.stringify(record));
  assert.equal((await make()).status().method, null, "falls back to the marker's recovery path");

  // An uncertain write that did land is confirmed by reading it back.
  const flaky = new MemoryStore();
  flaky.write = async (value: Uint8Array) => { flaky.value = Uint8Array.from(value); return "unknown"; };
  const instance = new AppLockService({ store: flaky, googleAvailable: false, params: FAST });
  await instance.load();
  assert.equal((await instance.setupPassword(SETUP)).status, "configured");
});

test("ID token azp/email_verified and loopback Host checks", async () => {
  const google = fakeGoogle();
  const expect = { clientId: google.clientId, nonce: "n", keys: [google.jwk], issuers: ["https://accounts.google.com"], now: Date.now() };
  const good = google.claims("n");
  assert.throws(() => verifyIdToken(google.token({ ...good, email_verified: undefined }), expect), OAuthError);
  assert.throws(() => verifyIdToken(google.token({ ...good, aud: [google.clientId, "other"], azp: "other" }), expect), OAuthError);
  assert.equal(verifyIdToken(google.token({ ...good, aud: [google.clientId, "other"], azp: google.clientId }), expect).sub, "123");
  const port = await freePort();
  const pending = waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 2_000 });
  await new Promise((done) => setTimeout(done, 50));
  const rebound = await new Promise<number>((done) => {
    const socket = createServer().listen(0); socket.close();
    void import("node:http").then(({ request }) => {
      const req = request({ host: "127.0.0.1", port, path: "/oauth/callback?state=S&code=x", headers: { host: `evil.example:${port}` } }, (res) => { res.resume(); done(res.statusCode ?? 0); });
      req.end();
    });
  });
  assert.equal(rebound, 404);
  await fetch(`http://127.0.0.1:${port}/oauth/callback?state=S&code=ok`);
  assert.deepEqual(await pending, { status: "code", code: "ok" });
});
