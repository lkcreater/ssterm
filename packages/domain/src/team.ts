/** Strict public team protocol DTOs. No Node or privileged dependencies. */
import {
  isSyncControlPublication,
  isSyncOperationPublication,
  syncObject,
  syncUuid,
  syncHash,
  syncBytes,
  syncInteger,
  SYNC_SUITE,
  type SyncScope,
  type SyncControlPublication,
  type SyncOperationPublication,
} from './sync.ts';
export type TeamRole = 'Owner' | 'Editor' | 'Connector' | 'Viewer';
export interface TeamScope {
  deploymentId: string;
  accountId: string;
  teamId: string;
  metadataVaultId: string;
  credentialVaultId: string;
}
export interface TeamPrincipal {
  principalId: string;
  role: TeamRole;
  status: 'active' | 'revoked';
  tokenHash: string;
}
export interface TeamDevice {
  deviceId: string;
  principalId: string;
}
export interface TeamPolicy {
  format: 'ssterm-team-policy-v1';
  scope: TeamScope;
  generation: number;
  previousHash: string;
  previousOwnerFingerprint: string;
  ownerSpki: string;
  ownerPrincipalId: string;
  ownerDeviceId: string;
  metadataControlHash: string;
  credentialControlHash: string;
  principals: TeamPrincipal[];
  devices: TeamDevice[];
}
export interface TeamSignedPolicy {
  body: TeamPolicy;
  oldOwnerSignature: string;
  newOwnerSignature: string;
}
export interface TeamDomainPublication {
  control: SyncControlPublication;
  snapshot: SyncOperationPublication;
}
export interface TeamRecoveryKit {
  format: 'ssterm-team-recovery-v1';
  basePolicy: TeamSignedPolicy;
  metadataRecoveryWire: string;
  credentialRecoveryWire: string;
}
export interface TeamAtomicPublication {
  policy: TeamSignedPolicy;
  metadata: TeamDomainPublication;
  credentials: TeamDomainPublication;
  recovery: TeamRecoveryKit | null;
}
export interface TeamPublishRequest {
  expectedPolicyHash: string | null;
  expectedMetadataHash: string | null;
  expectedCredentialHash: string | null;
  publication: TeamAtomicPublication;
}
export interface TeamReceipt {
  policyHash: string;
  generation: number;
  metadataHash: string;
  credentialHash: string;
}
export interface TeamWriteRequest {
  policyHash: string;
  expectedHead: string;
  operation: SyncOperationPublication;
}
export interface TeamWriteReceipt {
  policyHash: string;
  head: string;
}
export interface TeamPolicyCheckpoint {
  policy: TeamSignedPolicy;
  metadataControl: SyncControlPublication;
  credentialControl: SyncControlPublication;
}
export interface TeamPoliciesResponse {
  checkpoints: TeamPolicyCheckpoint[];
  nextGeneration: number;
  hasMore: boolean;
}
export interface TeamStateRequest {
  knownPolicyHash: string | null;
}
export interface TeamState {
  checkpoint: TeamPolicyCheckpoint;
  metadataHead: string;
  credentialHead: string;
  metadataSnapshot: SyncOperationPublication;
  credentialSnapshot: SyncOperationPublication | null;
  metadataWraps: string[];
  credentialWraps: string[];
}
export interface TeamRecoveryResponse {
  kit: TeamRecoveryKit | null;
  checkpoint: TeamPolicyCheckpoint;
  metadataHead: string;
  credentialHead: string;
  metadataSnapshot: SyncOperationPublication;
  credentialSnapshot: SyncOperationPublication;
}
export interface TeamHost {
  recordId: string;
  label: string;
  address: string;
  port: number;
  username: string;
  environment: 'DEV' | 'STAGING' | 'PROD' | null;
}
export interface TeamMetadataSnapshot {
  format: 'ssterm-team-metadata-v1';
  hosts: TeamHost[];
  memberNames: { principalId: string; label: string }[];
}
export interface TeamPassword {
  credentialId: string;
  recordId: string;
  targetDigest: string;
  password: string;
}
export interface TeamCredentialSnapshot {
  format: 'ssterm-team-credentials-v1';
  credentials: TeamPassword[];
}
export interface TeamConnectRequest {
  requestId: string;
  policyHash: string;
  metadataHash: string;
  credentialHash: string;
  recordId: string;
}
export interface TeamConnectGrant extends TeamConnectRequest {
  expiresAt: number;
}
export interface TeamClientEvent {
  eventId: string;
  requestId: string;
  policyHash: string;
  recordId: string;
  action: 'connect-requested' | 'connect-ready' | 'connect-ended';
}
export interface TeamAuditEntry {
  sequence: number;
  time: number;
  principalId: string | null;
  deviceId: string | null;
  recordId: string | null;
  policyHash: string | null;
  requestId: string | null;
  action:
    | 'policy-published'
    | 'metadata-written'
    | 'credential-written'
    | 'connect-authorized'
    | 'request-denied'
    | 'client-connect-requested'
    | 'client-connect-ready'
    | 'client-connect-ended';
  outcome: 'accepted' | 'denied';
}
export interface TeamAuditPage {
  entries: TeamAuditEntry[];
  firstAvailableSequence: number;
  nextSequence: number;
  hasMore: boolean;
}

