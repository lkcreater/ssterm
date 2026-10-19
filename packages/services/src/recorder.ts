/**
 * SST-034: opt-in, encrypted, main-only session logs and command history. One deep module behind ten members plus
 * `forget`: callers never see a path, a key, a segment or a policy rule.
 *
 * Files: one per (terminal generation, kind) in the confined `recordings/` root, `out-<id>` for output and
 * `cmd-<id>` for command lines, `.part` while open or interrupted and `.ssr` once sealed with a final segment.
 *   header   = identity ‖ u16 len ‖ vaultId ‖ u16 len ‖ keyEnvelope
 *   identity = "SSTREC\0\1" ‖ u32 len ‖ JSON {v, kind, id, startedAt, generation, scope, label, endpoint, environment, local}
 *   segments = STREAM frames (protection.ts) under a per-file random key; AAD = SHA-256(identity); plaintext is
 *              u8 type ‖ body: 1 output, 2 gap (u64 bytes dropped), 3 command (u64 ms ‖ UTF-8), 4 end (last only).
 * The key envelope is the vault content key's v1 envelope bound to (vaultId, recording id, 'recording-key').
 * Frames seal from the first byte while the key wrap is still in flight; only ciphertext ever waits or reaches disk.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CONTENT_KEY_BYTES, ENVELOPE_OVERHEAD, openSegment, sealSegment, SEGMENT_HEADER, SEGMENT_SEALED_MAX } from '@ssterm/adapters';
import { RECORDING_NAME, type FileIdentity, type RecordingFiles, type RecordingSink } from '@ssterm/adapters/recording-files';
import type { ObservedTerminal, TerminalObserver } from '@ssterm/domain';
import {
  DEFAULT_RECORDING_POLICY, isCommandText, isRecordingPolicy, MAX_LISTED_RECORDINGS, MAX_SUGGESTIONS,
  type ConfigureOutcome, type DeleteRecordingTarget, type ExportOutcome, type ExportRecordingTarget, type ForgetOutcome,
  type RecordingEnvironment, type RecordingKeys, type RecordingPolicy, type RecordingProblem, type RecordingState,
  type RecordingSummary, type SuggestOutcome, type TerminalRecording,
} from '@ssterm/domain/recording';
import { CommandScanner, type RecordableCommand } from './command-scanner.ts';
import { MAX_TRANSIENT_MS } from './transient.ts';

export interface RecorderLimits {
  /** Output bytes per sealed segment. */
  segmentBytes: number;
  /** A partly filled segment is sealed after this long, which bounds what a crash loses. */
  flushMs: number;
  /** Pending ciphertext of one recording at which output starts to drop (with a gap record). */
  highWater: number;
  /** Pending ciphertext below which a dropping recording resumes. */
  lowWater: number;
  /** Pending ciphertext across all recordings at which output drops. */
  globalHighWater: number;
  keyDeadlineMs: number;
  historyTtlMs: number;
  /** Command lines closer together than this in one session are dropped (forged bursts, replayed logs). */
  commandIntervalMs: number;
  maxFilesPerKind: number;
  drainMs: number;
  sweepMs: number;
}
const MiB = 1_048_576;
const DAY = 86_400_000;
export const DEFAULT_RECORDER_LIMITS: Readonly<RecorderLimits> = Object.freeze({
  segmentBytes: 65_536, flushMs: 1_000, highWater: 8 * MiB, lowWater: 2 * MiB, globalHighWater: 32 * MiB,
  keyDeadlineMs: 30_000, historyTtlMs: MAX_TRANSIENT_MS, commandIntervalMs: 200, maxFilesPerKind: 4_096, drainMs: 2_000,
  sweepMs: 3_600_000,
});

export interface Recorder {
  /** The bounded root check, index scan and retention pass. Never touches the Keychain; never rejects. */
  readonly ready: Promise<void>;
  /** The registry's `observeTerminal`. Synchronous, never throws; undefined when the policy captures nothing. */
  observe(session: ObservedTerminal): TerminalObserver | undefined;
  /** The pane badge of one generation; null when nothing is captured for it. */
  status(sessionId: string, generation: number): TerminalRecording | null;
  /** Called with the owner whose badge changed. */
  onChange(listener: (ownerId: string) => void): () => void;
  state(): RecordingState;
  /** Enabling a kind first prepares and probes the vault key; disabling stops that kind in running panes at once. */
  configure(policy: RecordingPolicy): Promise<ConfigureOutcome>;
  /** Unlinks matching closed files; stops and unlinks matching live ones. */
  delete(target: DeleteRecordingTarget): Promise<RecordingState>;
  /** Streams plaintext to `destination` (chosen by the main save dialog) through an exclusive stage. */
  export(target: ExportRecordingTarget, destination: string): Promise<ExportOutcome>;
  /** Same-scope prefix matches, newest first, distinct, at most MAX_SUGGESTIONS, never equal to the prefix. */
  suggest(scope: string, prefix: string): Promise<SuggestOutcome>;
  /** Rewrites every closed history file of the scope without `text` under a fresh key; live ones at their end. */
  forget(scope: string, text: string): Promise<ForgetOutcome>;
  /** Screen lock or suspend, after the registry ended every observer: drops the history cache, aborts exports. */
  lock(): void;
  /** Quit: ends what is still live, bounded drain, zeroes keys. Idempotent. */
  dispose(): Promise<void>;
}

