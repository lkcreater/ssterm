import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, session, shell } from "electron";
import { isAbsolute, join, relative } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  channels,
  failure,
  type StorageHealth,
  type TerminalSession,
  type StorageProblem,
} from "@ssterm/contracts";
import type { MetadataRepository, SecretProvider } from "@ssterm/domain";
import {
  CatalogModule,
  type KnownHostPolicy,
  AppLockService,
  SecretService,
  TransientSecrets,
  TunnelService,
} from "@ssterm/services";
import { listenLocal } from "@ssterm/adapters/local-listener";
import { FileRecordStore } from "@ssterm/adapters/record-file";
import { WindowBoundary, sameDocument } from "./boundary";
import { contentSecurityPolicy, rendererLocation } from "./security";
import { openMetadata } from "./storage";
import { createDesktopSessions, sessionOwnerId } from "./session-runtime";
import { createSavedHostSessions } from "./ssh";
import { createKnownHostsController } from "./known-hosts";
import { registerKnownHostHandlers } from "./known-host-runtime";
import { createCredentialsController } from "./credentials";
import { registerCredentialHandlers } from "./credential-runtime";
import { closePrompt, createTerminalController, registerTerminalHandlers, type TerminalController } from "./terminals";
import { createSftpController, registerSftpHandlers, type SftpController } from "./sftp";
import { createLocalFiles } from "@ssterm/adapters/local-files";
import { createLocalTransferFiles } from "@ssterm/adapters/local-transfers";
import { createTransferController, registerTransferHandlers, withTransferPrompt, type TransferController } from "./transfers";
import { applicationMenuTemplate } from "./menu";
import { registerLinkHandlers } from "./links";
import { registerWorkspaceTemplateHandlers } from "./workspace-templates";
import { registerSettingsHandlers } from "./settings";
import { createCatalogController, observeCommits, registerCatalogHandlers, type CatalogController } from "./catalog-controller";
import { createIdentitiesController, registerIdentityHandlers, secretNamespace, type IdentitiesController } from "./identities";
import { createSnippetsController, registerSnippetHandlers, type SnippetsController } from "./snippets";
import { createTunnelController, registerTunnelHandlers, type TunnelController } from "./tunnels";
import { appLockEnabled, createAppLockController, googleConfiguration, registerAppLockHandlers, type AppLockController } from "./app-lock";

/** The Google OAuth client compiled in from SSTERM_GOOGLE_CLIENT_FILE at build time (null without one). */
declare const __SSTERM_GOOGLE_CLIENT__: unknown;

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
} else {
  // Fixed data folder (~/Library/Application Support/ssterm), independent of the bundle's display name, so storage
  // and the single-instance lock never move if productName changes or the disk is case-sensitive.
  app.setPath("userData", join(app.getPath("appData"), "ssterm"));
}

