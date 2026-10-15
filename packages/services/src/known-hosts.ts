import { randomUUID } from "node:crypto";
import {
  normalizeEndpoint,
  type HostKeyAlgorithm,
  type HostKeyIdentity,
  type KnownHost,
  type MetadataChange,
  type MetadataRepository,
  type MetadataSnapshot,
} from "@ssterm/domain";
import { decodeHostPublicKey } from "@ssterm/adapters";

export interface KnownHostView {
  id: string;
  revision: number;
  endpointHost: string;
  endpointPort: number;
  algorithm: HostKeyAlgorithm;
  fingerprint: string;
  firstAcceptedAt: string;
  lastVerifiedAt: string;
}
interface ChallengeIdentity {
  endpointHost: string;
  endpointPort: number;
  algorithm: HostKeyAlgorithm;
  fingerprint: string;
}
export type TrustChallenge =
  | (ChallengeIdentity & { kind: "unknown" })
  | (ChallengeIdentity & {
      kind: "changed";
      previousAlgorithm: HostKeyAlgorithm;
      previousFingerprint: string;
    });
export type TrustDecision = "accept-once" | "remember" | "replace" | "reject";
const messages = {
  untrusted: "The host key was not trusted.",
  changed: "The host key changed.",
  cancelled: "Host verification was cancelled.",
  conflict: "Host trust changed. Verify the host again.",
  storage: "Host trust storage is unavailable.",
  "invalid-request": "The host trust request is invalid.",
} as const;
export type KnownHostErrorCode = keyof typeof messages;
export type KnownHostResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: KnownHostErrorCode; message: string } };
export interface KnownHostRevokePreview {
  token: string;
  entry: KnownHostView;
  expiresAt: string;
}
const success = <T>(value: T): KnownHostResult<T> => ({ ok: true, value });
const failure = <T>(code: KnownHostErrorCode): KnownHostResult<T> => ({
  ok: false,
  error: { code, message: messages[code] },
});
const validOwner = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const view = (row: KnownHost): KnownHostView => ({
  id: row.id,
  revision: row.revision,
  endpointHost: row.endpointHost,
  endpointPort: row.endpointPort,
  algorithm: row.algorithm as HostKeyAlgorithm,
  fingerprint: row.fingerprint,
  firstAcceptedAt: row.firstAcceptedAt,
  lastVerifiedAt: row.lastVerifiedAt,
});

