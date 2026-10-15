import { resolve } from "node:path";
import { test, expect } from "./fixtures";

test("shipped session composition captures config and fences power/owner lifecycle", async ({
  desktop,
}, testInfo) => {
  const receipt = await desktop.app.evaluate(async ({ app, powerMonitor }) => {
    const require = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const fs = require("node:fs"),
      path = require("node:path");
    const main = path.join(app.getAppPath(), "out/main");
    const { openMetadata } = require(path.join(main, "storage.js"));
    const { CatalogModule } = require(path.join(main, "catalog.js"));
    const { createDesktopSessions, TransientSecrets } = require(
      path.join(main, "sessions.js"),
    );
    const directory = fs.mkdtempSync(
      path.join(app.getPath("temp"), "ssterm-sessions-runtime-"),
    );
    let repository: any, runtime: any;
    const baseline = [
      powerMonitor.listenerCount("lock-screen"),
      powerMonitor.listenerCount("suspend"),
    ];
    const transient = new TransientSecrets();
    try {
      const value = (r: any) => {
        if (!r.ok) throw new Error("Session runtime fixture failed");
        return r.value;
      };
      repository = value(
        await openMetadata({ path: path.join(directory, "catalog.sqlite") }),
      );
      const catalog = new CatalogModule({ repository });
      const perform = (intent: any) =>
        value(catalog.apply(value(catalog.prepare(intent)).token));
      const hostId = perform({
        type: "create-host",
        data: {
          label: "ระบบทดสอบ",
          address: "127.0.0.1",
          port: { mode: "value", port: 2222 },
        },
      }).createdIds[0];
      const contexts: any[] = [],
        events: any[] = [];
      let disposed = 0;
      runtime = createDesktopSessions({
        resolve: (id: string) => catalog.resolve(id),
        transient,
        power: powerMonitor,
        adapter: {
          start(context: any) {
            contexts.push(context);
            context.own({
              dispose: () => {
                disposed += 1;
              },
            });
            context.verifyingHost();
            context.authenticating();
            context.ready({
              dispose: () => {
                disposed += 1;
              },
            });
          },
        },
      });
      const owner = "window:1:1";
      runtime.registry.subscribe(owner, (event: any) => events.push(event));
      const waitTurn = () => new Promise<void>((done) => setImmediate(done));
      const first = value(runtime.registry.connect(owner, hostId));
      await waitTurn();
      const captured = contexts[0].config;
      const capturedJSON = JSON.stringify(captured);
      perform({
        type: "update-host",
        id: hostId,
        expectedRevision: 1,
        data: { port: { mode: "value", port: 2201 } },
      });
      const captureStable =
        JSON.stringify(captured) === capturedJSON &&
        captured.port.value === 2222 &&
        Object.isFrozen(captured);
      await runtime.registry.close(owner, first.id);
      value(runtime.registry.reconnect(owner, first.id));
      await waitTurn();
      const reconnectFresh =
        contexts[1].config.port.value === 2201 &&
        contexts[1].generation > contexts[0].generation;
      let staleDisposed = 0;
      const staleRejected =
        !contexts[0].ready({
          dispose: () => {
            staleDisposed += 1;
          },
        }) && staleDisposed === 1;
      const held = transient.hold(Buffer.from("owned-session-fixture"));
      powerMonitor.emit("lock-screen");
      const lockedImmediately =
        held.disposed &&
        contexts[1].signal.aborted &&
        disposed === 4 &&
        !runtime.registry.connect(owner, hostId).ok;
      powerMonitor.emit("unlock-screen");
      const noOSResume = !runtime.registry.connect(owner, hostId).ok;
      const unlocked = await runtime.registry.unlock(async () => true);
      const noReplay = contexts.length === 2;
      value(runtime.registry.connect("window:2:1", hostId));
      await waitTurn();
      runtime.revokeOwner({ windowId: 2, generation: 1 });
      const ownerClosed = contexts[2].signal.aborted;
      await runtime.shutdown();
      const listenersRestored =
        baseline[0] === powerMonitor.listenerCount("lock-screen") &&
        baseline[1] === powerMonitor.listenerCount("suspend");
      const serialized = JSON.stringify(events);
      const safeEvents =
        !serialized.includes("passwordRef") &&
        !serialized.includes("privateKeyRef") &&
        !serialized.includes("owned-session-fixture");
      return {
        electron: process.versions.electron,
        captureStable,
        reconnectFresh,
        staleRejected,
        lockedImmediately,
        noOSResume,
        unlocked,
        noReplay,
        ownerClosed,
        listenersRestored,
        safeEvents,
      };
    } finally {
      if (runtime) await runtime.shutdown();
      transient.purgeAll();
      repository?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  await testInfo.attach("sessions-runtime", {
    body: JSON.stringify(receipt),
    contentType: "application/json",
  });
  for (const [key, value] of Object.entries(receipt)) {
    if (key !== "electron") expect(value, key).toBe(true);
  }
  expect(desktop.errors).toEqual([]);
});

test("production registry owns a real fixture SSH transport and interactive channel", async ({
  desktop,
}, testInfo) => {
  test.setTimeout(120_000);
  // The fixture implementation is external to the app and never enters its package.
  const fixtureModule = resolve("tests/fixtures/sessions/ssh.cjs");
  const receipt = await desktop.app.evaluate(async ({ app }, fixturePath) => {
    const require = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const production = require(
      path.join(app.getAppPath(), "out/main/sessions.js"),
    );
    const { runSessionSmoke } = require(fixturePath);
    return runSessionSmoke(production);
  }, fixtureModule);
  await testInfo.attach("sessions-ssh-runtime", {
    body: JSON.stringify(receipt),
    contentType: "application/json",
  });
  for (const [key, value] of Object.entries(receipt))
    expect(value, key).toBe(true);
  expect(desktop.errors).toEqual([]);
});