type Kind = 'out' | 'cmd';
const enum Segment { Output = 1, Gap = 2, Command = 3, End = 4 }
const MAGIC = Buffer.from('SSTREC\0\x01', 'latin1');
const MAX_IDENTITY = 4_096;
const MAX_VAULT_ID = 64;
const KEY_ENVELOPE = ENVELOPE_OVERHEAD + CONTENT_KEY_BYTES;
interface Identity {
  v: 1;
  kind: Kind;
  id: string;
  startedAt: number;
  generation: number;
  scope: string;
  label: string;
  endpoint: string | null;
  environment: RecordingEnvironment;
  local: boolean;
}
interface Entry {
  kind: Kind;
  id: string;
  name: string;
  identity: Identity;
  block: Buffer;
  hash: Buffer;
  vaultId: string;
  envelope: Uint8Array;
  file: FileIdentity;
  bytes: number;
  state: 'live' | 'complete' | 'incomplete';
}
interface Writer {
  record: Live;
  kind: Kind;
  id: string;
  identity: Identity;
  block: Buffer;
  hash: Buffer;
  /** Lives exactly as long as the writer accepts input; zeroed right after the final segment is sealed. */
  key: Buffer | undefined;
  counter: number;
  plain: Buffer | undefined;
  used: number;
  queue: Uint8Array[];
  pending: number;
  dropped: number;
  bytes: number;
  commands: number;
  header?: Buffer;
  vaultId?: string;
  envelope?: Uint8Array;
  sink?: RecordingSink;
  entry?: Entry;
  opening: boolean;
  pumping: boolean;
  ended: boolean;
  failed: boolean;
  /** Deleted while live: the file is unlinked once its handle is closed. */
  discard: boolean;
  /** Lines the user forgot while this file was live; it is rewritten without them at its end. */
  forget: Set<string>;
  done: Promise<void>;
  settle(): void;
}
interface Live {
  key: string;
  session: ObservedTerminal;
  scope: string;
  epoch: number;
  out?: Writer;
  cmd?: Writer;
  scanner?: CommandScanner;
  status: TerminalRecording | null;
  lastCommandAt: number;
  finished: boolean;
}
type JournalRecord = { type: 'output'; bytes: Buffer } | { type: 'gap'; bytes: number } | { type: 'command'; at: number; text: string };
type Verdict = 'complete' | 'incomplete' | 'corrupt';

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const clip = (value: string, max: number) => [...value].slice(0, max).join('');
const u16 = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
function identityBlock(identity: Identity): Buffer {
  const json = Buffer.from(JSON.stringify(identity), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json]);
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function isIdentity(value: unknown, kind: Kind, id: string): value is Identity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const keys = ['v', 'kind', 'id', 'startedAt', 'generation', 'scope', 'label', 'endpoint', 'environment', 'local'];
  return Object.keys(v).length === keys.length && keys.every((key) => Object.hasOwn(v, key)) && v.v === 1 && v.kind === kind &&
    v.id === id && Number.isSafeInteger(v.startedAt) && Number.isSafeInteger(v.generation) && typeof v.scope === 'string' &&
    v.scope.length > 0 && v.scope.length <= 256 && !/[\t\n\r]/u.test(v.scope) && typeof v.label === 'string' &&
    (v.endpoint === null || typeof v.endpoint === 'string') && ['DEV', 'STAGING', 'PROD', null].includes(v.environment as string | null) &&
    typeof v.local === 'boolean';
}

function limitsOf(input: Partial<RecorderLimits> | undefined): RecorderLimits {
  const limits = { ...DEFAULT_RECORDER_LIMITS, ...input };
  const valid = Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0) && limits.segmentBytes <= 65_536 &&
    limits.lowWater < limits.highWater && limits.highWater <= limits.globalHighWater && limits.historyTtlMs <= MAX_TRANSIENT_MS;
  if (!valid) throw new RangeError('invalid-recorder-limits');
  return limits;
}

