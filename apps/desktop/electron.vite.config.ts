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
      externalizeDeps: { exclude: ["@ssterm/contracts"] },
      rollupOptions: {
        input: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)),
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
