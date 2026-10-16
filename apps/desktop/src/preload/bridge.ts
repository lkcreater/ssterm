import {
  channels,
  isCredentialState, isCredentialStateRequest, isAnswerCredentialsRequest,
  isCancelCredentialPromptRequest, isCredentialActionResponse,
  type CredentialState, type CredentialStateRequest, type AnswerCredentialsRequest,
  type CancelCredentialPromptRequest,
  isTerminalState, isTerminalStateRequest, isTerminalOutput, isTerminalTarget, isWriteTerminalRequest,
  isResizeTerminalRequest, isAckTerminalRequest, isTerminalActionResponse,
  type TerminalState, type TerminalStateRequest, type TerminalOutput, type TerminalTarget,
  type WriteTerminalRequest, type ResizeTerminalRequest, type AckTerminalRequest,
  isOpenLinkRequest, isOpenLinkResponse, type OpenLinkRequest,
  isCatalogState, isCatalogStateRequest, isPrepareCatalogChangeRequest, isCatalogPrepareResponse,
  isApplyCatalogChangeRequest, isCatalogApplyResponse, isConnectHostRequest, isConnectHostResponse,
  type CatalogState, type CatalogStateRequest, type PrepareCatalogChangeRequest, type ApplyCatalogChangeRequest,
  type ConnectHostRequest,
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
  const sameOwner = (value: Owner) => !!owner && value.windowId === owner.windowId && value.generation === owner.generation;
  const terminalCallbacks = new Set<(state: TerminalState) => void>();
  const terminalListener = (_event: unknown, value: unknown): void => {
    if (disposed || !isTerminalState(value) || !sameOwner(value.owner) || value.sequence <= terminalSequence) return;
    terminalSequence = value.sequence;
    for (const callback of terminalCallbacks) callback(value);
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
      const values = request.values.map((field) => ({ id: field.id, value: new Uint8Array(field.value) }));
      try {
        return await invoke(channels.answerCredentials, [{ owner: { ...request.owner }, sessionId: request.sessionId,
          generation: request.generation, promptId: request.promptId, values }], isCredentialActionResponse);
      } finally { for (const field of values) field.value.fill(0); }
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
    closeTerminal(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.closeTerminal, [target(request)], isTerminalActionResponse);
    },
    reconnectTerminal(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.reconnectTerminal, [target(request)], isTerminalActionResponse);
    },
    dismissTerminal(request: TerminalTarget) {
      if (!isTerminalTarget(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.dismissTerminal, [target(request)], isTerminalActionResponse);
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
    connectHost(request: ConnectHostRequest) {
      if (!isConnectHostRequest(request)) return Promise.resolve(failure("invalid-request"));
      return invoke(channels.connectHost, [{ owner: { ...request.owner }, hostId: request.hostId }], isConnectHostResponse);
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
