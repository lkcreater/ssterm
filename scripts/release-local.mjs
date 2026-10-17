// Local, reviewable release artifacts from the packaged app (run after `npm run package:mac`). Nothing is uploaded,
// published or notarized. Output (ignored): artifacts/release/SSTerm-<version>-darwin-arm64.zip, SHA256SUMS,
// release-manifest.json.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packaged = JSON.parse(await readFile(join(root, "artifacts/package-path.json"), "utf8"));
const out = join(root, "artifacts/release");
const allowDirty = process.argv.includes("--allow-dirty");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
// The manifest must describe the bundle being zipped: same commit, built from a clean tree.
if (!allowDirty && (packaged.commit !== head || packaged.workingTreeClean !== true))
  throw new Error(`release:local: the package was built from ${packaged.commit ?? "an unknown commit"}${packaged.workingTreeClean ? "" : " with uncommitted changes"}; commit and run package:mac again, or pass --allow-dirty for a local trial`);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const sha256 = (path) => new Promise((done, fail) => {
  const hash = createHash("sha256");
  createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", fail).on("end", () => done(hash.digest("hex")));
});
// The bundle must still verify before it is archived.
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", packaged.bundle], { stdio: "ignore" });
const name = `SSTerm-${packaged.version}-darwin-arm64.zip`;
const zip = join(out, name);
// ditto keeps the bundle's symlinks, extended attributes and code signature intact.
execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", packaged.bundle, zip]);
const digest = await sha256(zip);
await writeFile(join(out, "SHA256SUMS"), `${digest}  ${name}\n`);
const manifest = {
  product: "ssterm",
  version: packaged.version,
  bundleId: packaged.identifier,
  platform: `${packaged.platform}-${packaged.arch}`,
  electron: packaged.electron,
  minimumMacOS: execFileSync("/usr/bin/plutil", ["-extract", "LSMinimumSystemVersion", "raw", join(packaged.bundle, "Contents/Info.plist")], { encoding: "utf8" }).trim(),
  signature: { kind: "ad-hoc", identifier: packaged.identifier, developerId: false, notarized: false },
  commit: packaged.commit,
  workingTreeClean: packaged.workingTreeClean,
  trial: allowDirty && (packaged.commit !== head || packaged.workingTreeClean !== true),
  artifact: { file: basename(zip), bytes: (await stat(zip)).size, sha256: digest },
  createdAt: new Date().toISOString(),
};
await writeFile(join(out, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
