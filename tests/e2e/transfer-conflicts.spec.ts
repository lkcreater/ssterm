import { mkdir, open, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { ROOT, LABEL, pane, setupTransferLab, snapshot, hash, renderedContrast, chooseConflict } from "./support/transfer-fixture";

// Credentials remain main-only fixture inputs; attach screenshots only at explicit empty-input points.
test.use({ trace: "off", screenshot: "off", video: "off" });
const OVERWRITE = "เขียนทับรายงานการตรวจสอบระบบเครือข่ายประจำไตรมาสที่สี่-🚀.bin";
const RENAMED = "รายงานชื่อใหม่สำหรับตรวจสอบการโอนไฟล์-🚀.bin";
const SIZE = 96 * 1024 * 1024;
const sourceBytes = Buffer.alloc(1_048_713);
for (let i = 0; i < sourceBytes.length; i++) sourceBytes[i] = (i * 31 + Math.floor(i / 53)) & 255;
const OLD = Buffer.from("original-destination-must-survive-until-publish");
const sourceHash = hash(sourceBytes); const oldHash = hash(OLD);
const queue = (page: Page) => page.getByTestId("transfer-panel");
const row = (page: Page, source: string) => queue(page).locator(`[data-testid="transfer-job"][data-source-path=${JSON.stringify(source)}]`).last();
// SST-040/05: the conflict decision is a drawer; Overwrite's confirmation is a step inside it.
const dialog = (page: Page) => page.getByTestId("transfer-conflict-drawer");
const step = (page: Page) => page.getByTestId("transfer-overwrite-confirm");

async function overwrite(page: Page, entry: Locator) {
  const drawer = await chooseConflict(page, entry, "Overwrite");
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(step(page)).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await drawer.getByRole("button", { name: "Replace file", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}
async function skip(page: Page, entry: Locator) {
  await (await chooseConflict(page, entry, "Skip")).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}
async function rename(page: Page, entry: Locator, name: string) {
  const drawer = await chooseConflict(page, entry, "Rename");
  const input = drawer.getByRole("textbox", { name: "New filename", exact: true });
  await input.fill("../outside");
  await input.press("Enter");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(entry).toHaveAttribute("data-state", "conflict");
  await input.fill(name);
  await drawer.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
}
async function staleDecision(page: Page, jobId: string, conflictId: string) {
  return page.evaluate(async ({ jobId, conflictId }) => {
    const b = await window.ssterm.bootstrap(); if (!b.ok) throw new Error("Bootstrap unavailable");
    return window.ssterm.resolveTransferConflict({ owner: b.value.owner, jobId, conflictId, decision: "skip", name: null });
  }, { jobId, conflictId });
}
async function retry(page: Page, jobId: string) {
  return page.evaluate(async (jobId) => {
    const b = await window.ssterm.bootstrap(); if (!b.ok) throw new Error("Bootstrap unavailable");
    return window.ssterm.retryTransfer({ owner: b.value.owner, jobId });
  }, jobId);
}

// All real decisions operate on disposable files in a new owned OpenSSH container and local test profile.
test("conflict UI captures Overwrite, Skip and Rename for upload and download with old/new hash integrity", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const { app, page, profile } = desktop;
  const lab = await setupTransferLab(desktop);
  try {
    const folder = join(profile, "ตรวจสอบความขัดแย้งของชื่อไฟล์");
    await mkdir(join(folder, "download", "elsewhere"), { recursive: true });
    const root = await realpath(folder); const download = `${root}/download`;
    const local = pane(page, "local"); const remote = pane(page, "remote");
    const names = [OVERWRITE, "skip.bin", "rename.bin", "independent-a.bin", "independent-b.bin"];
    for (const name of names) await writeFile(join(root, name), sourceBytes, { mode: 0o600 });
    await lab.python(`import base64\nr=${JSON.stringify(ROOT)}\nold=base64.b64decode(${JSON.stringify(OLD.toString("base64"))})\nfor n in ${JSON.stringify(names.slice(0, 3))}: open(r+'/'+n,'wb').write(old)`);
    await local.goto(root); await remote.goto(ROOT); await local.select(names);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).filter((job) => job.state === "conflict").length).toBe(3);
    await expect.poll(async () => (await snapshot(page)).filter((job) => job.state === "completed").length, { timeout: 30_000 }).toBe(2);
    expect(await lab.stages(), "waiting conflicts and completed jobs hold no staging files").toEqual([]);
    expect(await lab.handles(), "conflict waits own no source/destination handles").toBe(0);
    for (const name of names.slice(0, 3)) expect((await lab.remoteInfo(name))!.hash).toBe(oldHash);
    const captured = (await snapshot(page)).find((job) => job.sourcePath === `${root}/${OVERWRITE}`)!;
    expect(captured.atomicReplace, "owned OpenSSH advertises posix-rename").toBe(true);
    expect((await staleDecision(page, captured.id, "stale-nonce")).ok).toBe(false);
    await expect(row(page, `${root}/${OVERWRITE}`)).toHaveAttribute("data-state", "conflict");

    // The confirm step names the captured PROD target and destination; Cancel is the initial keyboard action.
    const opener = row(page, `${root}/${OVERWRITE}`).getByRole("button", { name: /^Resolve conflict for / });
    await (await chooseConflict(page, row(page, `${root}/${OVERWRITE}`), "Overwrite")).getByRole("button", { name: "Continue", exact: true }).click();
    await expect(step(page)).toHaveAttribute("role", "alert");
    await expect(page.getByRole("dialog"), "the confirmation is a step, not a stacked overlay").toHaveCount(1);
    await expect(dialog(page)).toContainText(LABEL);
    await expect(dialog(page)).toContainText(`${ROOT}/${OVERWRITE}`);
    await expect(dialog(page).getByText("PROD", { exact: true })).toBeVisible();
    const cancel = dialog(page).getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeFocused();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
    await expect.poll(() => dialog(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await dialog(page).evaluate((node) => { const box = node.getBoundingClientRect(); return { right: Math.abs(innerWidth - box.right) <= 0.5, bottom: Math.abs(innerHeight - box.bottom) <= 0.5 }; }), "right-edge drawer below the titlebar").toEqual({ right: true, bottom: true });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await testInfo.attach("transfer-overwrite-confirm-960x640-thai", { body: await page.screenshot(), contentType: "image/png" });
    const contrasts: Record<string, unknown> = {};
    for (const [label, element] of [
      ["Confirm title", step(page).getByRole("heading")],
      ["Confirm description", page.getByTestId("transfer-overwrite-description")],
      ["Confirm Cancel", cancel],
      ["Confirm Replace", dialog(page).getByRole("button", { name: "Replace file", exact: true })],
      ["Confirm PROD", dialog(page).getByText("PROD", { exact: true })],
    ] as const) {
      const measured = await renderedContrast(element); contrasts[label] = measured;
      expect(measured.ratio, label).toBeGreaterThanOrEqual(4.5);
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      await expect.poll(() => dialog(page).evaluate((node) => node.contains(document.activeElement)), "confirm traps keyboard focus").toBe(true);
    }
    // Cancel leaves the step, not the drawer; Esc then closes the drawer and focus returns to its opener.
    await cancel.click(); await expect(step(page)).toHaveCount(0);
    await expect(dialog(page).getByRole("button", { name: "Continue", exact: true })).toBeFocused();
    await page.keyboard.press("Escape"); await expect(dialog(page)).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect((await lab.remoteInfo(OVERWRITE))!.hash, "dismissing confirmation changes no file").toBe(oldHash);
    // Navigation does not change any captured conflict destination or rename directory.
    await remote.goto(`${ROOT}/elsewhere`);
    await overwrite(page, row(page, `${root}/${OVERWRITE}`));
    await skip(page, row(page, `${root}/skip.bin`));
    await rename(page, row(page, `${root}/rename.bin`), RENAMED);
    for (const name of [OVERWRITE, "rename.bin"]) await expect(row(page, `${root}/${name}`)).toHaveAttribute("data-state", "completed", { timeout: 30_000 });
    await expect(row(page, `${root}/skip.bin`)).toHaveAttribute("data-state", "skipped");
    expect((await staleDecision(page, captured.id, captured.conflictId!)).ok, "duplicate completed decision is rejected").toBe(false);
    expect((await lab.remoteInfo(OVERWRITE))!.hash).toBe(sourceHash);
    expect((await lab.remoteInfo("skip.bin"))!.hash).toBe(oldHash);
    expect((await lab.remoteInfo("rename.bin"))!.hash).toBe(oldHash);
    expect((await lab.remoteInfo(RENAMED))!.hash).toBe(sourceHash);
    expect(await lab.remoteInfo(`elsewhere/${RENAMED}`)).toBeNull();
    expect(await lab.stages(), "successful publications remove their stages").toEqual([]);

    // Repeat all three decisions for a remote source and local destination.
    const downNames = ["download-overwrite.bin", "download-skip.bin", "download-rename.bin", "download-independent-a.bin", "download-independent-b.bin"];
    await lab.python(`r=${JSON.stringify(ROOT)}\ndata=bytes((i*31+i//53)&255 for i in range(${sourceBytes.length}))\nfor n in ${JSON.stringify(downNames)}: open(r+'/'+n,'wb').write(data)`);
    for (const name of downNames.slice(0, 3)) await writeFile(join(download, name), OLD, { mode: 0o600 });
    await remote.goto(ROOT); await local.goto(download); await remote.select(downNames);
    await page.getByRole("button", { name: "Download selected files", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).filter((job) => job.state === "conflict").length).toBe(3);
    await expect(row(page, `${ROOT}/download-independent-b.bin`)).toHaveAttribute("data-state", "completed", { timeout: 30_000 });
    await local.goto(`${download}/elsewhere`);
    await overwrite(page, row(page, `${ROOT}/download-overwrite.bin`));
    await skip(page, row(page, `${ROOT}/download-skip.bin`));
    await rename(page, row(page, `${ROOT}/download-rename.bin`), `ดาวน์โหลด-${RENAMED}`);
    await expect(row(page, `${ROOT}/download-overwrite.bin`)).toHaveAttribute("data-state", "completed", { timeout: 30_000 });
    await expect(row(page, `${ROOT}/download-rename.bin`)).toHaveAttribute("data-state", "completed", { timeout: 30_000 });
    expect(hash(await readFile(join(download, "download-overwrite.bin")))).toBe(sourceHash);
    expect(hash(await readFile(join(download, "download-skip.bin")))).toBe(oldHash);
    expect(hash(await readFile(join(download, "download-rename.bin")))).toBe(oldHash);
    expect(hash(await readFile(join(download, `ดาวน์โหลด-${RENAMED}`)))).toBe(sourceHash);
    expect((await readdir(download)).filter((name) => name.startsWith(".ssterm-"))).toEqual([]);
    expect(await readdir(join(download, "elsewhere")), "navigation never redirects a renamed publication").toEqual([]);

    // Equal lexical paths identify distinct endpoints, so they are valid local↔remote transfers.
    await writeFile(join(root, "same-path.txt"), "same-path-content", { mode: 0o600 });
    await lab.samePathDirectory(root);
    await local.goto(root); await remote.goto(root); await local.select(["same-path.txt"]);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    await expect(row(page, `${root}/same-path.txt`)).toHaveAttribute("data-state", "completed", { timeout: 30_000 });
    expect((await lab.remoteInfo(`${root}/same-path.txt`))!.hash).toBe(hash(Buffer.from("same-path-content")));
    await expect.poll(lab.handles).toBe(0);
    expect(desktop.errors).toEqual([]); expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("transfer-conflict-integrity", { body: JSON.stringify({ sourceHash, oldHash, sourceBytes: sourceBytes.length,
      uploadDecisions: ["overwrite", "skip", "rename"], downloadDecisions: ["overwrite", "skip", "rename"],
      noStagesAfterSuccess: true, conflictWorkerSlotsReleased: true, sameLexicalPath: true, contrasts,
      platform: process.platform, viewport: [960, 640], reducedMotion: true }), contentType: "application/json" });
  } finally { await lab.finish(); }
});

test("cancelled overwrites keep old files and retained stages; permission retry is fresh and reconnect never replays", async ({ desktop }, testInfo) => {
  test.setTimeout(300_000);
  const { app, page, profile } = desktop;
  const lab = await setupTransferLab(desktop);
  const folder = join(profile, "เก็บไฟล์บางส่วนเมื่อยกเลิกการเขียนทับ");
  try {
    await mkdir(join(folder, "download"), { recursive: true });
    const root = await realpath(folder); const download = `${root}/download`;
    const local = pane(page, "local"); const remote = pane(page, "remote");
    const large = await open(join(root, "cancel-overwrite.bin"), "wx", 0o600);
    try { await large.truncate(SIZE); } finally { await large.close(); }
    await lab.python(`import os,base64\nr=${JSON.stringify(ROOT)}\nold=base64.b64decode(${JSON.stringify(OLD.toString("base64"))})\nopen(r+'/cancel-overwrite.bin','wb').write(old)\nf=open(r+'/download-cancel.bin','wb');f.truncate(${SIZE});f.close()\nos.makedirs(r+'/permission')\nopen(r+'/permission/permission.bin','wb').write(old)\nos.chmod(r+'/permission',0o500)`);
    await local.goto(root); await remote.goto(ROOT); await local.select(["cancel-overwrite.bin"]);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    const uploadRow = row(page, `${root}/cancel-overwrite.bin`);
    await expect(uploadRow).toHaveAttribute("data-state", "conflict"); await overwrite(page, uploadRow);
    await expect.poll(async () => (await snapshot(page)).find((job) => job.sourcePath === `${root}/cancel-overwrite.bin`)!.bytes).toBeGreaterThan(0);
    expect((await lab.remoteInfo("cancel-overwrite.bin"))!.hash, "old final survives active staging").toBe(oldHash);
    await uploadRow.getByRole("button", { name: /^Cancel upload / }).click();
    await expect(uploadRow).toHaveAttribute("data-state", "cancelled");
    const cancelled = (await snapshot(page)).find((job) => job.sourcePath === `${root}/cancel-overwrite.bin`)!;
    expect(cancelled.partial).toBe(true); expect(cancelled.partialPath).toMatch(/\/\.ssterm-[0-9a-f-]+\.part$/u);
    await expect(uploadRow).toHaveAttribute("data-partial-path", cancelled.partialPath!);
    await expect(uploadRow).toContainText(cancelled.partialPath!);
    expect((await lab.remoteInfo("cancel-overwrite.bin"))!.hash).toBe(oldHash);
    const uploadStage = await lab.remoteInfo(cancelled.partialPath!);
    expect(uploadStage!.size).toBeGreaterThan(0); expect(uploadStage!.size).toBeLessThan(SIZE);
    await expect.poll(lab.handles).toBe(0);

    // Download cancellation follows the same staging policy and cannot truncate the existing local file.
    await writeFile(join(download, "download-cancel.bin"), OLD, { mode: 0o600 });
    await local.goto(download); await remote.select(["download-cancel.bin"]);
    await page.getByRole("button", { name: "Download selected files", exact: true }).click();
    const downloadRow = row(page, `${ROOT}/download-cancel.bin`);
    await expect(downloadRow).toHaveAttribute("data-state", "conflict"); await overwrite(page, downloadRow);
    await expect.poll(async () => (await snapshot(page)).find((job) => job.sourcePath === `${ROOT}/download-cancel.bin`)!.bytes).toBeGreaterThan(0);
    expect(hash(await readFile(join(download, "download-cancel.bin")))).toBe(oldHash);
    await downloadRow.getByRole("button", { name: /^Cancel download / }).click();
    await expect(downloadRow).toHaveAttribute("data-state", "cancelled");
    const downloadCancelled = (await snapshot(page)).find((job) => job.sourcePath === `${ROOT}/download-cancel.bin`)!;
    const downloadStage = downloadCancelled.partialPath!;
    expect((await stat(downloadStage)).size).toBeGreaterThan(0);
    expect((await stat(downloadStage)).mode & 0o777).toBe(0o600);
    expect(hash(await readFile(join(download, "download-cancel.bin")))).toBe(oldHash);
    await expect(downloadRow).toContainText(downloadStage);

    // Clearing process history removes rows but deliberately leaves both user-visible stage files on disk.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
    await expect.poll(() => queue(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    const retainedPath = uploadRow.locator(".transfer-paths dd").last();
    await retainedPath.scrollIntoViewIfNeeded();
    await expect(retainedPath, "the actual retained stage is visible in the evidence").toBeInViewport();
    await testInfo.attach("retained-transfer-stages-960x640", { body: await page.screenshot(), contentType: "image/png" });
    const partialContrast = await renderedContrast(retainedPath);
    expect(partialContrast.ratio, "retained stage path contrast").toBeGreaterThanOrEqual(4.5);
    await queue(page).getByRole("button", { name: "Clear finished", exact: true }).click();
    await expect(queue(page).getByTestId("transfer-job")).toHaveCount(0);
    expect(await lab.remoteInfo(cancelled.partialPath!)).toEqual(uploadStage);
    expect((await stat(downloadStage)).size).toBeGreaterThan(0);

    // A permission failure leaves its old destination intact; a later Retry creates a fresh job.
    await writeFile(join(root, "permission.bin"), sourceBytes, { mode: 0o600 });
    await writeFile(join(root, "unrelated.bin"), sourceBytes, { mode: 0o600 });
    await writeFile(join(root, "missing-source.bin"), sourceBytes, { mode: 0o600 });
    await local.goto(root); await remote.goto(`${ROOT}/permission`); await local.select(["permission.bin"]);
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    await expect(row(page, `${root}/permission.bin`)).toHaveAttribute("data-state", "conflict");
    const originalNonce = (await snapshot(page)).find((job) => job.sourcePath === `${root}/permission.bin`)!.conflictId;
    await overwrite(page, row(page, `${root}/permission.bin`));
    await expect(row(page, `${root}/permission.bin`)).toHaveAttribute("data-state", "failed");
    const failed = (await snapshot(page)).find((job) => job.sourcePath === `${root}/permission.bin`)!;
    expect(failed.error).toBe("permission-denied");
    expect((await lab.remoteInfo("permission/permission.bin"))!.hash).toBe(oldHash);
    await remote.goto(ROOT); await local.select(["unrelated.bin", "missing-source.bin"]);
    await unlink(join(root, "missing-source.bin"));
    await page.getByRole("button", { name: "Upload selected files", exact: true }).click();
    await expect(row(page, `${root}/unrelated.bin`)).toHaveAttribute("data-state", "completed", { timeout: 30_000 });
    await expect(row(page, `${root}/missing-source.bin`)).toHaveAttribute("data-state", "failed");
    expect((await snapshot(page)).find((job) => job.sourcePath === `${root}/missing-source.bin`)!.error).toBe("not-found");
    await lab.python(`import os\nos.chmod(${JSON.stringify(`${ROOT}/permission`)},0o700)`);
    await row(page, `${root}/permission.bin`).getByRole("button", { name: "Retry", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).filter((job) => job.sourcePath === `${root}/permission.bin`).length).toBe(2);
    await expect(row(page, `${root}/permission.bin`)).toHaveAttribute("data-state", "conflict");
    const retried = (await snapshot(page)).filter((job) => job.sourcePath === `${root}/permission.bin`).at(-1)!;
    expect(retried.id).not.toBe(failed.id); expect(retried.generation).toBe(failed.generation);
    // Retry retains the captured destination path and requires fresh overwrite consent.
    expect(retried.destinationPath).toBe(failed.destinationPath);
    expect(retried.conflictId).not.toBe(originalNonce);
    await overwrite(page, row(page, `${root}/permission.bin`));
    await expect(row(page, `${root}/permission.bin`)).toHaveAttribute("data-state", "completed", { timeout: 30_000 });
    expect((await lab.remoteInfo("permission/permission.bin"))!.hash).toBe(sourceHash);
    await remote.section.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(remote.section).toHaveAttribute("data-phase", "closed");
    const before = await snapshot(page);
    await remote.section.getByRole("button", { name: "Reconnect", exact: true }).click(); await lab.password();
    await expect(remote.section).toHaveAttribute("data-generation", "2");
    await expect(remote.section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    expect((await retry(page, failed.id)).ok, "retry never silently moves a captured job to a new generation").toBe(false);
    expect(await snapshot(page), "reconnect never automatically retries or resumes").toEqual(before);
    expect(await lab.remoteInfo(cancelled.partialPath!)).toEqual(uploadStage);
    await expect.poll(lab.handles).toBe(0);
    expect(desktop.errors).toEqual([]); expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("transfer-retention-and-retry", { body: JSON.stringify({ oldHash, sourceHash,
      uploadStage: { basename: basename(cancelled.partialPath!), bytes: uploadStage!.size },
      downloadStage: { basename: basename(downloadStage), bytes: (await stat(downloadStage)).size },
      stagesSurviveClear: true, retryJobIdChanged: failed.id !== retried.id, staleRetryRejected: true, partialContrast,
      realFailures: ["permission-denied", "not-found", "cancelled"], fakeOnlyFailures: ["quota-exceeded", "no-space", "unsupported", "publication-unknown"],
      platform: process.platform, viewport: [960, 640], reducedMotion: true }), contentType: "application/json" });
  } finally {
    await lab.finish();
  }
});
