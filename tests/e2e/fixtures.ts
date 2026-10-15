import {
  test as base,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DesktopAPI } from "../../packages/contracts/src/index";

declare global {
  interface Window {
    ssterm: DesktopAPI;
  }
}

interface Desktop {
  app: ElectronApplication;
  page: Page;
  errors: string[];
  externalRequests: string[];
}

export const test = base.extend<{ desktop: Desktop }>({
  desktop: async ({}, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-"));
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (item): item is [string, string] => item[1] !== undefined,
      ),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    env.SSTERM_TEST_USER_DATA = profile;
    const packaged = process.env.SSTERM_PACKAGED_EXECUTABLE;
    const showcase = testInfo.project.name === "showcase";
    if (showcase) env.ELECTRON_RENDERER_URL = "http://127.0.0.1:5173/";
    // A packaged build must ignore even an explicitly supplied development URL.
    if (packaged) env.ELECTRON_RENDERER_URL = "http://127.0.0.1:9/";
    let app: ElectronApplication | undefined;
    try {
      app = await _electron.launch({
        executablePath: packaged,
        args: packaged ? [] : [resolve("apps/desktop")],
        env,
        chromiumSandbox: true,
        timeout: 25_000,
      });
      const errors: string[] = [];
      const externalRequests: string[] = [];
      await app.context().route(/^https?:\/\//, async (route) => {
        const url = new URL(route.request().url());
        if (showcase && url.origin === "http://127.0.0.1:5173")
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
      if (showcase) await page.goto("http://127.0.0.1:5173/#showcase");
      await page.waitForLoadState("domcontentloaded");
      await use({ app, page, errors, externalRequests });
    } finally {
      if (app) {
        const child = app.process();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            app.close(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Close timed out")),
                5_000,
              );
            }),
          ]);
        } catch {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      await rm(profile, { recursive: true, force: true });
    }
  },
});

export { expect };
