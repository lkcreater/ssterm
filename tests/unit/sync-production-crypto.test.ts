import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as crypto from '../../packages/adapters/src/sync-crypto.ts';
import * as control from '../../packages/adapters/src/sync-control.ts';
import * as recovery from '../../packages/adapters/src/sync-recovery.ts';
import * as reference from '../fixtures/crypto/reference.ts';
import * as controlReference from '../fixtures/crypto/control-reference.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/crypto/${name}`, import.meta.url));
const golden = JSON.parse(fixture('project-golden.json').toString()) as {
  header: crypto.DataHeader; epochKeyHex: string; signingSeedHex: string; plaintextHex: string;
  headerHex: string; derivedKeyHex: string; ciphertextHex: string; signatureHex: string; commitment: string;
};
const cg = JSON.parse(fixture('control-golden.json').toString()) as Record<string, string>;
const hex = (s: string) => Buffer.from(s, 'hex');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const signing = (seed: string) => createPrivateKey({ key: hex(`302e020100300506032b657004220420${seed}`), format: 'der', type: 'pkcs8' });
const author = signing(golden.signingSeedHex);
const owner = signing(cg.ownerSeedHex);
const nextOwner = signing('ef'.repeat(32));
const rsaVectors = JSON.parse(fixture('rsa_oaep_3072_sha256_mgf1sha256_test.json').toString()) as {
  testGroups: Array<{ privateKeyPem: string }>;
};
const wrapping = createPrivateKey(rsaVectors.testGroups[0].privateKeyPem);
const ownerWrapping = createPublicKey(fixture('public-test-owner-rsa.pem'));
const scope = { deploymentId: golden.header.deploymentId, accountId: golden.header.accountId, vaultId: golden.header.vaultId };
const epochKey = hex(golden.epochKeyHex);
const plaintext = hex(golden.plaintextHex);
const ownerCertificate: control.Certificate = { ...scope, deviceId: golden.header.authorDeviceId, signingKey: createPublicKey(author), wrappingKey: ownerWrapping,
  role: 'owner', enrollmentHash: '0'.repeat(64), ownerFingerprint: crypto.fingerprint(owner), firstGeneration: 1 };
const ownerCertWire = control.sealCertificate(ownerCertificate, owner);
const roster = control.rosterBytes([ownerCertWire]);
const genesis: control.Control = { ...scope, generation: 1, previousHash: '0'.repeat(64), previousOwnerFingerprint: crypto.fingerprint(owner),
  newOwnerKey: createPublicKey(owner), ownerDeviceId: ownerCertificate.deviceId, activeEpoch: 1, rosterDigest: control.rosterCommitment(roster), recoveryDescriptorDigest: '0'.repeat(64) };
const genesisWire = control.sealControl(genesis, owner, owner);
const accepted = control.acceptControl(genesisWire, roster, scope, createPublicKey(owner));
const flip = (bytes: Uint8Array, index = 0) => { const copy = Buffer.from(bytes); copy[index] ^= 1; return copy; };
const invalid = (fn: () => unknown) => assert.throws(fn, (error) => error instanceof crypto.SyncCryptoError && error.code === 'invalid' &&
  error.message === 'Sync cryptography failed validation.' && error.cause === undefined);

// Immutable fixture values, not production-generated expectations, pin the wire suite.
test('production data matches fixed headers, HKDF, AEAD, signature and commitment golden bytes', () => {
  const wire = crypto.sealOperation(golden.header, [], epochKey, plaintext, author);
  const [header, ciphertext, signature] = crypto.unframe(wire, 3);
  assert.equal(header.toString('hex'), golden.headerHex);
  assert.equal(ciphertext.toString('hex'), golden.ciphertextHex);
  assert.equal(signature.toString('hex'), golden.signatureHex);
  assert.equal(crypto.operationCommitment(wire), golden.commitment);
  assert.equal(crypto.deriveKey(epochKey, golden.header.salt, header, 'ssterm-sync-data-key-v1').toString('hex'), golden.derivedKeyHex);
  assert.deepEqual(crypto.openOperation(wire, golden.header, [], epochKey, createPublicKey(author)), plaintext);
  assert.deepEqual(wire, reference.sealOperation(golden.header, [], epochKey, plaintext, author));
});

