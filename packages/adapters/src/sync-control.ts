import { constants, createHash, createPublicKey, privateDecrypt, publicEncrypt, sign, verify, type KeyObject } from 'node:crypto';
import { SUITE, fingerprint, frame, unframe, cryptoGuard, SyncCryptoError, type DataHeader } from './sync-crypto.ts';

export type Scope = Pick<DataHeader, 'deploymentId' | 'accountId' | 'vaultId'>;
export type Role = 'owner' | 'writer' | 'reader';
export type Certificate = Scope & { deviceId: string; signingKey: KeyObject; wrappingKey: KeyObject;
  role: Role; enrollmentHash: string; ownerFingerprint: string; firstGeneration: number };
export type Control = Scope & { generation: number; previousHash: string; previousOwnerFingerprint: string;
  newOwnerKey: KeyObject; ownerDeviceId: string; activeEpoch: number; rosterDigest: string; recoveryDescriptorDigest: string };
export type AcceptedControl = { control: Control; commitment: string; certificates: Certificate[] };
export type Enrollment = Scope & { requestId: string; newDeviceId: string; signingKey: KeyObject; wrappingKey: KeyObject;
  requestedRole: Role; issuerOwnerFingerprint: string; baseControlHash: string; nonce: string; expiresAtUnix: number };
