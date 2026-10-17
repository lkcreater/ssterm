"use strict";

// Test-only Adapter: generated credentials stay in the test process/main isolate.
// Neither this file nor the isolated spike is included in the desktop package.
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");
const { connect } = require("../../../spikes/ssh-compat/src/connection.cjs");

function state(registry, owner, id, expected) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("SESSION_FIXTURE_DEADLINE"));
    }, 15_000);
    const inspect = () => {
      const snapshot = registry.snapshot(owner, id)[0];
      if (
        !snapshot ||
        (snapshot.state !== expected && snapshot.state !== "Failed")
      )
        return;
      clearTimeout(timer);
      unsubscribe();
      if (snapshot.state === expected) resolve(snapshot);
      else reject(new Error("SESSION_FIXTURE_CONNECTION_FAILED"));
    };
    unsubscribe = registry.subscribe(owner, inspect);
    inspect();
  });
}

async function runSessionSmoke({ SessionRegistry, TransientSecrets }) {
  let fixture, registry;
  const transient = new TransientSecrets();
  const contexts = [],
    transports = [],
    channels = [];
  const owner = "owned-ssh-fixture";
  let trustPrompts = 0,
    disposedControllers = 0;
  let result,
    failed = false;
  try {
    fixture = await startFixture();
    const hostId = randomUUID();
    const config = {
      hostRef: {
        id: hostId,
        revision: 1,
        label: "Owned SSH fixture",
        groupId: null,
      },
      address: fixture.host,
      environment: null,
      port: { value: fixture.port, source: { kind: "default" } },
      auth: {
        selection: "none",
        identity: null,
        key: null,
        source: { kind: "default" },
      },
      ancestry: [],
      catalogRevision: 1,
    };
    registry = new SessionRegistry({
      resolve: () => ({ ok: true, value: config }),
      transient,
      limits: { connectMs: 15_000 },
      adapter: {
        async start(context) {
          contexts.push(context);
          const abort = new AbortController();
          let transport, finish;
          const drained = new Promise((resolve) => {
            finish = resolve;
          });
          // Claim revocation before the first asynchronous engine call.
          if (
            !context.own({
              dispose() {
                disposedControllers += 1;
                abort.abort();
                transport?.client.destroy();
              },
              drained,
            })
          ) {
            finish();
            return;
          }
          if (!context.verifyingHost()) {
            finish();
            return;
          }
          try {
            transport = await connect(fixture, {
              signal: abort.signal,
              onUnknown: async (info) => {
                const answer = await context.requestPrompt({
                  kind: "host-trust",
                  status: "unknown",
                  endpointHost: fixture.host,
                  endpointPort: fixture.port,
                  algorithm: info.algorithm,
                  fingerprint: info.fingerprint,
                });
                if (
                  answer.kind !== "host-trust" ||
                  answer.decision !== "accept-once" ||
                  !context.authenticating()
                )
                  return "reject";
                return answer.decision;
              },
            });
            transports.push(transport);
            void transport.closed.then(finish, finish);
            if (
              !context.own({
                dispose: () => transport.client.destroy(),
                drained: transport.closed,
              })
            )
              return;
            const shell = await transport.shell();
            channels.push(shell);
            let closed;
            const channelDrained = new Promise((resolve) => {
              closed = resolve;
            });
            shell.once("close", closed);
            // Drain the fixture's banner/prompt without retaining terminal bytes.
            shell.on("data", () => {});
            shell.stderr.on("data", () => {});
            shell.once("close", () => context.ended());
            // Lifecycle-only terminal: these smokes never open the byte stream.
            context.ready({
              dispose: () => shell.destroy(),
              drained: channelDrained,
              open: () => false,
              ack() {},
              write: () => "closed",
              resize() {},
            });
          } catch {
            if (!context.signal.aborted) context.failed("network");
            if (!transport) finish();
          }
        },
      },
    });
    const snapshots = [];
    registry.subscribe(owner, (snapshot) => {
      snapshots.push(snapshot);
      if (snapshot.prompt?.kind === "host-trust") {
        trustPrompts += 1;
        assert.equal(
          registry.answerPrompt(
            owner,
            snapshot.id,
            snapshot.generation,
            snapshot.prompt.id,
            { kind: "host-trust", decision: "accept-once" },
          ).ok,
          true,
        );
      }
    });
    const opened = registry.connect(owner, hostId);
    assert.equal(opened.ok, true);
    const id = opened.value.id;
    await state(registry, owner, id, "Ready");
    assert.equal(transports[0].details.authenticationStarted, true);
    const close = await registry.close(owner, id);
    assert.equal(close.ok, true);
    assert.equal(registry.snapshot(owner, id)[0].cleanup, "complete");
    assert.equal(contexts[0].signal.aborted, true);
    const repeated = await registry.close(owner, id);
    assert.equal(repeated.ok, true);

    assert.equal(registry.reconnect(owner, id).ok, true);
    await state(registry, owner, id, "Ready");
    assert.ok(contexts[1].generation > contexts[0].generation);
    assert.notEqual(transports[1], transports[0]);
    await registry.cancel(owner, id);
    assert.equal(registry.snapshot(owner, id)[0].cleanup, "complete");
    assert.equal(disposedControllers, 2);
    assert.equal(trustPrompts, 2);
    const serialized = JSON.stringify(snapshots);
    assert.equal(serialized.includes(fixture.password), false);
    assert.equal(serialized.includes(fixture.passphrase), false);
    assert.equal(serialized.includes("PRIVATE KEY"), false);
    result = {
      interactiveReady: true,
      explicitFixtureTrust: true,
      closeAndCancelComplete: true,
      reconnectNewTransport: true,
      noCredentialEvents: true,
      transportsClosed: contexts.every((ctx) => ctx.signal.aborted),
    };
  } catch {
    failed = true;
  } finally {
    if (registry) await registry.dispose();
    transient.purgeAll();
    // These are only handles created above; no unrelated process/credential cleanup.
    for (const channel of channels) channel.destroy();
    for (const transport of transports) await transport.close();
    if (fixture) {
      fixture.privateKey.fill(0);
      await fixture.dispose();
      await fixture.assertCleaned();
    }
  }
  if (failed || !result) throw new Error("SESSION_FIXTURE_SMOKE_FAILED");
  return { ...result, fixtureCleaned: true };
}

module.exports = { runSessionSmoke };
