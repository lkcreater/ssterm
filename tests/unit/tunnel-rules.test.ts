import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { createCatalogController } from "../../apps/desktop/src/main/catalog-controller.ts";
import { createTunnelController, registerTunnelHandlers, tunnelChannels } from "../../apps/desktop/src/main/tunnels.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";
import { CatalogModule } from "../../packages/services/src/index.ts";
import { openMetadata } from "../../packages/adapters/src/index.ts";
import type { StoreResult, MetadataRepository } from "../../packages/domain/src/index.ts";
import type { TunnelSnapshot } from "../../packages/services/src/tunnels.ts";
import {
  channels, failure, isCatalogChangeIntent, isStartTunnelResponse, isTunnelRuleRequest, isTunnelState,
  type CatalogChangeIntent, type Result,
} from "../../packages/contracts/src/index.ts";

const owner = { windowId: 1, generation: 1 };
const id = () => randomUUID();
function value<T>(result: StoreResult<T> | Result<T>): T {
  if (!result.ok) assert.fail(JSON.stringify(result.error));
  return result.value;
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync("/private/tmp/ssterm-tunnel-rules-");
  const repo = value(await openMetadata({ path: join(dir, "catalog.sqlite") })) as MetadataRepository;
  const active = new Set<string>();
  const controller = createCatalogController({ repository: repo, catalog: new CatalogModule({ repository: repo }), activeTunnel: (rule) => active.has(rule) });
  controller.register(owner, () => {});
  t.after(() => { controller.dispose(); repo.close(); rmSync(dir, { recursive: true, force: true }); });
  const apply = (intent: CatalogChangeIntent) => {
    const prepared = value(controller.prepareCatalogChange({ owner, intent }));
    if (prepared.kind !== "preview") return prepared.fields;
    return value(controller.applyCatalogChange({ owner, token: prepared.token })).createdIds;
  };
  const hostId = (apply({ type: "create-host", data: { label: "Web", address: "web.example" } }) as string[])[0]!;
  return { repo, controller, active, apply, hostId, state: () => value(controller.catalogState(owner)) };
}

