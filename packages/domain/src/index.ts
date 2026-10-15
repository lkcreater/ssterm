/** Metadata only. Credentials and protected content have no writable interface here. */
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
export interface Host extends Entity {
  label: string;
  address: string;
  groupId: Id | null;
  environment: 'DEV' | 'STAGING' | 'PROD' | null;
  port: PortOverride;
  auth: AuthOverride;
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
export interface KnownHost extends Entity {
  endpointHost: string;
  endpointPort: number;
  algorithm: string;
  publicKey: string;
  fingerprint: string;
  firstAcceptedAt: string;
  lastVerifiedAt: string;
}
export interface TunnelRule extends Entity {
  label: string;
  hostId: Id;
  type: 'local';
  bindAddress: '127.0.0.1' | '::1';
  bindPort: number;
  destinationHost: string;
  destinationPort: number;
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
  knownHosts: KnownHost[];
  tunnelRules: TunnelRule[];
  secretOperations: SecretOperation[];
}
type Fields<T> = Omit<T, keyof Entity>;
export type HostInput = Pick<Fields<Host>, 'label' | 'address'> & Partial<Omit<Fields<Host>, 'label' | 'address'>>;
export type GroupInput = Pick<Fields<Group>, 'label'> & Partial<Omit<Fields<Group>, 'label'>>;
/** Saved credentials/key identities are reserved for the verified SST-006 writer. */
export type IdentityInput = {
  label: string;
  username: string;
  method: 'password' | 'keyboard-interactive';
  passwordRef?: null;
  keyId?: null;
};
export type TagInput = {
  label: string;
};
export type TunnelRuleInput = Pick<Fields<TunnelRule>, 'label' | 'hostId' | 'bindPort' | 'destinationHost' | 'destinationPort'> & Partial<Pick<Fields<TunnelRule>, 'type' | 'bindAddress'>>;
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
export type MetadataChange = Crud<'host', HostInput> | Crud<'group', GroupInput> | Crud<'identity', IdentityInput> | Crud<'tag', TagInput> | Crud<'tunnel-rule', TunnelRuleInput> | {
  type: 'set-host-tag';
  hostId: Id;
  tagId: Id;
  present: boolean;
  expectedHostRevision: number;
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
};
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
