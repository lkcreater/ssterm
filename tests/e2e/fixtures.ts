import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DesktopAPI } from "../../packages/contracts/src/index";

declare global {
  interface Window {
    ssterm: DesktopAPI;
  }
}

export interface Desktop {
  app: ElectronApplication;
  page: Page;
  errors: string[];
  externalRequests: string[];
  profile: string;
  /** The Keychain namespace this launch's main uses; teardown empties it. */
  secretNamespace: string;
  /** Idempotent; safe after the app already exited. */
  close(): Promise<void>;
}

const TEST_NAMESPACE = /^dev\.ssterm\.test\.[0-9a-f-]{36}$/u;

/**
 * Launches the desktop app on an existing temporary profile; relaunching on the same profile reopens its data.
 * Each launch gets a fresh `dev.ssterm.test.<uuid>` Keychain namespace unless one is given (an invalid value
 * exercises the fail-closed gate). `close()` always empties it, so saved secrets never survive a relaunch.
 */
export async function launchDesktop(
  profile: string,
  options: { showcase?: boolean; secretNamespace?: string } = {},
): Promise<Desktop> {
  const { showcase = false, secretNamespace = `dev.ssterm.test.${randomUUID()}` } = options;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (item): item is [string, string] => item[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  env.SSTERM_TEST_USER_DATA = profile;
  env.SSTERM_TEST_SECRET_NAMESPACE = secretNamespace;
  const packaged = process.env.SSTERM_PACKAGED_EXECUTABLE;
  if (showcase) env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5174/";
  // A packaged build must ignore even an explicitly supplied development URL.
  if (packaged) env.ELECTRON_RENDERER_URL = "http://127.0.0.1:9/";
  const app = await _electron.launch({
    executablePath: packaged,
    args: packaged ? [] : [resolve("apps/desktop")],
    env,
    chromiumSandbox: true,
    timeout: 25_000,
  });
  // Read from the child, never from `app`: Playwright disposes the application object once it exits.
  const child: ChildProcess = app.process();
  const exited = new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) done();
    else child.once("exit", () => done());
  });
  const alive = () => child.exitCode === null && child.signalCode === null;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      if (!alive()) return;
      // Empty this launch's namespace through the shipped secrets entry while main still runs, then close.
      let leftovers: number | string = 0;
      if (TEST_NAMESPACE.test(secretNamespace))
        leftovers = await app.evaluate(async ({ app }, namespace) => {
          const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
          const { clearTestNamespace } = require(require("node:path").join(app.getAppPath(), "out/main/secrets.js"));
          return clearTestNamespace(namespace);
        }, secretNamespace).catch(() => "unknown");
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        app.close().catch(() => undefined),
        exited,
        new Promise<void>((done) => {
          timer = setTimeout(done, 5_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (alive()) {
        child.kill("SIGKILL");
        await exited;
      }
      if (leftovers !== 0) throw new Error(`Test Keychain namespace not emptied: ${leftovers}`);
    })());
  try {
    const errors: string[] = [];
    const externalRequests: string[] = [];
    await app.context().route(/^https?:\/\//, async (route) => {
      const url = new URL(route.request().url());
      if (showcase && url.origin === "http://127.0.0.1:5174")
        await route.continue();
      else {
        externalRequests.push(url.href);
        await route.abort();
      }
    });
    if (!showcase) await app.context().setOffline(true);
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    if (showcase) await page.goto("http://127.0.0.1:5174/#showcase");
    await page.waitForLoadState("domcontentloaded");
    return { app, page, errors, externalRequests, profile, secretNamespace, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export const test = base.extend<{ desktop: Desktop; corruptStore: boolean }>({
  corruptStore: [false, { option: true }],
  desktop: async ({ corruptStore }, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-"));
    let desktop: Desktop | undefined;
    try {
      if (corruptStore) {
        await mkdir(join(profile, "metadata"), { mode: 0o700 });
        await writeFile(
          join(profile, "metadata/catalog.sqlite"),
          "ssterm-corrupt-owned-fixture",
          { mode: 0o600 },
        );
      }
      desktop = await launchDesktop(profile, {
        showcase: testInfo.project.name === "showcase",
      });
      await use(desktop);
    } finally {
      await desktop?.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});

export { expect };

/**
 * Applies catalog intents through a second connection to the profile's own catalog database, using the
 * shipped storage and catalog entries in main. A string "$n" is replaced by step n's created id, and
 * `expectedRevision: "current"` by the target's current revision. Returns each step's created id.
 */
export function changeCatalog(app: ElectronApplication, steps: object[]): Promise<(string | null)[]> {
  return app.evaluate(async ({ app }, steps) => {
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const path = require("node:path");
    const main = path.join(app.getAppPath(), "out/main");
    const { openMetadata } = require(path.join(main, "storage.js"));
    const { CatalogModule } = require(path.join(main, "catalog.js"));
    const opened = await openMetadata({ path: path.join(app.getPath("userData"), "metadata/catalog.sqlite") });
    if (!opened.ok) throw new Error(`Second catalog connection: ${opened.error.code}`);
    const repository = opened.value;
    try {
      const catalog = new CatalogModule({ repository });
      const value = (result: any) => {
        if (!result.ok) throw new Error(`Catalog change: ${result.error.code}`);
        return result.value;
      };
      const ids: (string | null)[] = [];
      const resolve = (item: unknown): unknown =>
        typeof item === "string" && /^\$\d+$/u.test(item) ? ids[Number(item.slice(1))]
          : Array.isArray(item) ? item.map(resolve)
          : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, resolve(v)]))
          : item;
      for (const step of steps) {
        const intent = resolve(step) as any;
        if (intent.expectedRevision === "current") {
          const snapshot = value(repository.snapshot());
          const rows = [...snapshot.hosts, ...snapshot.groups, ...snapshot.tags, ...snapshot.identities];
          intent.expectedRevision = rows.find((row: any) => row.id === intent.id).revision;
        }
        if (intent.expectedHostRevision === "current")
          intent.expectedHostRevision = value(repository.snapshot()).hosts.find((row: any) => row.id === intent.hostId).revision;
        ids.push(value(catalog.apply(value(catalog.prepare(intent)).token)).createdIds[0] ?? null);
      }
      return ids;
    } finally {
      repository.close();
    }
  }, steps);
}
