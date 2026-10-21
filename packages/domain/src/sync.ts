/** Public bounded transport DTOs. This module has no Node, key or catalog dependencies. */
export interface SyncScope {
  deploymentId: string;
  accountId: string;
  vaultId: string;
}
export interface SyncInfo extends SyncScope {
  protocol: 'ssterm-sync-v1';
  suite: 'rsa3072-oaep-sha256_ed25519_hkdf-sha256_aes256gcm';
}
export interface SyncEndpoint {
  url: string;
  scope: SyncScope;
}
export interface SyncControlPublication {
  controlWire: string;
  rosterWire: string;
  wraps: string[];
  recoveryDescriptorWire: string | null;
  recoveryWire: string | null;
  enrollmentProofs: string[];
}
export interface SyncOperationPublication {
  wire: string;
  parents: string[];
}
export interface SyncOperationEntry extends SyncOperationPublication {
  sequence: number;
}
export interface SyncChallenge {
  nonce: string;
  expiresAt: number;
}
export interface SyncRequestAuth {
  deviceId: string;
  nonce: string;
  signature: string;
}
export interface SyncExchangeRequest {
  afterSequence: number;
  operations: SyncOperationPublication[];
}
export interface SyncExchangeResponse {
  operations: SyncOperationEntry[];
  nextSequence: number;
  hasMore: boolean;
}
export interface SyncControlsResponse {
  controls: SyncControlPublication[];
  nextGeneration: number;
  hasMore: boolean;
}
export interface SyncPublicationReceipt {
  controlHash: string;
  generation: number;
}
export interface SyncRecoveryResponse {
  publication: SyncControlPublication | null;
}
export type SyncTransportCode =
  | 'invalid'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'stale-control'
  | 'rate-limited'
  | 'too-large'
  | 'unsupported'
  | 'unavailable'
  | 'cancelled';
