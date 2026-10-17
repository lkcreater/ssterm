import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import renderer from "./vite.config";
import { moduleManifest } from "./module-manifest";

function googleClient(): { clientId: string; clientSecret: string } | null {
  const file = process.env.SSTERM_GOOGLE_CLIENT_FILE;
  if (!file) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { installed?: { client_id?: string; client_secret?: string } };
  const installed = parsed.installed;
  if (!installed?.client_id || !installed.client_secret) throw new Error("SSTERM_GOOGLE_CLIENT_FILE must be an installed-app client JSON");
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

const contracts = fileURLToPath(
  new URL("../../packages/contracts/src/index.ts", import.meta.url),
);

export default defineConfig({
  main: {
    plugins: [moduleManifest("main")],
    // The installed-app Google client (ADR 0004): read at build time, never committed. Google does not treat an
    // installed app's secret as confidential; without a file the Google option is disabled.
    define: { __SSTERM_GOOGLE_CLIENT__: JSON.stringify(googleClient()) },
    resolve: { alias: { "@ssterm/contracts": contracts } },
    build: {
      externalizeDeps: {
        include: ["ssh2"],
        exclude: [
          "zod",
          "@ssterm/contracts",
          "@ssterm/domain",
          "@ssterm/adapters",
          "@ssterm/services",
        ],
      },
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)),
          storage: fileURLToPath(
            new URL("./src/main/storage.ts", import.meta.url),
          ),
          secrets: fileURLToPath(
            new URL("./src/main/secrets.ts", import.meta.url),
          ),
          catalog: fileURLToPath(
            new URL("./src/main/catalog.ts", import.meta.url),
          ),
          sessions: fileURLToPath(
            new URL("./src/main/sessions.ts", import.meta.url),
          ),
          trust: fileURLToPath(new URL("./src/main/trust.ts", import.meta.url)),
          ssh: fileURLToPath(new URL("./src/main/ssh.ts", import.meta.url)),
        },
        preserveEntrySignatures: "strict",
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
        },
      },
    },
  },
  preload: {
    plugins: [moduleManifest("preload")],
    resolve: { alias: { "@ssterm/contracts": contracts } },
    build: {
      externalizeDeps: { exclude: ["@ssterm/contracts", "zod"] },
      rollupOptions: {
        input: fileURLToPath(
          new URL("./src/preload/index.ts", import.meta.url),
        ),
        output: { format: "cjs", entryFileNames: "index.js" },
      },
    },
  },
  renderer,
});
