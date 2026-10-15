import { normalizeEndpoint, normalizeLabel, normalizeTag, type MetadataSnapshot, type MetadataChange, type Entity } from '@ssterm/domain';
import { fail } from './errors.ts';
export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function keys(value: unknown, allowed: string[], required: string[] = []): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('invalid-request');
}
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export function id(value: unknown): asserts value is string {
  if (!validId(value)) fail('invalid-request');
}
export function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || value as number < min || value as number > max) fail('invalid-request');
}
function oneOf(value: unknown, values: unknown[]): void {
  if (!values.includes(value)) fail('invalid-request');
}
const fields = {
  host: ['label', 'address', 'groupId', 'environment', 'port', 'auth'],
  group: ['label', 'parentId', 'port', 'auth'],
  identity: ['label', 'username', 'method', 'passwordRef', 'keyId'],
  tag: ['label'],
  'tunnel-rule': ['label', 'hostId', 'type', 'bindAddress', 'bindPort', 'destinationHost', 'destinationPort'],
  settings: ['theme', 'uiFont', 'uiFontSize', 'terminalFont', 'terminalFontSize', 'terminalScrollback', 'terminalPalette', 'terminalCursor', 'terminalCursorBlink', 'reducedMotion'],
  vault: ['label']
};
const required = {
  host: ['label', 'address'],
  group: ['label'],
  identity: ['label', 'username', 'method'],
  tag: ['label'],
  'tunnel-rule': ['label', 'hostId', 'bindPort', 'destinationHost', 'destinationPort']
};
const defaults = {
  host: {
    groupId: null,
    environment: null,
    port: {
      mode: 'inherit'
    },
    auth: {
      mode: 'inherit'
    }
  },
  group: {
    parentId: null,
    port: {
      mode: 'inherit'
    },
    auth: {
      mode: 'inherit'
    }
  },
  identity: {
    passwordRef: null,
    keyId: null
  },
  tag: {},
  'tunnel-rule': {
    type: 'local',
    bindAddress: '127.0.0.1'
  }
};
const collections = {
  host: 'hosts',
  group: 'groups',
  identity: 'identities',
  tag: 'tags',
  'tunnel-rule': 'tunnelRules'
} as const;
type Kind = keyof typeof collections;
export const mutableCollections = Object.values(collections);
function normalizeData(kind: keyof typeof fields, data: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  keys(data, fields[kind], creating && kind in required ? required[kind as Kind] : []);
  const result = {
    ...data
  };
  for (const [key, value] of Object.entries(result)) {
    switch (key) {
      case 'label':
        try {
          result[key] = normalizeLabel(value as string);
        } catch {
          fail('invalid-request');
        }
        break;
      case 'address':
      case 'destinationHost':
        try {
          result[key] = normalizeEndpoint(value as string);
        } catch {
          fail('invalid-request');
        }
        break;
      case 'parentId':
      case 'groupId':
        if (value !== null) id(value);
        break;
      case 'hostId':
        id(value);
        break;
      case 'passwordRef':
      case 'keyId':
        if (value !== null) fail('unavailable');
        break;
      case 'username':
        if (typeof value !== 'string' || !value.length || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-request');
        break;
      case 'method':
        if (value === 'key') fail('unavailable');
        oneOf(value, ['password', 'keyboard-interactive']);
        break;
      case 'environment':
        oneOf(value, [null, 'DEV', 'STAGING', 'PROD']);
        break;
      case 'port':
        keys(value, ['mode', 'port'], ['mode']);
        if (value.mode === 'inherit') {
          keys(value, ['mode']);
        } else if (value.mode === 'value') {
          keys(value, ['mode', 'port'], ['port']);
          integer(value.port, 1, 65535);
        } else fail('invalid-request');
        break;
      case 'auth':
        keys(value, ['mode', 'identityId'], ['mode']);
        if (value.mode === 'inherit' || value.mode === 'clear') keys(value, ['mode']);else if (value.mode === 'value') {
          keys(value, ['mode', 'identityId'], ['identityId']);
          id(value.identityId);
        } else fail('invalid-request');
        break;
      case 'bindPort':
      case 'destinationPort':
        integer(value, 1, 65535);
        break;
      case 'type':
        oneOf(value, ['local']);
        break;
      case 'bindAddress':
        oneOf(value, ['127.0.0.1', '::1']);
        break;
      case 'theme':
        oneOf(value, ['dark']);
        break;
      case 'uiFont':
        oneOf(value, ['Inter']);
        break;
      case 'uiFontSize':
        integer(value, 11, 20);
        break;
      case 'terminalFont':
        oneOf(value, ['JetBrains Mono']);
        break;
      case 'terminalFontSize':
        integer(value, 10, 32);
        break;
      case 'terminalScrollback':
        integer(value, 100, 100000);
        break;
      case 'terminalPalette':
        oneOf(value, ['signal-blue-dark']);
        break;
      case 'terminalCursor':
        oneOf(value, ['block', 'bar', 'underline']);
        break;
      case 'terminalCursorBlink':
        if (typeof value !== 'boolean') fail('invalid-request');
        break;
      case 'reducedMotion':
        oneOf(value, ['system', 'on', 'off']);
        break;
    }
  }
  return result;
}
/** Revision expectations always refer to the initial snapshot, even for repeated owner edits. */
export function applyChanges(initial: MetadataSnapshot, changes: MetadataChange[]): MetadataSnapshot {
  const next = structuredClone(initial);
  const now = new Date().toISOString();
  const touched = new Set<string>();
  const initialRecords = new Map<string, Entity>();
  for (const collection of mutableCollections) for (const row of initial[collection]) initialRecords.set(row.id, row);
  initialRecords.set(initial.settings.id, initial.settings);
  initialRecords.set(initial.vault.id, initial.vault);
  const usedIds = new Set<string>();
  for (const row of [initial.vault, initial.settings, ...initial.hosts, ...initial.groups, ...initial.identities, ...initial.tags, ...initial.keys, ...initial.secretRefs, ...initial.snippets, ...initial.knownHosts, ...initial.tunnelRules]) usedIds.add(row.id);
  function touch(row: Entity, expected: unknown) {
    integer(expected);
    const before = initialRecords.get(row.id);
    if (!before) {
      if (row.revision !== 1 || expected !== 1) fail('conflict');
      return;
    }
    if (before.revision !== expected) fail('conflict');
    touched.add(row.id);
  }
  const ordered: unknown[] = [...changes.filter(c => c?.type !== 'set-host-tag'), ...changes.filter(c => c?.type === 'set-host-tag')];
  for (const raw of ordered) {
    if (!isObject(raw) || typeof raw.type !== 'string') fail('invalid-request');
    if (/(?:snippet|secret|key|known-host)/u.test(raw.type)) fail('unavailable');
    if (raw.type === 'set-host-tag') {
      keys(raw, ['type', 'hostId', 'tagId', 'present', 'expectedHostRevision'], ['hostId', 'tagId', 'present', 'expectedHostRevision']);
      id(raw.hostId);
      id(raw.tagId);
      if (typeof raw.present !== 'boolean') fail('invalid-request');
      const host = next.hosts.find(row => row.id === raw.hostId) ?? initial.hosts.find(row => row.id === raw.hostId);
      if (!host) fail('constraint');
      touch(host, raw.expectedHostRevision);
      const index = next.hostTags.findIndex(row => row.hostId === raw.hostId && row.tagId === raw.tagId);
      if (raw.present && index === -1) next.hostTags.push({
        vaultId: next.vault.id,
        hostId: raw.hostId,
        tagId: raw.tagId
      });
      if (!raw.present && index !== -1) next.hostTags.splice(index, 1);
      continue;
    }
    if (raw.type === 'update-settings' || raw.type === 'update-vault') {
      keys(raw, ['type', 'expectedRevision', 'data'], ['expectedRevision', 'data']);
      const kind = raw.type === 'update-settings' ? 'settings' : 'vault';
      const row = next[kind];
      touch(row, raw.expectedRevision);
      Object.assign(row, normalizeData(kind, raw.data as Record<string, unknown>, false));
      continue;
    }
    const match = /^(create|update|delete)-(host|group|identity|tag|tunnel-rule)$/u.exec(raw.type);
    if (!match) fail('invalid-request');
    const action = match[1];
    const kind = match[2] as Kind;
    const collection = next[collections[kind]] as Entity[];
    keys(raw, action === 'create' ? ['type', 'id', 'data'] : action === 'update' ? ['type', 'id', 'expectedRevision', 'data'] : ['type', 'id', 'expectedRevision'], action === 'create' ? ['id', 'data'] : action === 'update' ? ['id', 'expectedRevision', 'data'] : ['id', 'expectedRevision']);
    id(raw.id);
    const index = collection.findIndex(row => row.id === raw.id);
    if (action === 'create') {
      if (usedIds.has(raw.id)) fail('constraint');
      usedIds.add(raw.id);
      const data = normalizeData(kind, raw.data as Record<string, unknown>, true);
      collection.push({
        id: raw.id,
        vaultId: next.vault.id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...structuredClone(defaults[kind]),
        ...data
      } as Entity);
    } else {
      if (index === -1) fail('conflict');
      const row = collection[index]!;
      touch(row, raw.expectedRevision);
      if (action === 'delete') collection.splice(index, 1);else Object.assign(row, normalizeData(kind, raw.data as Record<string, unknown>, false));
    }
  }
  for (const collection of mutableCollections) for (const row of next[collection]) if (touched.has(row.id)) {
    row.revision++;
    row.updatedAt = now;
  }
  for (const row of [next.settings, next.vault]) if (touched.has(row.id)) {
    row.revision++;
    row.updatedAt = now;
  }
  for (const tag of next.tags) tag.normalizedName = normalizeTag(tag.label);
  next.catalogRevision++;
  validateGraph(next);
  return next;
}
/** Full resulting graph, including reserved tables, must remain valid within the transaction. */
export function validateGraph(s: MetadataSnapshot): void {
  const all = [s.vault, s.settings, ...s.hosts, ...s.groups, ...s.identities, ...s.tags, ...s.keys, ...s.secretRefs, ...s.snippets, ...s.knownHosts, ...s.tunnelRules];
  const ids = new Set<string>();
  const utc = (value: string) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
  for (const row of all) {
    if (!validId(row.id) || row.vaultId !== s.vault.id || ids.has(row.id) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !utc(row.createdAt) || !utc(row.updatedAt)) fail('constraint');
    ids.add(row.id);
    if ('label' in row) {
      try {
        if (normalizeLabel(row.label as string) !== row.label) fail('constraint');
      } catch {
        fail('constraint');
      }
    }
  }
  const groups = new Map(s.groups.map(r => [r.id, r]));
  const identities = new Map(s.identities.map(r => [r.id, r]));
  const keysById = new Map(s.keys.map(r => [r.id, r]));
  const secrets = new Map(s.secretRefs.map(r => [r.id, r]));
  const has = (rows: {
    id: string;
  }[], value: string | null) => value === null || rows.some(r => r.id === value);
  const credentialOwners = new Set<string>();
  function ref(value: string | null, kind: string, owned = false) {
    if (value === null) return;
    const secret = secrets.get(value);
    if (!secret || secret.kind !== kind) fail('constraint');
    if (owned) {
      if (credentialOwners.has(value)) fail('constraint');
      credentialOwners.add(value);
    }
  }
  ref(s.vault.contentKeyRef, 'content-key');
  if (s.vault.contentKeyRef === null !== (s.vault.protectionFormat === null)) fail('constraint');
  for (const row of [...s.groups, ...s.hosts]) {
    try {
      normalizeLabel(row.label);
    } catch {
      fail('constraint');
    }
    if (row.auth.mode === 'value' && !identities.has(row.auth.identityId)) fail('constraint');
    if (row.port.mode === 'value' && (!Number.isInteger(row.port.port) || row.port.port < 1 || row.port.port > 65535)) fail('constraint');
  }
  for (const row of s.groups) {
    const seen = new Set<string>([row.id]);
    let parent = row.parentId;
    while (parent !== null) {
      if (seen.has(parent) || !groups.has(parent)) fail('constraint');
      seen.add(parent);
      parent = groups.get(parent)!.parentId;
    }
  }
  for (const row of s.hosts) {
    if (!has(s.groups, row.groupId)) fail('constraint');
    try {
      if (normalizeEndpoint(row.address) !== row.address) fail('constraint');
    } catch {
      fail('constraint');
    }
  }
  for (const row of s.identities) {
    if (!row.username.length || /[\u0000-\u001f\u007f]/u.test(row.username)) fail('constraint');
    if (row.method === 'password') {
      if (row.keyId !== null) fail('constraint');
      ref(row.passwordRef, 'password', true);
    } else if (row.method === 'key') {
      if (row.passwordRef !== null || !row.keyId || !keysById.has(row.keyId)) fail('constraint');
    } else if (row.method !== 'keyboard-interactive' || row.passwordRef !== null || row.keyId !== null) fail('constraint');
  }
  for (const row of s.keys) {
    ref(row.privateKeyRef, 'private-key', true);
    ref(row.passphraseRef, 'passphrase', true);
  }
  const names = new Set<string>();
  for (const row of s.tags) {
    if (row.normalizedName !== normalizeTag(row.label) || names.has(row.normalizedName)) fail('constraint');
    names.add(row.normalizedName);
  }
  const memberships = new Set<string>();
  for (const row of s.hostTags) {
    const key = `${row.hostId}/${row.tagId}`;
    if (row.vaultId !== s.vault.id || !has(s.hosts, row.hostId) || !has(s.tags, row.tagId) || memberships.has(key)) fail('constraint');
    memberships.add(key);
  }
  for (const row of s.snippetTags) if (row.vaultId !== s.vault.id || !has(s.snippets, row.snippetId) || !has(s.tags, row.tagId)) fail('constraint');
  for (const row of s.snippets) {
    ref(row.keyRef, 'content-key');
    if (!row.bodyEnvelope.length || row.keyRef !== s.vault.contentKeyRef || row.protectionFormat !== s.vault.protectionFormat) fail('constraint');
  }
  for (const row of s.knownHosts) {
    try {
      if (normalizeEndpoint(row.endpointHost) !== row.endpointHost || !utc(row.firstAcceptedAt) || !utc(row.lastVerifiedAt)) fail('constraint');
    } catch {
      fail('constraint');
    }
  }
  for (const row of s.secretOperations) if (row.vaultId !== s.vault.id || !validId(row.operationId) || !validId(row.intendedRef) || !validId(row.ownerId) || !utc(row.createdAt) || !utc(row.updatedAt)) fail('constraint');
  for (const row of s.tunnelRules) {
    if (!has(s.hosts, row.hostId)) fail('constraint');
    try {
      if (normalizeEndpoint(row.destinationHost) !== row.destinationHost) fail('constraint');
    } catch {
      fail('constraint');
    }
  }
}
