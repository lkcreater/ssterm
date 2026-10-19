import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TerminalSession } from "../../packages/contracts/src/index.ts";
import type { TerminalInputHandle, TerminalInputs } from "../../apps/desktop/src/renderer/src/components/workspace/terminal-inputs.ts";
import { captureTarget, captureTargets, dispatchTargets, inspectTargets } from "../../apps/desktop/src/renderer/src/lib/multi-target-dispatch.ts";

function session(id: string, production = false): TerminalSession {
  return { sessionId: id, generation: 1, hostId: `host-${id}`, phase: "ready", end: null, error: null,
    target: { label: id, environment: production ? "PROD" : "DEV", endpointHost: `${id}.test`, endpointPort: 22, username: "lab" } };
}
function setup() {
  const sessions = new Map([session("a"), session("b", true)].map((row) => [row.sessionId, row]));
  const sent: { id: string; text: string; bytes: Uint8Array }[] = [];
  const bracketed = { a: true, b: false };
  const inputs: TerminalInputs = new Map([...sessions.keys()].map((id) => [id, {
    generation: 1, accepting: () => true, bracketed: () => bracketed[id as "a" | "b"],
    deliver: async (bytes: Uint8Array) => { sent.push({ id, text: new TextDecoder().decode(bytes), bytes }); return "sent" as const; },
  }]));
  const options = { targets: captureTargets([...sessions.values()]), text: "echo one\necho two", mode: "run" as const,
    inputs, readSession: (id: string) => sessions.get(id) };
  return { sessions, sent, bracketed, inputs, options };
}
test("captured targets are immutable snapshots; duplicate, unready and over-eight sets fail closed", () => {
  const live = session("a"), targets = captureTargets([live]);
  live.target!.label = "changed";
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.label, "a");
  assert.equal(targets[0]!.endpoint, "lab@a.test:22");
  assert.ok(Object.isFrozen(targets[0]));
  assert.equal(captureTarget({ ...live, phase: "connecting" }), null);
  assert.throws(() => captureTargets([{ ...live, phase: "connecting" }]));
  assert.throws(() => captureTargets([live, live]));
  assert.throws(() => captureTargets(Array.from({ length: 9 }, (_, index) => session(String(index)))), RangeError);
});
test("local panes cannot join SSH broadcast or receive bytes through a stale captured SSH target", async () => {
  const { options, sessions, sent } = setup();
  const local: TerminalSession = { ...session("a"), hostId: null, target: null, local: { shell: "zsh", platform: "darwin" } };
  assert.equal(captureTarget(local), null);
  assert.throws(() => captureTargets([local]));
  sessions.set("a", local);
  const result = await dispatchTargets({ ...options, text: "uptime" });
  assert.equal(result[0]!.status, "refused");
  assert.equal(sent.length, 0);
});
test("mixed bracket modes and PROD get independent consent and destination bytes", async () => {
  const { options, sent } = setup();
  const preflight = inspectTargets(options);
  assert.deepEqual(preflight.map((row) => row.reasons), [[], ["production", "line-by-line"]]);
  const results = await dispatchTargets({ ...options, approvedReasons: new Map(preflight.map((row) => [row.target.sessionId, row.reasons])) });
  assert.deepEqual(results.map((row) => row.status), ["accepted", "accepted"]);
  assert.deepEqual(sent.map((row) => row.text), ["\x1b[200~echo one\recho two\x1b[201~\r", "echo one\recho two\r"]);
  assert.ok(sent.every((row) => row.bytes.every((byte) => byte === 0)), "temporary bytes are wiped after delivery settles");
});
test("a newly unbracketed target needs fresh consent; a reconnected target is refused", async () => {
  const { options, bracketed, sessions, sent } = setup();
  const preflight = inspectTargets(options);
  bracketed.a = false;
  sessions.get("b")!.generation = 2;
  const results = await dispatchTargets({ ...options, approvedReasons: new Map(preflight.map((row) => [row.target.sessionId, row.reasons])) });
  assert.deepEqual(results.map((row) => row.status), ["needs-confirmation", "refused"]);
  assert.deepEqual(results[0]!.reasons, ["line-by-line"]);
  assert.equal(sent.length, 0);
});
test("Insert does not append Enter; PROD Run and removed controls require consent", async () => {
  const { options, sent } = setup();
  assert.deepEqual((await dispatchTargets({ ...options, text: "uptime", mode: "insert" })).map((row) => row.status), ["accepted", "accepted"]);
  assert.deepEqual(sent.map((row) => row.text), ["\x1b[200~uptime\x1b[201~", "uptime"]);
  assert.deepEqual(inspectTargets({ ...options, text: "\x1buptime" }).map((row) => row.reasons), [["removed"], ["production", "removed"]]);
});
test("a newly observed PROD risk requires fresh consent even if the captured label was DEV", async () => {
  const { options, sessions, sent } = setup();
  const inspection = inspectTargets({ ...options, text: "uptime" });
  sessions.get("a")!.target!.environment = "PROD";
  const results = await dispatchTargets({ ...options, text: "uptime", approvedReasons: new Map(inspection.map((row) => [row.target.sessionId, row.reasons])) });
  assert.equal(results[0]!.status, "needs-confirmation");
  assert.deepEqual(results[0]!.reasons, ["production"]);
  assert.deepEqual(sent.map((row) => row.id), ["b"]);
});
test("cancel before delivery and between targets cancels only undispatched work", async () => {
  const { options, sent } = setup();
  const before = new AbortController(); before.abort();
  assert.deepEqual((await dispatchTargets({ ...options, signal: before.signal })).map((row) => row.status), ["cancelled", "cancelled"]);
  assert.equal(sent.length, 0);
  const between = new AbortController();
  const results = await dispatchTargets({ ...options, text: "uptime", signal: between.signal, onResult: () => between.abort() });
  assert.deepEqual(results.map((row) => row.status), ["accepted", "cancelled"]);
  assert.equal(sent.length, 1);
});
test("cancel while a write is in flight awaits real acceptance and retains only the pane-owned copy", async () => {
  const { options, inputs, sent } = setup();
  const abort = new AbortController();
  let finish!: (result: "sent" | "refused") => void;
  let handedOff!: Uint8Array;
  let queueCopy!: Uint8Array;
  inputs.set("a", { ...inputs.get("a")!, deliver: (bytes) => {
    handedOff = bytes;
    queueCopy = Uint8Array.from(bytes);
    return new Promise((resolve) => { finish = (result) => { queueCopy.fill(0); resolve(result); }; });
  } });
  const pending = dispatchTargets({ ...options, text: "uptime", signal: abort.signal });
  assert.ok(handedOff.every((byte) => byte === 0), "the caller's planning copy is wiped before acknowledgement");
  assert.ok(queueCopy.some((byte) => byte !== 0));
  abort.abort();
  assert.ok(queueCopy.some((byte) => byte !== 0), "the pane-owned in-flight bytes stay intact");
  finish("sent");
  assert.deepEqual((await pending).map((row) => row.status), ["accepted", "cancelled"]);
  assert.ok(handedOff.every((byte) => byte === 0));
  assert.ok(queueCopy.every((byte) => byte === 0));
  assert.equal(sent.length, 0);
});
test("partial refusal never redirects or retries; handle generation and acceptance are fenced", async () => {
  const { options, inputs, sent } = setup();
  inputs.set("a", { ...inputs.get("a")!, deliver: async () => "refused" });
  const results = await dispatchTargets({ ...options, text: "uptime", mode: "insert" });
  assert.deepEqual(results.map((row) => row.status), ["refused", "accepted"]);
  assert.deepEqual(sent.map((row) => row.id), ["b"]);
  for (const change of [{ generation: 2 }, { accepting: () => false }]) {
    inputs.set("a", { ...inputs.get("a")!, generation: 1, accepting: () => true, ...change } as TerminalInputHandle);
    assert.equal(inspectTargets(options)[0]!.status, "refused");
  }
});
test("empty, over-budget, thrown refusal and target snapshot changes have explicit outcomes", async () => {
  const { options, inputs, sent } = setup();
  assert.deepEqual((await dispatchTargets({ ...options, text: "" })).map((row) => row.status), ["empty", "empty"]);
  assert.deepEqual((await dispatchTargets({ ...options, text: "x".repeat(262_145) })).map((row) => row.status), ["too-large", "too-large"]);
  inputs.set("a", { ...inputs.get("a")!, deliver: async () => { throw new Error("closed"); } });
  const selected = [...options.targets];
  const results = await dispatchTargets({ ...options, targets: selected, text: "uptime", mode: "insert", onResult: () => { selected.length = 0; } });
  assert.deepEqual(results.map((row) => row.status), ["refused", "accepted"]);
  assert.deepEqual(sent.map((row) => row.id), ["b"]);
});
