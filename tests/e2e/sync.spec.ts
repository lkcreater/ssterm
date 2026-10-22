import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";
import type { SyncAction, SyncReply } from "../../packages/contracts/src/sync";
import { SyncServer } from "../../apps/sync-server/src/server";
import {
  test,
  expect,
  launchDesktop,
  changeCatalog,
  type Desktop,
} from "./fixtures";

test.use({ trace: "off", screenshot: "off", video: "off" });
async function command(page: Page, action: SyncAction): Promise<SyncReply> {
  const result = await page.evaluate(async (action) => {
    const bootstrap = await window.ssterm.bootstrap();
    if (!bootstrap.ok) return null;
    return window.ssterm.syncCommand({ owner: bootstrap.value.owner, action });
  }, action);
  expect(
    result?.ok,
    `sync command ${action.type} reached production main`,
  ).toBe(true);
  if (!result?.ok) throw new Error("Sync IPC unavailable.");
  expect(
    result.value.outcome,
    `sync command ${action.type} outcome (${result.value.code ?? "ok"})`,
  ).toBe("ok");
  return result.value;
}
async function state(page: Page) {
  const result = await page.evaluate(async () => {
    const boot = await window.ssterm.bootstrap();
    return boot.ok
      ? window.ssterm.syncState({ owner: boot.value.owner })
      : null;
  });
  expect(result?.ok).toBe(true);
  if (!result?.ok) throw new Error("Sync state unavailable.");
  return result.value;
}
async function blobs(root: string): Promise<Buffer[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? blobs(join(root, entry.name))
          : entry.isFile()
            ? readFile(join(root, entry.name)).then((bytes) => [bytes])
            : [],
      ),
    )
  ).flat();
}

