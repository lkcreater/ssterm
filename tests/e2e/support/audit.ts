import type { Page } from "@playwright/test";

/**
 * In-page audit of what is rendered now: visible text contrast (4.5:1, or 3:1 for large text), accessible names for
 * interactive controls, horizontal overflow, and reduced-motion effectiveness. Disabled controls and placeholders are
 * exempt from contrast (WCAG 1.4.3). Backgrounds are composited through ancestors on a canvas, as in other specs.
 * Primary-blue text is the ADR 0008 accepted exception: its measured ratio is recorded in `excepted`, not asserted.
 */
export async function audit(page: Page) {
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
    const excepted: string[] = [];
    const blue = rgba(getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()).join();
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
      const color = rgba(style.color);
      const fore = blend(color, back);
      const value = ratio(fore, back);
      checked += 1;
      if (color.join() === blue) excepted.push(`${describe(element)} ${value.toFixed(2)}:1`);
      else if (value < (large ? 3 : 4.5)) findings.push({ kind: "contrast", detail: `${describe(element)} ${value.toFixed(2)}:1` });
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
    // The workspace's pages, or the app-lock gate (SST-040/14) when nothing else renders.
    const roots = [...document.querySelectorAll(".app-workspace, .app-lock-screen")];
    // Neither root rendered: the overflow check would pass silently, so it is a finding.
    if (!roots.length) findings.push({ kind: "overflow", detail: "no .app-workspace or .app-lock-screen to check" });
    const overflow = roots.flatMap((root) => [root, ...root.querySelectorAll(".catalog-page, .workspace-page, [data-testid$='-page'], [data-testid='team-workspace'], .app-lock-panel-body")])
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
    return { findings, excepted, checked };
  });
}
