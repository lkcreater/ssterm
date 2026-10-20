import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, hkdfSync, privateDecrypt, publicEncrypt, sign, verify,
} from 'node:crypto';
import {
  DATA_MAX, RECOVERY_MAX, SUITE, dataHeader, deriveKey, fingerprint, frame, openOperation, openRecovery,
  operationCommitment, parentsDigest, parseDataHeader, parseRecoveryHeader, parseWrapHeader,
  recoveryHeader, sealOperation, sealRecovery, unframe, unwrapEpoch, wrapEpoch, wrapHeader,
  type DataHeader, type RecoveryHeader, type WrapHeader,
} from '../fixtures/crypto/reference.ts';
import {
  acceptControl, certificateBody, certificateCommitment, controlBody, enrollmentBody, enrollmentHash,
  operationDisposition, proveEnrollment, readCertificate, rosterBytes, rosterCommitment, rosterEntries, sealCertificate,
  sealControl, verifyEnrollment, type Certificate, type Control, type Enrollment,
} from '../fixtures/crypto/control-reference.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/crypto/${name}`, import.meta.url));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fromHex = (hex: string) => Buffer.from(hex, 'hex');
const GOLDEN = JSON.parse(fixture('project-golden.json').toString()) as {
  header: DataHeader; epochKeyHex: string; signingSeedHex: string; plaintextHex: string;
  headerHex: string; derivedKeyHex: string; ciphertextHex: string; signatureHex: string; commitment: string;
};
const privateSigning = (seed: string) => createPrivateKey({ key: fromHex(`302e020100300506032b657004220420${seed}`), type: 'pkcs8', format: 'der' });
const signing = privateSigning(GOLDEN.signingSeedHex);
const publicSigning = createPublicKey(signing);
const wrongSigning = privateSigning('ab'.repeat(32));
const epochKey = fromHex(GOLDEN.epochKeyHex);
const plaintext = fromHex(GOLDEN.plaintextHex);
const h = GOLDEN.header;
const makeOperation = () => sealOperation(h, [], epochKey, plaintext, signing);
const flip = (bytes: Uint8Array, at = 0) => { const b = Buffer.from(bytes); b[at] ^= 1; return b; };
const resignData = (header: Uint8Array, ciphertext: Uint8Array) => frame(header, ciphertext,
  sign(null, frame('ssterm-sync-data-sign-v1', header, ciphertext), signing));
const wrapVectors = JSON.parse(fixture('rsa_oaep_3072_sha256_mgf1sha256_test.json').toString()) as {
  numberOfTests: number; testGroups: Array<{ keySize: number; sha: string; mgf: string; mgfSha: string; privateKeyPem: string;
    tests: Array<{ tcId: number; result: string; msg: string; ct: string; label: string }> }>;
};
const rsaPrivate = createPrivateKey(wrapVectors.testGroups[0].privateKeyPem);
const rsaPublic = createPublicKey(rsaPrivate);
const wrap: WrapHeader = { deploymentId: h.deploymentId, accountId: h.accountId, vaultId: h.vaultId, epoch: h.epoch,
  recipientDeviceId: h.authorDeviceId, recipientFingerprint: fingerprint(rsaPublic), issuerDeviceId: h.operationId,
  issuerFingerprint: fingerprint(signing), controlHash: h.controlHash };
const recovery: RecoveryHeader = { deploymentId: h.deploymentId, accountId: h.accountId, vaultId: h.vaultId,
  recoveryId: h.operationId, controlHash: h.controlHash, salt: h.salt, nonce: h.nonce, plaintextLength: plaintext.length };

test('RFC 5869 Appendix A.1: SHA-256 HKDF known answer (42 bytes)', () => {
  assert.equal(Buffer.from(hkdfSync('sha256', Buffer.alloc(22, 0x0b), fromHex('000102030405060708090a0b0c'),
    fromHex('f0f1f2f3f4f5f6f7f8f9'), 42)).toString('hex'),
  '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});

test('RFC 8032 section 7.1 TEST 1: public Ed25519 key and empty-message signature known answer', () => {
  const expectedPublic = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const expectedSignature = fromHex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f' +
    'b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
  assert.equal(publicSigning.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), expectedPublic);
  assert.deepEqual(sign(null, Buffer.alloc(0), signing), expectedSignature);
  assert.equal(verify(null, Buffer.alloc(0), publicSigning, expectedSignature), true);
  assert.equal(verify(null, Buffer.of(0), publicSigning, expectedSignature), false);
});

test('NIST CAVP CAVS 14.0 AES-256-GCM: independent empty and nonempty AAD/plaintext known answers', async (t) => {
  const nist = JSON.parse(fixture('nist-gcm256.json').toString()) as { vectors: Array<{
    parameters: { Keylen: number; IVlen: number; PTlen: number; AADlen: number; Taglen: number };
    Count: string; Key: string; IV: string; PT: string; AAD: string; CT: string; Tag: string;
  }> };
  assert.equal(nist.vectors.length, 3);
  for (const v of nist.vectors) await t.test(`PT${v.parameters.PTlen}/AAD${v.parameters.AADlen}/Count${v.Count}`, () => {
    assert.equal(v.parameters.Keylen, 256); assert.equal(v.parameters.IVlen, 96); assert.equal(v.parameters.Taglen, 128);
    const cipher = createCipheriv('aes-256-gcm', fromHex(v.Key), fromHex(v.IV), { authTagLength: 16 });
    cipher.setAAD(fromHex(v.AAD));
    assert.deepEqual(Buffer.concat([cipher.update(fromHex(v.PT)), cipher.final()]), fromHex(v.CT));
    assert.deepEqual(cipher.getAuthTag(), fromHex(v.Tag));
    const open = (tag: Uint8Array, aad: Uint8Array) => {
      const decipher = createDecipheriv('aes-256-gcm', fromHex(v.Key), fromHex(v.IV), { authTagLength: 16 });
      decipher.setAAD(aad); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(fromHex(v.CT)), decipher.final()]);
    };
    assert.deepEqual(open(fromHex(v.Tag), fromHex(v.AAD)), fromHex(v.PT));
    assert.throws(() => open(flip(fromHex(v.Tag)), fromHex(v.AAD)));
    assert.throws(() => open(fromHex(v.Tag), Buffer.concat([fromHex(v.AAD), Buffer.of(0)])));
  });
});