test("two devices sync encrypted catalog through UI/bridge, merge independent edits and recover owner", async ({
  desktop,
}) => {
  test.setTimeout(300_000);
  const directory = await mkdtemp(join(tmpdir(), "ssterm-sync-e2e-"));
  const scope = {
    deploymentId: randomUUID(),
    accountId: randomUUID(),
    vaultId: randomUUID(),
  };
  const token = randomBytes(32).toString("base64url");
  const server = new SyncServer(
    {
      ...scope,
      tokenHash: createHash("sha256")
        .update(Buffer.from(token, "base64url"))
        .digest("hex"),
      databasePath: join(directory, "server.sqlite"),
    },
    { requestLimit: 10000 },
  );
  const endpoint = await server.listen();
  const secondProfile = join(directory, "device-two");
  await mkdir(secondProfile);
  let second: Desktop | undefined;
  let recovered: Desktop | undefined;
  const owner = desktop;
  const marker = "owned-sync-ไทย-" + randomUUID();
  try {
    await owner.page
      .getByRole("button", { name: "Settings", exact: true })
      .first()
      .click();
    await owner.page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Sync" }).click();
    const panel = owner.page.getByTestId("sync-settings");
    await expect(panel).toContainText("disabled");
    await panel.getByLabel("Server URL", { exact: true }).fill(endpoint);
    await panel
      .getByLabel("Deployment ID", { exact: true })
      .fill(scope.deploymentId);
    await panel.getByLabel("Account ID", { exact: true }).fill(scope.accountId);
    await panel
      .getByLabel("Sync vault ID", { exact: true })
      .fill(scope.vaultId);
    await panel.getByLabel("Server account token", { exact: true }).fill(token);
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Create encrypted vault" }).click();
    await expect(panel).toContainText("enrolled", { timeout: 20000 });
    await owner.page.keyboard.press("Escape");
    const before = await state(owner.page);
    expect(before.role).toBe("owner");
    second = await launchDesktop(secondProfile);
    const request = await command(second.page, {
      type: "begin-join",
      endpoint,
      token,
      expectedScope: scope,
      expectedOwnerFingerprint: before.ownerFingerprint!,
      role: "writer",
      consent: true,
    });
    expect(request.detail.kind).toBe("text");
    if (request.detail.kind !== "text") throw new Error("No candidate.");
    const challenge = await command(owner.page, {
      type: "challenge",
      candidateText: request.detail.text,
    });
    if (challenge.detail.kind !== "text") throw new Error("No challenge.");
    const proof = await command(second.page, {
      type: "prove",
      challengeText: challenge.detail.text,
    });
    if (proof.detail.kind !== "text" || !proof.detail.fingerprint)
      throw new Error("No proof.");
    expect(proof.detail.fingerprint).toBe(challenge.detail.fingerprint);
    await command(owner.page, {
      type: "approve",
      proofText: proof.detail.text,
      confirmedFingerprint: proof.detail.fingerprint,
    });
    await command(second.page, { type: "finish-join" });
    const [host] = await changeCatalog(owner.app, [
      {
        type: "create-host",
        data: { label: marker, address: "127.0.0.1", auth: { mode: "clear" } },
      },
    ]);
    const body = marker + "\nsecond line λ";
    const snippet = await owner.page.evaluate(
      async ({ label, body }) => {
        const boot = await window.ssterm.bootstrap();
        if (!boot.ok) return false;
        const result = await window.ssterm.saveSnippet({
          owner: boot.value.owner,
          snippetId: null,
          expectedRevision: null,
          label,
          body,
          tagIds: [],
        });
        return result.ok;
      },
      { label: marker, body },
    );
    expect(snippet).toBe(true);
    await command(owner.page, { type: "publish" });
    await command(second.page, { type: "fetch" });
    const review = await command(second.page, {
      type: "review",
      operationHashes: [],
    });
    expect(review.detail.kind).toBe("review");
    if (review.detail.kind !== "review") throw new Error("No review.");
    expect(review.detail.review.conflicts).toHaveLength(0);
    await command(second.page, {
      type: "apply",
      reviewToken: review.detail.review.reviewToken,
      resolutions: [],
    });
    await second.page.reload();
    await expect(
      second.page
        .getByTestId("hosts-page")
        .locator("button[data-host-id]", { hasText: marker }),
    ).toBeVisible();
    const exactBody = await second.page.evaluate(
      async (expected) => {
        const boot = await window.ssterm.bootstrap();
        if (!boot.ok) return false;
        const catalog = await window.ssterm.catalogState({
          owner: boot.value.owner,
        });
        if (!catalog.ok) return false;
        const row = catalog.value.snippets.find(
          (item) => item.label === expected.label,
        );
        if (!row) return false;
        const opened = await window.ssterm.openSnippet({
          owner: boot.value.owner,
          snippetId: row.id,
          expectedRevision: row.revision,
        });
        return (
          opened.ok &&
          opened.value.status === "open" &&
          opened.value.body === expected.body
        );
      },
      { label: marker, body },
    );
    expect(
      exactBody,
      "imported Thai/multiline snippet decrypts to the exact source bytes",
    ).toBe(true);
    // Independent local edits on two branches merge, without silently choosing a winner by arrival time.
    await changeCatalog(owner.app, [
      {
        type: "create-host",
        data: {
          label: "Owned branch A",
          address: "127.0.0.2",
          auth: { mode: "clear" },
        },
      },
    ]);
    await changeCatalog(second.app, [
      {
        type: "create-host",
        data: {
          label: "Owned branch B",
          address: "127.0.0.3",
          auth: { mode: "clear" },
        },
      },
    ]);
    await command(owner.page, { type: "publish" });
    await command(second.page, { type: "publish" });
    await command(second.page, { type: "fetch" });
    const merged = await command(second.page, {
      type: "review",
      operationHashes: [],
    });
    if (merged.detail.kind !== "review") throw new Error("No branch review.");
    expect(merged.detail.review.conflicts).toHaveLength(0);
    await command(second.page, {
      type: "apply",
      reviewToken: merged.detail.review.reviewToken,
      resolutions: [],
    });
    await command(second.page, { type: "publish" });
    await command(owner.page, { type: "fetch" });
    const ownerMerge = await command(owner.page, {
      type: "review",
      operationHashes: [],
    });
    if (ownerMerge.detail.kind !== "review")
      throw new Error("No owner review.");
    await command(owner.page, {
      type: "apply",
      reviewToken: ownerMerge.detail.review.reviewToken,
      resolutions: [],
    });
    const retained = await state(second.page);
    await command(second.page, { type: "logout", forgetTransportToken: true });
    expect((await state(second.page)).needsToken).toBe(true);
    await command(second.page, { type: "resume", token });
    const resumed = await state(second.page);
    expect(resumed.needsToken).toBe(false);
    expect(resumed.deviceId).toBe(retained.deviceId);
    expect(resumed.ownerFingerprint).toBe(retained.ownerFingerprint);
    expect(resumed.epoch).toBe(retained.epoch);
    // The server and dedicated sync journals must never contain plaintext catalog or snippets.
    const stored = [
      ...(await blobs(join(secondProfile, "sync"))),
      ...(await blobs(join(owner.profile, "sync"))),
    ];
    const serverBytes = await readFile(join(directory, "server.sqlite"));
    expect(serverBytes.includes(marker)).toBe(false);
    expect(
      stored.some(
        (bytes) =>
          bytes.includes(marker) ||
          bytes.includes(body) ||
          bytes.includes(token),
      ),
    ).toBe(false);
    // Recovery kit is saved through the actual main dialog seam, and the confirmation performs an offline decrypt drill.
    const kitPath = join(directory, "owned-sync-kit.ssterm");
    await owner.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath,
      })) as typeof dialog.showSaveDialog;
    }, kitPath);
    const recovery = await command(owner.page, { type: "create-recovery" });
    if (recovery.detail.kind !== "recovery")
      throw new Error("No recovery secret.");
    const recoverySecret = recovery.detail.secret;
    await command(owner.page, {
      type: "confirm-recovery",
      confirmationToken: recovery.detail.confirmationToken,
      secret: recoverySecret,
    });
    expect((await state(owner.page)).recoveryReady).toBe(true);
    const recoveryProfile = join(directory, "device-recovered");
    await mkdir(recoveryProfile);
    recovered = await launchDesktop(recoveryProfile);
    await recovered.app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [filePath],
      })) as typeof dialog.showOpenDialog;
    }, kitPath);
    await command(recovered.page, {
      type: "recover",
      endpoint,
      token,
      expectedScope: scope,
      expectedOwnerFingerprint: before.ownerFingerprint!,
      secret: recoverySecret,
      consent: true,
    });
    expect((await state(recovered.page)).role).toBe("owner");
    expect((await state(recovered.page)).epoch).toBeGreaterThan(before.epoch);
    await command(recovered.page, { type: "fetch" });
    const after = await command(recovered.page, {
      type: "review",
      operationHashes: [],
    });
    if (after.detail.kind !== "review") throw new Error("No recovered review.");
    await command(recovered.page, {
      type: "apply",
      reviewToken: after.detail.review.reviewToken,
      resolutions: after.detail.review.conflicts.map((conflict) => ({
        key: conflict.key,
        choice: "remote" as const,
      })),
    });
    expect(owner.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(recovered.errors).toEqual([]);
    expect(owner.externalRequests).toEqual([]);
    expect(second.externalRequests).toEqual([]);
    expect(recovered.externalRequests).toEqual([]);
    expect(host).toBeTruthy();
  } finally {
    await recovered?.close();
    await second?.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync setup remains keyboard accessible at supported sizes and clears transient inputs on close", async ({
  desktop,
}) => {
  const { renderedContrast } = await import("./support/transfer-fixture");
  const { page } = desktop;
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const size of [
    { width: 960, height: 640 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    const trigger = page
      .locator("#app-sidebar")
      .getByRole("button", { name: "Settings", exact: true });
    await trigger.click();
    await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Sync" }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    const panel = dialog.getByTestId("sync-settings");
    const endpoint = panel.getByLabel("Server URL", { exact: true });
    await endpoint.scrollIntoViewIfNeeded();
    await endpoint.focus();
    await expect(endpoint).toBeFocused();
    await expect(panel).toContainText("disabled");
    await endpoint.fill("http://127.0.0.1:12345");
    await panel
      .getByLabel("Server account token", { exact: true })
      .fill("owned-transient-input");
    const label = panel.locator("label").filter({ hasText: "Server URL" });
    expect((await renderedContrast(label)).ratio).toBeGreaterThanOrEqual(4.5);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Sync" }).click();
    await expect(
      page.getByLabel("Server account token", { exact: true }),
    ).toHaveValue("");
    await expect(page.getByLabel("Server URL", { exact: true })).toHaveValue(
      "",
    );
    await page.keyboard.press("Escape");
  }
  expect(desktop.errors).toEqual([]);
});

