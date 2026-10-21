import type { TeamStateRequest, TeamCommandRequest, TeamView, TeamReply } from "./team.ts";
export * from "./team.ts";
import type { SyncStateRequest, SyncCommandRequest, SyncView, SyncReply } from "./sync.ts";
export * from "./sync.ts";
import type { RemoteEditState, StartRemoteEditRequest, StartRemoteEditResponse, RemoteEditRequest, UploadRemoteEditRequest } from './remote-edit.ts';
export * from './remote-edit.ts';
import type { CredentialState, CredentialStateRequest, AnswerCredentialsRequest, CancelCredentialPromptRequest, CredentialActionResponse } from "./credentials.ts";
export * from "./credentials.ts";
import type { TrustState, TrustStateRequest, AnswerHostTrustRequest, PrepareKnownHostRevokeRequest, RevokeKnownHostRequest, KnownHostRevokePreview, TrustActionResponse } from "./known-hosts.ts";
export * from "./known-hosts.ts";
import type { TerminalState, TerminalStateRequest, StartLocalTerminalRequest, TerminalOutput, TerminalTarget, CloseTerminalRequest, WriteTerminalRequest, ResizeTerminalRequest, AckTerminalRequest, TerminalActionResponse } from "./terminals.ts";
export * from "./terminals.ts";
import type { SftpState, FilePathRequest, FileOutcome, DirectoryListing, FileAttributes } from "./files.ts";
export * from "./files.ts";
import type { TransferState, EnqueueTransfersRequest, CancelTransferRequest, ResolveTransferConflictRequest, RetryTransferRequest } from "./transfers.ts";
export * from "./transfers.ts";
import type { OpenLinkRequest, OpenLinkResponse } from "./links.ts";
import type { CatalogState, CatalogStateRequest, PrepareCatalogChangeRequest, CatalogPrepareResponse, ApplyCatalogChangeRequest, CatalogApplyResponse, ConnectHostRequest, ConnectHostResponse } from "./catalog.ts";
export * from "./catalog.ts";
import type {
  SetIdentityPasswordRequest, SetIdentityPasswordResponse, ChooseKeyFileRequest, ChooseKeyFileResponse, ImportKeyRequest,
  ImportKeyResponse, DiscardKeyImportRequest, DiscardKeyImportResponse, RenameKeyRequest, RenameKeyResponse,
  ForgetKeyPassphraseRequest, ForgetKeyPassphraseResponse, DeleteKeyRequest, DeleteKeyResponse, RetrySecretsRequest,
  RetrySecretsResponse,
} from "./identities.ts";
export * from "./identities.ts";
export * from "./links.ts";
import type { OpenSnippetRequest, OpenSnippetResponse, SaveSnippetRequest, SaveSnippetResponse, DeleteSnippetRequest, DeleteSnippetResponse } from "./snippets.ts";
export * from "./snippets.ts";
import type { TunnelState, TunnelStateRequest, TunnelRuleRequest, StartTunnelResponse, StopTunnelResponse } from "./tunnels.ts";
export * from "./tunnels.ts";
import type {
  AppLockStatus, AppLockStateRequest, SetupPasswordRequest, SetupPasswordResponse, UnlockPasswordRequest, AttemptResponse,
  ConfirmPasswordRequest, GoogleSignInRequest, GoogleSignInResponse, CancelGoogleRequest, UnlockOfflineRequest,
  UnlockOfflineResponse, RecoverRequest, RegenerateRecoveryRequest, RegenerateRecoveryResponse,
} from "./app-lock.ts";
export * from "./app-lock.ts";
import type { TerminalSettings, SettingsRequest, UpdateSettingsRequest } from "./settings.ts";
export * from "./settings.ts";
import type { WorkspaceTemplatesRequest, WorkspaceTemplatesResponse, WorkspaceTemplateView, SaveWorkspaceTemplateRequest, DeleteWorkspaceTemplateRequest, DeleteWorkspaceTemplateResponse } from './workspace-templates.ts';
export * from './workspace-templates.ts';
import type {
  RecordingState, RecordingStateRequest, ConfigureRecordingRequest, ConfigureRecordingResponse, DeleteRecordingsRequest,
  ExportRecordingRequest, ExportRecordingResponse, SuggestCommandsRequest, SuggestCommandsResponse, ForgetCommandRequest,
  ForgetCommandResponse,
} from './recording.ts';
export * from './recording.ts';
/** Serializable values crossing the isolated preload boundary. */
export type ErrorCode =
  | "invalid-request"
  | "unauthorized"
  | "stale-owner"
  | "conflict"
  | "busy"
  | "unavailable";
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string } };
export interface Owner {
  windowId: number;
  generation: number;
}
/** Fixed diagnostics only; catalog data and filesystem details stay in main. */
export type StorageProblem =
  | "corrupt"
  | "foreign-database"
  | "unsupported-schema"
  | "unsupported-protection"
  | "recovery-required"
  | "unwritable"
  | "migration-failed"
  | "busy"
  | "unavailable";