test('pinned public Wycheproof RSA-OAEP-3072 SHA256/MGF1-SHA256 corpus rejects every invalid case', async (t) => {
  assert.equal(sha(fixture('rsa_oaep_3072_sha256_mgf1sha256_test.json')), 'c8122302f522bfd539650c71c4aa966bd1f89acb50c6f4c190030fdb9b2684a4');
  assert.equal(sha(fixture('WYCHEPROOF-LICENSE')), '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd');
  let count = 0; let valid = 0; let invalid = 0;
  for (const group of wrapVectors.testGroups) {
    assert.equal(group.keySize, 3072); assert.equal(group.sha, 'SHA-256'); assert.equal(group.mgf, 'MGF1'); assert.equal(group.mgfSha, 'SHA-256');
    const key = createPrivateKey(group.privateKeyPem);
    for (const v of group.tests) await t.test(`tcId ${v.tcId}: ${v.result}`, () => {
      count++;
      const decrypt = () => privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256', oaepLabel: fromHex(v.label) }, fromHex(v.ct));
      if (v.result === 'valid') { valid++; assert.deepEqual(decrypt(), fromHex(v.msg)); }
      else { assert.equal(v.result, 'invalid'); invalid++; assert.throws(decrypt); }
    });
  }
  assert.equal(count, 37); assert.equal(count, wrapVectors.numberOfTests); assert.ok(valid > 0 && invalid > 0);
});

test('project regression vector freezes exact header, derived key, ciphertext, signature and commitment bytes', () => {
  const wire = makeOperation(); const [header, ciphertext, signature] = unframe(wire, 3);
  assert.equal(header.toString('hex'), GOLDEN.headerHex);
  assert.equal(deriveKey(epochKey, h.salt, header, 'ssterm-sync-data-key-v1').toString('hex'), GOLDEN.derivedKeyHex);
  assert.equal(ciphertext.toString('hex'), GOLDEN.ciphertextHex);
  assert.equal(signature.toString('hex'), GOLDEN.signatureHex);
  assert.equal(operationCommitment(wire), GOLDEN.commitment);
  assert.deepEqual(parseDataHeader(header), h);
  assert.deepEqual(openOperation(wire, h, [], epochKey, publicSigning), plaintext);
  assert.equal(h.parentsDigest, 'dd79156e1f11a49f0bbc68ce3b2f793044d80ba3f7498194040df980873d0ad1');
});

test('data verification rejects tampered signatures/ciphertext/tags, a foreign signer and unauthenticated plaintext', () => {
  const wire = makeOperation(); const [header, ciphertext, sig] = unframe(wire, 3);
  const open = (bytes: Uint8Array) => openOperation(bytes, h, [], epochKey, publicSigning);
  assert.throws(() => open(frame(header, ciphertext, flip(sig))));
  assert.throws(() => open(frame(header, flip(ciphertext), sig)));
  assert.throws(() => open(frame(header, flip(ciphertext, ciphertext.length - 1), sig)));
  assert.throws(() => open(frame(header, ciphertext, sig.subarray(1))));
  assert.throws(() => openOperation(wire, h, [], epochKey, createPublicKey(wrongSigning)));
  assert.throws(() => openOperation(wire, h, [], Buffer.alloc(32, 0xff), publicSigning));
  // A legitimate signer cannot change a tag or AAD while retaining old AEAD bytes.
  assert.throws(() => open(resignData(header, flip(ciphertext, ciphertext.length - 1))));
  const changed = { ...h, controlHash: 'bb'.repeat(32) };
  assert.throws(() => openOperation(resignData(dataHeader(changed), ciphertext), changed, [], epochKey, publicSigning));
  // A wrap-domain signature is invalid even over identical data header/ciphertext.
  assert.throws(() => open(frame(header, ciphertext, sign(null, frame('ssterm-sync-wrap-sign-v1', header, ciphertext), signing))));
});

