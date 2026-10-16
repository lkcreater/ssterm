import { randomUUID } from "node:crypto";
import {
  HOST_KEY_ALGORITHMS,
  type ResolvedHostConfig,
  type StoreResult,
  type HostKeyAlgorithm,
} from "@ssterm/domain";
import { TransientSecrets, type TransientSecret } from "./transient.ts";

export type SessionState =
  | "Idle"
  | "Connecting"
  | "VerifyingHost"
  | "Authenticating"
  | "AwaitingInput"
  | "Ready"
  | "Failed"
  | "Closing"
  | "Closed";
const messages = {
  "invalid-request": "The session request is invalid.",
  "invalid-state": "The session is not in the required state.",
  "not-found": "The session is unavailable.",
  locked: "The workspace is locked.",
  disposed: "The session service is closed.",
  "invalid-config": "The host configuration is unavailable.",
  "host-key-untrusted": "The host key was not trusted.",
  "host-key-changed": "The host key changed.",
  "auth-denied": "Authentication was denied.",
  "credentials-required": "Saved credentials are required.",
  "credentials-unavailable": "Saved credentials are unavailable.",
  "invalid-private-key": "The saved private key could not be opened.",
  "unsupported-private-key": "The saved private key format is unsupported.",
  "key-mismatch": "The saved private key does not match its public metadata.",
  "prompt-cancelled": "The prompt was cancelled.",
  timeout: "The connection or prompt timed out.",
  dns: "The host could not be resolved.",
  network: "The connection failed.",
  "channel-open-failed": "The interactive channel could not be opened.",
  "subsystem-unavailable": "The connection subsystem is unavailable.",
  "resource-limit": "The session resource limit was reached.",
} as const;
export type SessionErrorCode = keyof typeof messages;
export interface SessionError {
  code: SessionErrorCode;
  message: string;
}
export type SessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionError };
export type PromptFieldId =
  | "password"
  | "passphrase"
  | "response-1"
  | "response-2"
  | "response-3"
  | "response-4"
  | "response-5"
  | "response-6"
  | "response-7"
  | "response-8";
export type SessionPromptSpec =
  | ({
      kind: "host-trust";
      algorithm: HostKeyAlgorithm;
      fingerprint: string;
      endpointHost: string;
      endpointPort: number;
    } & (
      | { status: "unknown" }
      | {
          status: "changed";
          previousAlgorithm: HostKeyAlgorithm;
          previousFingerprint: string;
        }
    ))
  | {
      kind: "credentials";
      purpose?: "password" | "passphrase" | "keyboard-interactive";
      attempt?: 1 | 2 | 3;
      fields: readonly { id: PromptFieldId; echo: boolean }[];
    };
export type SessionPrompt = SessionPromptSpec & { id: string };
export type SessionPromptInput =
  | {
      kind: "host-trust";
      decision: "accept-once" | "remember" | "replace" | "reject";
    }
  | {
      kind: "credentials";
      values: readonly { id: PromptFieldId; value: Uint8Array }[];
    };
/** Main-only answer. Consume synchronously; the views are overwritten when the callback returns. */
export type SessionPromptAnswer =
  | {
      kind: "host-trust";
      decision: "accept-once" | "remember" | "replace" | "reject";
    }
  | {
      kind: "credentials";
      use<T>(
        callback: (
          values: Readonly<Partial<Record<PromptFieldId, Uint8Array>>>,
        ) => T,
      ): T;
    };