export function createRecorder(options: {
  files: RecordingFiles;
  /** Undefined (storage blocked, no secure store) fails capture closed with a visible problem. */
  keys: () => RecordingKeys | undefined;
  limits?: Partial<RecorderLimits>;
  now?: () => number;
}): Recorder {
  const { files } = options;
  const limits = limitsOf(options.limits);
  const now = options.now ?? Date.now;
  let policy: RecordingPolicy = { ...DEFAULT_RECORDING_POLICY };
  let rootSafe = false;
  let lastProblem: RecordingState['problem'] = null;
  let epoch = 0;
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let totalPending = 0;
  const index = new Map<string, Entry>();
  const live = new Map<string, Live>();
  const writers = new Set<Writer>();
  const listeners = new Set<(ownerId: string) => void>();
  const owed = new Set<string>();
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  let sweepAgain = false;
  let cache: { bytes: Buffer; timer: ReturnType<typeof setTimeout> } | undefined;
  let loading: Promise<Buffer | SuggestOutcome> | undefined;
  // Bumped by every purge, so a load that started before one never installs its result.
  let loads = 0;

  const cap = (kind: Kind) => (kind === 'out' ? policy.logMiB : policy.historyMiB) * MiB;
  /** Coalesced and deferred: a badge change never re-enters the registry from inside its own callback. */
  function changed(record: Live): void {
    const ownerId = record.session.ownerId;
    if (owed.has(ownerId)) return;
    owed.add(ownerId);
    queueMicrotask(() => {
      owed.delete(ownerId);
      for (const listener of [...listeners]) { try { listener(ownerId); } catch { /* A listener cannot break capture. */ } }
    });
  }
  function zero(writer: Writer): void {
    writer.key?.fill(0);
    writer.key = undefined;
    writer.plain?.fill(0);
    writer.plain = undefined;
    writer.used = 0;
  }
  function dropQueue(writer: Writer): void {
    totalPending -= writer.pending;
    writer.pending = 0;
    writer.queue = [];
  }
  function enqueue(writer: Writer, plaintext: Uint8Array, last = false): void {
    const frame = sealSegment(writer.key!, writer.hash, writer.counter++, last, plaintext);
    writer.queue.push(frame);
    writer.pending += frame.length;
    writer.bytes += frame.length;
    totalPending += frame.length;
    pump(writer);
  }
  function flush(writer: Writer): void {
    if (!writer.used || !writer.plain || !writer.key) return;
    writer.plain[0] = Segment.Output;
    enqueue(writer, writer.plain.subarray(0, writer.used + 1));
    writer.plain.fill(0, 0, writer.used + 1);
    writer.used = 0;
  }
  function gap(writer: Writer): void {
    const body = Buffer.alloc(9);
    body[0] = Segment.Gap;
    body.writeBigUInt64BE(BigInt(writer.dropped), 1);
    writer.dropped = 0;
    enqueue(writer, body);
  }
  function writer(record: Live, kind: Kind): Writer {
    const id = randomUUID();
    const s = record.session;
    const identity: Identity = {
      v: 1, kind, id, startedAt: now(), generation: s.generation, scope: record.scope, label: clip(s.label, 256),
      endpoint: s.endpoint === null ? null : clip(s.endpoint, 512), environment: s.environment, local: s.local,
    };
    const block = identityBlock(identity);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const created: Writer = {
      record, kind, id, identity, block, hash: sha256(block), key: randomBytes(CONTENT_KEY_BYTES), counter: 0,
      plain: kind === 'out' ? Buffer.alloc(limits.segmentBytes + 1) : undefined, used: 0, queue: [], pending: 0, dropped: 0,
      bytes: 0, commands: 0, opening: false, pumping: false, ended: false, failed: false, discard: false, forget: new Set(), done,
      settle: () => { writers.delete(created); settle(); },
    };
    writers.add(created);
    return created;
  }
  /** Seals what is buffered and the final segment, then zeroes the key: the rest is ciphertext only. */
  function close(writer: Writer): void {
    if (writer.ended) return;
    writer.ended = true;
    if (writer.key && !writer.failed) {
      flush(writer);
      if (writer.dropped) gap(writer);
      enqueue(writer, Uint8Array.of(Segment.End), true);
    }
    zero(writer);
    if (writer.failed || (writer.kind === 'cmd' && writer.commands === 0 && !writer.sink && !writer.opening)) {
      dropQueue(writer);
      writer.settle();
      return;
    }
    if (writer.sink) pump(writer);
    else if (writer.header && !writer.opening) void openFile(writer);
  }
  function stop(record: Live, problem: RecordingProblem): void {
    if (record.status) record.status = { ...record.status, state: 'stopped', problem };
    for (const item of [record.out, record.cmd]) if (item) close(item);
    record.scanner = undefined;
    changed(record);
  }
  async function fail(writer: Writer): Promise<void> {
    writer.failed = true;
    dropQueue(writer);
    if (!writer.ended) { writer.ended = true; zero(writer); }
    if (writer.entry) writer.entry.state = 'incomplete';
    const sink = writer.sink;
    writer.sink = undefined;
    await sink?.close().catch(() => undefined);
    if (writer.discard && writer.entry) {
      if (await files.remove(writer.entry.name, writer.entry.file)) index.delete(writer.entry.id);
    }
    if (!writer.record.finished) stop(writer.record, 'write-failed');
    writer.settle();
  }
  async function openFile(writer: Writer): Promise<void> {
    if (writer.opening || writer.sink || writer.failed || !writer.header) return;
    if (writer.discard) { dropQueue(writer); writer.settle(); return; }
    writer.opening = true;
    try {
      const name = `${writer.kind}-${writer.id}.part`;
      const sink = await files.create(name);
      writer.entry = {
        kind: writer.kind, id: writer.id, name, identity: writer.identity, block: writer.block, hash: writer.hash,
        vaultId: writer.vaultId!, envelope: writer.envelope!, file: sink.identity, bytes: 0, state: 'live',
      };
      index.set(writer.id, writer.entry);
      writer.sink = sink;
      await sink.write(writer.header);
      writer.bytes += writer.header.length;
      writer.entry.bytes = writer.header.length;
    } catch {
      writer.opening = false;
      await fail(writer);
      return;
    }
    writer.opening = false;
    pump(writer);
  }
  function pump(writer: Writer): void {
    if (writer.pumping || !writer.sink) return;
    writer.pumping = true;
    void (async () => {
      try {
        while (writer.queue.length) {
          const frame = writer.queue.shift()!;
          try { await writer.sink!.write(frame); } finally {
            writer.pending -= frame.length;
            totalPending -= frame.length;
          }
          if (writer.entry) writer.entry.bytes += frame.length;
        }
        if (writer.ended) await finalize(writer);
      } catch {
        writer.pumping = false;
        await fail(writer);
        return;
      }
      writer.pumping = false;
    })();
  }
  async function finalize(writer: Writer): Promise<void> {
    const sink = writer.sink!;
    const entry = writer.entry!;
    writer.sink = undefined;
    await sink.sync();
    await sink.close();
    if (writer.discard) {
      if (await files.remove(entry.name, entry.file)) index.delete(entry.id);
    } else {
      const sealed = entry.name.replace(/\.part$/u, '.ssr');
      await files.rename(entry.name, sealed, entry.file);
      entry.name = sealed;
      entry.state = 'complete';
      if (writer.forget.size) {
        const keys = options.keys();
        if (keys) await rewrite([entry], writer.forget, keys, epoch).catch(() => undefined);
      }
    }
    writer.settle();
    void sweep();
  }
  function wrap(record: Live, keys: RecordingKeys): void {
    const pending = [record.out, record.cmd].filter((item): item is Writer => !!item);
    // The service copies nothing: hand it copies so ending a writer can zero its own key at once.
    const copies = pending.map((item) => ({ recordingId: item.id, key: Buffer.from(item.key!) }));
    let settled = false;
    const timer = setTimeout(() => apply({ ok: false, reason: 'unavailable' }), limits.keyDeadlineMs);
    timer.unref?.();
    function apply(result: Awaited<ReturnType<RecordingKeys['seal']>>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const copy of copies) copy.key.fill(0);
      // A result after a lock, quit or failure discards everything sealed so far: nothing reaches disk.
      if (!result.ok || record.epoch !== epoch || disposed || result.envelopes.length !== pending.length) {
        for (const item of pending) { item.discard = true; close(item); dropQueue(item); zero(item); item.settle(); }
        lastProblem = 'key-unavailable';
        if (!record.finished && record.status) { record.status = { ...record.status, state: 'stopped', problem: 'key-unavailable' }; record.scanner = undefined; changed(record); }
        return;
      }
      lastProblem = null;
      pending.forEach((item, at) => {
        item.vaultId = result.vaultId;
        item.envelope = result.envelopes[at]!;
        item.header = Buffer.concat([item.block, u16(Buffer.byteLength(result.vaultId)), Buffer.from(result.vaultId, 'utf8'), u16(item.envelope.length), item.envelope]);
        if (item.discard) { dropQueue(item); if (item.ended) item.settle(); }
        else if (item.kind === 'out' || item.commands > 0) void openFile(item);
      });
      if (!record.finished && record.status?.state === 'starting') { record.status = { ...record.status, state: 'on' }; changed(record); }
    }
    keys.seal(copies).then(apply, () => apply({ ok: false, reason: 'error' }));
  }
  function output(record: Live, chunk: Uint8Array): void {
    const out = record.out;
    if (out && !out.ended && out.plain) {
      const dropping = out.dropped > 0
        ? out.pending >= limits.lowWater || totalPending >= limits.globalHighWater
        : out.pending >= limits.highWater || totalPending >= limits.globalHighWater;
      if (dropping) {
        if (out.dropped === 0) {
          // Bytes already buffered keep their place before the gap.
          flush(out);
          if (record.status && !record.status.gaps) { record.status = { ...record.status, gaps: true }; changed(record); }
        }
        out.dropped += chunk.length;
      } else {
        if (out.dropped) { flush(out); gap(out); }
        for (let offset = 0; offset < chunk.length;) {
          const count = Math.min(chunk.length - offset, limits.segmentBytes - out.used);
          out.plain.set(chunk.subarray(offset, offset + count), 1 + out.used);
          out.used += count;
          offset += count;
          if (out.used === limits.segmentBytes) flush(out);
        }
        if (out.bytes >= cap('out')) stop(record, 'size-limit');
      }
    }
    if (record.scanner) for (const command of record.scanner.feed(chunk)) accept(record, command);
  }
  function accept(record: Live, command: RecordableCommand): void {
    const writer = record.cmd;
    if (!writer || writer.ended || !writer.key) return;
    const at = now();
    if (at - record.lastCommandAt < limits.commandIntervalMs) return;
    record.lastCommandAt = at;
    const text = Buffer.from(command, 'utf8');
    const body = Buffer.alloc(9 + text.length);
    body[0] = Segment.Command;
    body.writeBigUInt64BE(BigInt(at), 1);
    text.copy(body, 9);
    try { enqueue(writer, body); } finally { body.fill(0); text.fill(0); }
    writer.commands += 1;
    if (writer.header && !writer.sink) void openFile(writer);
    if (cache) {
      const line = Buffer.from(`${record.scope}\t${at}\t${command}\n`, 'utf8');
      const next = Buffer.concat([cache.bytes, line]);
      cache.bytes.fill(0);
      line.fill(0);
      cache.bytes = next;
    }
    if (writer.bytes >= cap('cmd')) stop(record, 'size-limit');
  }
  function finish(record: Live): void {
    if (record.finished) return;
    record.finished = true;
    record.scanner = undefined;
    for (const item of [record.out, record.cmd]) if (item) close(item);
    live.delete(record.key);
    if (live.size === 0 && flushTimer) { clearInterval(flushTimer); flushTimer = undefined; }
    changed(record);
  }

  async function parseHeader(name: string, kind: Kind, id: string) {
    const source = await files.read(name);
    try {
      const head = Buffer.from(await source.read(0, 12));
      if (head.length < 12 || !head.subarray(0, 8).equals(MAGIC)) return undefined;
      const length = head.readUInt32BE(8);
      if (length < 2 || length > MAX_IDENTITY) return undefined;
      const rest = Buffer.from(await source.read(12, length + 2 + MAX_VAULT_ID + 2 + KEY_ENVELOPE));
      if (rest.length < length + 2) return undefined;
      const identity: unknown = JSON.parse(textDecoder.decode(rest.subarray(0, length)));
      if (!isIdentity(identity, kind, id)) return undefined;
      const vaultLength = rest.readUInt16BE(length);
      if (vaultLength < 1 || vaultLength > MAX_VAULT_ID || rest.length < length + 2 + vaultLength + 2) return undefined;
      const vaultId = textDecoder.decode(rest.subarray(length + 2, length + 2 + vaultLength));
      const envelopeLength = rest.readUInt16BE(length + 2 + vaultLength);
      const start = length + 4 + vaultLength;
      if (envelopeLength !== KEY_ENVELOPE || rest.length < start + envelopeLength) return undefined;
      const block = Buffer.concat([head, rest.subarray(0, length)]);
      return { identity, block, hash: sha256(block), vaultId, envelope: Uint8Array.from(rest.subarray(start, start + envelopeLength)), offset: 12 + start + envelopeLength };
    } catch { return undefined; } finally { await source.close().catch(() => undefined); }
  }
  /** Sequential, bounded-memory read of one file; every verdict is authenticated (the file name is only a hint). */
  async function readJournal(entry: Entry, key: Uint8Array, visit: (record: JournalRecord) => void | Promise<void>): Promise<Verdict> {
    const parsed = await parseHeader(entry.name, entry.kind, entry.id);
    if (!parsed || !parsed.block.equals(entry.block)) return 'corrupt';
    const source = await files.read(entry.name);
    try {
      let offset = parsed.offset;
      for (let counter = 0; ; counter++) {
        const head = Buffer.from(await source.read(offset, SEGMENT_HEADER));
        if (head.length < SEGMENT_HEADER) return 'incomplete';
        const length = head.readUInt32BE(0);
        const last = head[4]!;
        if (last > 1 || length <= 16 || length > SEGMENT_SEALED_MAX) return 'corrupt';
        const sealed = await source.read(offset + SEGMENT_HEADER, length);
        if (sealed.length < length) return 'incomplete';
        let plain: Buffer;
        try { plain = openSegment(key, entry.hash, counter, last === 1, sealed); } catch { return 'corrupt'; }
        try {
          const type = plain[0];
          if (last === 1) {
            if (type !== Segment.End || plain.length !== 1) return 'corrupt';
            return (await source.read(offset + SEGMENT_HEADER + length, 1)).length ? 'corrupt' : 'complete';
          }
          if (type === Segment.Output && plain.length > 1) await visit({ type: 'output', bytes: plain.subarray(1) });
          else if (type === Segment.Gap && plain.length === 9) await visit({ type: 'gap', bytes: Number(plain.readBigUInt64BE(1)) });
          else if (type === Segment.Command && plain.length > 9) {
            let text: string;
            try { text = textDecoder.decode(plain.subarray(9)); } catch { return 'corrupt'; }
            if (!isCommandText(text)) return 'corrupt';
            await visit({ type: 'command', at: Number(plain.readBigUInt64BE(1)), text });
          } else return 'corrupt';
        } finally { plain.fill(0); }
        offset += SEGMENT_HEADER + length;
      }
    } finally { await source.close().catch(() => undefined); }
  }
  async function openKeys(keys: RecordingKeys, entries: readonly Entry[]) {
    return entries.length ? keys.open(entries.map((entry) => ({ recordingId: entry.id, vaultId: entry.vaultId, envelope: entry.envelope })))
      : { ok: true as const, keys: [] as (Uint8Array | undefined)[] };
  }

  function purgeCache(): void {
    if (cache) { clearTimeout(cache.timer); cache.bytes.fill(0); }
    cache = undefined;
    loading = undefined;
    loads += 1;
  }
  function loadCache(): Promise<Buffer | SuggestOutcome> {
    if (cache) return Promise.resolve(cache.bytes);
    if (loading) return loading;
    const keys = options.keys();
    if (!keys) return Promise.resolve({ status: 'key-unavailable' });
    const since = epoch;
    const ticket = loads;
    const attempt: Promise<Buffer | SuggestOutcome> = (async () => {
      const entries = [...index.values()].filter((entry) => entry.kind === 'cmd');
      const opened = await openKeys(keys, entries);
      if (!opened.ok) return { status: 'key-unavailable' } as const;
      const parts: { at: number; line: Buffer }[] = [];
      try {
        for (const [at, entry] of entries.entries()) {
          const key = opened.keys[at];
          if (!key || since !== epoch) continue;
          await readJournal(entry, key, (record) => {
            if (record.type === 'command') parts.push({ at: record.at, line: Buffer.from(`${entry.identity.scope}\t${record.at}\t${record.text}\n`, 'utf8') });
          }).catch(() => undefined);
        }
      } finally { for (const key of opened.keys) key?.fill(0); }
      if (since !== epoch || ticket !== loads) {
        for (const part of parts) part.line.fill(0);
        return { status: 'locked' } as const;
      }
      parts.sort((a, b) => a.at - b.at);
      const bytes = Buffer.concat(parts.map((part) => part.line));
      for (const part of parts) part.line.fill(0);
      const timer = setTimeout(purgeCache, limits.historyTtlMs);
      timer.unref?.();
      cache = { bytes, timer };
      return bytes;
    })();
    const guarded = attempt.catch((): SuggestOutcome => ({ status: 'key-unavailable' }));
    loading = guarded;
    void guarded.finally(() => { if (loading === guarded) loading = undefined; });
    return guarded;
  }
  /** Re-seals each history file that holds one of `texts` without those lines, under a fresh key, then unlinks it. */
  async function rewrite(entries: readonly Entry[], texts: ReadonlySet<string>, keys: RecordingKeys, since: number): Promise<number | 'key-unavailable' | 'locked' | 'failed'> {
    const opened = await openKeys(keys, entries);
    if (!opened.ok) return 'key-unavailable';
    const plans: { entry: Entry; commands: { at: number; text: string }[] }[] = [];
    try {
      for (const [at, entry] of entries.entries()) {
        const key = opened.keys[at];
        if (!key || since !== epoch) continue;
        const commands: { at: number; text: string }[] = [];
        let hit = false;
        const verdict = await readJournal(entry, key, (record) => {
          if (record.type !== 'command') return;
          if (texts.has(record.text)) hit = true;
          else commands.push({ at: record.at, text: record.text });
        }).catch(() => 'corrupt' as const);
        if (hit && verdict !== 'corrupt') plans.push({ entry, commands });
      }
    } finally { for (const key of opened.keys) key?.fill(0); }
    if (since !== epoch) return 'locked';
    if (!plans.length) return 0;
    const fresh = plans.filter((plan) => plan.commands.length).map((plan) => ({ plan, id: randomUUID(), key: randomBytes(CONTENT_KEY_BYTES) }));
    try {
      const sealed = fresh.length ? await keys.seal(fresh.map((item) => ({ recordingId: item.id, key: Buffer.from(item.key) })))
        : { ok: true as const, vaultId: '', envelopes: [] as Uint8Array[] };
      if (!sealed.ok) return 'key-unavailable';
      if (since !== epoch) return 'locked';
      for (const [at, item] of fresh.entries()) {
        const identity: Identity = { ...item.plan.entry.identity, id: item.id };
        const block = identityBlock(identity);
        const hash = sha256(block);
        const envelope = sealed.envelopes[at]!;
        const frames = [Buffer.concat([block, u16(Buffer.byteLength(sealed.vaultId)), Buffer.from(sealed.vaultId, 'utf8'), u16(envelope.length), envelope])];
        item.plan.commands.forEach((command, counter) => {
          const text = Buffer.from(command.text, 'utf8');
          const body = Buffer.alloc(9 + text.length);
          body[0] = Segment.Command;
          body.writeBigUInt64BE(BigInt(command.at), 1);
          text.copy(body, 9);
          frames.push(Buffer.from(sealSegment(item.key, hash, counter, false, body)));
          body.fill(0);
          text.fill(0);
        });
        frames.push(Buffer.from(sealSegment(item.key, hash, item.plan.commands.length, true, Uint8Array.of(Segment.End))));
        const name = `cmd-${item.id}.part`;
        const sink = await files.create(name);
        try {
          await sink.write(Buffer.concat(frames));
          await sink.sync();
        } finally { await sink.close(); }
        await files.rename(name, `cmd-${item.id}.ssr`, sink.identity);
        index.set(item.id, {
          kind: 'cmd', id: item.id, name: `cmd-${item.id}.ssr`, identity, block, hash, vaultId: sealed.vaultId, envelope,
          file: sink.identity, bytes: frames.reduce((sum, frame) => sum + frame.length, 0), state: 'complete',
        });
      }
      for (const plan of plans) {
        if (await files.remove(plan.entry.name, plan.entry.file)) index.delete(plan.entry.id);
      }
      return plans.length;
    } catch { return 'failed'; } finally { for (const item of fresh) item.key.fill(0); }
  }

  function sweep(): Promise<void> {
    if (sweeping) { sweepAgain = true; return sweeping; }
    sweeping = (async () => {
      do {
        sweepAgain = false;
        const at = now();
        for (const kind of ['out', 'cmd'] as const) {
          const days = kind === 'out' ? policy.logDays : policy.historyDays;
          const entries = [...index.values()].filter((entry) => entry.kind === kind);
          const closed = entries.filter((entry) => entry.state !== 'live').sort((a, b) => a.identity.startedAt - b.identity.startedAt);
          const victims = new Set(closed.filter((entry) => at - entry.identity.startedAt > days * DAY));
          let total = entries.reduce((sum, entry) => sum + (victims.has(entry) ? 0 : entry.bytes), 0);
          let count = entries.length - victims.size;
          for (const entry of closed) {
            if (total <= cap(kind) && count <= limits.maxFilesPerKind) break;
            if (victims.has(entry)) continue;
            victims.add(entry);
            total -= entry.bytes;
            count -= 1;
          }
          for (const entry of victims) if (await files.remove(entry.name, entry.file)) index.delete(entry.id);
        }
      } while (sweepAgain);
    })().catch(() => undefined).finally(() => { sweeping = undefined; });
    return sweeping;
  }
  const summary = (entry: Entry): RecordingSummary => ({
    id: entry.id, label: entry.identity.label, environment: entry.identity.environment, local: entry.identity.local,
    endpoint: entry.identity.endpoint, startedAt: entry.identity.startedAt, bytes: entry.bytes,
    state: entry.state === 'live' ? 'recording' : entry.state,
  });
  function state(): RecordingState {
    const logs = [...index.values()].filter((entry) => entry.kind === 'out').sort((a, b) => b.identity.startedAt - a.identity.startedAt);
    const history = [...index.values()].filter((entry) => entry.kind === 'cmd');
    return {
      policy: { ...policy }, problem: rootSafe ? lastProblem : 'storage-unavailable',
      logs: logs.slice(0, MAX_LISTED_RECORDINGS).map(summary), logCount: logs.length,
      logBytes: logs.reduce((sum, entry) => sum + entry.bytes, 0),
      historyFiles: history.length, historyBytes: history.reduce((sum, entry) => sum + entry.bytes, 0),
    };
  }
  /** Stops capture of `kinds` (or one recording id) in live panes; `discard` also unlinks their files. */
  function stopKinds(match: (writer: Writer) => boolean, discard: boolean): void {
    for (const record of live.values()) {
      let touched = false;
      for (const item of [record.out, record.cmd]) {
        if (!item || item.discard || !match(item)) continue;
        if (discard) item.discard = true;
        close(item);
        touched = true;
        if (record.status) record.status = { ...record.status, [item.kind === 'out' ? 'output' : 'commands']: false };
        if (item.kind === 'cmd') record.scanner = undefined;
      }
      if (!touched) continue;
      if (record.status && !record.status.output && !record.status.commands) record.status = null;
      changed(record);
    }
  }

  const ready = (async () => {
    rootSafe = await files.open();
    const stored = await files.readPolicy();
    if (isRecordingPolicy(stored)) policy = { ...stored };
    const listed = rootSafe ? await files.list() : undefined;
    if (rootSafe && !listed) rootSafe = false;
    for (const info of listed ?? []) {
      const match = RECORDING_NAME.exec(info.name);
      if (!match) continue;
      const kind = match[1] as Kind;
      const parsed = await parseHeader(info.name, kind, match[2]!);
      if (!parsed) continue;
      index.set(parsed.identity.id, {
        kind, id: parsed.identity.id, name: info.name, identity: parsed.identity, block: parsed.block, hash: parsed.hash,
        vaultId: parsed.vaultId, envelope: parsed.envelope, file: { dev: info.dev, ino: info.ino }, bytes: info.size,
        state: match[3] === 'ssr' ? 'complete' : 'incomplete',
      });
    }
    await sweep();
    if (!disposed) {
      sweepTimer = setInterval(() => void sweep(), limits.sweepMs);
      sweepTimer.unref?.();
    }
  })().catch(() => { rootSafe = false; });

  return {
    ready,
    observe(session) {
      if (disposed || (!policy.logs && !policy.history)) return undefined;
      const key = `${session.sessionId}:${session.generation}`;
      if (live.has(key)) return undefined;
      const record: Live = {
        key, session, scope: session.hostId ?? 'local', epoch, lastCommandAt: Number.NEGATIVE_INFINITY, finished: false,
        status: { output: policy.logs, commands: policy.history, state: 'starting', gaps: false, problem: null },
      };
      live.set(key, record);
      const keys = options.keys();
      if (!rootSafe || !keys) {
        record.status = { ...record.status!, state: 'stopped', problem: 'storage-unavailable' };
        lastProblem = 'storage-unavailable';
        changed(record);
        return { output() {}, end: () => finish(record) };
      }
      if (policy.logs) record.out = writer(record, 'out');
      if (policy.history) { record.cmd = writer(record, 'cmd'); record.scanner = new CommandScanner(); }
      flushTimer ??= setInterval(() => {
        for (const item of live.values()) if (item.out && !item.out.ended) flush(item.out);
      }, limits.flushMs);
      flushTimer.unref?.();
      changed(record);
      wrap(record, keys);
      void sweep();
      return {
        output: (chunk) => { try { output(record, chunk); } catch { stop(record, 'write-failed'); } },
        end: () => finish(record),
      };
    },
    status(sessionId, generation) {
      const status = live.get(`${sessionId}:${generation}`)?.status;
      return status ? { ...status } : null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    state,
    async configure(next) {
      if (disposed || !isRecordingPolicy(next)) return { status: 'failed' };
      const enabling = (next.logs && !policy.logs) || (next.history && !policy.history);
      if (enabling) {
        if (!rootSafe) return { status: 'failed' };
        const keys = options.keys();
        if (!keys) return { status: 'key-unavailable', reason: 'unavailable' };
        const prepared = await keys.prepare();
        if (!prepared.ok) return { status: 'key-unavailable', reason: prepared.reason };
        const probe = await keys.seal([]);
        if (!probe.ok) return { status: 'key-unavailable', reason: probe.reason };
      }
      if (!(await files.writePolicy(next))) return { status: 'failed' };
      const previous = policy;
      policy = { ...next };
      if (previous.logs && !next.logs) stopKinds((item) => item.kind === 'out', false);
      if (previous.history && !next.history) { stopKinds((item) => item.kind === 'cmd', false); purgeCache(); }
      await sweep();
      return { status: 'saved', state: state() };
    },
    async delete(target) {
      const kinds: readonly Kind[] = target.kind === 'logs' ? ['out'] : target.kind === 'history' ? ['cmd'] : target.kind === 'all' ? ['out', 'cmd'] : [];
      const matches = (kind: Kind, id: string) => target.kind === 'log' ? kind === 'out' && id === target.id : kinds.includes(kind);
      stopKinds((item) => matches(item.kind, item.id), true);
      if (kinds.includes('cmd')) purgeCache();
      for (const entry of [...index.values()]) {
        if (entry.state === 'live' || !matches(entry.kind, entry.id)) continue;
        if (await files.remove(entry.name, entry.file)) index.delete(entry.id);
      }
      // Files whose header could not be read are not indexed; a bulk delete still removes them.
      if (kinds.length && rootSafe) {
        const liveIds = new Set([...writers].map((item) => item.id));
        for (const info of await files.list() ?? []) {
          const match = RECORDING_NAME.exec(info.name);
          if (match && kinds.includes(match[1] as Kind) && !index.has(match[2]!) && !liveIds.has(match[2]!)) await files.remove(info.name, info);
        }
      }
      return state();
    },
    async export(target, destination) {
      const since = epoch;
      const keys = options.keys();
      const entries = target.kind === 'log'
        ? [index.get(target.id)].filter((entry): entry is Entry => entry?.kind === 'out')
        : [...index.values()].filter((entry) => entry.kind === 'cmd').sort((a, b) => a.identity.startedAt - b.identity.startedAt);
      if (!entries.length) return { status: 'not-found' };
      if (!keys) return { status: 'key-unavailable' };
      const opened = await openKeys(keys, entries);
      if (!opened.ok) return { status: 'key-unavailable' };
      let verdict = 'complete' as Verdict;
      let gaps = 0;
      try {
        if (since !== epoch) return { status: 'aborted' };
        if (target.kind === 'log' && !opened.keys[0]) return { status: 'corrupt' };
        const abort = new Error('aborted');
        const saved = await files.exportTo(destination, async (write) => {
          for (const [at, entry] of entries.entries()) {
            const key = opened.keys[at];
            if (!key) continue;
            const result = await readJournal(entry, key, async (record) => {
              if (since !== epoch) throw abort;
              if (record.type === 'output') await write(record.bytes);
              else if (record.type === 'gap') { gaps += 1; await write(Buffer.from(`\r\n[ssterm: ${record.bytes} bytes not recorded]\r\n`)); }
              else {
                const line = Buffer.from(`${new Date(record.at).toISOString()}\t${entry.identity.label.replace(/[\t\r\n]/gu, ' ')}\t${record.text}\n`, 'utf8');
                try { await write(line); } finally { line.fill(0); }
              }
            });
            if (result === 'corrupt' && target.kind === 'log') { verdict = 'corrupt'; return false; }
            if (result === 'incomplete') {
              verdict = 'incomplete';
              if (target.kind === 'log') await write(Buffer.from('\r\n[ssterm: recording incomplete]\r\n'));
            }
          }
          return since === epoch;
        });
        if (since !== epoch) return { status: 'aborted' };
        if (verdict === 'corrupt') return { status: 'corrupt' };
        return saved === 'saved' ? { status: 'saved', incomplete: verdict === 'incomplete', gaps } : { status: saved === 'aborted' ? 'aborted' : 'failed' };
      } finally { for (const key of opened.keys) key?.fill(0); }
    },
    async suggest(scope, prefix) {
      if (!policy.history) return { status: 'off' };
      const loaded = await loadCache();
      if (!Buffer.isBuffer(loaded)) return loaded;
      const excluded = new Set<string>();
      for (const record of live.values()) if (record.scope === scope && record.cmd) for (const text of record.cmd.forget) excluded.add(text);
      const text = loaded.toString('utf8');
      const suggestions: string[] = [];
      const seen = new Set<string>();
      for (let end = text.length; end > 0 && suggestions.length < MAX_SUGGESTIONS;) {
        const start = text.lastIndexOf('\n', end - 2) + 1;
        const line = text.slice(start, end - 1);
        end = start;
        const first = line.indexOf('\t');
        const second = line.indexOf('\t', first + 1);
        if (first < 0 || second < 0 || line.slice(0, first) !== scope) continue;
        const command = line.slice(second + 1);
        if (command === prefix || !command.startsWith(prefix) || seen.has(command) || excluded.has(command)) continue;
        seen.add(command);
        suggestions.push(command);
      }
      return { status: 'ok', suggestions };
    },
    async forget(scope, text) {
      if (!policy.history) return { status: 'off' };
      if (!isCommandText(text)) return { status: 'not-found' };
      const keys = options.keys();
      if (!keys) return { status: 'key-unavailable' };
      const since = epoch;
      purgeCache();
      let flagged = false;
      for (const record of live.values()) {
        if (record.scope === scope && record.cmd && !record.cmd.discard) { record.cmd.forget.add(text); flagged = true; }
      }
      const closed = [...index.values()].filter((entry) => entry.kind === 'cmd' && entry.state !== 'live' && entry.identity.scope === scope);
      const rewritten = await rewrite(closed, new Set([text]), keys, since);
      if (typeof rewritten !== 'number') return { status: rewritten };
      return { status: rewritten > 0 || flagged ? 'forgotten' : 'not-found' };
    },
    lock() {
      epoch += 1;
      purgeCache();
    },
    dispose() {
      return disposing ??= (async () => {
        disposed = true;
        if (sweepTimer) clearInterval(sweepTimer);
        for (const record of [...live.values()]) finish(record);
        purgeCache();
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          Promise.all([...writers].map((item) => item.done)),
          new Promise<void>((done) => { timer = setTimeout(done, limits.drainMs); }),
        ]);
        clearTimeout(timer);
        for (const item of [...writers]) { dropQueue(item); zero(item); }
        await sweeping;
      })();
    },
  };
}
