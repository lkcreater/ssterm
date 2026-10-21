/** Team authority and role enforcement. Personal protocol bytes are reused unchanged. */
import {
  createHash,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  frame,
  unframe,
  fingerprint,
  SyncCryptoError,
  SUITE,
  parseDataHeader,
  parseWrapHeader,
  operationCommitment,
  parentsDigest,
  type DataHeader,
} from './sync-crypto.ts';
import {
  acceptControl,
  parseControlBody,
  parseEnrollmentBody,
  enrollmentHash,
  type AcceptedControl,
  type Certificate,
} from './sync-control.ts';
import {
  parseRecoveryDescriptor,
  recoveryDescriptorDigest,
} from './sync-recovery.ts';
import {
  SYNC_ZERO,
  type SyncOperationPublication,
  type SyncControlPublication,
} from '../../domain/src/sync.ts';
import {
  isTeamPolicy,
  isTeamSignedPolicy,
  isTeamPolicyCheckpoint,
  isTeamHost,
  teamMetadataScope,
  teamCredentialScope,
  type TeamPolicy,
  type TeamSignedPolicy,
  type TeamScope,
  type TeamPolicyCheckpoint,
  type TeamHost,
  type TeamRole,
} from '../../domain/src/team.ts';
const hash = (v: Uint8Array): string =>
  createHash('sha256').update(v).digest('hex');
const bytes = (v: string): Buffer => Buffer.from(v, 'base64url');
const sameScope = (
  a: { deploymentId: string; accountId: string; vaultId: string },
  b: { deploymentId: string; accountId: string; vaultId: string },
) =>
  a.deploymentId === b.deploymentId &&
  a.accountId === b.accountId &&
  a.vaultId === b.vaultId;
function check(v: unknown): asserts v {
  if (!v) throw new SyncCryptoError();
}
export interface AcceptedTeamPolicy {
  policy: TeamSignedPolicy;
  commitment: string;
  ownerKey: KeyObject;
}
export interface TeamAdmission {
  requestId: string;
  nonce: string;
  hash: string;
}
export interface AcceptedTeamCheckpoint {
  policy: AcceptedTeamPolicy;
  metadata: AcceptedControl;
  credentials: AcceptedControl;
  admissions: TeamAdmission[];
  checkpoint: TeamPolicyCheckpoint;
}
export const teamMetadataRole = (
  role: TeamRole,
): 'owner' | 'writer' | 'reader' =>
  role === 'Owner' ? 'owner' : role === 'Editor' ? 'writer' : 'reader';
export const teamCredentialRole = (
  role: TeamRole,
): 'owner' | 'reader' | null =>
  role === 'Owner' ? 'owner' : role === 'Viewer' ? null : 'reader';
