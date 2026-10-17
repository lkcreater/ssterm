// Builds THIRD_PARTY_NOTICES.txt for what the package ships: JS bundled into main/preload/renderer (from the build's
// module manifests), CSS/fonts imported by the stylesheet, Electron, and the npm packages staged outside the archive.
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Imported through `globals.css` (not visible in JS module graphs). */
export const CSS_PACKAGES = ["tailwindcss", "tw-animate-css", "shadcn", "@fontsource-variable/inter", "@fontsource-variable/jetbrains-mono", "@fontsource-variable/noto-sans-thai"];

function locate(root, name) {
  for (const base of [join(root, "apps/desktop/node_modules"), join(root, "node_modules")]) {
    const dir = join(base, name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  throw new Error(`notices: package not found: ${name}`);
}
async function licenseText(dir) {
  const files = (await readdir(dir)).filter((file) => /^(licen[cs]e|copying|notice)(\.|$)/iu.test(file)).sort();
  const texts = [];
  for (const file of files) texts.push((await readFile(join(dir, file), "utf8")).trim());
  return texts.join("\n\n");
}

export async function writeNotices({ root, out, staged, destination }) {
  const names = new Set([...CSS_PACKAGES, ...staged]);
  for (const target of ["main", "preload", "renderer"]) {
    const manifest = join(out, target, `third-party-modules-${target}.json`);
    for (const name of JSON.parse(await readFile(manifest, "utf8"))) names.add(name);
  }
  const sections = [];
  const summary = [];
  for (const name of [...names].sort()) {
    const dir = locate(root, name);
    const meta = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    // Some older packages (ssh2) still use the legacy `licenses` array.
    const license = typeof meta.license === "string" ? meta.license : meta.license?.type
      ?? (Array.isArray(meta.licenses) ? meta.licenses.map((row) => row.type).join(" OR ") : undefined) ?? "UNKNOWN";
    if (license === "UNKNOWN") throw new Error(`notices: no license field for ${name}`);
    const text = await licenseText(dir);
    if (!text) throw new Error(`notices: no license file for ${name}@${meta.version}`);
    summary.push({ name, version: meta.version, license });
    sections.push(`${"=".repeat(78)}\n${name}@${meta.version} — ${license}\n${"=".repeat(78)}\n\n${text}\n`);
  }
  const electronMeta = JSON.parse(await readFile(join(locate(root, "electron"), "package.json"), "utf8"));
  // The prebuilt keyring addon statically links Rust crates; point to their upstream licences rather than omit them.
  const native = [
    "The native module @napi-rs/keyring-darwin-arm64 (keyring.darwin-arm64.node, MIT, same project as @napi-rs/keyring)",
    "statically links Rust crates including napi, napi-derive, keyring, security-framework and core-foundation,",
    "distributed under MIT and/or Apache-2.0; see https://github.com/Brooooooklyn/keyring-node and each crate's repository.",
  ];
  const header = [
    "ssterm — third-party notices",
    "",
    "This application includes the software listed below under the licenses reproduced here.",
    `Electron ${electronMeta.version} (MIT) and Chromium: see LICENSE.electron.txt and LICENSES.chromium.html in Contents/Resources.`,
    "",
    ...summary.map((row) => `- ${row.name}@${row.version} (${row.license})`),
    "",
    ...native,
    "",
  ].join("\n");
  await writeFile(destination, `${header}\n${sections.join("\n")}`);
  return summary;
}
