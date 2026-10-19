import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
require("electron");
// npm ci --ignore-scripts deliberately avoids native rebuild/download scripts. The pinned N-API
// macOS prebuild already ships in node-pty; its npm archive omits the helper's execute bits.
if (process.platform === "darwin" && process.arch === "arm64") {
  const root = dirname(require.resolve("node-pty/package.json"));
  chmodSync(join(root, "prebuilds/darwin-arm64/spawn-helper"), 0o755);
  require("node-pty");
}
