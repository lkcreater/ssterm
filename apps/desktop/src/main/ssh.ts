/** Main-only saved-host composition. No transport or secret capability crosses preload. */
import type { MetadataRepository, SecretProvider } from "@ssterm/domain";
import { resolveHostConfig } from "@ssterm/domain";
import { KnownHostPolicy, createSavedHostSshAdapter, type TransientSecrets, type SessionLimits } from "@ssterm/services";
import { createDesktopSessions, type SessionPowerEvents } from "./session-runtime";

export function createSavedHostSessions(options: {
  repository: MetadataRepository;
  provider?: SecretProvider;
  transient: TransientSecrets;
  power: SessionPowerEvents;
  limits?: Partial<SessionLimits>;
}) {
  const policy = new KnownHostPolicy({ repository: options.repository });
  const sessions = createDesktopSessions({
    transient: options.transient,
    power: options.power,
    limits: options.limits,
    resolve: (hostId) => {
      const snapshot = options.repository.snapshot();
      return snapshot.ok ? resolveHostConfig(snapshot.value, hostId) : snapshot;
    },
    adapter: options.provider
      ? createSavedHostSshAdapter({ provider: options.provider, policy })
      : undefined,
  });
  return {
    ...sessions,
    policy,
    shutdown() {
      policy.dispose();
      return sessions.shutdown();
    },
  };
}

export { openMetadata } from "@ssterm/adapters";
export { CatalogModule, SecretService, TransientSecrets } from "@ssterm/services";
export { createCredentialsController } from "./credentials";
export { registerCredentialHandlers } from "./credential-runtime";
export { createTerminalController, registerTerminalHandlers } from "./terminals";
export { WindowBoundary } from "./boundary";
export { sessionOwnerId } from "./session-runtime";
export { channels } from "@ssterm/contracts";