/** Shared main-only terminal/SFTP/tunnel policy. No transport or authentication belongs here. */
export class KnownHostPolicy {
  readonly #plans = new Map<
    string,
    { ownerId: string; entry: KnownHostView; expires: number }
  >();
  #disposed = false;
  readonly #observers = new Set<() => void>();
  subscribe(callback: () => void): () => void {
    if (
      this.#disposed ||
      typeof callback !== "function" ||
      this.#observers.size >= 128
    )
      return () => {};
    this.#observers.add(callback);
    return () => {
      this.#observers.delete(callback);
    };
  }
  constructor(
    private readonly options: {
      repository: MetadataRepository;
      now?: () => Date;
      createId?: () => string;
    },
  ) {}
  #time(): Date {
    return this.options.now?.() ?? new Date();
  }
  #snapshot(): KnownHostResult<MetadataSnapshot> {
    if (this.#disposed) return failure("cancelled");
    try {
      // Storage validates every row on open and commit; no re-parse per read.
      const result = this.options.repository.snapshot();
      return result.ok ? success(result.value) : failure("storage");
    } catch {
      return failure("storage");
    }
  }
  /** Commits against a snapshot read in the same synchronous turn; callers fence their own row. */
  #commit(
    current: MetadataSnapshot,
    change: MetadataChange,
  ): KnownHostResult<MetadataSnapshot> {
    try {
      const result = this.options.repository.commit({
        expectedCatalogRevision: current.catalogRevision,
        changes: [change],
      });
      if (!result.ok)
        return failure(
          result.error.code === "conflict" ? "conflict" : "storage",
        );
      for (const observer of [...this.#observers]) {
        try {
          observer();
        } catch {
          /* Observers cannot interrupt trust progress. */
        }
      }
      return success(result.value);
    } catch {
      return failure("storage");
    }
  }
  list(): KnownHostResult<KnownHostView[]> {
    const snapshot = this.#snapshot();
    if (!snapshot.ok) return snapshot;
    return success(
      snapshot.value.knownHosts
        .map(view)
        .sort(
          (a, b) =>
            a.endpointHost.localeCompare(b.endpointHost) ||
            a.endpointPort - b.endpointPort,
        ),
    );
  }
  async verify(request: {
    endpointHost: string;
    endpointPort: number;
    publicKey: Uint8Array;
    signal: AbortSignal;
    requestDecision(challenge: TrustChallenge): Promise<TrustDecision>;
  }): Promise<
    KnownHostResult<{
      decision: "known" | "accept-once" | "remember" | "replace";
    }>
  > {
    let endpointHost: string;
    let identity: HostKeyIdentity | undefined;
    try {
      if (
        !request ||
        !Number.isInteger(request.endpointPort) ||
        request.endpointPort < 1 ||
        request.endpointPort > 65535 ||
        !(request.signal instanceof AbortSignal) ||
        typeof request.requestDecision !== "function"
      )
        return failure("invalid-request");
      endpointHost = normalizeEndpoint(request.endpointHost);
      identity = decodeHostPublicKey(request.publicKey);
      if (!identity) return failure("invalid-request");
    } catch {
      return failure("invalid-request");
    }
    const signal = request.signal;
    const endpointPort = request.endpointPort;
    const cancelled = () => this.#disposed || signal.aborted;
    if (cancelled()) return failure("cancelled");
    const before = this.#snapshot();
    if (!before.ok) return before;
    const find = (snapshot: MetadataSnapshot) =>
      snapshot.knownHosts.find(
        (row) =>
          row.endpointHost === endpointHost && row.endpointPort === endpointPort,
      );
    const row = find(before.value);
    if (row?.publicKey === identity.publicKey) {
      // A match is trusted even if recording lastVerifiedAt fails.
      try {
        this.#commit(before.value, {
          type: "verify-known-host",
          id: row.id,
          expectedRevision: row.revision,
          verifiedAt: this.#time().toISOString(),
        });
      } catch {
        /* Best-effort observation. */
      }
      return cancelled()
        ? failure("cancelled")
        : success({ decision: "known" });
    }
    const base = {
      endpointHost,
      endpointPort,
      algorithm: identity.algorithm,
      fingerprint: identity.fingerprint,
    };
    const challenge: TrustChallenge = row
      ? {
          ...base,
          kind: "changed",
          previousAlgorithm: row.algorithm as HostKeyAlgorithm,
          previousFingerprint: row.fingerprint,
        }
      : { ...base, kind: "unknown" };
    let decision: TrustDecision;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Host verification cancelled."));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    void aborted.catch(() => {});
    try {
      if (cancelled()) return failure("cancelled");
      decision = await Promise.race([
        request.requestDecision(Object.freeze(challenge)),
        aborted,
      ]);
    } catch {
      return failure(cancelled() ? "cancelled" : row ? "changed" : "untrusted");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (cancelled()) return failure("cancelled");
    if (decision === "reject") return failure(row ? "changed" : "untrusted");
    if (
      row
        ? decision !== "replace"
        : decision !== "accept-once" && decision !== "remember"
    )
      return failure("invalid-request");
    // Fence only this endpoint: unrelated saves keep the decision, any change to its trust voids it.
    const current = this.#snapshot();
    if (!current.ok) return current;
    const latest = find(current.value);
    if (
      row
        ? latest?.id !== row.id ||
          latest.revision !== row.revision ||
          latest.publicKey !== row.publicKey
        : latest
    )
      return failure("conflict");
    if (decision === "accept-once") return success({ decision });
    let change: MetadataChange;
    try {
      const acceptedAt = this.#time().toISOString();
      change = row
        ? {
            type: "replace-known-host",
            id: row.id,
            expectedRevision: row.revision,
            data: { ...identity, acceptedAt },
          }
        : {
            type: "accept-known-host",
            id: this.options.createId?.() ?? randomUUID(),
            data: { endpointHost, endpointPort, ...identity, acceptedAt },
          };
    } catch {
      return failure("storage");
    }
    if (cancelled()) return failure("cancelled");
    const committed = this.#commit(current.value, change);
    if (!committed.ok) return committed;
    // A later revoke applies to the next verification; this decision was committed first.
    return cancelled() ? failure("cancelled") : success({ decision });
  }
  prepareRevoke(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): KnownHostResult<KnownHostRevokePreview> {
    if (
      !validOwner(ownerId) ||
      typeof id !== "string" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    )
      return failure("invalid-request");
    const snapshot = this.#snapshot();
    if (!snapshot.ok) return snapshot;
    const row = snapshot.value.knownHosts.find(
      (row) => row.id === id && row.revision === expectedRevision,
    );
    if (!row) return failure("conflict");
    const now = this.#time().getTime();
    for (const [token, plan] of this.#plans)
      if (plan.expires <= now) this.#plans.delete(token);
    if (this.#plans.size >= 64) return failure("invalid-request");
    const token = randomUUID();
    const entry = view(row);
    const expires = now + 60_000;
    this.#plans.set(token, { ownerId, entry, expires });
    return success({
      token,
      entry: structuredClone(entry),
      expiresAt: new Date(expires).toISOString(),
    });
  }
  revoke(ownerId: string, token: string): KnownHostResult<void> {
    if (this.#disposed) return failure("cancelled");
    if (!validOwner(ownerId) || typeof token !== "string")
      return failure("invalid-request");
    const plan = this.#plans.get(token);
    if (!plan || plan.ownerId !== ownerId) return failure("invalid-request");
    this.#plans.delete(token);
    if (plan.expires <= this.#time().getTime()) return failure("conflict");
    const current = this.#snapshot();
    if (!current.ok) return current;
    // The row revision fences the previewed key; unrelated saves keep the preview valid.
    const committed = this.#commit(current.value, {
      type: "revoke-known-host",
      id: plan.entry.id,
      expectedRevision: plan.entry.revision,
    });
    return committed.ok ? success(undefined) : committed;
  }
  revokeOwner(ownerId: string): void {
    for (const [token, plan] of this.#plans)
      if (plan.ownerId === ownerId) this.#plans.delete(token);
  }
  dispose(): void {
    this.#disposed = true;
    this.#plans.clear();
    this.#observers.clear();
  }
}