test('every data identity, epoch and checkpoint binding is compared with trusted expected context', () => {
  const wire = makeOperation();
  const substitutions: Partial<DataHeader>[] = [
    { deploymentId: h.accountId }, { accountId: h.vaultId }, { vaultId: h.operationId }, { epoch: 2 },
    { operationId: h.vaultId }, { authorDeviceId: h.operationId }, { controlHash: 'bb'.repeat(32) },
    { parentsDigest: parentsDigest(['cc'.repeat(32)]) }, { salt: 'ff'.repeat(32) }, { nonce: 'ff'.repeat(12) },
  ];
  for (const changed of substitutions) assert.throws(() => openOperation(wire, { ...h, ...changed }, [], epochKey, publicSigning));
  assert.throws(() => openOperation(wire, h, ['cc'.repeat(32)], epochKey, publicSigning));
  const changedSalt = { ...h, salt: 'ff'.repeat(32) };
  const changedScope = { ...h, accountId: h.vaultId };
  const key = deriveKey(epochKey, h.salt, dataHeader(h), 'ssterm-sync-data-key-v1');
  assert.notDeepEqual(key, deriveKey(epochKey, changedSalt.salt, dataHeader(changedSalt), 'ssterm-sync-data-key-v1'));
  assert.notDeepEqual(key, deriveKey(epochKey, h.salt, dataHeader(changedScope), 'ssterm-sync-data-key-v1'));
  assert.notDeepEqual(key, deriveKey(epochKey, h.salt, dataHeader(h), 'ssterm-sync-recovery-key-v1'));
});

test('parent commitments require bounded unique canonical sorted inputs', () => {
  assert.throws(() => parentsDigest(['bb'.repeat(32), 'aa'.repeat(32)]));
  assert.throws(() => parentsDigest(['aa'.repeat(32), 'aa'.repeat(32)]));
  assert.throws(() => parentsDigest(['AA'.repeat(32)]));
  assert.throws(() => parentsDigest(Array.from({ length: 65 }, (_, n) => n.toString(16).padStart(64, '0'))));
  const parents = ['aa'.repeat(32), 'bb'.repeat(32)];
  const header = { ...h, parentsDigest: parentsDigest(parents) };
  const wire = sealOperation(header, parents, epochKey, plaintext, signing);
  assert.deepEqual(openOperation(wire, header, parents, epochKey, publicSigning), plaintext);
  assert.throws(() => openOperation(wire, header, parents.slice(0, 1), epochKey, publicSigning));
});

test('strict framing rejects truncation at every byte, trailing fields and overlarge lengths before crypto', () => {
  const header = dataHeader(h);
  for (let i = 0; i < header.length; i++) assert.throws(() => parseDataHeader(header.subarray(0, i)), `cut ${i}`);
  assert.throws(() => parseDataHeader(Buffer.concat([header, Buffer.alloc(1)])));
  assert.throws(() => parseDataHeader(frame(...unframe(header, 14), 'extra')));
  const claimedHuge = Buffer.alloc(4); claimedHuge.writeUInt32BE(0xffffffff);
  assert.throws(() => parseDataHeader(claimedHuge));
  assert.throws(() => unframe(Buffer.alloc(8193), 1, 8192, 8192));
  assert.throws(() => unframe(Buffer.alloc(0), 259));
  const wire = makeOperation();
  for (const broken of [wire.subarray(0, -1), Buffer.concat([wire, Buffer.of(0)]), claimedHuge, Buffer.alloc(DATA_MAX + 4097)]) {
    assert.throws(() => openOperation(broken, h, [], epochKey, publicSigning));
  }
});

test('data headers reject unsupported algorithms/versions and ambiguous text or numbers', () => {
  const fields = unframe(dataHeader(h), 14);
  const invalid: Array<[number, string | Uint8Array]> = [
    [0, 'ssterm-sync-recovery-v1'], [1, '2'], [1, '01'], [2, 'aes-256-gcm-v1'], [2, SUITE + ' '],
    [3, '11111111-1111-4111-8111-11111111111A'], [4, ''], [5, h.vaultId + ' '], [6, '0'], [6, '01'],
    [6, '-1'], [6, '1e0'], [6, '4294967296'], [7, 'not-a-uuid'], [8, h.authorDeviceId + '\n'],
    [9, 'AA'.repeat(32)], [10, '0'.repeat(63)], [11, 'gg'.repeat(32)], [12, '00'.repeat(13)],
    [13, String(DATA_MAX + 1)], [13, '00'], [13, '9007199254740992'], [13, Buffer.of(0xff)],
  ];
  for (const [index, value] of invalid) {
    const mutated = [...fields]; mutated[index] = Buffer.from(value);
    assert.throws(() => parseDataHeader(frame(...mutated)), `field ${index}: ${String(value)}`);
  }
});

