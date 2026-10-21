import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { IpcMain } from "electron";
import type { SyncClient } from "../../packages/services/src/sync.ts";
import {
  registerSyncHandlers,
  guardSyncCatalog,
} from "../../apps/desktop/src/main/sync.ts";
import {
  channels,
  failure,
  isSyncCommandRequest,
  isSyncReply,
  type SyncView,
} from "../../packages/contracts/src/index.ts";
import { createDesktopBridge } from "../../apps/desktop/src/preload/bridge.ts";
const owner = { windowId: 1, generation: 2 };
const state: SyncView = {
  status: "disabled",
  endpoint: null,
  scope: null,
  deviceId: null,
  role: null,
  generation: 0,
  epoch: 0,
  ownerFingerprint: null,
  canCancelSetup: false,
  needsToken: false,
  recoveryReady: false,
  outbox: 0,
  inbox: 0,
  conflicts: 0,
  devices: [],
  warnings: [],
};
function fixture(
  overrides: Record<string, unknown> = {},
  saveKit: () => Promise<boolean> = async () => false,
  canApply: () => boolean = () => true,
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let authorized = true,
    unlocks = 0,
    cancelled = 0;
  const kit = Buffer.from("owned encrypted kit");
  const client = {
    state: () => state,
    lifecycleEpoch: () => 0,
    unlock: () => {
      unlocks++;
    },
    lock: () => {},
    cancelRecovery: () => {
      cancelled++;
    },
    publish: async () => ({ ok: true, value: state }),
    createRecovery: async () => ({
      ok: true,
      value: { confirmationToken: "owned", secret: "a".repeat(43), kit },
    }),
    ...overrides,
  } as unknown as SyncClient;
  const ipc = {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      handlers.set(name, callback),
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as Pick<IpcMain, "handle" | "removeHandler">;
  const registered = registerSyncHandlers({
    ipc,
    boundary: {
      authorizeOwner: () =>
        authorized
          ? { ok: true as const, value: owner }
          : failure("unauthorized"),
    },
    client: () => client,
    canApply,
    saveKit,
    openKit: async () => undefined,
  });
  return {
    registered,
    handlers,
    kit,
    unlocks: () => unlocks,
    cancelled: () => cancelled,
    revoke: () => {
      authorized = false;
    },
    invoke: (request: unknown, ...extra: unknown[]) =>
      handlers.get(channels.syncCommand)!({}, request, ...extra),
  };
}
test("sync IPC rejects sender/shape before work and fences late replies", async () => {
  let finish!: () => void;
  const f = fixture({
    publish: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true, value: state };
    },
  });
  try {
    assert.deepEqual(
      await f.invoke({
        owner,
        action: { type: "publish", secret: "unexpected" },
      }),
      failure("invalid-request"),
    );
    assert.deepEqual(
      await f.invoke({ owner, action: { type: "publish" } }, "extra"),
      failure("invalid-request"),
    );
    assert.equal(f.unlocks(), 0);
    const pending = f.invoke({ owner, action: { type: "publish" } });
    f.revoke();
    finish();
    assert.deepEqual(await pending, failure("unauthorized"));
    assert.deepEqual(
      await f.invoke({ owner, action: { type: "publish" } }),
      failure("unauthorized"),
    );
  } finally {
    f.registered.dispose();
  }
});
test("cancelling native recovery save wipes output kit, cancels service draft, and never exposes secret", async () => {
  const f = fixture();
  try {
    const result = await f.invoke({
      owner,
      action: { type: "create-recovery" },
    });
    assert.ok(
      result && typeof result === "object" && "ok" in result && result.ok,
    );
    const reply = (result as unknown as { value: unknown }).value;
    assert.ok(isSyncReply(reply));
    assert.equal(reply.outcome, "cancelled");
    assert.equal(reply.detail.kind, "none");
    assert.equal(f.cancelled(), 1);
    assert.ok(f.kit.every((byte) => byte === 0));
    assert.ok(!JSON.stringify(result).includes("a".repeat(43)));
  } finally {
    f.registered.dispose();
  }
});
test("preload validates sync payloads and strict response shapes without exposing transport", async () => {
  let invocations = 0;
  const bridge = createDesktopBridge({
    invoke: async () => {
      invocations++;
      return { ok: true, value: { ...state, privateKey: "never" } };
    },
    on() {},
    removeListener() {},
  });
  assert.equal(
    isSyncCommandRequest({
      owner,
      action: { type: "logout", forgetTransportToken: true, extra: 1 },
    }),
    false,
  );
  assert.deepEqual(
    await bridge.api.syncState({ owner }),
    failure("unavailable"),
  );
  assert.equal(invocations, 1);
  assert.deepEqual(
    await bridge.api.syncCommand({
      owner,
      action: { type: "fetch", extra: 1 },
    } as never),
    failure("invalid-request"),
  );
  assert.equal(invocations, 1);
  bridge.dispose();
});

