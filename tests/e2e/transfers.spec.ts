import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { ROOT, pane, setupTransferLab, snapshot, terminalState, hash, renderedContrast, chooseConflict } from "./support/transfer-fixture";

// Password input is filled from main; automatic credential-bearing traces/screenshots stay disabled.
test.use({ trace: "off", screenshot: "off", video: "off" });
const THAI = "รายงานการตรวจสอบระบบเครือข่ายประจำไตรมาสที่สี่ของปีงบประมาณ-🚀.bin";
const SIZE = 96 * 1024 * 1024;

// One owned fixture keeps all captures, cancellations and lifecycle assertions bound to the same target.
test("real UI transfers preserve hashes, queue/cancel independently, retain partials and fence reconnect/lock", async ({ desktop }, testInfo) => {
  test.setTimeout(420_000);
  const { app, page, profile } = desktop;
  const lab = await setupTransferLab(desktop);
  try {
    const local = pane(page, "local"); const remote = pane(page, "remote");
    const panel = page.getByTestId("transfer-panel");
    const job = (path: string) => panel.locator(`[data-testid="transfer-job"][data-source-path=${JSON.stringify(path)}]`);
    const localRoot = join(profile, "โฟลเดอร์สำหรับตรวจสอบการโอนไฟล์ชื่อยาวมาก");
    await mkdir(join(localRoot, "download", "elsewhere"), { recursive: true });
    const root = await realpath(localRoot);
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 137);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + Math.floor(i / 31)) & 255;
    const binary = Buffer.concat([bytes, bytes.subarray(0, 719_111)]);
    const expected = new Map([[THAI, hash(bytes)], ["binary.bin", hash(binary)], ["empty.txt", hash(Buffer.alloc(0))]]);
    for (const [name, content] of [[THAI, bytes], ["binary.bin", binary], ["empty.txt", Buffer.alloc(0)], ["existing.txt", Buffer.from("replacement")]] as const)
      await writeFile(join(root, name), content);
    await local.goto(root); await remote.goto(ROOT);
    await local.select(["existing.txt", THAI, "binary.bin", "empty.txt"]);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    // Navigate after enqueue: every job still writes to the captured folder.
    await remote.goto(`${ROOT}/elsewhere`);
    await expect(job(`${root}/existing.txt`)).toHaveAttribute("data-state", "conflict");
    await (await chooseConflict(page, job(`${root}/existing.txt`), "Skip")).getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).filter(terminalState).length, { timeout: 45_000 }).toBe(4);
    await expect(job(`${root}/existing.txt`)).toHaveAttribute("data-state", "skipped");
    expect(await lab.remoteInfo("existing.txt")).toEqual({ size: 15, hash: hash(Buffer.from("original-server")) });
    for (const [name, digest] of expected) {
      await expect(job(`${root}/${name}`)).toHaveAttribute("data-state", "completed");
      expect((await lab.remoteInfo(name))!.hash, `upload hash ${name}`).toBe(digest);
      expect(await lab.remoteInfo(`elsewhere/${name}`), "navigation never redirects an upload").toBeNull();
    }
    await expect.poll(lab.handles, { message: "completed upload handles closed" }).toBe(0);
    // Explicit existing local destination must also be preserved; unrelated downloads still complete.
    await writeFile(join(root, "download", "existing.txt"), "original-local", { mode: 0o600 });
    await remote.goto(ROOT); await local.goto(`${root}/download`);
    await remote.select(["existing.txt", THAI, "binary.bin", "empty.txt"]);
    await page.getByRole("button", { name: "Download selected files", exact: true }).click();
    await local.goto(`${root}/download/elsewhere`);
    await expect(job(`${ROOT}/existing.txt`)).toHaveAttribute("data-state", "conflict");
    await (await chooseConflict(page, job(`${ROOT}/existing.txt`), "Skip")).getByRole("button", { name: "Continue", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).filter(terminalState).length, { timeout: 45_000 }).toBe(8);
    await expect(job(`${ROOT}/existing.txt`)).toHaveAttribute("data-state", "skipped");
    expect(await readFile(join(root, "download", "existing.txt"), "utf8")).toBe("original-local");
    for (const [name, digest] of expected) {
      const destination = join(root, "download", name);
      expect(hash(await readFile(destination)), `download hash ${name}`).toBe(digest);
      expect((await stat(destination)).mode & 0o777, "new downloads use private permissions").toBe(0o600);
      await expect(job(`${ROOT}/${name}`)).toHaveAttribute("data-destination-path", destination);
    }
    expect(await readFile(join(root, "download", "empty.txt"))).toHaveLength(0);
    await expect.poll(lab.handles).toBe(0);

    // Sparse sources create enough real SFTP round trips to observe both slots and a queued job.
    for (const name of ["large-active-a.bin", "large-active-b.bin", "queued-cancel.bin", "lock-cancel.bin"]) {
      const file = await open(join(root, name), "wx", 0o600);
      try { await file.truncate(SIZE); } finally { await file.close(); }
    }
    await panel.getByRole("button", { name: "Clear finished", exact: true }).click();
    await expect(panel.getByTestId("transfer-job")).toHaveCount(0);
    await local.goto(root); await remote.goto(ROOT);
    await local.select(["large-active-a.bin", "large-active-b.bin", "queued-cancel.bin"]);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    await expect(job(`${root}/queued-cancel.bin`)).toHaveAttribute("data-state", "queued");
    await expect.poll(async () => (await snapshot(page)).filter((entry) => entry.state === "running").length).toBe(2);
    await job(`${root}/queued-cancel.bin`).getByRole("button", { name: /^Cancel / }).click();
    await expect(job(`${root}/queued-cancel.bin`)).toHaveAttribute("data-state", "cancelled");
    expect(await lab.remoteInfo("queued-cancel.bin"), "queued cancel never creates a destination").toBeNull();
    await expect.poll(async () => (await snapshot(page)).find((entry) => entry.sourcePath === `${root}/large-active-a.bin`)?.bytes ?? 0).toBeGreaterThan(0);
    const cancel = job(`${root}/large-active-a.bin`).getByRole("button", { name: /^Cancel / });
    await cancel.focus(); await page.keyboard.press("Enter");
    await expect(job(`${root}/large-active-a.bin`)).toHaveAttribute("data-state", "cancelled");
    await expect(job(`${root}/large-active-a.bin`)).toHaveAttribute("data-partial", "true");
    await expect(job(`${root}/large-active-a.bin`)).toContainText("Temporary file retained");
    await expect(cancel, "progress and final updates preserve keyboard focus").toBeFocused();
    const partialPath = (await snapshot(page)).find((entry) => entry.sourcePath === `${root}/large-active-a.bin`)!.partialPath!;
    expect(partialPath).toMatch(/\/\.ssterm-[0-9a-f-]+\.part$/u);
    const partial = await lab.remoteInfo(partialPath);
    expect(await lab.remoteInfo("large-active-a.bin"), "cancelled upload never publishes its final path").toBeNull();
    expect(partial!.size).toBeGreaterThan(0); expect(partial!.size).toBeLessThan(SIZE);
    // Disconnect cancels the other active job and releases all server handles.
    await expect(job(`${root}/large-active-b.bin`)).toHaveAttribute("data-state", "running");
    await remote.section.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(remote.section).toHaveAttribute("data-phase", "closed");
    await expect.poll(async () => (await snapshot(page)).every(terminalState)).toBe(true);
    await expect.poll(lab.handles, { timeout: 10_000 }).toBe(0);
    const beforeReconnect = await snapshot(page);
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await expect(lab.terminal, "transfer cancellation and disconnect leave the terminal live").toHaveAttribute("data-phase", "ready");
    await lab.terminal.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type('echo "TRANSFER-INDEPENDENCE-$((40+2))"'); await page.keyboard.press("Enter");
    await expect(lab.terminal.locator(".xterm-rows")).toContainText("TRANSFER-INDEPENDENCE-42");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await remote.section.getByRole("button", { name: "Reconnect", exact: true }).click(); await lab.password();
    await expect(remote.section).toHaveAttribute("data-generation", "2");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    expect(await snapshot(page), "reconnect never replays jobs").toEqual(beforeReconnect);
    expect(await lab.remoteInfo(partialPath), "cancelled stage remains unchanged").toEqual(partial);
    // Lock aborts jobs on the new generation as well.
    await local.select(["lock-cancel.bin"]);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).find((entry) => entry.sourcePath === `${root}/lock-cancel.bin`)?.bytes ?? 0).toBeGreaterThan(0);
    await app.evaluate(({ powerMonitor }) => { powerMonitor.emit("lock-screen"); });
    await expect(remote.section).toHaveAttribute("data-phase", "closed");
    await expect.poll(async () => (await snapshot(page)).every(terminalState)).toBe(true);
    await expect(job(`${root}/lock-cancel.bin`)).toHaveAttribute("data-partial", "true");
    await expect.poll(lab.handles, { timeout: 10_000 }).toBe(0);
    await remote.section.getByRole("button", { name: "Reconnect", exact: true }).click(); await lab.password();
    await expect(remote.section).toHaveAttribute("data-generation", "3");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });

    // An explicit fixture-only screenshot: Thai and full captured paths, operational state and PROD are legible.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
    await expect(panel).toBeVisible();
    await expect(panel.getByText("PROD", { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth), "queue fits minimum window width").toBe(true);
    await testInfo.attach("transfers-960x640-thai-reduced-motion", { body: await page.screenshot(), contentType: "image/png" });
    const contrasts: Record<string, unknown> = {};
    for (const [label, locator] of [
      ["Queue warning", panel.locator(".transfer-warning")],
      ["Job primary text", panel.locator(".transfer-job-heading .type-label").first()],
      ["Job error", panel.locator(".transfer-error").first()],
      ["PROD badge", panel.getByText("PROD", { exact: true }).first()],
    ] as const) {
      const measured = await renderedContrast(locator);
      contrasts[label] = measured;
      expect(measured.ratio, `${label} against its rendered surface`).toBeGreaterThanOrEqual(4.5);
    }
    await testInfo.attach("transfers-rendered-contrast", { body: JSON.stringify(contrasts, null, 2), contentType: "application/json" });
    // The terminal was also closed by lock; reconnect explicitly and prove input remains usable beside SFTP.
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await lab.terminal.getByRole("button", { name: "Reconnect", exact: true }).click(); await lab.password();
    await expect(lab.terminal).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await lab.terminal.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type('echo "AFTER-TRANSFERS-$((40+2))"'); await page.keyboard.press("Enter");
    await expect(lab.terminal.locator(".xterm-rows")).toContainText("AFTER-TRANSFERS-42");
    expect(desktop.errors).toEqual([]); expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("transfers-runtime-evidence", { body: JSON.stringify({
      platform: process.platform, port: lab.fixture.port, unicodeBytes: bytes.length, binaryBytes: binary.length,
      uploadAndDownloadHashes: Object.fromEntries(expected), partialBytes: partial!.size,
      finalJobs: (await snapshot(page)).map(({ state, bytes, partial, generation }) => ({ state, bytes, partial, generation })),
    }), contentType: "application/json" });
  } finally { await lab.finish(); }
});