export type StorageHealth =
  | { status: "ready"; schemaVersion: number }
  | { status: "blocked"; code: StorageProblem };
export interface BootstrapData {
  app: { name: string; version: string; platform: string };
  owner: Owner;
  window: { focused: boolean; sequence: number };
  storage: StorageHealth;
}
export interface PingRequest {
  owner: Owner;
  requestId: string;
}
export interface WindowStateEvent {
  owner: Owner;
  sequence: number;
  type: "focus-changed";
  focused: boolean;
}
export interface DesktopAPI {
  teamState(request: TeamStateRequest): Promise<Result<TeamView>>;
  teamCommand(request: TeamCommandRequest): Promise<Result<TeamReply>>;
  syncState(request: SyncStateRequest): Promise<Result<SyncView>>;
  syncCommand(request: SyncCommandRequest): Promise<Result<SyncReply>>;
  bootstrap(): Promise<Result<BootstrapData>>;
  credentialState(request: CredentialStateRequest): Promise<Result<CredentialState>>;
  onCredentialState(callback: (state: CredentialState) => void): () => void;
  answerCredentials(request: AnswerCredentialsRequest): Promise<Result<CredentialActionResponse>>;
  cancelCredentialPrompt(request: CancelCredentialPromptRequest): Promise<Result<CredentialActionResponse>>;
  trustState(request: TrustStateRequest): Promise<Result<TrustState>>;
  onTrustState(callback: (state: TrustState) => void): () => void;
  answerHostTrust(request: AnswerHostTrustRequest): Promise<Result<TrustActionResponse>>;
  prepareKnownHostRevoke(request: PrepareKnownHostRevokeRequest): Promise<Result<KnownHostRevokePreview>>;
  revokeKnownHost(request: RevokeKnownHostRequest): Promise<Result<TrustActionResponse>>;
  terminalState(request: TerminalStateRequest): Promise<Result<TerminalState>>;
  startLocalTerminal(request: StartLocalTerminalRequest): Promise<Result<ConnectHostResponse>>;
  onTerminalState(callback: (state: TerminalState) => void): () => void;
  onTerminalOutput(callback: (output: TerminalOutput) => void): () => void;
  openTerminal(request: TerminalTarget): Promise<Result<TerminalActionResponse>>;
  writeTerminal(request: WriteTerminalRequest): Promise<Result<TerminalActionResponse>>;
  resizeTerminal(request: ResizeTerminalRequest): Promise<Result<TerminalActionResponse>>;
  ackTerminal(request: AckTerminalRequest): Promise<Result<TerminalActionResponse>>;
  closeTerminal(request: CloseTerminalRequest): Promise<Result<TerminalActionResponse>>;
  reconnectTerminal(request: TerminalTarget): Promise<Result<TerminalActionResponse>>;
  dismissTerminal(request: TerminalTarget): Promise<Result<TerminalActionResponse>>;
  sftpState(request: TerminalStateRequest): Promise<Result<SftpState>>;
  onSftpState(callback: (state: SftpState) => void): () => void;
  connectSftp(request: ConnectHostRequest): Promise<Result<ConnectHostResponse>>;
  closeSftp(request: TerminalTarget): Promise<Result<TerminalActionResponse>>;
  reconnectSftp(request: TerminalTarget): Promise<Result<TerminalActionResponse>>;
  dismissSftp(request: TerminalTarget): Promise<Result<TerminalActionResponse>>;
  listDirectory(request: FilePathRequest): Promise<Result<FileOutcome<DirectoryListing>>>;
  /** Follows symlinks. */
  statPath(request: FilePathRequest): Promise<Result<FileOutcome<FileAttributes>>>;
  /** Canonical path of an absolute, `~` or home-relative path. */
  resolvePath(request: FilePathRequest): Promise<Result<FileOutcome<string>>>;
  remoteEditState(request: TerminalStateRequest): Promise<Result<RemoteEditState>>;
  onRemoteEditState(callback: (state: RemoteEditState) => void): () => void;
  startRemoteEdit(request: StartRemoteEditRequest): Promise<Result<StartRemoteEditResponse>>;
  openRemoteEditor(request: RemoteEditRequest): Promise<Result<TerminalActionResponse>>;
  checkRemoteEdit(request: RemoteEditRequest): Promise<Result<TerminalActionResponse>>;
  uploadRemoteEdit(request: UploadRemoteEditRequest): Promise<Result<TerminalActionResponse>>;
  discardRemoteEdit(request: RemoteEditRequest): Promise<Result<TerminalActionResponse>>;
  transferState(request: TerminalStateRequest): Promise<Result<TransferState>>;
  onTransferState(callback: (state: TransferState) => void): () => void;
  enqueueTransfers(request: EnqueueTransfersRequest): Promise<Result<TerminalActionResponse>>;
  cancelTransfer(request: CancelTransferRequest): Promise<Result<TerminalActionResponse>>;
  resolveTransferConflict(request: ResolveTransferConflictRequest): Promise<Result<TerminalActionResponse>>;
  retryTransfer(request: RetryTransferRequest): Promise<Result<TerminalActionResponse>>;
  clearFinishedTransfers(request: TerminalStateRequest): Promise<Result<TerminalActionResponse>>;
  openLink(request: OpenLinkRequest): Promise<Result<OpenLinkResponse>>;
  catalogState(request: CatalogStateRequest): Promise<Result<CatalogState>>;
  onCatalogState(callback: (state: CatalogState) => void): () => void;
  prepareCatalogChange(request: PrepareCatalogChangeRequest): Promise<Result<CatalogPrepareResponse>>;
  applyCatalogChange(request: ApplyCatalogChangeRequest): Promise<Result<CatalogApplyResponse>>;
  connectHost(request: ConnectHostRequest): Promise<Result<ConnectHostResponse>>;
  setIdentityPassword(request: SetIdentityPasswordRequest): Promise<Result<SetIdentityPasswordResponse>>;
  chooseKeyFile(request: ChooseKeyFileRequest): Promise<Result<ChooseKeyFileResponse>>;
  importKey(request: ImportKeyRequest): Promise<Result<ImportKeyResponse>>;
  discardKeyImport(request: DiscardKeyImportRequest): Promise<Result<DiscardKeyImportResponse>>;
  renameKey(request: RenameKeyRequest): Promise<Result<RenameKeyResponse>>;
  forgetKeyPassphrase(request: ForgetKeyPassphraseRequest): Promise<Result<ForgetKeyPassphraseResponse>>;
  deleteKey(request: DeleteKeyRequest): Promise<Result<DeleteKeyResponse>>;
  retrySecrets(request: RetrySecretsRequest): Promise<Result<RetrySecretsResponse>>;
  workspaceTemplates(request: WorkspaceTemplatesRequest): Promise<Result<WorkspaceTemplatesResponse>>;
  saveWorkspaceTemplate(request: SaveWorkspaceTemplateRequest): Promise<Result<WorkspaceTemplateView>>;
  deleteWorkspaceTemplate(request: DeleteWorkspaceTemplateRequest): Promise<Result<DeleteWorkspaceTemplateResponse>>;
  openSnippet(request: OpenSnippetRequest): Promise<Result<OpenSnippetResponse>>;
  saveSnippet(request: SaveSnippetRequest): Promise<Result<SaveSnippetResponse>>;
  deleteSnippet(request: DeleteSnippetRequest): Promise<Result<DeleteSnippetResponse>>;
  appLockState(request: AppLockStateRequest): Promise<Result<AppLockStatus>>;
  setupAppLockPassword(request: SetupPasswordRequest): Promise<Result<SetupPasswordResponse>>;
  unlockAppLock(request: UnlockPasswordRequest): Promise<Result<AttemptResponse>>;
  confirmAppLockPassword(request: ConfirmPasswordRequest): Promise<Result<AttemptResponse>>;
  googleSignIn(request: GoogleSignInRequest): Promise<Result<GoogleSignInResponse>>;
  cancelGoogleSignIn(request: CancelGoogleRequest): Promise<Result<{ status: "cancelled" }>>;
  unlockAppLockOffline(request: UnlockOfflineRequest): Promise<Result<UnlockOfflineResponse>>;
  recoverAppLock(request: RecoverRequest): Promise<Result<AttemptResponse>>;
  regenerateRecoveryCode(request: RegenerateRecoveryRequest): Promise<Result<RegenerateRecoveryResponse>>;
  tunnelState(request: TunnelStateRequest): Promise<Result<TunnelState>>;
  onTunnelState(callback: (state: TunnelState) => void): () => void;
  startTunnel(request: TunnelRuleRequest): Promise<Result<StartTunnelResponse>>;
  stopTunnel(request: TunnelRuleRequest): Promise<Result<StopTunnelResponse>>;
  settings(request: SettingsRequest): Promise<Result<TerminalSettings>>;
  updateSettings(request: UpdateSettingsRequest): Promise<Result<TerminalSettings>>;
  recordingState(request: RecordingStateRequest): Promise<Result<RecordingState>>;
  configureRecording(request: ConfigureRecordingRequest): Promise<Result<ConfigureRecordingResponse>>;
  deleteRecordings(request: DeleteRecordingsRequest): Promise<Result<RecordingState>>;
  exportRecording(request: ExportRecordingRequest): Promise<Result<ExportRecordingResponse>>;
  suggestCommands(request: SuggestCommandsRequest): Promise<Result<SuggestCommandsResponse>>;
  forgetCommand(request: ForgetCommandRequest): Promise<Result<ForgetCommandResponse>>;
  ping(
    request: PingRequest,
  ): Promise<Result<{ requestId: string; ready: true }>>;
  onWindowState(callback: (event: WindowStateEvent) => void): () => void;
}

