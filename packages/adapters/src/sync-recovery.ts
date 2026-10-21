/** Canonical recovery payload codec. Call only after authenticating the recovery envelope.
 * Bundled checkpoints prove signatures and scope, never server freshness or roster adoption. */
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { SUITE, RECOVERY_MAX, SyncCryptoError, cryptoGuard, fingerprint, frame, unframe, recoveryHeader, type RecoveryHeader } from './sync-crypto.ts';
import { controlCommitment, readControl } from './sync-control.ts';

export type RecoveryBinding = Pick<RecoveryHeader, 'deploymentId' | 'accountId' | 'vaultId' | 'recoveryId' | 'controlHash'>;
export type RecoveryPayload = {
  ownerKey: KeyObject;
  previousOwnerKey: KeyObject;
  baseControlWire: Uint8Array;
  epochs: Array<{ epoch: number; key: Uint8Array }>;
};
const EPOCH_MAX = 4096;
const EPOCH_WIRE_MAX = 512 * 1024;
function check(ok: unknown): asserts ok { if (!ok) throw new SyncCryptoError(); }
function ascii(bytes: Buffer): string { check(bytes.every((v) => v >= 32 && v <= 126)); return bytes.toString('ascii'); }
function integer(bytes: Buffer, max: number): number {
  const s = ascii(bytes); check(/^[1-9][0-9]*$/.test(s)); const n = Number(s);
  check(Number.isSafeInteger(n) && n <= max); return n;
}
function spki(key: KeyObject): Buffer {
  check(key.asymmetricKeyType === 'ed25519');
  return (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' });
}
function canonicalPublic(raw: Buffer): KeyObject {
  check(raw.length === 44); const key = createPublicKey({ key: raw, format: 'der', type: 'spki' });
  check(spki(key).equals(raw)); return key;
}
function decodeImpl(bytes: Uint8Array, binding: RecoveryBinding, expectedOwnerFingerprint: string): RecoveryPayload {
  check(bytes instanceof Uint8Array && bytes.length <= RECOVERY_MAX && /^[0-9a-f]{64}$/.test(expectedOwnerFingerprint));
  // Reuse the envelope codec's exact identifier/commitment validation.
  recoveryHeader({ ...binding, ...{ salt: '00'.repeat(32), nonce: '00'.repeat(12), plaintextLength: bytes.length } });
  const f = unframe(bytes, 12, RECOVERY_MAX, RECOVERY_MAX);
  const epochs: RecoveryPayload['epochs'] = [];
  let returned = false;
  try {
    check(ascii(f[0]) === 'ssterm-sync-recovery-payload-v1' && ascii(f[1]) === '1' && ascii(f[2]) === SUITE);
    check([binding.deploymentId, binding.accountId, binding.vaultId, binding.recoveryId].every((v, i) => ascii(f[i + 3]) === v));
    check(f[7].length === 48);
    const ownerKey = createPrivateKey({ key: f[7], format: 'der', type: 'pkcs8' });
    check(ownerKey.asymmetricKeyType === 'ed25519');
    const canonicalPrivate = ownerKey.export({ format: 'der', type: 'pkcs8' });
    try { check(canonicalPrivate.equals(f[7])); } finally { canonicalPrivate.fill(0); }
    const owner = canonicalPublic(f[8]); const previousOwnerKey = canonicalPublic(f[9]);
    check(spki(ownerKey).equals(f[8]) && fingerprint(owner) === expectedOwnerFingerprint);
    const control = readControl(f[10], binding, previousOwnerKey, expectedOwnerFingerprint);
    check(controlCommitment(f[10]) === binding.controlHash && spki(control.newOwnerKey).equals(f[8]));
    const epochWire = f[11]; check(epochWire.length <= EPOCH_WIRE_MAX);
    const prefix = frame('ssterm-sync-recovery-epochs-v1');
    check(epochWire.subarray(0, prefix.length).equals(prefix) && epochWire.length >= prefix.length + 4);
    const length = epochWire.readUInt32BE(prefix.length);
    check(length >= 1 && length <= 4 && epochWire.length >= prefix.length + 4 + length);
    const count = integer(epochWire.subarray(prefix.length + 4, prefix.length + 4 + length), EPOCH_MAX);
    const entries = unframe(epochWire, count + 2, 128, EPOCH_WIRE_MAX);
    let previous = 0;
    try {
      for (const entry of entries.slice(2)) {
        const pair = unframe(entry, 2, 32, 128);
        try {
          const [rawEpoch, key] = pair;
          const epoch = integer(rawEpoch, control.activeEpoch);
          check(epoch > previous && key.length === 32); previous = epoch;
          epochs.push({ epoch, key: Buffer.from(key) });
        } finally { for (const field of pair) field.fill(0); }
      }
    } finally { for (const entry of entries) entry.fill(0); }
    check(previous === control.activeEpoch);
    const result = { ownerKey, previousOwnerKey, baseControlWire: Buffer.from(f[10]), epochs };
    returned = true;
    return result;
  } finally {
    // These are owned unframe copies. The caller owns and must clear bytes itself.
    for (const field of f) field.fill(0);
    if (!returned) for (const epoch of epochs) epoch.key.fill(0);
  }
}

function encodeImpl(payload: RecoveryPayload, binding: RecoveryBinding, expectedOwnerFingerprint: string): Buffer {
  check(payload.ownerKey.type === 'private' && payload.ownerKey.asymmetricKeyType === 'ed25519');
  check(payload.epochs.length >= 1 && payload.epochs.length <= EPOCH_MAX);
  const entries: Buffer[] = [];
  let epochs: Buffer | undefined;
  let privateKey: Buffer | undefined;
  try {
    for (const { epoch, key } of payload.epochs) {
      check(key instanceof Uint8Array && key.length === 32); entries.push(frame(String(epoch), key));
    }
    epochs = frame('ssterm-sync-recovery-epochs-v1', String(payload.epochs.length), ...entries);
    privateKey = payload.ownerKey.export({ format: 'der', type: 'pkcs8' });
    const bytes = frame('ssterm-sync-recovery-payload-v1', '1', SUITE,
      binding.deploymentId, binding.accountId, binding.vaultId, binding.recoveryId,
      privateKey, spki(payload.ownerKey), spki(payload.previousOwnerKey), payload.baseControlWire, epochs);
    try {
      const decoded = decodeImpl(bytes, binding, expectedOwnerFingerprint);
      for (const epoch of decoded.epochs) epoch.key.fill(0);
      return bytes;
    } catch (error) { bytes.fill(0); throw error; }
  } finally {
    for (const entry of entries) entry.fill(0);
    privateKey?.fill(0); epochs?.fill(0);
  }
}

export const encodeRecoveryPayload = cryptoGuard(encodeImpl);
export const decodeRecoveryPayload = cryptoGuard(decodeImpl);

export type RecoveryDescriptor = Pick<RecoveryBinding, 'deploymentId' | 'accountId' | 'vaultId' | 'recoveryId'> & { recoveryEnvelopeHash: string };
function descriptorImpl(d: RecoveryDescriptor): Buffer {
  check(/^[0-9a-f]{64}$/.test(d.recoveryEnvelopeHash));
  recoveryHeader({ ...d, controlHash: '00'.repeat(32), salt: '00'.repeat(32), nonce: '00'.repeat(12), plaintextLength: 0 });
  return frame('ssterm-sync-recovery-descriptor-v1', '1', SUITE, d.deploymentId, d.accountId, d.vaultId, d.recoveryId, d.recoveryEnvelopeHash);
}
export const recoveryDescriptor = cryptoGuard(descriptorImpl);
export const parseRecoveryDescriptor = cryptoGuard((bytes: Uint8Array): RecoveryDescriptor => {
  const f = unframe(bytes, 8, 1024, 1024).map(ascii);
  check(f[0] === 'ssterm-sync-recovery-descriptor-v1' && f[1] === '1' && f[2] === SUITE);
  const d = { deploymentId: f[3], accountId: f[4], vaultId: f[5], recoveryId: f[6], recoveryEnvelopeHash: f[7] };
  check(descriptorImpl(d).equals(Buffer.from(bytes))); return d;
});
export const recoveryDescriptorDigest = cryptoGuard((bytes: Uint8Array): string => {
  parseRecoveryDescriptor(bytes); return createHash('sha256').update(bytes).digest('hex');
});
