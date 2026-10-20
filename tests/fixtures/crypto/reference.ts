// SST-036 TEST-ONLY reference. Trusted checkpoint/key lookup, persistent replay
// protection, entropy generation and recovery payload parsing are deliberately absent.
import {
  constants, createCipheriv, createDecipheriv, createHash, createPublicKey,
  hkdfSync, privateDecrypt, publicEncrypt, sign, verify, type KeyObject,
} from 'node:crypto';

export const SUITE = 'rsa3072-oaep-sha256_ed25519_hkdf-sha256_aes256gcm';
export const DATA_MAX = 1024 * 1024;
export const RECOVERY_MAX = 8 * DATA_MAX;
const HEADER_MAX = 1024;
const WIRE_MAX = RECOVERY_MAX + 2048;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]+$/;
type Field = string | Uint8Array;
export type DataHeader = {
  deploymentId: string; accountId: string; vaultId: string; epoch: number;
  operationId: string; authorDeviceId: string; controlHash: string;
  parentsDigest: string; salt: string; nonce: string; plaintextLength: number;
};
export type WrapHeader = Pick<DataHeader, 'deploymentId' | 'accountId' | 'vaultId' | 'epoch' | 'controlHash'> & {
  recipientDeviceId: string; recipientFingerprint: string; issuerDeviceId: string; issuerFingerprint: string;
};
export type RecoveryHeader = Pick<DataHeader, 'deploymentId' | 'accountId' | 'vaultId' | 'controlHash' | 'salt' | 'nonce' | 'plaintextLength'> & {
  recoveryId: string;
};
function requireValue(ok: unknown): asserts ok { if (!ok) throw new Error('Invalid reference envelope'); }
export function frame(...fields: Field[]): Buffer {
  const measured = fields.reduce((n, v) => n + 4 + (typeof v === 'string' ? Buffer.byteLength(v) : v.byteLength), 0);
  requireValue(measured <= WIRE_MAX);
  const buffers = fields.map((v) => Buffer.from(v));
  const length = buffers.reduce((n, b) => n + 4 + b.length, 0);
  requireValue(length <= WIRE_MAX);
  return Buffer.concat(buffers.flatMap((b) => {
    const size = Buffer.alloc(4); size.writeUInt32BE(b.length); return [size, b];
  }));
}
export function unframe(bytes: Uint8Array, count: number, maxField = WIRE_MAX, maxTotal = WIRE_MAX): Buffer[] {
  requireValue(Number.isSafeInteger(count) && count >= 0 && count <= 258 && bytes.length <= maxTotal);
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields: Buffer[] = []; let offset = 0;
  for (let i = 0; i < count; i++) {
    requireValue(offset + 4 <= source.length);
    const size = source.readUInt32BE(offset); offset += 4;
    requireValue(size <= maxField && size <= source.length - offset);
    fields.push(source.subarray(offset, offset + size)); offset += size;
  }
  requireValue(offset === source.length); return fields;
}
function texts(bytes: Uint8Array, count: number): string[] {
  return unframe(bytes, count, HEADER_MAX, HEADER_MAX).map((b) => {
    requireValue(b.every((v) => v >= 0x20 && v <= 0x7e)); return b.toString('ascii');
  });
}
function digest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function isHex(value: string, bytes: number): boolean { return value.length === bytes * 2 && hex.test(value); }
function decimal(value: string, max: number, min = 0): number {
  requireValue(/^(0|[1-9][0-9]*)$/.test(value));
  const result = Number(value); requireValue(Number.isSafeInteger(result) && result >= min && result <= max); return result;
}
function prefix(fields: string[], domain: string): void {
  requireValue(fields[0] === domain && fields[1] === '1' && fields[2] === SUITE);
  requireValue(fields.slice(3, 6).every((id) => uuid.test(id)));
}
export function parentsDigest(parents: readonly string[]): string {
  requireValue(parents.length <= 64 && parents.every((h) => isHex(h, 32)) && new Set(parents).size === parents.length);
  const sorted = [...parents].sort();
  // The separate wire list must already be canonical, not silently normalized.
  requireValue(parents.every((v, i) => v === sorted[i]));
  return digest(frame('ssterm-sync-parents-v1', String(parents.length), ...parents));
}
export function dataHeader(h: DataHeader): Buffer {
  const bytes = frame('ssterm-sync-data-v1', '1', SUITE, h.deploymentId, h.accountId, h.vaultId,
    String(h.epoch), h.operationId, h.authorDeviceId, h.controlHash, h.parentsDigest, h.salt, h.nonce, String(h.plaintextLength));
  parseDataHeader(bytes); return bytes;
}
export function parseDataHeader(bytes: Uint8Array): DataHeader {
  const f = texts(bytes, 14); prefix(f, 'ssterm-sync-data-v1');
  requireValue(uuid.test(f[7]) && uuid.test(f[8]) && f.slice(9, 12).every((v) => isHex(v, 32)) && isHex(f[12], 12));
  return { deploymentId: f[3], accountId: f[4], vaultId: f[5], epoch: decimal(f[6], 0xffffffff, 1),
    operationId: f[7], authorDeviceId: f[8], controlHash: f[9], parentsDigest: f[10], salt: f[11], nonce: f[12],
    plaintextLength: decimal(f[13], DATA_MAX) };
}
export function wrapHeader(h: WrapHeader): Buffer {
  const bytes = frame('ssterm-sync-wrap-v1', '1', SUITE, h.deploymentId, h.accountId, h.vaultId, String(h.epoch),
    h.recipientDeviceId, h.recipientFingerprint, h.issuerDeviceId, h.issuerFingerprint, h.controlHash);
  parseWrapHeader(bytes); return bytes;
}
export function parseWrapHeader(bytes: Uint8Array): WrapHeader {
  const f = texts(bytes, 12); prefix(f, 'ssterm-sync-wrap-v1');
  requireValue(uuid.test(f[7]) && uuid.test(f[9]) && [f[8], f[10], f[11]].every((v) => isHex(v, 32)));
  return { deploymentId: f[3], accountId: f[4], vaultId: f[5], epoch: decimal(f[6], 0xffffffff, 1),
    recipientDeviceId: f[7], recipientFingerprint: f[8], issuerDeviceId: f[9], issuerFingerprint: f[10], controlHash: f[11] };
}
export function recoveryHeader(h: RecoveryHeader): Buffer {
  const bytes = frame('ssterm-sync-recovery-v1', '1', SUITE, h.deploymentId, h.accountId, h.vaultId,
    h.recoveryId, h.controlHash, h.salt, h.nonce, String(h.plaintextLength));
  parseRecoveryHeader(bytes); return bytes;
}
export function parseRecoveryHeader(bytes: Uint8Array): RecoveryHeader {
  const f = texts(bytes, 11); prefix(f, 'ssterm-sync-recovery-v1');
  requireValue(uuid.test(f[6]) && isHex(f[7], 32) && isHex(f[8], 32) && isHex(f[9], 12));
  return { deploymentId: f[3], accountId: f[4], vaultId: f[5], recoveryId: f[6], controlHash: f[7],
    salt: f[8], nonce: f[9], plaintextLength: decimal(f[10], RECOVERY_MAX) };
}
function key32(key: Uint8Array): void { requireValue(key.length === 32); }
function publicPart(key: KeyObject): KeyObject { return key.type === 'public' ? key : createPublicKey(key); }
function checkKey(key: KeyObject, algorithm: 'ed25519' | 'rsa', privateOnly = false): void {
  requireValue(key.asymmetricKeyType === algorithm && (key.type === 'public' || key.type === 'private'));
  requireValue(!privateOnly || key.type === 'private');
  if (algorithm === 'rsa') requireValue(key.asymmetricKeyDetails?.modulusLength === 3072 && key.asymmetricKeyDetails.publicExponent === 65537n);
}
export function fingerprint(key: KeyObject): string {
  requireValue(key.asymmetricKeyType === 'rsa' || key.asymmetricKeyType === 'ed25519');
  checkKey(key, key.asymmetricKeyType); return digest(publicPart(key).export({ format: 'der', type: 'spki' }));
}
export function deriveKey(key: Uint8Array, salt: string, header: Uint8Array, domain: 'ssterm-sync-data-key-v1' | 'ssterm-sync-recovery-key-v1'): Buffer {
  key32(key); requireValue(isHex(salt, 32));
  requireValue(domain === 'ssterm-sync-data-key-v1' || domain === 'ssterm-sync-recovery-key-v1');
  return Buffer.from(hkdfSync('sha256', key, Buffer.from(salt, 'hex'), frame(domain, header), 32));
}
function encrypt(key: Uint8Array, nonce: string, header: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(nonce, 'hex'), { authTagLength: 16 });
  cipher.setAAD(header); return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