export interface TeamEndpoint {
  url: string;
  scope: TeamScope;
}
export const TEAM_VIRTUAL_HOST_PREFIX = '7ea03700-';
export const isTeamVirtualHostId = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^7ea03700-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export interface TeamInfo {
  protocol: 'ssterm-team-v1';
  scope: TeamScope;
  suite: typeof SYNC_SUITE;
}
export const teamMetadataScope = (s: TeamScope): SyncScope => ({
  deploymentId: s.deploymentId,
  accountId: s.accountId,
  vaultId: s.metadataVaultId,
});
export const teamCredentialScope = (s: TeamScope): SyncScope => ({
  deploymentId: s.deploymentId,
  accountId: s.accountId,
  vaultId: s.credentialVaultId,
});
export const teamRoles: readonly TeamRole[] = [
  'Owner',
  'Editor',
  'Connector',
  'Viewer',
];
export const teamCanConnect = (r: TeamRole): boolean => r !== 'Viewer';
export const teamCanEdit = (r: TeamRole): boolean =>
  r === 'Owner' || r === 'Editor';
export const isTeamRole = (v: unknown): v is TeamRole =>
  teamRoles.includes(v as TeamRole);
export const isTeamScope = (v: unknown): v is TeamScope =>
  syncObject(v, [
    'deploymentId',
    'accountId',
    'teamId',
    'metadataVaultId',
    'credentialVaultId',
  ]) &&
  [
    v.deploymentId,
    v.accountId,
    v.teamId,
    v.metadataVaultId,
    v.credentialVaultId,
  ].every(syncUuid) &&
  new Set([v.teamId, v.metadataVaultId, v.credentialVaultId]).size === 3;
export const isTeamInfo = (v: unknown): v is TeamInfo =>
  syncObject(v, ['protocol', 'scope', 'suite']) &&
  v.protocol === 'ssterm-team-v1' &&
  v.suite === SYNC_SUITE &&
  isTeamScope(v.scope);
export const isTeamPrincipal = (v: unknown): v is TeamPrincipal =>
  syncObject(v, ['principalId', 'role', 'status', 'tokenHash']) &&
  syncUuid(v.principalId) &&
  isTeamRole(v.role) &&
  (v.status === 'active' || v.status === 'revoked') &&
  syncHash(v.tokenHash);
export const isTeamDevice = (v: unknown): v is TeamDevice =>
  syncObject(v, ['deviceId', 'principalId']) &&
  syncUuid(v.deviceId) &&
  syncUuid(v.principalId);
