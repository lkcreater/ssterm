import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open as openNative, readdir, readFile, rename as renameNative, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, seal, PROTECTION_FORMAT, ENVELOPE_VERSION } from '../../packages/adapters/src/protection.ts';
import { createRecordingFiles, type RecordingFiles } from '../../packages/adapters/src/recording-files.ts';
import { createRecorder, type Recorder, type RecorderLimits } from '../../packages/services/src/recorder.ts';
import { DEFAULT_RECORDING_POLICY, type RecordingKeyProblem, type RecordingKeys, type RecordingPolicy } from '../../packages/domain/src/recording.ts';
import type { ObservedTerminal } from '../../packages/domain/src/index.ts';

const DAY = 86_400_000;
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(condition: () => boolean | Promise<boolean>, message: string, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) { if (Date.now() > deadline) assert.fail(message); await delay(5); }
}
/** An in-memory vault content key with call counters and switchable failures (no Keychain). */
function memoryKeys() {
  const vault = randomBytes(32);
  const vaultId = randomUUID();
  const calls = { prepare: 0, seal: 0, open: 0 };
  const control: { failure?: RecordingKeyProblem; gate?: Promise<void> } = {};
  const binding = (recordingId: string) => ({ vaultId, recordingId, field: 'recording-key' as const });
  const keys: RecordingKeys = {
    async prepare() { calls.prepare++; return control.failure ? { ok: false, reason: control.failure } : { ok: true }; },
    async seal(items) {
      calls.seal++;
      await control.gate;
      if (control.failure) return { ok: false, reason: control.failure };
      return { ok: true, vaultId, envelopes: items.map((item) => seal(vault, binding(item.recordingId), item.key)) };
    },
    async open(items) {
      calls.open++;
      if (control.failure) return { ok: false, reason: control.failure };
      return { ok: true, keys: items.map((item) => {
        try { return item.vaultId === vaultId ? open(vault, binding(item.recordingId), { bodyEnvelope: item.envelope, envelopeVersion: ENVELOPE_VERSION, protectionFormat: PROTECTION_FORMAT }) : undefined; }
        catch { return undefined; }
      }) };
    },
  };
  return { keys, calls, control };
}
const ON: RecordingPolicy = { ...DEFAULT_RECORDING_POLICY, logs: true, history: true };
const session = (overrides: Partial<ObservedTerminal> = {}): ObservedTerminal => ({
  ownerId: 'window:1:1', sessionId: randomUUID(), generation: 1, hostId: 'host-a', local: false, label: 'Lab ห้อง',
  endpoint: 'fixture@127.0.0.1:2222', environment: 'PROD', ...overrides,
});
const marker = (text: string) => Buffer.from(`\x1b]633;E;${text.replaceAll('\\', '\\\\').replaceAll(';', '\\x3b')}\x07`, 'utf8');

async function setup(t: TestContext, options: { limits?: Partial<RecorderLimits>; policy?: RecordingPolicy | null; files?: (files: RecordingFiles) => RecordingFiles; keys?: () => RecordingKeys | undefined; io?: Parameters<typeof createRecordingFiles>[0]['io'] } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'ssterm-recorder-'));
  const root = join(profile, 'recordings');
  const memory = memoryKeys();
  const clock = { now: 1_800_000_000_000 };
  const base = createRecordingFiles({ root, io: options.io });
  const files = options.files ? options.files(base) : base;
  let recorder: Recorder | undefined;
  const make = async () => {
    recorder = createRecorder({ files, keys: options.keys ?? (() => memory.keys), now: () => clock.now, limits: { flushMs: 20, ...options.limits } });
    await recorder.ready;
    return recorder;
  };
  t.after(async () => { await recorder?.dispose(); await rm(profile, { recursive: true, force: true }); });
  const current = await make();
  if (options.policy !== null) assert.equal((await current.configure(options.policy ?? ON)).status, 'saved');
  /** Raw bytes of every file under the root, for plaintext scans. */
  const raw = async () => Buffer.concat(await Promise.all((await readdir(root)).map((name) => readFile(join(root, name)))));
  const names = async () => (await readdir(root)).sort();
  const exported = async (target: Parameters<Recorder['export']>[0]) => {
    const destination = join(profile, `export-${randomUUID()}.txt`);
    const outcome = await recorder!.export(target, destination);
    return { outcome, text: outcome.status === 'saved' ? await readFile(destination, 'utf8') : '' };
  };
  return { profile, root, memory, clock, files, get recorder() { return recorder!; }, restart: make, raw, names, exported };
}
/** Observes one generation, feeds frames (advancing the clock past the command rate limit) and ends it. */
async function record(recorder: Recorder, clock: { now: number }, frames: (string | Buffer)[], target = session()) {
  const observer = recorder.observe(target);
  assert.ok(observer);
  for (const frame of frames) { clock.now += 1_000; observer.output(typeof frame === 'string' ? Buffer.from(frame, 'utf8') : frame); }
  observer.end();
  return target;
}
/** Waits until exactly `count` recordings are sealed and none is still open. */
const settled = (s: { names(): Promise<string[]> }, count: number) => until(async () => { const names = await s.names(); return !names.some((name) => name.endsWith(".part")) && names.filter((name) => /^(out|cmd)-.*\.ssr$/u.test(name)).length === count; }, `expected ${count} sealed recordings`);

