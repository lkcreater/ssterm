import type { ResolvedHostConfig, StoreResult } from "@ssterm/domain";
import type { ManagedSshPasswordLoader } from "./ssh-session.ts";
import type { SessionResolveContext } from "./sessions.ts";

export interface TeamSessionAccessChange {
  teamId: string;
  principalId: string;
  deviceId: string;
  role: string | null;
  policyHash: string | null;
  canConnect: boolean;
}

/** Structural seam: the guard has no access to the TeamClient's key store or plaintext cache. */
export interface ManagedTeamSessionClient {
  hasVirtualBinding(hostId: string): boolean;
  resolveCapturedHost(input: { virtualHostId: string; session: SessionResolveContext }): Promise<
    { ok: true; value: ResolvedHostConfig } | { ok: false; code: string }
  >;
  loadManagedPassword: ManagedSshPasswordLoader;
  observePolicy(listener: (event: TeamSessionAccessChange) => void): () => void;
  fetch(): Promise<unknown>;
}

interface Attempt {
  session: SessionResolveContext;
  source?: NonNullable<ResolvedHostConfig["source"]>;
  detach(): void;
}
const denied = (): StoreResult<ResolvedHostConfig> => ({
  ok: false, error: { code: "invalid-request", message: "The managed host is unavailable." },
});

/**
 * Registers before the first ACL await. Only exact managed attempts are closed; personal and local sessions
 * never enter this ledger. Poll failures leave existing SSH alone; new managed connections still fail closed.
 */
export class TeamSessionGuard {
  readonly #attempts = new Set<Attempt>();
  readonly #unsubscribe: () => void;
  #timer?: ReturnType<typeof setTimeout>;
  #polling = false;
  #disposed = false;
  #epoch = 0;

  constructor(private readonly options: {
    client: ManagedTeamSessionClient;
    close(session: SessionResolveContext): void;
  }) {
    this.#unsubscribe = options.client.observePolicy((event) => {
      for (const attempt of [...this.#attempts]) {
        const source = attempt.source;
        if ((!source && !event.canConnect) || (source?.teamId === event.teamId && source.principalId === event.principalId &&
          (!event.canConnect || source.deviceId !== event.deviceId)))
          this.#close(attempt);
      }
    });
  }

  hasBinding(hostId: string): boolean { return this.options.client.hasVirtualBinding(hostId); }

  async resolve(hostId: string, session: SessionResolveContext): Promise<StoreResult<ResolvedHostConfig>> {
    if (this.#disposed || session.signal.aborted || session.kind !== "terminal" || this.#attempts.size >= 32) return denied();
    const epoch = this.#epoch;
    const attempt: Attempt = { session, detach: () => undefined };
    const abort = () => this.#remove(attempt);
    attempt.detach = () => session.signal.removeEventListener("abort", abort);
    this.#attempts.add(attempt);
    session.signal.addEventListener("abort", abort, { once: true });
    this.#schedule();
    try {
      const result = await this.options.client.resolveCapturedHost({ virtualHostId: hostId, session });
      if (!this.#attempts.has(attempt) || epoch !== this.#epoch || this.#disposed || session.signal.aborted) return denied();
      if (!result.ok || !result.value.source || result.value.source.kind !== "team" ||
        result.value.hostRef.id !== hostId || result.value.jumps?.length || result.value.proxy ||
        result.value.auth.selection !== "identity" || result.value.auth.identity?.method !== "password") {
        this.#remove(attempt);
        return denied();
      }
      attempt.source = Object.freeze({ ...result.value.source });
      return { ok: true, value: result.value };
    } catch { this.#remove(attempt); return denied(); }
  }

  lock(): void {
    this.#epoch++;
    for (const attempt of [...this.#attempts]) this.#close(attempt);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.lock();
    this.#unsubscribe();
  }

  #remove(attempt: Attempt): void {
    if (!this.#attempts.delete(attempt)) return;
    attempt.detach();
    if (!this.#attempts.size && this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
  }

  #close(attempt: Attempt): void {
    this.#remove(attempt);
    try { this.options.close(attempt.session); } catch { /* One failed close cannot spare other affected attempts. */ }
  }

  #schedule(): void {
    if (this.#disposed || this.#timer || this.#polling || !this.#attempts.size) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#polling = true;
      void Promise.resolve().then(() => this.options.client.fetch()).catch(() => undefined).finally(() => {
        this.#polling = false;
        this.#schedule();
      });
    }, 15_000);
    this.#timer.unref();
  }
}
