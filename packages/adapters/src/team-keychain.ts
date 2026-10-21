/** Team-only opaque accounts; never accepts personal sync or local-content references. */
import { AsyncEntry } from '@napi-rs/keyring';
import { classifyProviderError, PRODUCTION_SECRET_NAMESPACE } from './keychain.ts';
import type { SyncKeyRead, SyncKeyStore } from './sync-keychain.ts';
export type TeamKeyRead = SyncKeyRead;
export interface TeamKeyStore extends SyncKeyStore {}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const accountPattern = new RegExp(`^team/v1/${uuid}/${uuid}/${uuid}/${uuid}/(owner-signing|device-signing|device-wrapping|metadata-epoch|credential-epoch|transport-token|invitation-token|checkpoint)/${uuid}$`);
export class KeychainTeamKeyStore implements TeamKeyStore {
  constructor(private readonly namespace: string) {
    if (namespace !== PRODUCTION_SECRET_NAMESPACE && !/^dev\.ssterm\.test\.[0-9a-f-]{36}$/.test(namespace)) throw new Error('Unsupported secret namespace.');
  }
  async read(account: string): Promise<TeamKeyRead> {
    if (!accountPattern.test(account)) return { status: 'unavailable' };
    try { const raw = await new AsyncEntry(this.namespace, account).getSecret(); if (!raw) return { status: 'missing' }; const value = Buffer.from(raw); raw.fill(0); return { status: 'present', value }; }
    catch (error) { return { status: classifyProviderError(error) === 'missing' ? 'missing' : 'unavailable' }; }
  }
  async write(account: string, value: Uint8Array): Promise<'confirmed' | 'unknown'> {
    if (!accountPattern.test(account) || !(value instanceof Uint8Array) || value.length > 8192) return 'unknown';
    try { await new AsyncEntry(this.namespace, account).setSecret(value); return 'confirmed'; } catch { return 'unknown'; }
  }
  async delete(account: string): Promise<'confirmed' | 'unknown'> {
    if (!accountPattern.test(account)) return 'unknown';
    try { await new AsyncEntry(this.namespace, account).deleteCredential(); return 'confirmed'; }
    catch (error) { return classifyProviderError(error) === 'missing' ? 'confirmed' : 'unknown'; }
  }
}
