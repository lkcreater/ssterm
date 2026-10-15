import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const { executable } = JSON.parse(
  await readFile(
    new URL("../artifacts/package-path.json", import.meta.url),
    "utf8",
  ),
);
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", "--project=packaged"],
  {
    stdio: "inherit",
    env: { ...process.env, SSTERM_PACKAGED_EXECUTABLE: executable },
  },
);
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
