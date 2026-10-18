import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createKnownHostsController } from "../../apps/desktop/src/main/known-hosts.ts";
import { sessionOwnerId } from "../../apps/desktop/src/main/session-runtime.ts";
import {
  SessionRegistry,
  TransientSecrets,
  type KnownHostPolicy,
  type SessionContext,
} from "../../packages/services/src/index.ts";
import {
  isTrustState,
  isKnownHostRevokePreview,
  isAnswerHostTrustRequest,
  HOST_KEY_ALGORITHMS as CONTRACT_ALGORITHMS,
  MAX_KNOWN_HOSTS,
  type TrustState,
  type KnownHostEntry,
} from "../../packages/contracts/src/index.ts";
import {
  HOST_KEY_ALGORITHMS,
  type ResolvedHostConfig,
} from "../../packages/domain/src/index.ts";

const owner = { windowId: 1, generation: 2 };
const other = { windowId: 2, generation: 3 };
const fingerprint = `SHA256:${"A".repeat(43)}`;
const trust = {
  kind: "host-trust",
  status: "unknown",
  endpointHost: "example.com",
  endpointPort: 22,
  algorithm: "ssh-ed25519",
  fingerprint,
} as const;
const config: ResolvedHostConfig = {
  hostRef: { id: "host-1", revision: 1, label: "เป้าหมาย lab", groupId: null },
  address: "example.com",
  environment: "PROD",
  port: { value: 22, source: { kind: "default" } },
  auth: {
    selection: "identity",
    source: { kind: "default" },
    key: null,
    identity: null,
  },
  ancestry: [],
  catalogRevision: 1,
};
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  const contexts: SessionContext[] = [];
  const registry = new SessionRegistry({
    resolve: () => ({ ok: true, value: config }),
    transient: new TransientSecrets(),
    adapter: {
      start(context) {
        contexts.push(context);
      },
    },
  });
  const observers = new Set<() => void>();
  const revokedOwners: string[] = [];
  const entries: KnownHostEntry[] = [];
  let unavailable = false;
  let revokeCode = "storage";
  const policy: Pick<
    KnownHostPolicy,
    "list" | "subscribe" | "prepareRevoke" | "revoke" | "revokeOwner"
  > = {
    list: () =>
      unavailable
        ? { ok: false, error: { code: "storage", message: "/private/hidden" } }
        : { ok: true, value: entries },
    subscribe: (callback) => {
      observers.add(callback);
      return () => {
        observers.delete(callback);
      };
    },
    prepareRevoke: () => ({
      ok: false,
      error: { code: "storage", message: "/private/must-not-escape" },
    }),
    revoke: () => ({
      ok: false,
      error: {
        code: revokeCode as "storage",
        message: "/private/must-not-escape",
      },
    }),
    revokeOwner: (id) => {
      revokedOwners.push(id);
    },
  };
  const controller = createKnownHostsController({ registry, policy });
  const events: TrustState[] = [];
  controller.register(owner, (state) => events.push(state));
  controller.register(other, () => {});
  return {
    registry,
    controller,
    contexts,
    events,
    observers,
    revokedOwners,
    entries,
    failStorage: () => {
      unavailable = true;
    },
    conflictRevoke: () => {
      revokeCode = "conflict";
    },
  };
}

test("controller projects actual owned trust prompts, rejects cross-owner/stale answers and disposes listeners", async () => {
  const f = fixture();
  try {
    const connected = f.registry.connect(sessionOwnerId(owner), "host-1");
    assert.ok(connected.ok);
    await tick();
    const context = f.contexts[0]!;
    assert.ok(context.verifyingHost());
    const answer = context.requestPrompt(trust);
    const state = f.controller.trustState(owner);
    assert.ok(state.ok);
    assert.equal(state.value.prompts.length, 1);
    const prompt = state.value.prompts[0]!;
    assert.equal(prompt.targetLabel, "เป้าหมาย lab");
    assert.equal(prompt.environment, "PROD");
    assert.equal(JSON.stringify(state).includes("username"), false);
    const request = {
      owner,
      sessionId: prompt.sessionId,
      generation: prompt.generation,
      promptId: prompt.promptId,
      decision: "remember" as const,
    };
    assert.equal(
      f.controller.answerHostTrust({ ...request, owner: other }).ok,
      false,
    );
    assert.equal(
      f.controller.answerHostTrust({
        ...request,
        generation: prompt.generation + 1,
      }).ok,
      false,
    );
    assert.equal(
      f.controller.answerHostTrust({ ...request, decision: "replace" }).ok,
      false,
    );
    assert.equal(f.controller.answerHostTrust(request).ok, true);
    assert.deepEqual(await answer, {
      kind: "host-trust",
      decision: "remember",
    });
    assert.equal(f.events.at(-1)!.prompts.length, 0);
    f.controller.revokeOwner(owner);
    assert.equal(f.controller.trustState(owner).ok, false);
    assert.equal(f.controller.answerHostTrust(request).ok, false);
    assert.ok(f.revokedOwners.includes(sessionOwnerId(owner)));
  } finally {
    f.controller.dispose();
    f.controller.dispose();
    assert.equal(f.observers.size, 0);
    await f.registry.dispose();
  }
});