export function isTeamPolicy(v: unknown): v is TeamPolicy {
  if (
    !syncObject(v, [
      'format',
      'scope',
      'generation',
      'previousHash',
      'previousOwnerFingerprint',
      'ownerSpki',
      'ownerPrincipalId',
      'ownerDeviceId',
      'metadataControlHash',
      'credentialControlHash',
      'principals',
      'devices',
    ]) ||
    v.format !== 'ssterm-team-policy-v1' ||
    !isTeamScope(v.scope) ||
    !syncInteger(v.generation, 1, 0xffffffff) ||
    ![
      v.previousHash,
      v.previousOwnerFingerprint,
      v.metadataControlHash,
      v.credentialControlHash,
    ].every(syncHash) ||
    !syncBytes(v.ownerSpki, 44, 44) ||
    !syncUuid(v.ownerPrincipalId) ||
    !syncUuid(v.ownerDeviceId) ||
    !Array.isArray(v.principals) ||
    v.principals.length < 1 ||
    v.principals.length > 32 ||
    !v.principals.every(isTeamPrincipal) ||
    !Array.isArray(v.devices) ||
    v.devices.length < 1 ||
    v.devices.length > 128 ||
    !v.devices.every(isTeamDevice)
  )
    return false;
  const ps = v.principals as TeamPrincipal[],
    ds = v.devices as TeamDevice[];
  if (
    !ps.every((p, i) => i === 0 || ps[i - 1].principalId < p.principalId) ||
    new Set(ps.map((p) => p.tokenHash)).size !== ps.length ||
    !ds.every((d, i) => i === 0 || ds[i - 1].deviceId < d.deviceId)
  )
    return false;
  const owners = ps.filter((p) => p.status === 'active' && p.role === 'Owner');
  return (
    owners.length === 1 &&
    owners[0].principalId === v.ownerPrincipalId &&
    ds.filter((d) => d.principalId === v.ownerPrincipalId).length === 1 &&
    ds.some(
      (d) =>
        d.deviceId === v.ownerDeviceId && d.principalId === v.ownerPrincipalId,
    ) &&
    ds.every((d) =>
      ps.some((p) => p.principalId === d.principalId && p.status === 'active'),
    )
  );
}
export const isTeamSignedPolicy = (v: unknown): v is TeamSignedPolicy =>
  syncObject(v, ['body', 'oldOwnerSignature', 'newOwnerSignature']) &&
  isTeamPolicy(v.body) &&
  syncBytes(v.oldOwnerSignature, 64, 64) &&
  syncBytes(v.newOwnerSignature, 64, 64) &&
  JSON.stringify(v).length <= 128 * 1024;
export const isTeamDomainPublication = (
  v: unknown,
): v is TeamDomainPublication =>
  syncObject(v, ['control', 'snapshot']) &&
  isSyncControlPublication(v.control) &&
  isSyncOperationPublication(v.snapshot);
export const isTeamRecoveryKit = (v: unknown): v is TeamRecoveryKit =>
  syncObject(v, [
    'format',
    'basePolicy',
    'metadataRecoveryWire',
    'credentialRecoveryWire',
  ]) &&
  v.format === 'ssterm-team-recovery-v1' &&
  isTeamSignedPolicy(v.basePolicy) &&
  syncBytes(v.metadataRecoveryWire, 128 * 1024) &&
  syncBytes(v.credentialRecoveryWire, 128 * 1024) &&
  JSON.stringify(v).length <= 512 * 1024;
export const isTeamAtomicPublication = (
  v: unknown,
): v is TeamAtomicPublication =>
  syncObject(v, ['policy', 'metadata', 'credentials', 'recovery']) &&
  isTeamSignedPolicy(v.policy) &&
  isTeamDomainPublication(v.metadata) &&
  isTeamDomainPublication(v.credentials) &&
  (v.recovery === null || isTeamRecoveryKit(v.recovery)) &&
  v.metadata.control.wraps.length + v.credentials.control.wraps.length <= 256;
const nullableHash = (v: unknown) => v === null || syncHash(v);
export const isTeamPublishRequest = (v: unknown): v is TeamPublishRequest =>
  syncObject(v, [
    'expectedPolicyHash',
    'expectedMetadataHash',
    'expectedCredentialHash',
    'publication',
  ]) &&
  nullableHash(v.expectedPolicyHash) &&
  nullableHash(v.expectedMetadataHash) &&
  nullableHash(v.expectedCredentialHash) &&
  isTeamAtomicPublication(v.publication);
export const isTeamReceipt = (v: unknown): v is TeamReceipt =>
  syncObject(v, [
    'policyHash',
    'generation',
    'metadataHash',
    'credentialHash',
  ]) &&
  [v.policyHash, v.metadataHash, v.credentialHash].every(syncHash) &&
  syncInteger(v.generation, 1, 0xffffffff);
export const isTeamWriteRequest = (v: unknown): v is TeamWriteRequest =>
  syncObject(v, ['policyHash', 'expectedHead', 'operation']) &&
  syncHash(v.policyHash) &&
  syncHash(v.expectedHead) &&
  isSyncOperationPublication(v.operation);