// These names are never exposed through contextBridge.
export const channels = Object.freeze({
  teamState: "ssterm:team-state",
  teamCommand: "ssterm:team-command",
  syncState: "ssterm:sync-state",
  syncCommand: "ssterm:sync-command",
  bootstrap: "ssterm:bootstrap",
  credentialState: "ssterm:credential-state",
  credentialStateChanged: "ssterm:credential-state-changed",
  answerCredentials: "ssterm:answer-credentials",
  cancelCredentialPrompt: "ssterm:cancel-credential-prompt",
  ping: "ssterm:ping",
  windowState: "ssterm:window-state",
  trustState: "ssterm:trust-state",
  trustStateChanged: "ssterm:trust-state-changed",
  answerHostTrust: "ssterm:answer-host-trust",
  prepareKnownHostRevoke: "ssterm:prepare-known-host-revoke",
  revokeKnownHost: "ssterm:revoke-known-host",
  terminalState: "ssterm:terminal-state",
  startLocalTerminal: "ssterm:start-local-terminal",
  terminalStateChanged: "ssterm:terminal-state-changed",
  terminalOutput: "ssterm:terminal-output",
  openTerminal: "ssterm:open-terminal",
  writeTerminal: "ssterm:write-terminal",
  resizeTerminal: "ssterm:resize-terminal",
  ackTerminal: "ssterm:ack-terminal",
  closeTerminal: "ssterm:close-terminal",
  reconnectTerminal: "ssterm:reconnect-terminal",
  dismissTerminal: "ssterm:dismiss-terminal",
  sftpState: "ssterm:sftp-state",
  sftpStateChanged: "ssterm:sftp-state-changed",
  connectSftp: "ssterm:connect-sftp",
  closeSftp: "ssterm:close-sftp",
  reconnectSftp: "ssterm:reconnect-sftp",
  dismissSftp: "ssterm:dismiss-sftp",
  listDirectory: "ssterm:list-directory",
  statPath: "ssterm:stat-path",
  resolvePath: "ssterm:resolve-path",
  remoteEditState: "ssterm:remote-edit-state",
  remoteEditStateChanged: "ssterm:remote-edit-state-changed",
  startRemoteEdit: "ssterm:start-remote-edit",
  openRemoteEditor: "ssterm:open-remote-editor",
  checkRemoteEdit: "ssterm:check-remote-edit",
  uploadRemoteEdit: "ssterm:upload-remote-edit",
  discardRemoteEdit: "ssterm:discard-remote-edit",
  transferState: "ssterm:transfer-state",
  transferStateChanged: "ssterm:transfer-state-changed",
  enqueueTransfers: "ssterm:enqueue-transfers",
  cancelTransfer: "ssterm:cancel-transfer",
  clearFinishedTransfers: "ssterm:clear-finished-transfers",
  resolveTransferConflict: "ssterm:resolve-transfer-conflict",
  retryTransfer: "ssterm:retry-transfer",
  openLink: "ssterm:open-link",
  catalogState: "ssterm:catalog-state",
  catalogStateChanged: "ssterm:catalog-state-changed",
  prepareCatalogChange: "ssterm:prepare-catalog-change",
  applyCatalogChange: "ssterm:apply-catalog-change",
  connectHost: "ssterm:connect-host",
  setIdentityPassword: "ssterm:set-identity-password",
  chooseKeyFile: "ssterm:choose-key-file",
  importKey: "ssterm:import-key",
  discardKeyImport: "ssterm:discard-key-import",
  renameKey: "ssterm:rename-key",
  forgetKeyPassphrase: "ssterm:forget-key-passphrase",
  deleteKey: "ssterm:delete-key",
  retrySecrets: "ssterm:retry-secrets",
  workspaceTemplates: "ssterm:workspace-templates",
  saveWorkspaceTemplate: "ssterm:save-workspace-template",
  deleteWorkspaceTemplate: "ssterm:delete-workspace-template",
  openSnippet: "ssterm:open-snippet",
  saveSnippet: "ssterm:save-snippet",
  deleteSnippet: "ssterm:delete-snippet",
  appLockState: "ssterm:app-lock-state",
  setupAppLockPassword: "ssterm:app-lock-setup-password",
  unlockAppLock: "ssterm:app-lock-unlock",
  confirmAppLockPassword: "ssterm:app-lock-confirm",
  googleSignIn: "ssterm:app-lock-google",
  cancelGoogleSignIn: "ssterm:app-lock-google-cancel",
  unlockAppLockOffline: "ssterm:app-lock-offline",
  recoverAppLock: "ssterm:app-lock-recover",
  regenerateRecoveryCode: "ssterm:app-lock-regenerate",
  tunnelState: "ssterm:tunnel-state",
  tunnelStateChanged: "ssterm:tunnel-state-changed",
  startTunnel: "ssterm:start-tunnel",
  stopTunnel: "ssterm:stop-tunnel",
  settings: "ssterm:settings",
  updateSettings: "ssterm:update-settings",
  recordingState: "ssterm:recording-state",
  configureRecording: "ssterm:configure-recording",
  deleteRecordings: "ssterm:delete-recordings",
  exportRecording: "ssterm:export-recording",
  suggestCommands: "ssterm:suggest-commands",
  forgetCommand: "ssterm:forget-command",
});

