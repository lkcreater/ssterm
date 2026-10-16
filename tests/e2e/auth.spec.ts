import { resolve } from "node:path";
import { test, expect } from "./fixtures";

test("shipped saved-host SSH authenticates from catalog and real Keychain references", async ({ desktop }, testInfo) => {
  test.setTimeout(180_000);
  const receipt = await desktop.app.evaluate(async ({ app }, fixturePath) => {
    // Yield before touching the synchronous repository; inspector evaluation can interrupt main.
    await new Promise<void>((done) => setImmediate(done));
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const production = {
      ...require(path.join(app.getAppPath(), "out/main/ssh.js")),
      ...require(path.join(app.getAppPath(), "out/main/secrets.js")),
    };
    const { runSavedHostSmoke } = require(fixturePath);
    return runSavedHostSmoke(production, app.getPath("temp"));
  }, resolve("tests/fixtures/auth/ssh.cjs"));
  expect(receipt).toEqual({
    password: true,
    supported: ["openssh-ed25519-encrypted", "openssh-ed25519", "pem-rsa-pkcs1", "pem-rsa-pkcs1-encrypted"],
    inheritedAuth: true, rememberedMatch: true, rejectBeforeCredentialRead: true,
    changedBeforeCredentialRead: true, explicitReplacement: true, badAuth: true,
    latestSecretReference: true, lockCleanup: true, safeEvents: true,
    noPlaintextMetadata: true, providerBuffersWiped: true, leftoverItems: 0, fixtureCleaned: true,
  });
  expect(desktop.errors).toEqual([]);
  await testInfo.attach("saved-host-ssh-runtime", { body: JSON.stringify(receipt), contentType: "application/json" });
});
