import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, expect } from "./fixtures";

// SST-028 artifact review of the packaged app on disk; runs only in the packaged project.
const executable = process.env.SSTERM_PACKAGED_EXECUTABLE;
const bundle = executable ? resolve(dirname(executable), "../..") : "";
const plist = (key: string) => execFileSync("/usr/bin/plutil", ["-extract", key, "raw", join(bundle, "Contents/Info.plist")], { encoding: "utf8" }).trim();
const has = (key: string) => { try { plist(key); return true; } catch { return false; } };

test.skip(!executable, "packaged project only");

test("bundle identity, version, usage strings, icon and signature are release-ready (ad-hoc, unsigned by Developer ID)", async () => {
  const version = JSON.parse(readFileSync("apps/desktop/package.json", "utf8")).version;
  expect(plist("CFBundleIdentifier")).toBe("dev.ssterm.desktop");
  expect(plist("CFBundleShortVersionString")).toBe(version);
  expect(plist("CFBundleVersion")).toBe(version);
  expect(Number(plist("LSMinimumSystemVersion").split(".")[0])).toBeGreaterThanOrEqual(13);
  for (const key of ["NSDesktopFolderUsageDescription", "NSDocumentsFolderUsageDescription", "NSDownloadsFolderUsageDescription",
    "NSNetworkVolumesUsageDescription", "NSRemovableVolumesUsageDescription"]) expect(plist(key)).toMatch(/^ssterm /u);
  for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"]) expect(has(key), key).toBe(false);
  // The derived icon replaces Electron's and comes from icon v2 (ADR 0008); qa.json records its source.
  const qa = JSON.parse(readFileSync("artifacts/icons/qa.json", "utf8"));
  const v2 = execFileSync("shasum", ["-a", "256", "docs/logo/icon-logo-v2.png"], { encoding: "utf8" }).split(" ")[0];
  expect(qa.source.sha256).toBe(v2);
  const icon = join(bundle, "Contents/Resources", plist("CFBundleIconFile"));
  const derived = execFileSync("shasum", ["-a", "256", "artifacts/icons/ssterm.icns"], { encoding: "utf8" }).split(" ")[0];
  expect(execFileSync("shasum", ["-a", "256", icon], { encoding: "utf8" }).split(" ")[0]).toBe(derived);
  // Stable ad-hoc identity with sealed resources, strictly valid.
  const details = execFileSync("/bin/sh", ["-c", `/usr/bin/codesign -dv "${bundle}" 2>&1`], { encoding: "utf8" });
  expect(details).toContain("Identifier=dev.ssterm.desktop");
  expect(details).toContain("Signature=adhoc");
  expect(details).toMatch(/Sealed Resources version=2/u);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  // Fuses: no run-as-node, no NODE_OPTIONS, archive-only with integrity validation.
  // eslint-disable-next-line no-control-regex -- the CLI colours its output.
  const fuses = execFileSync(process.execPath, ["node_modules/@electron/fuses/dist/bin.js", "read", "--app", bundle], { encoding: "utf8" }).replace(/\u001b\[[0-9;]*m/gu, "");
  for (const line of ["RunAsNode is Disabled", "EnableNodeOptionsEnvironmentVariable is Disabled", "EnableEmbeddedAsarIntegrityValidation is Enabled", "OnlyLoadAppFromAsar is Enabled"])
    expect(fuses, line).toContain(line);
});

test("package contents: offline fonts, notices and licences, native keyring unpacked, no Windows helper, fixtures or build metadata", async () => {
  const { listPackage } = createRequire(import.meta.url)("@electron/asar") as { listPackage(path: string): string[] };
  const files = listPackage(join(bundle, "Contents/Resources/app.asar"));
  // Inter, JetBrains Mono and Noto Sans Thai ship as local woff2 (font-src 'self'; no network).
  for (const family of ["inter-latin", "jetbrains-mono-latin", "noto-sans-thai-thai"])
    expect(files.some((file) => file.startsWith("/out/renderer/assets/") && file.includes(family) && file.endsWith(".woff2")), family).toBe(true);
  const forbidden = files.filter((file) => /pagent|\/ssh2\/(test|examples)\/|third-party-modules|\.map$|showcase\/fixtures/u.test(file));
  expect(forbidden).toEqual([]);
  expect(existsSync(join(bundle, "Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node"))).toBe(true);
  const native = join(bundle, "Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64");
  for (const name of ["pty.node", "spawn-helper"]) {
    expect(existsSync(join(native, name)), name).toBe(true);
    expect(execFileSync("/usr/bin/file", [join(native, name)], { encoding: "utf8" })).toContain("arm64");
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", join(native, name)]);
  }
  expect(statSync(join(native, "spawn-helper")).mode & 0o111).toBe(0o111);
  expect(files.filter(file => /node-pty\/(?:deps|src|test|third_party)(?:\/|$)|node-pty\/prebuilds\/(?!darwin-arm64(?:\/|$))/u.test(file))).toEqual([]);
  const notices = readFileSync(join(bundle, "Contents/Resources/THIRD_PARTY_NOTICES.txt"), "utf8");
  for (const name of ["@xterm/xterm@", "ssh2@", "node-pty@1.1.0", "@napi-rs/keyring@", "react@", "@fontsource-variable/noto-sans-thai@", "tweetnacl@"])
    expect(notices, name).toContain(name);
  expect(notices).not.toContain("(UNKNOWN)");
  expect(notices).toContain("SIL OPEN FONT LICENSE");
  expect(notices).toContain("Node.js API collaborators");
  for (const file of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) expect(existsSync(join(bundle, "Contents/Resources", file)), file).toBe(true);
  // SST-041: the stdio bridge agent CLIs start, outside the archive so /bin/sh can read it.
  expect(readFileSync(join(bundle, "Contents/Resources/ssterm-mcp"), "utf8")).toMatch(/^#!\/bin\/sh\n[^]*\| \/usr\/bin\/nc -U "\$SSTERM_MCP_SOCKET" 2>\/dev\/null \| \{\n[^]*\n\} &\nwait \$!\n$/u);
  // No build-machine paths or user names inside the shipped JavaScript.
  const home = process.env.HOME ?? "/Users/";
  const leaks = execFileSync("/bin/sh", ["-c", `grep -rl --binary-files=text -F "${home}" "${join(bundle, "Contents/Resources/app.asar")}" || true`], { encoding: "utf8" }).trim();
  expect(leaks).toBe("");
});

test("the local release zip, when built, verifies its checksum and extracts to a strictly valid bundle", async () => {
  const zip = join("artifacts/release", `SSTerm-${plist("CFBundleShortVersionString")}-darwin-arm64.zip`);
  test.skip(!existsSync(zip), "run npm run release:local first");
  const sums = readFileSync("artifacts/release/SHA256SUMS", "utf8").trim().split(/\s+/u);
  expect(execFileSync("shasum", ["-a", "256", zip], { encoding: "utf8" }).split(" ")[0]).toBe(sums[0]);
  // No resource-fork or extended-attribute sidecars (machine metadata) in the archive.
  expect(execFileSync("/usr/bin/zipinfo", ["-1", zip], { encoding: "utf8" })).not.toContain("__MACOSX");
  const target = await mkdtemp(join(tmpdir(), "ssterm-release-"));
  try {
    execFileSync("/usr/bin/ditto", ["-x", "-k", zip, target]);
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(target, "SSTerm.app")]);
    const manifest = JSON.parse(readFileSync("artifacts/release/release-manifest.json", "utf8"));
    expect(manifest).toMatchObject({ bundleId: "dev.ssterm.desktop", signature: { kind: "ad-hoc", developerId: false, notarized: false } });
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