test('data cap and exact length are enforced, including the empty operation', () => {
  for (const size of [0, DATA_MAX]) {
    const header = { ...h, plaintextLength: size }; const bytes = Buffer.alloc(size, 3);
    const wire = sealOperation(header, [], epochKey, bytes, signing);
    assert.deepEqual(openOperation(wire, header, [], epochKey, publicSigning), bytes);
  }
  assert.throws(() => sealOperation({ ...h, plaintextLength: DATA_MAX + 1 }, [], epochKey, Buffer.alloc(DATA_MAX + 1), signing));
  assert.throws(() => sealOperation(h, [], epochKey, Buffer.alloc(1), signing));
  assert.throws(() => sealOperation(h, [], Buffer.alloc(31), plaintext, signing));
  const [header, ciphertext] = unframe(makeOperation(), 3);
  assert.throws(() => openOperation(resignData(header, ciphertext.subarray(1)), h, [], epochKey, publicSigning));
});

test('RSA epoch wraps bind recipient key, issuer signature, OAEP label, scope and active epoch', () => {
  const wire = wrapEpoch(wrap, epochKey, rsaPublic, signing);
  const [header, ciphertext, sig] = unframe(wire, 3);
  assert.deepEqual(parseWrapHeader(header), wrap); assert.equal(ciphertext.length, 384); assert.equal(sig.length, 64);
  assert.deepEqual(unwrapEpoch(wire, wrap, rsaPrivate, publicSigning), epochKey);
  for (const change of [{ epoch: 2 }, { recipientDeviceId: h.operationId }, { issuerDeviceId: h.vaultId },
    { deploymentId: h.vaultId }, { accountId: h.vaultId }, { vaultId: h.operationId }, { controlHash: 'bb'.repeat(32) }]) {
    assert.throws(() => unwrapEpoch(wire, { ...wrap, ...change }, rsaPrivate, publicSigning));
  }
  assert.throws(() => unwrapEpoch(frame(header, flip(ciphertext), sig), wrap, rsaPrivate, publicSigning));
  assert.throws(() => unwrapEpoch(frame(header, ciphertext, flip(sig)), wrap, rsaPrivate, publicSigning));
  assert.throws(() => unwrapEpoch(wire, wrap, rsaPrivate, createPublicKey(wrongSigning)));
  assert.throws(() => wrapEpoch({ ...wrap, recipientFingerprint: '00'.repeat(32) }, epochKey, rsaPublic, signing));
  const wrongRecipient = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey;
  assert.throws(() => unwrapEpoch(wire, wrap, wrongRecipient, publicSigning));
  // Valid issuer can resign a changed context, but old OAEP ciphertext still fails its label.
  const changed = { ...wrap, epoch: 2 }; const changedHeader = wrapHeader(changed);
  const changedWire = frame(changedHeader, ciphertext, sign(null, frame('ssterm-sync-wrap-sign-v1', changedHeader, ciphertext), signing));
  assert.throws(() => unwrapEpoch(changedWire, changed, rsaPrivate, publicSigning));
  const noLabel = publicEncrypt({ key: rsaPublic, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, epochKey);
  const signedNoLabel = frame(header, noLabel, sign(null, frame('ssterm-sync-wrap-sign-v1', header, noLabel), signing));
  assert.throws(() => unwrapEpoch(signedNoLabel, wrap, rsaPrivate, publicSigning));
  const shortKey = publicEncrypt({ key: rsaPublic, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: header }, Buffer.alloc(31));
  assert.throws(() => unwrapEpoch(frame(header, shortKey, sign(null, frame('ssterm-sync-wrap-sign-v1', header, shortKey), signing)), wrap, rsaPrivate, publicSigning));
});

test('wrap/header and key validation reject downgrade, RSA size/exponent confusion and signing/wrapping key reuse', () => {
  const fields = unframe(wrapHeader(wrap), 12);
  for (const [index, value] of [[1, '2'], [2, 'rsa-oaep-sha1'], [6, '0'], [8, 'AA'.repeat(32)], [10, '00'], [11, 'bad']] as const) {
    const changed = [...fields]; changed[index] = Buffer.from(value);
    assert.throws(() => parseWrapHeader(frame(...changed)));
  }
  const rsa2048 = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  const exponent3 = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 3 }).publicKey;
  assert.throws(() => fingerprint(rsa2048)); assert.throws(() => fingerprint(exponent3));
  assert.throws(() => wrapEpoch(wrap, epochKey, publicSigning, signing));
  assert.throws(() => wrapEpoch(wrap, epochKey, rsaPublic, rsaPrivate));
  assert.throws(() => wrapEpoch(wrap, Buffer.alloc(33), rsaPublic, signing));
  assert.throws(() => unwrapEpoch(Buffer.alloc(0), wrap, rsaPrivate, publicSigning));
  assert.throws(() => unwrapEpoch(frame(wrapHeader(wrap), Buffer.alloc(383), Buffer.alloc(64)), wrap, rsaPrivate, publicSigning));
  assert.throws(() => sealOperation(h, [], epochKey, plaintext, rsaPrivate));
  assert.throws(() => sealOperation(h, [], epochKey, plaintext, publicSigning));
});