export interface SessionSnapshot {
  id: string;
  generation: number;
  hostId: string;
  state: SessionState;
  target?: {
    label: string;
    address: string;
    port: number;
    username: string | null;
    environment: ResolvedHostConfig["environment"];
    hostRevision: number;
    catalogRevision: number;
  };
  prompt?: SessionPrompt;
  error?: SessionError;
  cleanup: "none" | "pending" | "complete" | "timeout" | "failed";
}
export interface SessionResource {
  dispose(): void;
  readonly drained?: Promise<void>;
}
export interface SessionContext {
  readonly id: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly config: ResolvedHostConfig;
  own(resource: SessionResource): boolean;
  verifyingHost(): boolean;
  authenticating(): boolean;
  requestPrompt(spec: SessionPromptSpec): Promise<SessionPromptAnswer>;
  ready(terminal: SessionResource): boolean;
  failed(code: SessionErrorCode): void;
  ended(): void;
}
export interface SessionAdapter {
  start(context: SessionContext): void | Promise<void>;
}
export interface SessionLimits {
  sessions: number;
  resources: number;
  promptMs: number;
  connectMs: number;
  drainMs: number;
}
export interface SessionScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}
interface PendingPrompt {
  spec: SessionPrompt;
  resume: "VerifyingHost" | "Authenticating";
  resolve(answer: SessionPromptAnswer): void;
  reject(error: Error): void;
  timer: unknown;
}
interface ResourceEntry {
  resource: SessionResource;
  owner: Generation;
  disposed: boolean;
  drain: Promise<boolean>;
  disposeResult?: Promise<boolean>;
}
interface Generation {
  id: string;
  ownerId: string;
  hostId: string;
  generation: number;
  state: SessionState;
  active: boolean;
  controller: AbortController;
  config?: ResolvedHostConfig;
  error?: SessionError;
  prompt?: PendingPrompt;
  resources: Set<ResourceEntry>;
  secrets: Set<TransientSecret>;
  connectTimer?: unknown;
  cleanup: SessionSnapshot["cleanup"];
  teardown?: Promise<void>;
  teardownDone: boolean;
}
const success = <T>(value: T): SessionResult<T> => ({ ok: true, value });
const error = (code: SessionErrorCode): SessionError => ({
  code,
  message: messages[code],
});
const failure = <T>(code: SessionErrorCode): SessionResult<T> => ({
  ok: false,
  error: error(code),
});
class SessionFault extends Error {
  constructor(readonly code: SessionErrorCode) {
    super(messages[code]);
  }
}
function rejectedPrompt(code: SessionErrorCode): Promise<SessionPromptAnswer> {
  const promise = Promise.reject<SessionPromptAnswer>(new SessionFault(code));
  // Late/invalid Adapter callbacks may ignore their result during disposal.
  // Awaiting callers still receive the rejection; the process never gets an orphan.
  void promise.catch(() => {});
  return promise;
}
const validName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f]/u.test(value);
const finiteCode = (value: unknown): SessionErrorCode =>
  typeof value === "string" && Object.hasOwn(messages, value)
    ? (value as SessionErrorCode)
    : "subsystem-unavailable";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
