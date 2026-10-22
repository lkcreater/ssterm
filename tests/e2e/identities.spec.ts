import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop, type Desktop } from "./fixtures";

// Passwords and passphrases are typed from main; keep dialogs, terminals and inputs out of artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

const runFile = promisify(execFile);
const { startFixture } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
type Lab = {
  host: string; port: number; username: string; password: string; passphrase: string; privateKey: Buffer;
  directory: string; container: string; dispose(): Promise<void>; assertCleaned(): Promise<void>;
};

/** Items Keychain holds under a service name; attributes only, so no authorization prompt. */
async function keychainCount(service: string): Promise<number> {
  const { stdout } = await runFile("security", ["dump-keychain"], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split("\n").filter((line) => line.includes(`"svce"<blob>="${service}"`)).length;
}
async function fixtureContainers(): Promise<number> {
  const { stdout } = await runFile("docker", ["ps", "-aq", "--filter", "label=dev.ssterm.spike.fixture"]);
  return stdout.trim() ? stdout.trim().split("\n").length : 0;
}

/** Starts the runner-owned lab and writes each secret to a 0600 file only main reads. */
async function startLab() {
  const lab: Lab = await startFixture();
  const files = {
    password: join(lab.directory, "password"),
    wrongPassword: join(lab.directory, "wrong-password"),
    passphrase: join(lab.directory, "passphrase"),
    wrongPassphrase: join(lab.directory, "wrong-passphrase"),
  };
  await writeFile(files.password, lab.password, { mode: 0o600 });
  await writeFile(files.passphrase, lab.passphrase, { mode: 0o600 });
  await writeFile(files.wrongPassword, randomBytes(24).toString("hex"), { mode: 0o600 });
  await writeFile(files.wrongPassphrase, randomBytes(24).toString("hex"), { mode: 0o600 });
  const shells = async () => {
    try { return Number((await runFile("docker", ["exec", lab.container, "pgrep", "-c", "-f", "sshd: fixture@"])).stdout.trim()); }
    catch (error) { if ((error as { code?: number }).code === 1) return 0; throw new Error("Shell count unavailable"); }
  };
  return { lab, files, shells };
}

/** Main reads the secret file and sets the one matching input in the renderer; the value never crosses Playwright. */
function typeSecret(app: ElectronApplication, selector: string, file: string) {
  return expect.poll(() => app.evaluate(async ({ BrowserWindow }, { selector, file }) => {
    const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
    return BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
      const inputs = [...document.querySelectorAll(${JSON.stringify(selector)})];
      if (inputs.length !== 1 || inputs[0].disabled) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], ${JSON.stringify(value)});
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
      return true; })()`);
  }, { selector, file }), { message: `main typed into ${selector}` }).toBe(true);
}
const editorPassword = '[data-testid="identity-editor"] input[type="password"]';
const importPassphrase = '[data-testid="import-key-dialog"] input[type="password"]';
const promptInput = '[data-testid="credential-prompt-dialog"] input';

/** The open dialog returns `file`, looked up by main at call time. */
function stubFileDialog(app: ElectronApplication, file: string) {
  return app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
  }, file);
}

/**
 * Privacy evidence computed in main: profile SQLite/WAL bytes and the renderer's catalog state are checked against
 * the secret files and each of their base64 lines, "PRIVATE KEY" and the metadata's secret references. Only counts and booleans come back.
 */
function privacy(app: ElectronApplication, secretFiles: string[]) {
  return app.evaluate(async ({ app, BrowserWindow }, secretFiles) => {
    const require = process.getBuiltinModule("node:module").createRequire(app.getAppPath() + "/package.json");
    const fs = require("node:fs");
    const path = require("node:path");
    const { openMetadata } = require(path.join(app.getAppPath(), "out/main/storage.js"));
    const directory = path.join(app.getPath("userData"), "metadata");
    const names: string[] = fs.readdirSync(directory).filter((name: string) => /^catalog\.sqlite(-wal|-shm)?$/u.test(name));
    const blobs: Buffer[] = names.map((name) => fs.readFileSync(path.join(directory, name)));
    // Every base64 body line too, so a re-encoded or partial copy of a key is caught, not only the whole file.
    const lines = secretFiles.flatMap((file) => fs.readFileSync(file, "utf8").split(/\r?\n/u))
      .filter((line: string) => line.length >= 16 && !line.startsWith("-----")).map((line: string) => Buffer.from(line));
    const needles: Buffer[] = [...secretFiles.map((file) => fs.readFileSync(file)), ...lines, Buffer.from("PRIVATE KEY")];
    const opened = await openMetadata({ path: path.join(directory, "catalog.sqlite") });
    if (!opened.ok) throw new Error(`Second catalog connection: ${opened.error.code}`);
    let refs: string[] = [];
    try {
      const snapshot = opened.value.snapshot().value;
      refs = [snapshot.vault?.contentKeyRef, ...snapshot.identities.map((row: any) => row.passwordRef),
        ...snapshot.keys.flatMap((row: any) => [row.privateKeyRef, row.passphraseRef]),
        ...snapshot.secretOperations.flatMap((row: any) => [row.operationId, row.intendedRef, row.oldRef])].filter((ref) => typeof ref === "string");
    } finally { opened.value.close(); }
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const state: string = await contents.executeJavaScript(`(async () => {
      const boot = await window.ssterm.bootstrap();
      const result = await window.ssterm.catalogState({ owner: boot.value.owner });
      return JSON.stringify(result); })()`);
    const filledSecretInputs: number = await contents.executeJavaScript(
      `[...document.querySelectorAll('input[type="password"]')].filter((input) => input.value !== '').length`);
    return {
      files: names.sort(),
      metadataLeaks: blobs.some((bytes) => needles.some((needle) => bytes.includes(needle))),
      stateOk: state.startsWith('{"ok":true'),
      stateRefFields: /Ref"\s*:/u.test(state) || /operationId/u.test(state),
      stateRefValues: refs.filter((ref) => state.includes(ref)).length,
      stateSecrets: needles.some((needle) => state.includes(needle.toString("utf8"))),
      refsChecked: refs.length,
      filledSecretInputs,
    };
  }, secretFiles);
}

function ui(page: Page) {
  const hosts = page.getByTestId("hosts-page");
  /** A Servers table row, by the server's name. */
  const row = (label: string) => hosts.getByRole("row").filter({ has: page.locator("button[data-host-id]", { hasText: label }) });
  // The server openServer showed last; its row holds Connect, the identity and the status.
  let current = "";
  const identities = page.getByTestId("identities-page");
  const editor = page.getByTestId("identity-editor");
  const choose = async (dialog: Locator, label: string, option: string) => {
    await dialog.getByLabel(label, { exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  return {
    hosts, row, identities, editor, choose,
    server: page.getByTestId("server-editor"),
    get detail() { return row(current); },
    get connect() { return hosts.getByRole("button", { name: `Connect ${current}`, exact: true }); },
    trust: page.getByTestId("host-trust-dialog"),
    prompt: page.getByTestId("credential-prompt-dialog"),
    pane: (label: string) => page.locator(`section[aria-label="Terminal for ${label}"]`),
    async openIdentities() {
      await page.getByRole("button", { name: "Identities", exact: true }).click();
      await expect(identities).toBeVisible();
    },
    async openServer(label: string) {
      await page.getByRole("button", { name: /^All servers/u }).click();
      current = label;
      await expect(row(label)).toBeVisible();
    },
    async addServer(options: { label: string; address: string; group?: string; identity?: string; environment?: string }) {
      await hosts.getByRole("button", { name: "Add server" }).click();
      const server = page.getByTestId("server-editor");
      await server.getByLabel("Name").fill(options.label);
      await server.getByLabel("Address").fill(options.address);
      if (options.group) await choose(server, "Group", options.group);
      if (options.environment) await choose(server, "Environment", options.environment);
      if (options.identity) await choose(server, "Identity", options.identity);
      await server.getByRole("button", { name: "Save", exact: true }).click();
      await expect(server).toHaveCount(0);
      current = options.label;
      await expect(row(options.label)).toBeVisible();
    },
    /** Opens the editor for a new identity from either the empty state or the heading. */
    async newIdentity(label: string, username: string) {
      await identities.getByRole("tab", { name: "Identities" }).click();
      await identities.getByRole("button", { name: "New identity" }).first().click();
      await expect(editor).toBeVisible();
      await editor.getByLabel("Name", { exact: true }).fill(label);
      await editor.getByLabel("User name", { exact: true }).fill(username);
    },
    async save(dialog: Locator) {
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    },
    identityRow: (label: string) => identities.locator("li[data-identity-id]", { hasText: label }),
    keyRow: (label: string) => identities.locator("li[data-key-id]", { hasText: label }),
  };
}

/** Connects the selected server and waits for Ready; trust is answered when the dialog appears. */
async function connectReady(page: Page, u: ReturnType<typeof ui>, label: string, options: { trust?: boolean } = {}) {
  await u.connect.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terminals");
  if (options.trust) await u.trust.getByRole("button", { name: "Remember", exact: true }).click();
  const pane = u.pane(label);
  await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
  await expect(pane.locator(".xterm-rows")).toContainText("fixture@", { timeout: 20_000 });
  return pane;
}
/** Computed remotely, so the echoed command line alone cannot satisfy the assertion. */
async function remoteEcho(page: Page, pane: Locator, tag: string) {
  await pane.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(`echo "${tag}-$((40+2))"`);
  await page.keyboard.press("Enter");
  await expect(pane.locator(".xterm-rows")).toContainText(`${tag}-42`);
}
async function disconnect(pane: Locator) {
  // Disconnect ends the session and removes its pane.
  await pane.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(pane).toHaveCount(0);
}

/** Closes the app (teardown empties its namespace), then the lab, and checks nothing is left behind. */
async function finish(desktop: Desktop, started: Awaited<ReturnType<typeof startLab>> | undefined) {
  try {
    await desktop.close();
    if (started) expect(await started.shells(), "no server shell outlives the app").toBe(0);
  } finally {
    if (started) {
      started.lab.privateKey.fill(0);
      await started.lab.dispose();
      await started.lab.assertCleaned();
    }
  }
  expect(await keychainCount(desktop.secretNamespace), "teardown emptied the namespace").toBe(0);
  expect(await fixtureContainers(), "no fixture containers remain").toBe(0);
}

test("F03: a shared password identity saved in the Keychain connects grouped servers; replacing it affects only new connections", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const started = await startLab();
  const { lab, files, shells } = started;
  const { app, page } = desktop;
  const u = ui(page);
  const group = "PROD shared ห้องทดลอง";
  const [hostA, hostB] = ["Shared A กรุงเทพ", "Shared B เชียงใหม่"];
  const identity = "Lab shared";
  try {
    // Identity with the lab password saved, created through the editor.
    await u.openIdentities();
    await expect(u.identities.getByText("No identities yet", { exact: true })).toBeVisible();
    await u.newIdentity(identity, lab.username);
    await expect(u.editor.getByLabel("Password", { exact: true })).toBeVisible();
    await typeSecret(app, editorPassword, files.password);
    await u.save(u.editor);
    await expect(u.identityRow(identity)).toContainText("Saved in Keychain");
    expect(await keychainCount(desktop.secretNamespace), "one saved password").toBe(1);

    // A group selects the identity; two servers inherit it.
    await page.getByRole("button", { name: /^All servers/u }).click();
    await u.hosts.getByRole("button", { name: "New group" }).click();
    const groupEditor = page.getByTestId("group-editor");
    await groupEditor.getByLabel("Name").fill(group);
    await groupEditor.getByRole("button", { name: "Custom", exact: true }).click();
    await groupEditor.getByLabel("Custom port").fill(String(lab.port));
    await u.choose(groupEditor, "Identity", `${identity} (${lab.username})`);
    await u.save(groupEditor);
    for (const label of [hostA, hostB]) await u.addServer({ label, address: lab.host, group, environment: "PROD" });
    await expect(u.detail).toContainText(`${identity} (${lab.username})`);
    // The host drawer says where the identity comes from.
    await u.detail.locator("button[data-host-id]").click();
    await expect(u.server).toContainText(`Uses ${identity} (${lab.username}), from group ${group}.`);
    await page.keyboard.press("Escape");
    await expect(u.server).toHaveCount(0);
    await u.openIdentities();
    await expect(u.identityRow(identity)).toContainText("Used by 2 servers (0 direct, 2 via groups)");

    // Saved password: trust once, then neither server asks for anything.
    await u.openServer(hostA);
    const paneA = await connectReady(page, u, hostA, { trust: true });
    await expect(u.prompt).toHaveCount(0);
    await u.openServer(hostB);
    let paneB = await connectReady(page, u, hostB);
    await expect(u.trust).toHaveCount(0);
    await expect(u.prompt).toHaveCount(0);
    expect(await shells()).toBe(2);
    await disconnect(paneB);
    await expect.poll(shells).toBe(1);

    // Replace with a wrong password: the open session keeps its login, the next connection is denied.
    await u.openIdentities();
    await u.identityRow(identity).getByRole("button", { name: `Edit ${identity}` }).click();
    await expect(u.editor.getByText("Saved in Keychain.", { exact: true })).toBeVisible();
    await u.editor.getByRole("button", { name: "Replace", exact: true }).click();
    await expect(u.editor.getByLabel("New password", { exact: true })).toBeVisible();
    await expect(u.editor).toContainText("Leave blank to keep the saved password.");
    await typeSecret(app, editorPassword, files.wrongPassword);
    await u.save(u.editor);
    await expect(u.identityRow(identity)).toContainText("Saved in Keychain");
    await expect.poll(() => keychainCount(desktop.secretNamespace), { message: "the replaced password was removed" }).toBe(1);
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await expect(paneA).toHaveAttribute("data-phase", "ready");
    await remoteEcho(page, paneA, "STILL-ALIVE");
    await u.openServer(hostB);
    await u.connect.click();
    paneB = u.pane(hostB);
    await expect(paneB).toContainText("Couldn't connect: the server rejected the credentials", { timeout: 20_000 });
    await expect(u.prompt).toHaveCount(0);
    // Servers shows the failed session as its tab does, and hostA stays Connected.
    await page.getByRole("button", { name: "Servers", exact: true }).click();
    await expect(u.row(hostB).locator(".connection-status")).toHaveAttribute("data-state", "error");
    await expect(u.row(hostB).locator(".connection-status")).toHaveText("Connection error");
    await expect(u.row(hostA).locator(".connection-status")).toHaveText("Connected");
    await page.getByRole("button", { name: /^Terminals/u }).click();
    await paneB.getByRole("button", { name: "Close pane", exact: true }).click();
    await expect(paneB).toHaveCount(0);

    // Restore the right password: the next connection is Ready without a prompt.
    await u.openIdentities();
    await u.identityRow(identity).getByRole("button", { name: `Edit ${identity}` }).click();
    await u.editor.getByRole("button", { name: "Replace", exact: true }).click();
    await typeSecret(app, editorPassword, files.password);
    await u.save(u.editor);
    await u.openServer(hostB);
    paneB = await connectReady(page, u, hostB);
    await expect(u.prompt).toHaveCount(0);
    await remoteEcho(page, paneB, "RESTORED");
    expect(await shells()).toBe(2);
    await disconnect(paneB);
    await disconnect(paneA);
    await expect.poll(shells, { message: "Disconnect reaped both shells" }).toBe(0);

    // Privacy after the flows: no secret bytes in metadata, no references in the renderer, no filled inputs.
    const evidence = await privacy(app, [files.password, files.wrongPassword]);
    expect(evidence).toMatchObject({
      metadataLeaks: false, stateOk: true, stateRefFields: false, stateRefValues: 0, stateSecrets: false, filledSecretInputs: 0,
    });
    expect(evidence.files).toContain("catalog.sqlite");
    expect(evidence.refsChecked).toBeGreaterThan(0);

    // Forgetting the password confirms first, naming the group and every PROD server it reaches.
    await u.openIdentities();
    await u.identityRow(identity).getByRole("button", { name: `Edit ${identity}` }).click();
    await u.editor.getByRole("button", { name: "Forget saved password", exact: true }).click();
    await u.editor.getByRole("button", { name: "Save", exact: true }).click();
    // The impact review is a step inside the same editor drawer, not a stacked dialog.
    const forget = u.editor.getByRole("region", { name: "Forget the saved password?" });
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(forget.getByRole("list", { name: "Groups set to this identity" })).toContainText(group);
    const inheriting = forget.getByRole("list", { name: "Servers inheriting it through groups" });
    for (const label of [hostA, hostB]) await expect(inheriting.getByRole("listitem").filter({ hasText: label })).toContainText("PROD");
    // Esc on the impact step goes back to editing (no discard step); Save reaches it again, then Back to editing.
    await page.keyboard.press("Escape");
    await expect(forget).toHaveCount(0);
    await expect(u.editor.getByRole("alert", { name: "Discard unsaved changes?" })).toHaveCount(0);
    await expect(u.editor.getByRole("button", { name: "Save", exact: true })).toBeFocused();
    await u.editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(forget).toBeVisible();
    await u.editor.getByRole("button", { name: "Back to editing", exact: true }).click();
    await expect(forget).toHaveCount(0);
    await u.editor.getByRole("button", { name: "Keep saved password", exact: true }).click();
    await u.editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(u.editor).toHaveCount(0);
    expect(await keychainCount(desktop.secretNamespace), "Back to editing kept the password").toBe(1);

    // Deleting the identity in the UI removes its saved password from the Keychain.
    await u.openIdentities();
    await u.identityRow(identity).getByRole("button", { name: `Delete ${identity}` }).click();
    const remove = page.getByTestId("delete-identity-dialog");
    await remove.getByRole("radio", { name: /^Detach/u }).click();
    await expect(remove.getByTestId("delete-impacts")).toContainText("The saved password is removed from the Keychain.");
    await remove.getByRole("button", { name: "Delete identity", exact: true }).click();
    await expect(remove).toHaveCount(0);
    await expect.poll(() => keychainCount(desktop.secretNamespace), { message: "UI deletion emptied the namespace" }).toBe(0);
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("identities-f03-evidence", {
      body: JSON.stringify({ ...evidence, port: lab.port, platform: process.platform }),
      contentType: "application/json",
    });
  } finally {
    await finish(desktop, started);
  }
});

test("imports an encrypted Ed25519 key, connects without a prompt, and asks again after Forget passphrase; rejects unsupported files", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const started = await startLab();
  const { lab, files, shells } = started;
  const { app, page } = desktop;
  const u = ui(page);
  const keys = join(desktop.profile, "keys");
  const keyFile = join(keys, "id_lab");
  const keyLabel = "Lab key ทดสอบ";
  const identity = "Lab key identity";
  const server = "Key server";
  try {
    await runFile("mkdir", ["-m", "700", keys]);
    await writeFile(keyFile, lab.privateKey, { mode: 0o600 });
    // The lab key's fingerprint, derived in main from its public half.
    const expected = await app.evaluate(({}, file) => {
      const { createHash } = process.getBuiltinModule("node:crypto");
      const blob = Buffer.from(process.getBuiltinModule("node:fs").readFileSync(file, "utf8").trim().split(/\s+/u)[1], "base64");
      return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;
    }, join(lab.directory, "client_ed25519.pub"));
    expect(expected).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/u);

    await u.openIdentities();
    await u.identities.getByRole("tab", { name: "SSH keys" }).click();
    await expect(u.identities.getByText("No SSH keys yet", { exact: true })).toBeVisible();

    // Unsupported, too large and invalid files are refused with fixed copy; nothing is held.
    const importer = page.getByTestId("import-key-dialog");
    await u.identities.getByRole("button", { name: "Import key…" }).click();
    await expect(importer).toBeVisible();
    const openSshRsa = join(keys, "id_rsa_openssh");
    await runFile("ssh-keygen", ["-q", "-t", "rsa", "-b", "2048", "-N", "", "-C", "ssterm-owned-fixture", "-f", openSshRsa]);
    const garbage = join(keys, "garbage");
    await writeFile(garbage, "-----BEGIN OPENSSH PRIVATE KEY-----\nbm90IGEga2V5\n-----END OPENSSH PRIVATE KEY-----\n", { mode: 0o600 });
    const large = join(keys, "large");
    await writeFile(large, Buffer.alloc(70 * 1024, 0x41), { mode: 0o600 });
    const refusal = importer.getByRole("alert");
    const refused = [
      { file: join(lab.directory, "client_ed25519.pub"), copy: "This key type, format or protection is not supported." },
      { file: large, copy: "Key files must be 64 KiB or smaller." },
      { file: garbage, copy: "This file is not a private key ssterm can read." },
      { file: openSshRsa, copy: "ssh-keygen -p -m PEM -f <key file>" },
    ];
    for (const { file, copy } of refused) {
      await stubFileDialog(app, file);
      await importer.getByRole("button", { name: /^Choose (another )?file…$/u }).click();
      await expect(refusal).toContainText("This file cannot be imported");
      await expect(refusal).toContainText(copy);
      await expect(importer.getByRole("button", { name: "Import", exact: true })).toBeDisabled();
    }
    await rm(openSshRsa, { force: true });

    // Wrong passphrase keeps the import and refocuses the field; the right one with Save imports.
    await stubFileDialog(app, keyFile);
    await importer.getByRole("button", { name: "Choose file…" }).click();
    await expect(importer.getByText("Passphrase protected", { exact: true })).toBeVisible();
    const name = importer.getByLabel("Name", { exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue("id_lab");
    await name.fill(keyLabel);
    await typeSecret(app, importPassphrase, files.wrongPassphrase);
    await importer.getByRole("button", { name: "Import", exact: true }).click();
    await expect(importer).toContainText("That passphrase does not unlock this key.");
    await expect(importer.getByLabel("Passphrase", { exact: true })).toBeFocused();
    await expect(importer.getByLabel("Passphrase", { exact: true })).toHaveValue("");
    await typeSecret(app, importPassphrase, files.passphrase);
    await importer.getByRole("checkbox", { name: "Save passphrase in Keychain" }).click();
    await importer.getByRole("button", { name: "Import", exact: true }).click();
    await expect(importer).toHaveCount(0);
    const keyRow = u.keyRow(keyLabel);
    await expect(keyRow.getByLabel(`Fingerprint ${expected}`, { exact: true })).toBeVisible();
    await expect(keyRow).toContainText("Ed25519");
    await expect(keyRow).toContainText("Passphrase saved");
    expect(await keychainCount(desktop.secretNamespace), "private key and passphrase").toBe(2);

    // A key identity bound directly to a server connects without any prompt.
    await u.newIdentity(identity, lab.username);
    await u.editor.getByRole("radio", { name: "SSH key" }).or(u.editor.getByRole("button", { name: "SSH key", exact: true })).click();
    await u.choose(u.editor, "SSH key", `${keyLabel} · Ed25519`);
    await u.save(u.editor);
    await expect(u.identityRow(identity)).toContainText(keyLabel);
    await page.getByRole("button", { name: /^All servers/u }).click();
    await u.hosts.getByRole("button", { name: "New group" }).click();
    const groupEditor = page.getByTestId("group-editor");
    await groupEditor.getByLabel("Name").fill("Key lab");
    await groupEditor.getByRole("button", { name: "Custom", exact: true }).click();
    await groupEditor.getByLabel("Custom port").fill(String(lab.port));
    await u.save(groupEditor);
    await u.addServer({ label: server, address: lab.host, group: "Key lab", identity: `${identity} (${lab.username})` });
    let pane = await connectReady(page, u, server, { trust: true });
    await expect(u.prompt).toHaveCount(0);
    await remoteEcho(page, pane, "KEY");
    await disconnect(pane);
    await expect.poll(shells).toBe(0);

    // Forget the passphrase: the next connection asks for it through the SST-011 prompt.
    await u.openIdentities();
    await u.identities.getByRole("tab", { name: "SSH keys" }).click();
    const forgetButton = keyRow.getByRole("button", { name: `Forget passphrase for ${keyLabel}` });
    await forgetButton.click();
    const forget = page.getByTestId("forget-passphrase-key-dialog");
    // Destructive: Cancel takes focus, and Escape returns focus to the row action.
    await expect(forget.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(forget).toHaveCount(0);
    await expect(forgetButton).toBeFocused();
    await forgetButton.click();
    await forget.getByRole("button", { name: "Forget passphrase", exact: true }).click();
    await expect(forget).toHaveCount(0);
    await expect(keyRow).not.toContainText("Passphrase saved");
    await expect.poll(() => keychainCount(desktop.secretNamespace), { message: "the passphrase item was removed" }).toBe(1);
    await u.openServer(server);
    await u.connect.click();
    await expect(u.prompt).toBeVisible({ timeout: 20_000 });
    await expect(u.prompt).toContainText("Unlock your imported private key for this connection.");
    await typeSecret(app, promptInput, files.passphrase);
    await u.prompt.getByRole("button", { name: "Continue", exact: true }).click();
    pane = u.pane(server);
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await remoteEcho(page, pane, "PROMPTED");
    await disconnect(pane);
    await expect.poll(shells).toBe(0);

    const evidence = await privacy(app, [files.passphrase, files.wrongPassphrase, keyFile]);
    expect(evidence).toMatchObject({
      metadataLeaks: false, stateOk: true, stateRefFields: false, stateRefValues: 0, stateSecrets: false, filledSecretInputs: 0,
    });
    expect(evidence.refsChecked).toBeGreaterThan(0);

    // Delete in the UI: the identity first (the key is in use until then), then the key.
    await u.openIdentities();
    await u.identities.getByRole("tab", { name: "SSH keys" }).click();
    await expect(keyRow.getByRole("button", { name: `Delete ${keyLabel}` })).toHaveAttribute("aria-disabled", "true");
    await expect(keyRow).toContainText(`Can't delete: used by ${identity}.`);
    await u.identities.getByRole("tab", { name: "Identities" }).click();
    await u.identityRow(identity).getByRole("button", { name: `Delete ${identity}` }).click();
    const remove = page.getByTestId("delete-identity-dialog");
    await remove.getByRole("radio", { name: /^Detach/u }).click();
    await remove.getByRole("button", { name: "Delete identity", exact: true }).click();
    await expect(remove).toHaveCount(0);
    await u.identities.getByRole("tab", { name: "SSH keys" }).click();
    await keyRow.getByRole("button", { name: `Delete ${keyLabel}` }).click();
    const deleteKey = page.getByTestId("delete-key-dialog");
    await expect(deleteKey.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await deleteKey.getByRole("button", { name: "Delete key", exact: true }).click();
    await expect(deleteKey).toHaveCount(0);
    await expect(u.identities.getByText("No SSH keys yet", { exact: true })).toBeVisible();
    await expect.poll(() => keychainCount(desktop.secretNamespace), { message: "UI deletion emptied the namespace" }).toBe(0);
    expect(desktop.errors).toEqual([]);
    expect(desktop.externalRequests).toEqual([]);
    await testInfo.attach("identities-key-evidence", {
      body: JSON.stringify({ ...evidence, fingerprintMatched: true, refused: refused.length, platform: process.platform }),
      contentType: "application/json",
    });
  } finally {
    await finish(desktop, started);
  }
});