export function teamOwnerKey(p: TeamPolicy): KeyObject {
  check(isTeamPolicy(p));
  const raw = bytes(p.ownerSpki);
  const k = createPublicKey({ key: raw, format: 'der', type: 'spki' });
  check(
    k.asymmetricKeyType === 'ed25519' &&
      k.export({ format: 'der', type: 'spki' }).equals(raw),
  );
  return k;
}
export function teamPolicyBody(p: TeamPolicy): Buffer {
  check(isTeamPolicy(p));
  teamOwnerKey(p);
  const principals = frame(
    'ssterm-team-principals-v1',
    String(p.principals.length),
    ...p.principals.map((v) =>
      frame(v.principalId, v.role, v.status, v.tokenHash),
    ),
  );
  const devices = frame(
    'ssterm-team-devices-v1',
    String(p.devices.length),
    ...p.devices.map((v) => frame(v.deviceId, v.principalId)),
  );
  return frame(
    'ssterm-team-policy-v1',
    '1',
    SUITE,
    p.scope.deploymentId,
    p.scope.accountId,
    p.scope.teamId,
    p.scope.metadataVaultId,
    p.scope.credentialVaultId,
    String(p.generation),
    p.previousHash,
    p.previousOwnerFingerprint,
    bytes(p.ownerSpki),
    p.ownerPrincipalId,
    p.ownerDeviceId,
    p.metadataControlHash,
    p.credentialControlHash,
    principals,
    devices,
  );
}
export function teamPolicyHash(p: TeamSignedPolicy): string {
  check(isTeamSignedPolicy(p));
  return hash(
    frame(
      'ssterm-team-policy-commit-v1',
      teamPolicyBody(p.body),
      bytes(p.oldOwnerSignature),
      bytes(p.newOwnerSignature),
    ),
  );
}
export function sealTeamPolicy(
  body: TeamPolicy,
  oldOwner: KeyObject,
  newOwner: KeyObject,
): TeamSignedPolicy {
  check(
    fingerprint(oldOwner) === body.previousOwnerFingerprint &&
      fingerprint(newOwner) === fingerprint(teamOwnerKey(body)),
  );
  const wire = teamPolicyBody(body);
  return {
    body,
    oldOwnerSignature: sign(
      null,
      frame('ssterm-team-policy-authorize-v1', wire),
      oldOwner,
    ).toString('base64url'),
    newOwnerSignature: sign(
      null,
      frame('ssterm-team-policy-possession-v1', wire),
      newOwner,
    ).toString('base64url'),
  };
}
export function acceptTeamPolicy(
  p: TeamSignedPolicy,
  scope: TeamScope,
  pinnedOwner: KeyObject,
  current?: AcceptedTeamPolicy,
): AcceptedTeamPolicy {
  check(
    isTeamSignedPolicy(p) &&
      JSON.stringify(p.body.scope) === JSON.stringify(scope),
  );
  const body = teamPolicyBody(p.body),
    ownerKey = teamOwnerKey(p.body),
    old = current?.ownerKey ?? pinnedOwner;
  check(p.body.previousOwnerFingerprint === fingerprint(old));
  check(
    verify(
      null,
      frame('ssterm-team-policy-authorize-v1', body),
      old,
      bytes(p.oldOwnerSignature),
    ) &&
      verify(
        null,
        frame('ssterm-team-policy-possession-v1', body),
        ownerKey,
        bytes(p.newOwnerSignature),
      ),
  );
  if (!current)
    check(
      p.body.generation === 1 &&
        p.body.previousHash === SYNC_ZERO &&
        fingerprint(ownerKey) === fingerprint(pinnedOwner) &&
        p.body.principals.length === 1 &&
        p.body.devices.length === 1,
    );
  else {
    const before = current.policy.body;
    check(
      p.body.generation === before.generation + 1 &&
        p.body.previousHash === current.commitment &&
        p.body.ownerPrincipalId === before.ownerPrincipalId,
    );
    for (const principal of before.principals) {
      const n = p.body.principals.find(
        (p) => p.principalId === principal.principalId,
      );
      check(
        n &&
          (principal.status !== 'revoked' ||
            (n.status === 'revoked' &&
              n.role === principal.role &&
              n.tokenHash === principal.tokenHash)),
      );
      if (principal.principalId === before.ownerPrincipalId)
        check(n.status === 'active' && n.role === 'Owner');
      if (n.role !== principal.role)
        check(
          !p.body.devices.some((d) => d.principalId === principal.principalId),
        );
    }
    for (const d of p.body.devices) {
      const prior = before.devices.find((x) => x.deviceId === d.deviceId);
      check(!prior || prior.principalId === d.principalId);
    }
  }
  return { policy: p, ownerKey, commitment: teamPolicyHash(p) };
}
export function teamTargetDigest(teamId: string, host: TeamHost): string {
  check(isTeamHost(host) && /^[0-9a-f-]{36}$/.test(teamId));
  return hash(
    frame(
      'ssterm-team-target-v1',
      teamId,
      host.recordId,
      host.address,
      String(host.port),
      host.username,
    ),
  );
}
export function teamEnrollmentHash(
  teamId: string,
  principalId: string,
  humanRole: TeamRole,
  basePolicyHash: string,
  existingEnrollmentFingerprint: string,
): string {
  return hash(
    frame(
      'ssterm-team-enrollment-v1',
      teamId,
      principalId,
      humanRole,
      basePolicyHash,
      existingEnrollmentFingerprint,
    ),
  );
}
function sameKeys(a: Certificate, b: Certificate): boolean {
  return (
    a.deviceId === b.deviceId &&
    fingerprint(a.signingKey) === fingerprint(b.signingKey) &&
    fingerprint(a.wrappingKey) === fingerprint(b.wrappingKey)
  );
}
/** Authenticates public checkpoint continuity, exact role-derived rosters and admissions.
 * Server additionally consumes returned admission identifiers durably exactly once. */