export const isTeamWriteReceipt = (v: unknown): v is TeamWriteReceipt =>
  syncObject(v, ['policyHash', 'head']) &&
  syncHash(v.policyHash) &&
  syncHash(v.head);
export const isTeamPolicyCheckpoint = (v: unknown): v is TeamPolicyCheckpoint =>
  syncObject(v, ['policy', 'metadataControl', 'credentialControl']) &&
  isTeamSignedPolicy(v.policy) &&
  isSyncControlPublication(v.metadataControl) &&
  isSyncControlPublication(v.credentialControl);
export const isTeamPoliciesResponse = (v: unknown): v is TeamPoliciesResponse =>
  syncObject(v, ['checkpoints', 'nextGeneration', 'hasMore']) &&
  Array.isArray(v.checkpoints) &&
  v.checkpoints.length <= 8 &&
  v.checkpoints.every(isTeamPolicyCheckpoint) &&
  syncInteger(v.nextGeneration, 0, 0xffffffff) &&
  typeof v.hasMore === 'boolean' &&
  (!v.hasMore || v.checkpoints.length > 0);
export const isTeamStateRequest = (v: unknown): v is TeamStateRequest =>
  syncObject(v, ['knownPolicyHash']) && nullableHash(v.knownPolicyHash);
const wraps = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 256 && v.every((w) => syncBytes(w, 2048));
export const isTeamState = (v: unknown): v is TeamState =>
  syncObject(v, [
    'checkpoint',
    'metadataHead',
    'credentialHead',
    'metadataSnapshot',
    'credentialSnapshot',
    'metadataWraps',
    'credentialWraps',
  ]) &&
  isTeamPolicyCheckpoint(v.checkpoint) &&
  syncHash(v.metadataHead) &&
  syncHash(v.credentialHead) &&
  isSyncOperationPublication(v.metadataSnapshot) &&
  (v.credentialSnapshot === null ||
    isSyncOperationPublication(v.credentialSnapshot)) &&
  wraps(v.metadataWraps) &&
  wraps(v.credentialWraps);
export const isTeamRecoveryResponse = (v: unknown): v is TeamRecoveryResponse =>
  syncObject(v, [
    'kit',
    'checkpoint',
    'metadataHead',
    'credentialHead',
    'metadataSnapshot',
    'credentialSnapshot',
  ]) &&
  (v.kit === null || isTeamRecoveryKit(v.kit)) &&
  isTeamPolicyCheckpoint(v.checkpoint) &&
  syncHash(v.metadataHead) &&
  syncHash(v.credentialHead) &&
  isSyncOperationPublication(v.metadataSnapshot) &&
  isSyncOperationPublication(v.credentialSnapshot);
const safeText = (v: unknown, max: number): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  new TextEncoder().encode(v).length <= max &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(v) &&
  v.trim() === v;
export const isTeamHost = (v: unknown): v is TeamHost =>
  syncObject(v, [
    'recordId',
    'label',
    'address',
    'port',
    'username',
    'environment',
  ]) &&
  syncUuid(v.recordId) &&
  safeText(v.label, 200) &&
  safeText(v.address, 253) &&
  !/[\s/@\\]/u.test(v.address) &&
  syncInteger(v.port, 1, 65535) &&
  safeText(v.username, 128) &&
  !/[\s:@/\\]/u.test(v.username) &&
  [null, 'DEV', 'STAGING', 'PROD'].includes(v.environment as never);
export const isTeamMetadataSnapshot = (v: unknown): v is TeamMetadataSnapshot =>
  syncObject(v, ['format', 'hosts', 'memberNames']) &&
  v.format === 'ssterm-team-metadata-v1' &&
  Array.isArray(v.hosts) &&
  v.hosts.length <= 128 &&
  v.hosts.every(isTeamHost) &&
  v.hosts.every((h, i, a) => i === 0 || a[i - 1].recordId < h.recordId) &&
  Array.isArray(v.memberNames) &&
  v.memberNames.length <= 32 &&
  v.memberNames.every(
    (n, i, a) =>
      syncObject(n, ['principalId', 'label']) &&
      syncUuid(n.principalId) &&
      safeText(n.label, 200) &&
      (i === 0 || a[i - 1].principalId < n.principalId),
  ) &&
  new TextEncoder().encode(JSON.stringify(v)).length <= 1048576;
