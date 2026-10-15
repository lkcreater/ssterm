import type { SecretDelete, SecretItem, SecretLookup, SecretProvider, SecretRead, SecretWrite } from '../../../packages/domain/src/index.ts';
type Operation = 'read' | 'lookup' | 'write' | 'delete';
/** One injected outcome for the next matching call. apply: the store still changes (an ambiguous success); crash: the call throws like a process exit. */
export interface Fault {
  op: Operation;
  status?: string;
  apply?: boolean;
  crash?: boolean;
}
export class SimulatedCrash extends Error {}
const ids = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** In-memory fault-injection SecretProvider for contract and journal tests. */
export class MemorySecretProvider implements SecretProvider {
  readonly items = new Map<string, Buffer>();
  readonly calls: Operation[] = [];
  #faults: Fault[] = [];
  inject(...faults: Fault[]): void {
    this.#faults.push(...faults);
  }
  count(op: Operation): number {
    return this.calls.filter(call => call === op).length;
  }
  #take(op: Operation): Fault | undefined {
    this.calls.push(op);
    const index = this.#faults.findIndex(fault => fault.op === op);
    return index === -1 ? undefined : this.#faults.splice(index, 1)[0];
  }
  #key(item: SecretItem): string | undefined {
    return item && ids.test(item.vaultId) && ids.test(item.ref) && ['password', 'private-key', 'passphrase', 'content-key'].includes(item.kind) ? `${item.vaultId}/${item.kind}/${item.ref}` : undefined;
  }
  async read(item: SecretItem): Promise<SecretRead> {
    const fault = this.#take('read');
    const key = this.#key(item);
    if (!key) return { status: 'error', code: 'invalid' };
    if (fault?.status) return { status: fault.status } as SecretRead;
    const value = this.items.get(key);
    return value ? { status: 'present', value: Buffer.from(value) } : { status: 'missing' };
  }
  async lookup(item: SecretItem): Promise<SecretLookup> {
    const fault = this.#take('lookup');
    const key = this.#key(item);
    if (!key) return { status: 'error', code: 'invalid' };
    if (fault?.status) return { status: fault.status } as SecretLookup;
    return this.items.has(key) ? { status: 'present' } : { status: 'missing' };
  }
  async write(item: SecretItem, value: Uint8Array): Promise<SecretWrite> {
    const fault = this.#take('write');
    const key = this.#key(item);
    if (!key) return { status: 'error', code: 'invalid' };
    if (!fault || fault.apply) this.items.set(key, Buffer.from(value));
    if (fault?.crash) throw new SimulatedCrash();
    return fault?.status ? { status: fault.status } as SecretWrite : { status: 'confirmed' };
  }
  async delete(item: SecretItem): Promise<SecretDelete> {
    const fault = this.#take('delete');
    const key = this.#key(item);
    if (!key) return { status: 'error', code: 'invalid' };
    const existed = this.items.has(key);
    if (!fault || fault.apply) this.items.delete(key);
    if (fault?.crash) throw new SimulatedCrash();
    if (fault?.status) return { status: fault.status } as SecretDelete;
    return { status: existed ? 'confirmed' : 'missing' };
  }
}