const messages: Record<ErrorCode, string> = {
  "invalid-request": "The request is invalid.",
  unauthorized: "The request is not authorized.",
  "stale-owner": "The window has changed. Reload its state.",
  conflict: "The state changed. Refresh and try again.",
  busy: "The session is not accepting input. Try again.",
  unavailable: "The application is unavailable.",
};
export function failure<T = never>(code: ErrorCode): Result<T> {
  return { ok: false, error: { code, message: messages[code] } };
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function isStorageHealth(value: unknown): value is StorageHealth {
  if (exactObject(value, ["status", "schemaVersion"]) && value.status === "ready")
    return isCounter(value.schemaVersion) && value.schemaVersion > 0;
  return (
    exactObject(value, ["status", "code"]) &&
    value.status === "blocked" &&
    typeof value.code === "string" &&
    [
      "corrupt",
      "foreign-database",
      "unsupported-schema",
      "unsupported-protection",
      "recovery-required",
      "unwritable",
      "migration-failed",
      "busy",
      "unavailable",
    ].includes(value.code)
  );
}
export function isOwner(value: unknown): value is Owner {
  return (
    exactObject(value, ["windowId", "generation"]) &&
    isCounter(value.windowId) &&
    value.windowId > 0 &&
    isCounter(value.generation) &&
    value.generation > 0
  );
}
export function isPingRequest(value: unknown): value is PingRequest {
  return (
    exactObject(value, ["owner", "requestId"]) &&
    isOwner(value.owner) &&
    typeof value.requestId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value.requestId)
  );
}
export function isWindowStateEvent(value: unknown): value is WindowStateEvent {
  return (
    exactObject(value, ["owner", "sequence", "type", "focused"]) &&
    isOwner(value.owner) &&
    isCounter(value.sequence) &&
    value.type === "focus-changed" &&
    typeof value.focused === "boolean"
  );
}
export function isBootstrapData(value: unknown): value is BootstrapData {
  if (
    !exactObject(value, ["app", "owner", "window", "storage"]) ||
    !isOwner(value.owner) ||
    !isStorageHealth(value.storage)
  )
    return false;
  return (
    exactObject(value.app, ["name", "version", "platform"]) &&
    ["name", "version", "platform"].every((key) => {
      const field = value.app as Record<string, unknown>;
      return (
        typeof field[key] === "string" &&
        field[key].length > 0 &&
        field[key].length <= 128
      );
    }) &&
    exactObject(value.window, ["focused", "sequence"]) &&
    typeof value.window.focused === "boolean" &&
    isCounter(value.window.sequence)
  );
}
export function isPingResponse(
  value: unknown,
): value is { requestId: string; ready: true } {
  return (
    exactObject(value, ["requestId", "ready"]) &&
    typeof value.requestId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value.requestId) &&
    value.ready === true
  );
}
export function isResult<T>(
  value: unknown,
  validate: (value: unknown) => value is T,
): value is Result<T> {
  if (exactObject(value, ["ok", "value"]) && value.ok === true)
    return validate(value.value);
  return (
    exactObject(value, ["ok", "error"]) &&
    value.ok === false &&
    exactObject(value.error, ["code", "message"]) &&
    typeof value.error.code === "string" &&
    Object.hasOwn(messages, value.error.code) &&
    value.error.message === messages[value.error.code as ErrorCode]
  );
}
