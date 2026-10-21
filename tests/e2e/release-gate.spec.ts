import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop } from "./fixtures";

// SST-027 / DS05 release-quality sweep (design-system.md §11) over every page with a populated fixture catalog.
test.use({ trace: "off", video: "off" });

interface Finding { page: string; size: string; kind: string; detail: string }
const SIZES = [[960, 640], [1280, 800]] as const;

/**
 * In-page audit of what is rendered now: visible text contrast (4.5:1, or 3:1 for large text), accessible names for
 * interactive controls, horizontal overflow, and reduced-motion effectiveness. Disabled controls and placeholders are
 * exempt from contrast (WCAG 1.4.3). Backgrounds are composited through ancestors on a canvas, as in other specs.
 */
async function audit(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const background = (element: Element) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(document.documentElement).backgroundColor || "#000";
      context.fillRect(0, 0, 1, 1);
      const chain: Element[] = [];
      for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node);
      for (const node of chain) {
        context.fillStyle = getComputedStyle(node).backgroundColor;
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const luminance = (value: number[]) => value.slice(0, 3).map((part) => {
      const channel = part / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index]!, 0);
    const blend = (top: number[], bottom: number[]) => {
      const alpha = top[3]! / 255;
      return [0, 1, 2].map((index) => top[index]! * alpha + bottom[index]! * (1 - alpha)).concat(255);
    };
    const ratio = (a: number[], b: number[]) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (light! + 0.05) / (dark! + 0.05);
    };
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return false;
      for (let node: Element | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
        if ((node as HTMLElement).inert) return false;
      }
      return box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
    };
    const describe = (element: Element) => {
      const id = element.id ? `#${element.id}` : "";
      const test = element.closest("[data-testid]")?.getAttribute("data-testid");
      return `${element.tagName.toLowerCase()}${id}${test ? ` in ${test}` : ""} "${(element.textContent ?? "").trim().slice(0, 40)}"`;
    };
    const findings: { kind: string; detail: string }[] = [];
    let checked = 0;
    for (const element of document.querySelectorAll("body *")) {
      if (element.closest(".xterm, svg, [aria-hidden='true'], .sr-only")) continue;
      const own = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
      if (!own || !visible(element)) continue;
      if (element.closest(":disabled, [aria-disabled='true'], [data-disabled]")) continue;
      const style = getComputedStyle(element);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const back = background(element);
      const fore = blend(rgba(style.color), back);
      const value = ratio(fore, back);
      checked += 1;
      if (value < (large ? 3 : 4.5)) findings.push({ kind: "contrast", detail: `${describe(element)} ${value.toFixed(2)}:1` });
    }
    const controls = "button, a[href], input, textarea, select, [role='button'], [role='tab'], [role='menuitem'], [role='combobox'], [role='switch'], [role='checkbox'], [role='separator'][tabindex]";
    for (const element of document.querySelectorAll(controls)) {
      if (!visible(element) || element.closest(".xterm, [aria-hidden='true']")) continue;
      // Form-library mirrors (e.g. Base UI's hidden select input) are neither focusable nor exposed.
      if (element.getAttribute("tabindex") === "-1" && element.getAttribute("aria-hidden") === "true") continue;
      const labelledby = element.getAttribute("aria-labelledby");
      const labelText = labelledby ? labelledby.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "").join("") : "";
      const label = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent ?? "" : "";
      const name = [element.getAttribute("aria-label"), labelText, label, (element as HTMLElement).innerText, element.getAttribute("title"),
        (element as HTMLInputElement).placeholder].some((text) => text && text.trim());
      if (!name) findings.push({ kind: "name", detail: describe(element) });
    }
    const workspace = document.querySelector(".app-workspace")!;
    const overflow = [workspace, ...workspace.querySelectorAll(".catalog-page, .workspace-page, [data-testid$='-page'], [data-testid='team-workspace']")]
      .filter((node) => visible(node) && node.scrollWidth - node.clientWidth > 1).map((node) => describe(node));
    for (const detail of overflow) findings.push({ kind: "overflow", detail });
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced)
      for (const element of document.querySelectorAll("body *")) {
        const style = getComputedStyle(element);
        const seconds = (value: string) => Math.max(...value.split(",").map((part) => parseFloat(part) * (part.trim().endsWith("ms") ? 0.001 : 1)));
        if (style.animationName !== "none" && seconds(style.animationDuration) > 0.01)
          findings.push({ kind: "motion", detail: `${describe(element)} ${style.animationName} ${style.animationDuration}` });
      }
    return { findings, checked };
  });
}

