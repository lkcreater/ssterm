import { app, BrowserWindow, ipcMain, session } from "electron";
import { isAbsolute, join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { channels, failure } from "@ssterm/contracts";
import { WindowBoundary, sameDocument } from "./boundary";
import { contentSecurityPolicy, rendererLocation } from "./security";

// Tests opt into an existing task-owned temporary directory before Electron starts.
const testUserData = process.env.SSTERM_TEST_USER_DATA;
if (testUserData) {
  const actual = realpathSync(testUserData);
  const temporaryRoots = [realpathSync(tmpdir()), realpathSync("/tmp")];
  const isTemporary = temporaryRoots.some((temporary) => {
    const fromTemp = relative(temporary, actual);
    return fromTemp && !fromTemp.startsWith("..") && !isAbsolute(fromTemp);
  });
  if (!isAbsolute(testUserData) || !isTemporary) {
    throw new Error("Test userData must be an existing temporary directory");
  }
  app.setPath("userData", actual);
}

app.setName("ssterm");
app.enableSandbox();
const location = rendererLocation(
  app.isPackaged,
  join(__dirname, "../renderer/index.html"),
  process.env.ELECTRON_RENDERER_URL,
);
const boundary = new WindowBoundary(location.url, {
  name: "ssterm",
  version: app.getVersion(),
  platform: process.platform,
});
let quitting = false;

// Apply to all webContents, including any accidentally created outside composition.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!sameDocument(url, location.url)) event.preventDefault();
  });
  contents.on("will-frame-navigate", (details) => {
    if (!details.isMainFrame || !sameDocument(details.url, location.url))
      details.preventDefault();
  });
  contents.on("will-redirect", (details) => {
    if (!details.isMainFrame || !sameDocument(details.url, location.url))
      details.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

function createWindow(): void {
  const window = new BrowserWindow({
    title: "ssterm",
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0C1220",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  const contents = window.webContents;
  const revoke = boundary.register(
    contents,
    window.id,
    window.isFocused(),
    (event) => {
      if (!contents.isDestroyed()) contents.send(channels.windowState, event);
    },
  );
  const navigating = (
    details: Electron.Event & { isMainFrame: boolean; isSameDocument: boolean },
  ): void => {
    if (details.isMainFrame && !details.isSameDocument)
      boundary.rotate(contents);
  };
  const focused = (): void => boundary.focus(contents, true);
  const blurred = (): void => boundary.focus(contents, false);
  contents.on("did-start-navigation", navigating);
  window.on("focus", focused);
  window.on("blur", blurred);
  contents.once("destroyed", () => {
    revoke();
    window.removeListener("focus", focused);
    window.removeListener("blur", blurred);
    contents.removeListener("did-start-navigation", navigating);
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(location.url).catch(() => {
    // No renderer paths, stack traces, or arbitrary upstream errors cross IPC/logs.
    if (!window.isDestroyed()) window.destroy();
    if (!quitting) app.quit();
  });
}

void app.whenReady().then(() => {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  defaultSession.setPermissionCheckHandler(() => false);
  const csp = contentSecurityPolicy(location.devOrigin);
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "content-security-policy") delete headers[key];
    }
    callback({
      responseHeaders: { ...headers, "Content-Security-Policy": [csp] },
    });
  });
  ipcMain.handle(channels.bootstrap, (event, ...args: unknown[]) => {
    try {
      return boundary.bootstrap(event, args);
    } catch {
      return failure("unavailable");
    }
  });
  ipcMain.handle(channels.ping, (event, ...args: unknown[]) => {
    try {
      return boundary.ping(event, args);
    } catch {
      return failure("unavailable");
    }
  });
  createWindow();
  app.on("activate", () => {
    if (!quitting && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  quitting = true;
  boundary.dispose();
  ipcMain.removeHandler(channels.bootstrap);
  ipcMain.removeHandler(channels.ping);
});
