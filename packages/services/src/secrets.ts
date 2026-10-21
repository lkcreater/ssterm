import { randomBytes, randomUUID } from 'node:crypto';
import { CONTENT_KEY_BYTES, ENVELOPE_VERSION, MAX_BODY, open, PROTECTION_FORMAT, ProtectionFault, seal } from '@ssterm/adapters';
import type { Id, MetadataChange, MetadataRepository, MetadataSnapshot, SecretItem, SecretKind, SecretOperation, SecretOwnerType, SecretProvider, StorageErrorCode, StoreResult } from '@ssterm/domain';
import type { RecordingKeys } from '@ssterm/domain/recording';
import { DEFAULT_TRANSIENT_MS, type TransientSecret, type TransientSecrets } from './transient.ts';
export const MAX_SECRET_BYTES = 64 * 1024;
export type PendingReason = 'locked' | 'denied' | 'unavailable' | 'unknown' | 'needs-input' | 'storage';
export type SecretResult = {
  status: 'published';
  operationId: Id;
  ref: Id;
} | {
  status: 'pending';
  operationId: Id;
  reason: PendingReason;
} | {
  /** Not published; any confirmed unused provider item is queued for cleanup. */
  status: 'cancelled';
  operationId: Id;
  cleanup: 'none' | 'cleaned' | 'pending';
} | {
  status: 'failed';
  code: StorageErrorCode | 'invalid';
};
export type CleanupResult = {
  status: 'cleaned';
} | {
  status: 'pending';
  reason: PendingReason;
};
export interface ReconcileSummary {
  published: number;
  cleaned: number;
  cancelled: number;
  needsInput: number;
  pending: number;
}
export type KeyUnavailable = 'uninitialized' | 'missing' | 'locked' | 'denied' | 'unavailable' | 'error';
export type SnippetSaveResult = {
  status: 'saved';
  snapshot: MetadataSnapshot;
} | {
  status: 'key-unavailable';
  reason: KeyUnavailable;
} | {
  status: 'corrupt' | 'unsupported';
} | {
  status: 'failed';
  code: StorageErrorCode | 'invalid' | 'fenced';
};
export type SnippetOpenResult = {
  status: 'open';
  body: TransientSecret;
} | {
  status: 'key-unavailable';
  reason: KeyUnavailable;
} | {
  status: 'not-found' | 'corrupt' | 'unsupported';
} | {
  status: 'failed';
  code: StorageErrorCode;
};
type Publication = (ref: Id) => MetadataChange[];
const item = (op: Pick<SecretOperation, 'vaultId' | 'kind' | 'intendedRef'>): SecretItem => ({
  vaultId: op.vaultId,
  kind: op.kind,
  ref: op.intendedRef
});
/** Orders SQL journal steps around OS writes/deletes (domain-storage-spec "Cross-store journal"); never cross-store atomic. */
export class SecretService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: {
    repository: MetadataRepository;
    provider: SecretProvider;
    transient: TransientSecrets;
  }) {}
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
  private commit(changes: MetadataChange[]): StoreResult<MetadataSnapshot> {
    const current = this.options.repository.snapshot();
    if (!current.ok) return current;
    return this.options.repository.commit({
      expectedCatalogRevision: current.value.catalogRevision,
      changes
    });
  }
  private operation(operationId: Id): SecretOperation | undefined {
    const current = this.options.repository.snapshot();
    return current.ok ? current.value.secretOperations.find(op => op.operationId === operationId) : undefined;
  }
  private move(op: SecretOperation, to: 'staged' | 'reconcile' | 'needs-input' | 'cleanup' | 'complete'): boolean {
    if (op.state === to) return true;
    const result = this.commit([{
      type: 'transition-secret',
      operationId: op.operationId,
      from: op.state,
      to
    }]);
    if (result.ok) op.state = to;
    return result.ok;
  }
  /** Stage, write under the stable intended ref, look up before every retry, then publish.
   * publish (owner-creating changes) is accepted only for a new owner (expectedRevision null). */
  storeSecret(request: {
    kind: SecretKind;
    owner: {
      type: SecretOwnerType;
      id: Id;
      expectedRevision: number | null;
    };
    oldRef?: Id | null;
    value: Uint8Array;
    publish?: Publication;
  }): Promise<SecretResult> {
    return this.serial(() => this.store(request));
  }
  private async store(request: Parameters<SecretService['storeSecret']>[0]): Promise<SecretResult> {
    // Reconciliation can only reconstruct a plain ref swap for an existing owner, so no extra payload may ride along.
    if (!(request.value instanceof Uint8Array) || request.value.length > MAX_SECRET_BYTES || (request.publish && request.owner.expectedRevision !== null)) return {
      status: 'failed',
      code: 'invalid'
    };
    const operationId = randomUUID();
    const oldRef = request.oldRef ?? null;
    const staged = this.commit([{
      type: 'stage-secret',
      operationId,
      action: oldRef === null ? 'create' : 'replace',
      kind: request.kind,
      intendedRef: randomUUID(),
      ownerType: request.owner.type,
      ownerId: request.owner.id,
      expectedRevision: request.owner.expectedRevision,
      oldRef
    }]);
    if (!staged.ok) return {
      status: 'failed',
      code: staged.error.code
    };
    const op = staged.value.secretOperations.find(row => row.operationId === operationId)!;
    return this.attempt(op, request.value, request.publish, false);
  }
  private async attempt(op: SecretOperation, value: Uint8Array | undefined, publish: Publication | undefined, lookupFirst: boolean): Promise<SecretResult> {
    const { provider } = this.options;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (lookupFirst || attempt > 0) {
        const found = await provider.lookup(item(op));
        if (found.status === 'present') return this.publish(op, publish);
        if (found.status !== 'missing') {
          this.move(op, 'reconcile');
          return {
            status: 'pending',
            operationId: op.operationId,
            reason: found.status === 'error' ? 'unknown' : found.status
          };
        }
        if (!value) {
          this.move(op, 'needs-input');
          return {
            status: 'pending',
            operationId: op.operationId,
            reason: 'needs-input'
          };
        }
      }
      // Re-entered input resumes the same operation and ref.
      if (op.state === 'needs-input' && !this.move(op, 'staged')) return {
        status: 'pending',
        operationId: op.operationId,
        reason: 'storage'
      };
      const written = await provider.write(item(op), value!);
      if (written.status === 'confirmed') return this.publish(op, publish);
      if (written.status === 'error') {
        // A definite failure wrote nothing; the stable ref is retired unused.
        this.move(op, 'complete');
        return {
          status: 'failed',
          code: 'invalid'
        };
      }
      this.move(op, 'reconcile');
      if (written.status !== 'unknown') return {
        status: 'pending',
        operationId: op.operationId,
        reason: written.status
      };
    }
    return {
      status: 'pending',
      operationId: op.operationId,
      reason: 'unknown'
    };
  }
  private async publish(op: SecretOperation, publish: Publication | undefined): Promise<SecretResult> {
    if (op.expectedRevision === null && !publish) return this.abandon(op);
    // An item found present after needs-input publishes like any confirmed write.
    if (op.state === 'needs-input' && !this.move(op, 'reconcile')) return {
      status: 'pending',
      operationId: op.operationId,
      reason: 'storage'
    };
    const changes: MetadataChange[] = [{
      type: 'publish-secret',
      operationId: op.operationId,
      ...(op.action === 'replace' ? {
        cleanupOperationId: randomUUID()
      } : {})
    }, ...(publish?.(op.intendedRef) ?? [])];
    const published = this.commit(changes);
    if (published.ok) {
      const cleanup = published.value.secretOperations.find(row => row.action === 'delete' && row.state === 'cleanup' && row.intendedRef === op.oldRef);
      if (cleanup) await this.cleanup(cleanup);
      return {
        status: 'published',
        operationId: op.operationId,
        ref: op.intendedRef
      };
    }
    if (['busy', 'closed', 'io', 'unwritable', 'unavailable'].includes(published.error.code)) {
      this.move(op, 'reconcile');
      return {
        status: 'pending',
        operationId: op.operationId,
        reason: 'storage'
      };
    }
    return this.abandon(op);
  }
  /** Owner changed, vanished or failed validation: never publish; delete the confirmed unused item. */
  private async abandon(op: SecretOperation): Promise<SecretResult> {
    if (!this.move(op, 'cleanup')) return {
      status: 'pending',
      operationId: op.operationId,
      reason: 'storage'
    };
    const cleaned = await this.cleanup(op);
    return {
      status: 'cancelled',
      operationId: op.operationId,
      cleanup: cleaned.status === 'cleaned' ? 'cleaned' : 'pending'
    };
  }
  private async cleanup(op: SecretOperation): Promise<CleanupResult> {
    const current = this.options.repository.snapshot();
    if (!current.ok) return {
      status: 'pending',
      reason: 'storage'
    };
    const s = current.value;
    const live = [s.vault.contentKeyRef, ...s.identities.map(r => r.passwordRef), ...s.keys.flatMap(r => [r.privateKeyRef, r.passphraseRef]), ...s.snippets.map(r => r.keyRef)];
    const stored = s.secretOperations.find(row => row.operationId === op.operationId);
    // Defensive re-check; the repository also refuses cleanup of live references.
    if (stored?.state !== 'cleanup' || live.includes(op.intendedRef)) return {
      status: 'pending',
      reason: 'storage'
    };
    const removed = await this.options.provider.delete(item(op));
    if (removed.status !== 'confirmed' && removed.status !== 'missing') return {
      status: 'pending',
      reason: removed.status === 'error' ? 'unknown' : removed.status
    };
    return this.commit([{
      type: 'retire-secret',
      operationId: op.operationId
    }]).ok ? {
      status: 'cleaned'
    } : {
      status: 'pending',
      reason: 'storage'
    };
  }
  /** Retry with live input (or without, to resolve by lookup); always looks up the same intended ref first. */
  resume(operationId: Id, value?: Uint8Array, publish?: Publication): Promise<SecretResult> {
    return this.serial(async () => {
      const op = this.operation(operationId);
      if (!op || !['staged', 'reconcile', 'needs-input'].includes(op.state) || (publish && op.expectedRevision !== null) || (value && (!(value instanceof Uint8Array) || value.length > MAX_SECRET_BYTES))) return {
        status: 'failed',
        code: 'invalid'
      };
      return this.attempt(op, value, publish, true);
    });
  }
  cancel(operationId: Id): Promise<SecretResult> {
    return this.serial(() => this.cancelOperation(operationId));
  }
  private async cancelOperation(operationId: Id): Promise<SecretResult> {
    const op = this.operation(operationId);
    if (!op || !['staged', 'reconcile', 'needs-input'].includes(op.state)) return {
      status: 'failed',
      code: 'invalid'
    };
    const found = await this.options.provider.lookup(item(op));
    if (found.status === 'present') return this.abandon(op);
    if (found.status === 'missing') return this.move(op, 'complete') ? {
      status: 'cancelled',
      operationId,
      cleanup: 'none'
    } : {
      status: 'pending',
      operationId,
      reason: 'storage'
    };
    this.move(op, 'reconcile');
    return {
      status: 'pending',
      operationId,
      reason: found.status === 'error' ? 'unknown' : found.status
    };
  }
  /** SQL first: remove references and journal cleanup atomically, then request OS deletion. */
  removeSecrets(changes: MetadataChange[], refs: Id[]): Promise<{
    status: 'committed';
    cleanup: CleanupResult[];
  } | {
    status: 'failed';
    code: StorageErrorCode;
  }> {
    return this.serial(async () => {
      const queued = refs.map(ref => ({
        type: 'queue-secret-cleanup' as const,
        operationId: randomUUID(),
        ref
      }));
      const committed = this.commit([...changes, ...queued]);
      if (!committed.ok) return {
        status: 'failed',
        code: committed.error.code
      };
      const cleanup: CleanupResult[] = [];
      for (const change of queued) cleanup.push(await this.cleanup(committed.value.secretOperations.find(op => op.operationId === change.operationId)!));
      return {
        status: 'committed',
        cleanup
      };
    });
  }
  /** Startup/unlock reconciliation of unfinished journal rows. Returns counts only. */
  reconcile(): Promise<ReconcileSummary> {
    return this.serial(async () => {
      const summary: ReconcileSummary = {
        published: 0,
        cleaned: 0,
        cancelled: 0,
        needsInput: 0,
        pending: 0
      };
      const current = this.options.repository.snapshot();
      if (!current.ok) return summary;
      for (const op of current.value.secretOperations) {
        if (op.state === 'complete') continue;
        if (op.state === 'needs-input') {
          const owner = op.ownerType === 'vault' ? current.value.vault : (op.ownerType === 'identity' ? current.value.identities : current.value.keys).find(row => row.id === op.ownerId);
          // Re-entry could never publish against a moved or deleted owner; cancel so backup/migration are not blocked.
          if (owner?.revision === op.expectedRevision) summary.needsInput++;else if ((await this.cancelOperation(op.operationId)).status === 'cancelled') summary.cancelled++;else summary.pending++;
          continue;
        }
        if (op.state === 'cleanup') {
          if ((await this.cleanup(op)).status === 'cleaned') summary.cleaned++;else summary.pending++;
          continue;
        }
        const found = await this.options.provider.lookup(item(op));
        let result: SecretResult;
        if (found.status === 'present') result = await this.publish(op, undefined);else if (found.status === 'missing') {
          // A vanished new-owner draft cannot be re-entered; an existing owner can.
          result = op.expectedRevision === null && this.move(op, 'complete') ? {
            status: 'cancelled',
            operationId: op.operationId,
            cleanup: 'none'
          } : this.move(op, 'needs-input') ? {
            status: 'pending',
            operationId: op.operationId,
            reason: 'needs-input'
          } : {
            status: 'pending',
            operationId: op.operationId,
            reason: 'storage'
          };
        } else {
          this.move(op, 'reconcile');
          result = {
            status: 'pending',
            operationId: op.operationId,
            reason: 'unknown'
          };
        }
        if (result.status === 'published') summary.published++;else if (result.status === 'cancelled') summary.cancelled++;else if (result.status === 'pending' && result.reason === 'needs-input') summary.needsInput++;else summary.pending++;
      }
      return summary;
    });
  }
  /**
   * SST-034: per-recording data keys wrapped by the vault content key. One provider read per call however many
   * items it carries; the vault key is zeroed before the call settles and never leaves this service.
   */
  readonly recording: RecordingKeys = {
    prepare: async () => {
      const result = await this.initializeContentKey();
      if (result.status === 'ready' || result.status === 'published') return { ok: true };
      if (result.status === 'failed') return { ok: false, reason: result.code === 'constraint' ? 'constraint' : 'unavailable' };
      if (result.status === 'pending' && (result.reason === 'locked' || result.reason === 'denied')) return { ok: false, reason: result.reason };
      return { ok: false, reason: 'unavailable' };
    },
    seal: (items) => this.serial(async () => {
      const current = this.options.repository.snapshot();
      if (!current.ok) return { ok: false as const, reason: 'unavailable' as const };
      const s = current.value;
      const loaded = await this.contentKey(s);
      if ('reason' in loaded) return { ok: false as const, reason: loaded.reason };
      try {
        const envelopes = items.map((item) => seal(loaded.key, { vaultId: s.vault.id, recordingId: item.recordingId, field: 'recording-key' }, item.key));
        return { ok: true as const, vaultId: s.vault.id, envelopes };
      } catch {
        return { ok: false as const, reason: 'error' as const };
      } finally { loaded.key.fill(0); }
    }),
    open: (items) => this.serial(async () => {
      const current = this.options.repository.snapshot();
      if (!current.ok) return { ok: false as const, reason: 'unavailable' as const };
      const s = current.value;
      const loaded = await this.contentKey(s);
      if ('reason' in loaded) return { ok: false as const, reason: loaded.reason };
      try {
        const keys = items.map((item) => {
          if (item.vaultId !== s.vault.id) return undefined;
          try {
            return open(loaded.key, { vaultId: s.vault.id, recordingId: item.recordingId, field: 'recording-key' },
              { bodyEnvelope: item.envelope, envelopeVersion: ENVELOPE_VERSION, protectionFormat: PROTECTION_FORMAT });
          } catch (error) {
            if (error instanceof ProtectionFault) return undefined;
            throw error;
          }
        });
        return { ok: true as const, keys };
      } finally { loaded.key.fill(0); }
    }),
  };
  /** Creates the vault content key only for an uninitialized vault without ciphertext; a published key is never replaced. */
  initializeContentKey(): Promise<SecretResult | {
    status: 'ready';
  }> {
    return this.serial(async () => {
      const current = this.options.repository.snapshot();
      if (!current.ok) return {
        status: 'failed',
        code: current.error.code
      };
      const { vault, snippets, secretOperations } = current.value;
      if (vault.contentKeyRef !== null) return {
        status: 'ready'
      };
      if (snippets.length) return {
        status: 'failed',
        code: 'constraint'
      };
      const pending = secretOperations.find(op => op.ownerType === 'vault' && op.state !== 'complete' && op.state !== 'cleanup');
      if (pending) {
        const resolved = await this.attempt(pending, undefined, undefined, true);
        if (resolved.status !== 'pending' || resolved.reason !== 'needs-input') return resolved;
        // Confirmed missing and never published: retire it before staging a fresh key.
        const cancelled = await this.cancelOperation(pending.operationId);
        if (cancelled.status !== 'cancelled') return cancelled;
      }
      const vaultNow = this.options.repository.snapshot();
      if (!vaultNow.ok) return {
        status: 'failed',
        code: vaultNow.error.code
      };
      const key = randomBytes(CONTENT_KEY_BYTES);
      try {
        return await this.store({
          kind: 'content-key',
          owner: {
            type: 'vault',
            id: vaultNow.value.vault.id,
            expectedRevision: vaultNow.value.vault.revision
          },
          value: key
        });
      } finally {
        key.fill(0);
      }
    });
  }
  private async contentKey(s: MetadataSnapshot): Promise<{
    key: Buffer;
  } | {
    reason: KeyUnavailable;
  }> {
    if (s.vault.contentKeyRef === null) return {
      reason: 'uninitialized'
    };
    const read = await this.options.provider.read({
      vaultId: s.vault.id,
      kind: 'content-key',
      ref: s.vault.contentKeyRef
    });
    if (read.status !== 'present') return {
      reason: read.status
    };
    const key = Buffer.from(read.value);
    read.value.fill(0);
    if (key.length !== CONTENT_KEY_BYTES) {
      key.fill(0);
      return {
        reason: 'error'
      };
    }
    return {
      key
    };
  }
  /**
   * Encrypts with the vault key; an existing body must authenticate before it may be overwritten.
   * `tagIds`, when given, is the complete membership set, written in the same revision-fenced commit.
   */
  saveSnippet(request: {
    id: Id;
    label: string;
    body: Uint8Array;
    expectedRevision?: number;
    tagIds?: readonly Id[];
    /** Checked synchronously right before the commit; false (e.g. a workspace lock meanwhile) writes nothing. */
    fence?: () => boolean;
  }): Promise<SnippetSaveResult> {
    return this.serial(async () => {
      if (!(request.body instanceof Uint8Array) || request.body.length > MAX_BODY) return {
        status: 'failed',
        code: 'invalid'
      };
      if (request.tagIds !== undefined && (!Array.isArray(request.tagIds) || new Set(request.tagIds).size !== request.tagIds.length)) return {
        status: 'failed',
        code: 'invalid'
      };
      const current = this.options.repository.snapshot();
      if (!current.ok) return {
        status: 'failed',
        code: current.error.code
      };
      const s = current.value;
      const existing = s.snippets.find(row => row.id === request.id);
      const loaded = await this.contentKey(s);
      if ('reason' in loaded) return {
        status: 'key-unavailable',
        reason: loaded.reason
      };
      const { key } = loaded;
      const binding = {
        vaultId: s.vault.id,
        snippetId: request.id,
        field: 'body' as const
      };
      try {
        if (existing) open(key, binding, existing).fill(0);
        const envelope = seal(key, binding, request.body);
        const data = {
          label: request.label,
          bodyEnvelope: envelope,
          envelopeVersion: ENVELOPE_VERSION,
          keyRef: s.vault.contentKeyRef!,
          protectionFormat: PROTECTION_FORMAT
        };
        const changes: MetadataChange[] = [existing ? {
          type: 'update-snippet',
          id: request.id,
          expectedRevision: request.expectedRevision ?? -1,
          data
        } : {
          type: 'create-snippet',
          id: request.id,
          data
        }];
        if (request.tagIds !== undefined) {
          const expectedSnippetRevision = existing ? request.expectedRevision ?? -1 : 1;
          const before = new Set(s.snippetTags.filter(row => row.snippetId === request.id).map(row => row.tagId));
          const after = new Set(request.tagIds);
          for (const tagId of after) if (!before.has(tagId)) changes.push({ type: 'set-snippet-tag', snippetId: request.id, tagId, present: true, expectedSnippetRevision });
          for (const tagId of before) if (!after.has(tagId)) changes.push({ type: 'set-snippet-tag', snippetId: request.id, tagId, present: false, expectedSnippetRevision });
        }
        if (request.fence && !request.fence()) return {
          status: 'failed',
          code: 'fenced'
        };
        const saved = this.commit(changes);
        return saved.ok ? {
          status: 'saved',
          snapshot: saved.value
        } : {
          status: 'failed',
          code: saved.error.code
        };
      } catch (error) {
        if (error instanceof ProtectionFault) return {
          status: error.code === 'unsupported' ? 'unsupported' : 'corrupt'
        };
        throw error;
      } finally {
        key.fill(0);
      }
    });
  }
  /** Metadata-only and key-independent: the row and its memberships go; the shared vault key stays. */
  deleteSnippet(id: Id, expectedRevision: number, fence?: () => boolean): Promise<StoreResult<MetadataSnapshot> | { ok: false; error: { code: 'fenced' } }> {
    return this.serial(async () => fence && !fence() ? { ok: false as const, error: { code: 'fenced' as const } } : this.commit([{
      type: 'delete-snippet',
      id,
      expectedRevision
    }]));
  }
  /** Main-only sync capture. Owned plaintext buffers must be wiped by the caller; nothing is persisted here. */
  exportSnippetBodies(ids: readonly Id[], fence: () => boolean = () => true): Promise<{ status: 'ready'; bodies: { id: Id; body: Buffer }[] } | { status: 'failed' }> {
    return this.serial(async () => {
      const bodies: { id: Id; body: Buffer }[] = [];
      const current = this.options.repository.snapshot();
      if (!current.ok || ids.length > 256 || new Set(ids).size !== ids.length || !fence()) return { status: 'failed' };
      if (!ids.length) return { status: 'ready', bodies };
      const loaded = await this.contentKey(current.value);
      if ('reason' in loaded) return { status: 'failed' };
      try {
        let total = 0;
        for (const id of ids) {
          const snippet = current.value.snippets.find(row => row.id === id);
          if (!snippet) throw new Error('unavailable');
          const body = open(loaded.key, { vaultId: current.value.vault.id, snippetId: id, field: 'body' }, snippet);
          bodies.push({ id, body });
          total += body.length;
          if (total > MAX_BODY || !fence()) throw new Error('unavailable');
        }
        return { status: 'ready', bodies };
      } catch {
        for (const item of bodies) item.body.fill(0);
        return { status: 'failed' };
      } finally { loaded.key.fill(0); }
    });
  }
  /** Prepare one atomic catalog import; content-key initialization is a separate reconciled operation. */
  prepareSnippetImport(request: {
    expectedCatalogRevision: number;
    snippets: { id: Id; label: string; body: Uint8Array; expectedRevision?: number }[];
    fence?: () => boolean;
  }): Promise<{ status: 'ready'; changes: MetadataChange[]; catalogRevision: number } | { status: 'failed' }> {
    return this.serial(async () => {
      const current = this.options.repository.snapshot();
      if (!current.ok || current.value.catalogRevision !== request.expectedCatalogRevision || request.snippets.length > 256 ||
        new Set(request.snippets.map(item => item.id)).size !== request.snippets.length || request.fence?.() === false) return { status: 'failed' };
      const s = current.value;
      if (!request.snippets.length) return { status: 'ready', changes: [], catalogRevision: s.catalogRevision };
      const loaded = await this.contentKey(s);
      if ('reason' in loaded) return { status: 'failed' };
      try {
        const changes: MetadataChange[] = [];
        let total = 0;
        for (const item of request.snippets) {
          if (!(item.body instanceof Uint8Array) || (total += item.body.length) > MAX_BODY) return { status: 'failed' };
          const existing = s.snippets.find(row => row.id === item.id);
          if (existing && existing.revision !== item.expectedRevision) return { status: 'failed' };
          if (existing) open(loaded.key, { vaultId: s.vault.id, snippetId: item.id, field: 'body' }, existing).fill(0);
          const data = { label: item.label, bodyEnvelope: seal(loaded.key, { vaultId: s.vault.id, snippetId: item.id, field: 'body' }, item.body),
            envelopeVersion: ENVELOPE_VERSION, keyRef: s.vault.contentKeyRef!, protectionFormat: PROTECTION_FORMAT };
          changes.push(existing ? { type: 'update-snippet', id: item.id, expectedRevision: existing.revision, data } : { type: 'create-snippet', id: item.id, data });
        }
        const now = this.options.repository.snapshot();
        if (!now.ok || now.value.catalogRevision !== s.catalogRevision || request.fence?.() === false) return { status: 'failed' };
        return { status: 'ready', changes, catalogRevision: s.catalogRevision };
      } catch { return { status: 'failed' }; }
      finally { loaded.key.fill(0); }
    });
  }
  openSnippet(id: Id, ttlMs = DEFAULT_TRANSIENT_MS): Promise<SnippetOpenResult> {
    return this.serial(async () => {
      const current = this.options.repository.snapshot();
      if (!current.ok) return {
        status: 'failed',
        code: current.error.code
      };
      const s = current.value;
      const snippet = s.snippets.find(row => row.id === id);
      if (!snippet) return {
        status: 'not-found'
      };
      const loaded = await this.contentKey(s);
      if ('reason' in loaded) return {
        status: 'key-unavailable',
        reason: loaded.reason
      };
      let body: Buffer | undefined;
      try {
        body = open(loaded.key, {
          vaultId: s.vault.id,
          snippetId: id,
          field: 'body'
        }, snippet);
        return {
          status: 'open',
          body: this.options.transient.hold(body, ttlMs)
        };
      } catch (error) {
        if (error instanceof ProtectionFault) return {
          status: error.code === 'unsupported' ? 'unsupported' : 'corrupt'
        };
        throw error;
      } finally {
        body?.fill(0);
        loaded.key.fill(0);
      }
    });
  }
}