test('recovery envelope requires its independent high-entropy secret, exact scope, AAD and version', () => {
  const secret = Buffer.alloc(32, 0x77); const wire = sealRecovery(recovery, secret, plaintext);
  const [header, ciphertext] = unframe(wire, 2);
  assert.deepEqual(parseRecoveryHeader(header), recovery);
  assert.deepEqual(openRecovery(wire, recovery, secret), plaintext);
  assert.throws(() => openRecovery(wire, recovery, epochKey));
  assert.throws(() => openRecovery(wire, recovery, Buffer.alloc(31)));
  assert.throws(() => openRecovery(frame(header, flip(ciphertext)), recovery, secret));
  assert.throws(() => openRecovery(frame(header, flip(ciphertext, ciphertext.length - 1)), recovery, secret));
  for (const change of [{ accountId: h.vaultId }, { deploymentId: h.accountId }, { vaultId: h.operationId },
    { recoveryId: h.authorDeviceId }, { controlHash: 'bb'.repeat(32) }, { salt: 'bb'.repeat(32) }, { nonce: 'bb'.repeat(12) }]) {
    assert.throws(() => openRecovery(wire, { ...recovery, ...change }, secret));
  }
  const changed = { ...recovery, controlHash: 'bb'.repeat(32) };
  assert.throws(() => openRecovery(frame(recoveryHeader(changed), ciphertext), changed, secret));
  const fields = unframe(header, 11);
  for (const [index, value] of [[1, '2'], [2, 'unknown'], [6, 'bad'], [7, 'AA'.repeat(32)], [8, '00'], [9, '00'], [10, '01'], [10, String(RECOVERY_MAX + 1)]] as const) {
    const changed = [...fields]; changed[index] = Buffer.from(value); assert.throws(() => parseRecoveryHeader(frame(...changed)));
  }
  assert.throws(() => openRecovery(wire.subarray(0, -1), recovery, secret));
  assert.throws(() => openRecovery(Buffer.concat([wire, Buffer.of(0)]), recovery, secret));
  assert.throws(() => openRecovery(frame(header, ciphertext.subarray(1)), recovery, secret));
  assert.throws(() => sealRecovery(recovery, secret, Buffer.alloc(1)));
  // Recovery and data envelopes cannot substitute for each other, even with the same secret.
  assert.throws(() => openRecovery(makeOperation(), recovery, epochKey));
  assert.throws(() => openOperation(wire, h, [], secret, publicSigning));
});

test('recovery supports bounded empty/maximum bodies and refuses oversized ciphertext before derivation', () => {
  const secret = Buffer.alloc(32, 0x77);
  for (const size of [0, RECOVERY_MAX]) {
    const header = { ...recovery, plaintextLength: size }; const body = Buffer.alloc(size, 0x44);
    assert.deepEqual(openRecovery(sealRecovery(header, secret, body), header, secret), body);
  }
  assert.throws(() => recoveryHeader({ ...recovery, plaintextLength: RECOVERY_MAX + 1 }));
  assert.throws(() => openRecovery(Buffer.alloc(RECOVERY_MAX + 8193), recovery, secret));
});

const CONTROL_GOLDEN = JSON.parse(fixture('control-golden.json').toString()) as Record<string, string>;
const owner = privateSigning(CONTROL_GOLDEN.ownerSeedHex);
const ownerPublic = createPublicKey(owner);
const ownerWrapping = createPublicKey(fixture('public-test-owner-rsa.pem'));
const scope = { deploymentId: h.deploymentId, accountId: h.accountId, vaultId: h.vaultId };
const ownerCert: Certificate = { ...scope, deviceId: h.authorDeviceId, signingKey: publicSigning, wrappingKey: ownerWrapping,
  role: 'owner', enrollmentHash: '0'.repeat(64), ownerFingerprint: fingerprint(owner), firstGeneration: 1 };
const ownerCertWire = sealCertificate(ownerCert, owner);
const genesisRoster = rosterBytes([ownerCertWire]);
const genesis: Control = { ...scope, generation: 1, previousHash: '0'.repeat(64), previousOwnerFingerprint: fingerprint(owner),
  newOwnerKey: ownerPublic, ownerDeviceId: ownerCert.deviceId, activeEpoch: 1, rosterDigest: rosterCommitment(genesisRoster), recoveryDescriptorDigest: '0'.repeat(64) };
const genesisWire = sealControl(genesis, owner, owner);
const pinned = acceptControl(genesisWire, genesisRoster, scope, ownerPublic);
const enrollment: Enrollment = { ...scope, requestId: h.operationId, newDeviceId: h.operationId, signingKey: createPublicKey(wrongSigning), wrappingKey: rsaPublic,
  requestedRole: 'writer', issuerOwnerFingerprint: fingerprint(owner), baseControlHash: pinned.commitment, nonce: 'ab'.repeat(32), expiresAtUnix: 2000000000 };