app.setName("ssterm");
// The native About panel shows the derived app icon; the brand lockup is not shown there (DS06 limitation).
app.setAboutPanelOptions({
  applicationName: "ssterm",
  applicationVersion: app.getVersion(),
  copyright: "Copyright © 2026 ssterm contributors",
  credits: "Local-first SSH workspace. Third-party notices: SSTerm.app/Contents/Resources/THIRD_PARTY_NOTICES.txt",
});
app.enableSandbox();
// Acquire ownership before opening storage. Test profiles use distinct userData.
const ownsInstance = app.requestSingleInstanceLock();
let repository: MetadataRepository | undefined;
let storageHealth: StorageHealth = { status: "blocked", code: "unavailable" };
// No app-wide credential cache: only owned transient values, purged on lock, suspend and quit.
const transientSecrets = new TransientSecrets();
// Main-only; undefined while storage or the Keychain binding is unavailable.
let secrets: SecretService | undefined;
let secretProvider: SecretProvider | undefined;
let desktopSessions: ReturnType<typeof createDesktopSessions> | undefined;
let knownHostPolicy: KnownHostPolicy | undefined;
let knownHosts: ReturnType<typeof createKnownHostsController> | undefined;
let removeKnownHostHandlers: (() => void) | undefined;
let credentials: ReturnType<typeof createCredentialsController> | undefined;
let removeCredentialHandlers: (() => void) | undefined;
let terminals: TerminalController | undefined;
let removeTerminalHandlers: (() => void) | undefined;
let sftp: SftpController | undefined;
let transfers: TransferController | undefined;
let removeTransferHandlers: (() => void) | undefined;
let removeSftpHandlers: (() => void) | undefined;
let removeLinkHandlers: (() => void) | undefined;
let removeWorkspaceTemplateHandlers: (() => void) | undefined;
let removeSettingsHandlers: (() => void) | undefined;
let catalog: CatalogController | undefined;
let removeCatalogHandlers: (() => void) | undefined;
let identities: IdentitiesController | undefined;
let removeIdentityHandlers: (() => void) | undefined;
let snippets: SnippetsController | undefined;
// Local forwarding: the service (SST-025) and its owner-bound Start/Stop/status IPC (SST-026).
let tunnels: TunnelService | undefined;
// App lock (SST-039): every feature channel waits until it opens.
let appLock: AppLockController | undefined;
let removeAppLockHandlers: (() => void) | undefined;
let tunnelControls: TunnelController | undefined;
let removeTunnelHandlers: (() => void) | undefined;
let removeSnippetHandlers: (() => void) | undefined;
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
  secretProvider = undefined;
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
    // Every writer (catalog, secrets, known hosts) republishes the catalog projection once per turn.
    repository = observeCommits(opened.value, () => catalog?.publishAll());
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
      const namespace = secretNamespace(process.env, PRODUCTION_SECRET_NAMESPACE);
      if (!namespace) throw new Error("No isolated test secret namespace");
      secretProvider = new KeychainSecretProvider(namespace);
      secrets = new SecretService({
        repository,
        provider: secretProvider,
        transient: transientSecrets,
      });
      // Touches the Keychain only for unfinished journal rows; outcomes stay in the journal, never in logs.
      void secrets.reconcile().catch(() => undefined);
    } catch {
      secrets = undefined;
      secretProvider = undefined;
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
    credentials?.revokeOwner(owner);
    knownHosts?.revokeOwner(owner);
    catalog?.revokeOwner(owner);
    identities?.revokeOwner(owner);
    // Stop output frames before the owner's sessions start closing.
    terminals?.revokeOwner(owner);
    transfers?.revokeOwner(owner);
    sftp?.revokeOwner(owner);
    // Listeners and sockets close before the owner's sessions are revoked.
    tunnelControls?.revokeOwner(owner);
    void tunnels?.closeOwner(sessionOwnerId(owner)).catch(() => undefined);
    desktopSessions?.revokeOwner(owner);
  },
);
/** The user sees the exact normalized href before the OS opens it; Cancel is the default. */
async function confirmAndOpen(href: string, window: BrowserWindow | null): Promise<boolean> {
  if (!window || window.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    message: "Open this link in your browser?",
    detail: href,
    buttons: ["Cancel", "Open"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return false;
  await shell.openExternal(href);
  return true;
}
let quitting = false;
let shutdownComplete = false;
let quitConfirmed = false;
let quitPrompt: Promise<void> | undefined;
function liveSessions(windows: BrowserWindow[]): TerminalSession[] {
  return windows.flatMap((window) => {
    if (window.isDestroyed()) return [];
    const owner = boundary.ownerOf(window.webContents);
    const state = owner && terminals?.terminalState(owner);
    return state && state.ok ? state.value.sessions : [];
  });
}
function pendingTransfers(windows: BrowserWindow[]): number {
  return windows.reduce((count, window) => {
    const owner = !window.isDestroyed() && boundary.ownerOf(window.webContents);
    return count + (owner ? transfers?.pendingCount(owner) ?? 0 : 0);
  }, 0);
}
/** Windows showing a close sheet; a Quit meanwhile brings that sheet forward instead of stacking another. */
const closeSheets = new Set<BrowserWindow>();
/** A sheet on a minimized or background window (Dock Quit, a close from another app) would go unseen. */
function bringToFront(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}
/** Cancel is the default; `dialog` is read at call time so runtime tests can stub the sheet. */
async function confirmDisconnect(window: BrowserWindow | undefined, prompt: { message: string; detail: string }, confirm: string): Promise<boolean> {
  const options = { type: "warning" as const, buttons: ["Cancel", confirm], defaultId: 0, cancelId: 0, ...prompt };
  if (!window || window.isDestroyed()) return (await dialog.showMessageBox(options)).response === 1;
  bringToFront(window);
  return (await dialog.showMessageBox(window, options)).response === 1;
}
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
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 14, y: 13 } } : {}),
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
      devTools: !app.isPackaged,
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
  // A crashed renderer can never answer prompts or acknowledge output; revoke its owner like a navigation.
  const gone = (): void => boundary.rotate(contents);
  const focused = (): void => boundary.focus(contents, true);
  const blurred = (): void => boundary.focus(contents, false);
  contents.on("did-start-navigation", navigating);
  contents.on("render-process-gone", gone);
  window.on("focus", focused);
  window.on("blur", blurred);
  contents.once("destroyed", () => {
    revoke();
    window.removeListener("focus", focused);
    window.removeListener("blur", blurred);
    contents.removeListener("did-start-navigation", navigating);
    contents.removeListener("render-process-gone", gone);
  });
  let allowClose = false;
  let closePrompting: Promise<void> | undefined;
  window.on("close", (event) => {
    if (quitting) return;
    // A confirmation covers one close only: if the window stays open anyway, the next close asks again.
    if (allowClose) {
      allowClose = false;
      return;
    }
    const prompt = withTransferPrompt(closePrompt(liveSessions([window]), "close"), pendingTransfers([window]), "close");
    if (!prompt) return;
    event.preventDefault();
    if (closePrompting) return;
    closeSheets.add(window);
    closePrompting = confirmDisconnect(window, prompt, "Close Window")
      .then((confirmed) => {
        if (!confirmed || window.isDestroyed()) return;
        allowClose = true;
        window.close();
      }, () => undefined)
      .finally(() => {
        closePrompting = undefined;
        closeSheets.delete(window);
      });
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(location.url).catch(() => {
    // No renderer paths, stack traces, or arbitrary upstream errors cross IPC/logs.
    if (!window.isDestroyed()) window.destroy();
    if (!quitting) app.quit();
  });
}

/** Loads the app-lock record (Keychain) and installs the IPC gate before any window exists. */
async function initializeAppLock(): Promise<void> {
  const google = googleConfiguration(process.env, typeof __SSTERM_GOOGLE_CLIENT__ === "undefined" ? null : __SSTERM_GOOGLE_CLIENT__);
  let service: AppLockService | undefined;
  if (appLockEnabled(process.env)) {
    let store;
    try {
      const { KeychainRecordStore, PRODUCTION_SECRET_NAMESPACE } = await import("@ssterm/adapters/keychain");
      const namespace = secretNamespace(process.env, PRODUCTION_SECRET_NAMESPACE);
      if (namespace) store = new KeychainRecordStore(namespace);
    } catch {
      // No Keychain binding: the lock reports itself unavailable and stays closed.
    }
    // The marker lives in the profile, so deleting only the Keychain record cannot reset the lock to first-run setup.
    const marker = new FileRecordStore(join(app.getPath("userData"), "app-lock.json"));
    service = new AppLockService({ store, marker, googleAvailable: !!google });
    await service.load();
  }
  appLock = createAppLockController({ service, google, openExternal: (url) => shell.openExternal(url) });
  boundary.setAccessGate(() => appLock?.open() ?? false);
  removeAppLockHandlers = registerAppLockHandlers({ ipc: ipcMain, boundary, controller: () => appLock });
}

// A locked registry reopens only while saved hosts can be resolved; a missing secure store fails per saved ref instead.
const checkAccess = async () => storageHealth.status === "ready" && !!repository;

if (ownsInstance) {
  void app.whenReady().then(async () => {
    if (quitting) return;
    await initializeStorage();
    await initializeAppLock();
    if (quitting) {
      closeStorage();
      return;
    }
    if (repository) {
      const savedHostSessions = createSavedHostSessions({
        repository,
        provider: secretProvider,
        transient: transientSecrets,
        power: powerMonitor,
      });
      desktopSessions = savedHostSessions;
      knownHostPolicy = savedHostSessions.policy;
      knownHosts = createKnownHostsController({
        policy: knownHostPolicy,
        registry: desktopSessions.registry,
      });
      catalog = createCatalogController({
        repository,
        catalog: new CatalogModule({ repository }),
        secretStore: () => !!secrets,
        cleanupQueued: () => identities?.cleanupQueued(),
        lockEpoch: () => savedHostSessions.registry.lockEpoch,
        // A rule (or its server) with a starting, running or stopping tunnel is edited only after an explicit stop.
        activeTunnel: (ruleId) => tunnels?.active(ruleId) ?? false,
      });
      // Renderers drop decrypted snippet editors when the lock epoch they see increases.
      savedHostSessions.onLock(() => catalog?.publishAll());
      tunnels = new TunnelService({ registry: savedHostSessions.registry, repository, listen: listenLocal });
      const service = tunnels;
      tunnelControls = createTunnelController({ service, lock: savedHostSessions.registry, checkAccess });
      snippets = createSnippetsController({
        repository,
        secrets: () => secrets,
        lock: savedHostSessions.registry,
        checkAccess,
      });
      identities = createIdentitiesController({
        repository,
        secrets: () => secrets,
        transient: transientSecrets,
        lock: savedHostSessions.registry,
        checkAccess,
        pickFile: async (owner) => {
          const window = BrowserWindow.fromId(owner.windowId);
          if (!window || window.isDestroyed()) return undefined;
          const chosen = await dialog.showOpenDialog(window, {
            properties: ["openFile", "showHiddenFiles"],
            defaultPath: join(app.getPath("home"), ".ssh"),
          });
          return chosen.canceled ? undefined : chosen.filePaths[0];
        },
      });
    } else {
      desktopSessions = createDesktopSessions({
        transient: transientSecrets,
        power: powerMonitor,
        resolve: () => ({
          ok: false,
          error: { code: "unavailable", message: "Configuration is unavailable." },
        }),
      });
    }
    credentials = createCredentialsController({ registry: desktopSessions.registry });
    removeCredentialHandlers = registerCredentialHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => credentials,
    });
    terminals = createTerminalController({
      registry: desktopSessions.registry,
      checkAccess,
    });
    removeTerminalHandlers = registerTerminalHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => terminals,
    });
    sftp = createSftpController({
      registry: desktopSessions.registry,
      checkAccess,
      local: createLocalFiles(),
    });
    removeSftpHandlers = registerSftpHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => sftp,
    });
    transfers = createTransferController({ registry: desktopSessions.registry, local: createLocalTransferFiles() });
    removeTransferHandlers = registerTransferHandlers({ ipc: ipcMain, boundary, controller: () => transfers });
    removeKnownHostHandlers = registerKnownHostHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => knownHosts,
    });
    removeCatalogHandlers = registerCatalogHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => catalog,
    });
    removeIdentityHandlers = registerIdentityHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => identities,
    });
    removeTunnelHandlers = registerTunnelHandlers({ ipc: ipcMain, boundary, controller: () => tunnelControls });
    removeSnippetHandlers = registerSnippetHandlers({
      ipc: ipcMain,
      boundary,
      controller: () => snippets,
    });
    removeWorkspaceTemplateHandlers = registerWorkspaceTemplateHandlers({ ipc: ipcMain, boundary, repository: () => repository });
    removeSettingsHandlers = registerSettingsHandlers({
      ipc: ipcMain,
      boundary,
      repository: () => repository,
    });
    removeLinkHandlers = registerLinkHandlers({
      ipc: ipcMain,
      boundary,
      open: (href, sender) => confirmAndOpen(href, BrowserWindow.fromWebContents(sender)),
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
        // While locked a window learns only its owner; feature state is registered after unlock (it bootstraps again).
        if (result.ok && appLock?.open()) {
          credentials?.register(result.value.owner, (state) => {
            if (!event.sender.isDestroyed())
              event.sender.send(channels.credentialStateChanged, state);
          });
          knownHosts?.register(result.value.owner, (state) => {
            if (!event.sender.isDestroyed())
              event.sender.send(channels.trustStateChanged, state);
          });
          terminals?.register(result.value.owner, (channel, value) => {
            if (!event.sender.isDestroyed()) event.sender.send(channel, value);
          });
          sftp?.register(result.value.owner, (channel, value) => {
            if (!event.sender.isDestroyed()) event.sender.send(channel, value);
          });
          transfers?.register(result.value.owner, (channel, value) => {
            if (!event.sender.isDestroyed()) event.sender.send(channel, value);
          });
          tunnelControls?.register(result.value.owner, (state) => {
            if (!event.sender.isDestroyed()) event.sender.send(channels.tunnelStateChanged, state);
          });
          catalog?.register(result.value.owner, (state) => {
            if (!event.sender.isDestroyed())
              event.sender.send(channels.catalogStateChanged, state);
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
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(applicationMenuTemplate({ packaged: app.isPackaged, platform: process.platform })),
    );
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
  if (quitting || quitPrompt) return;
  // The quit would otherwise sit behind the close sheet and end unanswered when that window closes.
  const sheet = closeSheets.values().next().value;
  if (sheet) {
    if (!sheet.isDestroyed()) bringToFront(sheet);
    return;
  }
  const prompt = quitConfirmed ? undefined : withTransferPrompt(closePrompt(liveSessions(BrowserWindow.getAllWindows()), "quit"), pendingTransfers(BrowserWindow.getAllWindows()), "quit");
  if (prompt) {
    quitPrompt = confirmDisconnect(BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0], prompt, "Quit")
      .then((confirmed) => {
        quitPrompt = undefined;
        if (!confirmed) return;
        quitConfirmed = true;
        app.quit();
      }, () => { quitPrompt = undefined; });
    return;
  }
  quitting = true;
  boundary.dispose();
  credentials?.dispose();
  knownHosts?.dispose();
  terminals?.dispose();
  transfers?.dispose();
  sftp?.dispose();
  catalog?.dispose();
  identities?.dispose();
  snippets?.dispose();
  tunnelControls?.dispose();
  knownHostPolicy?.dispose();
  removeKnownHostHandlers?.();
  removeCredentialHandlers?.();
  removeTerminalHandlers?.();
  removeTransferHandlers?.();
  removeSftpHandlers?.();
  removeLinkHandlers?.();
  removeWorkspaceTemplateHandlers?.();
  removeSettingsHandlers?.();
  removeCatalogHandlers?.();
  removeIdentityHandlers?.();
  removeSnippetHandlers?.();
  removeTunnelHandlers?.();
  appLock?.dispose();
  removeAppLockHandlers?.();
  ipcMain.removeHandler(channels.bootstrap);
  ipcMain.removeHandler(channels.ping);
  transientSecrets.purgeAll();
  // Tunnel listeners and sockets are destroyed synchronously inside dispose(); session invalidation also starts
  // synchronously. Both drains are bounded.
  const tunnelsClosed = Promise.race([
    Promise.resolve(tunnels?.dispose()).catch(() => undefined),
    new Promise<void>((done) => setTimeout(done, 2_000)),
  ]);
  void Promise.all([tunnelsClosed, Promise.resolve(desktopSessions?.shutdown())]).finally(() => {
    closeStorage();
    shutdownComplete = true;
    app.quit();
  });
});

if (!ownsInstance) app.quit();
