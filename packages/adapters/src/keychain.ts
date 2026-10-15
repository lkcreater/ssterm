import { AsyncEntry, findCredentialsAsync } from '@napi-rs/keyring';
import type { SecretDelete, SecretItem, SecretLookup, SecretProvider, SecretRead, SecretWrite } from '@ssterm/domain';
import { validId } from './validation.ts';
export const PRODUCTION_SECRET_NAMESPACE = 'dev.ssterm.desktop.secrets';
const testNamespace = /^dev\.ssterm\.test\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const kinds = new Set(['password', 'private-key', 'passphrase', 'content-key']);
/** keyring-core 1.0.0 Display prefixes, verified against the shipped binary strings and crate source (ADR 0003).
 * macOS status codes are not exposed: storage-access and platform failures carry only localized OS text,
 * so they collapse with unrecognized errors into one inaccessible class and locked/denied are never inferred. */
export type ProviderFailure = 'inaccessible' | 'ambiguous' | 'invalid' | 'malformed' | 'missing';
export function classifyProviderError(error: unknown): ProviderFailure {
  const message = error instanceof Error && typeof error.message === 'string' ? error.message : '';
  if (message.startsWith('Entry is matched by ')) return 'ambiguous';
  if (message.startsWith("Value of '")) return 'invalid';
  if (/^(?:Secret|Store) data is malformed|^Password data is not valid UTF-8/u.test(message)) return 'malformed';
  if (message === 'No matching credential found') return 'missing';
  return 'inaccessible';
}
export function readOutcome(failure: ProviderFailure): Exclude<SecretRead, { status: 'present' }> {
  if (failure === 'missing') return { status: 'missing' };
  return failure === 'inaccessible' ? { status: 'unavailable' } : { status: 'error', code: failure };
}
/** A rejected mutation may still have reached the store, except keyring-core attribute validation before any platform call. */
export function writeOutcome(failure: ProviderFailure): SecretWrite {
  return failure === 'invalid' ? { status: 'error', code: 'invalid' } : { status: 'unknown' };
}
export function deleteOutcome(failure: ProviderFailure): SecretDelete {
  if (failure === 'missing') return { status: 'missing' };
  return failure === 'invalid' ? { status: 'error', code: 'invalid' } : { status: 'unknown' };
}
function account(item: SecretItem): string | undefined {
  if (!item || !validId(item.vaultId) || !validId(item.ref) || !kinds.has(item.kind)) return undefined;
  return `${item.vaultId}/${item.kind}/${item.ref}`;
}
/** macOS Keychain generic passwords under one app-owned service namespace. Values never leave main. */
export class KeychainSecretProvider implements SecretProvider {
  constructor(private readonly namespace: string) {
    if (namespace !== PRODUCTION_SECRET_NAMESPACE && !testNamespace.test(namespace)) throw new Error('Unsupported secret namespace');
  }
  private entry(item: SecretItem): AsyncEntry | undefined {
    const name = account(item);
    return name ? new AsyncEntry(this.namespace, name) : undefined;
  }
  async read(item: SecretItem): Promise<SecretRead> {
    try {
      const entry = this.entry(item);
      if (!entry) return { status: 'error', code: 'invalid' };
      const value = await entry.getSecret();
      if (value === null) return { status: 'missing' };
      const bytes = Buffer.alloc(value.length);
      for (let i = 0; i < value.length; i++) bytes[i] = value[i]!;
      value.fill(0);
      return { status: 'present', value: bytes };
    } catch (error) {
      return readOutcome(classifyProviderError(error));
    }
  }
  /** The account encodes vault, kind and ref, so a present item is the exact owned one; its value is discarded. */
  async lookup(item: SecretItem): Promise<SecretLookup> {
    const result = await this.read(item);
    if (result.status !== 'present') return result;
    result.value.fill(0);
    return { status: 'present' };
  }
  async write(item: SecretItem, value: Uint8Array): Promise<SecretWrite> {
    try {
      const entry = this.entry(item);
      if (!entry || !(value instanceof Uint8Array)) return { status: 'error', code: 'invalid' };
      await entry.setSecret(value);
      return { status: 'confirmed' };
    } catch (error) {
      return writeOutcome(classifyProviderError(error));
    }
  }
  async delete(item: SecretItem): Promise<SecretDelete> {
    try {
      const entry = this.entry(item);
      if (!entry) return { status: 'error', code: 'invalid' };
      // keyring documents false as definite absence; failed deletions reject.
      return { status: (await entry.deleteCredential()) ? 'confirmed' : 'missing' };
    } catch (error) {
      return deleteOutcome(classifyProviderError(error));
    }
  }
}
/** Test teardown only: deletes every item in a dev.ssterm.test.<uuid> namespace and returns how many remain. */
export async function clearTestNamespace(namespace: string): Promise<number> {
  if (!testNamespace.test(namespace)) throw new Error('Only test namespaces can be cleared');
  for (const { account } of await findCredentialsAsync(namespace)) await new AsyncEntry(namespace, account).deleteCredential();
  return (await findCredentialsAsync(namespace)).length;
}
