import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, launchDesktop, type Desktop } from "./fixtures";

// Passwords and recovery codes are owned fixture values; keep traces off anyway.
test.use({ trace: "off", screenshot: "off", video: "off" });

const LOCK = { SSTERM_TEST_APP_LOCK: "on" };
const PASSWORD = "เปิด ssterm ด้วยรหัสยาว 2026";
const NEXT_PASSWORD = "a different long passphrase";

const screen = (page: Page) => page.getByTestId("app-lock");
async function gated(page: Page) {
  return page.evaluate(async () => {
    const boot = await window.ssterm.bootstrap();
    if (!boot.ok) return "bootstrap";
    const catalog = await window.ssterm.catalogState({ owner: boot.value.owner });
    const sync = await window.ssterm.syncState({ owner: boot.value.owner });
    const team = await window.ssterm.teamState({ owner: boot.value.owner });
    const mutation = await window.ssterm.teamCommand({ owner: boot.value.owner, action: { type: "fetch" } });
    if (!catalog.ok && catalog.error.code === "unauthorized" && (team.ok || team.error.code !== "unauthorized" || mutation.ok || mutation.error.code !== "unauthorized")) return "team-gate-bypassed";
    if (!catalog.ok && catalog.error.code === "unauthorized" && (sync.ok || sync.error.code !== "unauthorized")) return "sync-gate-bypassed";
    return catalog.ok ? "open" : catalog.error.code;
  });
}
async function saveRecoveryCode(page: Page): Promise<string> {
  const view = page.getByTestId("recovery-code");
  await expect(view).toBeVisible();
  const code = (await view.getByLabel("Recovery code", { exact: true }).textContent())!.trim();
  await expect(view.getByRole("button", { name: "Continue" })).toBeDisabled();
  await view.getByRole("checkbox", { name: "I saved the recovery code" }).click();
  await view.getByRole("button", { name: "Continue" }).click();
  return code;
}

