import {
  failure,
  isTrustState,
  isKnownHostRevokePreview,
  isAnswerHostTrustRequest,
  isPrepareKnownHostRevokeRequest,
  isRevokeKnownHostRequest,
  MAX_KNOWN_HOSTS,
  type AnswerHostTrustRequest,
  type KnownHostRevokePreview,
  type Owner,
  type PrepareKnownHostRevokeRequest,
  type Result,
  type RevokeKnownHostRequest,
  type TrustActionResponse,
  type TrustState,
  type HostTrustPrompt,
} from "@ssterm/contracts";
import type { KnownHostPolicy, SessionRegistry } from "@ssterm/services";
import { sessionOwnerId } from "./session-runtime";

interface Registration {
  owner: Owner;
  sequence: number;
  send(state: TrustState): void;
  unsubscribe(): void;
}
/** Main owns this projection; no credential prompt or key material crosses its boundary. */
export function createKnownHostsController(options: {
  registry: Pick<SessionRegistry, "snapshot" | "subscribe" | "answerPrompt">;
  policy: Pick<
    KnownHostPolicy,
    "list" | "subscribe" | "prepareRevoke" | "revoke" | "revokeOwner"
  >;
}) {
  const registrations = new Map<string, Registration>();
  let disposed = false;
  const matching = (owner: Owner) => registrations.get(sessionOwnerId(owner));
  const state = (registration: Registration): Result<TrustState> => {
    try {
      const listed = options.policy.list();
      const prompts: HostTrustPrompt[] = [];
      for (const snapshot of options.registry.snapshot(
        sessionOwnerId(registration.owner),
      )) {
        const prompt = snapshot.prompt;
        if (!prompt || prompt.kind !== "host-trust" || !snapshot.target)
          continue;
        const base = {
          sessionId: snapshot.id,
          generation: snapshot.generation,
          promptId: prompt.id,
          targetLabel: snapshot.target.label,
          environment: snapshot.target.environment,
          endpointHost: prompt.endpointHost,
          endpointPort: prompt.endpointPort,
          algorithm: prompt.algorithm,
          fingerprint: prompt.fingerprint,
        };
        prompts.push(
          prompt.status === "changed"
            ? {
                ...base,
                status: "changed",
                previousAlgorithm: prompt.previousAlgorithm,
                previousFingerprint: prompt.previousFingerprint,
              }
            : { ...base, status: "unknown" },
        );
      }
      const entries = listed.ok ? listed.value : [];
      const value = {
        owner: { ...registration.owner },
        sequence: registration.sequence,
        availability: listed.ok ? "ready" : "unavailable",
        truncated: entries.length > MAX_KNOWN_HOSTS,
        knownHosts: entries.slice(0, MAX_KNOWN_HOSTS).map((entry) => ({
          id: entry.id,
          revision: entry.revision,
          endpointHost: entry.endpointHost,
          endpointPort: entry.endpointPort,
          algorithm: entry.algorithm,
          fingerprint: entry.fingerprint,
          firstAcceptedAt: entry.firstAcceptedAt,
          lastVerifiedAt: entry.lastVerifiedAt,
        })),
        prompts,
      };
      return isTrustState(value) ? { ok: true, value } : failure("unavailable");
    } catch {
      return failure("unavailable");
    }
  };
  const publish = (registration: Registration): void => {
    if (disposed || matching(registration.owner) !== registration) return;
    registration.sequence += 1;
    const current = state(registration);
    if (current.ok) {
      try {
        registration.send(current.value);
      } catch {
        /* A closed window cannot interrupt service cleanup. */
      }
    }
  };
  const offPolicy = options.policy.subscribe(() => {
    for (const registration of registrations.values()) publish(registration);
  });
  const revokeOwner = (owner: Owner): void => {
    const key = sessionOwnerId(owner);
    const registration = registrations.get(key);
    registrations.delete(key);
    registration?.unsubscribe();
    options.policy.revokeOwner(key);
  };
  return {
    register(owner: Owner, send: (state: TrustState) => void): void {
      if (disposed) return;
      const existing = matching(owner);
      if (existing) {
        existing.send = send;
        return;
      }
      const registration: Registration = {
        owner: { ...owner },
        sequence: 0,
        send,
        unsubscribe: () => {},
      };
      registrations.set(sessionOwnerId(owner), registration);
      // Subscribe before reading snapshots so no prompt can be lost between them.
      registration.unsubscribe = options.registry.subscribe(
        sessionOwnerId(owner),
        () => publish(registration),
      );
    },
    trustState(owner: Owner): Result<TrustState> {
      const registration = matching(owner);
      return !disposed && registration
        ? state(registration)
        : failure("stale-owner");
    },
    answerHostTrust(
      request: AnswerHostTrustRequest,
    ): Result<TrustActionResponse> {
      if (!isAnswerHostTrustRequest(request)) return failure("invalid-request");
      if (disposed || !matching(request.owner)) return failure("stale-owner");
      try {
        const result = options.registry.answerPrompt(
          sessionOwnerId(request.owner),
          request.sessionId,
          request.generation,
          request.promptId,
          { kind: "host-trust", decision: request.decision },
        );
        return result.ok
          ? { ok: true, value: { accepted: true } }
          : failure("invalid-request");
      } catch {
        return failure("unavailable");
      }
    },
    prepareKnownHostRevoke(
      request: PrepareKnownHostRevokeRequest,
    ): Result<KnownHostRevokePreview> {
      if (!isPrepareKnownHostRevokeRequest(request))
        return failure("invalid-request");
      if (disposed || !matching(request.owner)) return failure("stale-owner");
      try {
        const result = options.policy.prepareRevoke(
          sessionOwnerId(request.owner),
          request.id,
          request.expectedRevision,
        );
        if (!result.ok)
          return failure(
            result.error.code === "conflict" ? "conflict" : "unavailable",
          );
        return isKnownHostRevokePreview(result.value)
          ? { ok: true, value: result.value }
          : failure("unavailable");
      } catch {
        return failure("unavailable");
      }
    },
    revokeKnownHost(
      request: RevokeKnownHostRequest,
    ): Result<TrustActionResponse> {
      if (!isRevokeKnownHostRequest(request)) return failure("invalid-request");
      if (disposed || !matching(request.owner)) return failure("stale-owner");
      try {
        const result = options.policy.revoke(
          sessionOwnerId(request.owner),
          request.token,
        );
        if (result.ok) return { ok: true, value: { accepted: true } };
        return failure(
          result.error.code === "conflict" ? "conflict" : "unavailable",
        );
      } catch {
        return failure("unavailable");
      }
    },
    revokeOwner,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      offPolicy();
      for (const registration of [...registrations.values()])
        revokeOwner(registration.owner);
    },
  };
}