test("credential prompts never project and persisted policy notifications refresh ordered projections", async () => {
  const f = fixture();
  try {
    f.registry.connect(sessionOwnerId(owner), "host-1");
    await tick();
    const context = f.contexts[0]!;
    context.verifyingHost();
    context.authenticating();
    void context
      .requestPrompt({
        kind: "credentials",
        fields: [{ id: "password", echo: false }],
      })
      .catch(() => {});
    const state = f.controller.trustState(owner);
    assert.ok(state.ok);
    assert.deepEqual(state.value.prompts, []);
    const now = "2026-10-15T00:00:00.000Z";
    f.entries.push({
      id: "known-1",
      revision: 1,
      endpointHost: "example.com",
      endpointPort: 22,
      algorithm: "ssh-ed25519",
      fingerprint,
      firstAcceptedAt: now,
      lastVerifiedAt: now,
    });
    for (const observer of f.observers) observer();
    assert.equal(f.events.at(-1)!.knownHosts.length, 1);
    for (let i = 1; i < f.events.length; i++)
      assert.ok(f.events[i]!.sequence > f.events[i - 1]!.sequence);
    assert.equal(
      f.controller.prepareKnownHostRevoke({
        owner,
        id: "known-1",
        expectedRevision: 1,
      }).ok,
      false,
    );
    const failed = f.controller.revokeKnownHost({
      owner,
      token: "owned-token",
    });
    assert.equal(JSON.stringify(failed).includes("/private"), false);
    assert.deepEqual(failed.ok ? null : failed.error.code, "unavailable");
    f.conflictRevoke();
    const changed = f.controller.revokeKnownHost({
      owner,
      token: "owned-token",
    });
    assert.deepEqual(changed.ok ? null : changed.error.code, "conflict");
  } finally {
    f.controller.dispose();
    await f.registry.dispose();
  }
});

test("trust contracts reject nested extra fields, secrets, malformed keys and unsupported decisions", () => {
  const base = {
    owner,
    sequence: 0,
    availability: "ready",
    knownHosts: [],
    truncated: false,
    prompts: [],
  };
  assert.ok(isTrustState(base));
  assert.deepEqual([...CONTRACT_ALGORITHMS], [...HOST_KEY_ALGORITHMS]);
  const prompt = {
    sessionId: "s",
    generation: 1,
    promptId: "p",
    targetLabel: "lab",
    environment: "PROD",
    jumpFor: null,
    ...trust,
  };
  const { kind: _kind, ...publicPrompt } = prompt;
  assert.ok(isTrustState({ ...base, prompts: [publicPrompt] }));
  for (const bad of [
    { ...base, owner: { ...owner, secret: "bad" } },
    { ...base, prompts: [{ ...publicPrompt, fields: [] }] },
    { ...base, prompts: [{ ...publicPrompt, fingerprint: "invalid" }] },
    { ...base, prompts: [{ ...publicPrompt, status: "changed" }] },
    { ...base, prompts: [{ ...publicPrompt, publicKey: "bad" }] },
    { ...base, prompts: [{ ...publicPrompt, endpointPort: 0 }] },
    { ...base, prompts: [{ ...publicPrompt, jumpFor: "" }] },
    { ...base, prompts: [{ ...publicPrompt, jumpFor: "bad\u0000" }] },
    { ...base, sequence: Infinity },
  ])
    assert.equal(isTrustState(bad), false);
  assert.equal(
    isKnownHostRevokePreview({
      token: "token",
      entry: {},
      expiresAt: "/private",
    }),
    false,
  );
  assert.equal(
    isAnswerHostTrustRequest({
      owner,
      sessionId: "s",
      generation: 1,
      promptId: "p",
      decision: "auto-accept",
    }),
    false,
  );
});

test("storage failure still publishes current prompt cancellation without exposing stale trust", async () => {
  const f = fixture();
  try {
    const connected = f.registry.connect(sessionOwnerId(owner), "host-1");
    assert.ok(connected.ok);
    await tick();
    const context = f.contexts[0]!;
    context.verifyingHost();
    void context.requestPrompt(trust).catch(() => {});
    assert.equal(f.events.at(-1)!.prompts.length, 1);
    f.failStorage();
    await f.registry.cancel(sessionOwnerId(owner), connected.value.id);
    const event = f.events.at(-1)!;
    assert.equal(event.availability, "unavailable");
    assert.deepEqual(event.prompts, []);
    assert.deepEqual(event.knownHosts, []);
    assert.ok(isTrustState(event));
    assert.equal(JSON.stringify(event).includes("/private"), false);
  } finally {
    f.controller.dispose();
    await f.registry.dispose();
  }
});

test("prompts stay deliverable when the known-host list exceeds one event", async () => {
  const f = fixture();
  try {
    const now = "2026-10-15T00:00:00.000Z";
    for (let index = 0; index <= MAX_KNOWN_HOSTS; index++)
      f.entries.push({
        id: `known-${index}`,
        revision: 1,
        endpointHost: `h${index}.example`,
        endpointPort: 22,
        algorithm: "ssh-ed25519",
        fingerprint,
        firstAcceptedAt: now,
        lastVerifiedAt: now,
      });
    const connected = f.registry.connect(sessionOwnerId(owner), "host-1");
    assert.ok(connected.ok);
    await tick();
    const context = f.contexts[0]!;
    context.verifyingHost();
    void context.requestPrompt(trust).catch(() => {});
    const event = f.events.at(-1)!;
    assert.ok(isTrustState(event));
    assert.equal(event.prompts.length, 1);
    assert.equal(event.truncated, true);
    assert.equal(event.knownHosts.length, MAX_KNOWN_HOSTS);
  } finally {
    f.controller.dispose();
    await f.registry.dispose();
  }
});