/** Tab through the page: every focused control shows an indicator (outline or ring shadow) of at least 3:1. */
async function focusAudit(page: Page, presses = 25) {
  const findings: string[] = [];
  let reached = 0;
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Tab");
    const result = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body || element.closest(".xterm")) return null;
      const style = getComputedStyle(element);
      const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      const ring = style.boxShadow !== "none" && style.boxShadow !== "";
      return { name: `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.innerText ?? "").trim().slice(0, 30)}"`,
        indicated: outline || ring, outline, ring };
    });
    if (!result) continue;
    reached += 1;
    if (!result.indicated) findings.push(result.name);
  }
  return { findings, reached };
}

test("DS05 release sweep: every page at 960×640 and 1280×800 with reduced motion — contrast, names, overflow, focus", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  // A populated, Thai-heavy catalog (no network): groups, PROD and DEV servers, tags, identities, rules, snippets.
  const ids = await changeCatalog(app, [
    { type: "create-group", data: { label: "โครงสร้างพื้นฐาน การผลิต", port: { mode: "value", port: 2222 } } },
    { type: "create-identity", data: { label: "ผู้ดูแลระบบ", username: "admin", method: "password" } },
    { type: "create-host", data: { label: "ฐานข้อมูลหลัก ระบบการเงินภาคตะวันออกเฉียงเหนือ", address: "db-01.internal.example", groupId: "$0", environment: "PROD", auth: { mode: "value", identityId: "$1" } } },
    { type: "create-host", data: { label: "Staging web", address: "10.0.0.12", environment: "STAGING" } },
    { type: "create-host", data: { label: "Dev box", address: "dev.example", environment: "DEV" } },
    { type: "create-tag", data: { label: "ฐานข้อมูล" } },
    { type: "set-host-tag", hostId: "$2", tagId: "$5", present: true, expectedHostRevision: "current" },
    { type: "create-tunnel-rule", data: { label: "Postgres ผ่านเซิร์ฟเวอร์", hostId: "$2", bindPort: 15432, destinationHost: "127.0.0.1", destinationPort: 5432 } },
  ]);
  expect(ids.every((value, index) => index === 6 || typeof value === "string")).toBe(true);
  await page.reload();
  await page.evaluate(async () => {
    const boot = await window.ssterm.bootstrap();
    if (!boot.ok) throw new Error("bootstrap");
    for (const [label, body] of [["รีสตาร์ทบริการ", "sudo systemctl restart app\n"], ["Disk usage", "df -h"]])
      await window.ssterm.saveSnippet({ owner: boot.value.owner, snippetId: null, expectedRevision: null, label, body, tagIds: [] });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });

  const pages: { name: string; open(): Promise<void> }[] = [
    { name: "servers", open: async () => {
      await page.getByRole("button", { name: /^All servers/u }).click();
      await page.getByTestId("hosts-page").locator("button[data-host-id]").first().click();
    } },
    { name: "identities", open: () => page.getByRole("button", { name: "Identities", exact: true }).click() },
    { name: "snippets", open: async () => {
      await page.getByRole("button", { name: "Snippets", exact: true }).click();
      await page.getByTestId("snippets-page").locator("button[data-snippet-id]").first().click();
      await expect(page.getByTestId("snippet-editor").getByLabel("Script")).toBeVisible();
    } },
    { name: "port-forwarding", open: () => page.getByRole("button", { name: /^Port forwarding/u }).click() },
    { name: "known-hosts", open: () => page.getByRole("button", { name: "Known hosts", exact: true }).click() },
    { name: "files", open: () => page.getByRole("button", { name: "Files", exact: true }).click() },
    // SST-034: the Recordings page (empty logs, shell-integration snippet and matrix); Settings › Recording is audited
    // with the Settings dialog below.
    { name: "recordings", open: async () => {
      await page.getByRole("button", { name: "Recordings", exact: true }).click();
      await expect(page.getByTestId("recordings-page").getByRole("table")).toBeVisible();
    } },
    { name: "team-vault", open: async()=>{await page.getByRole("button",{name:"Team vault",exact:true}).click();await expect(page.getByTestId("team-workspace").getByRole("button",{name:"Create encrypted team",exact:true})).toBeVisible();} },
    { name: "terminals-empty", open: () => page.getByRole("button", { name: /^Terminals/u }).click() },
  ];
  const findings: Finding[] = [];
  const matrix: Record<string, { checked: number; focusReached?: number }> = {};
  for (const [width, height] of SIZES) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size[0], size[1]), [width, height] as const);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
    const size = `${width}x${height}`;
    for (const view of pages) {
      await view.open();
      await page.waitForTimeout(150);
      const result = await audit(page);
      matrix[`${view.name}@${size}`] = { checked: result.checked };
      findings.push(...result.findings.map((finding) => ({ page: view.name, size, ...finding })));
      if (width === 960) {
        const focus = await focusAudit(page);
        matrix[`${view.name}@${size}`]!.focusReached = focus.reached;
        findings.push(...focus.findings.map((detail) => ({ page: view.name, size, kind: "focus", detail })));
      }
      await page.screenshot({ path: testInfo.outputPath(`${view.name}-${size}.png`) });
    }
    // Dialogs: Settings and Keyboard shortcuts, then Esc returns focus to the opener.
    for (const [name, dialog] of [["Settings", "settings"], ["Keyboard shortcuts", "shortcuts"]] as const) {
      const opener = page.getByRole("button", { name: new RegExp(`^${name}`, "u") }).last();
      await opener.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      // Let the open transition settle (0.01 ms under reduced motion, plus a frame).
      await page.waitForTimeout(250);
      const result = await audit(page);
      expect(result.checked, `${name} dialog text was audited`).toBeGreaterThan(3);
      matrix[`${dialog}-dialog@${size}`] = { checked: result.checked };
      findings.push(...result.findings.map((finding) => ({ page: `${dialog}-dialog`, size, ...finding })));
      if (dialog === "settings") {
        // The Recording section sits below the fold of the scrolling dialog.
        await page.getByTestId("recording-settings").scrollIntoViewIfNeeded();
        await expect(page.getByTestId("recording-settings").getByRole("switch", { name: "Record session output" })).not.toBeChecked();
        const recording = await audit(page);
        matrix[`settings-recording@${size}`] = { checked: recording.checked };
        findings.push(...recording.findings.map((finding) => ({ page: "settings-recording", size, ...finding })));
        await page.getByRole("dialog").getByRole("heading", { name: "Settings" }).scrollIntoViewIfNeeded();
      }
      await page.screenshot({ path: testInfo.outputPath(`${dialog}-dialog-${size}.png`) });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(opener, `${name} dialog returns focus to its opener`).toBeFocused();
    }
  }
  await testInfo.attach("release-sweep", { body: JSON.stringify({ matrix, findings }, null, 2), contentType: "application/json" });
  expect(findings).toEqual([]);
  expect(desktop.errors).toEqual([]);
});