const nativeScheduler: SessionScheduler = {
  set(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
const fieldIds = new Set<PromptFieldId>([
  "password",
  "passphrase",
  "response-1",
  "response-2",
  "response-3",
  "response-4",
  "response-5",
  "response-6",
  "response-7",
  "response-8",
]);
function promptSpec(input: SessionPromptSpec): SessionPromptSpec | undefined {
  if (!input || typeof input !== "object") return;
  if (input.kind === "host-trust") {
    const algorithms: readonly string[] = HOST_KEY_ALGORITHMS;
    const fingerprint = (value: unknown) =>
      typeof value === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/u.test(value);
    const fields = [
      "kind",
      "status",
      "endpointHost",
      "endpointPort",
      "algorithm",
      "fingerprint",
      ...(input.status === "changed"
        ? ["previousAlgorithm", "previousFingerprint"]
        : []),
    ];
    if (
      Object.keys(input).some((key) => !fields.includes(key)) ||
      !["unknown", "changed"].includes(input.status) ||
      !algorithms.includes(input.algorithm) ||
      !fingerprint(input.fingerprint) ||
      typeof input.endpointHost !== "string" ||
      input.endpointHost.length < 1 ||
      input.endpointHost.length > 253 ||
      /[\s\u0000-\u001f\u007f]/u.test(input.endpointHost) ||
      !Number.isInteger(input.endpointPort) ||
      input.endpointPort < 1 ||
      input.endpointPort > 65535 ||
      (input.status === "changed" &&
        (!algorithms.includes(input.previousAlgorithm) ||
          !fingerprint(input.previousFingerprint)))
    )
      return;
    return { ...input };
  }
  if (
    input.kind !== "credentials" ||
    Object.keys(input).some((key) => !["kind", "fields", "purpose", "attempt"].includes(key)) ||
    (input.purpose !== undefined && !["password", "passphrase", "keyboard-interactive"].includes(input.purpose)) ||
    (input.attempt !== undefined && ![1, 2, 3].includes(input.attempt)) ||
    !Array.isArray(input.fields) ||
    input.fields.length < 1 ||
    input.fields.length > 8
  )
    return;
  const ids = new Set<string>();
  const fields: { id: PromptFieldId; echo: boolean }[] = [];
  for (const field of input.fields) {
    if (
      !field ||
      typeof field !== "object" ||
      Object.keys(field).some((key) => !["id", "echo"].includes(key)) ||
      !fieldIds.has(field.id) ||
      ids.has(field.id) ||
      typeof field.echo !== "boolean"
    )
      return;
    ids.add(field.id);
    fields.push({ id: field.id, echo: field.echo });
  }
  return {
    kind: "credentials", fields,
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
  };
}

/** Main-only lifecycle and ownership. It exposes metadata projections, never resolved config or credential bytes. */
export class SessionRegistry {
  readonly #records = new Map<string, Generation>();
  readonly #resources = new WeakMap<SessionResource, ResourceEntry>();
  readonly #observers = new Map<
    string,
    Set<(snapshot: SessionSnapshot) => void>
  >();
  readonly #limits: SessionLimits;
  readonly #scheduler: SessionScheduler;
  #locked = false;
  #disposed = false;
  #epoch = 0;
  constructor(
    private readonly options: {
      resolve(
        hostId: string,
      ):
        | StoreResult<ResolvedHostConfig>
        | Promise<StoreResult<ResolvedHostConfig>>;
      adapter: SessionAdapter;
      transient: TransientSecrets;
      limits?: Partial<SessionLimits>;
      scheduler?: SessionScheduler;
    },
  ) {
    this.#limits = {
      sessions: 32,
      resources: 32,
      promptMs: 60_000,
      connectMs: 120_000,
      drainMs: 2_000,
      ...options.limits,
    };
    const maxima: SessionLimits = {
      sessions: 32,
      resources: 32,
      promptMs: 300_000,
      connectMs: 300_000,
      drainMs: 10_000,
    };
    for (const key of Object.keys(maxima) as (keyof SessionLimits)[])
      if (
        !Number.isSafeInteger(this.#limits[key]) ||
        this.#limits[key] < 1 ||
        this.#limits[key] > maxima[key]
      )
        throw new SessionFault("invalid-request");
    this.#scheduler = options.scheduler ?? nativeScheduler;
  }
  connect(ownerId: string, hostId: string): SessionResult<SessionSnapshot> {
    if (this.#disposed) return failure("disposed");
    if (this.#locked) return failure("locked");
    if (!validName(ownerId) || !validName(hostId))
      return failure("invalid-request");
    if (this.#records.size >= this.#limits.sessions)
      return failure("resource-limit");
    return success(this.#begin(ownerId, hostId, randomUUID(), 1));
  }
  reconnect(ownerId: string, id: string): SessionResult<SessionSnapshot> {
    if (this.#disposed) return failure("disposed");
    if (this.#locked) return failure("locked");
    const current = this.#owned(ownerId, id);
    if (!current) return failure("not-found");
    if (!["Failed", "Closed"].includes(current.state) || !current.teardownDone)
      return failure("invalid-state");
    return success(
      this.#begin(ownerId, current.hostId, id, current.generation + 1),
    );
  }
  snapshot(ownerId: string, id?: string): SessionSnapshot[] {
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.ownerId === ownerId && (id === undefined || id === record.id),
      )
      .map((record) => this.#snapshot(record));
  }
  subscribe(
    ownerId: string,
    callback: (snapshot: SessionSnapshot) => void,
  ): () => void {
    if (!validName(ownerId) || typeof callback !== "function" || this.#disposed)
      return () => {};
    let count = 0;
    for (const observers of this.#observers.values()) count += observers.size;
    if (count >= 128) return () => {};
    const observers = this.#observers.get(ownerId) ?? new Set();
    observers.add(callback);
    this.#observers.set(ownerId, observers);
    return () => {
      observers.delete(callback);
      if (observers.size === 0) this.#observers.delete(ownerId);
    };
  }
  cancelPrompt(ownerId: string, id: string, generation: number, promptId: string): SessionResult<void> {
    const current = this.#owned(ownerId, id);
    if (!current) return failure("not-found");
    if (!this.#live(current) || current.generation !== generation || !current.prompt || current.prompt.spec.id !== promptId || current.prompt.spec.kind !== "credentials")
      return failure("invalid-state");
    this.#fail(current, "prompt-cancelled");
    return success(undefined);
  }
  answerPrompt(
    ownerId: string,
    id: string,
    generation: number,
    promptId: string,
    answer: SessionPromptInput,
  ): SessionResult<void> {
    const current = this.#owned(ownerId, id);
    if (!current) return failure("not-found");
    if (
      !this.#live(current) ||
      generation !== current.generation ||
      current.prompt?.spec.id !== promptId
    )
      return failure("invalid-state");
    const pending = current.prompt;
    if (
      !pending ||
      !answer ||
      typeof answer !== "object" ||
      answer.kind !== pending.spec.kind
    )
      return failure("invalid-request");
    let delivered: SessionPromptAnswer;
    if (answer.kind === "host-trust" && pending.spec.kind === "host-trust") {
      if (
        Object.keys(answer).some(
          (key) => !["kind", "decision"].includes(key),
        ) ||
        !(
          pending.spec.status === "changed"
            ? ["replace", "reject"]
            : ["accept-once", "remember", "reject"]
        ).includes(answer.decision)
      )
        return failure("invalid-request");
      delivered = { kind: "host-trust", decision: answer.decision };
    } else if (
      answer.kind === "credentials" &&
      pending.spec.kind === "credentials"
    ) {
      if (
        Object.keys(answer).some((key) => !["kind", "values"].includes(key)) ||
        !Array.isArray(answer.values) ||
        answer.values.length !== pending.spec.fields.length
      )
        return failure("invalid-request");
      const ids = new Set<string>();
      let total = 0;
      for (const value of answer.values) {
        if (
          !value ||
          typeof value !== "object" ||
          Object.keys(value).some((key) => !["id", "value"].includes(key)) ||
          !pending.spec.fields.some((field) => field.id === value.id) ||
          ids.has(value.id) ||
          !(value.value instanceof Uint8Array) ||
          value.value.length > 16_384
        )
          return failure("invalid-request");
        ids.add(value.id);
        total += value.value.length;
      }
      if (total > 65_536) return failure("resource-limit");
      const secrets = new Map<PromptFieldId, TransientSecret>();
      try {
        for (const value of answer.values) {
          const secret = this.options.transient.hold(
            value.value,
            this.#limits.promptMs,
          );
          secrets.set(value.id, secret);
          current.secrets.add(secret);
        }
      } catch {
        for (const secret of secrets.values()) {
          secret.dispose();
          current.secrets.delete(secret);
        }
        return failure("subsystem-unavailable");
      }
      let consumed = false;
      delivered = {
        kind: "credentials",
        use: (callback) => {
          if (consumed || !this.#live(current))
            throw new SessionFault("prompt-cancelled");
          consumed = true;
          const values: Partial<Record<PromptFieldId, Uint8Array>> = {};
          try {
            for (const [id, secret] of secrets)
              secret.use((bytes) => {
                values[id] = bytes;
              });
            return callback(Object.freeze(values));
          } finally {
            for (const secret of secrets.values()) {
              secret.dispose();
              current.secrets.delete(secret);
            }
          }
        },
      };
    } else return failure("invalid-request");
    this.#scheduler.clear(pending.timer);
    delete current.prompt;
    current.state = pending.resume;
    // Promise continuations run after observers; adapters must still respect signal/generation.
    pending.resolve(delivered);
    if (delivered.kind === "host-trust" && delivered.decision === "reject")
      this.#fail(
        current,
        pending.spec.kind === "host-trust" && pending.spec.status === "changed"
          ? "host-key-changed"
          : "host-key-untrusted",
      );
    else this.#emit(current);
    return success(undefined);
  }
  cancel(ownerId: string, id: string): Promise<SessionResult<void>> {
    return this.close(ownerId, id);
  }
  close(ownerId: string, id: string): Promise<SessionResult<void>> {
    const current = this.#owned(ownerId, id);
    if (!current) return Promise.resolve(failure("not-found"));
    if (current.state === "Closed") return Promise.resolve(success(undefined));
    this.#fence(current, "Closing");
    if (current.teardownDone) this.#emit(current);
    return this.#teardown(current).then(() => success(undefined));
  }
  closeOwner(ownerId: string): Promise<void> {
    const records = [...this.#records.values()].filter(
      (record) => record.ownerId === ownerId,
    );
    for (const current of records) this.#fence(current, "Closing");
    this.#observers.delete(ownerId);
    return Promise.all(records.map((current) => this.#teardown(current))).then(
      () => {},
    );
  }
  forget(ownerId: string, id: string): SessionResult<void> {
    const current = this.#owned(ownerId, id);
    if (!current) return failure("not-found");
    if (!["Closed", "Failed"].includes(current.state) || !current.teardownDone)
      return failure("invalid-state");
    this.#records.delete(id);
    return success(undefined);
  }
  lock(): Promise<void> {
    this.#locked = true;
    this.#epoch++;
    const records = [...this.#records.values()];
    const completedFailures = records.filter(
      (current) => current.teardownDone && current.state === "Failed",
    );
    // Fence every generation before abort listeners, disposal or observers can reenter.
    for (const current of records) this.#fence(current, "Closing");
    for (const current of completedFailures) this.#emit(current);
    const drains = records.map((current) => this.#teardown(current));
    this.options.transient.purgeAll();
    return Promise.all(drains).then(() => {});
  }
  async unlock(checkAccess: () => Promise<boolean>): Promise<boolean> {
    if (this.#disposed || typeof checkAccess !== "function") return false;
    const epoch = ++this.#epoch;
    let allowed = false;
    try {
      allowed = await checkAccess();
    } catch {
      /* sanitized denial */
    }
    if (this.#disposed || epoch !== this.#epoch || allowed !== true)
      return false;
    this.#locked = false;
    return true;
  }
  dispose(): Promise<void> {
    this.#disposed = true;
    const drained = this.lock();
    this.#observers.clear();
    return drained;
  }
  #owned(ownerId: string, id: string): Generation | undefined {
    const current = this.#records.get(id);
    return current?.ownerId === ownerId ? current : undefined;
  }
  #live(current: Generation): boolean {
    return (
      current.active &&
      !this.#locked &&
      !this.#disposed &&
      this.#records.get(current.id) === current
    );
  }
  #begin(
    ownerId: string,
    hostId: string,
    id: string,
    generation: number,
  ): SessionSnapshot {
    const current: Generation = {
      ownerId,
      hostId,
      id,
      generation,
      state: "Connecting",
      active: true,
      controller: new AbortController(),
      resources: new Set(),
      secrets: new Set(),
      cleanup: "none",
      teardownDone: false,
    };
    this.#records.set(id, current);
    current.connectTimer = this.#scheduler.set(
      () => this.#fail(current, "timeout"),
      this.#limits.connectMs,
    );
    const snapshot = this.#snapshot(current);
    this.#emit(current);
    // Resolve outside the caller's stack, catching both synchronous and asynchronous adapter failures.
    void Promise.resolve()
      .then(async () => {
        if (!this.#live(current)) return;
        const result = await this.options.resolve(hostId);
        if (!this.#live(current)) return;
        if (!result.ok) {
          this.#fail(current, "invalid-config");
          return;
        }
        current.config = freeze(structuredClone(result.value));
        this.#emit(current);
        if (!this.#live(current)) return;
        const context: SessionContext = Object.freeze({
          id,
          generation,
          signal: current.controller.signal,
          config: current.config,
          own: (resource: SessionResource) => this.#own(current, resource),
          verifyingHost: () =>
            this.#transition(current, ["Connecting"], "VerifyingHost"),
          authenticating: () =>
            this.#transition(current, ["VerifyingHost"], "Authenticating"),
          requestPrompt: (spec: SessionPromptSpec) =>
            this.#prompt(current, spec),
          ready: (terminal: SessionResource) => {
            if (
              !this.#live(current) ||
              current.state !== "Authenticating" ||
              current.prompt
            ) {
              this.#discard(current, terminal);
              return false;
            }
            if (!this.#own(current, terminal)) return false;
            current.state = "Ready";
            this.#scheduler.clear(current.connectTimer);
            delete current.connectTimer;
            this.#emit(current);
            return this.#live(current) && current.state === "Ready";
          },
          failed: (code: SessionErrorCode) =>
            this.#fail(current, finiteCode(code)),
          ended: () => {
            if (this.#live(current)) {
              this.#fence(current, "Closing");
              void this.#teardown(current);
            }
          },
        });
        await this.options.adapter.start(context);
      })
      .catch(() => this.#fail(current, "subsystem-unavailable"));
    return snapshot;
  }
  #transition(
    current: Generation,
    from: SessionState[],
    to: SessionState,
  ): boolean {
    if (!this.#live(current) || !from.includes(current.state) || current.prompt)
      return false;
    current.state = to;
    this.#emit(current);
    return this.#live(current) && current.state === to;
  }
  #prompt(
    current: Generation,
    input: SessionPromptSpec,
  ): Promise<SessionPromptAnswer> {
    if (!this.#live(current) || current.prompt)
      return rejectedPrompt("invalid-state");
    for (const secret of current.secrets)
      if (secret.disposed) current.secrets.delete(secret);
    if (current.secrets.size > 0) return rejectedPrompt("invalid-state");
    const spec = promptSpec(input);
    if (!spec) return rejectedPrompt("invalid-request");
    const resume =
      spec.kind === "host-trust" ? "VerifyingHost" : "Authenticating";
    if (current.state !== resume) return rejectedPrompt("invalid-state");
    const promise = new Promise<SessionPromptAnswer>((resolve, reject) => {
      const timer = this.#scheduler.set(
        () => this.#fail(current, "timeout"),
        this.#limits.promptMs,
      );
      current.prompt = {
        spec: { ...spec, id: randomUUID() },
        resume,
        resolve,
        reject,
        timer,
      };
      if (spec.kind === "credentials") current.state = "AwaitingInput";
    });
    // An adapter can ignore its promise; rejection must never become an unhandled process error.
    void promise.catch(() => {});
    this.#emit(current);
    return promise;
  }
  #own(current: Generation, resource: SessionResource): boolean {
    if (
      !resource ||
      typeof resource !== "object" ||
      typeof resource.dispose !== "function"
    ) {
      this.#fail(current, "invalid-request");
      return false;
    }
    const existing = this.#resources.get(resource);
    if (existing)
      return (
        existing.owner === current && !existing.disposed && this.#live(current)
      );
    if (!this.#live(current)) {
      this.#discard(current, resource);
      return false;
    }
    if (current.resources.size >= this.#limits.resources) {
      this.#discard(current, resource);
      this.#fail(current, "resource-limit");
      return false;
    }
    const entry = this.#entry(current, resource);
    current.resources.add(entry);
    return true;
  }
  #entry(current: Generation, resource: SessionResource): ResourceEntry {
    let drain: Promise<boolean>;
    try {
      drain = Promise.resolve(resource.drained).then(
        () => true,
        () => false,
      );
    } catch {
      drain = Promise.resolve(false);
    }
    const entry = { resource, owner: current, disposed: false, drain };
    this.#resources.set(resource, entry);
    return entry;
  }
  #discard(current: Generation, resource: SessionResource): void {
    if (
      !resource ||
      typeof resource !== "object" ||
      typeof resource.dispose !== "function" ||
      this.#resources.has(resource)
    )
      return;
    this.#disposeEntry(this.#entry(current, resource));
  }
  #disposeEntry(entry: ResourceEntry): void {
    if (entry.disposed) return;
    entry.disposed = true;
    try {
      entry.disposeResult = Promise.resolve(entry.resource.dispose()).then(
        () => true,
        () => false,
      );
    } catch {
      entry.disposeResult = Promise.resolve(false);
    }
  }
  #fence(current: Generation, state: "Closing" | "Failed"): void {
    current.active = false;
    if (state === "Closing" && current.teardownDone) {
      current.state = "Closed";
      return;
    }
    if (
      current.state !== "Closed" &&
      (current.state !== "Failed" || state === "Closing")
    )
      current.state = state;
  }
  #fail(current: Generation, code: SessionErrorCode): void {
    if (!this.#live(current)) return;
    current.error = error(code);
    this.#fence(current, "Failed");
    void this.#teardown(current);
  }
  #teardown(current: Generation): Promise<void> {
    if (current.teardown) return current.teardown;
    let complete!: () => void;
    current.teardown = new Promise<void>((resolve) => {
      complete = resolve;
    });
    current.cleanup = "pending";
    this.#scheduler.clear(current.connectTimer);
    delete current.connectTimer;
    if (current.prompt) {
      const prompt = current.prompt;
      delete current.prompt;
      this.#scheduler.clear(prompt.timer);
      prompt.reject(new SessionFault("prompt-cancelled"));
    }
    for (const secret of current.secrets) secret.dispose();
    current.secrets.clear();
    // All ownership is fenced before external abort/dispose callbacks run.
    current.controller.abort();
    for (const entry of current.resources) this.#disposeEntry(entry);
    this.#emit(current);
    const drains = [...current.resources].flatMap((entry) => [
      entry.drain,
      entry.disposeResult ?? Promise.resolve(true),
    ]);
    let timer: unknown;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = this.#scheduler.set(
        () => resolve("timeout"),
        this.#limits.drainMs,
      );
    });
    void Promise.race([
      Promise.all(drains).then((results) =>
        results.every(Boolean) ? ("complete" as const) : ("failed" as const),
      ),
      timeout,
    ]).then((outcome) => {
      this.#scheduler.clear(timer);
      current.cleanup = outcome;
      current.teardownDone = true;
      current.resources.clear();
      delete current.config;
      if (current.state === "Closing") current.state = "Closed";
      this.#emit(current);
      complete();
    });
    return current.teardown;
  }
  #snapshot(current: Generation): SessionSnapshot {
    const config = current.config;
    return {
      id: current.id,
      generation: current.generation,
      hostId: current.hostId,
      state: current.state,
      cleanup: current.cleanup,
      ...(config
        ? {
            target: {
              label: config.hostRef.label,
              address: config.address,
              port: config.port.value,
              username: config.auth.identity?.username ?? null,
              environment: config.environment,
              hostRevision: config.hostRef.revision,
              catalogRevision: config.catalogRevision,
            },
          }
        : {}),
      ...(current.prompt
        ? { prompt: structuredClone(current.prompt.spec) }
        : {}),
      ...(current.error
        ? {
            error: {
              code: current.error.code,
              message: messages[current.error.code],
            },
          }
        : {}),
    };
  }
  #emit(current: Generation): void {
    for (const observer of [...(this.#observers.get(current.ownerId) ?? [])]) {
      try {
        observer(this.#snapshot(current));
      } catch {
        /* Observers never own lifecycle progress or raw error reporting. */
      }
    }
  }
}
