import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { contentSecurityPolicy } from "./src/main/security";
import { moduleManifest } from "./module-manifest";

export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  base: "./",
  // Keep even small font subsets in local files accepted by font-src 'self'.
  build: { assetsInlineLimit: 0 },
  plugins: [
    react(),
    tailwindcss(),
    moduleManifest("renderer"),
    {
      name: "ssterm-production-csp",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler: () => [
          {
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: contentSecurityPolicy(),
            },
            injectTo: "head-prepend",
          },
        ],
      },
    },
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
      "@ssterm/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
