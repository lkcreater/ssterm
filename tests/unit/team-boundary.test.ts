import assert from "node:assert/strict";
import { test } from "node:test";
import type { IpcMain } from "electron";
import type { TeamClient } from "../../packages/services/src/team.ts";
import { registerTeamHandlers } from "../../apps/desktop/src/main/team.ts";
import {
  channels,
  failure,
  isTeamCommandRequest,
  isTeamReply,
  isTeamView,
  type TeamView,
} from "../../packages/contracts/src/index.ts";
import { createDesktopBridge } from "../../apps/desktop/src/preload/bridge.ts";
const owner = { windowId: 1, generation: 2 };
const state: TeamView = {
  status: "disabled",
  endpoint: null,
  scope: null,
  principalId: null,
  deviceId: null,
  role: null,
  generation: 0,
  metadataEpoch: 0,
  credentialEpoch: 0,
  policyHash: null,
  metadataHash: null,
  credentialHash: null,
  ownerFingerprint: null,
  canManage: false,
  recoveryReady: false,
  needsToken: false,
  pending: 0,
  hosts: [],
  members: [],
  devices: [],
  warnings: [],
};
const recordId = "00000000-0000-4000-8000-000000000001",
  hash = "a".repeat(64),
  secret = "a".repeat(43),
  kit = "owned encrypted team kit";
