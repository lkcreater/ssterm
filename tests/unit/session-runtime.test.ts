import { strict as assert } from "node:assert";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { ResolvedHostConfig } from "../../packages/domain/src/index.ts";
import { TransientSecrets } from "../../packages/services/src/index.ts";
import {
  createDesktopSessions,
  sessionOwnerId,
} from "../../apps/desktop/src/main/session-runtime.ts";
import { WindowBoundary } from "../../apps/desktop/src/main/boundary.ts";

function fixture() {
  const hostId = randomUUID();
  const config: ResolvedHostConfig = {
    hostRef: { id: hostId, revision: 1, label: "Owned lab", groupId: null },
    address: "127.0.0.1",
    environment: null,
    port: { value: 2222, source: { kind: "default" } },
    auth: {
      selection: "none",
      identity: null,
      key: null,
      source: { kind: "default" },
    },
    ancestry: [],
    catalogRevision: 1,
  };
  const power = new EventEmitter();
  const transient = new TransientSecrets();
  const contexts: any[] = [];
  let disposed = 0;
  const runtime = createDesktopSessions({
    resolve: () => ({ ok: true, value: config }),
    transient,
    power,
    adapter: {
      start(context) {
        contexts.push(context);
        context.own({
          dispose: () => {
            disposed += 1;
          },
        });
        assert.equal(context.verifyingHost(), true);
        assert.equal(context.authenticating(), true);
        assert.equal(
          context.ready({
            dispose: () => {
              disposed += 1;
            },
          }),
          true,
        );
      },
    },
  });
  return {
    runtime,
    hostId,
    config,
    power,
    transient,
    contexts,
    disposed: () => disposed,
  };
}

test("power lock and suspend synchronously revoke sessions and require explicit unlock", async (t) => {
  const f = fixture();
  t.after(() => f.runtime.shutdown());
  const owner = sessionOwnerId({ windowId: 1, generation: 1 });
  const opened = f.runtime.registry.connect(owner, f.hostId);
  assert.ok(opened.ok);
  await setImmediate();
  assert.equal(f.runtime.registry.snapshot(owner)[0].state, "Ready");
  const held = f.transient.hold(Buffer.from("owned-fixture-only"));
  f.power.emit("lock-screen");
  assert.equal(held.disposed, true);
  assert.equal(f.contexts[0].signal.aborted, true);
  assert.equal(f.disposed(), 2);
  assert.notEqual(f.runtime.registry.snapshot(owner)[0].state, "Ready");
  const blocked = f.runtime.registry.connect(owner, f.hostId);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, "locked");
  f.power.emit("unlock-screen");
  assert.equal(f.runtime.registry.connect(owner, f.hostId).ok, false);
  assert.equal(await f.runtime.registry.unlock(async () => false), false);
  assert.equal(await f.runtime.registry.unlock(async () => true), true);
  assert.equal(f.contexts.length, 1, "unlock never reconnects");

  assert.ok(f.runtime.registry.connect(owner, f.hostId).ok);
  await setImmediate();
  const next = f.transient.hold(Buffer.from("second-owned-value"));
  f.power.emit("suspend");
  assert.equal(next.disposed, true);
  assert.equal(f.contexts[1].signal.aborted, true);
  assert.equal(f.disposed(), 4);
});

test("window generation rotation closes only its old sessions and destruction revokes the replacement", async (t) => {
  const f = fixture();
  t.after(() => f.runtime.shutdown());
  const entry = "file:///owned/index.html";
  const boundary = new WindowBoundary(
    entry,
    { name: "ssterm", version: "0.1.0", platform: "darwin" },
    () => ({ status: "ready", schemaVersion: 1 }),
    (owner) => f.runtime.revokeOwner(owner),
  );
  t.after(() => boundary.dispose());
  const sender = { id: 1, mainFrame: { url: entry }, isDestroyed: () => false };
  const revoke = boundary.register(sender, 1, true, () => {});
  const getOwner = () => {
    const r = boundary.bootstrap({ sender, senderFrame: sender.mainFrame }, []);
    assert.ok(r.ok);
    return sessionOwnerId(r.value.owner);
  };
  const oldOwner = getOwner();
  const otherOwner = sessionOwnerId({ windowId: 2, generation: 1 });
  assert.ok(f.runtime.registry.connect(oldOwner, f.hostId).ok);
  assert.ok(f.runtime.registry.connect(otherOwner, f.hostId).ok);
  await setImmediate();
  boundary.rotate(sender);
  assert.equal(f.contexts[0].signal.aborted, true);
  assert.equal(f.contexts[1].signal.aborted, false);
  assert.equal(f.runtime.registry.snapshot(otherOwner)[0].state, "Ready");
  await setImmediate();
  assert.deepEqual(
    f.runtime.registry.snapshot(oldOwner),
    [],
    "revoked windows release retained slots",
  );
  const newOwner = getOwner();
  assert.notEqual(newOwner, oldOwner);
  assert.ok(f.runtime.registry.connect(newOwner, f.hostId).ok);
  await setImmediate();
  revoke();
  assert.equal(f.contexts[2].signal.aborted, true);
  assert.equal(f.contexts[1].signal.aborted, false);
});

test("shutdown is idempotent and removes power listeners while fencing all owned sessions", async () => {
  const f = fixture();
  const owner = sessionOwnerId({ windowId: 1, generation: 1 });
  assert.ok(f.runtime.registry.connect(owner, f.hostId).ok);
  await setImmediate();
  assert.equal(f.power.listenerCount("lock-screen"), 1);
  assert.equal(f.power.listenerCount("suspend"), 1);
  const first = f.runtime.shutdown();
  const second = f.runtime.shutdown();
  assert.equal(first, second);
  assert.equal(f.contexts[0].signal.aborted, true);
  assert.equal(f.disposed(), 2);
  assert.equal(f.power.listenerCount("lock-screen"), 0);
  assert.equal(f.power.listenerCount("suspend"), 0);
  await first;
  assert.equal(f.runtime.registry.connect(owner, f.hostId).ok, false);
});

test("default desktop adapter fails closed until production trust/auth are implemented", async () => {
  const f = fixture();
  await f.runtime.shutdown();
  const transient = new TransientSecrets();
  const runtime = createDesktopSessions({
    resolve: () => ({ ok: true, value: f.config }),
    power: new EventEmitter(),
    transient,
  });
  try {
    assert.ok(runtime.registry.connect("window:1:1", f.hostId).ok);
    await setImmediate();
    assert.equal(runtime.registry.snapshot("window:1:1")[0].state, "Failed");
  } finally {
    await runtime.shutdown();
  }
});
