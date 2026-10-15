import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import renderer from "./vite.config";

const contracts = fileURLToPath(
  new URL("../../packages/contracts/src/index.ts", import.meta.url),
);

export default defineConfig({
  main: {
    resolve: { alias: { "@ssterm/contracts": contracts } },
    build: {
      externalizeDeps: {
        exclude: [
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
    resolve: { alias: { "@ssterm/contracts": contracts } },
    build: {
      externalizeDeps: { exclude: ["@ssterm/contracts"] },
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
