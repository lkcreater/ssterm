import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  channels, failure, isCredentialStateRequest, isAnswerCredentialsRequest, isCancelCredentialPromptRequest,
  type Owner, type CredentialState,
} from "@ssterm/contracts";
import type { WindowBoundary } from "./boundary";
import type { createCredentialsController } from "./credentials";
type Controller = ReturnType<typeof createCredentialsController>;
/** IPC owns the deserialized answer arrays and erases them on every return path. */
function wipe(value: unknown) {
  if (!value || typeof value !== "object" || !("values" in value) || !Array.isArray(value.values)) return;
  for (const field of value.values) {
    if (field && typeof field === "object" && "value" in field && field.value instanceof Uint8Array) field.value.fill(0);
  }
}
export function registerCredentialHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => Controller | undefined;
}) {
  const ownedChannels = [channels.credentialState, channels.answerCredentials, channels.cancelCredentialPrompt];
  const register = (event: IpcMainInvokeEvent, owner: Owner, controller: Controller) => controller.register(owner, (state: CredentialState) => {
    if (!event.sender.isDestroyed()) event.sender.send(channels.credentialStateChanged, state);
  });
  const handle = <T>(channel: string, validate: (value: unknown) => value is T, run: (controller: Controller, request: T) => unknown) => {
    options.ipc.handle(channel, (event, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner = request && typeof request === "object" && "owner" in request ? request.owner : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request)) return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        register(event, authorized.value, controller);
        return run(controller, request);
      } catch { return failure("unavailable"); }
      finally { if (channel === channels.answerCredentials) for (const arg of args) wipe(arg); }
    });
  };
  handle(channels.credentialState, isCredentialStateRequest, (controller, request) => controller.credentialState(request.owner));
  handle(channels.answerCredentials, isAnswerCredentialsRequest, (controller, request) => controller.answerCredentials(request));
  handle(channels.cancelCredentialPrompt, isCancelCredentialPromptRequest, (controller, request) => controller.cancelCredentialPrompt(request));
  return () => { for (const channel of ownedChannels) options.ipc.removeHandler(channel); };
}