test("deleting a shared identity lists direct and inherited servers with PROD, then reassigns or detaches them", async ({ desktop }) => {
  const { app, page } = desktop;
  const u = ui(page);
  await changeCatalog(app, [
    { type: "create-identity", data: { label: "Shared ops", username: "ops", method: "password" } },
    { type: "create-identity", data: { label: "Backup ops", username: "backup", method: "keyboard-interactive" } },
    { type: "create-group", data: { label: "Fleet", auth: { mode: "value", identityId: "$0" } } },
    { type: "create-host", data: { label: "Fleet PROD", address: "fleet-1.example.test", groupId: "$2", environment: "PROD" } },
    { type: "create-host", data: { label: "Fleet DEV", address: "fleet-2.example.test", groupId: "$2", environment: "DEV" } },
    { type: "create-host", data: { label: "Direct PROD", address: "direct.example.test", environment: "PROD", auth: { mode: "value", identityId: "$0" } } },
    { type: "create-host", data: { label: "Backup only", address: "backup.example.test", auth: { mode: "value", identityId: "$1" } } },
  ]);
  await page.reload();
  await u.openIdentities();
  await expect(u.identityRow("Shared ops")).toContainText("Used by 3 servers (1 direct, 2 via groups)");

  const deleteShared = u.identityRow("Shared ops").getByRole("button", { name: "Delete Shared ops" });
  await deleteShared.click();
  const remove = page.getByTestId("delete-identity-dialog");
  await expect(remove.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(remove.getByRole("button", { name: "Delete identity", exact: true })).toBeDisabled();
  await remove.getByRole("radio", { name: "Reassign them to another identity" }).click();
  await u.choose(remove, "Use instead", "Backup ops (backup)");
  const impacts = remove.getByTestId("delete-impacts");
  const direct = impacts.getByRole("list", { name: "Servers set to this identity" });
  const inherited = impacts.getByRole("list", { name: "Servers inheriting it through groups" });
  await expect(direct.getByRole("listitem")).toHaveCount(1);
  await expect(direct.getByRole("listitem").filter({ hasText: "Direct PROD" }).getByText("PROD", { exact: true })).toBeVisible();
  await expect(impacts.getByRole("list", { name: "Groups set to this identity" })).toHaveText("Fleet");
  await expect(inherited.getByRole("listitem")).toHaveCount(2);
  await expect(inherited.getByRole("listitem").filter({ hasText: "Fleet PROD" }).getByText("PROD", { exact: true })).toBeVisible();
  await expect(inherited.getByRole("listitem").filter({ hasText: "Fleet DEV" })).toContainText("DEV");
  await expect(impacts).toContainText("They will use Backup ops.");
  await remove.getByRole("button", { name: "Delete identity", exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(u.identityRow("Shared ops")).toHaveCount(0);
  await expect(u.identityRow("Backup ops")).toContainText("Used by 4 servers (2 direct, 2 via groups)");
  for (const host of ["Fleet PROD", "Direct PROD"]) {
    await u.openServer(host);
    await expect(u.detail).toContainText("Backup ops (backup)");
  }

  await u.openIdentities();
  await u.identityRow("Backup ops").getByRole("button", { name: "Delete Backup ops" }).click();
  await expect(remove.getByRole("radio", { name: "Reassign them to another identity" })).toBeDisabled();
  await remove.getByRole("radio", { name: /^Detach/u }).click();
  await expect(remove.getByTestId("delete-impacts")).toContainText("They will have No identity.");
  await remove.getByRole("button", { name: "Delete identity", exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(u.identities.getByText("No identities yet", { exact: true })).toBeVisible();
  for (const host of ["Backup only", "Fleet DEV"]) {
    await u.openServer(host);
    await expect(u.detail).toContainText("No identity");
    await expect(u.connect).toHaveAttribute("aria-disabled", "true");
    await expect(u.connect).toHaveAccessibleDescription("Choose an identity to connect.");
  }
  expect(desktop.errors).toEqual([]);
});

test("Identities page keyboard and focus at 960×640 with reduced motion", async ({ desktop }) => {
  const { app, page } = desktop;
  const u = ui(page);
  await changeCatalog(app, [
    { type: "create-identity", data: { label: "Alpha", username: "alpha", method: "password" } },
    { type: "create-identity", data: { label: "Beta", username: "beta", method: "keyboard-interactive" } },
  ]);
  await page.reload();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(960);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await u.openIdentities();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  // Tab order: heading action, the tab list, then each row's actions in order.
  const create = u.identities.getByRole("button", { name: "New identity" });
  await create.focus();
  await page.keyboard.press("Tab");
  const identitiesTab = u.identities.getByRole("tab", { name: "Identities" });
  await expect(identitiesTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(u.identities.getByRole("tab", { name: "SSH keys" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(identitiesTab).toBeFocused();
  await expect(identitiesTab).toHaveAttribute("aria-selected", "true");
  const order: string[] = [];
  for (let i = 0; i < 6 && order.length < 4; i++) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
    if (name) order.push(name);
  }
  expect(order).toEqual(["Edit Alpha", "Delete Alpha", "Edit Beta", "Delete Beta"]);

  // Editor: opens on its first field, closes on Escape without changes, and returns focus to Edit.
  const edit = u.identityRow("Alpha").getByRole("button", { name: "Edit Alpha" });
  await edit.focus();
  await page.keyboard.press("Enter");
  await expect(u.editor).toBeVisible();
  await expect(u.editor.getByLabel("Name", { exact: true })).toBeFocused();
  expect(await u.editor.evaluate((node) => parseFloat(getComputedStyle(node).animationDuration))).toBeLessThan(0.001);
  await page.keyboard.press("Escape");
  await expect(u.editor).toHaveCount(0);
  await expect(edit).toBeFocused();

  // A dirty editor asks before discarding; Keep editing is focused.
  await page.keyboard.press("Enter");
  await u.editor.getByLabel("Name", { exact: true }).fill("Alpha renamed");
  await page.keyboard.press("Escape");
  // The discard step replaces the form inside the same drawer.
  const discard = u.editor.getByRole("alert", { name: "Discard unsaved changes?" });
  await expect(discard).toBeVisible();
  await expect(u.editor.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await u.editor.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(u.editor).toHaveCount(0);
  await expect(edit).toBeFocused();

  // Delete dialog: Cancel takes focus; Escape returns focus to the row's Delete.
  const remove = u.identityRow("Beta").getByRole("button", { name: "Delete Beta" });
  await remove.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("delete-identity-dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  expect(await dialog.evaluate((node) => parseFloat(getComputedStyle(node).animationDuration))).toBeLessThan(0.001);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(desktop.errors).toEqual([]);
});

/** Launches with a namespace the gate refuses, so main has no secret store; checks production stays untouched. */
async function withoutSecretStore(lab: boolean, run: (desktop: Desktop, started?: Awaited<ReturnType<typeof startLab>>) => Promise<void>) {
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-"));
  let desktop: Desktop | undefined;
  let started: Awaited<ReturnType<typeof startLab>> | undefined;
  const productionBefore = await keychainCount("dev.ssterm.desktop.secrets");
  try {
    // Not a dev.ssterm.test.<uuid> value, so main must not open any Keychain namespace.
    desktop = await launchDesktop(profile, { secretNamespace: "dev.ssterm.test.not-a-uuid" });
    if (lab) started = await startLab();
    await run(desktop, started);
  } finally {
    try {
      if (desktop) await finish(desktop, started);
      else if (started) { await started.lab.dispose(); await started.lab.assertCleaned(); }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  }
  expect(await keychainCount("dev.ssterm.desktop.secrets"), "the production namespace is untouched").toBe(productionBefore);
}

test("with no usable secret store (fail-closed namespace gate) saving and import are disabled with a reason; metadata-only identities can be created", async () => {
  await withoutSecretStore(false, async ({ page, errors }) => {
    const u = ui(page);
    await u.openIdentities();
    await expect(u.identities.getByText("The macOS Keychain is unavailable", { exact: true })).toBeVisible();
    await expect(u.identities).toContainText("Passwords, keys and passphrases cannot be saved right now.");
    await u.identities.getByRole("tab", { name: "SSH keys" }).click();
    await expect(u.identities.getByRole("button", { name: "Import key…" })).toBeDisabled();

    await u.newIdentity("Ask each time", "fixture");
    await expect(u.editor.locator('input[type="password"]')).toHaveCount(0);
    await expect(u.editor).toContainText("The Keychain is unavailable, so ssterm will ask for the password when connecting.");
    await u.editor.getByRole("button", { name: "SSH key", exact: true }).click();
    await expect(u.editor.getByRole("button", { name: "Import key…" })).toBeDisabled();
    await u.editor.getByRole("button", { name: "Password", exact: true }).click();
    await u.save(u.editor);
    await expect(u.identityRow("Ask each time")).toContainText("Asks when connecting");
    expect(errors).toEqual([]);
  });
});

test("with no usable secret store a metadata-only password identity still connects through the password prompt", async ({}, testInfo) => {
  test.setTimeout(180_000);
  await withoutSecretStore(true, async ({ app, page, errors }, started) => {
    const { lab, files, shells } = started!;
    const u = ui(page);
    await changeCatalog(app, [
      { type: "create-identity", data: { label: "Ask each time", username: lab.username, method: "password" } },
      { type: "create-host", data: { label: "Asks server", address: lab.host, port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId: "$0" } } },
    ]);
    await page.reload();
    await u.openServer("Asks server");
    await u.connect.click();
    const pane = u.pane("Asks server");
    // The UI promises "Identities can still ask for a password when connecting".
    await expect(u.trust.or(pane.getByText(/^Couldn't connect/u))).toBeVisible({ timeout: 20_000 });
    await expect(pane, "the session must not fail before authentication").not.toContainText("Couldn't connect");
    await u.trust.getByRole("button", { name: "Remember", exact: true }).click();
    await expect(u.prompt).toBeVisible();
    await typeSecret(app, promptInput, files.password);
    await u.prompt.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(pane).toHaveAttribute("data-phase", "ready", { timeout: 20_000 });
    await remoteEcho(page, pane, "NO-STORE");
    await disconnect(pane);
    await expect.poll(shells).toBe(0);
    const evidence = await privacy(app, [files.password]);
    expect(evidence).toMatchObject({ metadataLeaks: false, stateOk: true, stateRefFields: false, stateSecrets: false, filledSecretInputs: 0 });
    expect(errors).toEqual([]);
    await testInfo.attach("identities-no-store-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  });
});
