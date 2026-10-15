import { app, BrowserWindow, ipcMain, powerMonitor, session } from "electron";
import { isAbsolute, join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  channels,
  failure,
  type StorageHealth,
  type StorageProblem,
} from "@ssterm/contracts";
import type { MetadataRepository } from "@ssterm/domain";
import {
  KnownHostPolicy,
  SecretService,
  TransientSecrets,
} from "@ssterm/services";
import { WindowBoundary, sameDocument } from "./boundary";
import { contentSecurityPolicy, rendererLocation } from "./security";
import { openMetadata } from "./storage";
import { resolveHostConfig } from "./catalog";
import { createDesktopSessions } from "./session-runtime";
import { createKnownHostsController } from "./known-hosts";
import { registerKnownHostHandlers } from "./known-host-runtime";

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
// Acquire ownership before opening storage. Test profiles use distinct userData.
const ownsInstance = app.requestSingleInstanceLock();
let repository: MetadataRepository | undefined;
let storageHealth: StorageHealth = { status: "blocked", code: "unavailable" };
// No app-wide credential cache: only owned transient values, purged on lock, suspend and quit.
const transientSecrets = new TransientSecrets();
// Main-only; undefined while storage or the Keychain binding is unavailable.
let secrets: SecretService | undefined;
let desktopSessions: ReturnType<typeof createDesktopSessions> | undefined;
let knownHostPolicy: KnownHostPolicy | undefined;
let knownHosts: ReturnType<typeof createKnownHostsController> | undefined;
let removeKnownHostHandlers: (() => void) | undefined;
function storageProblem(code: unknown): StorageProblem {
  switch (code) {
    case "corrupt":
    case "foreign-database":
    case "unsupported-schema":
    case "unsupported-protection":
    case "recovery-required":
    case "unwritable":
    case "migration-failed":
    case "busy":
    case "unavailable":
      return code;
    default:
      return "unavailable";
  }
}
function closeStorage(): void {
  const owned = repository;
  repository = undefined;
  secrets = undefined;
  owned?.close();
}
async function initializeStorage(): Promise<void> {
  try {
    const directory = join(app.getPath("userData"), "metadata");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const opened = await openMetadata({
      path: join(directory, "catalog.sqlite"),
    });
    if (!opened.ok) {
      storageHealth = {
        status: "blocked",
        code: storageProblem(opened.error.code),
      };
      return;
    }
    repository = opened.value;
    const snapshot = repository.snapshot();
    if (!snapshot.ok) {
      storageHealth = {
        status: "blocked",
        code: storageProblem(snapshot.error.code),
      };
      closeStorage();
      return;
    }
    storageHealth = {
      status: "ready",
      schemaVersion: snapshot.value.schemaVersion,
    };
    try {
      // Loaded lazily so a native-binding failure leaves storage health intact and secrets unavailable.
      const { KeychainSecretProvider, PRODUCTION_SECRET_NAMESPACE } =
        await import("@ssterm/adapters/keychain");
      secrets = new SecretService({
        repository,
        provider: new KeychainSecretProvider(PRODUCTION_SECRET_NAMESPACE),
        transient: transientSecrets,
      });
      // Touches the Keychain only for unfinished journal rows; outcomes stay in the journal, never in logs.
      void secrets.reconcile().catch(() => undefined);
    } catch {
      secrets = undefined;
    }
  } catch (error) {
    closeStorage();
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    storageHealth = {
      status: "blocked",
      code: ["EACCES", "EPERM", "EROFS", "ENOSPC"].includes(String(code))
        ? "unwritable"
        : "unavailable",
    };
  }
}
const location = rendererLocation(
  app.isPackaged,
  join(__dirname, "../renderer/index.html"),
  process.env.ELECTRON_RENDERER_URL,
);
const boundary = new WindowBoundary(
  location.url,
  {
    name: "ssterm",
    version: app.getVersion(),
    platform: process.platform,
  },
  () => storageHealth,
  (owner) => {
    knownHosts?.revokeOwner(owner);
    desktopSessions?.revokeOwner(owner);
  },
);
let quitting = false;
let shutdownComplete = false;
if (ownsInstance) {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

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

if (ownsInstance) {
  void app.whenReady().then(async () => {
    if (quitting) return;
    await initializeStorage();
    if (quitting) {
      closeStorage();
      return;
    }
    desktopSessions = createDesktopSessions({
      transient: transientSecrets,
      power: powerMonitor,
      resolve: (hostId) => {
        if (!repository) {
          return {
            ok: false,
            error: {
              code: "unavailable",
              message: "Configuration is unavailable.",
            },
          };
        }
        const snapshot = repository.snapshot();
        return snapshot.ok
          ? resolveHostConfig(snapshot.value, hostId)
          : snapshot;
      },
    });
    if (repository) {
      knownHostPolicy = new KnownHostPolicy({ repository });
      knownHosts = createKnownHostsController({
        policy: knownHostPolicy,
        registry: desktopSessions.registry,
      });
    }
    removeKnownHostHandlers = registerKnownHostHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => knownHosts,
    });
    const defaultSession = session.defaultSession;
    defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    defaultSession.setPermissionCheckHandler(() => false);
    const csp = contentSecurityPolicy(location.devOrigin);
    defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "content-security-policy")
          delete headers[key];
      }
      callback({
        responseHeaders: { ...headers, "Content-Security-Policy": [csp] },
      });
    });
    ipcMain.handle(channels.bootstrap, (event, ...args: unknown[]) => {
      try {
        const result = boundary.bootstrap(event, args);
        if (result.ok) {
          knownHosts?.register(result.value.owner, (state) => {
            if (!event.sender.isDestroyed())
              event.sender.send(channels.trustStateChanged, state);
          });
        }
        return result;
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
      if (!quitting && BrowserWindow.getAllWindows().length === 0)
        createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  boundary.dispose();
  knownHosts?.dispose();
  knownHostPolicy?.dispose();
  removeKnownHostHandlers?.();
  ipcMain.removeHandler(channels.bootstrap);
  ipcMain.removeHandler(channels.ping);
  transientSecrets.purgeAll();
  // Invalidation/destruction starts synchronously; optional engine drain is bounded.
  void Promise.resolve(desktopSessions?.shutdown()).finally(() => {
    closeStorage();
    shutdownComplete = true;
    app.quit();
  });
});

if (!ownsInstance) app.quit();
