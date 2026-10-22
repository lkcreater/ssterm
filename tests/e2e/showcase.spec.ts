import { test, expect } from "./fixtures";

test("showcases semantic colors, state independence, Thai text and both desktop sizes", async ({
  desktop,
}, testInfo) => {
  const { app, page, errors, externalRequests } = desktop;
  await expect(
    page.getByRole("heading", { name: "ssterm component showcase" }),
  ).toBeVisible();
  const pairs = page.locator("[data-color-pair]");
  await expect(pairs).toHaveCount(12);
  await expect
    .poll(() =>
      pairs.evaluateAll((items) =>
        items.every(
          (item) => Number(item.getAttribute("data-contrast-ratio")) > 0,
        ),
      ),
    )
    .toBe(true);
  const contrasts = await pairs.evaluateAll((items) =>
    items.map((item) => ({
      name: item.getAttribute("data-color-pair"),
      ratio: Number(item.getAttribute("data-contrast-ratio")),
      exception: item.hasAttribute("data-contrast-exception"),
    })),
  );
  // ADR 0008: focus ring / blue text and control boundary are recorded as evidence, not asserted.
  expect(contrasts.filter((pair) => pair.exception).map((pair) => pair.name)).toEqual([
    "Focus ring / blue text",
    "Control boundary",
  ]);
  for (const pair of contrasts.filter((item) => !item.exception))
    expect(pair.ratio, pair.name ?? "").toBeGreaterThanOrEqual(4.5);
  await testInfo.attach("rendered-contrast-pairs", {
    body: JSON.stringify(contrasts, null, 2),
    contentType: "application/json",
  });
  const field = page.getByRole("textbox", {
    name: "Host display name",
    exact: true,
  });
  await field.fill("ระบบทดสอบกรุงเทพฯ · ภาษาไทย");
  await expect(field).toHaveValue("ระบบทดสอบกรุงเทพฯ · ภาษาไทย");
  await field.focus();
  expect(
    await field.evaluate((element) => getComputedStyle(element).outlineWidth),
  ).toBe("2px");
  expect(
    await field.evaluate((element) => getComputedStyle(element).height),
  ).toBe("32px");
  const selectedConnected = page
    .locator('.session-tab[data-active="true"]')
    .filter({ hasText: "prod-api-01" })
    .first();
  await expect(
    selectedConnected.getByText("Connected", { exact: true }),
  ).toBeVisible();
  await expect(
    selectedConnected.getByText("Active", { exact: true }),
  ).toBeVisible();
  await expect(
    selectedConnected.getByText("PROD", { exact: true }),
  ).toBeVisible();
  expect(
    await selectedConnected
      .locator(".connection-status svg")
      .evaluate((element) => getComputedStyle(element).color),
  ).toBe("rgb(34, 197, 94)");
  for (const [width, height] of [
    [1280, 800],
    [960, 640],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
      [width, height],
    );
    await page
      .locator(".showcase")
      .evaluate((element) => element.scrollTo(0, 0));
    await expect
      .poll(() =>
        page
          .locator(".showcase")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`showcase-${width}.png`),
    });
  }
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});

test("keeps dialog keyboard focus contained and restores its trigger", async ({
  desktop,
}) => {
  const { page, errors } = desktop;
  const trigger = page.getByRole("button", {
    name: "Open host dialog fixture",
    exact: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Host details · fixture" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Fixture host name")).toBeFocused();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    await expect.poll(() => dialog.evaluate((element) =>
      element.contains(document.activeElement),
    )).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page
    .getByRole("button", { name: "Review conflict fixture", exact: true })
    .click();
  const conflict = page.getByRole("dialog", {
    name: "app.conf already exists",
  });
  await expect(conflict).toBeVisible();
  await expect(
    conflict.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();
  await conflict.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(conflict).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review conflict fixture", exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test("honors reduced motion and exposes local feedback without service actions", async ({
  desktop,
}) => {
  const { page, errors } = desktop;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "Show fixture toast", exact: true })
    .click();
  await expect(page.getByText("Preview notice", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  const duration = await page
    .locator('.connection-status[data-state="connecting"] svg')
    .first()
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(parseFloat(duration)).toBeLessThanOrEqual(0.001);
  expect(errors).toEqual([]);
});
