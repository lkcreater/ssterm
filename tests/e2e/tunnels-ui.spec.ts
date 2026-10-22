import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, changeCatalog, launchDesktop, type Desktop } from "./fixtures";
import { renderedContrast } from "./support/transfer-fixture";

// The lab password is typed from main and saved in the test Keychain namespace; keep automatic artifacts off.
test.use({ trace: "off", screenshot: "off", video: "off" });

const { startFixture, portIsOpen } = createRequire(import.meta.url)("../../spikes/ssh-compat/src/fixture.cjs");
const server = "ฐานข้อมูล อุโมงค์";

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}
function get(port: number): Promise<{ status: number; fixtureBody: boolean }> {
  return new Promise((done) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/", agent: false, timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body = (body + chunk).slice(0, 16_384); });
      response.on("end", () => done({ status: response.statusCode ?? 0, fixtureBody: body === "ssterm-fixture-ok\n" }));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => done({ status: 0, fixtureBody: false }));
  });
}
/** SOCKS5 CONNECT to 127.0.0.1:8080 through the dynamic rule, then one HTTP GET: the SOCKS reply and HTTP status. */
function socksGet(port: number): Promise<{ reply: number; status: number }> {
  return new Promise((done) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let stage = 0;
    const finish = () => {
      socket.destroy();
      done({ reply: buffer.length >= 4 ? buffer[3]! : -1, status: Number(/HTTP\/1\.[01] (\d{3})/u.exec(buffer.subarray(12).toString())?.[1] ?? 0) });
    };
    setTimeout(finish, 8_000);
    socket.on("error", () => undefined);
    socket.on("close", finish);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2) { stage = 1; socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x1f, 0x90])); }
      if (stage === 1 && buffer.length >= 12) { stage = 2; if (buffer[3] === 0) socket.write("GET / HTTP/1.0\r\n\r\n"); else finish(); }
    });
    socket.write(Buffer.from([5, 1, 0]));
  });
}
/** A GET from inside the fixture container to the server-side listener of a remote rule. */
function containerGet(container: string, port: number): Promise<string> {
  const script = `import urllib.request\ntry:\n print(urllib.request.urlopen('http://127.0.0.1:${port}/', timeout=5).read().decode(), end='')\nexcept Exception as e:\n print('ERR', type(e).__name__, end='')`;
  return new Promise((done) => execFile("docker", ["exec", container, "python3", "-c", script], { timeout: 20_000 }, (_error, stdout) => done(String(stdout))));
}
function ui(page: Page) {
  const root = page.getByTestId("tunnels-page");
  const editor = page.getByTestId("tunnel-editor");
  return {
    root, editor,
    nav: page.getByRole("button", { name: "Port forwarding", exact: false }),
    row: (label: string) => root.locator("li[data-rule-id]").filter({ hasText: label }),
  };
}

