/** Metadata and opaque descriptors only. Secret values cross only the main-side SecretProvider seam. */
import type { WorkspaceTemplateConfiguration } from './workspace-templates.ts';
export * from './workspace-templates.ts';
export * from './remote-edit.ts';
export type Id = string;
export type StorageErrorCode = 'invalid-request' | 'conflict' | 'constraint' | 'busy' | 'closed' | 'io' | 'corrupt' | 'foreign-database' | 'unsupported-schema' | 'unsupported-protection' | 'recovery-required' | 'unwritable' | 'migration-failed' | 'unavailable';
export type StoreResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: {
    code: StorageErrorCode;
    message: string;
  };
};
export type PortOverride = {
  mode: 'inherit';
} | {
  mode: 'value';
  port: number;
};
export type AuthOverride = {
  mode: 'inherit';
} | {
  mode: 'clear';
} | {
  mode: 'value';
  identityId: Id;
};
export interface Entity {
  id: Id;
  vaultId: Id;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface LocalVault extends Entity {
  label: string;
  contentKeyRef: Id | null;
  protectionFormat: string | null;
}
export interface Group extends Entity {
  label: string;
  parentId: Id | null;
  port: PortOverride;
  auth: AuthOverride;
}
/** A proxy used to reach a host directly (no proxy credentials are stored). */
export interface HostProxy {
  type: 'http' | 'socks5';
  host: string;
  port: number;
}
export interface Host extends Entity {
  label: string;
  address: string;
  groupId: Id | null;
  environment: 'DEV' | 'STAGING' | 'PROD' | null;
  port: PortOverride;
  auth: AuthOverride;
  /** SST-030: reach this host through another saved host (its own trust and identity); chains give multi-hop. */
  jumpHostId: Id | null;
  /** SST-030: reach this host through a proxy instead (only without a jump host). */
  proxy: HostProxy | null;
}
/** At most this many jump hosts in front of a target (so at most four SSH hops). */
export const MAX_JUMP_HOSTS = 3;
export type HostChainProblem = 'jump-missing' | 'jump-self' | 'jump-cycle' | 'jump-depth' | 'jump-and-proxy' | 'proxy';
/** Checks one host's jump/proxy settings against the catalog: existing, acyclic, bounded, exclusive with a proxy. */
export function hostChainProblem(host: Pick<Host, 'id' | 'jumpHostId' | 'proxy'>, hosts: ReadonlyMap<Id, Pick<Host, 'id' | 'jumpHostId' | 'proxy'>>): HostChainProblem | null {
  // Absent fields (records written before schema 3, test fixtures) mean a direct connection.
  const proxy = host.proxy ?? null;
  const jumpHostId = host.jumpHostId ?? null;
  if (proxy !== null) {
    if (jumpHostId !== null) return 'jump-and-proxy';
    if (!proxy || (proxy.type !== 'http' && proxy.type !== 'socks5') || typeof proxy.host !== 'string' || !proxy.host.length ||
      !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535) return 'proxy';
  }
  if (jumpHostId === null) return null;
  if (jumpHostId === host.id) return 'jump-self';
  const seen = new Set<Id>([host.id]);
  let current = hosts.get(jumpHostId);
  let depth = 0;
  while (current) {
    if (seen.has(current.id)) return 'jump-cycle';
    seen.add(current.id);
    depth += 1;
    if (depth > MAX_JUMP_HOSTS) return 'jump-depth';
    const next = current.jumpHostId ?? null;
    if (next === null) return null;
    current = hosts.get(next);
  }
  return 'jump-missing';
}
export interface Identity extends Entity {
  label: string;
  username: string;
  method: 'password' | 'key' | 'keyboard-interactive';
  passwordRef: Id | null;
  keyId: Id | null;
}
export interface Tag extends Entity {
  label: string;
  normalizedName: string;
}
export interface HostTag {
  vaultId: Id;
  hostId: Id;
  tagId: Id;
}
export interface SnippetTag {
  vaultId: Id;
  snippetId: Id;
  tagId: Id;
}
export interface KeyMetadata extends Entity {
  label: string;
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  privateKeyRef: Id;
  passphraseRef: Id | null;
}
export type SecretKind = 'password' | 'private-key' | 'passphrase' | 'content-key';
export interface SecretRef extends Entity {
  kind: SecretKind;
  operationId: Id;
}
export interface Snippet extends Entity {
  label: string;
  bodyEnvelope: Uint8Array;
  envelopeVersion: number;
  keyRef: Id;
  protectionFormat: string;
}
export interface WorkspaceTemplate extends Entity {
  label: string;
  configuration: WorkspaceTemplateConfiguration;
}
export interface KnownHost extends Entity {
  endpointHost: string;
  endpointPort: number;
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  firstAcceptedAt: string;
  lastVerifiedAt: string;
}
/**
 * `local`: listen on this Mac, the server opens the destination. `remote`: the server listens (port 0 = the server
 * assigns one) and this Mac opens the destination. `dynamic`: a SOCKS5 proxy on this Mac; the server opens each target.
 */
export type TunnelType = 'local' | 'remote' | 'dynamic';
export type TunnelBindAddress = '127.0.0.1' | '::1' | '0.0.0.0' | '::';
export interface TunnelRule extends Entity {
  label: string;
  hostId: Id;
  type: TunnelType;
  bindAddress: TunnelBindAddress;
  bindPort: number;
  /** Null only for `dynamic`. */
  destinationHost: string | null;
  destinationPort: number | null;
}
/** The per-type shape every stored rule must have; null when valid. */
export function tunnelRuleProblem(rule: Pick<TunnelRule, 'type' | 'bindAddress' | 'bindPort' | 'destinationHost' | 'destinationPort'>):
  'bind-address' | 'bind-port' | 'destination' | null {
  const loopback = rule.bindAddress === '127.0.0.1' || rule.bindAddress === '::1';
  // Only a remote (server-side) listener may be public, and only there may the port be assigned (0).
  if (rule.type !== 'remote' && !loopback) return 'bind-address';
  if (!Number.isInteger(rule.bindPort) || rule.bindPort < (rule.type === 'remote' ? 0 : 1) || rule.bindPort > 65535) return 'bind-port';
  if (rule.type === 'dynamic') return rule.destinationHost === null && rule.destinationPort === null ? null : 'destination';
  return typeof rule.destinationHost === 'string' && rule.destinationHost.length > 0 && Number.isInteger(rule.destinationPort) &&
    rule.destinationPort! >= 1 && rule.destinationPort! <= 65535 ? null : 'destination';
}
export interface AppSettings extends Entity {
  theme: 'dark';
  uiFont: 'Inter';
  uiFontSize: number;
  terminalFont: 'JetBrains Mono';
  terminalFontSize: number;
  terminalScrollback: number;
  terminalPalette: 'signal-blue-dark';
  terminalCursor: 'block' | 'bar' | 'underline';
  terminalCursorBlink: boolean;
  reducedMotion: 'system' | 'on' | 'off';
}
export interface SecretOperation {
  operationId: Id;
  vaultId: Id;
  action: 'create' | 'replace' | 'delete';
  state: 'staged' | 'reconcile' | 'cleanup' | 'complete' | 'needs-input';
  intendedRef: Id;
  kind: SecretKind;
  oldRef: Id | null;
  ownerType: 'vault' | 'identity' | 'key' | 'snippet';
  ownerId: Id;
  expectedRevision: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface MetadataSnapshot {
  schemaVersion: number;
  catalogRevision: number;
  vault: LocalVault;
  settings: AppSettings;
  hosts: Host[];
  groups: Group[];
  identities: Identity[];
  tags: Tag[];
  hostTags: HostTag[];
  snippetTags: SnippetTag[];
  keys: KeyMetadata[];
  secretRefs: SecretRef[];
  snippets: Snippet[];
  workspaceTemplates: WorkspaceTemplate[];
  knownHosts: KnownHost[];
  tunnelRules: TunnelRule[];
  secretOperations: SecretOperation[];
}
type Fields<T> = Omit<T, keyof Entity>;
export type HostInput = Pick<Fields<Host>, 'label' | 'address'> & Partial<Omit<Fields<Host>, 'label' | 'address'>>;
export type GroupInput = Pick<Fields<Group>, 'label'> & Partial<Omit<Fields<Group>, 'label'>>;
export type IdentityInput = Pick<Fields<Identity>, 'label' | 'username' | 'method'> & Partial<Pick<Fields<Identity>, 'passwordRef' | 'keyId'>>;
/** privateKeyRef changes only through secret publication; passphraseRef may be detached with queued cleanup. */
export type KeyInput = Pick<Fields<KeyMetadata>, 'label' | 'algorithm' | 'publicKey' | 'fingerprint' | 'privateKeyRef'> & Partial<Pick<Fields<KeyMetadata>, 'passphraseRef'>>;
/** Produced by the protection Module; the repository validates structure, never plaintext. */
export type SnippetInput = Fields<Snippet>;
export type SecretOwnerType = 'vault' | 'identity' | 'key';
export type SecretOperationState = SecretOperation['state'];
export type TagInput = {
  label: string;
};
export type TunnelRuleInput = Pick<Fields<TunnelRule>, 'label' | 'hostId' | 'bindPort'> & Partial<Pick<Fields<TunnelRule>, 'type' | 'bindAddress' | 'destinationHost' | 'destinationPort'>>;
type Crud<K extends string, T> = {
  type: `create-${K}`;
  id: Id;
  data: T;
} | {
  type: `update-${K}`;
  id: Id;
  expectedRevision: number;
  data: Partial<T>;
} | {
  type: `delete-${K}`;
  id: Id;
  expectedRevision: number;
};
export type MetadataChange = Crud<'workspace-template', Fields<WorkspaceTemplate>> | KnownHostChange | Crud<'host', HostInput> | Crud<'group', GroupInput> | Crud<'identity', IdentityInput> | Crud<'tag', TagInput> | Crud<'tunnel-rule', TunnelRuleInput> | {
  type: 'set-host-tag';
  hostId: Id;
  tagId: Id;
  present: boolean;
  expectedHostRevision: number;
} | {
  type: 'set-snippet-tag';
  snippetId: Id;
  tagId: Id;
  present: boolean;
  expectedSnippetRevision: number;
} | {
  type: 'update-settings';
  expectedRevision: number;
  data: Partial<Fields<AppSettings>>;
} | {
  type: 'update-vault';
  expectedRevision: number;
  data: {
    label: string;
  };
} | Crud<'key', KeyInput> | Crud<'snippet', SnippetInput> | {
  /** Journals an unpublished intended ref before any OS write. expectedRevision null means the owner is created by the publishing batch. */
  type: 'stage-secret';
  operationId: Id;
  action: 'create' | 'replace';
  kind: SecretKind;
  intendedRef: Id;
  ownerType: SecretOwnerType;
  ownerId: Id;
  expectedRevision: number | null;
  oldRef: Id | null;
} | {
  type: 'transition-secret';
  operationId: Id;
  from: SecretOperationState;
  to: 'staged' | 'reconcile' | 'needs-input' | 'cleanup' | 'complete';
} | {
  /** Inserts the descriptor after a confirmed OS write; replacement also queues old-ref cleanup under cleanupOperationId. */
  type: 'publish-secret';
  operationId: Id;
  cleanupOperationId?: Id;
} | {
  /** Journals OS deletion of a published ref the same batch leaves unreferenced. */
  type: 'queue-secret-cleanup';
  operationId: Id;
  ref: Id;
} | {
  /** Completes cleanup after confirmed OS absence and removes its descriptor. */
  type: 'retire-secret';
  operationId: Id;
};
export type SecretErrorCode = 'invalid' | 'ambiguous' | 'malformed';
/** Account identity within the provider namespace; kind and vault are part of the stable item identity. */
export interface SecretItem {
  vaultId: Id;
  kind: SecretKind;
  ref: Id;
}
type Failed = {
  status: 'error';
  code: SecretErrorCode;
};
export type SecretRead = {
  status: 'present';
  value: Uint8Array;
} | {
  status: 'missing' | 'locked' | 'denied' | 'unavailable';
} | Failed;
/** A lookup never returns bytes; present means the exact owned item exists. */
export type SecretLookup = {
  status: 'present';
} | {
  status: 'missing' | 'locked' | 'denied' | 'unavailable';
} | Failed;
export type SecretWrite = {
  status: 'confirmed' | 'denied' | 'unavailable' | 'unknown';
} | Failed;
export type SecretDelete = {
  status: 'confirmed' | 'missing' | 'denied' | 'unavailable' | 'unknown';
} | Failed;
/** Main-only OS credential seam. Implementations resolve typed outcomes and never throw or expose raw provider messages. */
export interface SecretProvider {
  read(item: SecretItem): Promise<SecretRead>;
  lookup(item: SecretItem): Promise<SecretLookup>;
  write(item: SecretItem, value: Uint8Array): Promise<SecretWrite>;
  delete(item: SecretItem): Promise<SecretDelete>;
}
/** How the remote side ended one interactive channel. Local close/cancel never produces one. */
export type TerminalEnd =
  | { kind: 'exit'; code: number }
  | { kind: 'signal'; signal: string }
  | { kind: 'eof' };
export type TerminalWrite = 'ok' | 'busy' | 'closed';
/** Main-only byte stream of one session generation. Output stays paused until `open`, then flows within a bounded unacknowledged window. */
export interface TerminalStream {
  /** Binds the single consumer and returns true; later calls bind nothing and return false. Chunks are exact-length owned copies numbered 0, 1, 2, ... without gaps. `output` must not throw. */
  open(output: (chunk: Uint8Array, sequence: number) => void): boolean;
  /** Returns credit for consumed bytes, clamped to bytes delivered. */
  ack(bytes: number): void;
  /** Copies input in call order. All or nothing: `busy` means the backlog bound would be exceeded and nothing was queued. */
  write(bytes: Uint8Array): TerminalWrite;
  /** Remote PTY size; the caller validates integer ranges. */
  resize(columns: number, rows: number): void;
}
/** Lifecycle owner's view. Only the session registry holds this; consumers receive `TerminalStream`. */
export interface TerminalChannel extends TerminalStream {
  dispose(): void;
  readonly drained: Promise<void>;
}
export * from './sftp-types.ts';
/** `refused`: the server would not open the destination (no server text is kept). */
export type TunnelForward =
  | { ok: true; stream: import('node:stream').Duplex }
  | { ok: false; code: 'refused' | 'closed' | 'resource-limit' };
export type RemoteListen = { ok: true; port: number } | { ok: false; code: 'refused' | 'closed' | 'resource-limit' };
/** Main-only forwarding capability (local, remote and SOCKS targets) of one tunnel session generation. Never throws. */
export interface TunnelSession {
  /** Opens one `direct-tcpip` channel; the destination is resolved by the SSH server. */
  forward(origin: { address: string; port: number }, destination: { host: string; port: number }): Promise<TunnelForward>;
  /**
   * Asks the server to listen (`tcpip-forward`); port 0 lets it assign one. Each accepted connection arrives as a
   * stream; the listener ends with the session. `refused` carries no server text.
   */
  listen(address: string, port: number, connection: (stream: import('node:stream').Duplex, origin: { address: string; port: number }) => void): Promise<RemoteListen>;
}
/** Lifecycle owner's view. Only the session registry holds this; consumers receive `TunnelSession`. */
export interface TunnelChannel extends TunnelSession {
  /** Destroys every forwarded stream and refuses further opens. Idempotent. */
  dispose(): void;
  readonly drained: Promise<void>;
}
export interface BackupManifest {
  format: 'ssterm-metadata-backup-v1';
  schemaVersion: number;
  catalogRevision: number;
  vaultId: Id;
  protectionFormats: string[];
  sha256: string;
  createdAt: string;
  includesOsSecrets: false;
}
export interface MetadataRepository {
  snapshot(): StoreResult<MetadataSnapshot>;
  commit(request: {
    expectedCatalogRevision: number;
    changes: MetadataChange[];
  }): StoreResult<MetadataSnapshot>;
  backup(request: {
    destination: string;
  }): Promise<StoreResult<BackupManifest>>;
  close(): void;
}
export { normalizeEndpoint, normalizeLabel, normalizeTag } from './normalize.ts';

export { resolveHostConfig, resolveHostConfigs, resolveGroupDefaults, queryCatalogHosts, catalogGroupTree, type GroupDefaults, type ConfigSource, type ResolvedHostConfig, type CatalogHostQuery, type CatalogHostView, type CatalogGroupNode } from './catalog.ts';

export { HOST_KEY_ALGORITHMS, type HostKeyAlgorithm, type HostKeyIdentity } from './host-key.ts';
/** Main-only finite trust transitions; endpoint identity cannot be edited. */
export type KnownHostChange = {
  type: 'accept-known-host'; id: Id;
  data: { endpointHost: string; endpointPort: number; algorithm: string; publicKey: string; fingerprint: string; acceptedAt: string };
} | { type: 'verify-known-host'; id: Id; expectedRevision: number; verifiedAt: string }
  | { type: 'replace-known-host'; id: Id; expectedRevision: number; data: { algorithm: string; publicKey: string; fingerprint: string; acceptedAt: string } }
  | { type: 'revoke-known-host'; id: Id; expectedRevision: number };
