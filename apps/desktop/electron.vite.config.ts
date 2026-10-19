import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import renderer from "./vite.config";
import { moduleManifest } from "./module-manifest";

/**
 * The Google OAuth client (ADR 0004) for this build. Read from the shell environment, or from the gitignored
 * `.env.local` at the repository root (see `.env.example`): either SSTERM_GOOGLE_CLIENT_ID + SSTERM_GOOGLE_CLIENT_SECRET,
 * or SSTERM_GOOGLE_CLIENT_FILE pointing at the downloaded "Desktop app" client JSON. Nothing set: Google is disabled.
 */
function googleClient(): { clientId: string; clientSecret: string } | null {
  const local = fileURLToPath(new URL("../../.env.local", import.meta.url));
  // Values already exported in the shell win over the file.
  if (existsSync(local)) process.loadEnvFile(local);
  const id = process.env.SSTERM_GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.SSTERM_GOOGLE_CLIENT_SECRET?.trim();
  const file = process.env.SSTERM_GOOGLE_CLIENT_FILE?.trim();
  let client: { clientId: string; clientSecret: string } | null = null;
  if (id || secret) {
    if (!id || !secret) throw new Error("Set both SSTERM_GOOGLE_CLIENT_ID and SSTERM_GOOGLE_CLIENT_SECRET (or neither).");
    client = { clientId: id, clientSecret: secret };
  } else if (file) {
    const parsed = JSON.parse(readFileSync(file.replace(/^~(?=\/)/u, homedir()), "utf8")) as { installed?: { client_id?: string; client_secret?: string } };
    const installed = parsed.installed;
    if (!installed?.client_id || !installed.client_secret) throw new Error("SSTERM_GOOGLE_CLIENT_FILE must be a Desktop app (installed) client JSON.");
    client = { clientId: installed.client_id, clientSecret: installed.client_secret };
  }
  if (client && !/^[\w.-]+\.apps\.googleusercontent\.com$/u.test(client.clientId))
    throw new Error("SSTERM_GOOGLE_CLIENT_ID must end with .apps.googleusercontent.com.");
  return client;
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
        include: ["ssh2", "node-pty"],
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
      externalizeDeps: { exclude: ["@ssterm/contracts", "@ssterm/domain", "zod"] },
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