test("tunnel rule intents: guards, loopback default, typed field errors, persistence and no runtime state", async (t) => {
  const s = await fixture(t);
  const data = { label: "DB", hostId: s.hostId, bindPort: 15432, destinationHost: "db.internal", destinationPort: 5432 };
  assert.ok(isCatalogChangeIntent({ type: "create-tunnel-rule", data }));
  for (const bad of [
    { type: "create-tunnel-rule", data: { ...data, bindAddress: "10.0.0.1" } },
    { type: "create-tunnel-rule", data: { ...data, type: "reverse" } },
    { type: "create-tunnel-rule", data: { ...data, destinationPort: "22" } },
    { type: "create-tunnel-rule", data: { ...data, hostId: "web" } },
    { type: "create-tunnel-rule", data: { label: "x" } },
    { type: "update-tunnel-rule", id: id(), expectedRevision: 1, data: {} },
    { type: "delete-tunnel-rule", id: id() },
  ]) assert.equal(isCatalogChangeIntent(bad), false, JSON.stringify(bad));

  const created = s.apply({ type: "create-tunnel-rule", data }) as string[];
  const rule = s.state().tunnelRules.find((row) => row.id === created[0])!;
  assert.deepEqual({ ...rule, id: "", revision: 0 }, {
    id: "", revision: 0, label: "DB", hostId: s.hostId, type: "local", bindAddress: "127.0.0.1", bindPort: 15432, destinationHost: "db.internal", destinationPort: 5432,
  });
  // Per-type shape is checked by main as field errors: public addresses and port 0 belong to remote rules only,
  // dynamic rules have no destination, and forwarding rules need one.
  assert.deepEqual(s.apply({ type: "create-tunnel-rule", data: { ...data, bindAddress: "0.0.0.0" } }), [{ field: "bindAddress", code: "invalid" }]);
  assert.deepEqual(s.apply({ type: "create-tunnel-rule", data: { ...data, type: "dynamic" } }), [{ field: "destination", code: "invalid" }]);
  assert.deepEqual(s.apply({ type: "create-tunnel-rule", data: { label: "R", hostId: s.hostId, type: "remote", bindPort: 0 } }),
    [{ field: "destinationPort", code: "invalid" }, { field: "destination", code: "invalid" }]);
  const [remoteId] = s.apply({ type: "create-tunnel-rule", data: { ...data, label: "Public", type: "remote", bindAddress: "::", bindPort: 0 } }) as string[];
  const [socksId] = s.apply({ type: "create-tunnel-rule", data: { label: "SOCKS", hostId: s.hostId, type: "dynamic", bindPort: 1080, destinationHost: null, destinationPort: null } }) as string[];
  assert.deepEqual(s.state().tunnelRules.find((row) => row.id === socksId)?.destinationPort, null);
  assert.equal(s.state().tunnelRules.find((row) => row.id === remoteId)?.bindAddress, "::");
  // Changing a remote rule's type away keeps its public address only if the change fixes it too.
  assert.deepEqual(s.apply({ type: "update-tunnel-rule", id: remoteId!, expectedRevision: 1, data: { type: "local" } }),
    [{ field: "bindAddress", code: "invalid" }, { field: "bindPort", code: "invalid" }]);
  assert.deepEqual(s.apply({ type: "update-tunnel-rule", id: remoteId!, expectedRevision: 1, data: { type: "dynamic", bindAddress: "127.0.0.1", bindPort: 1081, destinationHost: null, destinationPort: null } }), []);
  for (const extra of [remoteId, socksId]) assert.deepEqual(s.apply({ type: "delete-tunnel-rule", id: extra!, expectedRevision: extra === remoteId ? 2 : 1 }), []);
  assert.deepEqual(s.apply({ type: "create-tunnel-rule", data: { ...data, bindPort: 0, destinationPort: 70_000, destinationHost: "a b" } }), [
    { field: "bindPort", code: "invalid" }, { field: "destinationPort", code: "invalid" }, { field: "destination", code: "invalid" },
  ]);
  assert.deepEqual(s.apply({ type: "create-tunnel-rule", data: { ...data, hostId: id() } }), [{ field: "host", code: "not-found" }]);
  // Duplicate local ports may be saved; a runtime start reports the collision.
  assert.equal((s.apply({ type: "create-tunnel-rule", data: { ...data, label: "DB copy", bindAddress: "::1" } }) as string[]).length, 1);
  assert.deepEqual(s.apply({ type: "update-tunnel-rule", id: rule.id, expectedRevision: 1, data: { destinationHost: "DB.Internal.", bindPort: 25432 } }), []);
  const updated = s.state().tunnelRules.find((row) => row.id === rule.id)!;
  assert.equal(updated.destinationHost, "db.internal", "normalized like any endpoint");
  assert.equal(updated.revision, 2);
});

test("a running tunnel's rule and server cannot be edited or deleted, even if it started after the preview", async (t) => {
  const s = await fixture(t);
  const [ruleId] = s.apply({ type: "create-tunnel-rule", data: { label: "R", hostId: s.hostId, bindPort: 18080, destinationHost: "127.0.0.1", destinationPort: 80 } }) as string[];
  s.active.add(ruleId!);
  const host = s.state().hosts[0]!;
  assert.deepEqual(s.apply({ type: "update-tunnel-rule", id: ruleId!, expectedRevision: 1, data: { bindPort: 18081 } }), [{ field: "tunnel", code: "running" }]);
  assert.deepEqual(s.apply({ type: "delete-tunnel-rule", id: ruleId!, expectedRevision: 1 }), [{ field: "tunnel", code: "running" }]);
  assert.deepEqual(s.apply({ type: "delete-host", id: host.id, expectedRevision: host.revision }), [{ field: "tunnel", code: "running" }]);
  // Other edits of the server are fine: the tunnel keeps the configuration it started with.
  assert.deepEqual(s.apply({ type: "update-host", id: host.id, expectedRevision: host.revision, data: { label: "Web 2" } }), []);
  s.active.delete(ruleId!);
  const prepared = value(s.controller.prepareCatalogChange({ owner, intent: { type: "delete-tunnel-rule", id: ruleId!, expectedRevision: 1 } }));
  assert.equal(prepared.kind, "preview");
  s.active.add(ruleId!);
  assert.deepEqual(s.controller.applyCatalogChange({ owner, token: (prepared as { token: string }).token }), failure("conflict"));
  assert.equal(s.state().tunnelRules.length, 1);
  s.active.delete(ruleId!);
  assert.deepEqual(s.apply({ type: "delete-tunnel-rule", id: ruleId!, expectedRevision: 1 }), []);
  assert.equal(s.state().tunnelRules.length, 0);
});

