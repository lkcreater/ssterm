import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate } from "../../apps/desktop/src/main/menu.ts";

const roles = (items: MenuItemConstructorOptions[]): string[] => items.flatMap((item) => [
  ...(item.role ? [item.role] : []),
  ...(Array.isArray(item.submenu) ? roles(item.submenu) : []),
]);
const development = ["reload", "forceReload", "toggleDevTools"];

test("packaged menu has no reload or DevTools but keeps native clipboard, zoom and fullscreen roles", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const packaged = roles(applicationMenuTemplate({ packaged: true, platform }));
    for (const role of development) assert.equal(packaged.includes(role), false, role);
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "fileMenu", "windowMenu"])
      assert.ok(packaged.includes(role), role);
    assert.equal(packaged.includes("appMenu"), platform === "darwin");
  }
});

test("development menu adds reload, force reload and DevTools", () => {
  const dev = roles(applicationMenuTemplate({ packaged: false, platform: "darwin" }));
  for (const role of [...development, "copy", "paste", "selectAll"]) assert.ok(dev.includes(role), role);
});