test('production rejects modified signature, AEAD tag, expected identity, key, and every truncated frame', () => {
  const wire = crypto.sealOperation(golden.header, [], epochKey, plaintext, author);
  const [header, ciphertext, signature] = crypto.unframe(wire, 3);
  invalid(() => crypto.openOperation(crypto.frame(header, ciphertext, flip(signature)), golden.header, [], epochKey, author));
  invalid(() => crypto.openOperation(crypto.frame(header, flip(ciphertext), signature), golden.header, [], epochKey, author));
  invalid(() => crypto.openOperation(wire, { ...golden.header, epoch: golden.header.epoch + 1 }, [], epochKey, author));
  invalid(() => crypto.openOperation(wire, golden.header, [], flip(epochKey), author));
  for (let i = 0; i < wire.length; i++) invalid(() => crypto.openOperation(wire.subarray(0, i), golden.header, [], epochKey, author));
});

test('production framing bounds counts, bytes and numeric canonicalization before crypto', () => {
  invalid(() => crypto.unframe(Buffer.from('ffffffff', 'hex'), 1));
  invalid(() => crypto.unframe(Buffer.alloc(0), 4099));
  invalid(() => crypto.unframe(Buffer.alloc(0), 0, 0, crypto.RECOVERY_MAX + 2049));
  invalid(() => crypto.unframe(Buffer.alloc(0), 0, -1));
  const f = crypto.unframe(crypto.dataHeader(golden.header), 14);
  f[6] = Buffer.from('01'); invalid(() => crypto.parseDataHeader(crypto.frame(...f)));
  invalid(() => crypto.parentsDigest(['f'.repeat(64), '0'.repeat(64)]));
  invalid(() => crypto.parentsDigest(['f'.repeat(64), 'f'.repeat(64)]));
  invalid(() => crypto.sealOperation({ ...golden.header, plaintextLength: crypto.DATA_MAX + 1 }, [], epochKey, plaintext, author));
  const input = crypto.frame(Buffer.of(42)); const [owned] = crypto.unframe(input, 1);
  input.fill(0); assert.deepEqual(owned, Buffer.of(42));
});

test('public primitive boundaries sanitize malformed runtime/native inputs', () => {
  // IPC and storage callers still receive a sanitized fault if type checking is bypassed.
  invalid(() => crypto.fingerprint({} as KeyObject));
  invalid(() => crypto.unframe(null as unknown as Uint8Array, 2));
  invalid(() => crypto.sealOperation(null as unknown as crypto.DataHeader, [], epochKey, plaintext, author));
  invalid(() => control.parseControlBody(Buffer.alloc(0)));
  invalid(() => recovery.decodeRecoveryPayload(Buffer.alloc(0), scope as recovery.RecoveryBinding, '0'.repeat(64)));
});

test('production RSA wrappers interoperate with independent reference and reject wrong recipient/scope/signature', () => {
  const h: crypto.WrapHeader = { ...scope, epoch: 1, recipientDeviceId: golden.header.authorDeviceId, recipientFingerprint: crypto.fingerprint(wrapping),
    issuerDeviceId: golden.header.operationId, issuerFingerprint: crypto.fingerprint(author), controlHash: accepted.commitment };
  const wire = crypto.wrapEpoch(h, epochKey, createPublicKey(wrapping), author);
  assert.deepEqual(reference.unwrapEpoch(wire, h, wrapping, author), epochKey);
  const other = reference.wrapEpoch(h, epochKey, wrapping, author);
  assert.deepEqual(crypto.unwrapEpoch(other, h, wrapping, author), epochKey);
  invalid(() => crypto.unwrapEpoch(other, { ...h, epoch: 2 }, wrapping, author));
  invalid(() => crypto.unwrapEpoch(other, h, wrapping, owner));
  invalid(() => crypto.unwrapEpoch(flip(other, other.length - 1), h, wrapping, author));
});

test('production certificate/control/roster transcripts match fixed golden and reference', () => {
  assert.equal(control.certificateBody(ownerCertificate).toString('hex'), cg.certificateBodyHex);
  assert.equal(ownerCertWire.toString('hex'), cg.certificateWireHex);
  assert.equal(control.certificateCommitment(ownerCertWire), cg.certificateCommitment);
  assert.equal(roster.toString('hex'), cg.rosterHex);
  assert.equal(control.controlBody(genesis).toString('hex'), cg.controlBodyHex);
  assert.equal(genesisWire.toString('hex'), cg.controlWireHex);
  assert.equal(accepted.commitment, cg.controlCommitment);
  assert.equal(control.controlCommitment(genesisWire), cg.controlCommitment);
  assert.deepEqual(controlReference.sealControl(genesis, owner, owner), genesisWire);
  assert.equal(controlReference.acceptControl(genesisWire, roster, scope, owner).commitment, accepted.commitment);
});