test("recovery secrets and delayed native saves are fenced by lock without rotating the window owner", async ({
  desktop,
}) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "ssterm-sync-lock-e2e-"));
  const scope = {
    deploymentId: randomUUID(),
    accountId: randomUUID(),
    vaultId: randomUUID(),
  };
  const token = randomBytes(32).toString("base64url");
  const server = new SyncServer(
    {
      ...scope,
      tokenHash: createHash("sha256")
        .update(Buffer.from(token, "base64url"))
        .digest("hex"),
      databasePath: join(directory, "server.sqlite"),
    },
    { requestLimit: 10000 },
  );
  const endpoint = await server.listen();
  const { app, page } = desktop;
  try {
    // Lose the first control-publication reply AFTER the real server commits it.
    let dropped = false;
    server.server.prependListener("request", (request, response) => {
      if (
        request.method === "POST" &&
        request.url === "/v1/controls" &&
        !dropped
      ) {
        response.end = ((..._args: unknown[]) => {
          dropped = true;
          response.destroy();
          return response;
        }) as typeof response.end;
      }
    });
    const interrupted = await page.evaluate(
      async (input) => {
        const boot = await window.ssterm.bootstrap();
        if (!boot.ok) return false;
        const result = await window.ssterm.syncCommand({
          owner: boot.value.owner,
          action: { type: "create", ...input, consent: true },
        });
        return (
          result.ok &&
          result.value.outcome === "failed" &&
          result.value.state.status === "pending" &&
          !result.value.state.canCancelSetup
        );
      },
      {
        endpoint,
        token,
        expectedScope: scope,
        deviceLabel: "Owned lock fixture",
      },
    );
    expect(interrupted).toBe(true);
    expect(dropped).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(
      ({ dialog }, filePath) => {
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath,
        })) as typeof dialog.showSaveDialog;
      },
      join(directory, "shown-kit.ssterm"),
    );
    const trigger = page
      .locator("#app-sidebar")
      .getByRole("button", { name: "Settings", exact: true });
    const settings = page.getByRole("dialog", { name: "Settings" });
    await trigger.click();
    await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Sync" }).click();
    await settings
      .getByRole("button", { name: "Retry pending sync", exact: true })
      .click();
    await expect(settings.getByTestId("sync-settings")).toContainText(
      "enrolled",
    );
    await settings
      .getByRole("button", { name: "Save new encrypted recovery kit" })
      .click();
    await expect(settings.getByTestId("sync-recovery-secret")).toBeVisible();
    // The lock closes Settings from any tab: the Sync panel stays mounted behind the Terminal tab.
    await settings.getByRole("tab", { name: "Terminal" }).click();
    await expect(settings.getByTestId("sync-recovery-secret")).toBeHidden();
    const before = await page.evaluate(async () => {
      const boot = await window.ssterm.bootstrap();
      return boot.ok ? boot.value.owner : null;
    });
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("lock-screen");
    });
    await expect(settings).toHaveCount(0);
    await trigger.click();
    await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Sync" }).click();
    await expect(settings.getByTestId("sync-recovery-secret")).toHaveCount(0);
    await app.evaluate(({ dialog, ipcMain }) => {
      dialog.showSaveDialog = (() =>
        new Promise((resolve) => {
          (globalThis as any).__sstermSyncPendingSave = resolve;
        })) as typeof dialog.showSaveDialog;
      const handlers = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
        }
      )._invokeHandlers;
      const original = handlers.get("ssterm:sync-command")!;
      (globalThis as any).__sstermSyncRecoveryReceipts = [];
      ipcMain.removeHandler("ssterm:sync-command");
      ipcMain.handle("ssterm:sync-command", async (event, ...args) => {
        const result = (await original(event, ...args)) as any;
        (globalThis as any).__sstermSyncRecoveryReceipts.push({
          secret:
            result?.ok === true && result.value?.detail?.kind === "recovery",
        });
        return result;
      });
    });
    const latePath = join(directory, "must-not-save-after-lock.ssterm");
    await settings
      .getByRole("button", { name: "Save new encrypted recovery kit" })
      .click();
    await expect
      .poll(() =>
        app.evaluate(() => typeof (globalThis as any).__sstermSyncPendingSave),
      )
      .toBe("function");
    // While the action runs, every tab shows it, Done waits and Manage recordings cannot drop its reply.
    await expect(settings.getByRole("status").filter({ hasText: "Sync running" })).toBeVisible();
    await expect(settings.getByRole("button", { name: "Done" })).toBeDisabled();
    await settings.getByRole("tab", { name: "Recording" }).click();
    await expect(settings.getByRole("button", { name: "Manage recordings and shell integration" })).toBeDisabled();
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit("lock-screen");
    });
    await expect(settings).toHaveCount(0);
    // Re-unlocking this service through the same window must not revive its old native dialog callback.
    await trigger.click();
    await page.getByRole("dialog", { name: "Settings" }).getByRole("tab", { name: "Sync" }).click();
    await expect(settings.getByTestId("sync-settings")).toContainText(
      "enrolled",
    );
    await app.evaluate((_electron, path) => {
      (globalThis as any).__sstermSyncPendingSave({
        canceled: false,
        filePath: path,
      });
    }, latePath);
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as any).__sstermSyncRecoveryReceipts.length,
        ),
      )
      .toBe(1);
    expect(
      await app.evaluate(
        () => (globalThis as any).__sstermSyncRecoveryReceipts,
      ),
    ).toEqual([{ secret: false }]);
    expect(
      await readFile(latePath).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    await expect(settings.getByTestId("sync-recovery-secret")).toHaveCount(0);
    const after = await page.evaluate(async () => {
      const boot = await window.ssterm.bootstrap();
      return boot.ok ? boot.value.owner : null;
    });
    expect(after).toEqual(before);
    expect(desktop.errors).toEqual([]);
  } finally {
    await app
      .evaluate(() => {
        const done = (globalThis as any).__sstermSyncPendingSave;
        if (typeof done === "function") done({ canceled: true });
      })
      .catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
