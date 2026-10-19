import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RECORDING_POLICY, isCommandText, isDisplayText, isRecordingPolicy, promptMark, MAX_COMMAND_BYTES,
} from '../../packages/domain/src/recording.ts';
import { CommandScanner, decodeCommandLine, sensitiveCommand, MAX_ESCAPED_FIELD } from '../../packages/services/src/command-scanner.ts';

const latin = (text: string) => Buffer.from(text, 'latin1');
const utf8 = (text: string) => Buffer.from(text, 'utf8');
// Ported from the SST-034 runner-up probe: every terminator form, C1 introducers, aborts, nonce and filters.
const stream = Buffer.concat([
  utf8('prompt$ '), latin('\x1b]0;title\x07'), latin('\x1b[31mred\x1b[0m'),
  latin('\x1b]633;E;echo one\\x3b echo "a\\x3bb\\\\\\\\c" '), utf8('ไทย'), latin('\x07'),
  latin('\x1b]633;E;ls -la\x1b\\'),
  Buffer.from([0xc2, 0x9d]), latin('633;E;uptime'), Buffer.from([0xc2, 0x9c]),
  latin('\x1b]633;E;for i\\x0adone\x07'),
  latin('\x1b]633;E;rm -rf x\x18'),
  latin('\x1b]633;E;rm -rf y'), Buffer.from([0xc2, 0x85]), latin('\x07'),
  latin('\x1b]633;E;git status;nonce123\x07'),
  latin('\x1b]133;A\x07\x1b]633;E; hidden\x07'),
  latin('\x1b]633;E;export API_TOKEN=x\x07'),
  utf8('©°±'), latin('\x1b]633;E;caf'), utf8('é'), latin('\x07'),
  latin('\x1b]633;E;bad\\q\x07'), latin('\x1b]633;E;\\xff\\xfe\x07'),
  latin('\x1b]633;E;\\u202eevil\x07'), utf8('\x1b]633;E;echo ‮ evil\x07'),
  latin('\x1b]633;E;echo \x01ignored-c0\x07'),
]);
const expected = ['echo one; echo "a;b\\\\c" ไทย', 'ls -la', 'uptime', 'git status', 'café', 'echo ignored-c0'];

test('the scanner extracts the same commands at every split point and byte by byte', () => {
  assert.deepEqual([...new CommandScanner().feed(stream)], expected);
  for (let cut = 0; cut <= stream.length; cut++) {
    const scanner = new CommandScanner();
    assert.deepEqual([...scanner.feed(stream.subarray(0, cut)), ...scanner.feed(stream.subarray(cut))], expected, `cut ${cut}`);
  }
  for (let first = 1; first < stream.length; first += 7) {
    const scanner = new CommandScanner();
    const got = [stream.subarray(0, first), stream.subarray(first, first + 13), stream.subarray(first + 13)].flatMap((part) => [...scanner.feed(part)]);
    assert.deepEqual(got, expected, `three-way split at ${first}`);
  }
  const scanner = new CommandScanner();
  const got: string[] = [];
  for (const byte of stream) got.push(...scanner.feed(Uint8Array.of(byte)));
  assert.deepEqual(got, expected);
});

test('an oversize payload is skipped with constant memory and the scanner resynchronises', () => {
  const scanner = new CommandScanner();
  const huge = Buffer.concat([latin('\x1b]633;E;'), Buffer.alloc(MAX_ESCAPED_FIELD + 10, 0x61), latin('\x07\x1b]633;E;ok\x07')]);
  assert.deepEqual([...scanner.feed(huge)], ['ok']);
  // Other OSCs (titles, OSC 8 links) of any size are never buffered and never yield commands.
  assert.deepEqual([...scanner.feed(Buffer.concat([latin('\x1b]8;;http://x\x07'), Buffer.alloc(100_000, 0x62), latin('\x07')]))], []);
  // A forged marker after a CAN-aborted one and an ESC-started CSI still parse like xterm.
  assert.deepEqual([...scanner.feed(latin('\x1b]633;E;a\x18\x1b[0m\x1b]633;E;b\x07'))], ['b']);
});

