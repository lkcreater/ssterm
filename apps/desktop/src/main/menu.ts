import type { MenuItemConstructorOptions } from "electron";

/** Edit roles keep native Cmd+C/V/A reaching the focused terminal; reload and DevTools exist only in development. */
export function applicationMenuTemplate(options: { packaged: boolean; platform: NodeJS.Platform }): MenuItemConstructorOptions[] {
  const development: MenuItemConstructorOptions[] = options.packaged
    ? []
    : [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }];
  return [
    ...(options.platform === "darwin" ? [{ role: "appMenu" } as const] : []),
    { role: "fileMenu" },
    // Labelled "Edit" so macOS still appends its dictation and emoji items.
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        ...development,
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