test('production control rejects replay, scope substitution, duplicate roster and unauthorized role', () => {
  invalid(() => control.acceptControl(genesisWire, roster, scope, owner, accepted));
  invalid(() => control.acceptControl(genesisWire, roster, { ...scope, accountId: golden.header.operationId }, owner));
  invalid(() => control.readCertificate(flip(ownerCertWire, ownerCertWire.length - 1), owner));
  invalid(() => control.certificateBody({ ...ownerCertificate, role: 'admin' as control.Role }));
  const duplicate = control.rosterBytes([ownerCertWire, ownerCertWire]);
  const duplicateControl = control.sealControl({ ...genesis, rosterDigest: control.rosterCommitment(duplicate) }, owner, owner);
  invalid(() => control.acceptControl(duplicateControl, duplicate, scope, owner));
});

const enrollment: control.Enrollment = { ...scope, requestId: golden.header.operationId, newDeviceId: golden.header.operationId,
  signingKey: createPublicKey(signing('ab'.repeat(32))), wrappingKey: createPublicKey(wrapping), requestedRole: 'writer',
  issuerOwnerFingerprint: crypto.fingerprint(owner), baseControlHash: accepted.commitment, nonce: 'ab'.repeat(32), expiresAtUnix: 2000000000 };
const approval = () => ({ enrollmentHash: cg.enrollmentHash, challengeSecret: hex(cg.challengeSecretHex),
  nowUnix: 1999999900, monotonicNow: 10, monotonicDeadline: 110, used: false });

test('production enrollment matches fixed proof and enforces pinned channel and deadline', () => {
  const body = control.enrollmentBody(enrollment);
  assert.equal(body.toString('hex'), cg.enrollmentBodyHex);
  const proof = control.proveEnrollment(body, hex(cg.challengeHex), signing('ab'.repeat(32)), wrapping);
  assert.equal(proof.toString('hex'), cg.proofWireHex);
  assert.equal(control.verifyEnrollment(proof, accepted, approval()).newDeviceId, enrollment.newDeviceId);
  assert.equal(controlReference.verifyEnrollment(proof, accepted, approval()).newDeviceId, enrollment.newDeviceId);
  invalid(() => control.verifyEnrollment(proof, accepted, { ...approval(), used: true }));
  invalid(() => control.verifyEnrollment(proof, accepted, { ...approval(), monotonicNow: 110 }));
  invalid(() => control.verifyEnrollment(proof, accepted, { ...approval(), nowUnix: enrollment.expiresAtUnix }));
  invalid(() => control.verifyEnrollment(proof, accepted, { ...approval(), enrollmentHash: '0'.repeat(64) }));
  invalid(() => control.verifyEnrollment(proof, accepted, { ...approval(), challengeSecret: Buffer.alloc(32) }));
});

test('generated challenge and recovery entropy use fresh bounded CSPRNG material', async () => {
  const entropy = crypto.freshEntropy(); const other = crypto.freshEntropy();
  assert.match(entropy.salt, /^[0-9a-f]{64}$/); assert.match(entropy.nonce, /^[0-9a-f]{24}$/);
  assert.notEqual(entropy.salt, other.salt); assert.notEqual(entropy.nonce, other.nonce);
  assert.equal(crypto.generateEpochKey().length, 32); assert.equal(crypto.generateRecoverySecret().length, 32);
  assert.notDeepEqual(crypto.generateRecoverySecret(), crypto.generateRecoverySecret());
  const device = await crypto.generateDeviceKeys();
  assert.equal(device.wrappingKey.asymmetricKeyDetails?.modulusLength, 3072);
  assert.equal(device.wrappingKey.asymmetricKeyDetails?.publicExponent, 65537n);
  assert.equal(device.signingKey.asymmetricKeyType, 'ed25519');
  assert.notEqual(crypto.fingerprint(device.signingKey), crypto.fingerprint(author));
  const secret = crypto.generateEpochKey();
  const challenge = control.challengeEnrollment(enrollment, secret);
  const proof = control.proveEnrollment(control.enrollmentBody(enrollment), challenge, signing('ab'.repeat(32)), wrapping);
  const fingerprint = control.enrollmentHash(control.enrollmentBody(enrollment), challenge);
  assert.equal(control.verifyEnrollment(proof, accepted, { ...approval(), enrollmentHash: fingerprint, challengeSecret: secret }).newDeviceId, enrollment.newDeviceId);
});

