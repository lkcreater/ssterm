import { resolve } from "node:path";
import { test, expect } from "./fixtures";

// Sessions authenticate with Keychain-held fixture passwords; keep main-side evaluation out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("shipped saved-host adapter reaches a target through one and two real OpenSSH jump hosts; failed or refused hops leave nothing open", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const bootstrap = await desktop.page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("Jump fixture bootstrap failed");
  const receipt = await desktop.app.evaluate(async ({ app }, parameters) => {
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const out = (name: string) => require(path.join(app.getAppPath(), `out/main/${name}.js`));
    const production = { ...out("ssh"), ...out("secrets") };
    const { runJumpRuntime } = require(parameters.fixturePath);
    return runJumpRuntime(production, { owner: parameters.owner, tempDirectory: app.getPath("temp") });
  }, { owner: bootstrap.value.owner, fixturePath: resolve("tests/fixtures/jump/ssh.cjs") });
  await testInfo.attach("jump-runtime", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });

  expect(receipt).toMatchObject({
    // One hop: the bastion's key is asked as the bastion's (its published endpoint), then the target's (as named on the network).
    oneHop: "Ready/target/complete",
    oneHopPrompts: [expect.stringMatching(/^Bastion@127\.0\.0\.1:\d+$/u), "target@target:22"],
    // Two hops: only the new inner hop asks; bastion and target were remembered under their own endpoints.
    twoHops: "Ready/target/complete",
    twoHopsPrompts: ["Inner@inner:22"],
    // A failed intermediate hop is that hop's code; a jump host refusing onward is jump-refused. Both clean up fully.
    viaBad: "Failed/auth-denied/complete",
    blocked: "Failed/jump-refused/complete",
    knownHosts: [expect.stringMatching(/^127\.0\.0\.1:\d+$/u), "inner:22", "target:22"],
    terminalTwoHops: "Ready",
    sessionsLeft: 0,
    leftoverItems: 0,
    labCleaned: true,
  });
  expect(desktop.errors).toEqual([]);
});