test('off by default: nothing is observed and the private root holds only its marker', async (t) => {
  const s = await setup(t, { policy: null });
  assert.deepEqual(s.recorder.state().policy, DEFAULT_RECORDING_POLICY);
  assert.equal(s.recorder.observe(session()), undefined);
  assert.deepEqual(await s.names(), ['.ssterm-recordings']);
  assert.equal((await lstat(s.root)).mode & 0o777, 0o700);
  assert.equal((await s.recorder.configure({ ...DEFAULT_RECORDING_POLICY, logDays: 7 })).status, 'saved');
  assert.deepEqual(await s.names(), ['.ssterm-recordings', 'policy.json']);
  assert.equal((await lstat(join(s.root, 'policy.json'))).mode & 0o777, 0o600);
  assert.equal(s.memory.calls.prepare, 0, 'saving an off policy never touches the key');
});

test('a recorded generation exports exactly its output, keeps commands encrypted and stores no plaintext', async (t) => {
  const s = await setup(t);
  const needle = `NEEDLE_OUT_${randomUUID()}`;
  const command = `echo NEEDLE_CMD_${randomUUID()}`;
  const target = session();
  const frames = ['prompt$ ', marker(command), `${needle}\r\n`, Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xe0, 0xb8]), Buffer.from([0x81, 0x0a])];
  const observer = s.recorder.observe(target)!;
  assert.deepEqual(s.recorder.status(target.sessionId, 1), { output: true, commands: true, state: 'starting', gaps: false, problem: null });
  for (const frame of frames) { s.clock.now += 1_000; observer.output(typeof frame === 'string' ? Buffer.from(frame) : frame); }
  await until(() => s.recorder.status(target.sessionId, 1)?.state === 'on', 'recording did not start');
  observer.end();
  assert.equal(s.recorder.status(target.sessionId, 1), null);
  await settled(s, 2);
  const names = await s.names();
  assert.equal(names.filter((name) => /^out-.*\.ssr$/u.test(name)).length, 1);
  assert.equal(names.filter((name) => /^cmd-.*\.ssr$/u.test(name)).length, 1);
  for (const name of names.filter((name) => /\.ssr$/u.test(name))) assert.equal((await lstat(join(s.root, name))).mode & 0o777, 0o600);
  const raw = await s.raw();
  assert.ok(!raw.includes(needle) && !raw.includes('NEEDLE_CMD'), 'no plaintext at rest');
  const [log] = s.recorder.state().logs;
  assert.equal(log!.state, 'complete');
  assert.equal(log!.environment, 'PROD');
  const { outcome, text } = await s.exported({ kind: 'log', id: log!.id });
  assert.deepEqual(outcome, { status: 'saved', incomplete: false, gaps: 0 });
  assert.deepEqual(Buffer.from(text, 'utf8'), Buffer.concat(frames.map((frame) => typeof frame === 'string' ? Buffer.from(frame) : frame)));
  const history = await s.exported({ kind: 'history' });
  assert.match(history.text, new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[^\\t]+\\tLab ห้อง\\t${command}\\n$`, 'u'));
});

test('a slow disk drops output with an authenticated gap and never blocks the stream', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const s = await setup(t, {
    limits: { highWater: 256 * 1024, lowWater: 64 * 1024, globalHighWater: 1024 * 1024 },
    files: (files) => ({ ...files, async create(name) {
      const sink = await files.create(name);
      return { ...sink, identity: sink.identity, async write(bytes) { await gate; return sink.write(bytes); } };
    } }),
  });
  const target = session();
  const observer = s.recorder.observe(target)!;
  await until(() => s.recorder.status(target.sessionId, 1)?.state === 'on', 'recording did not start');
  const prefix = Buffer.alloc(300 * 1024, 0x61);
  const dropped = Buffer.alloc(2 * 1024 * 1024, 0x62);
  const started = performance.now();
  observer.output(prefix);
  observer.output(dropped);
  assert.ok(performance.now() - started < 500, 'output() is synchronous');
  assert.equal(s.recorder.status(target.sessionId, 1)?.gaps, true);
  release();
  await until(async () => (await s.raw()).length > 300 * 1024, 'the queue drained');
  await delay(50);
  const suffix = Buffer.from('tail-after-gap');
  observer.output(suffix);
  observer.end();
  await settled(s, 1);
  const { outcome, text } = await s.exported({ kind: 'log', id: s.recorder.state().logs[0]!.id });
  assert.equal(outcome.status, 'saved');
  assert.equal(outcome.status === 'saved' && outcome.gaps, 1);
  const kept = text.slice(0, text.indexOf('\r\n[ssterm:'));
  const match = /\r\n\[ssterm: (\d+) bytes not recorded\]\r\n/u.exec(text)!;
  assert.ok(match);
  assert.equal(kept.length + Number(match[1]), prefix.length + dropped.length, 'export length = flooded bytes − recorded gaps');
  assert.ok(text.endsWith('tail-after-gap'));
});

test('write failure, size limit and missing keys stop visibly and fail closed', async (t) => {
  const failing = await setup(t, { files: (files) => ({ ...files, async create(name) {
    const sink = await files.create(name);
    return { ...sink, identity: sink.identity, write: async () => { throw Object.assign(new Error('disk'), { code: 'ENOSPC' }); } };
  } }) });
  const broken = session();
  const observer = failing.recorder.observe(broken)!;
  observer.output(Buffer.from('x'));
  await until(() => failing.recorder.status(broken.sessionId, 1)?.problem === 'write-failed', 'write failure not visible');
  assert.equal(failing.recorder.status(broken.sessionId, 1)?.state, 'stopped');
  observer.end();

  const capped = await setup(t, { policy: { ...ON, history: false, logMiB: 16 } });
  const big = session();
  const writer = capped.recorder.observe(big)!;
  const chunk = Buffer.alloc(1024 * 1024, 0x63);
  for (let i = 0; i < 17 && capped.recorder.status(big.sessionId, 1)?.state !== 'stopped'; i++) {
    writer.output(chunk);
    await until(() => capped.recorder.status(big.sessionId, 1)?.state !== 'starting', 'started');
    await delay(40);
  }
  assert.equal(capped.recorder.status(big.sessionId, 1)?.problem, 'size-limit');
  writer.end();

  const keyless = await setup(t, { policy: null, keys: () => undefined });
  await writeFile(join(keyless.root, 'policy.json'), JSON.stringify(ON), { mode: 0o600 });
  const reloaded = await keyless.restart();
  const local = session({ hostId: null, local: true });
  const none = reloaded.observe(local)!;
  assert.deepEqual(reloaded.status(local.sessionId, 1), { output: true, commands: true, state: 'stopped', gaps: false, problem: 'storage-unavailable' });
  none.output(Buffer.from('NEEDLE'));
  none.end();
  assert.equal(reloaded.state().problem, 'storage-unavailable');
  assert.deepEqual(await keyless.names(), ['.ssterm-recordings', 'policy.json']);
});

test('a key wrap that fails, times out or resolves after a lock writes nothing; one that finishes after the end writes all', async (t) => {
  const s = await setup(t, { limits: { keyDeadlineMs: 100 } });
  s.memory.control.failure = 'denied';
  const denied = session();
  s.recorder.observe(denied)!.output(Buffer.from('NEEDLE'));
  await until(() => s.recorder.status(denied.sessionId, 1)?.problem === 'key-unavailable', 'denied not visible');
  assert.equal(s.recorder.state().problem, 'key-unavailable');
  delete s.memory.control.failure;

  let release!: () => void;
  s.memory.control.gate = new Promise<void>((done) => { release = done; });
  const slow = session();
  s.recorder.observe(slow)!.output(Buffer.from('NEEDLE'));
  await until(() => s.recorder.status(slow.sessionId, 1)?.problem === 'key-unavailable', 'deadline not visible', 2_000);

  const locked = session();
  const observer = s.recorder.observe(locked)!;
  observer.output(Buffer.from('NEEDLE'));
  observer.end();
  s.recorder.lock();
  release();
  await delay(100);
  assert.deepEqual((await s.names()).filter((name) => name.startsWith('out-')), [], 'nothing reached disk');

  delete s.memory.control.gate;
  let late!: () => void;
  s.memory.control.gate = new Promise<void>((done) => { late = done; });
  const pending = session();
  const short = s.recorder.observe(pending)!;
  short.output(Buffer.from('kept-after-pending-wrap'));
  short.end();
  late();
  await until(async () => (await s.names()).some((name) => /^out-.*\.ssr$/u.test(name)), 'the pending wrap wrote the file');
  await settled(s, 1);
  const { text } = await s.exported({ kind: 'log', id: s.recorder.state().logs[0]!.id });
  assert.equal(text, 'kept-after-pending-wrap');
});

test('truncated and tampered files export honestly', async (t) => {
  const s = await setup(t, { policy: { ...ON, history: false } });
  await record(s.recorder, s.clock, ['first segment ', 'second']);
  await settled(s, 1);
  const [log] = s.recorder.state().logs;
  const name = (await s.names()).find((item) => item.startsWith('out-'))!;
  const path = join(s.root, name);
  const full = await readFile(path);
  await truncate(path, full.length - 10);
  const truncated = await s.exported({ kind: 'log', id: log!.id });
  assert.deepEqual(truncated.outcome, { status: 'saved', incomplete: true, gaps: 0 });
  assert.equal(truncated.text, 'first segment second\r\n[ssterm: recording incomplete]\r\n');
  const tampered = Buffer.from(full);
  tampered[tampered.length - 3]! ^= 1;
  await writeFile(path, tampered);
  assert.deepEqual((await s.exported({ kind: 'log', id: log!.id })).outcome, { status: 'corrupt' });
});

test('retention removes closed files by age, size and count, never live ones', async (t) => {
  const s = await setup(t, { policy: { ...ON, history: false }, limits: { maxFilesPerKind: 3 } });
  for (let i = 0; i < 4; i++) await record(s.recorder, s.clock, [`log ${i}`]);
  await settled(s, 3);
  await until(() => s.recorder.state().logCount === 3, 'count cap applied');
  const live = s.recorder.observe(session())!;
  live.output(Buffer.from('live'));
  await until(() => s.recorder.state().logs.some((log) => log.state === 'recording'), 'live file');
  s.clock.now += 31 * DAY;
  assert.equal((await s.recorder.configure({ ...ON, history: false })).status, 'saved');
  assert.deepEqual(s.recorder.state().logs.map((log) => log.state), ['recording'], 'age removes closed files only');
  live.end();
  await settled(s, 0);
  assert.equal(s.recorder.state().logCount, 0, "a live recording past its age goes once it closes");
});

test('retention by size removes the oldest closed logs first', async (t) => {
  const s = await setup(t, { policy: { ...ON, history: false, logMiB: 16 } });
  const MiB = Buffer.alloc(1024 * 1024, 0x64);
  for (let log = 0; log < 3; log++) {
    const observer = s.recorder.observe(session({ label: `size ${log}` }))!;
    for (let i = 0; i < 7; i++) { observer.output(MiB); await delay(20); }
    observer.end();
    s.clock.now += 1_000;
    await settled(s, log + 1 > 2 ? 2 : log + 1);
  }
  assert.deepEqual(s.recorder.state().logs.map((log) => log.label), ['size 2', 'size 1']);
});

test('delete removes closed and live recordings; disable stops live capture', async (t) => {
  const s = await setup(t);
  await record(s.recorder, s.clock, ['a', marker('echo kept')]);
  await record(s.recorder, s.clock, ['b']);
  await settled(s, 3);
  const first = s.recorder.state().logs[1]!;
  assert.equal((await s.recorder.delete({ kind: 'log', id: first.id })).logCount, 1);
  const target = session();
  const observer = s.recorder.observe(target)!;
  observer.output(Buffer.from('live output'));
  await until(() => s.recorder.status(target.sessionId, 1)?.state === 'on', 'on');
  await until(async () => (await s.names()).some((name) => name.endsWith('.part')), 'live file on disk');
  await s.recorder.delete({ kind: 'logs' });
  await until(() => s.recorder.state().logCount === 0, 'the live log is gone from the list');
  assert.deepEqual(s.recorder.status(target.sessionId, 1), { output: false, commands: true, state: 'on', gaps: false, problem: null });
  await until(async () => !(await s.names()).some((name) => name.startsWith('out-')), 'live log unlinked');
  assert.equal((await s.recorder.configure({ ...ON, logs: false, history: false })).status, 'saved');
  assert.equal(s.recorder.status(target.sessionId, 1), null, 'disabling removes the badge at once');
  observer.end();
  await s.recorder.delete({ kind: 'all' });
  await until(async () => (await s.names()).every((name) => !/^(out|cmd)-/u.test(name)), 'all deleted');
});

test('history: scoped, prefix-matched, newest first, distinct, rate-limited and never sensitive', async (t) => {
  const s = await setup(t, { policy: { ...ON, logs: false } });
  await record(s.recorder, s.clock, [marker('git status'), marker('git push'), marker('export API_TOKEN=x'), marker('git status'), marker('ls')]);
  await record(s.recorder, s.clock, [marker('git log')], session({ hostId: 'host-b' }));
  await record(s.recorder, s.clock, [marker('git local')], session({ hostId: null, local: true, label: 'This Mac', endpoint: '/bin/zsh' }));
  await settled(s, 3);
  await until(async () => (await s.names()).filter((name) => /^cmd-.*\.ssr$/u.test(name)).length === 3, 'history files sealed');
  assert.deepEqual(await s.recorder.suggest('host-a', 'git'), { status: 'ok', suggestions: ['git status', 'git push'] });
  assert.deepEqual(await s.recorder.suggest('host-a', 'git status'), { status: 'ok', suggestions: [] });
  assert.deepEqual(await s.recorder.suggest('local', ''), { status: 'ok', suggestions: ['git local'] });
  assert.ok(!(await s.raw()).includes('API_TOKEN'));
  const history = await s.exported({ kind: 'history' });
  assert.doesNotMatch(history.text, /API_TOKEN/u);
  // Commands closer than 200 ms in one session are dropped.
  const fast = s.recorder.observe(session())!;
  for (const text of ['burst one', 'burst two', 'burst three']) fast.output(marker(text));
  fast.end();
  await settled(s, 4);
  await until(async () => (await s.recorder.suggest('host-a', 'burst')).status === 'ok', 'reload');
  s.recorder.lock();
  assert.deepEqual(await s.recorder.suggest('host-a', 'burst'), { status: 'ok', suggestions: ['burst one'] });
});

test('the decrypted history cache expires, and a lock purges it', async (t) => {
  const s = await setup(t, { policy: { ...ON, logs: false }, limits: { historyTtlMs: 80 } });
  await record(s.recorder, s.clock, [marker('make test')]);
  await settled(s, 1);
  await until(async () => (await s.names()).some((name) => /^cmd-.*\.ssr$/u.test(name)), 'sealed');
  await s.recorder.suggest('host-a', 'make');
  const loads = s.memory.calls.open;
  await s.recorder.suggest('host-a', 'make');
  assert.equal(s.memory.calls.open, loads, 'cached within the TTL');
  await delay(120);
  await s.recorder.suggest('host-a', 'make');
  assert.equal(s.memory.calls.open, loads + 1, 'expired after the TTL');
  s.recorder.lock();
  assert.deepEqual(await s.recorder.suggest('host-a', 'make'), { status: 'ok', suggestions: ['make test'] });
  assert.equal(s.memory.calls.open, loads + 2, 'a lock forces a new key read');
  s.memory.control.failure = 'missing';
  s.recorder.lock();
  assert.deepEqual(await s.recorder.suggest('host-a', 'make'), { status: 'key-unavailable' });
});

test('forget rewrites closed history under a fresh key and excludes live entries until their rewrite', async (t) => {
  const s = await setup(t, { policy: { ...ON, logs: false } });
  await record(s.recorder, s.clock, [marker('rm -rf build'), marker('make all')]);
  await settled(s, 1);
  await until(async () => (await s.names()).some((name) => /^cmd-.*\.ssr$/u.test(name)), 'sealed');
  const before = (await s.names()).filter((name) => name.startsWith('cmd-'));
  const live = session();
  const observer = s.recorder.observe(live)!;
  s.clock.now += 1_000;
  observer.output(marker('rm -rf build'));
  await until(async () => (await s.names()).some((name) => name.endsWith('.part')), 'live history on disk');
  assert.deepEqual(await s.recorder.forget('host-a', 'rm -rf build'), { status: 'forgotten' });
  const after = (await s.names()).filter((name) => /^cmd-.*\.ssr$/u.test(name));
  assert.equal(after.length, 1);
  assert.notDeepEqual(after, before.filter((name) => name.endsWith('.ssr')), 'a new file replaced the old one');
  assert.deepEqual(await s.recorder.suggest('host-a', ''), { status: 'ok', suggestions: ['make all'] }, 'the live entry is excluded');
  observer.end();
  await until(async () => !(await s.names()).some((name) => name.endsWith('.part')), 'live file sealed');
  await until(async () => !(await s.exported({ kind: 'history' })).text.includes('rm -rf build'), 'the live file was rewritten at its end');
  assert.deepEqual(await s.recorder.forget('host-a', 'never ran'), { status: 'not-found' });
});

test('unknown, foreign and linked entries are never touched; an invalid policy file means off', async (t) => {
  const s = await setup(t, { policy: null });
  const outside = join(s.profile, 'outside.txt');
  await writeFile(outside, 'keep');
  await writeFile(join(s.root, 'notes.txt'), 'keep', { mode: 0o600 });
  await symlink(outside, join(s.root, `out-${randomUUID()}.ssr`));
  await mkdir(join(s.root, `cmd-${randomUUID()}.ssr`));
  await writeFile(join(s.root, 'policy.json'), '{"logs":true}', { mode: 0o600 });
  const reloaded = await s.restart();
  assert.deepEqual(reloaded.state().policy, DEFAULT_RECORDING_POLICY);
  await reloaded.delete({ kind: 'all' });
  assert.equal(await readFile(outside, 'utf8'), 'keep');
  assert.equal((await s.names()).length, 5, 'marker, notes, link, directory and policy remain');
});

test('a capped log remains exportable and fits the retention budget including header and final frame', async (t) => {
  const s = await setup(t, { policy: { ...ON, logMiB: 16 } });
  const target = session();
  const observer = s.recorder.observe(target)!;
  await until(() => s.recorder.state().logCount === 1, 'header started');
  for (let i = 0; i < 17; i++) {
    observer.output(Buffer.alloc(1024 * 1024, 0x63));
    await delay(15);
    if (s.recorder.status(target.sessionId, 1)?.problem === 'size-limit') break;
  }
  assert.equal(s.recorder.status(target.sessionId, 1)?.problem, 'size-limit');
  assert.equal(s.recorder.status(target.sessionId, 1)?.state, 'on', 'history keeps capturing');
  assert.equal(s.recorder.status(target.sessionId, 1)?.output, false);
  s.clock.now += 1_000;
  observer.output(marker('echo after log limit'));
  observer.end();
  await s.recorder.dispose();
  assert.equal(s.recorder.state().logCount, 1, 'retention must preserve the capped recording');
  const log = s.recorder.state().logs[0]!;
  assert.equal(log.state, 'incomplete', 'size-limited data is never presented as a full session');
  assert.ok(log.bytes <= 16 * 1024 * 1024, 'full file must fit the configured budget');
  const result = await s.exported({ kind: 'log', id: log.id });
  assert.deepEqual(result.outcome, { status: 'saved', incomplete: true, gaps: 0 });
  assert.ok(result.text.endsWith('[ssterm: recording incomplete]\r\n'));
  assert.ok(result.text.length > 15 * 1024 * 1024, 'keeps the bounded prefix');
  assert.deepEqual(await s.recorder.suggest('host-a', ''), { status: 'ok', suggestions: ['echo after log limit'] });
});

test('data and end wait for a slow header write before touching the sink', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  let headerStarted = false;
  let headerFinished = false;
  let raced = false;
  const s = await setup(t, { policy: { ...ON, history: false }, limits: { segmentBytes: 16 }, files: (files) => ({
    ...files, async create(name) {
      const sink = await files.create(name);
      let first = true;
      return { ...sink, async write(bytes) {
        if (first) {
          first = false;
          headerStarted = true;
          await gate;
          await sink.write(bytes);
          headerFinished = true;
        } else { if (!headerFinished) raced = true; await sink.write(bytes); }
      } };
    },
  }) });
  const observer = s.recorder.observe(session())!;
  await until(() => headerStarted, 'header write reached gate');
  observer.output(Buffer.from('a first frame larger than sixteen bytes'));
  observer.end();
  await delay(30);
  release();
  await s.recorder.dispose();
  assert.equal(raced, false, 'header and frames must never overlap');
  const result = await s.exported({ kind: 'log', id: s.recorder.state().logs[0]!.id });
  assert.equal(result.text, 'a first frame larger than sixteen bytes');
  assert.deepEqual(result.outcome, { status: 'saved', incomplete: false, gaps: 0 });
});

test('delete history during a pending Forget cannot resurrect replacement files', async (t) => {
  const s = await setup(t, { policy: { ...ON, logs: false } });
  await record(s.recorder, s.clock, [marker('echo forget'), marker('echo keep')]);
  await settled(s, 1);
  let release!: () => void;
  s.memory.control.gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  const seals = s.memory.calls.seal;
  const forgetting = s.recorder.forget('host-a', 'echo forget');
  await until(() => s.memory.calls.seal > seals, 'replacement key reached gate');
  const deleting = s.recorder.delete({ kind: 'history' });
  // Give Delete a chance to finish in the buggy implementation without depending on that completion.
  await delay(30);
  release();
  await Promise.all([forgetting, deleting]);
  assert.equal(s.recorder.state().historyFiles, 0, 'Delete wins over an older Forget');
  assert.deepEqual((await s.names()).filter((name) => /^cmd-/u.test(name)), []);
  assert.deepEqual(await s.recorder.suggest('host-a', ''), { status: 'ok', suggestions: [] });
});

test('Forget reports failed when the original file cannot be removed', async (t) => {
  let refused = '';
  const s = await setup(t, { policy: { ...ON, logs: false }, files: (files) => ({ ...files, remove: (name, identity) => name === refused ? Promise.resolve(false) : files.remove(name, identity) }) });
  await record(s.recorder, s.clock, [marker('echo forget'), marker('echo keep')]);
  await settled(s, 1);
  const before = await s.names();
  refused = before.find((name) => name.startsWith('cmd-'))!;
  assert.deepEqual(await s.recorder.forget('host-a', 'echo forget'), { status: 'failed' });
  assert.deepEqual(await s.names(), before, 'replacement is removed when original unlink is refused');
});

test('locking during a Forget write aborts and removes the unpublished replacement', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  let block = false;
  let started = false;
  const s = await setup(t, { policy: { ...ON, logs: false }, files: (files) => ({ ...files, async create(name) {
    const sink = await files.create(name);
    return { ...sink, async write(bytes) { if (block) { started = true; await gate; } await sink.write(bytes); } };
  } }) });
  await record(s.recorder, s.clock, [marker('echo forget'), marker('echo keep')]);
  await settled(s, 1);
  const before = await s.names();
  block = true;
  const forgetting = s.recorder.forget('host-a', 'echo forget');
  await until(() => started, 'rewrite reached gated write');
  const queued = s.recorder.forget('host-a', 'echo keep');
  s.recorder.lock();
  release();
  assert.deepEqual(await forgetting, { status: 'locked' });
  assert.deepEqual(await queued, { status: 'locked' }, 'queued actions cannot start decrypting after a lock');
  assert.deepEqual(await s.names(), before, 'no unindexed replacement or part remains');
  assert.equal(s.recorder.state().historyFiles, 1);
});

test('a failed Forget write removes its stage and keeps the original history', async (t) => {
  let fail = false;
  const s = await setup(t, { policy: { ...ON, logs: false }, files: (files) => ({ ...files, async create(name) {
    const sink = await files.create(name);
    return { ...sink, async write(bytes) { if (fail) throw new Error('owned disk failure'); await sink.write(bytes); } };
  } }) });
  await record(s.recorder, s.clock, [marker('echo forget'), marker('echo keep')]);
  await settled(s, 1);
  const before = await s.names();
  fail = true;
  assert.deepEqual(await s.recorder.forget('host-a', 'echo forget'), { status: 'failed' });
  assert.deepEqual(await s.names(), before);
  assert.match((await s.exported({ kind: 'history' })).text, /echo forget/u);
});

test('two concurrent Forgets cannot restore each other\'s commands or a stale cache', async (t) => {
  const s = await setup(t, { policy: { ...ON, logs: false } });
  await record(s.recorder, s.clock, [marker('echo first'), marker('echo second'), marker('echo keep')]);
  await settled(s, 1);
  const results = await Promise.all([s.recorder.forget('host-a', 'echo first'), s.recorder.forget('host-a', 'echo second')]);
  assert.deepEqual(results, [{ status: 'forgotten' }, { status: 'forgotten' }]);
  assert.deepEqual(await s.recorder.suggest('host-a', ''), { status: 'ok', suggestions: ['echo keep'] });
  assert.doesNotMatch((await s.exported({ kind: 'history' })).text, /echo (first|second)/u);
  assert.equal(s.recorder.state().historyFiles, 1);
});

test('Delete also discards an ended observer whose header is still being created', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  let started = false;
  let writes = 0;
  const s = await setup(t, { policy: { ...ON, history: false }, files: (files) => ({ ...files, async create(name) {
    started = true;
    await gate;
    const sink = await files.create(name);
    return { ...sink, async write(bytes) { writes++; await sink.write(bytes); } };
  } }) });
  const observer = s.recorder.observe(session())!;
  observer.output(Buffer.from('ended output'));
  observer.end();
  await until(() => started, 'create reached gate after observer ended');
  await s.recorder.delete({ kind: 'all' });
  release();
  await s.recorder.dispose();
  assert.equal(s.recorder.state().logCount, 0);
  assert.equal(writes, 0, 'no header or data is written after Delete, even when native create returns late');
  assert.deepEqual((await s.names()).filter((name) => /^out-/u.test(name)), []);
});

test('a history cap preserves bounded history and lets the output log continue', async (t) => {
  const s = await setup(t, { policy: { ...ON, historyMiB: 1 } });
  const target = session();
  const observer = s.recorder.observe(target)!;
  await until(() => s.recorder.status(target.sessionId, 1)?.state === 'on', 'keys wrapped');
  for (let i = 0; i < 600 && s.recorder.status(target.sessionId, 1)?.problem !== 'size-limit'; i++) {
    s.clock.now += 1_000;
    observer.output(marker(`echo ${i} ${'x'.repeat(1_980)}`));
  }
  assert.deepEqual(s.recorder.status(target.sessionId, 1), { state: 'on', output: true, commands: false, problem: 'size-limit', gaps: false });
  observer.output(Buffer.from('output after history cap'));
  observer.end();
  await until(() => s.recorder.state().logs[0]?.state === 'complete', 'output finalized');
  assert.equal(s.recorder.state().historyFiles, 1);
  assert.ok(s.recorder.state().historyBytes <= 1024 * 1024);
  const history = await s.exported({ kind: 'history' });
  assert.deepEqual(history.outcome, { status: 'saved', incomplete: true, gaps: 0 });
  assert.deepEqual(await s.recorder.forget('host-a', `echo 0 ${'x'.repeat(1_980)}`), { status: 'forgotten' });
  assert.deepEqual((await s.exported({ kind: 'history' })).outcome, { status: 'saved', incomplete: true, gaps: 0 }, 'Forget preserves the incomplete verdict');
  assert.equal((await s.names()).filter((name) => /^cmd-.*\.part$/u.test(name)).length, 1);
  const log = s.recorder.state().logs[0]!;
  assert.equal(log.state, 'complete');
  assert.ok((await s.exported({ kind: 'log', id: log.id })).text.endsWith('output after history cap'));
});

test('a Forget invoked after Delete finds no history and cannot restore it', async (t) => {
  const s = await setup(t, { policy: { ...ON, logs: false } });
  await record(s.recorder, s.clock, [marker('echo forget'), marker('echo keep')]);
  await settled(s, 1);
  const [deleted, forgotten] = await Promise.all([s.recorder.delete({ kind: 'history' }), s.recorder.forget('host-a', 'echo forget')]);
  assert.equal(deleted.historyFiles, 0);
  assert.deepEqual(forgotten, { status: 'not-found' });
  assert.deepEqual((await s.names()).filter((name) => /^cmd-/u.test(name)), []);
});

test('lock during the export destination dialog aborts before any key read or plaintext stage', async (t) => {
  const s = await setup(t, { policy: { ...ON, history: false } });
  await record(s.recorder, s.clock, ['owned export content']);
  await settled(s, 1);
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  let choosing = false;
  const before = s.memory.calls.open;
  const destination = join(s.profile, 'aborted-export.txt');
  const exporting = s.recorder.export({ kind: 'log', id: s.recorder.state().logs[0]!.id }, async () => {
    choosing = true;
    await gate;
    return destination;
  });
  await until(() => choosing, 'save dialog is pending');
  s.recorder.lock();
  // Even if an owner unlocks again before the dialog returns, this export's epoch stays revoked.
  release();
  assert.deepEqual(await exporting, { status: 'aborted' });
  assert.equal(s.memory.calls.open, before, 'no decryption after the dialog lock');
  assert.ok(!(await readdir(s.profile)).includes('aborted-export.txt'));
  assert.ok(!(await readdir(s.profile)).some((name) => name.startsWith('.ssterm-export-')));
  assert.deepEqual(await s.recorder.export({ kind: 'history' }, async () => undefined), { status: 'cancelled' });
});

test('lock while an export stage syncs prevents publication and preserves an existing destination', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  let syncing = false;
  const s = await setup(t, { policy: { ...ON, history: false }, io: {
    async open(path, flags, mode) {
      const handle = await openNative(path, flags, mode);
      if (String(path).includes('/.ssterm-export-')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { syncing = true; await gate; await sync(); };
      }
      return handle;
    },
  } });
  await record(s.recorder, s.clock, ['plaintext must not replace a file after lock']);
  await settled(s, 1);
  const destination = join(s.profile, 'existing-export.txt');
  await writeFile(destination, 'keep existing');
  const exporting = s.recorder.export({ kind: 'log', id: s.recorder.state().logs[0]!.id }, destination);
  await until(() => syncing, 'plaintext stage is waiting at fsync');
  s.recorder.lock();
  release();
  assert.deepEqual(await exporting, { status: 'aborted' });
  assert.equal(await readFile(destination, 'utf8'), 'keep existing');
  assert.ok(!(await readdir(s.profile)).some((name) => name.startsWith('.ssterm-export-')));
});

test('a native export publication dispatched before lock reports saved once it succeeds', async (t) => {
  let recorder: Recorder | undefined;
  const s = await setup(t, { policy: { ...ON, history: false }, io: {
    async rename(from, to) {
      await renameNative(from, to);
      if (String(from).includes('/.ssterm-export-')) recorder!.lock();
    },
  } });
  recorder = s.recorder;
  await record(s.recorder, s.clock, ['published with consent before lock']);
  await settled(s, 1);
  const destination = join(s.profile, 'published-export.txt');
  assert.deepEqual(await s.recorder.export({ kind: 'log', id: s.recorder.state().logs[0]!.id }, destination), { status: 'saved', incomplete: false, gaps: 0 });
  assert.equal(await readFile(destination, 'utf8'), 'published with consent before lock');
});

test('a corrupt history file aborts the whole export instead of reporting a successful partial history', async (t) => {
  const s = await setup(t, { policy: { ...ON, logs: false } });
  await record(s.recorder, s.clock, [marker('echo first'), marker('echo second')]);
  await settled(s, 1);
  const name = (await s.names()).find((name) => name.startsWith('cmd-'))!;
  const path = join(s.root, name);
  const bytes = await readFile(path);
  bytes[bytes.length - 1]! ^= 1;
  await writeFile(path, bytes);
  const destination = join(s.profile, 'history.txt');
  await writeFile(destination, 'keep existing');
  assert.deepEqual(await s.recorder.export({ kind: 'history' }, destination), { status: 'corrupt' });
  assert.equal(await readFile(destination, 'utf8'), 'keep existing');
});

test('quit keeps its bounded drain even when a retention sweep waits behind a Forget key read', async (t) => {
  let policySaved = false;
  const s = await setup(t, { policy: { ...ON, logs: false }, limits: { drainMs: 30 }, files: (files) => ({
    ...files, async writePolicy(policy) { const saved = await files.writePolicy(policy); policySaved = true; return saved; },
  }) });
  await record(s.recorder, s.clock, [marker('echo forget'), marker('echo keep')]);
  await settled(s, 1);
  let release!: () => void;
  s.memory.control.gate = new Promise<void>((done) => { release = done; });
  t.after(() => release());
  const before = s.memory.calls.seal;
  const forgetting = s.recorder.forget('host-a', 'echo forget');
  await until(() => s.memory.calls.seal > before, 'Forget waits on secure storage');
  policySaved = false;
  const configuring = s.recorder.configure({ ...ON, logs: false });
  await until(() => policySaved, 'policy saved and retention sweep queued');
  const disposing = s.recorder.dispose();
  const bounded = await Promise.race([disposing.then(() => true), delay(150).then(() => false)]);
  release();
  await Promise.all([forgetting, configuring, disposing]);
  assert.equal(bounded, true, 'quit must not wait indefinitely behind secure storage');
});