const binding: recovery.RecoveryBinding = { ...scope, recoveryId: golden.header.operationId, controlHash: accepted.commitment };
const payload = (): recovery.RecoveryPayload => ({ ownerKey: owner, previousOwnerKey: createPublicKey(owner), baseControlWire: genesisWire, epochs: [{ epoch: 1, key: Buffer.from(epochKey) }] });

test('recovery payload has exact documented framing and authenticates expected owner before returning keys', () => {
  const encoded = recovery.encodeRecoveryPayload(payload(), binding, crypto.fingerprint(owner));
  const expected = crypto.frame('ssterm-sync-recovery-payload-v1', '1', crypto.SUITE,
    scope.deploymentId, scope.accountId, scope.vaultId, binding.recoveryId,
    owner.export({ format: 'der', type: 'pkcs8' }), createPublicKey(owner).export({ format: 'der', type: 'spki' }),
    createPublicKey(owner).export({ format: 'der', type: 'spki' }), genesisWire,
    crypto.frame('ssterm-sync-recovery-epochs-v1', '1', crypto.frame('1', epochKey)));
  assert.deepEqual(encoded, expected);
  const recovered = recovery.decodeRecoveryPayload(encoded, binding, crypto.fingerprint(owner));
  assert.equal(crypto.fingerprint(recovered.ownerKey), crypto.fingerprint(owner));
  assert.deepEqual(recovered.epochs[0].key, epochKey);
  invalid(() => recovery.decodeRecoveryPayload(encoded, binding, crypto.fingerprint(nextOwner)));
  invalid(() => recovery.decodeRecoveryPayload(encoded, { ...binding, controlHash: '0'.repeat(64) }, crypto.fingerprint(owner)));
  invalid(() => recovery.decodeRecoveryPayload(encoded, { ...binding, recoveryId: scope.accountId }, crypto.fingerprint(owner)));
});

test('recovery envelopes interoperate with reference and never release plaintext on failed AEAD', () => {
  const encoded = recovery.encodeRecoveryPayload(payload(), binding, crypto.fingerprint(owner));
  const h = { ...binding, ...crypto.freshEntropy(), plaintextLength: encoded.length };
  const secret = crypto.generateRecoverySecret();
  const wire = crypto.sealRecovery(h, secret, encoded);
  assert.deepEqual(reference.openRecovery(wire, h, secret), encoded);
  assert.deepEqual(crypto.openRecovery(reference.sealRecovery(h, secret, encoded), h, secret), encoded);
  invalid(() => crypto.openRecovery(wire, h, flip(secret)));
  invalid(() => crypto.openRecovery(flip(wire, wire.length - 1), h, secret));
  invalid(() => crypto.openRecovery(wire, { ...h, recoveryId: scope.accountId }, secret));
});

function rollover() {
  const newRoster = control.rosterBytes([control.sealCertificate({ ...ownerCertificate, ownerFingerprint: crypto.fingerprint(nextOwner) }, nextOwner)]);
  const c: control.Control = { ...genesis, generation: 2, previousHash: accepted.commitment, newOwnerKey: createPublicKey(nextOwner), activeEpoch: 2, rosterDigest: control.rosterCommitment(newRoster) };
  const wire = control.sealControl(c, owner, nextOwner);
  const next = control.acceptControl(wire, newRoster, scope, owner, accepted);
  return { c, wire, next, roster: newRoster, binding: { ...binding, controlHash: next.commitment },
    payload: { ownerKey: nextOwner, previousOwnerKey: createPublicKey(owner), baseControlWire: wire,
      epochs: [{ epoch: 1, key: epochKey }, { epoch: 2, key: Buffer.alloc(32, 2) }] } };
}

