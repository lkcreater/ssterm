import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  channels,
  failure,
  isAnswerHostTrustRequest,
  isPrepareKnownHostRevokeRequest,
  isRevokeKnownHostRequest,
  isTrustStateRequest,
  type Owner,
  type TrustState,
} from "@ssterm/contracts";
import type { WindowBoundary } from "./boundary";
import type { createKnownHostsController } from "./known-hosts";

type Controller = ReturnType<typeof createKnownHostsController>;

/** A narrow production handler factory, reused by owned Electron fixtures. */
export function registerKnownHostHandlers(options: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  boundary: WindowBoundary;
  controller: () => Controller | undefined;
}) {
  const ownedChannels = [
    channels.trustState,
    channels.answerHostTrust,
    channels.prepareKnownHostRevoke,
    channels.revokeKnownHost,
  ];
  const registerOwner = (
    event: IpcMainInvokeEvent,
    owner: Owner,
    controller: Controller,
  ) => {
    controller.register(owner, (state: TrustState) => {
      if (!event.sender.isDestroyed())
        event.sender.send(channels.trustStateChanged, state);
    });
  };
  const handle = <T>(
    channel: string,
    validate: (value: unknown) => value is T,
    run: (controller: Controller, request: T) => unknown,
  ) => {
    options.ipc.handle(channel, (event, ...args: unknown[]) => {
      try {
        const request = args[0];
        const owner =
          request && typeof request === "object" && "owner" in request
            ? request.owner
            : undefined;
        const authorized = options.boundary.authorizeOwner(event, owner);
        if (!authorized.ok) return authorized;
        if (args.length !== 1 || !validate(request))
          return failure("invalid-request");
        const controller = options.controller();
        if (!controller) return failure("unavailable");
        registerOwner(event, authorized.value, controller);
        return run(controller, request);
      } catch {
        return failure("unavailable");
      }
    });
  };
  handle(channels.trustState, isTrustStateRequest, (controller, request) =>
    controller.trustState(request.owner),
  );
  handle(
    channels.answerHostTrust,
    isAnswerHostTrustRequest,
    (controller, request) => controller.answerHostTrust(request),
  );
  handle(
    channels.prepareKnownHostRevoke,
    isPrepareKnownHostRevokeRequest,
    (controller, request) => controller.prepareKnownHostRevoke(request),
  );
  handle(
    channels.revokeKnownHost,
    isRevokeKnownHostRequest,
    (controller, request) => controller.revokeKnownHost(request),
  );
  return () => {
    for (const channel of ownedChannels) options.ipc.removeHandler(channel);
  };
}