export const isTeamPassword = (v: unknown): v is TeamPassword =>
  syncObject(v, ['credentialId', 'recordId', 'targetDigest', 'password']) &&
  syncUuid(v.credentialId) &&
  syncUuid(v.recordId) &&
  syncHash(v.targetDigest) &&
  typeof v.password === 'string' &&
  new TextEncoder().encode(v.password).length <= 65536 &&
  !/[\u0000\r\n]/u.test(v.password);
export const isTeamCredentialSnapshot = (
  v: unknown,
): v is TeamCredentialSnapshot =>
  syncObject(v, ['format', 'credentials']) &&
  v.format === 'ssterm-team-credentials-v1' &&
  Array.isArray(v.credentials) &&
  v.credentials.length <= 128 &&
  v.credentials.every(isTeamPassword) &&
  v.credentials.every(
    (c, i, a) => i === 0 || a[i - 1].credentialId < c.credentialId,
  ) &&
  new Set(v.credentials.map((c) => c.recordId)).size === v.credentials.length &&
  new TextEncoder().encode(JSON.stringify(v)).length <= 1048576;
export const isTeamConnectRequest = (v: unknown): v is TeamConnectRequest =>
  syncObject(v, [
    'requestId',
    'policyHash',
    'metadataHash',
    'credentialHash',
    'recordId',
  ]) &&
  syncUuid(v.requestId) &&
  syncUuid(v.recordId) &&
  [v.policyHash, v.metadataHash, v.credentialHash].every(syncHash);
export const isTeamConnectGrant = (v: unknown): v is TeamConnectGrant =>
  syncObject(v, [
    'requestId',
    'policyHash',
    'metadataHash',
    'credentialHash',
    'recordId',
    'expiresAt',
  ]) &&
  isTeamConnectRequest({
    requestId: v.requestId,
    policyHash: v.policyHash,
    metadataHash: v.metadataHash,
    credentialHash: v.credentialHash,
    recordId: v.recordId,
  }) &&
  syncInteger(v.expiresAt, 1, 4102444800);
export const isTeamClientEvent = (v: unknown): v is TeamClientEvent =>
  syncObject(v, ['eventId', 'requestId', 'policyHash', 'recordId', 'action']) &&
  [v.eventId, v.requestId, v.recordId].every(syncUuid) &&
  syncHash(v.policyHash) &&
  ['connect-requested', 'connect-ready', 'connect-ended'].includes(
    v.action as string,
  );
export const isTeamEventsRequest = (
  v: unknown,
): v is { events: TeamClientEvent[] } =>
  syncObject(v, ['events']) &&
  Array.isArray(v.events) &&
  v.events.length <= 16 &&
  v.events.every(isTeamClientEvent) &&
  new Set(v.events.map((e) => e.eventId)).size === v.events.length;
export const isTeamEventsReceipt = (v: unknown): v is { accepted: number } =>
  syncObject(v, ['accepted']) && syncInteger(v.accepted, 0, 16);
export const isTeamAuditEntry = (v: unknown): v is TeamAuditEntry =>
  syncObject(v, [
    'sequence',
    'time',
    'principalId',
    'deviceId',
    'recordId',
    'policyHash',
    'requestId',
    'action',
    'outcome',
  ]) &&
  syncInteger(v.sequence, 1) &&
  syncInteger(v.time, 0) &&
  [v.principalId, v.deviceId, v.recordId, v.requestId].every(
    (x) => x === null || syncUuid(x),
  ) &&
  nullableHash(v.policyHash) &&
  [
    'policy-published',
    'metadata-written',
    'credential-written',
    'connect-authorized',
    'request-denied',
    'client-connect-requested',
    'client-connect-ready',
    'client-connect-ended',
  ].includes(v.action as string) &&
  ['accepted', 'denied'].includes(v.outcome as string);
export const isTeamAuditPage = (v: unknown): v is TeamAuditPage =>
  syncObject(v, [
    'entries',
    'firstAvailableSequence',
    'nextSequence',
    'hasMore',
  ]) &&
  Array.isArray(v.entries) &&
  v.entries.length <= 100 &&
  v.entries.every(isTeamAuditEntry) &&
  syncInteger(v.firstAvailableSequence, 1) &&
  syncInteger(v.nextSequence, 0) &&
  typeof v.hasMore === 'boolean';