function decrypt(key: Uint8Array, nonce: string, header: Uint8Array, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'hex'), { authTagLength: 16 });
  decipher.setAAD(header); decipher.setAuthTag(ciphertext.subarray(-16));
  const staged = decipher.update(ciphertext.subarray(0, -16));
  try { return Buffer.concat([staged, decipher.final()]); } finally { staged.fill(0); }
}
function signature(domain: string, header: Uint8Array, ciphertext: Uint8Array, key: KeyObject): Buffer {
  checkKey(key, 'ed25519', true); return sign(null, frame(domain, header, ciphertext), key);
}
function verifySignature(domain: string, header: Uint8Array, ciphertext: Uint8Array, sig: Uint8Array, key: KeyObject): void {
  checkKey(key, 'ed25519'); requireValue(sig.length === 64 && verify(null, frame(domain, header, ciphertext), publicPart(key), sig));
}
export function sealOperation(h: DataHeader, parents: readonly string[], epochKey: Uint8Array, plaintext: Uint8Array, signer: KeyObject): Buffer {
  const header = dataHeader(h); requireValue(h.parentsDigest === parentsDigest(parents) && plaintext.length === h.plaintextLength);
  const key = deriveKey(epochKey, h.salt, header, 'ssterm-sync-data-key-v1');
  try {
    const ciphertext = encrypt(key, h.nonce, header, plaintext);
    return frame(header, ciphertext, signature('ssterm-sync-data-sign-v1', header, ciphertext, signer));
  } finally { key.fill(0); }
}
export function openOperation(wire: Uint8Array, expected: DataHeader, parents: readonly string[], epochKey: Uint8Array, signer: KeyObject): Buffer {
  const [header, ciphertext, sig] = unframe(wire, 3, DATA_MAX + 16, DATA_MAX + 2048);
  const h = parseDataHeader(header);
  requireValue(header.equals(dataHeader(expected)) && h.parentsDigest === parentsDigest(parents) && ciphertext.length === h.plaintextLength + 16);
  verifySignature('ssterm-sync-data-sign-v1', header, ciphertext, sig, signer);
  const key = deriveKey(epochKey, h.salt, header, 'ssterm-sync-data-key-v1');
  try { return decrypt(key, h.nonce, header, ciphertext); } finally { key.fill(0); }
}
export function operationCommitment(wire: Uint8Array): string {
  const [header, ciphertext, sig] = unframe(wire, 3, DATA_MAX + 16, DATA_MAX + 2048);
  const h = parseDataHeader(header); requireValue(ciphertext.length === h.plaintextLength + 16 && sig.length === 64);
  return digest(frame('ssterm-sync-data-commit-v1', header, ciphertext, sig));
}
export function wrapEpoch(h: WrapHeader, epochKey: Uint8Array, recipient: KeyObject, issuer: KeyObject): Buffer {
  const header = wrapHeader(h); key32(epochKey); checkKey(recipient, 'rsa');
  requireValue(fingerprint(recipient) === h.recipientFingerprint && fingerprint(issuer) === h.issuerFingerprint);
  const ciphertext = publicEncrypt({ key: publicPart(recipient), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: header }, epochKey);
  return frame(header, ciphertext, signature('ssterm-sync-wrap-sign-v1', header, ciphertext, issuer));
}
export function unwrapEpoch(wire: Uint8Array, expected: WrapHeader, recipient: KeyObject, issuer: KeyObject): Buffer {
  const [header, ciphertext, sig] = unframe(wire, 3, HEADER_MAX, 2048);
  const h = parseWrapHeader(header); checkKey(recipient, 'rsa', true);
  requireValue(header.equals(wrapHeader(expected)) && ciphertext.length === 384);
  requireValue(fingerprint(recipient) === h.recipientFingerprint && fingerprint(issuer) === h.issuerFingerprint);
  verifySignature('ssterm-sync-wrap-sign-v1', header, ciphertext, sig, issuer);
  const key = privateDecrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: header }, ciphertext);
  try { key32(key); return Buffer.from(key); } finally { key.fill(0); }
}
export function sealRecovery(h: RecoveryHeader, secret: Uint8Array, plaintext: Uint8Array): Buffer {
  const header = recoveryHeader(h); requireValue(plaintext.length === h.plaintextLength);
  const key = deriveKey(secret, h.salt, header, 'ssterm-sync-recovery-key-v1');
  try { return frame(header, encrypt(key, h.nonce, header, plaintext)); } finally { key.fill(0); }
}
export function openRecovery(wire: Uint8Array, expected: RecoveryHeader, secret: Uint8Array): Buffer {
  const [header, ciphertext] = unframe(wire, 2);
  const h = parseRecoveryHeader(header); requireValue(header.equals(recoveryHeader(expected)) && ciphertext.length === h.plaintextLength + 16);
  const key = deriveKey(secret, h.salt, header, 'ssterm-sync-recovery-key-v1');
  try { return decrypt(key, h.nonce, header, ciphertext); } finally { key.fill(0); }
}