function fixture(
  options: {
    overrides?: Record<string, unknown>;
    saveKit?: (current: () => boolean, bytes: Uint8Array) => Promise<boolean>;
    openKit?: (current: () => boolean) => Promise<Uint8Array | undefined>;
  } = {},
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let authorized = true,
    epoch = 0,
    unlocks = 0,
    cancelled = 0,
    recovers = 0;
  const client = {
    state: () => state,
    lifecycleEpoch: () => epoch,
    unlock: () => {
      unlocks++;
    },
    lock: () => {
      epoch++;
    },
    cancelRecovery: () => {
      cancelled++;
    },
    fetch: async () => ({ ok: true, value: state }),
    createRecovery: async () => ({
      ok: true,
      value: {
        confirmationToken: "owned-confirmation",
        secret,
        kit,
        expiresAt: Date.now() + 300000,
      },
    }),
    recover: async () => {
      recovers++;
      return { ok: true, value: state };
    },
    confirmRecovery: async () => ({ ok: true, value: state }),
    ...options.overrides,
  } as unknown as TeamClient;
  const ipc = {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      handlers.set(name, callback),
    removeHandler: (name: string) => handlers.delete(name),
  } as unknown as Pick<IpcMain, "handle" | "removeHandler">;
  const registered = registerTeamHandlers({
    ipc,
    boundary: {
      authorizeOwner: () =>
        authorized
          ? { ok: true as const, value: owner }
          : failure("unauthorized"),
    },
    client: () => client,
    saveKit: async (_owner, bytes, current) =>
      options.saveKit?.(current, bytes) ?? false,
    openKit: async (_owner, current) => options.openKit?.(current),
  });
  return {
    registered,
    handlers,
    unlocks: () => unlocks,
    cancelled: () => cancelled,
    recovers: () => recovers,
    lockUnlock: () => {
      epoch++;
      authorized = true;
    },
    revoke: () => {
      authorized = false;
    },
    invoke: (request: unknown, ...extra: unknown[]) =>
      handlers.get(channels.teamCommand)!({}, request, ...extra),
  };
}
test("Team IPC rejects sender and exact action schemas before any service work", async () => {
  const f = fixture();
  try {
    assert.deepEqual(
      await f.invoke({ owner, action: { type: "fetch", password: "never" } }),
      failure("invalid-request"),
    );
    assert.deepEqual(
      await f.invoke({ owner, action: { type: "fetch" } }, "extra"),
      failure("invalid-request"),
    );
    assert.equal(f.unlocks(), 0);
    f.revoke();
    assert.deepEqual(
      await f.invoke({ owner, action: { type: "fetch" } }),
      failure("unauthorized"),
    );
    assert.equal(f.unlocks(), 0);
    assert(
      !isTeamCommandRequest({
        owner,
        action: {
          type: "share-password",
          recordId,
          password: "plaintext",
          consent: true,
          expectedMetadataHash: hash,
          expectedCredentialHash: hash,
        },
      }),
    );
    assert(
      !isTeamCommandRequest({
        owner,
        action: {
          type: "change-role",
          principalId: recordId,
          role: "Owner",
          expectedPolicyHash: hash,
        },
      }),
    );
  } finally {
    f.registered.dispose();
  }
});
test("Team bridge has no credential readback and wipes its copied password bytes", async () => {
  let calls = 0,
    received: Uint8Array | undefined,
    release!: () => void;
  const bridge = createDesktopBridge({
    invoke: async (_channel, ...args) => {
      calls++;
      const request = args[0] as { action: { password: Uint8Array } };
      received = request.action.password;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ok: true,
        value: { state, outcome: "ok", code: null, detail: { kind: "none" } },
      };
    },
    on() {},
    removeListener() {},
  });
  const password = new TextEncoder().encode("owned-fixture-password");
  try {
    const pending = bridge.api.teamCommand({
      owner,
      action: {
        type: "share-password",
        recordId,
        password,
        consent: true,
        expectedMetadataHash: hash,
        expectedCredentialHash: hash,
      },
    });
    assert(received);
    assert.notEqual(received, password);
    assert.deepEqual(received, password);
    release();
    const result = await pending;
    assert(result.ok);
    assert(received.every((v) => v === 0));
    assert(password.some((v) => v !== 0));
    assert.equal(calls, 1);
    assert(!isTeamView({ ...state, password: "never" }));
    assert(
      !isTeamReply({
        state,
        outcome: "ok",
        code: null,
        detail: { kind: "none", password: "never" },
      }),
    );
  } finally {
    release?.();
    password.fill(0);
    bridge.dispose();
  }
});
test("Team bridge rejects forged response data instead of exposing passwords or keys", async () => {
  let calls = 0;
  const bridge = createDesktopBridge({
    invoke: async () => {
      calls++;
      return { ok: true, value: { ...state, credentialSnapshot: "never" } };
    },
    on() {},
    removeListener() {},
  });
  try {
    assert.deepEqual(
      await bridge.api.teamState({ owner }),
      failure("unavailable"),
    );
    assert.deepEqual(
      await bridge.api.teamCommand({
        owner,
        action: { type: "fetch", extra: 1 },
      } as never),
      failure("invalid-request"),
    );
    assert.equal(calls, 1);
  } finally {
    bridge.dispose();
  }
});
test("Team shared-password IPC wipes owned bytes after success and sanitized failure", async () => {
  let calls = 0;
  const f = fixture({
    overrides: {
      sharePassword: async (input: { password: string }) => {
        calls++;
        assert.equal(input.password, "owned");
        if (calls === 2) throw new Error("owned private exception");
        return { ok: true, value: state };
      },
    },
  });
  try {
    for (let i = 0; i < 2; i++) {
      const bytes = new TextEncoder().encode("owned");
      const result = await f.invoke({
        owner,
        action: {
          type: "share-password",
          recordId,
          password: bytes,
          consent: true,
          expectedMetadataHash: hash,
          expectedCredentialHash: hash,
        },
      });
      assert(bytes.every((v) => v === 0));
      assert(!JSON.stringify(result).includes("private exception"));
    }
    assert.equal(calls, 2);
  } finally {
    f.registered.dispose();
  }
});
test("cancelled Team native Save wipes bytes and returns no recovery secret", async () => {
  let output: Uint8Array | undefined;
  const f = fixture({
    saveKit: async (_current, bytes) => {
      output = bytes;
      assert.equal(new TextDecoder().decode(bytes), kit);
      return false;
    },
  });
  try {
    const response = (await f.invoke({
      owner,
      action: { type: "create-recovery" },
    })) as { ok: boolean; value: unknown };
    assert(response.ok);
    assert(isTeamReply(response.value));
    assert.equal(response.value.outcome, "cancelled");
    assert.equal(response.value.detail.kind, "none");
    assert.equal(f.cancelled(), 1);
    assert(output?.every((v) => v === 0));
    assert(!JSON.stringify(response).includes(secret));
  } finally {
    f.registered.dispose();
  }
});
test("same-owner lock and re-unlock fences native Save and overlapping mutation admission", async () => {
  let release!: () => void,
    entered!: () => void,
    output: Uint8Array | undefined,
    current!: () => boolean;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    saveKit: async (isCurrent, bytes) => {
      current = isCurrent;
      output = bytes;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    },
  });
  try {
    const pending = f.invoke({ owner, action: { type: "create-recovery" } });
    await saving;
    assert(current());
    assert.deepEqual(
      await f.invoke({ owner, action: { type: "fetch" } }),
      failure("busy"),
    );
    f.lockUnlock();
    assert(!current());
    release();
    const result = await pending;
    assert.deepEqual(result, failure("unauthorized"));
    assert(output?.every((v) => v === 0));
    assert(!JSON.stringify(result).includes(secret));
  } finally {
    release?.();
    f.registered.dispose();
  }
});
test("same-owner lock and re-unlock fences native Open and wipes returned bytes", async () => {
  let entered!: () => void, release!: () => void;
  const reading = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    bytes = new TextEncoder().encode(kit);
  const f = fixture({
    openKit: async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return bytes;
    },
  });
  const scope = {
    deploymentId: recordId,
    accountId: recordId,
    teamId: recordId,
    metadataVaultId: recordId,
    credentialVaultId: recordId,
  };
  try {
    const pending = f.invoke({
      owner,
      action: {
        type: "recover",
        endpoint: "https://owned.test",
        token: secret,
        principalId: recordId,
        expectedScope: scope,
        expectedOwnerFingerprint: hash,
        secret,
        consent: true,
      },
    });
    await reading;
    f.lockUnlock();
    release();
    assert.deepEqual(await pending, failure("unauthorized"));
    assert(bytes.every((v) => v === 0));
    assert.equal(f.recovers(), 0);
  } finally {
    release?.();
    f.registered.dispose();
  }
});
test("Team recovery secret cannot be exposed after service draft expires during native Save", async (context) => {
  let now = 1000;
  context.mock.method(Date, "now", () => now);
  const f = fixture({
    saveKit: async () => {
      now += 300001;
      return true;
    },
  });
  try {
    const result = await f.invoke({
      owner,
      action: { type: "create-recovery" },
    });
    assert(!JSON.stringify(result).includes(secret));
    assert(f.cancelled() > 0);
  } finally {
    f.registered.dispose();
  }
});
