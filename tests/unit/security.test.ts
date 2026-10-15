import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  contentSecurityPolicy,
  rendererLocation,
} from "../../apps/desktop/src/main/security.ts";

test("packaged renderer ignores development configuration; local document is exact", () => {
  assert.deepEqual(
    rendererLocation(true, "/owned/app/index.html", "https://evil.example/"),
    {
      url: "file:///owned/app/index.html",
    },
  );
  assert.deepEqual(
    rendererLocation(false, "/app/index.html", "http://127.0.0.1:5173"),
    {
      url: "http://127.0.0.1:5173/",
      devOrigin: "http://127.0.0.1:5173",
    },
  );
});

test("development entry rejects non-loopback origins, credentials, paths and URL extras", () => {
  for (const url of [
    "http://localhost:5173/",
    "http://0.0.0.0:5173/",
    "https://127.0.0.1:5173/",
    "http://127.0.0.1/",
    "http://127.0.0.1:5173/other",
    "http://127.0.0.1:5173/?extra=1",
    "http://127.0.0.1:5173/#showcase",
    "http://a:b@127.0.0.1:5173/",
    "file:///app/index.html",
  ])
    assert.throws(() => rendererLocation(false, "/app/index.html", url));
});

test("CSP is offline in production and dev connect allows only the selected loopback port", () => {
  const production = contentSecurityPolicy();
  assert.ok(production.includes("script-src 'self'"));
  assert.equal(
    production
      .split("; ")
      .find((directive) => directive.startsWith("script-src ")),
    "script-src 'self'",
  );
  assert.ok(production.includes("connect-src 'none'"));
  assert.ok(production.includes("font-src 'self'"));
  assert.ok(production.includes("frame-src 'none'"));
  assert.ok(!production.includes("unsafe-eval"));
  assert.ok(!production.includes("http:"));
  assert.ok(
    contentSecurityPolicy("http://127.0.0.1:5173").includes(
      "connect-src http://127.0.0.1:5173 ws://127.0.0.1:5173",
    ),
  );
  assert.ok(
    contentSecurityPolicy("http://127.0.0.1:5173").includes(
      "script-src 'self' 'unsafe-inline'",
    ),
  );
});
