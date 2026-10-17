import type { Plugin } from "vite";

/**
 * Lists the npm packages a build actually bundles (names only, no paths), so the package's third-party notices
 * cover exactly what ships. Written next to the bundle and excluded from the packaged app by the package script.
 */
export function moduleManifest(target: string): Plugin {
  return {
    name: "ssterm-module-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const names = new Set<string>();
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        for (const id of Object.keys(item.modules)) {
          const at = id.lastIndexOf("/node_modules/");
          if (at < 0) continue;
          const parts = id.slice(at + "/node_modules/".length).split("/");
          names.add(parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!);
        }
      }
      this.emitFile({ type: "asset", fileName: `third-party-modules-${target}.json`, source: `${JSON.stringify([...names].sort(), null, 2)}\n` });
    },
  };
}
