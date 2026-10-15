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
export interface ProtectedField {
  vaultId: Id;
  snippetId: Id;
  field: 'body';
}
export class ProtectionFault extends Error {
  constructor(readonly code: 'unsupported' | 'corrupt' | 'invalid') {
    super(code === 'unsupported' ? 'Unsupported protection format.' : code === 'corrupt' ? 'Protected content failed authentication.' : 'Invalid protection request.');
  }
}
/** Length-prefixed fields keep the record binding unambiguous regardless of field contents. */
function additionalData(binding: ProtectedField): Buffer {
  return Buffer.concat([PROTECTION_FORMAT, String(ENVELOPE_VERSION), binding.vaultId, binding.snippetId, binding.field].map(value => {
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
