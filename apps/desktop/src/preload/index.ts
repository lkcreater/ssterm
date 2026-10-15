import { contextBridge, ipcRenderer } from "electron";
import { createDesktopBridge } from "./bridge";

const bridge = createDesktopBridge(ipcRenderer);
contextBridge.exposeInMainWorld("ssterm", bridge.api);
window.addEventListener("unload", bridge.dispose, { once: true });