test("password lock: zod-validated first setup, recovery code, locked relaunch with backoff, Settings and recovery", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-lock-"));
  const namespace = `dev.ssterm.test.${crypto.randomUUID()}`;
  let desktop: Desktop | undefined;
  try {
    // 1. First launch: set up a password.
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: LOCK });
    let page = desktop.page;
    await expect(screen(page).getByRole("heading", { name: "Set up sign-in" })).toBeVisible();
    expect(await gated(page), "feature IPC is closed before setup").toBe("unauthorized");
    await page.getByLabel("User name", { exact: true }).fill("al");
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByLabel("Confirm password").fill("other");
    await page.getByRole("button", { name: "Create password" }).click();
    await expect(page.getByText("Use at least 3 characters.")).toBeVisible();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    await expect(page.getByText("The passwords do not match.")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("setup-errors.png") });
    await page.getByLabel("User name", { exact: true }).fill("alice");
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create password" }).click();
    const firstCode = await saveRecoveryCode(page);
    expect(firstCode).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){5}$/u);
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(await gated(page)).toBe("open");
    await desktop.close({ keepSecrets: true });

    // 2. Relaunch: locked until the right password; wrong attempts back off.
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: LOCK });
    page = desktop.page;
    await expect(screen(page).getByRole("heading", { name: "Unlock ssterm" })).toBeVisible();
    expect(await gated(page)).toBe("unauthorized");
    await expect(page.getByLabel("User name", { exact: true })).toHaveValue("alice");
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    await page.getByLabel("Password", { exact: true }).fill("wrong password");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("The user name or password is incorrect.")).toBeVisible();
    await expect(page.getByText(/Try again in \d+ s\./u)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("unlock-wrong.png") });
    await expect(page.getByText(/Try again in \d+ s\./u)).toHaveCount(0, { timeout: 5_000 });
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByTestId("hosts-page")).toBeVisible();

    // Settings: confirm, then issue a new recovery code (the old one stops working).
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Security" }).click();
    const settings = page.getByTestId("sign-in-settings");
    await expect(settings).toContainText("Password · alice");
    await settings.getByLabel("Current password").fill(PASSWORD);
    await settings.getByRole("button", { name: "Confirm" }).click();
    await settings.getByRole("button", { name: "New recovery code" }).click();
    const secondCode = (await settings.getByLabel("Recovery code", { exact: true }).textContent())!.trim();
    expect(secondCode).not.toBe(firstCode);
    await settings.getByRole("checkbox", { name: "I saved the recovery code" }).click();
    await settings.getByRole("button", { name: "Continue" }).click();
    expect(desktop.errors).toEqual([]);
    await desktop.close({ keepSecrets: true });

    // 3. Forgot the password: the replaced code fails, the current code allows a new setup.
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: LOCK });
    page = desktop.page;
    await page.getByRole("button", { name: "Forgot? Use a recovery code" }).click();
    await page.getByLabel("Recovery code").fill(firstCode);
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(page.getByText("That recovery code is not correct.")).toBeVisible();
    await expect(page.getByText(/Try again in \d+ s\./u)).toHaveCount(0, { timeout: 5_000 });
    await page.getByLabel("Recovery code").fill(secondCode.toLowerCase());
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(screen(page).getByRole("heading", { name: "Set up sign-in again" })).toBeVisible();
    expect(await gated(page), "a recovery code alone does not open the app").toBe("unauthorized");
    await page.getByLabel("User name", { exact: true }).fill("alice");
    await page.getByLabel("Password", { exact: true }).fill(NEXT_PASSWORD);
    await page.getByLabel("Confirm password").fill(NEXT_PASSWORD);
    await page.getByRole("button", { name: "Create password" }).click();
    expect(await saveRecoveryCode(page)).not.toBe(secondCode);
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(desktop.errors).toEqual([]);
  } finally {
    await desktop?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

/** A local stand-in for Google: authorization redirect, PKCE-checked token endpoint and RS256 JWKS. */
async function fakeGoogle() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "e2e", alg: "RS256", use: "sig" };
  const clientId = "e2e.apps.googleusercontent.com";
  const state = { mode: "ok" as "ok" | "other-account" | "offline", sub: "google-sub-1", pending: new Map<string, { challenge: string; nonce: string }>() };
  let base = "";
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", base);
    if (state.mode === "offline" && url.pathname !== "/auth") return void request.socket.destroy();
    if (url.pathname === "/auth") {
      const code = crypto.randomUUID();
      state.pending.set(code, { challenge: url.searchParams.get("code_challenge")!, nonce: url.searchParams.get("nonce")! });
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.search = new URLSearchParams({ code, state: url.searchParams.get("state")! }).toString();
      return void response.writeHead(302, { location: redirect.toString() }).end();
    }
    if (url.pathname === "/certs") return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        const pending = state.pending.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!pending || createHash("sha256").update(verifier).digest("base64url") !== pending.challenge || form.get("client_id") !== clientId)
          return void response.writeHead(400).end("{}");
        state.pending.delete(form.get("code")!);
        const now = Math.floor(Date.now() / 1000);
        const claims = { iss: base, aud: clientId, sub: state.mode === "other-account" ? "someone-else" : state.sub, email: "owner@example.com",
          email_verified: true, nonce: pending.nonce, iat: now, exp: now + 300 };
        const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "e2e" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
        const signature = sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), privateKey).toString("base64url");
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: `${head}.${payload}.${signature}` }));
      });
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = {
    ...LOCK,
    SSTERM_TEST_GOOGLE: JSON.stringify({ clientId, clientSecret: "e2e-secret", authorization: `${base}/auth`, token: `${base}/token`, jwks: `${base}/certs`, issuer: base }),
  };
  return { env, state, close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) };
}
/** Stands in for the system browser: main's openExternal follows the authorization redirect to the loopback callback. */
async function browserFollowsRedirect(desktop: Desktop) {
  await desktop.app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __opened?: string[] }).__opened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(new URL(url).origin);
      const response = await fetch(url, { redirect: "manual" });
      const location = response.headers.get("location");
      if (location) await fetch(location);
    };
  });
}

test("Google lock: system-browser sign-in through 127.0.0.1:55411, bound account only, offline grace", async () => {
  test.setTimeout(120_000);
  const google = await fakeGoogle();
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-google-"));
  const namespace = `dev.ssterm.test.${crypto.randomUUID()}`;
  let desktop: Desktop | undefined;
  try {
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: google.env });
    await browserFollowsRedirect(desktop);
    let page = desktop.page;
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await saveRecoveryCode(page);
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    await desktop.close({ keepSecrets: true });

    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: google.env });
    await browserFollowsRedirect(desktop);
    page = desktop.page;
    await expect(screen(page)).toContainText("owner@example.com");
    expect(await gated(page)).toBe("unauthorized");
    google.state.mode = "other-account";
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByText("That Google account is not the one this Mac was set up with.")).toBeVisible();
    expect(await gated(page)).toBe("unauthorized");
    google.state.mode = "ok";
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(await desktop.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toHaveLength(2);
    await desktop.close({ keepSecrets: true });

    // Offline: Google cannot be reached, and the last sign-in is recent, so ssterm may open.
    desktop = await launchDesktop(profile, { secretNamespace: namespace, env: google.env });
    await browserFollowsRedirect(desktop);
    page = desktop.page;
    google.state.mode = "offline";
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect(page.getByText("Google cannot be reached right now.")).toBeVisible();
    await page.getByRole("button", { name: "Continue offline (recent Google sign-in)" }).click();
    await expect(page.getByTestId("hosts-page")).toBeVisible();
    expect(desktop.errors).toEqual([]);
  } finally {
    await desktop?.close();
    await google.close();
    await rm(profile, { recursive: true, force: true });
  }
});
