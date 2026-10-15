/** Main-only transient secret lifetime. JavaScript cannot guarantee physical zeroization; dispose overwrites the owned copy. */
export const DEFAULT_TRANSIENT_MS = 60_000;
export const MAX_TRANSIENT_MS = 5 * 60_000;
export class TransientSecret {
  #bytes: Buffer | undefined;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #release: (secret: TransientSecret) => void;
  constructor(value: Uint8Array, ttlMs: number, release: (secret: TransientSecret) => void) {
    // Buffer.alloc never shares the pooled slab used by allocUnsafe.
    this.#bytes = Buffer.alloc(value.length);
    this.#bytes.set(value);
    this.#release = release;
    this.#timer = setTimeout(() => this.dispose(), ttlMs);
    this.#timer.unref();
  }
  get disposed(): boolean {
    return this.#bytes === undefined;
  }
  /** The view is valid only during the callback; callers must not retain it. */
  use<T>(callback: (bytes: Uint8Array) => T): T {
    if (!this.#bytes) throw new Error('Transient secret was disposed');
    return callback(this.#bytes);
  }
  dispose(): void {
    if (!this.#bytes) return;
    this.#bytes.fill(0);
    this.#bytes = undefined;
    clearTimeout(this.#timer);
    this.#release(this);
  }
}
export class TransientSecrets {
  readonly #live = new Set<TransientSecret>();
  hold(value: Uint8Array, ttlMs = DEFAULT_TRANSIENT_MS): TransientSecret {
    if (!(value instanceof Uint8Array) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TRANSIENT_MS) throw new Error('Invalid transient secret request');
    const secret = new TransientSecret(value, ttlMs, owned => this.#live.delete(owned));
    this.#live.add(secret);
    return secret;
  }
  get size(): number {
    return this.#live.size;
  }
  /** Lock, suspend and quit purge every live value; returns how many were disposed. */
  purgeAll(): number {
    const count = this.#live.size;
    for (const secret of [...this.#live]) secret.dispose();
    return count;
  }
}
