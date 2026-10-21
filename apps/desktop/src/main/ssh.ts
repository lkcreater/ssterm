/** Main-only saved-host composition. No transport or secret capability crosses preload. */
import type { MetadataRepository, SecretProvider } from "@ssterm/domain";
import { resolveHostConfig, isTeamVirtualHostId } from "@ssterm/domain";
import { KnownHostPolicy, createSavedHostSshAdapter, TeamSessionGuard, type ManagedTeamSessionClient, type TransientSecrets, type SessionLimits } from "@ssterm/services";
import { MAX_TERMINAL_WRITE } from "@ssterm/contracts";
import { sshKeepalive, terminalBounds, type SshKeepalive, type TerminalBounds } from "@ssterm/adapters/ssh";
import { createLocalPtyAdapter } from "@ssterm/adapters/local-pty";
import { createDesktopSessions, type SessionPowerEvents } from "./session-runtime";

const unavailable = { status: "unavailable" } as const;
const unavailableSecrets: SecretProvider = {
  read: async () => unavailable,
  lookup: async () => unavailable,
  write: async () => unavailable,
  delete: async () => unavailable,
};

export function createSavedHostSessions(options: {
  repository: MetadataRepository;
  provider?: SecretProvider;
  transient: TransientSecrets;
  power: SessionPowerEvents;
  limits?: Partial<SessionLimits>;
  /** Main-only stream bounds. An idle session must always accept one maximum write, so a paste is never split. */
  terminal?: TerminalBounds;
  /** Main-only dead-peer detection (default 15 s × 3). */
  keepalive?: SshKeepalive;
  /** Opt-in, main-only team client. Permanent managed UUIDs are checked before the personal catalog. */
  team?: ManagedTeamSessionClient;
  /** SST-034 capture tap (the recorder's `observe`). */
  observeTerminal?: Parameters<typeof createDesktopSessions>[0]["observeTerminal"];
}) {
  const terminal = terminalBounds(options.terminal);
  if (terminal.inputBacklog < MAX_TERMINAL_WRITE) throw new RangeError("invalid-terminal-bounds");
  const keepalive = sshKeepalive(options.keepalive);
  const policy = new KnownHostPolicy({ repository: options.repository });
  let teamGuard: TeamSessionGuard | undefined;
  const sessions = createDesktopSessions({
    transient: options.transient,
    power: options.power,
    limits: options.limits,
    observeTerminal: options.observeTerminal,
    localAdapter: createLocalPtyAdapter(),
    resolve: (hostId, context) => {
      // A known managed binding/tombstone never falls through, including denial and provider failures.
      if (teamGuard?.hasBinding(hostId)) return teamGuard.resolve(hostId, context);
      if (isTeamVirtualHostId(hostId)) return {
        ok: false as const, error: { code: "invalid-request" as const, message: "The managed host is unavailable." },
      };
      const snapshot = options.repository.snapshot();
      return snapshot.ok ? resolveHostConfig(snapshot.value, hostId) : snapshot;
    },
    // Without a secure store, saved refs still fail closed as credentials-unavailable, while
    // prompt-only identities (no saved ref) and keyboard-interactive keep working.
    adapter: createSavedHostSshAdapter({
      provider: options.provider ?? unavailableSecrets, policy, terminal, keepalive,
      ...(options.team ? { loadManagedPassword: (input) => options.team!.loadManagedPassword(input) } : {}),
    }),
  });
  if (options.team) {
    teamGuard = new TeamSessionGuard({
      client: options.team,
      close(context) {
        const current = sessions.registry.snapshot(context.ownerId).find((record) => record.id === context.sessionId);
        if (current?.generation === context.generation) void sessions.registry.close(context.ownerId, context.sessionId);
      },
    });
    sessions.onLock(() => teamGuard?.lock());
  }
  return {
    ...sessions,
    policy,
    teamGuard,
    shutdown() {
      teamGuard?.dispose();
      policy.dispose();
      return sessions.shutdown();
    },
  };
}

export { openMetadata } from "@ssterm/adapters";
export { CatalogModule, SecretService, TransientSecrets, TunnelService } from "@ssterm/services";
export { listenLocal } from "@ssterm/adapters/local-listener";
export { createCredentialsController } from "./credentials";
export { registerCredentialHandlers } from "./credential-runtime";
export { createTerminalController, registerTerminalHandlers, terminalChannels } from "./terminals";
export { createSftpController, registerSftpHandlers, sftpChannels } from "./sftp";
export { createLocalFiles } from "@ssterm/adapters/local-files";
export { createCatalogController, registerCatalogHandlers, catalogChannels, observeCommits } from "./catalog-controller";
export { createIdentitiesController, registerIdentityHandlers, identityChannels, secretNamespace } from "./identities";
export { registerLinkHandlers, validateExternalUrl } from "./links";
export { WindowBoundary } from "./boundary";
export { sessionOwnerId } from "./session-runtime";
export { createDesktopSessions } from "./session-runtime";
export { createLocalPtyAdapter } from "@ssterm/adapters/local-pty";
export { channels } from "@ssterm/contracts";

export { createTransferController, registerTransferHandlers, transferChannels } from "./transfers";
export { createLocalTransferFiles } from "@ssterm/adapters/local-transfers";

export { createRemoteEditController, registerRemoteEditHandlers, remoteEditChannels } from "./remote-edit";
export { createRemoteEditService } from "@ssterm/services";
export { createRemoteEditFiles } from "@ssterm/adapters/remote-edit-files";
export { createRemoteEditEditor } from "@ssterm/adapters/remote-edit-editor";

export { createRecorder } from "@ssterm/services";
export { createRecordingFiles } from "@ssterm/adapters/recording-files";
export { registerRecordingHandlers, recordingChannels } from "./recordings";
