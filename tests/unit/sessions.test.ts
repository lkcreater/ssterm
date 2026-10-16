import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import type {
  ResolvedHostConfig,
  StoreResult,
} from "../../packages/domain/src/index.ts";
import {
  SessionRegistry,
  TransientSecrets,
  type SessionContext,
  type SessionLimits,
  type SessionPromptAnswer,
  type SessionResult,
  type SessionScheduler,
  type SessionSnapshot,
} from "../../packages/services/src/index.ts";

const config = (revision = 1): ResolvedHostConfig => ({
  hostRef: { id: "host-1", revision, label: "Owned fixture", groupId: null },
  address: "127.0.0.1",
  environment: "PROD",
  port: { value: 2222, source: { kind: "default" } },
  auth: {
    selection: "identity",
    source: { kind: "default" },
    key: null,
    identity: {
      id: "identity-1",
      vaultId: "vault-1",
      revision: 1,
      createdAt: "fixture",
      updatedAt: "fixture",
      label: "fixture identity",
      username: "fixture",
      method: "password",
      passwordRef: "OPAQUE-NEVER-EMIT",
      keyId: null,
    },
  },
  ancestry: [],
  catalogRevision: revision,
});

test("ignored invalid and stale prompt callbacks cannot terminate the main process", () => {
  const child = spawnSync(
    process.execPath,
    ["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      input: `
      import { SessionRegistry, TransientSecrets } from './packages/services/src/index.ts';
      import { setImmediate } from 'node:timers/promises';
      let context;
      const registry = new SessionRegistry({
        resolve: () => ({ ok: true, value: ${JSON.stringify(config())} }),
        transient: new TransientSecrets(),
        adapter: { start(value) { context = value; } },
      });
      const opened = registry.connect('owner', 'host-1');
      await setImmediate();
      const prompt = { kind: 'credentials', fields: [{ id: 'password', echo: false }] };
      void context.requestPrompt(prompt);
      context.verifyingHost();
      context.authenticating();
      void context.requestPrompt({ ...prompt, unknown: true });
      await registry.close('owner', opened.value.id);
      void context.requestPrompt(prompt);
      await setImmediate();
      await registry.dispose();
    `,
    },
  );
  assert.equal(
    child.status,
    0,
    "ignored prompt rejections must remain handled under strict Node rejection policy",
  );
});
const value = <T>(result: SessionResult<T>): T => {
  if (!result.ok) assert.fail(result.error.message);
  return result.value;
};
const tick = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Clock implements SessionScheduler {
  now = 0;
  next = 0;
  jobs = new Map<number, { at: number; run(): void }>();
  set(run: () => void, delay: number) {
    const id = ++this.next;
    this.jobs.set(id, { at: this.now + delay, run });
    return id;
  }
  clear(id: unknown) {
    this.jobs.delete(id as number);
  }
  advance(ms: number) {
    this.now += ms;
    for (const [id, job] of [...this.jobs])
      if (job.at <= this.now) {
        this.jobs.delete(id);
        job.run();
      }
  }
}
function harness(
  options: {
    resolve?: (
      host: string,
    ) =>
      | StoreResult<ResolvedHostConfig>
      | Promise<StoreResult<ResolvedHostConfig>>;
    limits?: Partial<SessionLimits>;
    start?: (context: SessionContext) => void | Promise<void>;
  } = {},
) {
  const contexts: SessionContext[] = [];
  const transient = new TransientSecrets();
  const clock = new Clock();
  const registry = new SessionRegistry({
    resolve: options.resolve ?? (() => ({ ok: true, value: config() })),
    adapter: {
      start(context) {
        contexts.push(context);
        return options.start?.(context);
      },
    },
    transient,
    scheduler: clock,
    limits: options.limits,
  });
  const connect = (owner = "owner-1") =>
    value(registry.connect(owner, "host-1"));
  return { registry, transient, clock, contexts, connect };
}
const credential = {
  kind: "credentials",
  fields: [{ id: "password", echo: false }],
} as const;
const trust = {
  kind: "host-trust",
  status: "unknown",
  endpointHost: "example.com",
  endpointPort: 22,
  algorithm: "ssh-ed25519",
  fingerprint: `SHA256:${"A".repeat(43)}`,
} as const;

test("session configuration is a frozen copy and events project only permitted metadata", async () => {
  const source = config();
  const h = harness({ resolve: () => ({ ok: true, value: source }) });
  const events: SessionSnapshot[] = [];
  h.registry.subscribe("owner-1", (event) => {
    events.push(event);
    if (event.target) event.target.label = "mutated observer";
  });
  h.registry.subscribe("owner-1", () => {
    throw new Error("observer secret must never escape");
  });
  const session = h.connect();
  await tick();
  const context = h.contexts[0]!;
  source.auth.identity = {
    ...source.auth.identity!,
    passwordRef: "changed-source",
  };
  source.hostRef.label = "changed-source";
  assert.equal(context.config.auth.identity!.passwordRef, "OPAQUE-NEVER-EMIT");
  assert(Object.isFrozen(context.config.auth.identity));
  assert.equal(
    h.registry.snapshot("owner-1")[0]!.target!.label,
    "Owned fixture",
  );
  assert(!JSON.stringify(events).includes("OPAQUE-NEVER-EMIT"));
  assert(!JSON.stringify(events).includes("passwordRef"));
  assert.deepEqual(h.registry.snapshot("other", session.id), []);
  await h.registry.dispose();
});

test("cancel while configuration resolves never starts the adapter", async () => {
  const pending = deferred<StoreResult<ResolvedHostConfig>>();
  const h = harness({ resolve: () => pending.promise });
  const session = h.connect();
  await tick();
  const closing = h.registry.cancel("owner-1", session.id);
  assert.equal(h.registry.snapshot("owner-1")[0]!.state, "Closing");
  pending.resolve({ ok: true, value: config() });
  await closing;
  await tick();
  assert.equal(h.contexts.length, 0);
  assert.equal(h.registry.snapshot("owner-1")[0]!.state, "Closed");
  await h.registry.dispose();
});

for (const phase of [
  "Connecting",
  "VerifyingHost",
  "Authenticating",
  "AwaitingInput",
  "Ready",
] as const) {
  test(`cancellation fences ${phase}, rejects late transitions, and disposes resources once`, async () => {
    const h = harness();
    const session = h.connect();
    await tick();
    const context = h.contexts[0]!;
    let disposals = 0;
    const transport = {
      dispose() {
        disposals++;
      },
    };
    assert(context.own(transport));
    assert(context.own(transport));
    if (phase !== "Connecting") assert(context.verifyingHost());
    if (
      phase === "Authenticating" ||
      phase === "AwaitingInput" ||
      phase === "Ready"
    )
      assert(context.authenticating());
    const prompt =
      phase === "AwaitingInput" ? context.requestPrompt(credential) : undefined;
    if (phase === "Ready")
      assert(
        context.ready({
          dispose() {
            disposals++;
          },
        }),
      );
    assert.equal(h.registry.snapshot("owner-1")[0]!.state, phase);
    const closing = h.registry.cancel("owner-1", session.id);
    assert(context.signal.aborted);
    assert.equal(disposals, phase === "Ready" ? 2 : 1);
    assert(!context.authenticating());
    assert(!context.verifyingHost());
    let lateDisposed = 0;
    const late = {
      dispose() {
        lateDisposed++;
      },
    };
    assert(!context.ready(late));
    assert(!context.own(late));
    assert.equal(lateDisposed, 1);
    if (prompt) await assert.rejects(prompt, /cancelled/u);
    await closing;
    await h.registry.close("owner-1", session.id);
    assert.equal(disposals, phase === "Ready" ? 2 : 1);
    await h.registry.dispose();
  });
}

test("Ready requires host verification, authentication and adoption of an interactive resource", async () => {
  const h = harness();
  const session = h.connect();
  await tick();
  const context = h.contexts[0]!;
  let rejected = 0;
  assert(!context.authenticating());
  assert(
    !context.ready({
      dispose() {
        rejected++;
      },
    }),
  );
  assert.equal(rejected, 1);
  assert(context.verifyingHost());
  assert(!context.verifyingHost());
  const answer = context.requestPrompt(trust);
  const prompt = h.registry.snapshot("owner-1")[0]!.prompt!;
  assert.equal(h.registry.snapshot("owner-1")[0]!.state, "VerifyingHost");
  assert(!context.authenticating());
  value(
    h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, {
      kind: "host-trust",
      decision: "accept-once",
    }),
  );
  assert.deepEqual(await answer, {
    kind: "host-trust",
    decision: "accept-once",
  });
  assert(context.authenticating());
  assert(context.ready({ dispose() {} }));
  assert.equal(h.registry.snapshot("owner-1")[0]!.state, "Ready");
  assert(
    !context.ready({
      dispose() {
        rejected++;
      },
    }),
  );
  assert.equal(rejected, 2);
  await h.registry.dispose();
});

test("changed host-key prompts allow only replacement or rejection and rejection blocks authentication", async () => {
  for (const decision of ["replace", "reject"] as const) {
    const h = harness(); const session = h.connect(); await tick();
    const context = h.contexts[0]!;
    assert(context.verifyingHost());
    const changed = { ...trust, status: "changed", previousAlgorithm: "ssh-rsa", previousFingerprint: `SHA256:${"B".repeat(43)}` } as const;
    const pending = context.requestPrompt(changed);
    const prompt = h.registry.snapshot("owner-1")[0]!.prompt!;
    for (const forbidden of ["accept-once", "remember"] as const) {
      assert.equal(h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, { kind: "host-trust", decision: forbidden }).ok, false);
      assert.equal(h.registry.snapshot("owner-1")[0]!.prompt!.id, prompt.id);
      assert(!context.authenticating());
    }
    value(h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, { kind: "host-trust", decision }));
    assert.deepEqual(await pending, { kind: "host-trust", decision });
    assert.equal(context.authenticating(), decision === "replace");
    if (decision === "reject") assert.equal(h.registry.snapshot("owner-1")[0]!.error!.code, "host-key-changed");
    await h.registry.dispose();
  }
});

test("unknown host-key prompts reject replacement and malformed changed identity", async () => {
  const h = harness(); const session = h.connect(); await tick();
  const context = h.contexts[0]!; assert(context.verifyingHost());
  await assert.rejects(context.requestPrompt({ ...trust, status: "changed" } as never));
  const pending = context.requestPrompt(trust);
  const prompt = h.registry.snapshot("owner-1")[0]!.prompt!;
  assert.equal(h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, { kind: "host-trust", decision: "replace" }).ok, false);
  value(h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, { kind: "host-trust", decision: "accept-once" }));
  await pending; await h.registry.dispose();
});

test("prompt answers enforce ownership, generation, id, uniqueness and bounded finite fields", async () => {
  const h = harness();
  const session = h.connect();
  await tick();
  const context = h.contexts[0]!;
  context.verifyingHost();
  context.authenticating();
  const answerPromise = context.requestPrompt(credential);
  const prompt = h.registry.snapshot("owner-1")[0]!.prompt!;
  const input = {
    kind: "credentials",
    values: [{ id: "password", value: Buffer.from("fixture-credential") }],
  } as const;
  assert(!h.registry.answerPrompt("other", session.id, 1, prompt.id, input).ok);
  assert(
    !h.registry.answerPrompt("owner-1", session.id, 2, prompt.id, input).ok,
  );
  assert(!h.registry.answerPrompt("owner-1", session.id, 1, "wrong", input).ok);
  assert(
    !h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, {
      kind: "credentials",
      values: [],
    }).ok,
  );
  await assert.rejects(context.requestPrompt(credential), /required state/u);
  value(h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, input));
  assert(
    !h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, input).ok,
  );
  const answer = await answerPromise;
  assert.equal(answer.kind, "credentials");
  assert.equal(h.transient.size, 1);
  if (answer.kind !== "credentials") assert.fail();
  let view!: Uint8Array;
  const text = answer.use((values) => {
    view = values.password!;
    return Buffer.from(view).toString();
  });
  assert.equal(text, "fixture-credential");
  assert(view.every((byte) => byte === 0));
  assert.equal(h.transient.size, 0);
  assert.equal(input.values[0].value.toString(), "fixture-credential");
  assert.throws(() => answer.use(() => {}), /cancelled/u);
  await assert.rejects(
    context.requestPrompt({
      kind: "credentials",
      fields: [
        { id: "password", echo: false },
        { id: "password", echo: true },
      ],
    }),
    /invalid/u,
  );
  await assert.rejects(
    context.requestPrompt({ ...trust, fingerprint: "secret-server-message" }),
    /invalid/u,
  );
  await h.registry.dispose();
});

test("credential callbacks dispose even when consumer throws, and lock purges unconsumed answers", async () => {
  const h = harness();
  const session = h.connect();
  await tick();
  const context = h.contexts[0]!;
  context.verifyingHost();
  context.authenticating();
  const ask = async (): Promise<SessionPromptAnswer> => {
    const pending = context.requestPrompt(credential);
    const prompt = h.registry.snapshot("owner-1")[0]!.prompt!;
    value(
      h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, {
        kind: "credentials",
        values: [{ id: "password", value: Buffer.from("owned-fixture") }],
      }),
    );
    return pending;
  };
  const first = await ask();
  if (first.kind !== "credentials") assert.fail();
  assert.throws(
    () =>
      first.use(() => {
        throw new Error("consumer");
      }),
    /consumer/u,
  );
  assert.equal(h.transient.size, 0);
  const second = await ask();
  assert.equal(h.transient.size, 1);
  const locked = h.registry.lock();
  assert.equal(h.transient.size, 0);
  if (second.kind !== "credentials") assert.fail();
  assert.throws(() => second.use(() => {}), /cancelled/u);
  await locked;
  await h.registry.dispose();
});

test("an explicit trust rejection fences authentication even if an adapter attempts to continue", async () => {
  const h = harness();
  const session = h.connect();
  await tick();
  const context = h.contexts[0]!;
  context.verifyingHost();
  const pending = context.requestPrompt(trust);
  const prompt = h.registry.snapshot("owner-1")[0]!.prompt!;
  value(
    h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, {
      kind: "host-trust",
      decision: "reject",
    }),
  );
  assert.deepEqual(await pending, { kind: "host-trust", decision: "reject" });
  assert(!context.authenticating());
  assert(context.signal.aborted);
  assert.equal(
    h.registry.snapshot("owner-1")[0]!.error!.code,
    "host-key-untrusted",
  );
  await h.registry.dispose();
});

test("prompt timeout rejects adapter wait, clears resources and sanitizes error", async () => {
  const h = harness({ limits: { promptMs: 10 } });
  h.connect();
  await tick();
  const context = h.contexts[0]!;
  context.verifyingHost();
  context.authenticating();
  const pending = context.requestPrompt(credential);
  h.clock.advance(10);
  await assert.rejects(pending, /cancelled/u);
  await tick();
  const snapshot = h.registry.snapshot("owner-1")[0]!;
  assert.equal(snapshot.state, "Failed");
  assert.equal(snapshot.error!.code, "timeout");
  assert(!snapshot.prompt);
  await h.registry.dispose();
});

test("connection timeout and sync/async adapter or resolver errors are finite and secret free", async () => {
  for (const start of [
    () => {
      throw new Error("PRIVATE-ERROR");
    },
    async () => {
      throw new Error("PRIVATE-ERROR");
    },
  ]) {
    const h = harness({ start });
    h.connect();
    await tick();
    const snapshot = h.registry.snapshot("owner-1")[0]!;
    assert.equal(snapshot.state, "Failed");
    assert.equal(snapshot.error!.code, "subsystem-unavailable");
    assert(!JSON.stringify(snapshot).includes("PRIVATE-ERROR"));
    await h.registry.dispose();
  }
  const h = harness({ limits: { connectMs: 10 } });
  h.connect();
  await tick();
  h.clock.advance(10);
  await tick();
  assert.equal(h.registry.snapshot("owner-1")[0]!.error!.code, "timeout");
  await h.registry.dispose();
  const broken = harness({
    resolve: () => {
      throw new Error("SECRET-CONFIG");
    },
  });
  broken.connect();
  await tick();
  assert(
    !JSON.stringify(broken.registry.snapshot("owner-1")).includes(
      "SECRET-CONFIG",
    ),
  );
  await broken.registry.dispose();
});

test("manual reconnect captures fresh config, rejects stale generation callbacks and never replays input", async () => {
  let revision = 1;
  const h = harness({ resolve: () => ({ ok: true, value: config(revision) }) });
  const session = h.connect();
  await tick();
  const old = h.contexts[0]!;
  old.failed("network");
  await tick();
  revision = 2;
  const reconnected = value(h.registry.reconnect("owner-1", session.id));
  assert.equal(reconnected.generation, 2);
  await tick();
  const fresh = h.contexts[1]!;
  assert.equal(fresh.config.catalogRevision, 2);
  assert.equal(old.config.catalogRevision, 1);
  old.failed("auth-denied");
  old.ended();
  assert(!old.verifyingHost());
  assert.equal(h.registry.snapshot("owner-1")[0]!.state, "Connecting");
  assert(
    !h.registry.answerPrompt("owner-1", session.id, 1, "old-prompt", {
      kind: "host-trust",
      decision: "accept-once",
    }).ok,
  );
  assert(!h.registry.reconnect("other", session.id).ok);
  assert(!h.registry.reconnect("owner-1", session.id).ok);
  await h.registry.dispose();
});

test("resource identity has one owner and caps do not destroy another generation resources", async () => {
  const h = harness({ limits: { resources: 1 } });
  const first = h.connect();
  h.connect("owner-2");
  await tick();
  const one = h.contexts[0]!,
    two = h.contexts[1]!;
  let ownedDisposed = 0;
  const owned = {
    dispose() {
      ownedDisposed++;
    },
  };
  assert(one.own(owned));
  assert(one.own(owned));
  assert(!two.own(owned));
  assert.equal(ownedDisposed, 0);
  let excessDisposed = 0;
  assert(
    !one.own({
      dispose() {
        excessDisposed++;
      },
    }),
  );
  assert.equal(excessDisposed, 1);
  assert.equal(ownedDisposed, 1);
  await tick();
  assert.equal(
    h.registry.snapshot("owner-1")[0]!.error!.code,
    "resource-limit",
  );
  await h.registry.close("owner-1", first.id);
  assert.equal(h.registry.snapshot("owner-1")[0]!.state, "Closed");
  await h.registry.dispose();
  assert.equal(ownedDisposed, 1);
});

test("teardown destroys synchronously before waiting, bounds drain, and handles thrown/rejected destructors", async () => {
  const h = harness({ limits: { drainMs: 10 } });
  const session = h.connect();
  await tick();
  const context = h.contexts[0]!;
  let disposed = false;
  context.own({
    dispose() {
      disposed = true;
    },
    drained: new Promise(() => {}),
  });
  const closing = h.registry.close("owner-1", session.id);
  assert(disposed);
  assert(!h.registry.forget("owner-1", session.id).ok);
  assert(!h.registry.reconnect("owner-1", session.id).ok);
  h.clock.advance(10);
  await closing;
  assert.equal(h.registry.snapshot("owner-1")[0]!.cleanup, "timeout");
  value(h.registry.forget("owner-1", session.id));
  assert.deepEqual(h.registry.snapshot("owner-1"), []);
  for (const dispose of [
    () => {
      throw new Error("private cleanup failure");
    },
    () => Promise.reject(new Error("private async cleanup failure")),
  ]) {
    const next = h.connect();
    await tick();
    h.contexts.at(-1)!.own({ dispose });
    await h.registry.close("owner-1", next.id);
    const snapshot = h.registry.snapshot("owner-1", next.id)[0]!;
    assert.equal(snapshot.state, "Closed");
    assert.equal(snapshot.cleanup, "failed");
    assert(!JSON.stringify(snapshot).includes("private"));
  }
  await h.registry.dispose();
});

test("lock fences all sessions before reentrant cleanup and a late unlock cannot undo a newer lock", async () => {
  const h = harness();
  h.connect();
  h.connect("owner-2");
  await tick();
  const [first, second] = h.contexts;
  const observed: boolean[] = [];
  first!.own({
    dispose() {
      observed.push(second!.verifyingHost());
      observed.push(h.registry.connect("reentrant", "host-1").ok);
    },
  });
  const access = deferred<boolean>();
  const unlock = h.registry.unlock(() => access.promise);
  const locked = h.registry.lock();
  assert.deepEqual(observed, [false, false]);
  access.resolve(true);
  assert.equal(await unlock, false);
  await locked;
  assert(!h.registry.connect("owner-1", "host-1").ok);
  assert.equal(await h.registry.unlock(async () => false), false);
  assert.equal(await h.registry.unlock(async () => true), true);
  assert(h.registry.connect("owner-1", "host-1").ok);
  await h.registry.dispose();
  assert.equal(await h.registry.unlock(async () => true), false);
  assert(!h.registry.connect("owner-1", "host-1").ok);
});

test("owner cleanup and bounded retained records support explicit forgetting", async () => {
  const h = harness({ limits: { sessions: 1 } });
  const session = h.connect();
  await tick();
  assert(!h.registry.connect("owner-2", "host-1").ok);
  let events = 0;
  h.registry.subscribe("owner-1", () => {
    events++;
  });
  await h.registry.closeOwner("owner-1");
  assert.equal(events, 0);
  assert.equal(h.registry.snapshot("owner-1")[0]!.state, "Closed");
  assert(!h.registry.forget("other", session.id).ok);
  value(h.registry.forget("owner-1", session.id));
  assert(h.registry.connect("owner-2", "host-1").ok);
  await h.registry.dispose();
  await h.registry.dispose();
});

test("phase callbacks report cancellation from a reentrant observer before adapter continues", async () => {
  const h = harness();
  const session = h.connect();
  await tick();
  const context = h.contexts[0]!;
  h.registry.subscribe("owner-1", (snapshot) => {
    if (snapshot.state === "VerifyingHost")
      void h.registry.close("owner-1", session.id);
  });
  assert.equal(context.verifyingHost(), false);
  assert(context.signal.aborted);
  assert(!context.authenticating());
  await h.registry.dispose();
  const other = harness();
  const next = other.connect();
  await tick();
  const fresh = other.contexts[0]!;
  fresh.verifyingHost();
  fresh.authenticating();
  let disposed = 0;
  other.registry.subscribe("owner-1", (snapshot) => {
    if (snapshot.state === "Ready")
      void other.registry.close("owner-1", next.id);
  });
  assert.equal(
    fresh.ready({
      dispose() {
        disposed++;
      },
    }),
    false,
  );
  assert.equal(disposed, 1);
  await other.registry.dispose();
});

test("closing or locking a failed session after cleanup publishes Closed once", async () => {
  for (const action of ["close", "lock"] as const) {
    const h = harness();
    const session = h.connect();
    await tick();
    h.contexts[0]!.failed("auth-denied");
    await tick();
    assert.equal(h.registry.snapshot("owner-1")[0]!.cleanup, "complete");
    const states: string[] = [];
    h.registry.subscribe("owner-1", (snapshot) => {
      states.push(snapshot.state);
      if (snapshot.state === "Closed")
        void h.registry.close("owner-1", session.id);
    });
    if (action === "close") await h.registry.close("owner-1", session.id);
    else await h.registry.lock();
    assert.deepEqual(states, ["Closed"]);
    await h.registry.close("owner-1", session.id);
    assert.deepEqual(states, ["Closed"]);
    await h.registry.dispose();
  }
});

test("credential prompt cancellation is atomic and bound to owner, generation and the current credential prompt", async () => {
  const h = harness(); const session = h.connect(); await tick();
  const context = h.contexts[0]!; context.verifyingHost();
  const hostPending = context.requestPrompt(trust);
  const host = h.registry.snapshot("owner-1")[0]!.prompt!;
  assert(!h.registry.cancelPrompt("owner-1", session.id, 1, host.id).ok);
  value(h.registry.answerPrompt("owner-1", session.id, 1, host.id, { kind: "host-trust", decision: "accept-once" }));
  await hostPending; context.authenticating();
  const firstPending = context.requestPrompt({ ...credential, purpose: "password", attempt: 1 });
  const first = h.registry.snapshot("owner-1")[0]!.prompt!;
  assert(!h.registry.cancelPrompt("other", session.id, 1, first.id).ok);
  assert(!h.registry.cancelPrompt("owner-1", session.id, 2, first.id).ok);
  assert(!h.registry.cancelPrompt("owner-1", session.id, 1, "stale").ok);
  value(h.registry.answerPrompt("owner-1", session.id, 1, first.id, { kind: "credentials", values: [{ id: "password", value: Buffer.from("owned-fixture") }] }));
  const firstAnswer = await firstPending; assert(firstAnswer.kind === "credentials"); firstAnswer.use(() => {});
  const secondPending = context.requestPrompt({ ...credential, purpose: "password", attempt: 2 });
  const second = h.registry.snapshot("owner-1")[0]!.prompt!;
  assert(!h.registry.cancelPrompt("owner-1", session.id, 1, first.id).ok);
  assert.equal(h.registry.snapshot("owner-1")[0]!.state, "AwaitingInput");
  value(h.registry.cancelPrompt("owner-1", session.id, 1, second.id));
  assert.equal(context.signal.aborted, true);
  await assert.rejects(secondPending, /cancelled/u);
  await tick();
  const closed = h.registry.snapshot("owner-1")[0]!;
  assert.equal(closed.state, "Failed"); assert.equal(closed.error?.code, "prompt-cancelled");
  assert.equal(closed.prompt, undefined); assert.equal(h.transient.size, 0);
  assert(!h.registry.cancelPrompt("owner-1", session.id, 1, second.id).ok);
  await h.registry.dispose();
});

test("credential prompt metadata and answer sizes are bounded without advancing a rejected prompt", async () => {
  const h = harness(); const session = h.connect(); await tick();
  const context = h.contexts[0]!; context.verifyingHost(); context.authenticating();
  for (const invalid of [{ ...credential, attempt: 4 }, { ...credential, purpose: "untrusted-server-label" }])
    await assert.rejects(context.requestPrompt(invalid as never), /invalid/u);
  const fields = (["response-1", "response-2", "response-3", "response-4", "response-5"] as const).map((id) => ({ id, echo: false }));
  const pending = context.requestPrompt({ kind: "credentials", purpose: "keyboard-interactive", attempt: 3, fields });
  const prompt = h.registry.snapshot("owner-1")[0]!.prompt!;
  assert.equal(prompt.kind === "credentials" && prompt.attempt, 3);
  for (const size of [16_385, 16_384]) {
    const values = fields.map(({ id }) => ({ id, value: Buffer.alloc(size) }));
    assert(!h.registry.answerPrompt("owner-1", session.id, 1, prompt.id, { kind: "credentials", values }).ok);
    assert.equal(h.registry.snapshot("owner-1")[0]!.prompt!.id, prompt.id);
  }
  value(h.registry.cancelPrompt("owner-1", session.id, 1, prompt.id));
  await assert.rejects(pending, /cancelled/u);
  await h.registry.dispose();
});