test("tunnel controller: owner-sequenced state with fixed codes, start unlocks, stop is idempotent; IPC is owner-bound", async () => {
  const ruleId = id();
  const observers = new Set<() => void>();
  let rows: TunnelSnapshot[] = [];
  const service = {
    async start(_owner: string, rule: string) {
      if (rule !== ruleId) return { ok: false as const, code: "rule-not-found" as const };
      rows = [{ ruleId, hostId: id(), type: "local", bindAddress: "127.0.0.1", bindPort: 1, destinationHost: "x", destinationPort: 2, remotePort: null, state: "failed",
        error: "some-new-code" as never, activeConnections: 0, totalConnections: 0, failedConnections: 0 }];
      for (const observer of observers) observer();
      return { ok: true as const, value: rows[0]! };
    },
    async stop() { rows = []; for (const observer of observers) observer(); return { ok: true as const, value: undefined }; },
    snapshot: () => rows,
    subscribe: (_owner: string, callback: () => void) => { observers.add(callback); return () => observers.delete(callback); },
  };
  const lock = { locked: true, lockEpoch: 3, unlocks: 0, async unlock(check: () => Promise<boolean>, since?: number) {
    if (since !== this.lockEpoch || !(await check())) return false;
    this.unlocks += 1; this.locked = false; return true;
  } };
  const controller = createTunnelController({ service: service as never, lock, checkAccess: async () => true });
  const sent: unknown[] = [];
  controller.register(owner, (state) => sent.push(state));
  assert.deepEqual(value(await controller.startTunnel({ owner, ruleId: id() })), { status: "failed", code: "rule-not-found" });
  assert.equal(lock.unlocks, 1, "the explicit start unlocked");
  assert.deepEqual(value(await controller.startTunnel({ owner, ruleId })), { status: "starting" });
  const state = value(controller.tunnelState(owner));
  assert.ok(isTunnelState(state));
  assert.equal(state.tunnels[0]!.error, "other", "unknown codes collapse to a fixed one");
  assert.ok(sent.length >= 1 && sent.every(isTunnelState));
  assert.deepEqual(value(await controller.stopTunnel({ owner, ruleId })), { status: "stopped" });
  assert.deepEqual(value(await controller.stopTunnel({ owner, ruleId })), { status: "stopped" });
  assert.deepEqual(controller.tunnelState({ windowId: 9, generation: 1 }), failure("stale-owner"));
  assert.ok(isStartTunnelResponse({ status: "failed", code: "address-in-use" }));
  assert.equal(isStartTunnelResponse({ status: "failed", code: "EADDRINUSE" }), false);
  assert.equal(isTunnelRuleRequest({ owner, ruleId, force: true }), false);

  const mainFrame = { url: "http://127.0.0.1:5174/" };
  const sender = { id: 7, mainFrame, isDestroyed: () => false, send() {} };
  const boundary = new WindowBoundary(mainFrame.url, { name: "ssterm", version: "0", platform: "darwin" }, () => ({ status: "ready", schemaVersion: 1 }));
  boundary.register(sender, 1, true, () => {});
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const unregister = registerTunnelHandlers({ ipc: { handle: (c: string, h: Handler) => handlers.set(c, h), removeHandler: (c: string) => handlers.delete(c) } as never, boundary, controller: () => controller });
  assert.deepEqual([...handlers.keys()].sort(), [...tunnelChannels].sort());
  const event = { sender, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  assert.deepEqual(await handlers.get(channels.stopTunnel)!(event, { owner, ruleId }), { ok: true, value: { status: "stopped" } });
  assert.deepEqual(await handlers.get(channels.startTunnel)!(event, { owner, ruleId: "x" }), failure("invalid-request"));
  assert.equal(((await handlers.get(channels.startTunnel)!({ sender, senderFrame: { url: "https://evil.example/" } } as never, { owner, ruleId })) as Result<unknown>).ok, false);
  unregister();
  assert.equal(handlers.size, 0);
});
