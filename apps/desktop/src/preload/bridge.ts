import {
  channels,
  isRemoteEditState, isStartRemoteEditRequest, isStartRemoteEditResponse, isRemoteEditRequest, isUploadRemoteEditRequest,
  type RemoteEditState, type StartRemoteEditRequest, type RemoteEditRequest, type UploadRemoteEditRequest,
  isTransferState, isEnqueueTransfersRequest, isCancelTransferRequest, isResolveTransferConflictRequest, isRetryTransferRequest,
  type TransferState, type EnqueueTransfersRequest, type CancelTransferRequest, type ResolveTransferConflictRequest, type RetryTransferRequest,
  isCredentialState, isCredentialStateRequest, isAnswerCredentialsRequest,
  isCancelCredentialPromptRequest, isCredentialActionResponse,
  type CredentialState, type CredentialStateRequest, type AnswerCredentialsRequest,
  type CancelCredentialPromptRequest,
  isTerminalState, isTerminalStateRequest, isStartLocalTerminalRequest, isTerminalOutput, isTerminalTarget, isCloseTerminalRequest, isWriteTerminalRequest,
  isResizeTerminalRequest, isAckTerminalRequest, isTerminalActionResponse,
  type TerminalState, type TerminalStateRequest, type StartLocalTerminalRequest, type TerminalOutput, type TerminalTarget, type CloseTerminalRequest,
  type WriteTerminalRequest, type ResizeTerminalRequest, type AckTerminalRequest,
  isOpenLinkRequest, isOpenLinkResponse, type OpenLinkRequest,
  isSftpState, isFilePathRequest, isResolvePathRequest, isListingOutcome, isAttributesOutcome, isResolvedPathOutcome,
  type SftpState, type FilePathRequest, type FileSource,
  isSettingsRequest, isUpdateSettingsRequest, isTerminalSettings, type SettingsRequest, type UpdateSettingsRequest,
  isRecordingStateRequest, isRecordingState, isConfigureRecordingRequest, isConfigureRecordingResponse, isDeleteRecordingsRequest,
  isExportRecordingRequest, isExportRecordingResponse, isSuggestCommandsRequest, isSuggestCommandsResponse, isForgetCommandRequest,
  isForgetCommandResponse,
  type RecordingStateRequest, type ConfigureRecordingRequest, type DeleteRecordingsRequest, type ExportRecordingRequest,
  type SuggestCommandsRequest, type ForgetCommandRequest,
  isCatalogState, isCatalogStateRequest, isPrepareCatalogChangeRequest, isCatalogPrepareResponse,
  isApplyCatalogChangeRequest, isCatalogApplyResponse, isConnectHostRequest, isConnectHostResponse,
  type CatalogState, type CatalogStateRequest, type PrepareCatalogChangeRequest, type ApplyCatalogChangeRequest,
  type ConnectHostRequest,
  isSetIdentityPasswordRequest, isSetIdentityPasswordResponse, isChooseKeyFileRequest, isChooseKeyFileResponse,
  isImportKeyRequest, isImportKeyResponse, isDiscardKeyImportRequest, isDiscardKeyImportResponse, isRenameKeyRequest,
  isRenameKeyResponse, isKeyTargetRequest, isForgetKeyPassphraseResponse, isDeleteKeyResponse, isRetrySecretsRequest,
  isRetrySecretsResponse,
  type SetIdentityPasswordRequest, type ChooseKeyFileRequest, type ImportKeyRequest, type DiscardKeyImportRequest,
  type RenameKeyRequest, type ForgetKeyPassphraseRequest, type DeleteKeyRequest, type RetrySecretsRequest,
  isWorkspaceTemplatesRequest, isWorkspaceTemplatesResponse, isSaveWorkspaceTemplateRequest, isWorkspaceTemplateView,
  isDeleteWorkspaceTemplateRequest, isDeleteWorkspaceTemplateResponse, copyWorkspaceTemplateConfiguration,
  type WorkspaceTemplatesRequest, type SaveWorkspaceTemplateRequest, type DeleteWorkspaceTemplateRequest,
  isOpenSnippetRequest, isOpenSnippetResponse, isSaveSnippetRequest, isSaveSnippetResponse, isDeleteSnippetRequest,
  isDeleteSnippetResponse,
  type OpenSnippetRequest, type SaveSnippetRequest, type DeleteSnippetRequest,
  isTunnelState, isTunnelStateRequest, isTunnelRuleRequest, isStartTunnelResponse, isStopTunnelResponse,
  appLockRequestGuards, isAppLockStatus, isSetupPasswordResponse, isAttemptResponse, isGoogleSignInResponse, isUnlockOfflineResponse,
  isRegenerateRecoveryResponse, isCancelGoogleResponse,
  type AppLockStateRequest, type SetupPasswordRequest, type UnlockPasswordRequest, type ConfirmPasswordRequest,
  type GoogleSignInRequest, type CancelGoogleRequest, type UnlockOfflineRequest, type RecoverRequest, type RegenerateRecoveryRequest,
  type TunnelState, type TunnelStateRequest, type TunnelRuleRequest,
  isTrustState,
  isTrustStateRequest,
  isAnswerHostTrustRequest,
  isPrepareKnownHostRevokeRequest,
  isRevokeKnownHostRequest,
  isKnownHostRevokePreview,
  isTrustActionResponse,
  type TrustState,
  type TrustStateRequest,
  type AnswerHostTrustRequest,
  type PrepareKnownHostRevokeRequest,
  type RevokeKnownHostRequest,
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

/**
 * contextBridge hands preload its own copy of every argument and `invoke` serializes synchronously, so the
 * credential bytes a request carries are this world's to erase once the call settles.
 */
const wipe = (values: readonly (Uint8Array | null)[]) => { for (const bytes of values) bytes?.fill(0); };

export function createDesktopBridge(transport: BridgeTransport): {
  api: DesktopAPI;
  dispose: () => void;
} {
  let disposed = false;
  let owner: Owner | undefined;
  let sequence = -1;
  let trustSequence = -1;
  let credentialSequence = -1;
  let terminalSequence = -1;
  let catalogSequence = -1;
  let sftpSequence = -1;
  let remoteEditSequence = -1;
  const remoteEditCallbacks = new Set<(state: RemoteEditState) => void>();
  const remoteEditListener = (_event: unknown, value: unknown): void => {
    if (disposed || !isRemoteEditState(value) || !sameOwner(value.owner) || value.sequence <= remoteEditSequence) return;
    remoteEditSequence = value.sequence;
    for (const callback of remoteEditCallbacks) callback(value);
  };
  let transferSequence = -1;
  let tunnelSequence = -1;
  const tunnelCallbacks = new Set<(state: TunnelState) => void>();
  const tunnelListener = (_event: unknown, value: unknown): void => {
    if (disposed || !isTunnelState(value) || !sameOwner(value.owner) || value.sequence <= tunnelSequence) return;
    tunnelSequence = value.sequence;
    for (const callback of tunnelCallbacks) callback(value);
  };
  const transferCallbacks = new Set<(state: TransferState) => void>();
  const transferListener = (_event: unknown, value: unknown): void => {
    if (disposed || !isTransferState(value) || !sameOwner(value.owner) || value.sequence <= transferSequence) return;
    transferSequence = value.sequence;
    for (const callback of transferCallbacks) callback(value);
  };
  const sameOwner = (value: Owner) => !!owner && value.windowId === owner.windowId && value.generation === owner.generation;
  const terminalCallbacks = new Set<(state: TerminalState) => void>();
  const terminalListener = (_event: unknown, value: unknown): void => {
    if (disposed || !isTerminalState(value) || !sameOwner(value.owner) || value.sequence <= terminalSequence) return;
    terminalSequence = value.sequence;
    for (const callback of terminalCallbacks) callback(value);
  };
  const sftpCallbacks = new Set<(state: SftpState) => void>();
  const sftpListener = (_event: unknown, value: unknown): void => {
    if (disposed || !isSftpState(value) || !sameOwner(value.owner) || value.sequence <= sftpSequence) return;
    sftpSequence = value.sequence;
    for (const callback of sftpCallbacks) callback(value);
  };
  const catalogCallbacks = new Set<(state: CatalogState) => void>();
  const catalogListener = (_event: unknown, value: unknown): void => {
    if (disposed || !isCatalogState(value) || !sameOwner(value.owner) || value.sequence <= catalogSequence) return;
    catalogSequence = value.sequence;
    for (const callback of catalogCallbacks) callback(value);
  };
  const outputCallbacks = new Set<(output: TerminalOutput) => void>();
  // No sequence filter: a gap must reach the view, which reports it instead of hiding it.
  const outputListener = (_event: unknown, value: unknown): void => {
    if (disposed || !isTerminalOutput(value) || !sameOwner(value.owner)) return;
    const output: TerminalOutput = { owner: { ...value.owner }, sessionId: value.sessionId, generation: value.generation,
      sequence: value.sequence, bytes: value.bytes };
    for (const callback of outputCallbacks) callback(output);
  };
  /** One transport listener per channel, shared by every subscriber. */
  function subscribe<T>(channel: string, set: Set<(value: T) => void>, listener: (event: unknown, value: unknown) => void, callback: (value: T) => void): () => void {
    if (disposed || typeof callback !== "function") return () => {};
    let active = true;
    const subscribed = (value: T) => { if (active) callback(value); };
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      set.delete(subscribed);
      if (set.size === 0) transport.removeListener(channel, listener);
      subscriptions.delete(unsubscribe);
    };
    if (set.size === 0) transport.on(channel, listener);
    set.add(subscribed);
    subscriptions.add(unsubscribe);
    return unsubscribe;
  }
  const target = (request: TerminalTarget): TerminalTarget => ({ owner: { ...request.owner }, sessionId: request.sessionId, generation: request.generation });
  const source = (value: FileSource): FileSource =>
    value.kind === "local" ? { kind: "local" } : { kind: "remote", sessionId: value.sessionId, generation: value.generation };
  const fileRequest = (request: FilePathRequest): FilePathRequest => ({ owner: { ...request.owner }, source: source(request.source), path: request.path });
  const credentialCallbacks = new Set<(state: CredentialState) => void>();
  const credentialListener = (_event: unknown, value: unknown): void => {
    if (disposed || !owner || !isCredentialState(value) ||
      value.owner.windowId !== owner.windowId || value.owner.generation !== owner.generation || value.sequence <= credentialSequence) return;
    credentialSequence = value.sequence;
    for (const callback of credentialCallbacks) callback(value);
  };
  const trustCallbacks = new Set<(state: TrustState) => void>();
  const trustListener = (_event: unknown, value: unknown): void => {
    if (
      disposed ||
      !owner ||
      !isTrustState(value) ||
      value.owner.windowId !== owner.windowId ||
      value.owner.generation !== owner.generation ||
      value.sequence <= trustSequence
    )
      return;
    trustSequence = value.sequence;
    for (const callback of trustCallbacks) callback(value);
  };
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
          trustSequence = -1;
          credentialSequence = -1;
          terminalSequence = -1;
          catalogSequence = -1;
          sftpSequence = -1;
          remoteEditSequence = -1;
          transferSequence = -1;
          tunnelSequence = -1;
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
    async credentialState(request: CredentialStateRequest) {
      if (!isCredentialStateRequest(request)) return failure("invalid-request");
      const result = await invoke(channels.credentialState, [{ owner: { ...request.owner } }], isCredentialState);
      if (!result.ok) return result;
      if (!owner || result.value.owner.windowId !== owner.windowId || result.value.owner.generation !== owner.generation ||
        request.owner.windowId !== owner.windowId || request.owner.generation !== owner.generation) return failure("stale-owner");
      credentialSequence = Math.max(credentialSequence, result.value.sequence);
      return result;
    },
    onCredentialState(callback: (state: CredentialState) => void): () => void {
      if (disposed || typeof callback !== "function") return () => {};
      let active = true;
      const subscribed = (state: CredentialState) => { if (active) callback(state); };
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        credentialCallbacks.delete(subscribed);
        if (credentialCallbacks.size === 0) transport.removeListener(channels.credentialStateChanged, credentialListener);
        subscriptions.delete(unsubscribe);
      };
      if (credentialCallbacks.size === 0) transport.on(channels.credentialStateChanged, credentialListener);
      credentialCallbacks.add(subscribed);
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
    async answerCredentials(request: AnswerCredentialsRequest) {
      if (!isAnswerCredentialsRequest(request)) return failure("invalid-request");
      try {
        return await invoke(channels.answerCredentials, [{ owner: { ...request.owner }, sessionId: request.sessionId,
          generation: request.generation, promptId: request.promptId,
          values: request.values.map((field) => ({ id: field.id, value: field.value })) }], isCredentialActionResponse);
      } finally { wipe(request.values.map((field) => field.value)); }
    },
    cancelCredentialPrompt(request: CancelCredentialPromptRequest) {
      if (!isCancelCredentialPromptRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.cancelCredentialPrompt, [{ owner: { ...request.owner }, sessionId: request.sessionId,
        generation: request.generation, promptId: request.promptId }], isCredentialActionResponse);
    },
    async trustState(request: TrustStateRequest) {
      if (!isTrustStateRequest(request)) return failure("invalid-request");
      const result = await invoke(
        channels.trustState,
        [{ owner: { ...request.owner } }],
        isTrustState,
      );
      if (!result.ok) return result;
      if (
        !owner ||
        result.value.owner.windowId !== owner.windowId ||
        result.value.owner.generation !== owner.generation ||
        request.owner.windowId !== owner.windowId ||
        request.owner.generation !== owner.generation
      )
        return failure("stale-owner");
      trustSequence = Math.max(trustSequence, result.value.sequence);
      return result;
    },
    onTrustState(callback: (state: TrustState) => void): () => void {
      if (disposed || typeof callback !== "function") return () => {};
      let active = true;
      const subscribed = (state: TrustState) => {
        if (active) callback(state);
      };
      const unsubscribe = () => {
        if (!active) return;
        active = false;
        trustCallbacks.delete(subscribed);
        if (trustCallbacks.size === 0)
          transport.removeListener(channels.trustStateChanged, trustListener);
        subscriptions.delete(unsubscribe);
      };
      if (trustCallbacks.size === 0)
        transport.on(channels.trustStateChanged, trustListener);
      trustCallbacks.add(subscribed);
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
    answerHostTrust(request: AnswerHostTrustRequest) {
      if (!isAnswerHostTrustRequest(request))
        return Promise.resolve(failure("invalid-request"));
      return invoke(
        channels.answerHostTrust,
        [
          {
            owner: { ...request.owner },
            sessionId: request.sessionId,
            generation: request.generation,
            promptId: request.promptId,
            decision: request.decision,
          },
        ],
        isTrustActionResponse,
      );
    },
    prepareKnownHostRevoke(request: PrepareKnownHostRevokeRequest) {
      if (!isPrepareKnownHostRevokeRequest(request))
        return Promise.resolve(failure("invalid-request"));
      return invoke(
        channels.prepareKnownHostRevoke,
        [
          {
            owner: { ...request.owner },
            id: request.id,
            expectedRevision: request.expectedRevision,
          },
        ],
        isKnownHostRevokePreview,
      );
    },
    revokeKnownHost(request: RevokeKnownHostRequest) {
      if (!isRevokeKnownHostRequest(request))
        return Promise.resolve(failure("invalid-request"));
      return invoke(
        channels.revokeKnownHost,
        [{ owner: { ...request.owner }, token: request.token }],
        isTrustActionResponse,
      );
    },
    async terminalState(request: TerminalStateRequest) {
      if (!isTerminalStateRequest(request)) return failure("invalid-request");
      const result = await invoke(channels.terminalState, [{ owner: { ...request.owner } }], isTerminalState);
      if (!result.ok) return result;
      if (!sameOwner(result.value.owner) || !sameOwner(request.owner)) return failure("stale-owner");
      terminalSequence = Math.max(terminalSequence, result.value.sequence);
      return result;
    },
    onTerminalState(callback: (state: TerminalState) => void): () => void {
      return subscribe(channels.terminalStateChanged, terminalCallbacks, terminalListener, callback);
    },
    onTerminalOutput(callback: (output: TerminalOutput) => void): () => void {
      return subscribe(channels.terminalOutput, outputCallbacks, outputListener, callback);
    },
    openTerminal(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.openTerminal, [target(request)], isTerminalActionResponse);
    },
    async writeTerminal(request: WriteTerminalRequest) {
      if (!isWriteTerminalRequest(request)) return failure("invalid-request");
      const bytes = new Uint8Array(request.bytes);
      try {
        return await invoke(channels.writeTerminal, [{ ...target(request), bytes }], isTerminalActionResponse);
      } finally { bytes.fill(0); }
    },
    resizeTerminal(request: ResizeTerminalRequest) {
      if (!isResizeTerminalRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.resizeTerminal, [{ ...target(request), columns: request.columns, rows: request.rows }], isTerminalActionResponse);
    },
    ackTerminal(request: AckTerminalRequest) {
      if (!isAckTerminalRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.ackTerminal, [{ ...target(request), bytes: request.bytes }], isTerminalActionResponse);
    },
    closeTerminal(request: CloseTerminalRequest) {
      if (!isCloseTerminalRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.closeTerminal, [{ ...target(request), ...(request.onlyConnecting === true ? { onlyConnecting: true } : {}) }], isTerminalActionResponse);
    },
    reconnectTerminal(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.reconnectTerminal, [target(request)], isTerminalActionResponse);
    },
    dismissTerminal(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.dismissTerminal, [target(request)], isTerminalActionResponse);
    },
    async sftpState(request: TerminalStateRequest) {
      if (!isTerminalStateRequest(request)) return failure("invalid-request");
      const result = await invoke(channels.sftpState, [{ owner: { ...request.owner } }], isSftpState);
      if (!result.ok) return result;
      if (!sameOwner(result.value.owner) || !sameOwner(request.owner)) return failure("stale-owner");
      sftpSequence = Math.max(sftpSequence, result.value.sequence);
      return result;
    },
    onSftpState(callback: (state: SftpState) => void): () => void {
      return subscribe(channels.sftpStateChanged, sftpCallbacks, sftpListener, callback);
    },
    async remoteEditState(request: TerminalStateRequest) {
      if (!isTerminalStateRequest(request)) return failure("invalid-request");
      const result = await invoke(channels.remoteEditState, [{ owner: { ...request.owner } }], isRemoteEditState);
      if (!result.ok) return result;
      if (!sameOwner(result.value.owner) || !sameOwner(request.owner)) return failure("stale-owner");
      remoteEditSequence = Math.max(remoteEditSequence, result.value.sequence);
      return result;
    },
    onRemoteEditState(callback: (state: RemoteEditState) => void): () => void {
      return subscribe(channels.remoteEditStateChanged, remoteEditCallbacks, remoteEditListener, callback);
    },
    startRemoteEdit(request: StartRemoteEditRequest) {
      if (!isStartRemoteEditRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.startRemoteEdit, [{ owner: { ...request.owner }, source: source(request.source), path: request.path }], isStartRemoteEditResponse);
    },
    openRemoteEditor(request: RemoteEditRequest) {
      if (!isRemoteEditRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.openRemoteEditor, [{ owner: { ...request.owner }, editId: request.editId, revision: request.revision }], isTerminalActionResponse);
    },
    checkRemoteEdit(request: RemoteEditRequest) {
      if (!isRemoteEditRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.checkRemoteEdit, [{ owner: { ...request.owner }, editId: request.editId, revision: request.revision }], isTerminalActionResponse);
    },
    uploadRemoteEdit(request: UploadRemoteEditRequest) {
      if (!isUploadRemoteEditRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.uploadRemoteEdit, [{ owner: { ...request.owner }, editId: request.editId, revision: request.revision, approvalId: request.approvalId }], isTerminalActionResponse);
    },
    discardRemoteEdit(request: RemoteEditRequest) {
      if (!isRemoteEditRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.discardRemoteEdit, [{ owner: { ...request.owner }, editId: request.editId, revision: request.revision }], isTerminalActionResponse);
    },
    async transferState(request: TerminalStateRequest) {
      if (!isTerminalStateRequest(request)) return failure("invalid-request");
      const result = await invoke(channels.transferState, [{ owner: { ...request.owner } }], isTransferState);
      if (!result.ok) return result;
      if (!sameOwner(result.value.owner) || !sameOwner(request.owner)) return failure("stale-owner");
      transferSequence = Math.max(transferSequence, result.value.sequence);
      return result;
    },
    onTransferState(callback: (state: TransferState) => void): () => void {
      return subscribe(channels.transferStateChanged, transferCallbacks, transferListener, callback);
    },
    enqueueTransfers(request: EnqueueTransfersRequest) {
      if (!isEnqueueTransfersRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.enqueueTransfers, [{ owner: { ...request.owner }, source: source(request.source),
        sourceDirectory: request.sourceDirectory, names: [...request.names], destination: source(request.destination),
        destinationDirectory: request.destinationDirectory }], isTerminalActionResponse);
    },
    cancelTransfer(request: CancelTransferRequest) {
      if (!isCancelTransferRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.cancelTransfer, [{ owner: { ...request.owner }, jobId: request.jobId }], isTerminalActionResponse);
    },
    resolveTransferConflict(request: ResolveTransferConflictRequest) {
      if (!isResolveTransferConflictRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.resolveTransferConflict, [{ owner: { ...request.owner }, jobId: request.jobId,
        conflictId: request.conflictId, decision: request.decision, name: request.name }], isTerminalActionResponse);
    },
    retryTransfer(request: RetryTransferRequest) {
      if (!isRetryTransferRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.retryTransfer, [{ owner: { ...request.owner }, jobId: request.jobId }], isTerminalActionResponse);
    },
    clearFinishedTransfers(request: TerminalStateRequest) {
      if (!isTerminalStateRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.clearFinishedTransfers, [{ owner: { ...request.owner } }], isTerminalActionResponse);
    },
    connectSftp(request: ConnectHostRequest) {
      if (!isConnectHostRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.connectSftp, [{ owner: { ...request.owner }, hostId: request.hostId }], isConnectHostResponse);
    },
    closeSftp(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.closeSftp, [target(request)], isTerminalActionResponse);
    },
    reconnectSftp(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.reconnectSftp, [target(request)], isTerminalActionResponse);
    },
    dismissSftp(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.dismissSftp, [target(request)], isTerminalActionResponse);
    },
    listDirectory(request: FilePathRequest) {
      if (!isFilePathRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.listDirectory, [fileRequest(request)], isListingOutcome);
    },
    statPath(request: FilePathRequest) {
      if (!isFilePathRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.statPath, [fileRequest(request)], isAttributesOutcome);
    },
    resolvePath(request: FilePathRequest) {
      if (!isResolvePathRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.resolvePath, [fileRequest(request)], isResolvedPathOutcome);
    },
    async catalogState(request: CatalogStateRequest) {
      if (!isCatalogStateRequest(request)) return failure("invalid-request");
      const result = await invoke(channels.catalogState, [{ owner: { ...request.owner } }], isCatalogState);
      if (!result.ok) return result;
      if (!sameOwner(result.value.owner) || !sameOwner(request.owner)) return failure("stale-owner");
      catalogSequence = Math.max(catalogSequence, result.value.sequence);
      return result;
    },
    onCatalogState(callback: (state: CatalogState) => void): () => void {
      return subscribe(channels.catalogStateChanged, catalogCallbacks, catalogListener, callback);
    },
    async prepareCatalogChange(request: PrepareCatalogChangeRequest) {
      if (!isPrepareCatalogChangeRequest(request)) return failure("invalid-request");
      let intent: unknown;
      // A validated plain copy, never the caller's object; main validates it again.
      try { intent = structuredClone(request.intent); } catch { return failure("invalid-request"); }
      return invoke(channels.prepareCatalogChange, [{ owner: { ...request.owner }, intent }], isCatalogPrepareResponse);
    },
    applyCatalogChange(request: ApplyCatalogChangeRequest) {
      if (!isApplyCatalogChangeRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.applyCatalogChange, [{ owner: { ...request.owner }, token: request.token }], isCatalogApplyResponse);
    },
    startLocalTerminal(request: StartLocalTerminalRequest) {
      if (!isStartLocalTerminalRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.startLocalTerminal, [{ owner: { ...request.owner } }], isConnectHostResponse);
    },
    connectHost(request: ConnectHostRequest) {
      if (!isConnectHostRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.connectHost, [{ owner: { ...request.owner }, hostId: request.hostId }], isConnectHostResponse);
    },
    async setIdentityPassword(request: SetIdentityPasswordRequest) {
      if (!isSetIdentityPasswordRequest(request)) return failure("invalid-request");
      try {
        return await invoke(channels.setIdentityPassword, [{ owner: { ...request.owner }, identityId: request.identityId,
          expectedRevision: request.expectedRevision, value: request.value }], isSetIdentityPasswordResponse);
      } finally { wipe([request.value]); }
    },
    chooseKeyFile(request: ChooseKeyFileRequest) {
      if (!isChooseKeyFileRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.chooseKeyFile, [{ owner: { ...request.owner } }], isChooseKeyFileResponse);
    },
    async importKey(request: ImportKeyRequest) {
      if (!isImportKeyRequest(request)) return failure("invalid-request");
      try {
        return await invoke(channels.importKey, [{ owner: { ...request.owner }, importId: request.importId, label: request.label,
          passphrase: request.passphrase, savePassphrase: request.savePassphrase }], isImportKeyResponse);
      } finally { wipe([request.passphrase]); }
    },
    discardKeyImport(request: DiscardKeyImportRequest) {
      if (!isDiscardKeyImportRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.discardKeyImport, [{ owner: { ...request.owner }, importId: request.importId }], isDiscardKeyImportResponse);
    },
    renameKey(request: RenameKeyRequest) {
      if (!isRenameKeyRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.renameKey, [{ owner: { ...request.owner }, keyId: request.keyId, expectedRevision: request.expectedRevision,
        label: request.label }], isRenameKeyResponse);
    },
    forgetKeyPassphrase(request: ForgetKeyPassphraseRequest) {
      if (!isKeyTargetRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.forgetKeyPassphrase, [{ owner: { ...request.owner }, keyId: request.keyId,
        expectedRevision: request.expectedRevision }], isForgetKeyPassphraseResponse);
    },
    deleteKey(request: DeleteKeyRequest) {
      if (!isKeyTargetRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.deleteKey, [{ owner: { ...request.owner }, keyId: request.keyId,
        expectedRevision: request.expectedRevision }], isDeleteKeyResponse);
    },
    retrySecrets(request: RetrySecretsRequest) {
      if (!isRetrySecretsRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.retrySecrets, [{ owner: { ...request.owner } }], isRetrySecretsResponse);
    },
    workspaceTemplates(request: WorkspaceTemplatesRequest) {
      if (!isWorkspaceTemplatesRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.workspaceTemplates, [{ owner: { ...request.owner } }], isWorkspaceTemplatesResponse);
    },
    saveWorkspaceTemplate(request: SaveWorkspaceTemplateRequest) {
      if (!isSaveWorkspaceTemplateRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.saveWorkspaceTemplate, [{ owner: { ...request.owner }, templateId: request.templateId,
        expectedRevision: request.expectedRevision, label: request.label, configuration: copyWorkspaceTemplateConfiguration(request.configuration) }], isWorkspaceTemplateView);
    },
    deleteWorkspaceTemplate(request: DeleteWorkspaceTemplateRequest) {
      if (!isDeleteWorkspaceTemplateRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.deleteWorkspaceTemplate, [{ owner: { ...request.owner }, templateId: request.templateId,
        expectedRevision: request.expectedRevision }], isDeleteWorkspaceTemplateResponse);
    },
    openSnippet(request: OpenSnippetRequest) {
      if (!isOpenSnippetRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.openSnippet, [{ owner: { ...request.owner }, snippetId: request.snippetId,
        expectedRevision: request.expectedRevision }], isOpenSnippetResponse);
    },
    saveSnippet(request: SaveSnippetRequest) {
      if (!isSaveSnippetRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.saveSnippet, [{ owner: { ...request.owner }, snippetId: request.snippetId,
        expectedRevision: request.expectedRevision, label: request.label, body: request.body, tagIds: [...request.tagIds] }], isSaveSnippetResponse);
    },
    deleteSnippet(request: DeleteSnippetRequest) {
      if (!isDeleteSnippetRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.deleteSnippet, [{ owner: { ...request.owner }, snippetId: request.snippetId,
        expectedRevision: request.expectedRevision }], isDeleteSnippetResponse);
    },
    appLockState(request: AppLockStateRequest) {
      if (!appLockRequestGuards.state(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.appLockState, [{ owner: { ...request.owner } }], isAppLockStatus);
    },
    setupAppLockPassword(request: SetupPasswordRequest) {
      if (!appLockRequestGuards.setupPassword(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.setupAppLockPassword, [{ owner: { ...request.owner }, username: request.username, password: request.password,
        confirmPassword: request.confirmPassword }], isSetupPasswordResponse);
    },
    unlockAppLock(request: UnlockPasswordRequest) {
      if (!appLockRequestGuards.unlockPassword(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.unlockAppLock, [{ owner: { ...request.owner }, username: request.username, password: request.password }], isAttemptResponse);
    },
    confirmAppLockPassword(request: ConfirmPasswordRequest) {
      if (!appLockRequestGuards.confirmPassword(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.confirmAppLockPassword, [{ owner: { ...request.owner }, password: request.password }], isAttemptResponse);
    },
    googleSignIn(request: GoogleSignInRequest) {
      if (!appLockRequestGuards.google(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.googleSignIn, [{ owner: { ...request.owner }, purpose: request.purpose }], isGoogleSignInResponse);
    },
    cancelGoogleSignIn(request: CancelGoogleRequest) {
      if (!appLockRequestGuards.cancelGoogle(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.cancelGoogleSignIn, [{ owner: { ...request.owner } }], isCancelGoogleResponse);
    },
    unlockAppLockOffline(request: UnlockOfflineRequest) {
      if (!appLockRequestGuards.unlockOffline(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.unlockAppLockOffline, [{ owner: { ...request.owner } }], isUnlockOfflineResponse);
    },
    recoverAppLock(request: RecoverRequest) {
      if (!appLockRequestGuards.recover(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.recoverAppLock, [{ owner: { ...request.owner }, code: request.code }], isAttemptResponse);
    },
    regenerateRecoveryCode(request: RegenerateRecoveryRequest) {
      if (!appLockRequestGuards.regenerateRecovery(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.regenerateRecoveryCode, [{ owner: { ...request.owner } }], isRegenerateRecoveryResponse);
    },
    async tunnelState(request: TunnelStateRequest) {
      if (!isTunnelStateRequest(request)) return failure("invalid-request");
      const result = await invoke(channels.tunnelState, [{ owner: { ...request.owner } }], isTunnelState);
      if (!result.ok) return result;
      if (!sameOwner(result.value.owner) || !sameOwner(request.owner)) return failure("stale-owner");
      tunnelSequence = Math.max(tunnelSequence, result.value.sequence);
      return result;
    },
    onTunnelState(callback: (state: TunnelState) => void): () => void {
      return subscribe(channels.tunnelStateChanged, tunnelCallbacks, tunnelListener, callback);
    },
    startTunnel(request: TunnelRuleRequest) {
      if (!isTunnelRuleRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.startTunnel, [{ owner: { ...request.owner }, ruleId: request.ruleId }], isStartTunnelResponse);
    },
    stopTunnel(request: TunnelRuleRequest) {
      if (!isTunnelRuleRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.stopTunnel, [{ owner: { ...request.owner }, ruleId: request.ruleId }], isStopTunnelResponse);
    },
    settings(request: SettingsRequest) {
      if (!isSettingsRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.settings, [{ owner: { ...request.owner } }], isTerminalSettings);
    },
    updateSettings(request: UpdateSettingsRequest) {
      if (!isUpdateSettingsRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.updateSettings, [{ owner: { ...request.owner }, changes: { ...request.changes } }], isTerminalSettings);
    },
    recordingState(request: RecordingStateRequest) {
      if (!isRecordingStateRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.recordingState, [{ owner: { ...request.owner } }], isRecordingState);
    },
    configureRecording(request: ConfigureRecordingRequest) {
      if (!isConfigureRecordingRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.configureRecording, [{ owner: { ...request.owner }, policy: { ...request.policy } }], isConfigureRecordingResponse);
    },
    deleteRecordings(request: DeleteRecordingsRequest) {
      if (!isDeleteRecordingsRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.deleteRecordings, [{ owner: { ...request.owner }, target: { ...request.target } }], isRecordingState);
    },
    exportRecording(request: ExportRecordingRequest) {
      if (!isExportRecordingRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.exportRecording, [{ owner: { ...request.owner }, target: { ...request.target } }], isExportRecordingResponse);
    },
    suggestCommands(request: SuggestCommandsRequest) {
      if (!isSuggestCommandsRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.suggestCommands, [{ owner: { ...request.owner }, sessionId: request.sessionId, generation: request.generation,
        prefix: request.prefix }], isSuggestCommandsResponse);
    },
    forgetCommand(request: ForgetCommandRequest) {
      if (!isForgetCommandRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.forgetCommand, [{ owner: { ...request.owner }, sessionId: request.sessionId, generation: request.generation,
        text: request.text }], isForgetCommandResponse);
    },
    openLink(request: OpenLinkRequest) {
      if (!isOpenLinkRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.openLink, [{ owner: { ...request.owner }, url: request.url }], isOpenLinkResponse);
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