const enrollmentApproval = () => ({ enrollmentHash: CONTROL_GOLDEN.enrollmentHash, challengeSecret: fromHex(CONTROL_GOLDEN.challengeSecretHex),
  nowUnix: 1999999900, monotonicNow: 100, monotonicDeadline: 200, used: false });

test('project control/certificate/roster/enrollment golden freezes exact transcripts and dual signatures', () => {
  assert.equal(certificateBody(ownerCert).toString('hex'), CONTROL_GOLDEN.certificateBodyHex);
  assert.equal(ownerCertWire.toString('hex'), CONTROL_GOLDEN.certificateWireHex);
  assert.equal(certificateCommitment(ownerCertWire), CONTROL_GOLDEN.certificateCommitment);
  assert.equal(genesisRoster.toString('hex'), CONTROL_GOLDEN.rosterHex);
  assert.equal(rosterCommitment(genesisRoster), CONTROL_GOLDEN.rosterDigest);
  assert.equal(controlBody(genesis).toString('hex'), CONTROL_GOLDEN.controlBodyHex);
  assert.equal(genesisWire.toString('hex'), CONTROL_GOLDEN.controlWireHex);
  assert.equal(pinned.commitment, CONTROL_GOLDEN.controlCommitment);
  const body = enrollmentBody(enrollment); const challenge = fromHex(CONTROL_GOLDEN.challengeHex);
  assert.equal(body.toString('hex'), CONTROL_GOLDEN.enrollmentBodyHex);
  assert.equal(enrollmentHash(body, challenge), CONTROL_GOLDEN.enrollmentHash);
  assert.equal(proveEnrollment(body, challenge, wrongSigning, rsaPrivate).toString('hex'), CONTROL_GOLDEN.proofWireHex);
  assert.equal(verifyEnrollment(fromHex(CONTROL_GOLDEN.proofWireHex), pinned, enrollmentApproval()).requestedRole, 'writer');
});

test('control refuses foreign authority, scope/version substitution, tampered signatures and invalid genesis', () => {
  const [body, authorize, possession] = unframe(genesisWire, 3);
  assert.throws(() => acceptControl(genesisWire, genesisRoster, scope, publicSigning));
  assert.throws(() => acceptControl(genesisWire, genesisRoster, { ...scope, accountId: h.operationId }, ownerPublic));
  assert.throws(() => acceptControl(frame(body, flip(authorize), possession), genesisRoster, scope, ownerPublic));
  assert.throws(() => acceptControl(frame(body, authorize, flip(possession)), genesisRoster, scope, ownerPublic));
  assert.throws(() => acceptControl(frame(body, possession, authorize), genesisRoster, scope, ownerPublic), 'signature domains cannot be swapped');
  assert.throws(() => acceptControl(genesisWire.subarray(0, -1), genesisRoster, scope, ownerPublic));
  assert.throws(() => acceptControl(Buffer.concat([genesisWire, Buffer.of(0)]), genesisRoster, scope, ownerPublic));
  const fields = unframe(body, 14);
  for (const [index, value] of [[1, '2'], [2, 'unknown-suite'], [6, '01'], [7, 'AA'.repeat(32)], [11, '0']] as const) {
    const modified = [...fields]; modified[index] = Buffer.from(value); const b = frame(...modified);
    const wire = frame(b, sign(null, frame('ssterm-sync-control-authorize-v1', b), owner), sign(null, frame('ssterm-sync-control-possession-v1', b), owner));
    assert.throws(() => acceptControl(wire, genesisRoster, scope, ownerPublic));
  }
  for (const changed of [{ generation: 2 }, { previousHash: 'aa'.repeat(32) }, { activeEpoch: 2 }]) {
    assert.throws(() => acceptControl(sealControl({ ...genesis, ...changed }, owner, owner), genesisRoster, scope, ownerPublic));
  }
});

