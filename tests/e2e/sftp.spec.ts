import { resolve } from "node:path";
import { test, expect } from "./fixtures";

// The session authenticates with a Keychain-held fixture password; keep main-side evaluation out of traces.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("shipped saved-host composition opens an SFTP session beside a terminal on a real OpenSSH host", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const bootstrap = await desktop.page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("SFTP fixture bootstrap failed");
  // The fixture is external to the app and never enters its package.
  const receipt = await desktop.app.evaluate(async ({ app, powerMonitor }, parameters) => {
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const out = (name: string) => require(path.join(app.getAppPath(), `out/main/${name}.js`));
    const production = { ...out("ssh"), ...out("secrets") };
    const { runSftpRuntime } = require(parameters.fixturePath);
    return runSftpRuntime(production, { owner: parameters.owner, tempDirectory: app.getPath("temp"), power: powerMonitor });
  }, { owner: bootstrap.value.owner, fixturePath: resolve("tests/fixtures/sftp/ssh.cjs") });
  await testInfo.attach("sftp-runtime", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });

  expect(receipt).toMatchObject({
    // Session kind, shared trust and capability fences.
    sftpKind: "sftp", sftpReady: true, trustPrompts: 1, trustPromptsTotal: 1, home: "/home/fixture",
    terminalFenceRefusesSftp: true, sftpFenceRefusesTerminal: true, serverSftpProcesses: 1, terminalEchoBefore: true,
    // Unicode, non-UTF-8 and symlinks.
    list: "ok", listCount: 6, listSkipped: 0, listTruncated: false, thaiListed: true, emojiListed: true,
    lossyCount: 1, lossyStat: "not-found", symlinkTypes: ["symlink", "symlink", "symlink"],
    thaiStat: "file:1", emojiStat: "file:1", toDirStat: "directory", toDirLstat: "symlink",
    danglingStat: "not-found", loopStat: "not-found", loopLstat: "symlink",
    relativeRealpath: "invalid-request", realpathFollows: true, lockedList: "permission-denied",
    // Listing cap.
    k10000: { entries: 10_000, truncated: false, skipped: 0 },
    k10050: { entries: 10_000, truncated: true, skipped: 0 },
    // Exclusive create and byte round trip.
    existingCreate: "failure", existingKept: true, create: "ok", writes: 10, writeClose: "ok", writeCloseAgain: "ok",
    writeAfterClose: "closed", createdStat: "300000:600", readBackEqual: true, serverHashEqual: true,
    // Cancellation.
    bigOpen: "ok", serverHandlesWhileOpen: 1, abortedRead: "cancelled", readAfterAbort: "ok", bigHashEqual: true, bigClose: "ok",
    abortedOpen: "cancelled", statAfterAbort: "ok",
    // Closing SFTP leaves the terminal Ready.
    close: "Closed/-", opAfterClose: "closed", fenceAfterClose: true,
    terminalAfterClose: "Ready/-", terminalEchoAfter: true, terminalProcesses: 1,
    // Reconnect keeps the kind; lock closes everything; unlock + Reconnect is SFTP again.
    reconnectKind: "sftp", reconnectReady: true, reconnectList: "ok", opAfterLock: "closed",
    lockedSftp: "Closed/locked", lockedTerminal: "Closed/locked", reconnectWhileLocked: "locked",
    unlocked: true, unlockReconnectKind: "sftp", unlockReconnectReady: true,
    cleanup: { fixtureCleaned: true, leftoverItems: 0 }, labCleaned: true,
  });
  expect(receipt.abortSettleMs, "an aborted read settles at once").toBeLessThan(50);
  for (const key of ["serverHandlesZeroMs", "sftpProcessesGoneMs", "lockedProcessesGoneMs", "finalProcessesGoneMs"]) {
    expect(receipt[key], `${key}: reaped within 2 s`).toBeGreaterThanOrEqual(0);
  }
  expect(desktop.errors).toEqual([]);
});
