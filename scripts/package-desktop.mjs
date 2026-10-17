import { packager } from "@electron/packager";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeNotices } from "./third-party-notices.mjs";

/**
 * Bundle identity. Storage (userData "ssterm") and the Keychain service name do not depend on the signature, but
 * macOS binds Keychain item access and folder (TCC) grants to the code signature: an ad-hoc signature is identified
 * by its cdhash, which changes with every build, so those prompts can return after an upgrade until Developer ID.
 */
const BUNDLE_ID = "dev.ssterm.desktop";
const plist = (bundle, ...args) => execFileSync("/usr/bin/plutil", [...args, join(bundle, "Contents/Info.plist")]);

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Local packaging requires macOS arm64");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const source = JSON.parse(
  await readFile(join(desktop, "package.json"), "utf8"),
);
const stage = await mkdtemp(join(tmpdir(), "ssterm-package-"));
try {
  // Build manifests list bundled packages for the notices; they are build metadata, not runtime files.
  await cp(join(desktop, "out"), join(stage, "out"), {
    recursive: true,
    filter: (path) => !/third-party-modules-[a-z]+\.json$/u.test(path),
  });
  // External runtime dependencies: Keychain prebuilt and the pinned SSH parser's JS closure.
  // No optional CPU detection or SSH native acceleration is built or staged.
  const staged = [
    "@napi-rs/keyring",
    "@napi-rs/keyring-darwin-arm64",
    "ssh2",
    "asn1",
    "safer-buffer",
    "bcrypt-pbkdf",
    "tweetnacl",
  ];
  for (const name of staged) {
    await cp(join(root, "node_modules", name), join(stage, "node_modules", name), {
      recursive: true,
      // ssh2's upstream tests/examples are not runtime code and include private-key fixtures; pagent.exe is the
      // Windows Pageant helper, never used on macOS.
      filter: (path) => !/\/ssh2\/(test|examples)(\/|$)/u.test(path) && !/\/ssh2\/util\/(pagent|build_pagent)/u.test(path),
    });
  }
  // Notices, Electron/Chromium licences and the derived app icon travel as Contents/Resources files.
  const resources = join(stage, "resources");
  await mkdir(resources, { recursive: true });
  const notices = join(resources, "THIRD_PARTY_NOTICES.txt");
  await writeNotices({ root, out: join(desktop, "out"), staged: staged.filter((name) => name !== "@napi-rs/keyring-darwin-arm64"), destination: notices });
  const electronDist = join(root, "node_modules/electron/dist");
  await cp(join(electronDist, "LICENSE"), join(resources, "LICENSE.electron.txt"));
  await cp(join(electronDist, "LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html"));
  execFileSync(process.execPath, [join(root, "scripts/make-icons.mjs")], { stdio: "ignore" });
  const icon = join(root, "artifacts/icons/ssterm.icns");
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify(
      {
        name: "ssterm",
        productName: "SSTerm",
        version: source.version,
        private: true,
        type: "commonjs",
        main: "out/main/index.js",
      },
      null,
      2,
    ),
  );
  const output = join(root, "artifacts/package");
  await mkdir(output, { recursive: true });
  const require = createRequire(import.meta.url);
  const runtime = resolve(require("electron"), "..", "..", "..");
  const electronZipDir = join(root, "artifacts/electron-zip");
  await mkdir(electronZipDir, { recursive: true });
  execFileSync(
    "/usr/bin/ditto",
    [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      runtime,
      join(electronZipDir, "electron-v44.7.2-darwin-arm64.zip"),
    ],
    { timeout: 60_000 },
  );
  const paths = await packager({
    dir: stage,
    out: output,
    name: "SSTerm",
    appBundleId: BUNDLE_ID,
    appVersion: source.version,
    buildVersion: source.version,
    appCopyright: "Copyright © 2026 ssterm contributors",
    icon,
    extraResource: [notices, join(resources, "LICENSE.electron.txt"), join(resources, "LICENSES.chromium.html")],
    // Explains each folder prompt in ssterm's words; the Files page reads only folders the user opens.
    extendInfo: {
      NSDesktopFolderUsageDescription: "ssterm shows and transfers files in the Desktop folder when you open it in Files.",
      NSDocumentsFolderUsageDescription: "ssterm shows and transfers files in the Documents folder when you open it in Files.",
      NSDownloadsFolderUsageDescription: "ssterm shows and transfers files in the Downloads folder when you open it in Files.",
      NSNetworkVolumesUsageDescription: "ssterm shows and transfers files on network volumes when you open them in Files.",
      NSRemovableVolumesUsageDescription: "ssterm shows and transfers files on removable volumes when you open them in Files.",
    },
    platform: "darwin",
    arch: "arm64",
    electronVersion: "44.7.2",
    electronZipDir,
    // Native addons cannot be dlopen()ed from inside the archive.
    asar: { unpack: "**/*.node" },
    overwrite: true,
    prune: false,
  });
  const bundle = join(paths[0], "SSTerm.app");
  // Electron's template asks for devices ssterm never uses; remove those generic prompts.
  for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"]) {
    try { plist(bundle, "-remove", key); } catch { /* absent */ }
  }
  await rm(join(paths[0], "__MACOSX"), { recursive: true, force: true });
  // Local provenance/quarantine attributes are machine metadata; strip them before sealing.
  execFileSync("/usr/bin/xattr", ["-cr", bundle]);
  // Ad-hoc signature with a stable identifier (no Developer ID is available): nested code first, then the app,
  // so the Info.plist and resources are sealed and the identity is dev.ssterm.desktop instead of "Electron".
  execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "ignore" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", BUNDLE_ID, bundle], { stdio: "ignore" });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "ignore" });
  await writeFile(
    join(root, "artifacts/package-path.json"),
    JSON.stringify(
      {
        bundle: join(paths[0], "SSTerm.app"),
        executable: join(paths[0], "SSTerm.app/Contents/MacOS/SSTerm"),
        electron: "44.7.2",
        platform: "darwin",
        arch: "arm64",
        signed: false,
        signature: "ad-hoc",
        identifier: BUNDLE_ID,
        version: source.version,
        // What the bundle was built from; release:local refuses a package that no longer matches HEAD.
        commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        workingTreeClean: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Packaged unsigned desktop: ${paths[0]}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
