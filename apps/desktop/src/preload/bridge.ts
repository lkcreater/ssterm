import {
  channels,
  failure,
  isBootstrapData,
  isPingRequest,
  isPingResponse,
  isResult,
  isWindowStateEvent,
  type BootstrapData,
  type DesktopAPI,
  type Owner,
  type PingRequest,
  type Result,
  type WindowStateEvent,
} from "@ssterm/contracts";

export interface BridgeTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(
    channel: string,
    listener: (event: unknown, value: unknown) => void,
  ): unknown;
  removeListener(
    channel: string,
    listener: (event: unknown, value: unknown) => void,
  ): unknown;
}

export function createDesktopBridge(transport: BridgeTransport): {
  api: DesktopAPI;
  dispose: () => void;
} {
  let disposed = false;
  let owner: Owner | undefined;
  let sequence = -1;
  const subscriptions = new Set<() => void>();
  const callbacks = new Set<(event: WindowStateEvent) => void>();
  const listener = (_event: unknown, value: unknown): void => {
    if (
      disposed ||
      !owner ||
      !isWindowStateEvent(value) ||
      value.owner.windowId !== owner.windowId ||
      value.owner.generation !== owner.generation ||
      value.sequence <= sequence
    )
      return;
    sequence = value.sequence;
    for (const callback of callbacks) callback(value);
  };

  async function invoke<T>(
    channel: string,
    args: unknown[],
    validate: (value: unknown) => value is T,
  ): Promise<Result<T>> {
    if (disposed) return failure("unavailable");
    try {
      const result = await transport.invoke(channel, ...args);
      if (disposed || !isResult(result, validate))
        return failure("unavailable");
      return result;
    } catch {
      return failure("unavailable");
    }
  }

  const api: DesktopAPI = Object.freeze({
    async bootstrap(): Promise<Result<BootstrapData>> {
      const result = await invoke(channels.bootstrap, [], isBootstrapData);
      if (result.ok) {
        const next = result.value;
        if (!owner || next.owner.generation > owner.generation) {
          owner = { ...next.owner };
          sequence = next.window.sequence;
        } else if (
          next.owner.windowId === owner.windowId &&
          next.owner.generation === owner.generation
        ) {
          sequence = Math.max(sequence, next.window.sequence);
        }
      }
      return result;
    },
    ping(request: PingRequest) {
      if (!isPingRequest(request))
        return Promise.resolve(failure("invalid-request"));
      // Rebuild the minimal value rather than forwarding caller-controlled objects.
      return invoke(
        channels.ping,
        [{ owner: { ...request.owner }, requestId: request.requestId }],
        isPingResponse,
      );
    },
    onWindowState(callback: (event: WindowStateEvent) => void): () => void {
      if (disposed || typeof callback !== "function") return () => {};
      let active = true;
      // A unique wrapper permits subscribing the same callback twice.
      const subscribed = (value: WindowStateEvent): void => {
        if (active) callback(value);
      };
      const unsubscribe = (): void => {
        if (!active) return;
        active = false;
        callbacks.delete(subscribed);
        if (callbacks.size === 0)
          transport.removeListener(channels.windowState, listener);
        subscriptions.delete(unsubscribe);
      };
      if (callbacks.size === 0) transport.on(channels.windowState, listener);
      callbacks.add(subscribed);
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
  });
  return {
    api,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of subscriptions) unsubscribe();
      owner = undefined;
    },
  };
}