export function acceptTeamCheckpoint(
  p: TeamPolicyCheckpoint,
  scope: TeamScope,
  pin: KeyObject,
  current?: AcceptedTeamCheckpoint,
): AcceptedTeamCheckpoint {
  check(isTeamPolicyCheckpoint(p));
  const policy = acceptTeamPolicy(p.policy, scope, pin, current?.policy),
    b = p.policy.body;
  const metadata = acceptControl(
    bytes(p.metadataControl.controlWire),
    bytes(p.metadataControl.rosterWire),
    teamMetadataScope(scope),
    pin,
    current?.metadata,
  );
  const credentials = acceptControl(
    bytes(p.credentialControl.controlWire),
    bytes(p.credentialControl.rosterWire),
    teamCredentialScope(scope),
    pin,
    current?.credentials,
  );
  check(
    metadata.commitment === b.metadataControlHash &&
      credentials.commitment === b.credentialControlHash,
  );
  for (const c of [metadata, credentials])
    check(
      c.control.generation === b.generation &&
        c.control.ownerDeviceId === b.ownerDeviceId &&
        fingerprint(c.control.newOwnerKey) === fingerprint(policy.ownerKey),
    );
  const expectedMeta = b.devices,
    expectedCred = b.devices.filter(
      (d) =>
        b.principals.find((p) => p.principalId === d.principalId)!.role !==
        'Viewer',
    );
  check(
    metadata.certificates.length === expectedMeta.length &&
      credentials.certificates.length === expectedCred.length,
  );
  for (const [accepted, expected, credential] of [
    [metadata, expectedMeta, false],
    [credentials, expectedCred, true],
  ] as const) {
    for (const d of expected) {
      const principal = b.principals.find(
        (p) => p.principalId === d.principalId,
      )!;
      const cert = accepted.certificates.find((c) => c.deviceId === d.deviceId);
      check(
        cert &&
          cert.role ===
            (credential
              ? teamCredentialRole(principal.role)
              : teamMetadataRole(principal.role)),
      );
    }
  }
  for (const c of credentials.certificates) {
    const m = metadata.certificates.find((x) => x.deviceId === c.deviceId);
    check(m && sameKeys(c, m));
    const priorMetadata = current?.metadata.certificates.find((x) => sameKeys(x, c));
    const priorCredentials = current?.credentials.certificates.find((x) => sameKeys(x, c));
    const retainedRecoveryOwner = c.role === 'owner' && priorMetadata && priorCredentials &&
      priorMetadata.enrollmentHash === m.enrollmentHash && priorCredentials.enrollmentHash === c.enrollmentHash;
    const freshRecoveryOwner = c.role === 'owner' && current && !priorMetadata && !priorCredentials &&
      b.ownerDeviceId !== current.policy.policy.body.ownerDeviceId && fingerprint(policy.ownerKey) !== fingerprint(current.policy.ownerKey);
    check((m.enrollmentHash === c.enrollmentHash && m.firstGeneration === c.firstGeneration) ||
      ((retainedRecoveryOwner || freshRecoveryOwner) && m.firstGeneration === c.firstGeneration));
  }
  // Ordinary dual-domain admission repeats the identical metadata-scope proof.
  // A different challenge would create another candidate despite sharing public keys.
  for (const proof of p.credentialControl.enrollmentProofs) check(p.metadataControl.enrollmentProofs.includes(proof));
  if (current) {
    const old = current.policy.policy.body;
    const changes = old.principals.some((p) => {
      const n = b.principals.find((x) => x.principalId === p.principalId)!;
      return p.role !== n.role || p.status !== n.status;
    });
    const ownerChanged =
      fingerprint(policy.ownerKey) !== fingerprint(current.policy.ownerKey) ||
      b.ownerDeviceId !== old.ownerDeviceId;
    if (changes || ownerChanged)
      check(
        metadata.control.activeEpoch ===
          current.metadata.control.activeEpoch + 1 &&
          credentials.control.activeEpoch ===
            current.credentials.control.activeEpoch + 1,
      );
    for (const accepted of [metadata, credentials])
      for (const c of accepted.certificates) {
        const historical = [
          ...current.metadata.certificates,
          ...current.credentials.certificates,
        ].find((x) => x.deviceId === c.deviceId);
        check(!historical || sameKeys(historical, c));
      }
  }
  const admissions: TeamAdmission[] = [];
  for (const [accepted, pub, prev] of [
    [metadata, p.metadataControl, current?.metadata],
    [credentials, p.credentialControl, current?.credentials],
  ] as const) {
    if (accepted.control.recoveryDescriptorDigest === SYNC_ZERO)
      check(pub.recoveryDescriptorWire === null && pub.recoveryWire === null);
    else {
      check(
        pub.recoveryDescriptorWire !== null &&
          recoveryDescriptorDigest(bytes(pub.recoveryDescriptorWire)) ===
            accepted.control.recoveryDescriptorDigest,
      );
      const desc = parseRecoveryDescriptor(bytes(pub.recoveryDescriptorWire));
      check(sameScope(desc, accepted.control));
    }
    const fresh = accepted.certificates.filter(
      (c) =>
        b.generation !== 1 && !prev?.certificates.some((x) => sameKeys(x, c)),
    );
    // Fresh owner recovery is bound to a descriptor that was already current.
    const recovery =
      fresh.length === 1 &&
      fresh[0].role === 'owner' &&
      current &&
      b.ownerDeviceId !== current.policy.policy.body.ownerDeviceId &&
      fingerprint(policy.ownerKey) !== fingerprint(current.policy.ownerKey) &&
      accepted.control.activeEpoch === prev!.control.activeEpoch + 1 &&
      pub.enrollmentProofs.length === 0;
    if (recovery) {
      const priorPub =
        accepted === metadata
          ? current!.checkpoint.metadataControl
          : current!.checkpoint.credentialControl;
      check(priorPub.recoveryDescriptorWire !== null);
      check(
        fresh[0].enrollmentHash ===
          parseRecoveryDescriptor(bytes(priorPub.recoveryDescriptorWire))
            .recoveryEnvelopeHash,
      );
      const priorControl =
        accepted === metadata ? current!.metadata : current!.credentials;
      check(
        !accepted.certificates.some(
          (c) => c.deviceId === priorControl.control.ownerDeviceId,
        ),
      );
    } else check(pub.enrollmentProofs.length === fresh.length);
    const used = new Set<string>();
    for (const proof of pub.enrollmentProofs) {
      check(current);
      const [eb, ch, ph, sig] = unframe(bytes(proof), 4, 1536, 4096),
        e = parseEnrollmentBody(eb),
        low = enrollmentHash(eb, ch);
      const d = b.devices.find((d) => d.deviceId === e.newDeviceId);
      check(d);
      const principal = b.principals.find(
        (p) => p.principalId === d.principalId,
      )!;
      const expected = teamEnrollmentHash(
        scope.teamId,
        d.principalId,
        principal.role,
        current.policy.commitment,
        low,
      );
      const cert = fresh.find(
        (c) => c.deviceId === e.newDeviceId && c.enrollmentHash === expected,
      );
      check(cert && !used.has(cert.deviceId));
      used.add(cert.deviceId);
      check(
        sameScope(e, current.metadata.control) &&
          e.baseControlHash === current.metadata.commitment &&
          e.issuerOwnerFingerprint === fingerprint(current.policy.ownerKey) &&
          e.requestedRole === teamMetadataRole(principal.role) &&
          sameKeys(cert, {
            ...cert,
            signingKey: e.signingKey,
            wrappingKey: e.wrappingKey,
          }),
      );
      check(
        ch.length === 384 &&
          /^[0-9a-f]{64}$/.test(ph.toString('ascii')) &&
          sig.length === 64 &&
          verify(
            null,
            frame('ssterm-sync-enroll-sign-proof-v1', eb, ch, ph),
            e.signingKey,
            sig,
          ),
      );
      if (!admissions.some((a) => a.hash === low))
        admissions.push({ requestId: e.requestId, nonce: e.nonce, hash: low });
    }
  }
  check(
    admissions.every(
      (a, i) =>
        admissions.findIndex(
          (b) => b.requestId === a.requestId || b.nonce === a.nonce,
        ) === i,
    ),
  );
  return { policy, metadata, credentials, admissions, checkpoint: p };
}
export function verifyTeamOperation(
  p: SyncOperationPublication,
  current: AcceptedControl,
): { hash: string; header: DataHeader } {
  const wire = bytes(p.wire),
    [raw, cipher, sig] = unframe(wire, 3, 1048576 + 16, 1048576 + 2048),
    h = parseDataHeader(raw);
  const cert = current.certificates.find(
    (c) => c.deviceId === h.authorDeviceId,
  );
  check(
    cert &&
      cert.role !== 'reader' &&
      sameScope(h, current.control) &&
      h.controlHash === current.commitment &&
      h.epoch === current.control.activeEpoch &&
      h.parentsDigest === parentsDigest(p.parents) &&
      cipher.length === h.plaintextLength + 16 &&
      sig.length === 64 &&
      verify(
        null,
        frame('ssterm-sync-data-sign-v1', raw, cipher),
        cert.signingKey,
        sig,
      ),
  );
  return { hash: operationCommitment(wire), header: h };
}
export function verifyTeamWraps(
  p: SyncControlPublication,
  current: AcceptedControl,
): void {
  const owner = current.certificates.find((c) => c.role === 'owner')!;
  const seen = new Set<string>();
  for (const w of p.wraps) {
    const [raw, cipher, sig] = unframe(bytes(w), 3, 1024, 2048),
      h = parseWrapHeader(raw),
      recipient = current.certificates.find(
        (c) => c.deviceId === h.recipientDeviceId,
      );
    check(
      recipient &&
        sameScope(h, current.control) &&
        h.controlHash === current.commitment &&
        h.epoch === current.control.activeEpoch &&
        h.issuerDeviceId === owner.deviceId &&
        h.issuerFingerprint === fingerprint(owner.signingKey) &&
        h.recipientFingerprint === fingerprint(recipient.wrappingKey) &&
        cipher.length === 384 &&
        sig.length === 64 &&
        verify(
          null,
          frame('ssterm-sync-wrap-sign-v1', raw, cipher),
          owner.signingKey,
          sig,
        ) &&
        !seen.has(recipient.deviceId),
    );
    seen.add(recipient.deviceId);
  }
  check(current.certificates.every((c) => seen.has(c.deviceId)));
}