test("storage denial: an unwritable workspace folder opens with a sanitized blocked state and no data shown", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-unwritable-"));
  const metadata = join(profile, "metadata");
  await mkdir(metadata, { mode: 0o700 });
  await writeFile(join(metadata, "catalog.sqlite"), "");
  await chmod(join(metadata, "catalog.sqlite"), 0o400);
  await chmod(metadata, 0o500);
  const desktop = await launchDesktop(profile);
  try {
    await expect(desktop.page.getByText("Workspace is unavailable")).toBeVisible();
    const text = await desktop.page.locator("body").innerText();
    expect(text).not.toContain(profile);
    expect(text).not.toMatch(/SQLITE|EACCES|errno/iu);
    await expect(desktop.page.getByRole("button", { name: "Snippets", exact: true })).toBeDisabled();
    await expect(desktop.page.getByRole("button", { name: /^Port forwarding/u })).toBeDisabled();
  } finally {
    await desktop.close();
    await chmod(metadata, 0o700).catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

test("keyboard-interactive sign-in against the real OpenSSH/PAM fixture through the production Connect path", async ({ desktop }) => {
  test.setTimeout(120_000);
  const { createRequire } = await import("node:module");
  const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
  const { app, page } = desktop;
  const lab = await startFixture();
  try {
    // Main reads the answer from the lab's private directory, so the value never crosses Playwright.
    const secretFile = join(lab.directory, "kbd-answer");
    await writeFile(secretFile, lab.password, { mode: 0o600 });
    await changeCatalog(app, [
      { type: "create-identity", data: { label: "PAM challenge", username: lab.username, method: "keyboard-interactive" } },
      { type: "create-host", data: { label: "PAM server", address: lab.host, port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();
    await page.getByTestId("hosts-page").locator("button[data-host-id]", { hasText: "PAM server" }).click();
    await page.getByTestId("host-detail").getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    const prompt = page.getByTestId("credential-prompt-dialog");
    await expect(prompt).toBeVisible();
    // PAM sends one non-echoing field; the server's own prompt text never reaches the UI.
    await expect(prompt.locator("input")).toHaveCount(1);
    await expect(prompt.locator("input")).toHaveAttribute("type", "password");
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }, file) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(() => {
        const inputs = [...document.querySelectorAll('[data-testid="credential-prompt-dialog"] input')];
        if (inputs.length !== 1 || inputs[0].disabled) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], ${JSON.stringify(value)});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true; })()`);
    }, secretFile)).toBe(true);
    await prompt.getByRole("button", { name: "Continue" }).click();
    const pane = page.locator("section[data-session-id]").first();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await expect(pane.locator(".xterm-rows")).toContainText("fixture@");
    expect(await page.locator("body").innerText()).not.toContain(lab.password);
    expect(desktop.errors).toEqual([]);
  } finally {
    await desktop.close();
    lab.privateKey.fill(0);
    await lab.dispose();
    await lab.assertCleaned();
  }
});
