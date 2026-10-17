import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { test, expect, changeCatalog, launchDesktop } from "./fixtures";
import { downgradeToSchemaV1 } from "../fixtures/storage/schema-v1";

// SST-028 upgrade fixture: a profile written by a different build (the development build) reopens in the packaged
// build with storage and Keychain identifiers unchanged. SST-031: the seeded store is rewritten to the schema-1
// tunnel_rule layout first, so the packaged build runs the real v1→v2 migration (with its backup) on open.
test.use({ trace: "off", screenshot: "off", video: "off" });
const packaged = process.env.SSTERM_PACKAGED_EXECUTABLE;
test.skip(!packaged, "packaged project only");

const BODY = "#!/bin/sh\necho \"อัปเกรด ✓\"\n";
const listening = (port: number) => new Promise<boolean>((done) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
});

test("metadata written by another build reopens in the packaged build; Keychain-held secrets survive relaunch of the same signed build", async () => {
  test.setTimeout(150_000);
  const profile = await mkdtemp(join(tmpdir(), "ssterm-e2e-upgrade-"));
  const namespace = `dev.ssterm.test.${crypto.randomUUID()}`;
  // Set while Keychain items are deliberately kept between launches; the outer finally empties them on failure.
  let kept = false;
  try {
    // 1. Seed metadata with the development build of the same sources. No Keychain item is created here: macOS binds
    //    an item to the signature that created it, so another build would need an access prompt (see docs/release).
    delete process.env.SSTERM_PACKAGED_EXECUTABLE;
    let seeded;
    try { seeded = await launchDesktop(profile, { secretNamespace: namespace }); }
    finally { process.env.SSTERM_PACKAGED_EXECUTABLE = packaged; }
    try {
      await changeCatalog(seeded.app, [
        { type: "create-identity", data: { label: "Upgrade identity", username: "alice", method: "password" } },
        { type: "create-host", data: { label: "เซิร์ฟเวอร์อัปเกรด", address: "upgrade.example", environment: "PROD", auth: { mode: "value", identityId: "$0" } } },
        { type: "create-tunnel-rule", data: { label: "Upgrade rule", hostId: "$1", bindPort: 18765, destinationHost: "127.0.0.1", destinationPort: 80 } },
      ]);
      const settings = await seeded.page.evaluate(async () => {
        const boot = await window.ssterm.bootstrap();
        if (!boot.ok) return "bootstrap";
        const result = await window.ssterm.updateSettings({ owner: boot.value.owner, changes: { terminalFontSize: 17 } });
        return result.ok ? "ok" : "settings";
      });
      expect(settings).toBe("ok");
    } finally {
      await seeded.close();
    }
    const store = join(profile, "metadata/catalog.sqlite");
    expect(existsSync(store), "storage location is userData/metadata/catalog.sqlite").toBe(true);
    // The schema-1 layout: local-only, loopback-only tunnel rules (the table shipped before SST-031).
    const v1 = new DatabaseSync(store);
    try {
      downgradeToSchemaV1(v1);
    } finally {
      v1.close();
    }

    // 2. The packaged build reads it unchanged, starts nothing, then saves secrets under the same namespace.
    const first = await launchDesktop(profile, { secretNamespace: namespace });
    try {
      const state = await first.page.evaluate(async ({ body }) => {
        const boot = await window.ssterm.bootstrap();
        if (!boot.ok) throw new Error("bootstrap");
        const owner = boot.value.owner;
        const catalog = await window.ssterm.catalogState({ owner });
        const settings = await window.ssterm.settings({ owner });
        const tunnels = await window.ssterm.tunnelState({ owner });
        if (!catalog.ok) throw new Error("catalog");
        const identity = catalog.value.identities[0]!;
        const password = await window.ssterm.setIdentityPassword({ owner, identityId: identity.id, expectedRevision: identity.revision, value: new TextEncoder().encode("fixture-upgrade-password") });
        const snippet = await window.ssterm.saveSnippet({ owner, snippetId: null, expectedRevision: null, label: "Upgrade snippet", body, tagIds: [] });
        return {
          storage: boot.value.storage,
          host: catalog.value.hosts.map((row) => `${row.label}/${row.environment}`),
          rules: catalog.value.tunnelRules.map((row) => row.label),
          fontSize: settings.ok ? settings.value.terminalFontSize : 0,
          runningTunnels: tunnels.ok ? tunnels.value.tunnels.length : -1,
          password: password.ok ? password.value.status : password.error.code,
          snippet: snippet.ok ? snippet.value.status : snippet.error.code,
        };
      }, { body: BODY });
      expect(state).toEqual({
        storage: { status: "ready", schemaVersion: 2 }, host: ["เซิร์ฟเวอร์อัปเกรด/PROD"], rules: ["Upgrade rule"],
        fontSize: 17, runningTunnels: 0, password: "saved", snippet: "saved",
      });
      expect(readdirSync(join(profile, "metadata")).filter((name) => /^catalog\.sqlite\.v1-.+\.backup$/u.test(name)), "a schema-1 backup is kept").toHaveLength(1);
      expect(await listening(18765), "rules never autostart after an upgrade").toBe(false);
      expect(first.errors).toEqual([]);
    } finally {
      await first.close({ keepSecrets: true });
      kept = true;
    }

    // 3. Relaunching the same signed build finds the password and decrypts the snippet with the stored content key.
    const second = await launchDesktop(profile, { secretNamespace: namespace });
    try {
      const reopened = await second.page.evaluate(async () => {
        const boot = await window.ssterm.bootstrap();
        if (!boot.ok) throw new Error("bootstrap");
        const owner = boot.value.owner;
        const catalog = await window.ssterm.catalogState({ owner });
        if (!catalog.ok) throw new Error("catalog");
        const snippet = catalog.value.snippets[0]!;
        const opened = await window.ssterm.openSnippet({ owner, snippetId: snippet.id, expectedRevision: snippet.revision });
        return { passwordSaved: catalog.value.identities[0]?.passwordSaved, body: opened.ok && opened.value.status === "open" ? opened.value.body : JSON.stringify(opened) };
      });
      expect(reopened).toEqual({ passwordSaved: true, body: BODY });
      expect(second.errors).toEqual([]);
    } finally {
      await second.close();
      kept = false;
    }
  } finally {
    process.env.SSTERM_PACKAGED_EXECUTABLE = packaged;
    // The same signed build created the items, so a short launch can empty the namespace without a prompt.
    if (kept) await launchDesktop(profile, { secretNamespace: namespace }).then((cleanup) => cleanup.close()).catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});
