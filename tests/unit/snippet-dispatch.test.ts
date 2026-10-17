import { strict as assert } from "node:assert";
import { test } from "node:test";
import { planDispatch } from "../../apps/desktop/src/renderer/src/lib/snippet-dispatch.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const plan = (value: string, mode: "insert" | "run", bracketed = true, production = false) =>
  planDispatch({ text: value, mode, bracketed, production });

test("Insert sends the text only; Run appends exactly one Enter after dropping one trailing line break", () => {
  const insert = plan("ls -la", "insert");
  assert.equal(insert.kind, "send");
  assert.equal(text((insert as { bytes: Uint8Array }).bytes), "\x1b[200~ls -la\x1b[201~");
  const run = plan("ls -la\n", "run");
  assert.equal(text((run as { bytes: Uint8Array }).bytes), "\x1b[200~ls -la\x1b[201~\r");
  const unbracketed = plan("uptime", "run", false);
  assert.equal(text((unbracketed as { bytes: Uint8Array }).bytes), "uptime\r");
  // Only one trailing break is dropped: a deliberate blank last line stays.
  const blank = plan("echo a\n\n", "run");
  assert.equal(text((blank as { bytes: Uint8Array }).bytes), "\x1b[200~echo a\r\x1b[201~\r");
});

test("line endings: CRLF, LF and CR become CR; Thai and emoji pass through as UTF-8", () => {
  const multi = plan("echo สวัสดี\r\nprintf '🚀'\nls\rpwd", "insert");
  assert.equal(multi.kind, "send");
  assert.equal(text((multi as { bytes: Uint8Array }).bytes), "\x1b[200~echo สวัสดี\rprintf '🚀'\rls\rpwd\x1b[201~");
  assert.equal((multi as { lines: number }).lines, 4);
});

test("controls are removed (an embedded bracket end cannot escape) and ask first; empty and oversized send nothing", () => {
  const hostile = plan("echo hi\x1b[201~; rm -rf /tmp/x\u202e", "run");
  assert.equal(hostile.kind, "confirm");
  assert.deepEqual((hostile as { reasons: string[] }).reasons, ["removed"]);
  assert.equal(text((hostile as { bytes: Uint8Array }).bytes), "\x1b[200~echo hi[201~; rm -rf /tmp/x\x1b[201~\r");
  assert.deepEqual(plan("", "run"), { kind: "empty" });
  assert.deepEqual(plan("\n", "run"), { kind: "empty" });
  assert.deepEqual(plan("\x07", "insert"), { kind: "empty" });
  assert.equal(plan("\n", "insert").kind, "send");
  assert.deepEqual(plan("a".repeat(256 * 1024 + 1), "insert"), { kind: "refuse", reason: "too-large" });
  assert.deepEqual(plan("ก".repeat(100_000), "insert"), { kind: "refuse", reason: "too-large" });
});

test("Run on PROD and line-by-line multiline text ask first; Insert on PROD of one line does not", () => {
  assert.deepEqual((plan("uptime", "run", true, true) as { reasons: string[] }).reasons, ["production"]);
  assert.equal(plan("uptime", "insert", true, true).kind, "send");
  assert.deepEqual((plan("a\nb", "run", false) as { reasons: string[] }).reasons, ["line-by-line"]);
  assert.deepEqual((plan("a\nb", "insert", false) as { reasons: string[] }).reasons, ["line-by-line"]);
  assert.equal(plan("a\nb", "run", true).kind, "send");
});
