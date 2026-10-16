import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createCredentialsController } from "../../apps/desktop/src/main/credentials.ts";
import { registerCredentialHandlers } from "../../apps/desktop/src/main/credential-runtime.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import { SessionRegistry, TransientSecrets, type SessionContext } from "../../packages/services/src/index.ts";
import { channels, isCredentialState, isAnswerCredentialsRequest, failure, type CredentialState } from "../../packages/contracts/src/index.ts";
import type { ResolvedHostConfig } from "../../packages/domain/src/index.ts";
const owner = { windowId: 1, generation: 1 };
const other = { windowId: 2, generation: 2 };
const config: ResolvedHostConfig = {
  hostRef: { id: "host-1", revision: 1, label: "เป้าหมาย lab", groupId: null }, address: "example.com", environment: "PROD",
  port: { value: 22, source: { kind: "default" } },
  auth: { selection: "identity", source: { kind: "default" }, key: null, identity: null }, ancestry: [], catalogRevision: 1,
};
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function fixture() {
  const contexts: SessionContext[] = [];
  const registry = new SessionRegistry({ resolve: () => ({ ok: true, value: config }), transient: new TransientSecrets(), adapter: { start(context) { contexts.push(context); } } });
  const controller = createCredentialsController({ registry });
  const events: CredentialState[] = [];
  controller.register(owner, (state) => events.push(state));
  controller.register(other, () => {});
  const connected = registry.connect(sessionOwnerId(owner), "host-1");
  assert.ok(connected.ok);
  await tick();
  const context = contexts[0]!;
  context.verifyingHost(); context.authenticating();
  const pending = context.requestPrompt({ kind: "credentials", purpose: "keyboard-interactive", attempt: 2, fields: [{ id: "response-1", echo: false }, { id: "response-2", echo: true }] });
  // Cancellation tests deliberately reject this pending prompt.
  void pending.catch(() => {});
  const state = controller.credentialState(owner); assert.ok(state.ok);
  const prompt = state.value.prompts[0]!;
  const identity = { owner, sessionId: prompt.sessionId, generation: prompt.generation, promptId: prompt.promptId };
  return { registry, controller, events, context, pending, identity, prompt };
}
test("credential controller projects safe targets and copies answers into transient session storage", async () => {
  const f = await fixture();
  try {
    const projected = f.events.at(-1)!;
    assert.ok(isCredentialState(projected));
    assert.equal(f.prompt.targetLabel, "เป้าหมาย lab"); assert.equal(f.prompt.environment, "PROD");
    assert.equal(f.prompt.purpose, "keyboard-interactive"); assert.equal(f.prompt.attempt, 2);
    assert.deepEqual(f.prompt.fields, [{ id: "response-1", echo: false }, { id: "response-2", echo: true }]);
    const first = new TextEncoder().encode("owned-secret-one");
    const second = new TextEncoder().encode("owned-secret-two");
    const values = [{ id: "response-1" as const, value: first }, { id: "response-2" as const, value: second }];
    const answer = { ...f.identity, values };
    assert.deepEqual(f.controller.answerCredentials({ ...answer, owner: other }), failure("invalid-request"));
    assert.equal(f.controller.answerCredentials({ ...answer, generation: f.identity.generation + 1 }).ok, false);
    assert.equal(f.controller.answerCredentials({ ...answer, values: [values[0]!] }).ok, false);
    assert.equal(f.controller.answerCredentials(answer).ok, true);
    const result = await f.pending; assert.equal(result.kind, "credentials");
    if (result.kind !== "credentials") assert.fail();
    const retained: Uint8Array[] = [];
    result.use((fields) => {
      assert.equal(new TextDecoder().decode(fields["response-1"]), "owned-secret-one");
      assert.equal(new TextDecoder().decode(fields["response-2"]), "owned-secret-two");
      retained.push(fields["response-1"]!, fields["response-2"]!);
    });
    assert.ok(retained.every((bytes) => bytes.every((byte) => byte === 0)));
    assert.equal(new TextDecoder().decode(first), "owned-secret-one");
    assert.equal(f.events.at(-1)!.prompts.length, 0);
    assert.equal(JSON.stringify(f.events).includes("owned-secret"), false);
    assert.equal(f.controller.answerCredentials(answer).ok, false);
  } finally { f.controller.dispose(); await f.registry.dispose(); }
});
test("exact credential cancellation rejects stale sessions and clears the prompt synchronously", async () => {
  const f = await fixture();
  try {
    assert.equal(f.controller.cancelCredentialPrompt({ ...f.identity, promptId: "stale" }).ok, false);
    assert.equal(f.controller.cancelCredentialPrompt({ ...f.identity, owner: other }).ok, false);
    assert.equal(f.controller.cancelCredentialPrompt(f.identity).ok, true);
    assert.equal(f.events.at(-1)!.prompts.length, 0);
    const snapshot = f.registry.snapshot(sessionOwnerId(owner))[0]!;
    assert.equal(snapshot.state, "Failed"); assert.equal(snapshot.error?.code, "prompt-cancelled");
    assert.equal(f.controller.cancelCredentialPrompt(f.identity).ok, false);
    f.controller.revokeOwner(owner);
    assert.deepEqual(f.controller.credentialState(owner), failure("stale-owner"));
    assert.deepEqual(f.controller.cancelCredentialPrompt(f.identity), failure("stale-owner"));
  } finally { f.controller.dispose(); f.controller.dispose(); await f.registry.dispose(); }
});
test("credential contracts bound answer fields and exclude secret metadata", () => {
  const base = { owner, sequence: 0, availability: "ready", prompts: [] };
  assert.ok(isCredentialState(base));
  const identity = { owner, sessionId: "s", generation: 1, promptId: "p" };
  const value = new Uint8Array(16 * 1024);
  assert.ok(isAnswerCredentialsRequest({ ...identity, values: [{ id: "password", value }] }));
  for (const invalid of [
    { ...identity, extra: true, values: [{ id: "password", value }] },
    { ...identity, values: [{ id: "password", value: "secret" }] },
    { ...identity, values: [{ id: "password", value: new Uint8Array(16 * 1024 + 1) }] },
    { ...identity, values: [{ id: "password", value }, { id: "password", value }] },
    { ...identity, values: Array.from({ length: 5 }, (_, i) => ({ id: `response-${i + 1}`, value })) },
    { ...identity, values: [{ id: "arbitrary", value }] },
    { ...identity, owner: { ...owner, secretRef: "hidden" }, values: [{ id: "password", value }] },
    { ...identity, values: [{ id: "password", value, echo: true }] },
  ]) assert.equal(isAnswerCredentialsRequest(invalid), false);
  for (const invalid of [{ ...base, values: [] }, { ...base, owner: { ...owner, secret: true } }, { ...base, prompts: Array(33).fill({}) }]) assert.equal(isCredentialState(invalid), false);
});
test("guarded credential IPC rejects forged owners/frames/URLs before dispatch and wipes all answer payloads", async () => {
  const f = await fixture();
  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sent: unknown[] = [];
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send: (_channel: string, value: unknown) => sent.push(value) };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const ipc = { handle(channel: string, listener: Handler) { handlers.set(channel, listener); }, removeHandler(channel: string) { handlers.delete(channel); } } satisfies Pick<IpcMain, "handle" | "removeHandler">;
  const unregister = registerCredentialHandlers({ ipc, boundary, controller: () => f.controller });
  const invoke = (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event as IpcMainInvokeEvent, ...args);
  const event = { sender, senderFrame: mainFrame };
  const request = () => ({ ...f.identity, values: [{ id: "response-1", value: new Uint8Array([1, 2]) }, { id: "response-2", value: new Uint8Array([3]) }] });
  try {
    for (const forged of [
      { sender: { ...sender }, senderFrame: mainFrame },
      { sender, senderFrame: { url: mainFrame.url } },
      { sender, senderFrame: null },
    ]) {
      const answer = request();
      assert.deepEqual(invoke(channels.answerCredentials, forged, answer), failure("unauthorized"));
      assert.ok(answer.values.every((field) => field.value.every((byte) => byte === 0)));
    }
    const stale = request();
    assert.deepEqual(invoke(channels.answerCredentials, event, { ...stale, owner: { ...owner, generation: 99 } }), failure("stale-owner"));
    assert.ok(stale.values.every((field) => field.value.every((byte) => byte === 0)));
    mainFrame.url = "http://malicious.invalid/";
    const wrongURL = request();
    assert.deepEqual(invoke(channels.answerCredentials, event, wrongURL), failure("unauthorized"));
    mainFrame.url = "http://127.0.0.1:5174/";
    const invalid = request();
    assert.deepEqual(invoke(channels.answerCredentials, event, { ...invalid, extra: true }), failure("invalid-request"));
    assert.ok(invalid.values.every((field) => field.value.every((byte) => byte === 0)));
    const extra = request();
    assert.deepEqual(invoke(channels.answerCredentials, event, extra, extra), failure("invalid-request"));
    assert.ok(extra.values.every((field) => field.value.every((byte) => byte === 0)));
    const valid = request();
    assert.deepEqual(invoke(channels.answerCredentials, event, valid), { ok: true, value: { accepted: true } });
    assert.ok(valid.values.every((field) => field.value.every((byte) => byte === 0)));
    const answer = await f.pending; if (answer.kind === "credentials") answer.use((fields) => assert.deepEqual([...fields["response-1"]!], [1, 2]));
    assert.equal(JSON.stringify(sent).includes("values"), false);
  } finally { unregister(); assert.equal(handlers.size, 0); boundary.dispose(); f.controller.dispose(); await f.registry.dispose(); }
});