test('certificate and roster reject unauthorized roles, key substitution, duplicates, bad order and missing owner', () => {
  const [body, signature] = unframe(ownerCertWire, 2);
  assert.equal(readCertificate(ownerCertWire, ownerPublic).role, 'owner');
  assert.throws(() => readCertificate(frame(body, flip(signature)), ownerPublic));
  assert.throws(() => readCertificate(ownerCertWire, publicSigning));
  const fields = unframe(body, 13);
  for (const [index, value] of [[1, Buffer.from('2')], [7, publicSigning.export({ format: 'der', type: 'spki' }).subarray(1)],
    [8, rsaPublic.export({ format: 'der', type: 'spki' }).subarray(1)], [9, Buffer.from('admin')], [12, Buffer.from('0')]] as const) {
    const changed = [...fields]; changed[index] = value; const b = frame(...changed);
    assert.throws(() => readCertificate(frame(b, sign(null, frame('ssterm-sync-certificate-sign-v1', b), owner)), ownerPublic));
  }
  const checkRoster = (bytes: Uint8Array) => acceptControl(sealControl({ ...genesis, rosterDigest: rosterCommitment(bytes) }, owner, owner), bytes, scope, ownerPublic);
  assert.throws(() => checkRoster(rosterBytes([ownerCertWire, ownerCertWire])));
  const duplicateKeys = sealCertificate({ ...ownerCert, deviceId: h.operationId, role: 'writer' }, owner);
  assert.throws(() => checkRoster(rosterBytes([duplicateKeys, ownerCertWire])));
  assert.throws(() => checkRoster(rosterBytes([ownerCertWire, duplicateKeys])));
  assert.throws(() => checkRoster(rosterBytes([sealCertificate({ ...ownerCert, role: 'reader' }, owner)])));
  assert.throws(() => checkRoster(rosterBytes([sealCertificate({ ...ownerCert, firstGeneration: 2 }, owner)])));
  assert.throws(() => checkRoster(rosterBytes([sealCertificate({ ...ownerCert, enrollmentHash: 'ee'.repeat(32) }, owner)])));
  const ownerAsDevice = sealCertificate({ ...ownerCert, signingKey: ownerPublic }, owner);
  assert.throws(() => checkRoster(rosterBytes([ownerAsDevice])), 'authority and device signing keys must be distinct');
  assert.throws(() => checkRoster(rosterBytes([sealCertificate({ ...ownerCert, accountId: h.operationId }, owner)])));
  assert.throws(() => checkRoster(Buffer.concat([genesisRoster, Buffer.of(0)])));
  assert.throws(() => rosterBytes(Array.from({ length: 257 }, () => ownerCertWire)));
  const maximumFraming = rosterBytes(Array.from({ length: 256 }, () => ownerCertWire));
  assert.equal(rosterEntries(maximumFraming).length, 256, 'bounded framing accepts all 258 fields');
  assert.throws(() => checkRoster(maximumFraming), 'duplicate certificates are still unauthorized');
  assert.throws(() => rosterEntries(frame('ssterm-sync-roster-v1', '257', ...Array.from({ length: 257 }, () => ownerCertWire))));
  assert.throws(() => checkRoster(frame('ssterm-sync-roster-v1', '0')));
});

test('checkpoint progression rejects replay/forks and requires epoch rotation on access loss or owner rollover', () => {
  const writerCert: Certificate = { ...ownerCert, deviceId: h.operationId, signingKey: createPublicKey(wrongSigning), wrappingKey: rsaPublic,
    role: 'writer', enrollmentHash: 'bb'.repeat(32), firstGeneration: 2 };
  const roster = rosterBytes([sealCertificate(writerCert, owner), ownerCertWire]);
  const next: Control = { ...genesis, generation: 2, previousHash: pinned.commitment, rosterDigest: rosterCommitment(roster) };
  const wire = sealControl(next, owner, owner); const accepted = acceptControl(wire, roster, scope, ownerPublic, pinned);
  assert.equal(accepted.control.generation, 2);
  for (const change of [{ enrollmentHash: '0'.repeat(64) }, { firstGeneration: 1 }]) {
    const invalidRoster = rosterBytes([sealCertificate({ ...writerCert, ...change }, owner), ownerCertWire]);
    assert.throws(() => acceptControl(sealControl({ ...next, rosterDigest: rosterCommitment(invalidRoster) }, owner, owner), invalidRoster, scope, ownerPublic, pinned));
  }
  const rewrittenAdmission = rosterBytes([sealCertificate(writerCert, owner), sealCertificate({ ...ownerCert, enrollmentHash: 'bb'.repeat(32) }, owner)]);
  assert.throws(() => acceptControl(sealControl({ ...next, rosterDigest: rosterCommitment(rewrittenAdmission) }, owner, owner), rewrittenAdmission, scope, ownerPublic, pinned));
  assert.throws(() => acceptControl(genesisWire, genesisRoster, scope, ownerPublic, accepted), 'rollback');
  assert.throws(() => acceptControl(wire, roster, scope, ownerPublic, accepted), 'replayed generation');
  for (const change of [{ generation: 4 }, { previousHash: 'cc'.repeat(32) }, { activeEpoch: 3 }]) {
    assert.throws(() => acceptControl(sealControl({ ...next, ...change }, owner, owner), roster, scope, ownerPublic, pinned));
  }
  const removed = { ...next, generation: 3, previousHash: accepted.commitment, rosterDigest: rosterCommitment(genesisRoster) };
  assert.throws(() => acceptControl(sealControl(removed, owner, owner), genesisRoster, scope, ownerPublic, accepted), 'removal requires rotation');
  const rotated = acceptControl(sealControl({ ...removed, activeEpoch: 2 }, owner, owner), genesisRoster, scope, ownerPublic, accepted);
  assert.equal(rotated.control.activeEpoch, 2);
  const downgradedRoster = rosterBytes([sealCertificate({ ...writerCert, role: 'reader' }, owner), ownerCertWire]);
  const downgraded = { ...removed, rosterDigest: rosterCommitment(downgradedRoster) };
  assert.throws(() => acceptControl(sealControl(downgraded, owner, owner), downgradedRoster, scope, ownerPublic, accepted));
  const newOwner = privateSigning('ef'.repeat(32));
  const newOwnerCert = sealCertificate({ ...ownerCert, ownerFingerprint: fingerprint(newOwner) }, newOwner);
  const newRoster = rosterBytes([newOwnerCert]);
  const rollover = { ...removed, newOwnerKey: createPublicKey(newOwner), rosterDigest: rosterCommitment(newRoster), activeEpoch: 2 };
  const rolloverWire = sealControl(rollover, owner, newOwner);
  assert.equal(fingerprint(acceptControl(rolloverWire, newRoster, scope, ownerPublic, accepted).control.newOwnerKey), fingerprint(newOwner));
  const [rollBody, oldSig] = unframe(rolloverWire, 3);
  assert.throws(() => acceptControl(frame(rollBody, oldSig, sign(null, frame('ssterm-sync-control-possession-v1', rollBody), owner)), newRoster, scope, ownerPublic, accepted));
  assert.throws(() => acceptControl(sealControl({ ...rollover, activeEpoch: 1 }, owner, newOwner), newRoster, scope, ownerPublic, accepted));
  // These are pure decisions on authenticated in-memory fixtures, not a durable replay database.
  assert.equal(operationDisposition({ ...h, controlHash: accepted.commitment, authorDeviceId: writerCert.deviceId }, accepted), 'materialize');
  assert.equal(operationDisposition({ ...h, controlHash: accepted.commitment, authorDeviceId: writerCert.deviceId }, rotated), 'conflict');
  assert.equal(operationDisposition({ ...h, controlHash: rotated.commitment, epoch: 2, authorDeviceId: writerCert.deviceId }, rotated), 'reject');
  const readOnly = acceptControl(sealControl({ ...downgraded, activeEpoch: 2 }, owner, owner), downgradedRoster, scope, ownerPublic, accepted);
  assert.equal(operationDisposition({ ...h, epoch: 2, controlHash: readOnly.commitment, authorDeviceId: writerCert.deviceId }, readOnly), 'reject');
  assert.equal(operationDisposition({ ...h, epoch: 3, controlHash: rotated.commitment }, rotated), 'reject');
  assert.equal(operationDisposition({ ...h, accountId: h.operationId, controlHash: accepted.commitment }, accepted), 'reject');
});