export type SyncTransportResult<T> = { ok: true; value: T } | { ok: false; code: SyncTransportCode };
export const SYNC_HTTP_MAX = 12 * 1024 * 1024;
export const SYNC_SUITE = 'rsa3072-oaep-sha256_ed25519_hkdf-sha256_aes256gcm' as const;
export const SYNC_ZERO = '0'.repeat(64);
export const syncUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const syncHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const syncInteger = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export function syncObject(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k))
  );
}
export function syncBytes(v: unknown, max: number, exact?: number): v is string {
  if (
    typeof v !== 'string' ||
    v.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]*$/.test(v) ||
    v.length % 4 === 1
  )
    return false;
  const length = Math.floor((v.length * 3) / 4);
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(v.at(-1) ?? 'A');
  return (
    length <= max &&
    (exact === undefined || length === exact) &&
    (v.length % 4 !== 2 || last % 16 === 0) &&
    (v.length % 4 !== 3 || last % 4 === 0)
  );
}
export function isSyncScope(v: unknown): v is SyncScope {
  return (
    syncObject(v, ['deploymentId', 'accountId', 'vaultId']) &&
    syncUuid(v.deploymentId) &&
    syncUuid(v.accountId) &&
    syncUuid(v.vaultId)
  );
}
export function isSyncInfo(v: unknown): v is SyncInfo {
  return (
    syncObject(v, ['deploymentId', 'accountId', 'vaultId', 'protocol', 'suite']) &&
    syncUuid(v.deploymentId) &&
    syncUuid(v.accountId) &&
    syncUuid(v.vaultId) &&
    v.protocol === 'ssterm-sync-v1' &&
    v.suite === SYNC_SUITE
  );
}
export function isSyncControlPublication(v: unknown): v is SyncControlPublication {
  return (
    syncObject(v, [
      'controlWire',
      'rosterWire',
      'wraps',
      'recoveryDescriptorWire',
      'recoveryWire',
      'enrollmentProofs',
    ]) &&
    syncBytes(v.controlWire, 2048) &&
    syncBytes(v.rosterWire, 1048576) &&
    Array.isArray(v.wraps) &&
    v.wraps.length <= 256 &&
    v.wraps.every((w) => syncBytes(w, 2048)) &&
    (v.recoveryDescriptorWire === null || syncBytes(v.recoveryDescriptorWire, 1024)) &&
    (v.recoveryWire === null || syncBytes(v.recoveryWire, 8 * 1048576 + 2048)) &&
    Array.isArray(v.enrollmentProofs) &&
    v.enrollmentProofs.length <= 256 &&
    v.enrollmentProofs.every((p) => syncBytes(p, 4096))
  );
}
export function isSyncOperationPublication(v: unknown, entry = false): v is SyncOperationPublication {
  return (
    syncObject(v, entry ? ['wire', 'parents', 'sequence'] : ['wire', 'parents']) &&
    syncBytes(v.wire, 1048576 + 2048) &&
    Array.isArray(v.parents) &&
    v.parents.length <= 64 &&
    v.parents.every((p, i, a) => syncHash(p) && (i === 0 || a[i - 1] < p)) &&
    (!entry || syncInteger(v.sequence, 1))
  );
}
export function isSyncExchangeRequest(v: unknown): v is SyncExchangeRequest {
  return (
    syncObject(v, ['afterSequence', 'operations']) &&
    syncInteger(v.afterSequence) &&
    Array.isArray(v.operations) &&
    v.operations.length <= 8 &&
    v.operations.every((o) => isSyncOperationPublication(o))
  );
}
export function isSyncExchangeResponse(v: unknown): v is SyncExchangeResponse {
  return (
    syncObject(v, ['operations', 'nextSequence', 'hasMore']) &&
    syncInteger(v.nextSequence) &&
    typeof v.hasMore === 'boolean' &&
    Array.isArray(v.operations) &&
    v.operations.length <= 8 &&
    v.operations.every((o) => isSyncOperationPublication(o, true)) &&
    (!v.hasMore || v.operations.length > 0) &&
    (v.operations as SyncOperationEntry[]).every((o, i, a) => i === 0 || a[i - 1].sequence < o.sequence) &&
    (v.operations.length === 0 || (v.operations as SyncOperationEntry[]).at(-1)!.sequence === v.nextSequence)
  );
}
export function isSyncControlsResponse(v: unknown): v is SyncControlsResponse {
  return (
    syncObject(v, ['controls', 'nextGeneration', 'hasMore']) &&
    syncInteger(v.nextGeneration, 0, 0xffffffff) &&
    typeof v.hasMore === 'boolean' &&
    Array.isArray(v.controls) &&
    v.controls.length <= 8 &&
    v.controls.every(isSyncControlPublication) &&
    (!v.hasMore || v.controls.length > 0)
  );
}
export const isSyncReceipt = (v: unknown): v is SyncPublicationReceipt =>
  syncObject(v, ['controlHash', 'generation']) &&
  syncHash(v.controlHash) &&
  syncInteger(v.generation, 1, 0xffffffff);
export const isSyncChallenge = (v: unknown): v is SyncChallenge =>
  syncObject(v, ['nonce', 'expiresAt']) && syncHash(v.nonce) && syncInteger(v.expiresAt, 1, 4102444800);
export const isSyncWraps = (v: unknown): v is { wraps: string[] } =>
  syncObject(v, ['wraps']) &&
  Array.isArray(v.wraps) &&
  v.wraps.length <= 4096 &&
  v.wraps.every((w) => syncBytes(w, 2048));
export const isSyncRecovery = (v: unknown): v is SyncRecoveryResponse =>
  syncObject(v, ['publication']) && (v.publication === null || isSyncControlPublication(v.publication));
export const syncTransportCodes: readonly SyncTransportCode[] = [
  'invalid',
  'unauthorized',
  'forbidden',
  'conflict',
  'stale-control',
  'rate-limited',
  'too-large',
  'unsupported',
  'unavailable',
  'cancelled',
];
