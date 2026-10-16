import type { IpcMain } from "electron";
import type { AppSettings, MetadataRepository, StoreResult } from "@ssterm/domain";
import {
  channels, failure, isSettingsRequest, isUpdateSettingsRequest, type Result, type TerminalSettings,
} from "@ssterm/contracts";
import type { WindowBoundary } from "./boundary";

export const settingsChannels = Object.freeze([channels.settings, channels.updateSettings]);

const project = (settings: AppSettings): TerminalSettings => ({
  terminalFontSize: settings.terminalFontSize,
  terminalScrollback: settings.terminalScrollback,
  terminalCursor: settings.terminalCursor,
  terminalCursorBlink: settings.terminalCursorBlink,
});
function result(stored: StoreResult<{ settings: AppSettings }>): Result<TerminalSettings> {
  if (stored.ok) return { ok: true, value: project(stored.value.settings) };
  const code = stored.error.code;
  return failure(code === "conflict" ? "conflict" : code === "invalid-request" || code === "constraint" ? "invalid-request" : "unavailable");
}

export function registerSettingsHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  /** Undefined while metadata storage is blocked. */
  repository: () => MetadataRepository | undefined;
}): () => void {
  const handle = <T>(channel: string, validate: (value: unknown) => value is T, run: (repository: MetadataRepository, request: T) => Result<TerminalSettings>) => {
    options.ipc.handle(channel, (event, ...args: unknown[]): Result<TerminalSettings> => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const repository = options.repository();
        return repository ? run(repository, request) : failure("unavailable");
      } catch { return failure("unavailable"); }
    });
  };
  handle(channels.settings, isSettingsRequest, (repository) => result(repository.snapshot()));
  handle(channels.updateSettings, isUpdateSettingsRequest, (repository, request) => {
    const current = repository.snapshot();
    if (!current.ok) return result(current);
    return result(repository.commit({
      expectedCatalogRevision: current.value.catalogRevision,
      changes: [{ type: "update-settings", expectedRevision: current.value.settings.revision, data: { ...request.changes } }],
    }));
  });
  return () => { for (const channel of settingsChannels) options.ipc.removeHandler(channel); };
}