test('recovery supports owner rollover using distinct predecessor authorization and new-owner possession', () => {
  const r = rollover();
  const bytes = recovery.encodeRecoveryPayload(r.payload, r.binding, crypto.fingerprint(nextOwner));
  assert.equal(recovery.decodeRecoveryPayload(bytes, r.binding, crypto.fingerprint(nextOwner)).epochs.length, 2);
  invalid(() => recovery.encodeRecoveryPayload({ ...r.payload, previousOwnerKey: nextOwner }, r.binding, crypto.fingerprint(nextOwner)));
  const unrotated = control.sealControl({ ...r.c, activeEpoch: 1 }, owner, nextOwner);
  invalid(() => control.acceptControl(unrotated, control.rosterBytes([control.sealCertificate({ ...ownerCertificate, ownerFingerprint: crypto.fingerprint(nextOwner) }, nextOwner)]), scope, owner, accepted));
  const fields = crypto.unframe(bytes, 12);
  fields[9] = createPublicKey(nextOwner).export({ format: 'der', type: 'spki' });
  invalid(() => recovery.decodeRecoveryPayload(crypto.frame(...fields), r.binding, crypto.fingerprint(nextOwner)));
});

test('recovery rejects malformed DER, unauthorized signatures, noncanonical epoch lists, duplicates and omitted active key', () => {
  const r = rollover();
  const original = recovery.encodeRecoveryPayload(r.payload, r.binding, crypto.fingerprint(nextOwner));
  for (const list of [[], [{ epoch: 1, key: epochKey }], [{ epoch: 2, key: epochKey }, { epoch: 1, key: epochKey }],
    [{ epoch: 2, key: epochKey }, { epoch: 2, key: epochKey }], [{ epoch: 3, key: epochKey }], [{ epoch: 2, key: Buffer.alloc(31) }]]) {
    invalid(() => recovery.encodeRecoveryPayload({ ...r.payload, epochs: list }, r.binding, crypto.fingerprint(nextOwner)));
  }
  for (const index of [7, 8, 9, 10]) {
    const fields = crypto.unframe(original, 12); fields[index] = flip(fields[index], fields[index].length - 1);
    invalid(() => recovery.decodeRecoveryPayload(crypto.frame(...fields), r.binding, crypto.fingerprint(nextOwner)));
  }
  const fields = crypto.unframe(original, 12);
  fields[11] = crypto.frame('ssterm-sync-recovery-epochs-v1', '4097');
  invalid(() => recovery.decodeRecoveryPayload(crypto.frame(...fields), r.binding, crypto.fingerprint(nextOwner)));
  fields[11] = crypto.frame('ssterm-sync-recovery-epochs-v1', '01', crypto.frame('2', epochKey));
  invalid(() => recovery.decodeRecoveryPayload(crypto.frame(...fields), r.binding, crypto.fingerprint(nextOwner)));
  invalid(() => recovery.decodeRecoveryPayload(Buffer.concat([original, Buffer.of(0)]), r.binding, crypto.fingerprint(nextOwner)));
});

test('recovery supports 4096 bounded epoch keys and returns owned epoch/control byte copies', () => {
  // A self-contained signed checkpoint need not begin at genesis for recovery;
  // its freshness and progression are a distinct adoption step.
  const c = { ...genesis, generation: 4096, activeEpoch: 4096 };
  const wire = control.sealControl(c, owner, owner);
  const b = { ...binding, controlHash: control.controlCommitment(wire) };
  const p = { ...payload(), baseControlWire: wire, epochs: Array.from({ length: 4096 }, (_, i) => ({ epoch: i + 1, key: Buffer.alloc(32, i % 256) })) };
  const bytes = recovery.encodeRecoveryPayload(p, b, crypto.fingerprint(owner));
  const result = recovery.decodeRecoveryPayload(bytes, b, crypto.fingerprint(owner));
  assert.equal(result.epochs.length, 4096);
  bytes.fill(0);
  assert.deepEqual(result.epochs[1].key, Buffer.alloc(32, 1));
  assert.deepEqual(result.baseControlWire, wire);
});

test('recovery descriptors bind envelope hash and exact scope with bounded canonical bytes', () => {
  const descriptor = { ...scope, recoveryId: binding.recoveryId, recoveryEnvelopeHash: sha(Buffer.of(1, 2, 3)) };
  const wire = recovery.recoveryDescriptor(descriptor);
  assert.deepEqual(recovery.parseRecoveryDescriptor(wire), descriptor);
  assert.equal(recovery.recoveryDescriptorDigest(wire), sha(wire));
  invalid(() => recovery.recoveryDescriptor({ ...descriptor, recoveryEnvelopeHash: 'A'.repeat(64) }));
  invalid(() => recovery.parseRecoveryDescriptor(Buffer.concat([wire, Buffer.of(0)])));
});