test("F06: a saved rule forwards HTTP only while started, reports collisions, restarts explicitly and never autostarts", async ({ desktop }, testInfo) => {
  test.setTimeout(240_000);
  const { app, page } = desktop;
  const lab = await startFixture();
  let again: Desktop | undefined;
  try {
    // Identity with a saved password typed from main, then one saved server on the owned lab.
    const secret = join(lab.directory, "password");
    await writeFile(secret, lab.password, { mode: 0o600 });
    await page.getByRole("button", { name: "Identities", exact: true }).click();
    const identities = page.getByTestId("identities-page");
    await identities.getByRole("button", { name: "New identity" }).first().click();
    const identityEditor = page.getByTestId("identity-editor");
    await identityEditor.getByLabel("Name", { exact: true }).fill("Lab tunnel");
    await identityEditor.getByLabel("User name", { exact: true }).fill(lab.username);
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }, file) => {
      const value = process.getBuiltinModule("node:fs").readFileSync(file, "utf8");
      return BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(`(() => {
        const inputs = [...document.querySelectorAll('[data-testid="identity-editor"] input[type="password"]')];
        if (inputs.length !== 1 || inputs[0].disabled) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inputs[0], ${JSON.stringify(value)});
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true; })()`);
    }, secret)).toBe(true);
    await identityEditor.getByRole("button", { name: "Save", exact: true }).click();
    const identityRow = identities.locator("li[data-identity-id]", { hasText: "Lab tunnel" });
    await expect(identityRow).toContainText("Saved in Keychain");
    const identityId = await identityRow.getAttribute("data-identity-id");
    await changeCatalog(app, [{ type: "create-host", data: {
      label: server, address: lab.host, environment: "PROD", port: { mode: "value", port: lab.port }, auth: { mode: "value", identityId },
    } }]);
    // The second connection's commit is not observed by main's projection; reload to read it.
    await page.reload();
    await expect(page.getByTestId("hosts-page")).toContainText(server);

    const s = ui(page);
    await s.nav.click();
    await expect(s.root.getByText("No forwarding rules yet")).toBeVisible();
    const port = await freePort();
    await s.root.getByRole("button", { name: "New rule" }).click();
    await expect(s.editor.getByLabel("Name", { exact: true })).toBeFocused();
    await expect(s.editor.getByRole("heading", { name: "New local forwarding rule" })).toBeVisible();
    await s.editor.getByLabel("Name", { exact: true }).fill("เว็บ fixture");
    await expect(s.editor.getByText("Resolved and connected by the SSH server, not this Mac.")).toBeVisible();
    // Invalid ports are refused in place.
    await s.editor.getByLabel("Local port").fill("70000");
    await s.editor.getByLabel("Destination port").fill("8080");
    await s.editor.getByRole("button", { name: "Save rule" }).click();
    await expect(s.editor.getByText("Enter a local port from 1 to 65535.")).toBeVisible();
    await s.editor.getByLabel("Local port").fill(String(port));
    await s.editor.getByRole("button", { name: "Save rule" }).click();
    await expect(s.editor).toHaveCount(0);
    const row = s.row("เว็บ fixture");
    await expect(row).toContainText(`127.0.0.1:${port}`);
    await expect(row).toContainText("127.0.0.1:8080");
    await expect(row).toContainText(server);
    await expect(row).toContainText("PROD");
    await expect(row.locator(".tunnel-status")).toHaveText("Stopped");
    expect(await portIsOpen(port), "saving never starts a tunnel").toBe(false);

    // Start: the shared host-key policy asks; only after SSH is ready does it read Running.
    await row.getByRole("button", { name: "Start เว็บ fixture" }).click();
    await page.getByTestId("host-trust-dialog").getByRole("button", { name: "Remember", exact: true }).click();
    await expect(row.locator(".tunnel-status")).toContainText("Running");
    expect(await get(port)).toEqual({ status: 200, fixtureBody: true });

    // A duplicate rule on the same port saves, but its start fails visibly and never reads Running.
    await s.root.getByRole("button", { name: "New rule" }).click();
    await s.editor.getByLabel("Name", { exact: true }).fill("Duplicate");
    await s.editor.getByLabel("Local port").fill(String(port));
    await s.editor.getByLabel("Destination port").fill("8080");
    await s.editor.getByRole("button", { name: "Save rule" }).click();
    const duplicate = s.row("Duplicate");
    await duplicate.getByRole("button", { name: "Start Duplicate" }).click();
    await expect(duplicate.locator(".tunnel-status")).toHaveText("Failed");
    await expect(duplicate).toContainText("The local port is already in use on this Mac.");
    await expect(row.locator(".tunnel-status")).toContainText("Running");

    // Deleting the server while its tunnel runs is refused with a reason.
    await page.getByRole("button", { name: /^All servers/u }).click();
    await page.getByTestId("hosts-page").locator("button[data-host-id]", { hasText: server }).click();
    await page.getByTestId("host-detail").getByRole("button", { name: "Delete", exact: false }).first().click();
    await expect(page.getByTestId("delete-host-drawer")).toContainText("A tunnel on this server is running.");
    await page.getByTestId("delete-host-drawer").getByRole("button", { name: "Cancel" }).click();

    // Editing a running rule states the restart and restarts explicitly.
    await s.nav.click();
    await row.getByRole("button", { name: "Edit เว็บ fixture" }).click();
    await expect(s.editor).toContainText("This tunnel is running");
    await s.editor.getByLabel("Name", { exact: true }).fill("เว็บ fixture 2");
    await s.editor.getByRole("button", { name: "Save and restart" }).click();
    await expect(s.editor).toHaveCount(0);
    const renamed = s.row("เว็บ fixture 2");
    await expect(renamed.locator(".tunnel-status")).toContainText("Running");
    expect(await get(port)).toEqual({ status: 200, fixtureBody: true });

    // SOCKS rule: no destination fields, usage text, real HTTP through CONNECT.
    const choose = async (label: string, option: string) => {
      await s.editor.getByLabel(label, { exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    const socksPort = await freePort();
    await s.root.getByRole("button", { name: "New rule" }).click();
    await s.editor.getByLabel("Name", { exact: true }).fill("SOCKS proxy");
    await choose("Type", "SOCKS: a proxy on this Mac");
    await expect(s.editor.getByRole("heading", { name: "New SOCKS proxy rule" })).toBeVisible();
    await expect(s.editor.getByTestId("socks-usage")).toBeVisible();
    await expect(s.editor.getByLabel("Destination port")).toBeHidden();
    await s.editor.getByLabel("Local port").fill(String(socksPort));
    await s.editor.getByRole("button", { name: "Save rule" }).click();
    await expect(s.editor).toHaveCount(0);
    const socksRow = s.row("SOCKS proxy");
    await expect(socksRow).toHaveAttribute("data-type", "dynamic");
    await expect(socksRow).toContainText("SOCKS5, destinations opened by the server");
    await socksRow.getByRole("button", { name: "Start SOCKS proxy" }).click();
    await expect(socksRow.locator(".tunnel-status")).toContainText("Running");
    expect(await socksGet(socksPort)).toEqual({ reply: 0, status: 200 });

    // Remote rule: a public server address warns; port 0 lets the server choose; a container GET reaches this Mac.
    const local = http.createServer((_request, response) => response.end("ssterm-remote-ok\n"));
    await new Promise<void>((done) => local.listen(0, "127.0.0.1", done));
    try {
      await s.root.getByRole("button", { name: "New rule" }).click();
      await s.editor.getByLabel("Name", { exact: true }).fill("กลับมาที่ Mac");
      await choose("Type", "Remote: a port on the server");
      await expect(s.editor.getByRole("heading", { name: "New remote forwarding rule" })).toBeVisible();
      await expect(s.editor.getByText("Resolved and connected by this Mac.", { exact: false })).toBeVisible();
      await choose("Server address", "0.0.0.0 (every IPv4 address)");
      await expect(s.editor.getByText("Reachable from other machines")).toBeVisible();
      await choose("Server address", "127.0.0.1 (IPv4 loopback)");
      await expect(s.editor.getByText("Reachable from other machines")).toHaveCount(0);
      await s.editor.getByLabel("Server port").fill("0");
      await s.editor.getByLabel("Destination port").fill(String((local.address() as net.AddressInfo).port));
      await s.editor.getByRole("button", { name: "Save rule" }).click();
      await expect(s.editor).toHaveCount(0);
      const remoteRow = s.row("กลับมาที่ Mac");
      await expect(remoteRow).toContainText("127.0.0.1:assigned");
      await remoteRow.getByRole("button", { name: "Start กลับมาที่ Mac" }).click();
      await expect(remoteRow.locator(".tunnel-status")).toContainText("Running");
      const assigned = Number(await remoteRow.getByTestId("tunnel-remote-port").textContent());
      expect(assigned).toBeGreaterThan(0);
      await expect(remoteRow).toContainText(`127.0.0.1:${assigned}`);
      expect(await containerGet(lab.container, assigned)).toBe("ssterm-remote-ok\n");
      await remoteRow.getByRole("button", { name: "Stop กลับมาที่ Mac" }).click();
      await expect(remoteRow.locator(".tunnel-status")).toHaveText("Stopped");
      expect(await containerGet(lab.container, assigned)).toMatch(/^ERR/u);
      // Switching a SOCKS rule's type keeps the loopback address and needs a destination.
      await socksRow.getByRole("button", { name: "Stop SOCKS proxy" }).click();
      await expect(socksRow.locator(".tunnel-status")).toHaveText("Stopped");
      await socksRow.getByRole("button", { name: "Edit SOCKS proxy" }).click();
      await choose("Type", "Local: a port on this Mac");
      await s.editor.getByLabel("Destination port").fill("");
      await s.editor.getByRole("button", { name: "Save" , exact: true }).click();
      await expect(s.editor.getByText("Enter a destination port from 1 to 65535.")).toBeVisible();
      // Cancel on an edited rule is a discard step inside the same drawer; nothing is saved.
      await s.editor.getByRole("button", { name: "Cancel" }).click();
      await expect(s.editor.getByRole("button", { name: "Keep editing" })).toBeFocused();
      await s.editor.getByRole("button", { name: "Discard" }).click();
      await expect(s.editor).toHaveCount(0);
      await expect(socksRow).toHaveAttribute("data-type", "dynamic");
    } finally {
      await new Promise<void>((done) => local.close(() => done()));
    }

    // 960×640: rows fit and status text meets 4.5:1.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(960, 640));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(960);
    expect(await s.root.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
    for (const [name, locator] of [
      ["running", renamed.locator(".tunnel-status > span").first()],
      ["failed", duplicate.locator(".tunnel-status > span").first()],
      ["error", duplicate.locator(".tunnel-error")],
    ] as const) expect((await renderedContrast(locator)).ratio, name).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: testInfo.outputPath("tunnels-960x640.png") });

    // Stop closes the listener.
    await renamed.getByRole("button", { name: "Stop เว็บ fixture 2" }).click();
    await expect(renamed.locator(".tunnel-status")).toHaveText("Stopped");
    expect(await portIsOpen(port)).toBe(false);
    await renamed.getByRole("button", { name: "Start เว็บ fixture 2" }).click();
    await expect(renamed.locator(".tunnel-status")).toContainText("Running");
    expect(desktop.errors).toEqual([]);

    // Relaunch: rules persist, nothing starts by itself, and the old listener died with the app.
    await desktop.close({ keepSecrets: true });
    expect(await portIsOpen(port), "quit closed the listener").toBe(false);
    again = await launchDesktop(desktop.profile, { secretNamespace: desktop.secretNamespace });
    const r = ui(again.page);
    await r.nav.click();
    await expect(r.row("เว็บ fixture 2").locator(".tunnel-status")).toHaveText("Stopped");
    await expect(r.row("Duplicate").locator(".tunnel-status")).toHaveText("Stopped");
    expect(await portIsOpen(port), "no autostart after restart").toBe(false);
    // Delete asks with Cancel focused and removes the rule.
    await r.row("Duplicate").getByRole("button", { name: "Delete Duplicate" }).click();
    const remove = again.page.getByTestId("delete-tunnel-dialog");
    await expect(remove.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(remove).toHaveAttribute("role", "alertdialog");
    await remove.getByRole("button", { name: "Delete rule" }).click();
    await expect(remove).toHaveCount(0);
    await expect(r.row("Duplicate")).toHaveCount(0);
    expect(again.errors).toEqual([]);
  } finally {
    if (again) await again.close();
    else await desktop.close().catch(() => undefined);
    lab.privateKey.fill(0);
    await lab.dispose();
    await lab.assertCleaned();
  }
});
