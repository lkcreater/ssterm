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
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "windowMenu"])
      assert.ok(packaged.includes(role), role);
    assert.equal(packaged.includes("appMenu"), platform === "darwin");
    assert.equal(packaged.includes("fileMenu"), platform !== "darwin");
  }
});

test("development menu adds reload, force reload and DevTools", () => {
  const dev = roles(applicationMenuTemplate({ packaged: false, platform: "darwin" }));
  for (const role of [...development, "copy", "paste", "selectAll"]) assert.ok(dev.includes(role), role);
});

test("macOS File menu only closes the window with Shift+Cmd+W so Cmd+W reaches the renderer", () => {
  const template = applicationMenuTemplate({ packaged: true, platform: "darwin" });
  const file = template.find((item) => item.label === "File");
  assert.deepEqual(file?.submenu, [{ role: "close", label: "Close Window", accelerator: "CmdOrCtrl+Shift+W" }]);
  const accelerators = (items: MenuItemConstructorOptions[]): string[] => items.flatMap((item) => [
    ...(item.accelerator ? [String(item.accelerator)] : []),
    ...(Array.isArray(item.submenu) ? accelerators(item.submenu) : []),
  ]);
  assert.equal(accelerators(template).some((accelerator) => /^CmdOrCtrl\+W$|^Command\+W$/i.test(accelerator)), false);
});