test('authenticated recovery adopts mid-chain checkpoint with full roster validation and trusted owner fingerprint', () => {
  const r = rollover();
  const recovered = control.acceptRecoveryControl(r.wire, r.roster, scope, createPublicKey(owner), crypto.fingerprint(nextOwner));
  assert.equal(recovered.commitment, r.next.commitment);
  assert.equal(recovered.control.generation, 2);
  assert.equal(recovered.certificates.length, 1);
  invalid(() => control.acceptRecoveryControl(r.wire, roster, scope, owner, crypto.fingerprint(nextOwner)));
  invalid(() => control.acceptRecoveryControl(r.wire, r.roster, scope, nextOwner, crypto.fingerprint(nextOwner)));
  invalid(() => control.acceptRecoveryControl(r.wire, r.roster, scope, owner, crypto.fingerprint(owner)));
  invalid(() => control.acceptRecoveryControl(r.wire, r.roster, { ...scope, vaultId: scope.accountId }, owner, crypto.fingerprint(nextOwner)));
});

test('recovery clears temporary PKCS8 and epoch copies on late validation and partial-frame failures', (t) => {
  const r = rollover();
  const encoded = recovery.encodeRecoveryPayload(r.payload, r.binding, crypto.fingerprint(nextOwner));
  const fields = crypto.unframe(encoded, 12);
  fields[11] = crypto.frame('ssterm-sync-recovery-epochs-v1', '1', crypto.frame('1', epochKey));
  const omittedActiveEpoch = crypto.frame(...fields);
  const privateDer = nextOwner.export({ format: 'der', type: 'pkcs8' });
  try {
    for (const bytes of [omittedActiveEpoch, encoded.subarray(0, encoded.length - 1)]) {
      const original = Buffer.from(bytes);
      const copies: Buffer[] = [];
      const bufferFrom = Buffer.from;
      t.mock.method(Buffer, 'from', (...args: unknown[]) => {
        const copy = Reflect.apply(bufferFrom, Buffer, args) as Buffer;
        if (args[0] instanceof Uint8Array && (copy.includes(epochKey) || copy.equals(privateDer))) copies.push(copy);
        return copy;
      });
      try { invalid(() => recovery.decodeRecoveryPayload(bytes, r.binding, crypto.fingerprint(nextOwner))); }
      finally { t.mock.restoreAll(); }
      assert.ok(copies.length > 0, 'observed sensitive owned byte copies');
      assert.ok(copies.every((copy) => copy.every((byte) => byte === 0)), 'all rejected secret copies are cleared');
      assert.deepEqual(bytes, original, 'caller owns the original recovery plaintext');
    }
  } finally { privateDer.fill(0); }
});

test('successful recovery clears temporary secret copies while retaining only caller-owned epoch results', (t) => {
  const r = rollover();
  const encoded = recovery.encodeRecoveryPayload(r.payload, r.binding, crypto.fingerprint(nextOwner));
  const privateDer = nextOwner.export({ format: 'der', type: 'pkcs8' });
  const copies: Buffer[] = [];
  const bufferFrom = Buffer.from;
  t.mock.method(Buffer, 'from', (...args: unknown[]) => {
    const copy = Reflect.apply(bufferFrom, Buffer, args) as Buffer;
    if (args[0] instanceof Uint8Array && (copy.includes(epochKey) || copy.equals(privateDer))) copies.push(copy);
    return copy;
  });
  let result: recovery.RecoveryPayload;
  try { result = recovery.decodeRecoveryPayload(encoded, r.binding, crypto.fingerprint(nextOwner)); }
  finally { t.mock.restoreAll(); privateDer.fill(0); }
  const returnedKeys = new Set(result.epochs.map(({ key }) => key));
  assert.ok(copies.length > 1);
  assert.ok(copies.filter((copy) => !returnedKeys.has(copy)).every((copy) => copy.every((byte) => byte === 0)));
  assert.deepEqual(result.epochs[0].key, epochKey);
  for (const { key } of result.epochs) key.fill(0);
  encoded.fill(0);
});
