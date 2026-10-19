import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Id } from '@ssterm/domain';
/** Node/OpenSSL AES-256-GCM. Envelope v1 = version byte || 12-byte random nonce || ciphertext || 16-byte tag. */
export const PROTECTION_FORMAT = 'aes-256-gcm-v1';
export const ENVELOPE_VERSION = 1;
export const CONTENT_KEY_BYTES = 32;
const NONCE = 12;
const TAG = 16;
export const ENVELOPE_OVERHEAD = 1 + NONCE + TAG;
export const MAX_BODY = 1024 * 1024;
export const MAX_ENVELOPE = MAX_BODY + ENVELOPE_OVERHEAD;
/** AAD positions are fixed: [format, version, vaultId, record id, field]; the field names the record type. */
export type ProtectedField = {
  vaultId: Id;
  snippetId: Id;
  field: 'body';
} | {
  vaultId: Id;
  recordingId: Id;
  field: 'recording-key';
};
export class ProtectionFault extends Error {
  constructor(readonly code: 'unsupported' | 'corrupt' | 'invalid') {
    super(code === 'unsupported' ? 'Unsupported protection format.' : code === 'corrupt' ? 'Protected content failed authentication.' : 'Invalid protection request.');
  }
}
/** Length-prefixed fields keep the record binding unambiguous regardless of field contents. */
function additionalData(binding: ProtectedField): Buffer {
  return Buffer.concat([PROTECTION_FORMAT, String(ENVELOPE_VERSION), binding.vaultId, 'snippetId' in binding ? binding.snippetId : binding.recordingId, binding.field].map(value => {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  }));
}
function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== CONTENT_KEY_BYTES) throw new ProtectionFault('invalid');
}
export function seal(key: Uint8Array, binding: ProtectedField, plaintext: Uint8Array): Uint8Array {
  checkKey(key);
  if (!(plaintext instanceof Uint8Array) || plaintext.length > MAX_BODY) throw new ProtectionFault('invalid');
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG
  });
  cipher.setAAD(additionalData(binding));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.of(ENVELOPE_VERSION), nonce, body, cipher.getAuthTag()]));
}
/** Returns a new buffer the caller owns; the stored envelope is never modified. */
export function open(key: Uint8Array, binding: ProtectedField, envelope: {
  bodyEnvelope: Uint8Array;
  envelopeVersion: number;
  protectionFormat: string;
}): Buffer {
  checkKey(key);
  const bytes = envelope.bodyEnvelope;
  if (envelope.protectionFormat !== PROTECTION_FORMAT || envelope.envelopeVersion !== ENVELOPE_VERSION) throw new ProtectionFault('unsupported');
  if (!(bytes instanceof Uint8Array) || bytes.length < ENVELOPE_OVERHEAD || bytes[0] !== ENVELOPE_VERSION) throw new ProtectionFault('corrupt');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 1 + NONCE), {
    authTagLength: TAG
  });
  decipher.setAAD(additionalData(binding));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG));
  const parts: Buffer[] = [];
  try {
    parts.push(decipher.update(bytes.subarray(1 + NONCE, bytes.length - TAG)));
    parts.push(decipher.final());
    return Buffer.concat(parts);
  } catch {
    throw new ProtectionFault('corrupt');
  } finally {
    for (const part of parts) part.fill(0);
  }
}
/** Type byte plus at most 64 KiB of body. */
export const SEGMENT_PLAINTEXT_MAX = 65_537;
/** A frame is u32 BE sealed length ‖ u8 last flag ‖ ciphertext ‖ tag. */
export const SEGMENT_HEADER = 5;
export const SEGMENT_SEALED_MAX = SEGMENT_PLAINTEXT_MAX + TAG;
function segmentNonce(counter: number, last: boolean): Buffer {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter >= 2 ** 48) throw new ProtectionFault('invalid');
  const nonce = Buffer.alloc(NONCE);
  nonce.writeUIntBE(counter, 5, 6);
  nonce[11] = last ? 1 : 0;
  return nonce;
}
/**
 * STREAM (Hoang–Reyhanitabar–Rogaway–Vizár 2015) in age v1's layout: AES-256-GCM under a per-file key, nonce =
 * 11-byte big-endian counter ‖ last flag, AAD = the file's identity digest. Reordering, truncation, a flipped last
 * flag or a segment moved between files fails authentication. One key seals one file, and a file is never appended
 * after it closes, so a (key, nonce) pair never repeats.
 */
export function sealSegment(key: Uint8Array, identityHash: Uint8Array, counter: number, last: boolean, plaintext: Uint8Array): Uint8Array {
  checkKey(key);
  if (!(plaintext instanceof Uint8Array) || plaintext.length < 1 || plaintext.length > SEGMENT_PLAINTEXT_MAX || identityHash.length !== 32) throw new ProtectionFault('invalid');
  const cipher = createCipheriv('aes-256-gcm', key, segmentNonce(counter, last), { authTagLength: TAG });
  cipher.setAAD(identityHash);
  const frame = Buffer.allocUnsafe(SEGMENT_HEADER + plaintext.length + TAG);
  frame.writeUInt32BE(plaintext.length + TAG, 0);
  frame[4] = last ? 1 : 0;
  const body = cipher.update(plaintext);
  body.copy(frame, SEGMENT_HEADER);
  cipher.final();
  cipher.getAuthTag().copy(frame, SEGMENT_HEADER + body.length);
  return frame;
}
/** Inverse of `sealSegment` for one frame's ciphertext ‖ tag. Any authentication failure is `corrupt`. */
export function openSegment(key: Uint8Array, identityHash: Uint8Array, counter: number, last: boolean, sealed: Uint8Array): Buffer {
  checkKey(key);
  if (!(sealed instanceof Uint8Array) || sealed.length <= TAG || sealed.length > SEGMENT_SEALED_MAX || identityHash.length !== 32) throw new ProtectionFault('corrupt');
  const decipher = createDecipheriv('aes-256-gcm', key, segmentNonce(counter, last), { authTagLength: TAG });
  decipher.setAAD(identityHash);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  const body = decipher.update(sealed.subarray(0, sealed.length - TAG));
  try {
    decipher.final();
    return body;
  } catch {
    body.fill(0);
    throw new ProtectionFault('corrupt');
  }
}
