import { packager } from "@electron/packager";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("SST-004 local packaging requires macOS arm64");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const source = JSON.parse(
  await readFile(join(desktop, "package.json"), "utf8"),
);
const stage = await mkdtemp(join(tmpdir(), "ssterm-package-"));
try {
  await cp(join(desktop, "out"), join(stage, "out"), { recursive: true });
  // The main bundle keeps the Keychain binding external: ship its loader and arm64 prebuilt only.
  for (const name of ["@napi-rs/keyring", "@napi-rs/keyring-darwin-arm64"]) {
    await cp(join(root, "node_modules", name), join(stage, "node_modules", name), {
      recursive: true,
    });
  }
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
    appBundleId: "dev.ssterm.desktop",
    platform: "darwin",
    arch: "arm64",
    electronVersion: "44.7.2",
    electronZipDir,
    // Native addons cannot be dlopen()ed from inside the archive.
    asar: { unpack: "**/*.node" },
    overwrite: true,
    prune: false,
  });
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
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Packaged unsigned desktop: ${paths[0]}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
