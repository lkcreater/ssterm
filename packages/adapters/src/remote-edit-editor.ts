import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, normalize } from "node:path";
import type { RemoteEditEditor } from "@ssterm/domain";

type Launch = (binary: string, args: readonly string[], options: { signal?: AbortSignal; timeout: number }) => Promise<void>;
const launchNative: Launch = (binary, args, options) => new Promise((resolve, reject) => {
  execFile(binary, [...args], { ...options, maxBuffer: 1_024, windowsHide: true }, (error) => error ? reject(error) : resolve());
});
/** No renderer-selected application, shell, extension dispatch, or process environment test override. */
export function createRemoteEditEditor(options: { launch?: Launch; platform?: NodeJS.Platform } = {}): RemoteEditEditor {
  const launch = options.launch ?? launchNative;
  return {
    async open(documentPath, signal) {
      if (signal?.aborted) return { ok: false, code: "cancelled" };
      if ((options.platform ?? process.platform) !== "darwin") return { ok: false, code: "unsupported" };
      if (!isAbsolute(documentPath) || normalize(documentPath) !== documentPath || basename(documentPath) !== "document.txt" ||
        !/^edit-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(basename(dirname(documentPath))) ||
        basename(dirname(dirname(documentPath))) !== "remote-edit-temp") return { ok: false, code: "invalid-request" };
      try {
        // -e selects TextEdit; /usr/bin/open acknowledges dispatch, not editor lifetime/save.
        await launch("/usr/bin/open", ["-e", documentPath], { signal, timeout: 10_000 });
        return signal?.aborted ? { ok: false, code: "cancelled" } : { ok: true, value: undefined };
      } catch {
        return { ok: false, code: signal?.aborted ? "cancelled" : "editor-unavailable" };
      }
    },
  };
}
