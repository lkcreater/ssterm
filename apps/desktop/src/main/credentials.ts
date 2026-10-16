import {
  failure, isCredentialState, isAnswerCredentialsRequest, isCancelCredentialPromptRequest,
  type Owner, type Result, type CredentialState, type CredentialPrompt,
  type AnswerCredentialsRequest, type CancelCredentialPromptRequest, type CredentialActionResponse,
} from "@ssterm/contracts";
import type { SessionRegistry } from "@ssterm/services";
import { sessionOwnerId } from "./session-runtime";
interface Registration {
  owner: Owner;
  sequence: number;
  send(state: CredentialState): void;
  unsubscribe(): void;
}
/** Projects only app-owned prompt metadata. Credential values live only during answer dispatch. */
export function createCredentialsController(options: {
  registry: Pick<SessionRegistry, "snapshot" | "subscribe" | "answerPrompt" | "cancelPrompt">;
}) {
  const registrations = new Map<string, Registration>();
  let disposed = false;
  const matching = (owner: Owner) => registrations.get(sessionOwnerId(owner));
  const state = (registration: Registration): Result<CredentialState> => {
    try {
      const prompts: CredentialPrompt[] = [];
      for (const snapshot of options.registry.snapshot(sessionOwnerId(registration.owner))) {
        const prompt = snapshot.prompt;
        if (!prompt || prompt.kind !== "credentials" || !snapshot.target) continue;
        const purpose = prompt.purpose ?? (prompt.fields[0]?.id === "password" ? "password" : prompt.fields[0]?.id === "passphrase" ? "passphrase" : "keyboard-interactive");
        prompts.push({ sessionId: snapshot.id, generation: snapshot.generation, promptId: prompt.id,
          targetLabel: snapshot.target.label, environment: snapshot.target.environment,
          endpointHost: snapshot.target.address, endpointPort: snapshot.target.port, username: snapshot.target.username,
          purpose, attempt: prompt.attempt ?? 1, fields: prompt.fields.map((field) => ({ ...field })),
        });
      }
      const value: CredentialState = { owner: { ...registration.owner }, sequence: registration.sequence, availability: "ready", prompts };
      return isCredentialState(value) ? { ok: true, value } : failure("unavailable");
    } catch { return failure("unavailable"); }
  };
  const publish = (registration: Registration) => {
    if (disposed || matching(registration.owner) !== registration) return;
    registration.sequence += 1;
    const current = state(registration);
    try {
      registration.send(current.ok ? current.value : { owner: { ...registration.owner }, sequence: registration.sequence, availability: "unavailable", prompts: [] });
    } catch { /* Closed windows cannot interrupt cleanup. */ }
  };
  const revokeOwner = (owner: Owner) => {
    const registration = matching(owner);
    registrations.delete(sessionOwnerId(owner));
    registration?.unsubscribe();
  };
  return {
    register(owner: Owner, send: (state: CredentialState) => void) {
      if (disposed) return;
      const existing = matching(owner);
      if (existing) { existing.send = send; return; }
      const registration: Registration = { owner: { ...owner }, sequence: 0, send, unsubscribe: () => {} };
      registrations.set(sessionOwnerId(owner), registration);
      registration.unsubscribe = options.registry.subscribe(sessionOwnerId(owner), () => publish(registration));
    },
    credentialState(owner: Owner): Result<CredentialState> {
      const registration = matching(owner);
      return !disposed && registration ? state(registration) : failure("stale-owner");
    },
    answerCredentials(request: AnswerCredentialsRequest): Result<CredentialActionResponse> {
      const owned: Uint8Array[] = [];
      try {
        if (!isAnswerCredentialsRequest(request)) return failure("invalid-request");
        if (disposed || !matching(request.owner)) return failure("stale-owner");
        const values = request.values.map((field) => {
          const value = new Uint8Array(field.value);
          owned.push(value);
          return { id: field.id, value };
        });
        const result = options.registry.answerPrompt(sessionOwnerId(request.owner), request.sessionId, request.generation, request.promptId, { kind: "credentials", values });
        return result.ok ? { ok: true, value: { accepted: true } } : failure("invalid-request");
      } catch { return failure("unavailable"); }
      finally { for (const value of owned) value.fill(0); }
    },
    cancelCredentialPrompt(request: CancelCredentialPromptRequest): Result<CredentialActionResponse> {
      if (!isCancelCredentialPromptRequest(request)) return failure("invalid-request");
      if (disposed || !matching(request.owner)) return failure("stale-owner");
      try {
        const result = options.registry.cancelPrompt(sessionOwnerId(request.owner), request.sessionId, request.generation, request.promptId);
        return result.ok ? { ok: true, value: { accepted: true } } : failure("invalid-request");
      } catch { return failure("unavailable"); }
    },
    revokeOwner,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of [...registrations.values()]) revokeOwner(registration.owner);
    },
  };
}
