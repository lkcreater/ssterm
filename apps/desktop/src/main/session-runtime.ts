import type { Owner } from "@ssterm/contracts";
import { SessionRegistry, type TransientSecrets } from "@ssterm/services";

type RegistryOptions = ConstructorParameters<typeof SessionRegistry>[0];
type PowerEvent = "lock-screen" | "suspend";
export interface SessionPowerEvents {
  on(event: PowerEvent, listener: () => void): unknown;
  removeListener(event: PowerEvent, listener: () => void): unknown;
}

/** Window ownership and connection-attempt generations are separate namespaces. */
export function sessionOwnerId(owner: Owner): string {
  return `window:${owner.windowId}:${owner.generation}`;
}

/** The same composition is used by main and by owned runtime fixtures. */
export function createDesktopSessions(options: {
  resolve: RegistryOptions["resolve"];
  adapter?: RegistryOptions["adapter"];
  transient: TransientSecrets;
  power: SessionPowerEvents;
  limits?: RegistryOptions["limits"];
}) {
  const registry = new SessionRegistry({
    resolve: options.resolve,
    transient: options.transient,
    limits: options.limits,
    // Storage/provider failures and callers without an adapter remain fail closed.
    adapter: options.adapter ?? {
      start: (context) => context.failed("subsystem-unavailable"),
    },
  });
  const lock = (): void => {
    // Registry fences every attempt and purges transient values synchronously.
    void Promise.resolve(registry.lock()).catch(() => undefined);
  };
  options.power.on("lock-screen", lock);
  options.power.on("suspend", lock);
  let shutdown: Promise<void> | undefined;

  return {
    registry,
    revokeOwner(owner: Owner): void {
      const ownerId = sessionOwnerId(owner);
      void registry.closeOwner(ownerId).then(
        () => {
          // A destroyed document can never reconnect or explicitly forget its records.
          for (const record of registry.snapshot(ownerId)) {
            registry.forget(ownerId, record.id);
          }
        },
        () => undefined,
      );
    },
    shutdown(): Promise<void> {
      if (shutdown) return shutdown;
      options.power.removeListener("lock-screen", lock);
      options.power.removeListener("suspend", lock);
      shutdown = Promise.resolve(registry.dispose()).then(
        () => undefined,
        () => undefined,
      );
      return shutdown;
    },
  };
}
