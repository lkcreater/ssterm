"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("../../../spikes/ssh-compat/node_modules/ssh2");
const { startFixture } = require("../../../spikes/ssh-compat/src/fixture.cjs");

/** Test-only engine. Public-key verification always crosses the production policy. */
async function startTrustFixture(production, options) {
  const {
    openMetadata,
    CatalogModule,
    KnownHostPolicy,
    SessionRegistry,
    TransientSecrets,
    createKnownHostsController,
    sessionOwnerId,
  } = production;
  const directory = fs.mkdtempSync(
    path.join(options.tempDirectory, "ssterm-known-hosts-runtime-"),
  );
  let lab, database, policy, registry, controller;
  const transient = new TransientSecrets();
  const clients = new Set();
  const decisions = [];
  let current,
    authStarts = 0,
    channelsOpened = 0;
  const value = (result) => {
    if (!result.ok)
      throw new Error(`TRUST_FIXTURE_OPERATION_FAILED:${result.error?.code}`);
    return result.value;
  };
  const ownerId = sessionOwnerId(options.owner);
  const cleanup = async () => {
    controller?.dispose();
    policy?.dispose();
    if (registry) await registry.dispose();
    transient.purgeAll();
    for (const client of clients) client.destroy();
    database?.close();
    if (lab) {
      lab.privateKey.fill(0);
      await lab.dispose();
      await lab.assertCleaned();
    }
    fs.rmSync(directory, { recursive: true, force: true });
    return { fixtureCleaned: true };
  };
  try {
    lab = await startFixture();
    const filename = path.join(directory, "catalog.sqlite");
    database = value(await openMetadata({ path: filename }));
    // Stable repository seam lets a real close/reopen keep the event subscription alive.
    const repository = {
      snapshot: () => database.snapshot(),
      commit: (request) => database.commit(request),
      backup: (request) => database.backup(request),
      close: () => database.close(),
    };
    const catalog = new CatalogModule({ repository });
    const perform = (intent) =>
      value(catalog.apply(value(catalog.prepare(intent)).token));
    const hostId = perform({
      type: "create-host",
      data: {
        label: "ระบบทดสอบ กรุงเทพ",
        address: lab.host,
        environment: "PROD",
        port: { mode: "value", port: lab.port },
      },
    }).createdIds[0];
    policy = new KnownHostPolicy({ repository });
    registry = new SessionRegistry({
      resolve: (id) => catalog.resolve(id),
      transient,
      limits: { connectMs: 15_000 },
      adapter: {
        start(context) {
          const client = new Client();
          clients.add(client);
          let finished;
          const drained = new Promise((resolve) => {
            finished = resolve;
          });
          client.on("error", () => {
            if (!context.signal.aborted) context.failed("network");
          });
          client.once("close", () => {
            clients.delete(client);
            finished();
            context.ended();
          });
          if (
            !context.own({ dispose: () => client.destroy(), drained }) ||
            !context.verifyingHost()
          ) {
            client.destroy();
            finished();
            return;
          }
          client.once("ready", () => {
            client.shell(
              { term: "xterm-256color", cols: 80, rows: 24 },
              (error, channel) => {
                if (error) {
                  context.failed("channel-open-failed");
                  return;
                }
                let channelClosed;
                const drained = new Promise((resolve) => {
                  channelClosed = resolve;
                });
                channel.once("close", () => {
                  channelClosed();
                  context.ended();
                });
                channel.on("error", () => {});
                channel.on("data", () => {});
                channel.stderr.on("data", () => {});
                if (
                  context.ready({ dispose: () => channel.destroy(), drained })
                )
                  channelsOpened += 1;
              },
            );
          });
          let attempted = false;
          try {
            client.connect({
              host: context.config.address,
              port: context.config.port.value,
              username: lab.username,
              readyTimeout: 15_000,
              authHandler(_methods, _partial, next) {
                if (context.signal.aborted || attempted) {
                  next(false);
                  return;
                }
                attempted = true;
                authStarts += 1;
                next({
                  type: "password",
                  username: lab.username,
                  password: lab.password,
                });
              },
              hostVerifier(wire, finish) {
                void policy
                  .verify({
                    endpointHost: context.config.address,
                    endpointPort: context.config.port.value,
                    publicKey: wire,
                    signal: context.signal,
                    requestDecision: async (challenge) => {
                      const { kind, ...identity } = challenge;
                      const answer = await context.requestPrompt({
                        kind: "host-trust",
                        status: kind,
                        ...identity,
                      });
                      decisions.push(
                        answer.kind === "host-trust" ? answer.decision : "invalid",
                      );
                      return answer.kind === "host-trust"
                        ? answer.decision
                        : "reject";
                    },
                  })
                  .then(
                    (result) => {
                      if (
                        result.ok &&
                        !context.signal.aborted &&
                        context.authenticating()
                      )
                        finish(true);
                      else {
                        finish(false);
                        if (!context.signal.aborted)
                          context.failed(
                            !result.ok && result.error.code === "changed"
                              ? "host-key-changed"
                              : "host-key-untrusted",
                          );
                      }
                    },
                    () => {
                      finish(false);
                      context.failed("host-key-untrusted");
                    },
                  );
              },
            });
          } catch {
            context.failed("network");
          }
        },
      },
    });
    controller = createKnownHostsController({ registry, policy });
    controller.register(options.owner, options.send);
    return {
      registry,
      policy,
      controller,
      connect() {
        current = value(registry.connect(ownerId, hostId));
        return current;
      },
      status() {
        const snapshot = current
          ? registry.snapshot(ownerId, current.id)[0]
          : undefined;
        return {
          state: snapshot?.state ?? null,
          cleanup: snapshot?.cleanup ?? null,
          error: snapshot?.error?.code ?? null,
          authStarts,
          channelsOpened,
          knownHosts: value(policy.list()),
          decisions: [...decisions],
        };
      },
      async close() {
        if (current) value(await registry.close(ownerId, current.id));
      },
      rename() {
        const host = value(repository.snapshot()).hosts.find(
          (row) => row.id === hostId,
        );
        perform({
          type: "update-host",
          id: hostId,
          expectedRevision: host.revision,
          data: { label: "ระบบทดสอบ เปลี่ยนชื่อ" },
        });
      },
      async reopen() {
        if (
          registry
            .snapshot(ownerId)
            .some((row) => !["Closed", "Failed"].includes(row.state))
        )
          throw new Error("TRUST_FIXTURE_STILL_ACTIVE");
        database.close();
        database = value(await openMetadata({ path: filename }));
        return value(policy.list()).length;
      },
      rotate: () => lab.rotateHostKey(),
      dispose: cleanup,
    };
  } catch {
    await cleanup();
    throw new Error("TRUST_FIXTURE_START_FAILED");
  }
}

module.exports = { startTrustFixture };
