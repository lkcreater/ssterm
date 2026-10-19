import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  ENVELOPE_VERSION, PROTECTION_FORMAT, ProtectionFault, SEGMENT_HEADER, SEGMENT_PLAINTEXT_MAX, open, openSegment, seal, sealSegment,
} from '../../packages/adapters/src/protection.ts';

const vaultId = '11111111-1111-4111-8111-111111111111';
const snippetId = '22222222-2222-4222-8222-222222222222';
// Sealed by the pre-SST-034 protection.ts (HEAD 44bbcfb) with key 0x07 × 32: the snippet AAD bytes are unchanged.
const GOLDEN = '0101af7e2760177341c61f74657a7368841d74d34a681af1af9dbcdfd071cbca06efce581ba09aeddcd1c0b19b3af95d';
const stored = (bodyEnvelope: Uint8Array) => ({ bodyEnvelope, envelopeVersion: ENVELOPE_VERSION, protectionFormat: PROTECTION_FORMAT });
const corrupt = (error: unknown) => error instanceof ProtectionFault && error.code === 'corrupt';

test('existing snippet envelopes still open, and a recording-key envelope never opens as a snippet body', () => {
  const key = Buffer.alloc(32, 7);
  const body = open(key, { vaultId, snippetId, field: 'body' }, stored(Buffer.from(GOLDEN, 'hex')));
  assert.equal(body.toString('utf8'), 'golden snippet body');
  const dek = randomBytes(32);
  const wrapped = seal(key, { vaultId, recordingId: snippetId, field: 'recording-key' }, dek);
  assert.deepEqual(open(key, { vaultId, recordingId: snippetId, field: 'recording-key' }, stored(wrapped)), dek);
  assert.throws(() => open(key, { vaultId, snippetId, field: 'body' }, stored(wrapped)), corrupt);
  assert.throws(() => open(key, { vaultId, recordingId: snippetId, field: 'recording-key' }, stored(Buffer.from(GOLDEN, 'hex'))), corrupt);
  assert.throws(() => open(key, { vaultId, recordingId: vaultId, field: 'recording-key' }, stored(wrapped)), corrupt);
});

test('STREAM segments detect tamper, reorder, truncation, a flipped last flag and a foreign identity', () => {
  const key = randomBytes(32);
  const identity = createHash('sha256').update('identity').digest();
  const other = createHash('sha256').update('other').digest();
  const frames = [0, 1, 2].map((counter) => sealSegment(key, identity, counter, counter === 2, Buffer.from(`segment ${counter}`)));
  const body = (frame: Uint8Array) => frame.subarray(SEGMENT_HEADER);
  for (const [counter, frame] of frames.entries()) {
    assert.equal(Buffer.from(frame).readUInt32BE(0), frame.length - SEGMENT_HEADER);
    assert.equal(frame[4], counter === 2 ? 1 : 0);
    assert.equal(openSegment(key, identity, counter, counter === 2, body(frame)).toString(), `segment ${counter}`);
  }
  assert.throws(() => openSegment(key, identity, 0, false, body(frames[1]!)), corrupt, 'reordered');
  assert.throws(() => openSegment(key, identity, 1, true, body(frames[1]!)), corrupt, 'a middle segment cannot end the file');
  assert.throws(() => openSegment(key, identity, 2, false, body(frames[2]!)), corrupt, 'the last flag is authenticated');
  assert.throws(() => openSegment(key, other, 1, false, body(frames[1]!)), corrupt, 'moved to another file');
  assert.throws(() => openSegment(randomBytes(32), identity, 1, false, body(frames[1]!)), corrupt, 'another key');
  const flipped = Buffer.from(body(frames[0]!));
  flipped[0]! ^= 1;
  assert.throws(() => openSegment(key, identity, 0, false, flipped), corrupt, 'tampered ciphertext');
  const tag = Buffer.from(body(frames[0]!));
  tag[tag.length - 1]! ^= 1;
  assert.throws(() => openSegment(key, identity, 0, false, tag), corrupt, 'tampered tag');
  assert.throws(() => openSegment(key, identity, 0, false, body(frames[0]!).subarray(0, 10)), corrupt, 'truncated');
});

test('STREAM rejects invalid keys, counters and sizes', () => {
  const key = randomBytes(32);
  const identity = createHash('sha256').update('identity').digest();
  const invalid = (error: unknown) => error instanceof ProtectionFault && error.code === 'invalid';
  assert.throws(() => sealSegment(key.subarray(0, 16), identity, 0, false, Buffer.of(1)), invalid);
  assert.throws(() => sealSegment(key, identity, -1, false, Buffer.of(1)), invalid);
  assert.throws(() => sealSegment(key, identity, 2 ** 48, false, Buffer.of(1)), invalid);
  assert.throws(() => sealSegment(key, identity, 0, false, new Uint8Array(0)), invalid);
  assert.throws(() => sealSegment(key, identity, 0, false, new Uint8Array(SEGMENT_PLAINTEXT_MAX + 1)), invalid);
  const largest = sealSegment(key, identity, 2 ** 48 - 1, false, new Uint8Array(SEGMENT_PLAINTEXT_MAX));
  assert.equal(openSegment(key, identity, 2 ** 48 - 1, false, largest.subarray(SEGMENT_HEADER)).length, SEGMENT_PLAINTEXT_MAX);
});
