import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:net";
import { waitForOAuthCallback } from "../../packages/adapters/src/oauth-loopback.ts";
import { LOGO_DATA_URI } from "../../packages/adapters/src/oauth-loopback-logo.ts";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** Sends raw bytes and returns everything the server writes before it closes the connection. */
function rawRequest(port: number, bytes: string): Promise<string> {
  return new Promise((done, fail) => {
    let out = "";
    const socket = connect(port, "127.0.0.1", () => socket.end(bytes));
    socket.on("data", (chunk) => (out += chunk));
    socket.on("error", fail);
    socket.on("close", () => done(out));
  });
}

const sha = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const HOSTILE = encodeURIComponent(`<script>alert("x")</script>"'evil-marker`);

/** Headers and CSP hashes that must hold on every served page. */
function assertHardened(response: Response, html: string, closable: boolean) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^default-src 'none'; img-src data:; style-src 'sha256-[A-Za-z0-9+/=]+'; script-src 'sha256-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
  assert.ok(!csp.includes("unsafe"));
  assert.equal(html.split("<script").length - 1, closable ? 1 : 0, "exactly one script element on closable pages, none on Not found");
  const scripts = [...html.matchAll(/<script>([^<]*)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, closable ? 1 : 0);
  if (closable) assert.ok(csp.includes(`script-src ${sha(scripts[0])};`), "script hash matches the inline script");
  assert.equal(html.split("<style").length - 1, 1);
  const styles = [...html.matchAll(/<style>([^<]*)<\/style>/g)].map((m) => m[1]);
  assert.equal(styles.length, 1);
  assert.ok(csp.includes(`style-src ${sha(styles[0])};`), "style hash matches the inline style");
  assert.ok(!/\sstyle=|\son[a-z]+=/i.test(html), "no inline style or handler attributes the CSP would block");
  assert.ok(!/(src|href)="(?!data:)/.test(html), "no external resources");
  assert.ok(html.includes(`src="${LOGO_DATA_URI}"`), "inline logo");
  assert.ok(!html.includes("evil") && !html.includes("alert"), "never echoes parameters");
}

test("loopback callback pages: Charcoal page, inline logo, close button, strict CSP, no parameter echo", async () => {
  assert.ok(LOGO_DATA_URI.startsWith("data:image/png;base64,iVBORw0KGgo"));
  assert.ok(LOGO_DATA_URI.length < 24_000, "the logo stays small");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/oauth/callback`;

  const pending = waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 5_000 });
  await new Promise((done) => setTimeout(done, 50));
  const missing = await fetch(`${base}?state=${HOSTILE}&code=${HOSTILE}`);
  const missingHtml = await missing.text();
  assert.equal(missing.status, 404);
  assertHardened(missing, missingHtml, false);
  assert.match(missingHtml, /Not found/);
  assert.ok(!missingHtml.includes("<button") && !missingHtml.includes("<script"), "no button on Not found");

  const signed = await fetch(`${base}?state=S&code=${HOSTILE}&scope=${HOSTILE}`);
  const signedHtml = await signed.text();
  assert.equal(signed.status, 200);
  assertHardened(signed, signedHtml, true);
  assert.match(signedHtml, /<title>Signed in · ssterm<\/title>/);
  assert.match(signedHtml, /<button id="close" type="button" hidden>Close this window<\/button>/);
  assert.match(signedHtml, /window\.close\(\)/);
  assert.match(signedHtml, /close this tab with ⌘W/, "no-JS hint is visible before any script runs");
  assert.match(signedHtml, /Your browser kept this tab open \\u2014 close it with \\u2318W and return to ssterm\./);
  assert.deepEqual(await pending, { status: "code", code: decodeURIComponent(HOSTILE) });
  await assert.rejects(fetch(base), "single use: the listener is closed afterwards");

  const denied = waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 5_000 });
  await new Promise((done) => setTimeout(done, 50));
  const failed = await fetch(`${base}?state=S&error=${HOSTILE}&error_description=${HOSTILE}`);
  const failedHtml = await failed.text();
  assert.equal(failed.status, 200);
  assertHardened(failed, failedHtml, true);
  assert.match(failedHtml, /Sign-in was not completed/);
  assert.match(failedHtml, /Close this window/);
  assert.deepEqual(await denied, { status: "denied" });
});

test("loopback callback: a malformed request line answers 404 without throwing; pipelined callbacks cannot win twice", async () => {
  const port = await freePort();
  const host = `Host: 127.0.0.1:${port}\r\n`;
  const pending = waitForOAuthCallback({ port, path: "/oauth/callback", state: "S", timeoutMs: 5_000 });
  await new Promise((done) => setTimeout(done, 50));
  const malformed = await rawRequest(port, `GET http://[ HTTP/1.1\r\n${host}Connection: close\r\n\r\n`);
  assert.match(malformed, /^HTTP\/1\.1 404 /);
  assert.match(malformed, /\r\ncontent-security-policy: default-src 'none';/i);
  assert.match(malformed, /\r\nx-content-type-options: nosniff\r\n/i);
  // The listener survived and still serves the real callback. A second callback pipelined on the same
  // connection never resolves anything: the connection is dropped once the first page has been sent.
  const both = await rawRequest(port, `GET /oauth/callback?state=S&code=first HTTP/1.1\r\n${host}\r\nGET /oauth/callback?state=S&code=second HTTP/1.1\r\n${host}\r\n`);
  assert.deepEqual(both.match(/HTTP\/1\.1 \d+/g), ["HTTP/1.1 200"]);
  assert.deepEqual(await pending, { status: "code", code: "first" });
});
