import { normalizeEndpoint, normalizeLabel, normalizeTag, type MetadataSnapshot, type MetadataChange, type Entity, type Id, type SecretKind, type SecretOperation } from '@ssterm/domain';
import { fail } from './errors.ts';
import { validHostKeyIdentity } from './host-key.ts';
import { ENVELOPE_OVERHEAD, ENVELOPE_VERSION, MAX_ENVELOPE, PROTECTION_FORMAT } from './protection.ts';
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
  key: ['label', 'algorithm', 'publicKey', 'fingerprint', 'privateKeyRef', 'passphraseRef'],
  snippet: ['label', 'bodyEnvelope', 'envelopeVersion', 'keyRef', 'protectionFormat'],
  settings: ['theme', 'uiFont', 'uiFontSize', 'terminalFont', 'terminalFontSize', 'terminalScrollback', 'terminalPalette', 'terminalCursor', 'terminalCursorBlink', 'reducedMotion'],
  vault: ['label']
};
const required = {
  host: ['label', 'address'],
  group: ['label'],
  identity: ['label', 'username', 'method'],
  tag: ['label'],
  'tunnel-rule': ['label', 'hostId', 'bindPort', 'destinationHost', 'destinationPort'],
  key: ['label', 'algorithm', 'publicKey', 'fingerprint', 'privateKeyRef'],
  snippet: ['label', 'bodyEnvelope', 'envelopeVersion', 'keyRef', 'protectionFormat']
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
  },
  key: {
    passphraseRef: null
  },
  snippet: {}
};
const collections = {
  host: 'hosts',
  group: 'groups',
  identity: 'identities',
  tag: 'tags',
  'tunnel-rule': 'tunnelRules',
  key: 'keys',
  snippet: 'snippets'
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
      case 'passphraseRef':
        if (value !== null) id(value);
        break;
      case 'privateKeyRef':
      case 'keyRef':
        id(value);
        break;
      case 'algorithm':
      case 'publicKey':
      case 'fingerprint':
        if (typeof value !== 'string' || !value.length || value.length > 16384 || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-request');
        break;
      case 'bodyEnvelope':
        if (!(value instanceof Uint8Array) || value.length < ENVELOPE_OVERHEAD || value.length > MAX_ENVELOPE) fail('invalid-request');
        result[key] = Uint8Array.from(value);
        break;
      case 'envelopeVersion':
        oneOf(value, [ENVELOPE_VERSION]);
        break;
      case 'protectionFormat':
        oneOf(value, [PROTECTION_FORMAT]);
        break;
      case 'username':
        if (typeof value !== 'string' || !value.length || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-request');
        break;
      case 'method':
        oneOf(value, ['password', 'key', 'keyboard-interactive']);
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
const kinds: SecretKind[] = ['password', 'private-key', 'passphrase', 'content-key'];
const transitions: Record<SecretOperation['state'], string[]> = {
  staged: ['reconcile', 'needs-input', 'cleanup', 'complete'],
  reconcile: ['staged', 'needs-input', 'cleanup', 'complete'],
  'needs-input': ['staged', 'reconcile', 'cleanup', 'complete'],
  cleanup: [],
  complete: []
};
/** The one owner field that holds a credential kind; undefined when the owner type cannot hold it. */
export function slotField(ownerType: string, kind: SecretKind): 'contentKeyRef' | 'passwordRef' | 'privateKeyRef' | 'passphraseRef' | undefined {
  if (ownerType === 'vault' && kind === 'content-key') return 'contentKeyRef';
  if (ownerType === 'identity' && kind === 'password') return 'passwordRef';
  if (ownerType === 'key' && kind === 'private-key') return 'privateKeyRef';
  if (ownerType === 'key' && kind === 'passphrase') return 'passphraseRef';
  return undefined;
}
function owner(s: MetadataSnapshot, ownerType: string, ownerId: Id): Entity & Record<string, unknown> | undefined {
  const rows: Entity[] = ownerType === 'vault' ? [s.vault] : ownerType === 'identity' ? s.identities : ownerType === 'key' ? s.keys : [];
  return rows.find(row => row.id === ownerId) as Entity & Record<string, unknown> | undefined;
}
/** Revision expectations always refer to the initial snapshot, even for repeated owner edits. */
export function applyChanges(initial: MetadataSnapshot, changes: MetadataChange[]): MetadataSnapshot {
  const next = structuredClone(initial);
  const now = new Date().toISOString();
  const touched = new Set<string>();
  const initialRecords = new Map<string, Entity>();
  for (const collection of mutableCollections) for (const row of initial[collection]) initialRecords.set(row.id, row);
  for (const row of initial.knownHosts) initialRecords.set(row.id, row);
  initialRecords.set(initial.settings.id, initial.settings);
  initialRecords.set(initial.vault.id, initial.vault);
  const usedIds = new Set<string>();
  for (const row of [initial.vault, initial.settings, ...initial.hosts, ...initial.groups, ...initial.identities, ...initial.tags, ...initial.keys, ...initial.secretRefs, ...initial.snippets, ...initial.knownHosts, ...initial.tunnelRules]) usedIds.add(row.id);
  for (const op of initial.secretOperations) usedIds.add(op.intendedRef);
  const newOwnerPublications: SecretOperation[] = [];
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
  function operation(operationId: unknown): SecretOperation {
    id(operationId);
    return next.secretOperations.find(op => op.operationId === operationId) ?? fail('conflict');
  }
  function journal(op: Omit<SecretOperation, 'vaultId' | 'createdAt' | 'updatedAt'>): void {
    id(op.operationId);
    if (next.secretOperations.some(row => row.operationId === op.operationId)) fail('constraint');
    next.secretOperations.push({
      ...op,
      vaultId: next.vault.id,
      createdAt: now,
      updatedAt: now
    });
  }
  const membership = (c: MetadataChange) => c?.type === 'set-host-tag' || c?.type === 'set-snippet-tag';
  const ordered: unknown[] = [...changes.filter(c => !membership(c)), ...changes.filter(membership)];
  for (const raw of ordered) {
    if (!isObject(raw) || typeof raw.type !== 'string') fail('invalid-request');
    if (['accept-known-host', 'verify-known-host', 'replace-known-host', 'revoke-known-host'].includes(raw.type)) {
      const accepting = raw.type === 'accept-known-host';
      keys(raw, accepting ? ['type', 'id', 'data'] : raw.type === 'verify-known-host' ? ['type', 'id', 'expectedRevision', 'verifiedAt'] : raw.type === 'replace-known-host' ? ['type', 'id', 'expectedRevision', 'data'] : ['type', 'id', 'expectedRevision'], accepting ? ['id', 'data'] : raw.type === 'verify-known-host' ? ['id', 'expectedRevision', 'verifiedAt'] : raw.type === 'replace-known-host' ? ['id', 'expectedRevision', 'data'] : ['id', 'expectedRevision']);
      id(raw.id);
      const timestamp = (value: unknown): string => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('invalid-request');
        return value;
      };
      if (accepting) {
        keys(raw.data, ['endpointHost', 'endpointPort', 'algorithm', 'publicKey', 'fingerprint', 'acceptedAt'], ['endpointHost', 'endpointPort', 'algorithm', 'publicKey', 'fingerprint', 'acceptedAt']);
        let endpointHost: string;
        try { endpointHost = normalizeEndpoint(raw.data.endpointHost as string); } catch { fail('invalid-request'); }
        integer(raw.data.endpointPort, 1, 65535);
        if (!validHostKeyIdentity(raw.data as unknown as {algorithm:string;publicKey:string;fingerprint:string})) fail('invalid-request');
        const endpointPort = raw.data.endpointPort;
        if (usedIds.has(raw.id) || next.knownHosts.some(row => row.endpointHost === endpointHost && row.endpointPort === endpointPort)) fail('conflict');
        usedIds.add(raw.id);
        const at = timestamp(raw.data.acceptedAt);
        next.knownHosts.push({ id: raw.id, vaultId: next.vault.id, revision: 1, createdAt: now, updatedAt: now, endpointHost, endpointPort: raw.data.endpointPort, algorithm: raw.data.algorithm as string, publicKey: raw.data.publicKey as string, fingerprint: raw.data.fingerprint as string, firstAcceptedAt: at, lastVerifiedAt: at });
      } else {
        const row = next.knownHosts.find(row => row.id === raw.id) ?? fail('conflict');
        if (raw.type === 'verify-known-host') {
          // Observation only: fenced by the row revision but revising neither row nor catalog, so routine matches never void previews.
          integer(raw.expectedRevision);
          if (row.revision !== raw.expectedRevision) fail('conflict');
          row.lastVerifiedAt = timestamp(raw.verifiedAt);
          continue;
        }
        touch(row, raw.expectedRevision);
        if (raw.type === 'revoke-known-host') next.knownHosts = next.knownHosts.filter(row => row.id !== raw.id);
        else {
          keys(raw.data, ['algorithm', 'publicKey', 'fingerprint', 'acceptedAt'], ['algorithm', 'publicKey', 'fingerprint', 'acceptedAt']);
          if (!validHostKeyIdentity(raw.data as unknown as {algorithm:string;publicKey:string;fingerprint:string})) fail('invalid-request');
          if (row.publicKey === raw.data.publicKey) fail('invalid-request');
          const at = timestamp(raw.data.acceptedAt);
          Object.assign(row, { algorithm: raw.data.algorithm, publicKey: raw.data.publicKey, fingerprint: raw.data.fingerprint, firstAcceptedAt: at, lastVerifiedAt: at });
        }
      }
      continue;
    }
    if (raw.type === 'set-host-tag' || raw.type === 'set-snippet-tag') {
      const hostMembership = raw.type === 'set-host-tag';
      const ownerField = hostMembership ? 'hostId' : 'snippetId';
      const revisionField = hostMembership ? 'expectedHostRevision' : 'expectedSnippetRevision';
      keys(raw, ['type', ownerField, 'tagId', 'present', revisionField], [ownerField, 'tagId', 'present', revisionField]);
      id(raw[ownerField]);
      id(raw.tagId);
      if (typeof raw.present !== 'boolean') fail('invalid-request');
      const owners = hostMembership ? next.hosts : next.snippets;
      const originals = hostMembership ? initial.hosts : initial.snippets;
      const row = owners.find(row => row.id === raw[ownerField]) ?? originals.find(row => row.id === raw[ownerField]);
      if (!row) fail('constraint');
      touch(row, raw[revisionField]);
      if (hostMembership) {
        const index = next.hostTags.findIndex(row => row.hostId === raw.hostId && row.tagId === raw.tagId);
        if (raw.present && index === -1) next.hostTags.push({ vaultId: next.vault.id, hostId: raw.hostId as Id, tagId: raw.tagId });
        if (!raw.present && index !== -1) next.hostTags.splice(index, 1);
      } else {
        const index = next.snippetTags.findIndex(row => row.snippetId === raw.snippetId && row.tagId === raw.tagId);
        if (raw.present && index === -1) next.snippetTags.push({ vaultId: next.vault.id, snippetId: raw.snippetId as Id, tagId: raw.tagId });
        if (!raw.present && index !== -1) next.snippetTags.splice(index, 1);
      }
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
    if (raw.type === 'stage-secret') {
      keys(raw, ['type', 'operationId', 'action', 'kind', 'intendedRef', 'ownerType', 'ownerId', 'expectedRevision', 'oldRef'], ['operationId', 'action', 'kind', 'intendedRef', 'ownerType', 'ownerId', 'expectedRevision', 'oldRef']);
      id(raw.intendedRef);
      id(raw.ownerId);
      oneOf(raw.action, ['create', 'replace']);
      oneOf(raw.kind, kinds);
      oneOf(raw.ownerType, ['vault', 'identity', 'key']);
      if (raw.expectedRevision !== null) integer(raw.expectedRevision);
      if (raw.oldRef !== null) id(raw.oldRef);
      const kind = raw.kind as SecretKind;
      const field = slotField(raw.ownerType as string, kind) ?? fail('invalid-request');
      if (usedIds.has(raw.intendedRef)) fail('constraint');
      usedIds.add(raw.intendedRef);
      const current = owner(initial, raw.ownerType as string, raw.ownerId);
      if (raw.expectedRevision === null) {
        // The owner record itself is created by the later publishing batch.
        if (raw.action !== 'create' || raw.ownerType === 'vault' || current || usedIds.has(raw.ownerId)) fail('constraint');
      } else {
        if (!current || current.revision !== raw.expectedRevision) fail('conflict');
        if ((current[field] ?? null) !== (raw.action === 'create' ? null : raw.oldRef)) fail('conflict');
      }
      if ((raw.action === 'create') !== (raw.oldRef === null)) fail('invalid-request');
      if (kind === 'content-key' && initial.snippets.length) fail('constraint');
      journal({
        operationId: raw.operationId as Id,
        action: raw.action as 'create',
        state: 'staged',
        intendedRef: raw.intendedRef,
        kind,
        oldRef: raw.oldRef as Id | null,
        ownerType: raw.ownerType as 'vault',
        ownerId: raw.ownerId,
        expectedRevision: raw.expectedRevision as number | null
      });
      continue;
    }
    if (raw.type === 'transition-secret') {
      keys(raw, ['type', 'operationId', 'from', 'to'], ['operationId', 'from', 'to']);
      const op = operation(raw.operationId);
      if (op.state !== raw.from) fail('conflict');
      if (op.action === 'delete' || !transitions[op.state].includes(raw.to as string)) fail('invalid-request');
      op.state = raw.to as SecretOperation['state'];
      op.updatedAt = now;
      continue;
    }
    if (raw.type === 'publish-secret') {
      keys(raw, ['type', 'operationId', 'cleanupOperationId'], ['operationId']);
      const op = operation(raw.operationId);
      if (op.action === 'delete' || (op.state !== 'staged' && op.state !== 'reconcile')) fail('conflict');
      if ((op.action === 'replace') !== Object.hasOwn(raw, 'cleanupOperationId')) fail('invalid-request');
      op.state = 'complete';
      op.updatedAt = now;
      next.secretRefs.push({
        id: op.intendedRef,
        vaultId: next.vault.id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        kind: op.kind,
        operationId: op.operationId
      });
      if (op.expectedRevision === null) {
        newOwnerPublications.push(op);
        continue;
      }
      const field = slotField(op.ownerType, op.kind)!;
      const row = owner(next, op.ownerType, op.ownerId) ?? fail('conflict');
      if ((row[field] ?? null) !== op.oldRef) fail('conflict');
      touch(row, op.expectedRevision);
      row[field] = op.intendedRef;
      if (op.ownerType === 'vault') next.vault.protectionFormat = PROTECTION_FORMAT;
      if (op.oldRef !== null) journal({
        operationId: raw.cleanupOperationId as Id,
        action: 'delete',
        state: 'cleanup',
        intendedRef: op.oldRef,
        kind: op.kind,
        oldRef: null,
        ownerType: op.ownerType,
        ownerId: op.ownerId,
        expectedRevision: null
      });
      continue;
    }
    if (raw.type === 'queue-secret-cleanup') {
      keys(raw, ['type', 'operationId', 'ref'], ['operationId', 'ref']);
      id(raw.ref);
      const ref = initial.secretRefs.find(row => row.id === raw.ref) ?? fail('constraint');
      let holder: { type: SecretOperation['ownerType']; id: Id } | undefined;
      for (const [type, rows] of [['vault', [initial.vault]], ['identity', initial.identities], ['key', initial.keys]] as const) {
        const name = slotField(type, ref.kind);
        const row = name && (rows as readonly Entity[]).find(row => (row as unknown as Record<string, unknown>)[name] === ref.id);
        if (row) holder = { type, id: row.id };
      }
      if (!holder) fail('constraint');
      journal({
        operationId: raw.operationId as Id,
        action: 'delete',
        state: 'cleanup',
        intendedRef: ref.id,
        kind: ref.kind,
        oldRef: null,
        ownerType: holder.type,
        ownerId: holder.id,
        expectedRevision: null
      });
      continue;
    }
    if (raw.type === 'retire-secret') {
      keys(raw, ['type', 'operationId'], ['operationId']);
      const op = operation(raw.operationId);
      if (op.state !== 'cleanup') fail('conflict');
      op.state = 'complete';
      op.updatedAt = now;
      next.secretRefs = next.secretRefs.filter(row => row.id !== op.intendedRef);
      continue;
    }
    const match = /^(create|update|delete)-(host|group|identity|tag|tunnel-rule|key|snippet)$/u.exec(raw.type);
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
      if (action === 'delete') {
        collection.splice(index, 1);
        if (kind === 'snippet') next.snippetTags = next.snippetTags.filter(tag => tag.snippetId !== raw.id);
      } else {
        const data = normalizeData(kind, raw.data as Record<string, unknown>, false);
        // A private key ref changes only through publish-secret, which journals cleanup of the old item.
        if (kind === 'key' && Object.hasOwn(data, 'privateKeyRef') && data.privateKeyRef !== (row as Entity & { privateKeyRef: Id }).privateKeyRef) fail('constraint');
        Object.assign(row, data);
      }
    }
  }
  for (const op of newOwnerPublications) {
    const row = owner(next, op.ownerType, op.ownerId);
    if (!row || initialRecords.has(row.id) || row[slotField(op.ownerType, op.kind)!] !== op.intendedRef) fail('conflict');
  }
  for (const collection of mutableCollections) for (const row of next[collection]) if (touched.has(row.id)) {
    row.revision++;
    row.updatedAt = now;
  }
  for (const row of next.knownHosts) if (touched.has(row.id)) { row.revision++; row.updatedAt = now; }
  for (const row of [next.settings, next.vault]) if (touched.has(row.id)) {
    row.revision++;
    row.updatedAt = now;
  }
  for (const tag of next.tags) tag.normalizedName = normalizeTag(tag.label);
  if (!changes.every(change => change?.type === 'verify-known-host')) next.catalogRevision++;
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
    for (const field of [row.algorithm, row.publicKey, row.fingerprint]) if (typeof field !== 'string' || !field.length) fail('constraint');
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
  const snippetMemberships = new Set<string>();
  for (const row of s.snippetTags) {
    const key = `${row.snippetId}/${row.tagId}`;
    if (row.vaultId !== s.vault.id || !has(s.snippets, row.snippetId) || !has(s.tags, row.tagId) || snippetMemberships.has(key)) fail('constraint');
    snippetMemberships.add(key);
  }
  for (const row of s.snippets) {
    ref(row.keyRef, 'content-key');
    if (!(row.bodyEnvelope instanceof Uint8Array) || row.bodyEnvelope.length < ENVELOPE_OVERHEAD || row.bodyEnvelope[0] !== row.envelopeVersion || row.keyRef !== s.vault.contentKeyRef || row.protectionFormat !== s.vault.protectionFormat) fail('constraint');
  }
  const endpoints = new Set<string>();
  for (const row of s.knownHosts) {
    try {
      if (normalizeEndpoint(row.endpointHost) !== row.endpointHost || !Number.isInteger(row.endpointPort) || row.endpointPort < 1 || row.endpointPort > 65535 || !validHostKeyIdentity(row) || endpoints.has(`${row.endpointHost}/${row.endpointPort}`) || !utc(row.firstAcceptedAt) || !utc(row.lastVerifiedAt)) fail('constraint');
    } catch {
      fail('constraint');
    }
    endpoints.add(`${row.endpointHost}/${row.endpointPort}`);
  }
  validateJournal(s, utc);
  for (const row of s.tunnelRules) {
    if (!has(s.hosts, row.hostId)) fail('constraint');
    try {
      if (normalizeEndpoint(row.destinationHost) !== row.destinationHost) fail('constraint');
    } catch {
      fail('constraint');
    }
  }
}

/** Every descriptor came from one journaled operation and is either live-referenced or awaiting cleanup, never both. */
function validateJournal(s: MetadataSnapshot, utc: (value: string) => boolean): void {
  const live = new Set<string>([s.vault.contentKeyRef, ...s.identities.map(r => r.passwordRef), ...s.keys.flatMap(r => [r.privateKeyRef, r.passphraseRef]), ...s.snippets.map(r => r.keyRef)].filter((r): r is string => r !== null));
  const ops = new Map<string, SecretOperation>();
  const created = new Set<string>();
  const pending = new Set<string>();
  const pendingSlots = new Set<string>();
  for (const op of s.secretOperations) {
    if (op.vaultId !== s.vault.id || !validId(op.operationId) || !validId(op.intendedRef) || !validId(op.ownerId) || !utc(op.createdAt) || !utc(op.updatedAt) || ops.has(op.operationId)) fail('constraint');
    if (!slotField(op.ownerType, op.kind) || (op.action === 'replace') !== (op.oldRef !== null) || (op.oldRef !== null && !validId(op.oldRef))) fail('constraint');
    if (op.action === 'delete' ? op.state !== 'cleanup' && op.state !== 'complete' || op.expectedRevision !== null : created.has(op.intendedRef)) fail('constraint');
    if (op.expectedRevision !== null && !(Number.isSafeInteger(op.expectedRevision) && op.expectedRevision >= 1)) fail('constraint');
    ops.set(op.operationId, op);
    if (op.action !== 'delete') created.add(op.intendedRef);
    if (op.state === 'complete') continue;
    if (pending.has(op.intendedRef)) fail('constraint');
    pending.add(op.intendedRef);
    const slot = `${op.ownerId}/${op.kind}`;
    if (op.action !== 'delete' && op.state !== 'cleanup') {
      if (pendingSlots.has(slot)) fail('constraint');
      pendingSlots.add(slot);
    }
  }
  const published = new Set<string>();
  for (const ref of s.secretRefs) {
    const op = ops.get(ref.operationId);
    if (!op || op.action === 'delete' || op.intendedRef !== ref.id || op.kind !== ref.kind || op.state !== 'complete') fail('constraint');
    published.add(ref.id);
  }
  for (const op of s.secretOperations) {
    const cleaning = op.state === 'cleanup';
    if (cleaning && live.has(op.intendedRef)) fail('constraint');
    if (!cleaning && op.state !== 'complete' && published.has(op.intendedRef)) fail('constraint');
  }
  for (const ref of published) if (!live.has(ref) && !s.secretOperations.some(op => op.state === 'cleanup' && op.intendedRef === ref)) fail('constraint');
}