test('enrollment proofs reject replay/expiry, mismatched owner/checkpoint/channel fingerprint and either missing private key', () => {
  const wire = fromHex(CONTROL_GOLDEN.proofWireHex); const [body, challenge, proof, signature] = unframe(wire, 4);
  const approval = enrollmentApproval();
  assert.equal(verifyEnrollment(wire, pinned, approval).newDeviceId, enrollment.newDeviceId);
  for (const changed of [{ used: true }, { nowUnix: 2000000000 }, { nowUnix: 1999999000 }, { monotonicNow: 200 },
    { monotonicDeadline: 401 }, { enrollmentHash: 'aa'.repeat(32) }, { challengeSecret: Buffer.alloc(32) }]) {
    assert.throws(() => verifyEnrollment(wire, pinned, { ...approval, ...changed }));
  }
  for (const broken of [frame(body, flip(challenge), proof, signature), frame(body, challenge, flip(proof), signature),
    frame(body, challenge, proof, flip(signature)), wire.subarray(0, -1), Buffer.concat([wire, Buffer.of(0)])]) {
    assert.throws(() => verifyEnrollment(broken, pinned, approval));
  }
  for (const changed of [{ requestedRole: 'reader' as const }, { baseControlHash: 'aa'.repeat(32) },
    { issuerOwnerFingerprint: fingerprint(wrongSigning) }, { newDeviceId: h.vaultId }, { nonce: 'bb'.repeat(32) }, { accountId: h.operationId }]) {
    assert.throws(() => verifyEnrollment(frame(enrollmentBody({ ...enrollment, ...changed }), challenge, proof, signature), pinned, approval));
  }
  for (const changed of [{ signingKey: ownerPublic }, { signingKey: ownerCert.signingKey }, { wrappingKey: ownerCert.wrappingKey }, { newDeviceId: ownerCert.deviceId }]) {
    const changedBody = enrollmentBody({ ...enrollment, ...changed });
    assert.throws(() => verifyEnrollment(frame(changedBody, challenge, proof, signature), pinned, approval));
  }
  assert.throws(() => proveEnrollment(body, challenge, signing, rsaPrivate));
  assert.throws(() => proveEnrollment(body, challenge, wrongSigning, rsaPublic));
  assert.throws(() => proveEnrollment(enrollmentBody({ ...enrollment, nonce: 'cc'.repeat(32) }), challenge, wrongSigning, rsaPrivate), 'OAEP challenge label binds exact enrollment');
  const fields = unframe(body, 15);
  for (const [index, value] of [[1, '2'], [6, 'bad'], [10, 'admin'], [13, '00'], [14, '02000000000'], [14, '4102444801']] as const) {
    const changed = [...fields]; changed[index] = Buffer.from(value); const mutated = frame(...changed);
    assert.throws(() => verifyEnrollment(frame(mutated, challenge, proof, signature), pinned, approval));
  }
});