test("sync Apply preserves the existing active-tunnel catalog mutation guard before consuming review", async () => {
  let active = true,
    applies = 0;
  const f = fixture(
    {
      apply: async () => {
        applies++;
        return { ok: true, value: state };
      },
    },
    async () => false,
    () => !active,
  );
  try {
    const request = {
      owner,
      action: { type: "apply", reviewToken: "owned-review", resolutions: [] },
    };
    const blocked = (await f.invoke(request)) as {
      ok: boolean;
      value: { outcome: string; code: string };
    };
    assert.equal(blocked.ok, true);
    assert.equal(blocked.value.outcome, "failed");
    assert.equal(blocked.value.code, "active-tunnels");
    assert.equal(applies, 0);
    active = false;
    const allowed = (await f.invoke(request)) as {
      ok: boolean;
      value: { outcome: string };
    };
    assert.equal(allowed.ok, true);
    assert.equal(allowed.value.outcome, "ok");
    assert.equal(applies, 1);
  } finally {
    f.registered.dispose();
  }
});

test("sync catalog checks active resources again at the synchronous final commit", () => {
  let active = false,
    commits = 0;
  const repository = {
    commit: () => {
      commits++;
      return { ok: false, error: { code: "closed", message: "owned" } };
    },
    snapshot: () => ({
      ok: false,
      error: { code: "closed", message: "owned" },
    }),
    backup: async () => ({
      ok: false,
      error: { code: "closed", message: "owned" },
    }),
    close: () => {
      throw new Error("borrowed");
    },
  } as unknown as import("../../packages/domain/src/index.ts").MetadataRepository;
  const catalog = guardSyncCatalog(repository, () => !active);
  active = true;
  const blocked = catalog.commit({ expectedCatalogRevision: 1, changes: [] });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, "conflict");
  assert.equal(commits, 0);
  active = false;
  catalog.commit({ expectedCatalogRevision: 1, changes: [] });
  assert.equal(commits, 1);
  catalog.close();
});

test("workspace lock during native recovery save cannot return a late recovery secret to the same owner", async () => {
  let epoch = 0;
  let release!: () => void;
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture(
    {
      lifecycleEpoch: () => epoch,
      state: () => ({ ...state, status: epoch ? "locked" : "disabled" }),
    },
    async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    },
  );
  try {
    const pending = f.invoke({ owner, action: { type: "create-recovery" } });
    await saving;
    epoch++;
    release();
    const result = await pending;
    assert.ok(
      !JSON.stringify(result).includes("a".repeat(43)),
      "a same-owner workspace lock fences the late secret",
    );
    assert.ok(f.kit.every((byte) => byte === 0));
  } finally {
    f.registered.dispose();
  }
});

test("one window cannot queue additional mutations or native dialogs behind a pending recovery save", async () => {
  let release!: () => void, entered!: () => void;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({}, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return false;
  });
  try {
    const pending = f.invoke({ owner, action: { type: "create-recovery" } });
    await saving;
    assert.deepEqual(
      await f.invoke({ owner, action: { type: "publish" } }),
      failure("busy"),
    );
    release();
    await pending;
    const result = (await f.invoke({ owner, action: { type: "publish" } })) as {
      ok: boolean;
    };
    assert.equal(result.ok, true);
  } finally {
    release?.();
    f.registered.dispose();
  }
});
