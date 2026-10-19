import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DesktopAPI, TerminalSession } from "../../packages/contracts/src/index.ts";
import { captureTerminalTarget, startSiblingTerminal, terminalIdentity } from "../../apps/desktop/src/renderer/src/lib/terminal-target.ts";

const local = (): TerminalSession => ({ sessionId: "local-one", generation: 3, hostId: null, target: null,
  local: { shell: "zsh", platform: "darwin" }, phase: "ready", end: null, error: null });
const ssh = (): TerminalSession => ({ sessionId: "ssh-one", generation: 1, hostId: "saved-one",
  target: { label: "Lab", endpointHost: "::1", endpointPort: 22, username: "lab", environment: "PROD" },
  phase: "ready", end: null, error: null });

test("local identity and captured snippet target identify this Mac without inventing an SSH endpoint", () => {
  const session = local();
  assert.deepEqual(terminalIdentity(session), { label: "This Mac", endpoint: "zsh", local: true, production: false });
  const captured = captureTerminalTarget(session)!;
  session.generation += 1;
  session.local!.shell = "bash";
  assert.equal(captured.sessionId, "local-one");
  assert.equal(captured.generation, 3);
  assert.equal(captured.endpoint, "zsh");
  assert.equal(captureTerminalTarget({ ...local(), phase: "closed" }), undefined);
  assert.equal(captureTerminalTarget(undefined), undefined);
  assert.deepEqual(terminalIdentity(ssh()), { label: "Lab", endpoint: "lab@[::1]:22", local: false, production: true });
});

test("split routing opens a fresh local process or the same saved host, and fails closed with no host", async () => {
  const calls: unknown[] = [];
  const result = { ok: true as const, value: { sessionId: "new", generation: 1 } };
  const bridge: Pick<DesktopAPI, "startLocalTerminal" | "connectHost"> = {
    startLocalTerminal: async (request) => { calls.push(["local", request]); return result; },
    connectHost: async (request) => { calls.push(["ssh", request]); return result; },
  };
  const owner = { windowId: 1, generation: 1 };
  assert.equal(await startSiblingTerminal(bridge, owner, local()), result);
  assert.equal(await startSiblingTerminal(bridge, owner, ssh()), result);
  const unknown = { ...ssh(), hostId: null, target: null };
  assert.equal(await startSiblingTerminal(bridge, owner, unknown), undefined);
  assert.deepEqual(calls, [["local", { owner }], ["ssh", { owner, hostId: "saved-one" }]]);
});
