import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  channels, failure, isConfigureRecordingRequest, isDeleteRecordingsRequest, isExportRecordingRequest, isForgetCommandRequest,
  isRecordingStateRequest, isSuggestCommandsRequest, type ExportRecordingTarget, type Owner, type Result,
} from "@ssterm/contracts";
import type { Recorder, SessionRegistry } from "@ssterm/services";
import type { WindowBoundary } from "./boundary";
import { sessionOwnerId } from "./session-runtime";

/** Every IPC channel `registerRecordingHandlers` owns. */
export const recordingChannels = Object.freeze([
  channels.recordingState, channels.configureRecording, channels.deleteRecordings, channels.exportRecording,
  channels.suggestCommands, channels.forgetCommand,
]);
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const stamp = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}-${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`;
/** A file name the save dialog proposes: the captured label and start time, nothing a path could interpret. */
export function exportName(target: ExportRecordingTarget, recorder: Pick<Recorder, "state">, now = new Date()): string {
  if (target.kind === "history") return `ssterm-command-history-${stamp(now)}.txt`;
  const log = recorder.state().logs.find((entry) => entry.id === target.id);
  const label = (log?.label ?? "session").normalize("NFC").replace(/[^\p{L}\p{M}\p{N} ._-]+/gu, "-").replace(/^[.\s-]+|[.\s-]+$/gu, "").slice(0, 80) || "session";
  return `ssterm-${label}-${stamp(new Date(log?.startedAt ?? now.getTime()))}.log`;
}

/**
 * Owner-authorized recording commands (the app lock answers `unauthorized` first). The history scope of suggest and
 * forget comes from the exact live generation in main, never from the renderer. Export paths never cross IPC: main
 * asks through its own save dialog.
 */
export function registerRecordingHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: Pick<WindowBoundary, "authorizeOwner">;
  recorder: () => Recorder | undefined;
  registry: () => Pick<SessionRegistry, "snapshot"> | undefined;
  /** Main-owned save dialog anchored to the owner's window; undefined when cancelled. */
  chooseDestination(owner: Owner, suggestedName: string): Promise<string | undefined>;
}): () => void {
  const handle = <T>(channel: string, validate: (value: unknown) => value is T, run: (recorder: Recorder, request: T, owner: Owner) => Promise<unknown>) => {
    options.ipc.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const recorder = options.recorder();
        if (!recorder) return failure("unavailable");
        return await run(recorder, request, authorized.value);
      } catch { return failure("unavailable"); }
    });
  };
  /** scope = saved host id or "local", from the exact owner's live, Ready terminal generation. */
  const scope = (owner: Owner, sessionId: string, generation: number): string | undefined => {
    const session = options.registry()?.snapshot(sessionOwnerId(owner), sessionId)
      .find((item) => item.kind === "terminal" && item.generation === generation && item.state === "Ready");
    return session ? session.hostId ?? "local" : undefined;
  };
  handle(channels.recordingState, isRecordingStateRequest, async (recorder) => ok(recorder.state()));
  handle(channels.configureRecording, isConfigureRecordingRequest, async (recorder, request) => ok(await recorder.configure({ ...request.policy })));
  handle(channels.deleteRecordings, isDeleteRecordingsRequest, async (recorder, request) => ok(await recorder.delete(request.target)));
  handle(channels.exportRecording, isExportRecordingRequest, async (recorder, request, owner) => {
    const destination = await options.chooseDestination(owner, exportName(request.target, recorder));
    if (!destination) return ok({ status: "cancelled" });
    return ok(await recorder.export(request.target, destination));
  });
  handle(channels.suggestCommands, isSuggestCommandsRequest, async (recorder, request, owner) => {
    const found = scope(owner, request.sessionId, request.generation);
    return found ? ok(await recorder.suggest(found, request.prefix)) : failure("conflict");
  });
  handle(channels.forgetCommand, isForgetCommandRequest, async (recorder, request, owner) => {
    const found = scope(owner, request.sessionId, request.generation);
    return found ? ok(await recorder.forget(found, request.text)) : failure("conflict");
  });
  return () => { for (const channel of recordingChannels) options.ipc.removeHandler(channel); };
}