test('decodeCommandLine is the only gate: escapes, UTF-8, controls, bidi, size and credential shapes', () => {
  const decode = (text: string) => decodeCommandLine(utf8(text));
  assert.equal(decode('echo \\\\ \\x3b'), 'echo \\ ;');
  assert.equal(decode('echo สวัสดี'), 'echo สวัสดี');
  for (const rejected of ['', '   ', ' echo hidden', 'a\\x0ab', 'a\\x7f', 'a\\xc2\\x85', 'bad\\n', 'bad\\x4', '\\xff', 'echo ‮', 'echo ⁦x']) assert.equal(decode(rejected), undefined, rejected);
  assert.equal(decode('x'.repeat(MAX_COMMAND_BYTES)), 'x'.repeat(MAX_COMMAND_BYTES));
  assert.equal(decode('x'.repeat(MAX_COMMAND_BYTES + 1)), undefined);
  for (const sensitive of ['mysql -uroot -pX db', 'export API_TOKEN=x', 'curl -u alice:secret https://h', 'git clone https://u:p@h/r',
    'echo AKIAABCDEFGHIJKLMNOP', `gh auth ghp_${'a'.repeat(36)}`, 'tool --password x', 'sshpass -p x ssh h', 'PASSWORD=1 run',
    'curl -H "Authorization: Bearer x"', 'openai sk-abcdefghijklmnopqrstuvwx', 'echo eyJhbGciOi.eyJzdWIi.sig'])
    assert.equal(sensitiveCommand(sensitive), true, sensitive);
  for (const safe of ['ssh -p22 host', 'mkdir -p dir', 'git push', 'echo สวัสดี', 'ls -la', 'passwd', 'docker ps -a'])
    assert.equal(sensitiveCommand(safe), false, safe);
  assert.equal(decode('export API_TOKEN=x'), undefined);
});

test('domain text rules, prompt marks and the policy guard', () => {
  assert.equal(isDisplayText('', 4), true);
  assert.equal(isDisplayText('ไทย', 9), true);
  assert.equal(isDisplayText('ไทย', 8), false);
  assert.equal(isDisplayText('a\u0007', 10), false);
  assert.equal(isDisplayText('\ud800', 10), false);
  assert.equal(isCommandText('ls'), true);
  assert.equal(isCommandText(' ls'), false);
  assert.equal(isCommandText(''), false);
  assert.equal(isCommandText('a\nb'), false);
  assert.deepEqual(['A', 'B', 'C', 'D', 'D;0', 'D;130', 'E', 'AB', ''].map(promptMark), ['A', 'B', 'C', 'D', 'D', 'D', null, null, null]);
  assert.equal(isRecordingPolicy(DEFAULT_RECORDING_POLICY), true);
  assert.equal(DEFAULT_RECORDING_POLICY.logs || DEFAULT_RECORDING_POLICY.history, false, 'off by default');
  for (const invalid of [{ ...DEFAULT_RECORDING_POLICY, logDays: 0 }, { ...DEFAULT_RECORDING_POLICY, logMiB: 1.5 }, { ...DEFAULT_RECORDING_POLICY, extra: 1 },
    { ...DEFAULT_RECORDING_POLICY, logs: 'yes' }, { ...DEFAULT_RECORDING_POLICY, historyMiB: 65 }, null, [], 'policy'])
    assert.equal(isRecordingPolicy(invalid), false, JSON.stringify(invalid));
});

test('recording modules make no network imports', () => {
  for (const path of ['../../packages/domain/src/recording.ts', '../../packages/services/src/command-scanner.ts', '../../packages/services/src/recorder.ts', '../../packages/adapters/src/recording-files.ts']) {
    const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, /from ['"](?:node:)?(?:http|https|net|dgram|tls|dns)['"]|\bfetch\(/u, path);
  }
});
