import { resolve } from "node:path";
import { test, expect } from "./fixtures";

// The session authenticates with a Keychain-held fixture password; keep main-side evaluation out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("shipped tunnel service forwards HTTP over a real OpenSSH host and closes listeners on stop, lock, quit and loss", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const bootstrap = await desktop.page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("Tunnel fixture bootstrap failed");
  // The fixture is external to the app and never enters its package.
  const receipt = await desktop.app.evaluate(async ({ app, powerMonitor }, parameters) => {
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const out = (name: string) => require(path.join(app.getAppPath(), `out/main/${name}.js`));
    const production = { ...out("ssh"), ...out("secrets") };
    const { runTunnelRuntime } = require(parameters.fixturePath);
    return runTunnelRuntime(production, { owner: parameters.owner, tempDirectory: app.getPath("temp"), power: powerMonitor });
  }, { owner: bootstrap.value.owner, fixturePath: resolve("tests/fixtures/tunnel/ssh.cjs") });
  await testInfo.attach("tunnel-runtime", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });

  expect(receipt).toMatchObject({
    // Save never starts; loopback by default.
    defaultBind: "local/127.0.0.1", listenerAfterSave: false, sessionsAfterSave: 0,
    // Starting until SSH Ready, then real HTTP through the tunnel.
    startState: "starting", http: { status: 200, fixtureBody: true }, httpAgain: { status: 200, fixtureBody: true },
    counters: { totalConnections: 2, failedConnections: 0 }, fenceKind: true,
    // Collision is typed, adds no session and leaves the running tunnel serving.
    collision: "address-in-use", collisionAddedSession: false, httpAfterCollision: 200,
    // A refused destination closes only that connection.
    refusedDestination: 0, refusedCounted: true, refusedStillRunning: "running/-",
    // Stop closes the open connection, the listener and the session.
    heldActive: true, stop: true, heldClosed: true, listenerAfterStop: false, sessionsAfterStop: 0,
    // Lock fails the tunnel and closes its listener; starting while locked is refused and leaves nothing bound.
    lockedState: "failed/locked", listenerAfterLock: false, startWhileLocked: "locked", listenerAfterLockedStart: false, unlocked: true,
    // Quit (dispose) and transport loss leave no listener.
    listenerAfterDispose: false, sessionsAfterDispose: 0,
    httpBeforeLoss: 200, listenerAfterLoss: false,
    cleanup: { fixtureCleaned: true, leftoverItems: 0 }, labCleaned: true,
  });
  expect(receipt.runningMs).toBeGreaterThanOrEqual(0);
  expect(receipt.lossFailedMs).toBeGreaterThanOrEqual(0);
  expect(["network", "timeout"]).toContain(receipt.lossError);
  expect(desktop.errors).toEqual([]);
});
