import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type { GoogleIdentity } from "./app-lock.ts";

/** Installed-app OAuth with the system browser and a loopback redirect (ADR 0004). */
export const GOOGLE_LOOPBACK_PORT = 55411;
export const GOOGLE_CALLBACK_PATH = "/oauth/callback";
export const redirectUri = (port = GOOGLE_LOOPBACK_PORT) => `http://127.0.0.1:${port}${GOOGLE_CALLBACK_PATH}`;
export const GOOGLE_REDIRECT_URI = redirectUri();
export interface GoogleEndpoints {
  authorization: string;
  token: string;
  jwks: string;
  issuers: readonly string[];
}
export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};
export interface GoogleClient { clientId: string; clientSecret: string }
export type OAuthFailure = "network" | "invalid-response" | "denied";
export class OAuthError extends Error {
  constructor(readonly code: OAuthFailure) { super(code); }
}
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const base64url = (bytes: Buffer) => bytes.toString("base64url");
const NETWORK_TIMEOUT_MS = 10_000;

/** A fresh request: PKCE verifier (S256), state and nonce, each 32 random bytes. */
export function beginAuthorization(client: GoogleClient, endpoints = GOOGLE_ENDPOINTS, loginHint?: string, redirect = GOOGLE_REDIRECT_URI) {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const url = new URL(endpoints.authorization);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email",
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    nonce,
    prompt: "select_account",
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return { url: url.toString(), verifier, state, nonce, redirect };
}

async function request(fetcher: Fetch, url: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
  } catch {
    throw new OAuthError("network");
  }
  if (!response.ok) throw new OAuthError(response.status === 400 || response.status === 401 ? "denied" : "invalid-response");
  try { return await response.json(); } catch { throw new OAuthError("invalid-response"); }
}

/** Exchanges the code at the token endpoint and returns the verified identity. No token is kept. */
export async function completeAuthorization(options: {
  client: GoogleClient;
  code: string;
  verifier: string;
  nonce: string;
  endpoints?: GoogleEndpoints;
  fetch?: Fetch;
  now?: () => number;
  /** Must equal the authorization request's redirect URI. */
  redirect?: string;
}): Promise<GoogleIdentity> {
  const endpoints = options.endpoints ?? GOOGLE_ENDPOINTS;
  const fetcher = options.fetch ?? fetch;
  const token = await request(fetcher, endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: options.code,
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      redirect_uri: options.redirect ?? GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
      code_verifier: options.verifier,
    }).toString(),
  }) as { id_token?: unknown };
  if (typeof token?.id_token !== "string") throw new OAuthError("invalid-response");
  const keys = await request(fetcher, endpoints.jwks) as { keys?: unknown };
  return verifyIdToken(token.id_token, {
    clientId: options.client.clientId, nonce: options.nonce, keys: Array.isArray(keys?.keys) ? keys.keys as JsonWebKey[] : [],
    issuers: endpoints.issuers, now: options.now?.() ?? Date.now(),
  });
}

/** RS256 signature by a published key, issuer, audience, expiry and nonce; the account must have an email. */
export function verifyIdToken(token: string, expect: { clientId: string; nonce: string; keys: JsonWebKey[]; issuers: readonly string[]; now: number }): GoogleIdentity {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 16_384) throw new OAuthError("invalid-response");
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch { throw new OAuthError("invalid-response"); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new OAuthError("invalid-response");
  const jwk = expect.keys.find((key) => (key as { kid?: unknown }).kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new OAuthError("invalid-response");
  let valid = false;
  try {
    valid = verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2]!, "base64url"));
  } catch { valid = false; }
  if (!valid) throw new OAuthError("invalid-response");
  const seconds = Math.floor(expect.now / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!expect.issuers.includes(claims.iss as string) || !audience.includes(expect.clientId) ||
    typeof claims.exp !== "number" || claims.exp + 60 < seconds || (typeof claims.iat === "number" && claims.iat - 300 > seconds) ||
    claims.nonce !== expect.nonce || typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string" ||
    claims.email.length > 320 || claims.email_verified !== true ||
    // With several audiences (or an explicit azp) the authorized party must be this client.
    ((audience.length > 1 || claims.azp !== undefined) && claims.azp !== expect.clientId))
    throw new OAuthError("invalid-response");
  return { sub: claims.sub, email: claims.email };
}

/** Whether Google answers at all (any HTTP response); used before allowing the offline grace. */
export async function googleReachable(endpoints = GOOGLE_ENDPOINTS, fetcher: Fetch = fetch): Promise<boolean> {
  try {
    await fetcher(endpoints.jwks, { method: "HEAD", signal: AbortSignal.timeout(3_000) });
    return true;
  } catch { return false; }
}
