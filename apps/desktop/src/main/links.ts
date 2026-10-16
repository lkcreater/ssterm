import type { IpcMain, WebContents } from "electron";
import { channels, failure, isOpenLinkRequest, MAX_LINK_URL, type OpenLinkResponse, type Result } from "@ssterm/contracts";
import type { WindowBoundary } from "./boundary";

/** Returns the normalized href only for credential-free http(s) URLs. */
export function validateExternalUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_LINK_URL) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  return parsed.href.length <= MAX_LINK_URL ? parsed.href : undefined;
}

export function registerLinkHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  open: (href: string, sender: WebContents) => Promise<boolean>;
}): () => void {
  options.ipc.handle(channels.openLink, async (event, ...args: unknown[]): Promise<Result<OpenLinkResponse>> => {
    try {
      const request = args[0];
      const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
      const authorized = options.boundary.authorizeOwner(event, owner);
      if (!authorized.ok) return authorized;
      if (args.length !== 1 || !isOpenLinkRequest(request)) return failure("invalid-request");
      const href = validateExternalUrl(request.url);
      if (!href) return failure("invalid-request");
      return { ok: true, value: { opened: (await options.open(href, event.sender)) === true } };
    } catch { return failure("unavailable"); }
  });
  return () => options.ipc.removeHandler(channels.openLink);
}
