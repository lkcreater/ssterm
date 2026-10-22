import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Locator, Page } from "@playwright/test";
import type { TransferJob } from "../../../packages/contracts/src/index";
import { expect, changeCatalog, type Desktop } from "../fixtures";

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../../spikes/ssh-compat/src/fixture.cjs");
export const ROOT = "/home/fixture/transfers-ไทย";
export const LABEL = "การโอนไฟล์ ผลิตจริง";
interface Lab {
  host: string; port: number; username: string; password: string; directory: string; container: string; privateKey: Buffer;
  dispose(): Promise<void>; assertCleaned(): Promise<void>;
}

export function pane(page: Page, kind: "local" | "remote") {
  const section = page.locator(`section[data-pane="${kind}"]`);
  const list = section.locator('[role="listbox"].file-list');
  return {
    section, list,
    row: (name: string) => list.locator(`[role="option"][data-name=${JSON.stringify(name)}]`),
    async goto(path: string) {
      await section.getByRole("button", { name: "Go to path", exact: true }).click();
      const input = section.getByRole("textbox", { name: "Go to path" });
      await input.fill(path); await input.press("Enter");
      await expect(list).toHaveAttribute("data-path", path, { timeout: 20_000 });
      await expect(list).not.toHaveAttribute("aria-busy", "true");
    },
    async select(names: string[]) {
      for (let i = 0; i < names.length; i++) await this.row(names[i]!).click(i ? { modifiers: ["Meta"] } : {});
      await expect(list.locator('[role="option"][aria-selected="true"]')).toHaveCount(names.length);
    },
  };
}

export async function setupTransferLab(desktop: Desktop) {
  const fixture: Lab = await startFixture();
  const { app, page } = desktop;
  const python = (script: string) => runFile("docker", ["exec", "-u", "fixture", fixture.container, "python3", "-c", script], { timeout: 30_000 });
  const processCount = async () => {
    try { return Number((await runFile("docker", ["exec", fixture.container, "pgrep", "-c", "-f", "sshd: fixture@"])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw error; }
  };
  const password = async () => {
    const dialog = page.getByTestId("credential-prompt-dialog");
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }, file) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
        const input = document.querySelector('[data-testid="credential-prompt-dialog"] input');
        if (!input || input.disabled) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    }, join(fixture.directory, "password"))).toBe(true);
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  const finish = async () => {
    try {
      await desktop.close();
      await expect.poll(processCount, { timeout: 10_000, message: "no SSH process survives app quit" }).toBe(0);
    } finally {
      fixture.privateKey.fill(0);
      await fixture.dispose(); await fixture.assertCleaned();
    }
    const { stdout } = await runFile("security", ["dump-keychain"], { maxBuffer: 64 * 1024 * 1024 });
    expect(stdout.split("\n").filter((line) => line.includes(`"svce"<blob>="${desktop.secretNamespace}"`)), "test namespace emptied").toEqual([]);
  };
  try {
    await python(`import os\nr=${JSON.stringify(ROOT)}\nos.makedirs(r+'/elsewhere')\nopen(r+'/existing.txt','wb').write(b'original-server')`);
    await writeFile(join(fixture.directory, "password"), fixture.password, { mode: 0o600 });
    await changeCatalog(app, [
      { type: "create-identity", data: { label: "Transfer lab", username: fixture.username, method: "password" } },
      { type: "create-host", data: { label: LABEL, address: fixture.host, environment: "PROD", port: { mode: "value", port: fixture.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();
    await page.getByTestId("hosts-page").getByRole("button", { name: `Connect ${LABEL}`, exact: true }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    await password();
    const terminal = page.locator(`section[aria-label="Terminal for ${LABEL}"]`);
    await expect(terminal).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await terminal.getByRole("button", { name: "Pane actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open in SFTP", exact: true }).click();
    await password();
    await expect(pane(page, "remote").section).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    return { fixture, python, password, finish, terminal,
      /** The disposable container has a separate filesystem; seed an equal lexical local/remote path there. */
      async samePathDirectory(path: string) {
        await runFile("docker", ["exec", fixture.container, "python3", "-c", `import os,pwd\np=${JSON.stringify(path)}\nos.makedirs(p,exist_ok=True)\nu=pwd.getpwnam('fixture')\nos.chown(p,u.pw_uid,u.pw_gid)`]);
      },
      async remoteInfo(name: string): Promise<{ size: number; hash: string } | null> {
        const path = name.startsWith("/") ? name : `${ROOT}/${name}`;
        const { stdout } = await python(`import os,hashlib,json\np=${JSON.stringify(path)}\nprint(json.dumps({'size':os.stat(p).st_size,'hash':hashlib.file_digest(open(p,'rb'),'sha256').hexdigest()}) if os.path.isfile(p) else 'null')`);
        return JSON.parse(stdout);
      },
      async stages(): Promise<string[]> {
        const { stdout } = await python(`import glob,json\nprint(json.dumps(sorted(glob.glob(${JSON.stringify(`${ROOT}/.ssterm-*.part`)}))))`);
        return JSON.parse(stdout);
      },
      async handles() {
        const { stdout } = await runFile("docker", ["exec", fixture.container, "python3", "-c", `import glob,os\nn=0\nfor p in glob.glob('/proc/[0-9]*/fd/*'):\n try:\n  if os.readlink(p).startswith(${JSON.stringify(ROOT + "/")}): n+=1\n except OSError: pass\nprint(n)`]);
        return Number(stdout.trim());
      },
    };
  } catch (error) { await finish().catch(() => undefined); throw error; }
}

export async function snapshot(page: Page): Promise<TransferJob[]> {
  return page.evaluate(async () => {
    const bootstrap = await window.ssterm.bootstrap();
    if (!bootstrap.ok) throw new Error("Bootstrap unavailable");
    const result = await window.ssterm.transferState({ owner: bootstrap.value.owner });
    if (!result.ok) throw new Error("Transfers unavailable");
    return result.value.jobs;
  });
}

export const terminalState = (job: TransferJob) => ["completed", "cancelled", "failed", "skipped"].includes(job.state);
export const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function renderedContrast(locator: Locator) {
  // Canvas decodes computed oklch/rgb colors and composites translucent ancestor surfaces.
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const ancestors: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
    for (const node of ancestors) {
      context.fillStyle = getComputedStyle(node).backgroundColor; context.fillRect(0, 0, 1, 1);
    }
    const background = [...context.getImageData(0, 0, 1, 1).data];
    const color = getComputedStyle(element).color;
    context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    const foreground = [...context.getImageData(0, 0, 1, 1).data];
    const luminance = (rgba: number[]) => rgba.slice(0, 3).map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const [light, dark] = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
    return { color, foreground, background, ratio: (light! + 0.05) / (dark! + 0.05) };
  });
}

/** SST-040/05: opens a job's conflict drawer and selects one action; nothing is preselected, so Continue starts disabled. */
export async function chooseConflict(page: Page, entry: Locator, action: "Skip" | "Rename" | "Overwrite") {
  await entry.getByRole("button", { name: /^Resolve conflict for / }).click();
  const drawer = page.getByTestId("transfer-conflict-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await drawer.getByRole("radio", { name: action, exact: true }).click();
  return drawer;
}
