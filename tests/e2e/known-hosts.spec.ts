import { resolve } from "node:path";
import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";
import { expectDrawerPlaced } from "./support/drawer";

test("verifies real SSH trust through dialogs, persistence, replacement and revoke", async ({
  desktop,
}, testInfo) => {
  test.setTimeout(120_000);
  const { app, page } = desktop;
  const bootstrap = await page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("Trust fixture bootstrap failed");
  const parameters = {
    fixturePath: resolve("tests/fixtures/known-hosts/ssh.cjs"),
    owner: bootstrap.value.owner,
  };
  await app.evaluate(async ({ app, BrowserWindow, ipcMain }, parameters) => {
    const require = process
      .getBuiltinModule("node:module")
      .createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const production = require(
      path.join(app.getAppPath(), "out/main/trust.js"),
    );
    const { startTrustFixture } = require(parameters.fixturePath);
    const window = BrowserWindow.getAllWindows()[0];
    const boundary = new production.WindowBoundary(
      window.webContents.getURL().split("#")[0],
      { name: "ssterm", version: app.getVersion(), platform: process.platform },
      () => ({ status: "ready", schemaVersion: 1 }),
    );
    boundary.register(window.webContents, window.id, true, () => {});
      // Main rotates ownership for the initial document navigation as well.
      for (let generation = 1; generation < parameters.owner.generation; generation += 1) {
        boundary.rotate(window.webContents);
      }
    const check = boundary.bootstrap(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      [],
    );
    if (
      !check.ok ||
      JSON.stringify(check.value.owner) !== JSON.stringify(parameters.owner)
    )
      throw new Error("Trust fixture owner mismatch");
    const fixture = await startTrustFixture(production, {
      owner: parameters.owner,
      tempDirectory: app.getPath("temp"),
      send: (state: any) =>
        window.webContents.send(production.channels.trustStateChanged, state),
    });
    for (const name of [
      "trustState",
      "answerHostTrust",
      "prepareKnownHostRevoke",
      "revokeKnownHost",
    ])
      ipcMain.removeHandler(production.channels[name]);
    const disposeHandlers = production.registerKnownHostHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => fixture.controller,
    });
    (globalThis as any).__sstermOwnedTrustFixture = {
      fixture,
      boundary,
      disposeHandlers,
    };
  }, parameters);

  const operate = (
    method: "connect" | "close" | "rename" | "reopen" | "rotate",
  ) =>
    app.evaluate(async (_electron, method) => {
      // Inspector evaluations can interrupt synchronous main code (even mid-transaction);
      // touch fixture state only from a fresh macrotask.
      await new Promise((resolve) => setImmediate(resolve));
      const fixture = (globalThis as any).__sstermOwnedTrustFixture.fixture;
      await fixture[method]();
      return fixture.status();
    }, method);
  const status = () =>
    app.evaluate(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return (globalThis as any).__sstermOwnedTrustFixture.fixture.status();
    });
  // An answered prompt stays (busy) until the ordered state stream removes it, so each step
  // waits for that removal before the next connection can be mistaken for it.
  const ready = async () => {
    await expect.poll(async () => (await status()).state).toBe("Ready");
    await expect(dialog).toHaveCount(0);
  };
  const failed = async () => {
    await expect.poll(async () => (await status()).state).toBe("Failed");
    await expect(dialog).toHaveCount(0);
  };
  const shot = async (name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    // Finish the dialog entrance animation so evidence shows the settled surface.
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
  };
  const contrasts: Record<string, number> = {};
  // Composites every ancestor background (translucent badges/alerts included) under the text.
  const measure = async (scope: Locator, label: string, texts: string[]) => {
    for (const text of texts) {
      const ratio = await scope
        .getByText(text, { exact: true })
        .first()
        .evaluate((element) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d", {
            willReadFrequently: true,
          })!;
          const chain: Element[] = [];
          for (let node: Element | null = element; node; node = node.parentElement)
            chain.unshift(node);
          for (const node of chain) {
            context.fillStyle = getComputedStyle(node).backgroundColor;
            context.fillRect(0, 0, 1, 1);
          }
          const background = [...context.getImageData(0, 0, 1, 1).data];
          context.fillStyle = getComputedStyle(element).color;
          context.fillRect(0, 0, 1, 1);
          const foreground = [...context.getImageData(0, 0, 1, 1).data];
          const luminance = (rgb: number[]) => {
            const [r, g, b] = rgb.slice(0, 3).map((value) => {
              const channel = value / 255;
              return channel <= 0.03928
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
          };
          const [light, dark] = [luminance(background), luminance(foreground)].sort(
            (a, b) => b - a,
          );
          return (light! + 0.05) / (dark! + 0.05);
        });
      contrasts[`${label}: ${text}`] = Math.round(ratio * 100) / 100;
      expect(ratio, `${label}: ${text}`).toBeGreaterThanOrEqual(4.5);
    }
  };
  const dialog = page.getByTestId("host-trust-dialog");
  const knownHostsNav = page.getByRole("button", {
    name: "Known hosts",
    exact: true,
  });
  let cleaned = false;
  try {
    await knownHostsNav.click();
    await operate("connect");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Reject", exact: true }),
    ).toBeFocused();
    await expect(dialog.getByText("PROD", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("ระบบทดสอบ กรุงเทพ", { exact: true }),
    ).toBeVisible();
    // Alert semantics: an outside click neither dismisses nor decides.
    await page.mouse.click(8, 8);
    await expect(dialog).toBeVisible();
    expect(await status()).toMatchObject({ knownHosts: [], decisions: [] });
    await shot("trust-unknown");
    await expectDrawerPlaced(page, "host-trust-unknown");
    await measure(dialog, "unknown", [
      "Trust this server?",
      "ระบบทดสอบ กรุงเทพ",
      "PROD",
      "Server key",
      "ssh-ed25519",
      "Reject",
      "Accept once",
      "Remember",
    ]);
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await failed();
    expect((await status()).authStarts).toBe(0);
    expect((await status()).knownHosts).toHaveLength(0);
    await operate("close");

    await operate("connect");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await failed();
    await expect(knownHostsNav).toBeFocused();
    expect((await status()).authStarts).toBe(0);
    await operate("close");

    // Closing the session cancels its pending prompt; the stale dialog must disappear unanswered.
    await operate("connect");
    await expect(dialog).toBeVisible();
    await operate("close");
    await expect(dialog).toHaveCount(0);
    expect(await status()).toMatchObject({
      state: "Closed",
      authStarts: 0,
      knownHosts: [],
    });

    await operate("connect");
    await dialog
      .getByRole("button", { name: "Accept once", exact: true })
      .click();
    await ready();
    expect((await status()).knownHosts).toHaveLength(0);
    await operate("close");
    await operate("connect");
    await dialog.getByRole("button", { name: "Remember", exact: true }).click();
    await ready();
    const original = (await status()).knownHosts[0];
    expect(original).toBeTruthy();
    await operate("close");
    await operate("rename");
    await operate("reopen");
    await operate("connect");
    await ready();
    expect((await status()).knownHosts[0].fingerprint).toBe(
      original.fingerprint,
    );
    await operate("close");
    await operate("rotate");
    const authBeforeChange = (await status()).authStarts;
    await operate("connect");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("ระบบทดสอบ เปลี่ยนชื่อ", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Accept once", exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Remember", exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByText(original.fingerprint, { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await failed();
    expect(await status()).toMatchObject({
      error: "host-key-changed",
      authStarts: authBeforeChange,
    });
    expect((await status()).knownHosts[0].fingerprint).toBe(
      original.fingerprint,
    );
    await operate("close");

    await operate("connect");
    await expect(
      dialog.getByText("Server identity changed", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await failed();
    expect(await status()).toMatchObject({
      error: "host-key-changed",
      authStarts: authBeforeChange,
    });
    expect((await status()).knownHosts[0].fingerprint).toBe(
      original.fingerprint,
    );
    await operate("close");

    await operate("connect");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Replace key", exact: true }),
    ).toBeDisabled();
    // Both fingerprints are shown and the verification box starts unchecked.
    await expect(dialog.getByRole("checkbox")).not.toBeChecked();
    await expect(dialog.getByTestId("trust-fingerprint")).toHaveCount(2);
    await expect(dialog.getByText(original.fingerprint, { exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(960, 640),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await dialog.evaluate((element) =>
        parseFloat(getComputedStyle(element).animationDuration),
      ),
    ).toBeLessThanOrEqual(0.001);
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    // The initially focused action stays in view while only the details scroll.
    await expect(
      dialog.getByRole("button", { name: "Reject", exact: true }),
    ).toBeInViewport();
    await expect(
      dialog.getByRole("button", { name: "Replace key", exact: true }),
    ).toBeInViewport();
    await shot("trust-changed-narrow");
    await expectDrawerPlaced(page, "host-trust-changed");
    await measure(dialog, "changed", [
      "Server identity changed",
      "ระบบทดสอบ เปลี่ยนชื่อ",
      "PROD",
      "Host key mismatch",
      "Previous key",
      "New key",
      original.fingerprint,
    ]);
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          dialog.evaluate((element) => element.contains(document.activeElement)),
        )
        .toBe(true);
    }
    await dialog.getByRole("checkbox").check();
    const replace = dialog.getByRole("button", {
      name: "Replace key",
      exact: true,
    });
    await expect(replace).toBeEnabled();
    await shot("trust-replace-confirm");
    await measure(dialog, "replace", ["Replace key"]);
    await replace.click();
    await ready();
    const replaced = (await status()).knownHosts[0];
    expect(replaced.id).toBe(original.id);
    expect(replaced.fingerprint).not.toBe(original.fingerprint);
    await operate("close");
    await operate("connect");
    await ready();
    await operate("close");

    // A match records lastVerifiedAt only; the replaced row keeps its revision for the revoke preview.
    const latest = (await status()).knownHosts[0];
    expect(latest.revision).toBe(replaced.revision);
    expect(latest.lastVerifiedAt >= replaced.lastVerifiedAt).toBe(true);
    const entry = page
      .getByTestId("known-hosts-workspace")
      .getByRole("row")
      .filter({ hasText: latest.fingerprint });
    await expect(entry).toBeVisible();
    // The full fingerprint is visible text (it wraps, never truncates), so anyone can verify it without a pointer.
    const fingerprint = entry.getByTestId("known-host-fingerprint");
    await expect(fingerprint).toHaveText(latest.fingerprint);
    expect(await fingerprint.evaluate((node) => ({
      wraps: getComputedStyle(node).textOverflow !== "ellipsis" && node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight,
      inCell: (() => { const box = node.getBoundingClientRect(), cell = node.closest("td")!.getBoundingClientRect(); return box.right <= cell.right + 0.5 && box.bottom <= cell.bottom + 0.5; })(),
    })), "the whole fingerprint is shown").toEqual({ wraps: true, inCell: true });
    await shot("trust-known-hosts-list");
    const revokeTrigger = entry.getByRole("button", {
      name: "Revoke trust",
      exact: true,
    });
    const revoke = page.getByRole("alertdialog", {
      name: "Revoke this host's trust?",
    });
    await revokeTrigger.click();
    await expect(revoke).toBeVisible();
    await expect(
      revoke.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await expect(
      revoke.getByText(latest.fingerprint, { exact: true }),
    ).toBeVisible();
    await shot("trust-revoke-confirm");
    await expectDrawerPlaced(page, "revoke-trust");
    await measure(revoke, "revoke", [
      "Revoke this host's trust?",
      "Key being revoked",
      latest.fingerprint,
      "Cancel",
      "Revoke trust",
    ]);
    await page.keyboard.press("Escape");
    await expect(revoke).toHaveCount(0);
    await expect(revokeTrigger).toBeFocused();
    expect((await status()).knownHosts).toHaveLength(1);
    await revokeTrigger.click();
    await revoke
      .getByRole("button", { name: "Revoke trust", exact: true })
      .click();
    await expect.poll(async () => (await status()).knownHosts.length).toBe(0);
    await expect(page.getByText("No trusted hosts yet")).toBeVisible();
    await operate("connect");
    await expect(
      dialog.getByRole("button", { name: "Accept once", exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Reject", exact: true }).click();
    await failed();
    const final = await status();
    expect(final.decisions).toEqual([
      "reject",
      "reject",
      "accept-once",
      "remember",
      "reject",
      "reject",
      "replace",
      "reject",
    ]);
    expect(final.authStarts).toBe(5);
    expect(final.authStarts).toBe(final.channelsOpened);
    await operate("close");
    await testInfo.attach("trust-rendered-contrast", {
      body: JSON.stringify(contrasts, null, 2),
      contentType: "application/json",
    });
  } finally {
    await testInfo.attach("known-hosts-final-state", { body: JSON.stringify(await status()), contentType: "application/json" });
    const receipt = await app.evaluate(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const owned = (globalThis as any).__sstermOwnedTrustFixture;
      if (!owned) return { fixtureCleaned: false };
      owned.disposeHandlers();
      owned.boundary.dispose();
      const result = await owned.fixture.dispose();
      delete (globalThis as any).__sstermOwnedTrustFixture;
      return result;
    });
    cleaned = receipt.fixtureCleaned;
    await testInfo.attach("known-hosts-cleanup", {
      body: JSON.stringify(receipt),
      contentType: "application/json",
    });
  }
  expect(cleaned).toBe(true);
  expect(desktop.errors).toEqual([]);
});

test("trust IPC rejects wrong and stale owners and extra key material", async ({
  desktop,
}) => {
  const { page } = desktop;
  const bootstrap = await page.evaluate(() => window.ssterm.bootstrap());
  if (!bootstrap.ok) throw new Error("Trust bootstrap failed");
  const results = await page.evaluate(
    async (owner) => ({
      current: await window.ssterm.trustState({ owner }),
      wrong: await window.ssterm.trustState({
        owner: { ...owner, windowId: owner.windowId + 1 },
      }),
      extra: await (
        window.ssterm.trustState as (value: unknown) => Promise<unknown>
      )({ owner, publicKey: "must-not-pass" }),
    }),
    bootstrap.value.owner,
  );
  expect(results.current.ok).toBe(true);
  expect(results.wrong).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  expect(results.extra).toMatchObject({
    ok: false,
    error: { code: "invalid-request" },
  });
  await page.reload();
  await expect
    .poll(async () => (await page.evaluate(() => window.ssterm.bootstrap())).ok)
    .toBe(true);
  expect(
    await page.evaluate(
      (owner) => window.ssterm.trustState({ owner }),
      bootstrap.value.owner,
    ),
  ).toMatchObject({ ok: false, error: { code: "stale-owner" } });
});
