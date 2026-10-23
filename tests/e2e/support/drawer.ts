import type { Page } from "@playwright/test";
import { expect } from "../fixtures";

/** Drawer geometry on the current frame (the last match, so a stacked drawer is measured over the one below it). */
export function drawerGeometry(page: Page, selector = "[data-slot='drawer']") {
  return page.evaluate((query) => {
    const drawer = [...document.querySelectorAll<HTMLElement>(query)].at(-1)!;
    const box = drawer.getBoundingClientRect();
    const controls = [...drawer.querySelectorAll(":is(input, button, [role=combobox], [role=radio], label):not([aria-hidden='true'])")].map((node) => ({ node, rect: node.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0);
    return {
      left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width,
      viewport: { width: innerWidth, height: innerHeight },
      duration: Math.max(...getComputedStyle(drawer).transitionDuration.split(",").map((part) => parseFloat(part) * (part.trim().endsWith("ms") ? 0.001 : 1))),
      overflowing: controls.filter(({ rect }) => rect.left < box.left - 0.5 || rect.right > box.right + 0.5)
        .map(({ node, rect }) => `${node.outerHTML.slice(0, 120)} ${rect.left}-${rect.right}`),
      // Scroll containers only: clipped helpers (sr-only text, hidden form mirrors) never scroll.
      scrolling: [drawer, ...drawer.querySelectorAll("*")].filter((node) => node.scrollWidth - node.clientWidth > 1 &&
        (node === drawer || ["auto", "scroll"].includes(getComputedStyle(node).overflowX)))
        .map((node) => `${node.outerHTML.slice(0, 160)} ${node.scrollWidth}/${node.clientWidth} ${getComputedStyle(node).overflowX}`),
    };
  }, selector);
}

/**
 * The drawer contract's placement: flush right, from the titlebar's bottom to the window's, 480–560 px (640 for
 * Settings), no field overflow or horizontal scroll. `reducedMotion` also asserts there is no transition.
 */
export async function placed(page: Page, g: Awaited<ReturnType<typeof drawerGeometry>>, size: string, max = 560, reducedMotion = true) {
  // The modal hides the page from the accessibility tree; the banner is still the titlebar.
  const titlebar = (await page.getByRole("banner", { includeHidden: true }).boundingBox())!;
  if (reducedMotion) expect(g.duration, `${size}: no motion under reduced motion`).toBeLessThanOrEqual(0.00001);
  expect(Math.abs(g.right - g.viewport.width), `${size}: flush with the right edge`).toBeLessThanOrEqual(1);
  expect(Math.abs(g.top - (titlebar.y + titlebar.height)), `${size}: starts below the titlebar`).toBeLessThanOrEqual(1);
  expect(Math.abs(g.bottom - g.viewport.height), `${size}: full height`).toBeLessThanOrEqual(1);
  expect(g.width, `${size}: drawer width`).toBeGreaterThanOrEqual(Math.min(480, g.viewport.width));
  expect(g.width, `${size}: drawer width`).toBeLessThanOrEqual(max);
  expect(g.left, `${size}: the source screen stays visible`).toBeGreaterThan(0);
  expect(g.overflowing, `${size}: fields stay inside the drawer`).toEqual([]);
  expect(g.scrolling, `${size}: no horizontal scroll`).toEqual([]);
}

/**
 * SST-040/15: placement check for a drawer opened inside a feature spec (motion allowed). Waits until the open drawer
 * (the last `selector` match) has finished its entry transition, then applies `placed()` without the motion check.
 */
export async function expectDrawerPlaced(page: Page, name: string, { selector = "[data-slot='drawer']", max = 560 } = {}) {
  await expect.poll(() => page.evaluate((query) => {
    const drawer = [...document.querySelectorAll<HTMLElement>(query)].at(-1);
    return !!drawer && !drawer.hasAttribute("data-starting-style") && !drawer.hasAttribute("data-ending-style") &&
      drawer.getAnimations().every((animation) => animation.playState !== "running");
  }, selector), { message: `${name}: the drawer comes to rest` }).toBe(true);
  const size = await page.evaluate(() => `${innerWidth}x${innerHeight}`);
  await placed(page, await drawerGeometry(page, selector), `${name}@${size}`, max, false);
}
