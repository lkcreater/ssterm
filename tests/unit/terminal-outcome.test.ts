import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lifecycleFailure, terminalOutcome } from "../../apps/desktop/src/renderer/src/lib/terminal-outcome.ts";
import { TERMINAL_ERROR_CODES, type TerminalErrorCode, type TerminalSession } from "../../packages/contracts/src/index.ts";

type Outcome = Pick<TerminalSession, "phase" | "end" | "error">;
const failed = (error: TerminalErrorCode | null): Outcome => ({ phase: "failed", end: null, error });
const codes = [...TERMINAL_ERROR_CODES];

test("live phases show no outcome", () => {
  for (const phase of ["connecting", "ready"] as const)
    for (const connected of [false, true]) assert.equal(terminalOutcome({ phase, end: null, error: null }, connected), null);
});

test("remote ends are reported as remote outcomes, whatever the local state", () => {
  assert.equal(terminalOutcome({ phase: "closed", end: { kind: "exit", code: 7 }, error: null }, true), "Remote process exited with status 7");
  assert.equal(terminalOutcome({ phase: "closed", end: { kind: "signal", signal: "SIGKILL" }, error: null }, true), "Remote process was terminated by SIGKILL");
  assert.equal(terminalOutcome({ phase: "closed", end: { kind: "eof" }, error: null }, true), "The remote end closed the session");
});

test("a network or timeout failure after Ready is a lost connection; before Ready it is a failed attempt", () => {
  for (const error of ["network", "timeout"] as const) {
    assert.equal(terminalOutcome(failed(error), true), "Connection lost");
    assert.match(terminalOutcome(failed(error), false)!, /^Couldn't connect: /);
  }
  assert.equal(terminalOutcome(failed("network"), false), "Couldn't connect: the server could not be reached");
  assert.equal(terminalOutcome(failed("timeout"), false), "Couldn't connect: the server did not respond in time");
});

test("every failure code has fixed app-authored copy", () => {
  const texts = new Set<string>();
  for (const code of codes.filter((code) => code !== "locked")) {
    const text = terminalOutcome(failed(code), false)!;
    assert.match(text, /^Couldn't connect: [a-z][^\n]{5,80}$/, code);
    assert.ok(!text.includes("undefined"), code);
    texts.add(text);
  }
  assert.equal(texts.size, codes.length - 1, "each code reads differently");
  assert.equal(terminalOutcome(failed("auth-denied"), true), "Session failed: the server rejected the credentials");
  assert.equal(terminalOutcome(failed("resource-limit"), true), "Session failed: output exceeded the safety limit");
  assert.equal(terminalOutcome(failed("resource-limit"), false), "Couldn't connect: a session limit was reached");
  assert.equal(terminalOutcome(failed(null), false), "Couldn't connect");
});

test("lock and local close are distinct from failures", () => {
  const locked = "Closed because ssterm locked (screen lock or sleep)";
  assert.equal(terminalOutcome({ phase: "closed", end: null, error: "locked" }, true), locked);
  assert.equal(terminalOutcome(failed("locked"), false), locked);
  assert.equal(terminalOutcome({ phase: "closed", end: null, error: null }, true), "Session closed");
});

test("a failure that is then closed keeps its reason", () => {
  const closed = (error: TerminalErrorCode): Outcome => ({ phase: "closed", end: null, error });
  assert.equal(terminalOutcome(closed("prompt-cancelled"), false), "Couldn't connect: authentication was cancelled");
  assert.equal(terminalOutcome(closed("auth-denied"), false), "Couldn't connect: the server rejected the credentials");
  assert.equal(terminalOutcome(closed("network"), true), "Connection lost");
  for (const code of codes) assert.notEqual(terminalOutcome(closed(code), false), "Session closed", code);
});

test("refused lifecycle requests use fixed copy", () => {
  const changed = "This session changed since you clicked; check the pane and try again.";
  assert.equal(lifecycleFailure("reconnect", "conflict"), changed);
  assert.equal(lifecycleFailure("dismiss", "conflict"), changed);
  assert.equal(lifecycleFailure("reconnect", "unavailable"), "Couldn't reconnect. Try again.");
  assert.match(lifecycleFailure("reconnect", "unavailable", true), /could not unlock/);
  assert.match(lifecycleFailure("dismiss", "stale-owner"), /out of date/);
  assert.equal(lifecycleFailure("close", "busy"), "That didn't work; try again.");
});