export type EnrollmentApproval = { enrollmentHash: string; challengeSecret: Uint8Array; nowUnix: number;
  monotonicNow: number; monotonicDeadline: number; used: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const ZERO = '0'.repeat(64);
function check(ok: unknown): asserts ok { if (!ok) throw new SyncCryptoError(); }
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function text(b: Buffer): string { check(b.every((v) => v >= 32 && v <= 126)); return b.toString('ascii'); }
function integer(b: Buffer, max = 0xffffffff, min = 1): number {
  const s = text(b); check(/^(0|[1-9][0-9]*)$/.test(s)); const n = Number(s);
  check(Number.isSafeInteger(n) && n >= min && n <= max); return n;
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.deploymentId === b.deploymentId && a.accountId === b.accountId && a.vaultId === b.vaultId;
}
function scopeFields(s: Scope): string[] { return [s.deploymentId, s.accountId, s.vaultId]; }
function parsePrefix(f: Buffer[], domain: string): Scope {
  check(text(f[0]) === domain && text(f[1]) === '1' && text(f[2]) === SUITE);
  const ids = f.slice(3, 6).map(text); check(ids.every((id) => UUID.test(id)));
  return { deploymentId: ids[0], accountId: ids[1], vaultId: ids[2] };
}
function spki(key: KeyObject): Buffer {
  fingerprint(key); return (key.type === 'public' ? key : createPublicKey(key)).export({ format: 'der', type: 'spki' });
}
function publicKey(raw: Buffer, algorithm: 'ed25519' | 'rsa'): KeyObject {
  check(raw.length === (algorithm === 'ed25519' ? 44 : 422));
  const key = createPublicKey({ key: raw, format: 'der', type: 'spki' });
  check(key.asymmetricKeyType === algorithm && spki(key).equals(raw)); return key;
}
function signTranscript(domain: string, body: Uint8Array, key: KeyObject): Buffer {
  check(key.type === 'private' && key.asymmetricKeyType === 'ed25519'); return sign(null, frame(domain, body), key);
}
function verifyTranscript(domain: string, body: Uint8Array, sig: Uint8Array, key: KeyObject): void {
  check(key.asymmetricKeyType === 'ed25519' && sig.length === 64);
  check(verify(null, frame(domain, body), key.type === 'public' ? key : createPublicKey(key), sig));
}
function role(s: string): Role { check(s === 'owner' || s === 'writer' || s === 'reader'); return s; }
function certificateBodyImpl(c: Certificate): Buffer {
  const body = frame('ssterm-sync-certificate-v1', '1', SUITE, ...scopeFields(c), c.deviceId,
    spki(c.signingKey), spki(c.wrappingKey), c.role, c.enrollmentHash, c.ownerFingerprint, String(c.firstGeneration));
  parseCertificateBody(body); return body;
}
function parseCertificateBodyImpl(body: Uint8Array): Certificate {
  const f = unframe(body, 13, 1536, 1536); const scope = parsePrefix(f, 'ssterm-sync-certificate-v1');
  check(UUID.test(text(f[6])) && HEX.test(text(f[10])) && HEX.test(text(f[11])));
  return { ...scope, deviceId: text(f[6]), signingKey: publicKey(f[7], 'ed25519'), wrappingKey: publicKey(f[8], 'rsa'),
    role: role(text(f[9])), enrollmentHash: text(f[10]), ownerFingerprint: text(f[11]), firstGeneration: integer(f[12]) };
}
function sealCertificateImpl(c: Certificate, owner: KeyObject): Buffer {
  check(c.ownerFingerprint === fingerprint(owner)); const body = certificateBody(c);
  return frame(body, signTranscript('ssterm-sync-certificate-sign-v1', body, owner));
}
function readCertificateImpl(wire: Uint8Array, owner: KeyObject): Certificate {
  const [body, sig] = unframe(wire, 2, 1536, 2048); const c = parseCertificateBody(body);
  check(c.ownerFingerprint === fingerprint(owner)); verifyTranscript('ssterm-sync-certificate-sign-v1', body, sig, owner); return c;
}
function certificateCommitmentImpl(wire: Uint8Array): string {
  const [body, sig] = unframe(wire, 2, 1536, 2048); parseCertificateBody(body); check(sig.length === 64);
  return hash(frame('ssterm-sync-certificate-commit-v1', body, sig));
}
function rosterBytesImpl(certificates: readonly Uint8Array[]): Buffer {
  check(certificates.length >= 1 && certificates.length <= 256);
  const result = frame('ssterm-sync-roster-v1', String(certificates.length), ...certificates);
  check(result.length <= 1024 * 1024); return result;
}
function rosterCommitmentImpl(roster: Uint8Array): string { check(roster.length <= 1024 * 1024); return hash(roster); }
function rosterEntriesImpl(roster: Uint8Array): Buffer[] {
  check(roster.length <= 1024 * 1024);
  const prefix = frame('ssterm-sync-roster-v1'); const bytes = Buffer.from(roster);
  check(bytes.subarray(0, prefix.length).equals(prefix) && bytes.length >= prefix.length + 4);
  const countLength = bytes.readUInt32BE(prefix.length); check(countLength >= 1 && countLength <= 3);
  check(bytes.length >= prefix.length + 4 + countLength);
  const count = integer(bytes.subarray(prefix.length + 4, prefix.length + 4 + countLength), 256);
  const f = unframe(bytes, count + 2, 2048, 1024 * 1024);
  return f.slice(2);
}
function readRoster(roster: Uint8Array, owner: KeyObject): Certificate[] {
  const certificates = rosterEntries(roster).map((wire) => readCertificate(wire, owner));
  const fingerprints = new Set<string>();
  for (let i = 0; i < certificates.length; i++) {
    const c = certificates[i]; check(i === 0 || certificates[i - 1].deviceId < c.deviceId);
    for (const key of [c.signingKey, c.wrappingKey]) {
      const fp = fingerprint(key); check(!fingerprints.has(fp)); fingerprints.add(fp);
    }
  }
  return certificates;
}
function controlBodyImpl(c: Control): Buffer {
  const body = frame('ssterm-sync-control-v1', '1', SUITE, ...scopeFields(c), String(c.generation), c.previousHash,
    c.previousOwnerFingerprint, spki(c.newOwnerKey), c.ownerDeviceId, String(c.activeEpoch), c.rosterDigest, c.recoveryDescriptorDigest);
  parseControlBody(body); return body;
}
function parseControlBodyImpl(body: Uint8Array): Control {
  const f = unframe(body, 14, 1024, 1024); const scope = parsePrefix(f, 'ssterm-sync-control-v1');
  check([f[7], f[8], f[12], f[13]].every((b) => HEX.test(text(b))) && UUID.test(text(f[10])));
  return { ...scope, generation: integer(f[6]), previousHash: text(f[7]), previousOwnerFingerprint: text(f[8]),
    newOwnerKey: publicKey(f[9], 'ed25519'), ownerDeviceId: text(f[10]), activeEpoch: integer(f[11]),
    rosterDigest: text(f[12]), recoveryDescriptorDigest: text(f[13]) };
}
function sealControlImpl(c: Control, oldOwner: KeyObject, newOwner: KeyObject): Buffer {
  check(c.previousOwnerFingerprint === fingerprint(oldOwner) && fingerprint(c.newOwnerKey) === fingerprint(newOwner));
  const body = controlBody(c); return frame(body, signTranscript('ssterm-sync-control-authorize-v1', body, oldOwner),
    signTranscript('ssterm-sync-control-possession-v1', body, newOwner));
}
function acceptControlImpl(wire: Uint8Array, roster: Uint8Array, scope: Scope, pinnedOwner: KeyObject, current?: AcceptedControl): AcceptedControl {
  const [body, authorize, possession] = unframe(wire, 3, 1024, 2048); const c = parseControlBody(body);
  check(sameScope(c, scope));
  const oldOwner = current?.control.newOwnerKey ?? pinnedOwner;
  check(c.previousOwnerFingerprint === fingerprint(oldOwner));
  verifyTranscript('ssterm-sync-control-authorize-v1', body, authorize, oldOwner);
  verifyTranscript('ssterm-sync-control-possession-v1', body, possession, c.newOwnerKey);
  const certificates = validatedRoster(c, roster);
  const owners = certificates.filter((cert) => cert.role === 'owner');
  if (!current) {
    check(c.generation === 1 && c.previousHash === ZERO && c.activeEpoch === 1);
    check(fingerprint(c.newOwnerKey) === fingerprint(pinnedOwner));
    check(certificates.length === 1 && owners[0].firstGeneration === 1 && owners[0].enrollmentHash === ZERO);
  } else {
    check(sameScope(current.control, c) && c.generation === current.control.generation + 1 && c.previousHash === current.commitment);
    check(c.activeEpoch === current.control.activeEpoch || c.activeEpoch === current.control.activeEpoch + 1);
    for (const cert of certificates) {
      const previous = current.certificates.find((old) => old.deviceId === cert.deviceId &&
        fingerprint(old.signingKey) === fingerprint(cert.signingKey) && fingerprint(old.wrappingKey) === fingerprint(cert.wrappingKey));
      if (previous) check(cert.firstGeneration === previous.firstGeneration && cert.enrollmentHash === previous.enrollmentHash);
      else check(cert.firstGeneration === c.generation && cert.enrollmentHash !== ZERO);
    }
    const losesAccess = current.certificates.some((old) => {
      const next = certificates.find((cert) => cert.deviceId === old.deviceId);
      return !next || fingerprint(next.signingKey) !== fingerprint(old.signingKey) || fingerprint(next.wrappingKey) !== fingerprint(old.wrappingKey) ||
        (old.role !== 'reader' && next.role === 'reader');
    });
    const ownerChanges = fingerprint(c.newOwnerKey) !== fingerprint(oldOwner) || c.ownerDeviceId !== current.control.ownerDeviceId;
    check(!(losesAccess || ownerChanges) || c.activeEpoch === current.control.activeEpoch + 1);
  }
  return { control: c, certificates, commitment: hash(frame('ssterm-sync-control-commit-v1', body, authorize, possession)) };
}
// Caller must authenticate an operation against its referenced retained checkpoint
// before asking how it may affect the current view. This does not decrypt or persist.
function operationDispositionImpl(h: DataHeader, current: AcceptedControl): 'materialize' | 'conflict' | 'reject' {
  if (!sameScope(h, current.control) || h.epoch > current.control.activeEpoch) return 'reject';
  if (h.epoch < current.control.activeEpoch || h.controlHash !== current.commitment) return 'conflict';
  const cert = current.certificates.find((c) => c.deviceId === h.authorDeviceId);
  return cert && cert.role !== 'reader' ? 'materialize' : 'reject';
}
function enrollmentBodyImpl(e: Enrollment): Buffer {
  const body = frame('ssterm-sync-enroll-v1', '1', SUITE, ...scopeFields(e), e.requestId, e.newDeviceId,
    spki(e.signingKey), spki(e.wrappingKey), e.requestedRole, e.issuerOwnerFingerprint, e.baseControlHash, e.nonce, String(e.expiresAtUnix));
  parseEnrollmentBody(body); return body;
}
function parseEnrollmentBodyImpl(body: Uint8Array): Enrollment {
  const f = unframe(body, 15, 1536, 1536); const scope = parsePrefix(f, 'ssterm-sync-enroll-v1');
  check(UUID.test(text(f[6])) && UUID.test(text(f[7])) && [f[11], f[12], f[13]].every((b) => HEX.test(text(b))));
  return { ...scope, requestId: text(f[6]), newDeviceId: text(f[7]), signingKey: publicKey(f[8], 'ed25519'),
    wrappingKey: publicKey(f[9], 'rsa'), requestedRole: role(text(f[10])), issuerOwnerFingerprint: text(f[11]),
    baseControlHash: text(f[12]), nonce: text(f[13]), expiresAtUnix: integer(f[14], 4102444800) };
}
function enrollmentHashImpl(body: Uint8Array, challenge: Uint8Array): string {
  parseEnrollmentBody(body); check(challenge.length === 384);
  return hash(frame('ssterm-sync-enroll-fingerprint-v1', body, challenge));
}
function decryptProof(hashHex: string, secret: Uint8Array, challenge: Uint8Array): string {
  check(secret.length === 32); return hash(frame('ssterm-sync-enroll-decrypt-proof-v1', hashHex, secret, challenge));
}
function challengeEnrollmentImpl(e: Enrollment, secret: Uint8Array): Buffer {
  check(secret.length === 32); const body = enrollmentBody(e);
  return publicEncrypt({ key: e.wrappingKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
    oaepLabel: frame('ssterm-sync-enroll-oaep-v1', body) }, secret);
}
function proveEnrollmentImpl(body: Uint8Array, challenge: Uint8Array, signing: KeyObject, wrapping: KeyObject): Buffer {
  const e = parseEnrollmentBody(body); check(challenge.length === 384);
  check(fingerprint(signing) === fingerprint(e.signingKey) && fingerprint(wrapping) === fingerprint(e.wrappingKey));
  const secret = privateDecrypt({ key: wrapping, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
    oaepLabel: frame('ssterm-sync-enroll-oaep-v1', body) }, challenge);
  try {
    const proof = decryptProof(enrollmentHash(body, challenge), secret, challenge);
    check(signing.type === 'private' && signing.asymmetricKeyType === 'ed25519');
    return frame(body, challenge, proof, sign(null, frame('ssterm-sync-enroll-sign-proof-v1', body, challenge, proof), signing));
  } finally { secret.fill(0); }
}
function verifyEnrollmentImpl(wire: Uint8Array, current: AcceptedControl, approval: EnrollmentApproval): Enrollment {
  const [body, challenge, rawProof, sig] = unframe(wire, 4, 1536, 4096); const e = parseEnrollmentBody(body);
  check(sameScope(e, current.control) && e.baseControlHash === current.commitment && e.issuerOwnerFingerprint === fingerprint(current.control.newOwnerKey));
  check(fingerprint(e.signingKey) !== fingerprint(current.control.newOwnerKey));
  check(current.certificates.every((cert) => cert.deviceId !== e.newDeviceId &&
    fingerprint(cert.signingKey) !== fingerprint(e.signingKey) && fingerprint(cert.wrappingKey) !== fingerprint(e.wrappingKey)));
  check(!approval.used && Number.isFinite(approval.monotonicNow) && Number.isFinite(approval.monotonicDeadline) &&
    approval.monotonicNow < approval.monotonicDeadline && approval.monotonicDeadline - approval.monotonicNow <= 300);
  check(Number.isSafeInteger(approval.nowUnix) && e.expiresAtUnix > approval.nowUnix && e.expiresAtUnix - approval.nowUnix <= 300);
  check(enrollmentHash(body, challenge) === approval.enrollmentHash);
  const proof = text(rawProof); check(HEX.test(proof) && proof === decryptProof(approval.enrollmentHash, approval.challengeSecret, challenge));
  check(sig.length === 64 && verify(null, frame('ssterm-sync-enroll-sign-proof-v1', body, challenge, proof), e.signingKey, sig));
  return e;
}

/** Checks a checkpoint's self-contained dual signatures against a caller's trusted keys.
 * This does not check freshness, roster or progression; use acceptControl for adoption. */
function readControlImpl(wire: Uint8Array, scope: Scope, previousOwner: KeyObject, expectedOwnerFingerprint: string): Control {
  const [body, authorize, possession] = unframe(wire, 3, 1024, 2048);
  const c = parseControlBody(body);
  check(sameScope(c, scope) && c.previousOwnerFingerprint === fingerprint(previousOwner) && fingerprint(c.newOwnerKey) === expectedOwnerFingerprint);
  verifyTranscript('ssterm-sync-control-authorize-v1', body, authorize, previousOwner);
  verifyTranscript('ssterm-sync-control-possession-v1', body, possession, c.newOwnerKey);
  return c;
}
function controlCommitmentImpl(wire: Uint8Array): string {
  const [body, authorize, possession] = unframe(wire, 3, 1024, 2048);
  parseControlBody(body); check(authorize.length === 64 && possession.length === 64);
  return hash(frame('ssterm-sync-control-commit-v1', body, authorize, possession));
}

export const certificateBody = cryptoGuard(certificateBodyImpl);
export const parseCertificateBody = cryptoGuard(parseCertificateBodyImpl);
export const sealCertificate = cryptoGuard(sealCertificateImpl);
export const readCertificate = cryptoGuard(readCertificateImpl);
export const certificateCommitment = cryptoGuard(certificateCommitmentImpl);
export const rosterBytes = cryptoGuard(rosterBytesImpl);
export const rosterCommitment = cryptoGuard(rosterCommitmentImpl);
export const rosterEntries = cryptoGuard(rosterEntriesImpl);
export const controlBody = cryptoGuard(controlBodyImpl);
export const parseControlBody = cryptoGuard(parseControlBodyImpl);
export const sealControl = cryptoGuard(sealControlImpl);
export const acceptControl = cryptoGuard(acceptControlImpl);
export const operationDisposition = cryptoGuard(operationDispositionImpl);
export const enrollmentBody = cryptoGuard(enrollmentBodyImpl);
export const parseEnrollmentBody = cryptoGuard(parseEnrollmentBodyImpl);
export const enrollmentHash = cryptoGuard(enrollmentHashImpl);
export const challengeEnrollment = cryptoGuard(challengeEnrollmentImpl);
export const proveEnrollment = cryptoGuard(proveEnrollmentImpl);
/** Pure transcript verification only. The caller must durably consume the approval
 * exactly once and reconcile its publication journal before confirming enrollment. */
export const verifyEnrollment = cryptoGuard(verifyEnrollmentImpl);
export const readControl = cryptoGuard(readControlImpl);
export const controlCommitment = cryptoGuard(controlCommitmentImpl);

function validatedRoster(c: Control, roster: Uint8Array): Certificate[] {
  check(c.rosterDigest === rosterCommitment(roster));
  const certificates = readRoster(roster, c.newOwnerKey);
  check(certificates.every((cert) => sameScope(cert, c) && cert.firstGeneration <= c.generation));
  const owners = certificates.filter((cert) => cert.role === 'owner');
  check(owners.length === 1 && owners[0].deviceId === c.ownerDeviceId);
  check(certificates.every((cert) => fingerprint(cert.signingKey) !== fingerprint(c.newOwnerKey)));
  return certificates;
}
/** Adopts the base checkpoint authenticated by a decrypted recovery kit and its
 * independently expected owner fingerprint. This establishes no server freshness.
 * Ordinary transport checkpoints must always use sequential acceptControl. */
export const acceptRecoveryControl = cryptoGuard((wire: Uint8Array, roster: Uint8Array, scope: Scope,
  previousOwner: KeyObject, expectedOwnerFingerprint: string): AcceptedControl => {
  const c = readControl(wire, scope, previousOwner, expectedOwnerFingerprint);
  return { control: c, commitment: controlCommitment(wire), certificates: validatedRoster(c, roster) };
});
