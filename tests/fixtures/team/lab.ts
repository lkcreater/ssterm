/** Owned cryptographic fixture, using production primitives; never imported by application code. */
import {
  randomUUID,
  randomBytes,
  createHash,
  createPublicKey,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  generateSigningKey,
  generateDeviceKeys,
  generateEpochKey,
  freshEntropy,
  sealOperation,
  wrapEpoch,
  parentsDigest,
  fingerprint,
} from '../../../packages/adapters/src/sync-crypto.ts';
import {
  sealCertificate,
  sealControl,
  rosterBytes,
  rosterCommitment,
  controlCommitment,
  enrollmentBody,
  challengeEnrollment,
  proveEnrollment,
  enrollmentHash,
  type Certificate,
  type Scope,
} from '../../../packages/adapters/src/sync-control.ts';
import {
  sealTeamPolicy,
  teamPolicyHash,
  teamEnrollmentHash,
  teamMetadataRole,
  teamCredentialRole,
  acceptTeamCheckpoint,
  type AcceptedTeamCheckpoint,
} from '../../../packages/adapters/src/team-policy.ts';
import {
  createTeamTransport,
  type TeamTransport,
} from '../../../packages/adapters/src/team-transport.ts';
import {
  SYNC_ZERO,
  type SyncControlPublication,
  type SyncOperationPublication,
} from '../../../packages/domain/src/sync.ts';
import {
  teamMetadataScope,
  teamCredentialScope,
  type TeamRole,
  type TeamScope,
  type TeamPrincipal,
  type TeamAtomicPublication,
  type TeamPublishRequest,
  type TeamSignedPolicy,
  type TeamRecoveryKit,
} from '../../../packages/domain/src/team.ts';
export interface LabDevice {
  deviceId: string;
  principalId: string;
  signingKey: KeyObject;
  wrappingKey: KeyObject;
}
export interface LabMember {
  principal: TeamPrincipal;
  token: Buffer;
  devices: LabDevice[];
}
export const hash = (b: Uint8Array | string) =>
  createHash('sha256').update(b).digest('hex');
export async function member(
  role: TeamRole,
  deviceCount = 1,
): Promise<LabMember> {
  const token = randomBytes(32),
    principalId = randomUUID(),
    devices: LabDevice[] = [];
  for (let i = 0; i < deviceCount; i++)
    devices.push({
      deviceId: randomUUID(),
      principalId,
      ...(await generateDeviceKeys()),
    });
  return {
    principal: { principalId, role, status: 'active', tokenHash: hash(token) },
    token,
    devices,
  };
}
export async function createTeamLab() {
  const scope: TeamScope = {
    deploymentId: randomUUID(),
    accountId: randomUUID(),
    teamId: randomUUID(),
    metadataVaultId: randomUUID(),
    credentialVaultId: randomUUID(),
  };
  const owner = await member('Owner');
  let authority = generateSigningKey(),
    current: AcceptedTeamCheckpoint | undefined,
    currentPub: TeamAtomicPublication | undefined;
  let metaEpoch = generateEpochKey(),
    credEpoch = generateEpochKey();
  let metaHead: string | null = null,
    credHead: string | null = null;
  function operation(
    domain: 'metadata' | 'credentials',
    author: LabDevice,
    payload: unknown,
    parents?: string[],
    control?: AcceptedTeamCheckpoint,
  ): SyncOperationPublication {
    const active = control ?? current!;
    const accepted =
        domain === 'metadata' ? active.metadata : active.credentials,
      ps =
        parents ??
        [(domain === 'metadata' ? metaHead : credHead)!].filter(Boolean),
      plain = Buffer.from(JSON.stringify(payload));
    const h = {
      ...accepted.control,
      epoch: accepted.control.activeEpoch,
      operationId: randomUUID(),
      authorDeviceId: author.deviceId,
      controlHash: accepted.commitment,
      parentsDigest: parentsDigest(ps),
      ...freshEntropy(),
      plaintextLength: plain.length,
    };
    return {
      wire: sealOperation(
        h,
        ps,
        domain === 'metadata' ? metaEpoch : credEpoch,
        plain,
        author.signingKey,
      ).toString('base64url'),
      parents: ps,
    };
  }
  function prepare(
    members: LabMember[] = [owner],
    opts: {
      rotate?: boolean;
      recovery?: TeamRecoveryKit | null;
      metadataDescriptor?: string | null;
      credentialDescriptor?: string | null;
      newAuthority?: KeyObject;
      ownerDevice?: LabDevice;
      recoveryHashes?: { metadata: string; credentials: string };
    } = {},
  ): {
    request: TeamPublishRequest;
    accepted: AcceptedTeamCheckpoint;
    authority: KeyObject;
  } {
    const generation = (current?.policy.policy.body.generation ?? 0) + 1,
      ownerDevice = opts.ownerDevice ?? owner.devices[0],
      nextAuthority = opts.newAuthority ?? authority;
    if (opts.rotate) {
      metaEpoch = generateEpochKey();
      credEpoch = generateEpochKey();
    }
    const proofs = new Map<string, string>(),
      proofHashes = new Map<string, string>();
    if (current)
      for (const m of members)
        if (m.principal.status === 'active')
          for (const d of m.devices) {
            if (
              current.metadata.certificates.some(
                (c) => c.deviceId === d.deviceId,
              )
            )
              continue;
            if (opts.recoveryHashes && d.deviceId === ownerDevice.deviceId)
              continue;
            const enrollment = {
              ...teamMetadataScope(scope),
              requestId: randomUUID(),
              newDeviceId: d.deviceId,
              signingKey: d.signingKey,
              wrappingKey: d.wrappingKey,
              requestedRole: teamMetadataRole(m.principal.role),
              issuerOwnerFingerprint: fingerprint(authority),
              baseControlHash: current.metadata.commitment,
              nonce: randomBytes(32).toString('hex'),
              expiresAtUnix: Math.floor(Date.now() / 1000) + 290,
            };
            const body = enrollmentBody(enrollment),
              secret = randomBytes(32),
              challenge = challengeEnrollment(enrollment, secret);
            const proof = proveEnrollment(
              body,
              challenge,
              d.signingKey,
              d.wrappingKey,
            );
            secret.fill(0);
            proofs.set(d.deviceId, proof.toString('base64url'));
            proofHashes.set(
              d.deviceId,
              teamEnrollmentHash(
                scope.teamId,
                m.principal.principalId,
                m.principal.role,
                current.policy.commitment,
                enrollmentHash(body, challenge),
              ),
            );
          }

    function domain(which: 'metadata' | 'credentials'): SyncControlPublication {
      const previous =
          which === 'metadata' ? current?.metadata : current?.credentials,
        ds =
          which === 'metadata'
            ? teamMetadataScope(scope)
            : teamCredentialScope(scope),
        certs: { deviceId: string; wire: Uint8Array }[] = [],
        enrollmentProofs: string[] = [];
      for (const m of members)
        if (m.principal.status === 'active')
          for (const d of m.devices) {
            const role =
              which === 'metadata'
                ? teamMetadataRole(m.principal.role)
                : teamCredentialRole(m.principal.role);
            if (role === null) continue;
            const old = previous?.certificates.find(
              (c) => c.deviceId === d.deviceId,
            );
            let admission =
              old?.enrollmentHash ??
              (generation === 1 ? SYNC_ZERO : proofHashes.get(d.deviceId)!);
            if (opts.recoveryHashes && d.deviceId === ownerDevice.deviceId)
              admission = opts.recoveryHashes[which];
            const cert: Certificate = {
              ...ds,
              deviceId: d.deviceId,
              signingKey: d.signingKey,
              wrappingKey: d.wrappingKey,
              role,
              enrollmentHash: admission,
              ownerFingerprint: fingerprint(nextAuthority),
              firstGeneration: old?.firstGeneration ?? generation,
            };
            certs.push({
              deviceId: d.deviceId,
              wire: sealCertificate(cert, nextAuthority),
            });
            if (!old && generation > 1 && proofs.has(d.deviceId))
              enrollmentProofs.push(proofs.get(d.deviceId)!);
          }
      const entries = certs.sort((a, b) =>
        a.deviceId.localeCompare(b.deviceId),
      );
      const roster = rosterBytes(entries.map((e) => e.wire)),
        descriptor =
          which === 'metadata'
            ? Object.hasOwn(opts, 'metadataDescriptor')
              ? (opts.metadataDescriptor ?? null)
              : (currentPub?.metadata.control.recoveryDescriptorWire ?? null)
            : Object.hasOwn(opts, 'credentialDescriptor')
              ? (opts.credentialDescriptor ?? null)
              : (currentPub?.credentials.control.recoveryDescriptorWire ??
                null);
      const c = {
        ...ds,
        generation,
        previousHash: previous?.commitment ?? SYNC_ZERO,
        previousOwnerFingerprint: fingerprint(authority),
        newOwnerKey: createPublicKey(nextAuthority),
        ownerDeviceId: ownerDevice.deviceId,
        activeEpoch:
          (previous?.control.activeEpoch ?? 1) + (opts.rotate ? 1 : 0),
        rosterDigest: rosterCommitment(roster),
        recoveryDescriptorDigest: descriptor
          ? hash(Buffer.from(descriptor, 'base64url'))
          : SYNC_ZERO,
      };
      const controlWire = sealControl(c, authority, nextAuthority),
        commitment = controlCommitment(controlWire),
        wraps: string[] = [];
      for (const m of members)
        if (m.principal.status === 'active')
          for (const d of m.devices) {
            if (which === 'credentials' && m.principal.role === 'Viewer')
              continue;
            wraps.push(
              wrapEpoch(
                {
                  ...ds,
                  epoch: c.activeEpoch,
                  controlHash: commitment,
                  recipientDeviceId: d.deviceId,
                  recipientFingerprint: fingerprint(d.wrappingKey),
                  issuerDeviceId: ownerDevice.deviceId,
                  issuerFingerprint: fingerprint(ownerDevice.signingKey),
                },
                which === 'metadata' ? metaEpoch : credEpoch,
                d.wrappingKey,
                ownerDevice.signingKey,
              ).toString('base64url'),
            );
          }
      return {
        controlWire: controlWire.toString('base64url'),
        rosterWire: roster.toString('base64url'),
        wraps,
        recoveryDescriptorWire: descriptor,
        recoveryWire: null,
        enrollmentProofs,
      };
    }
    const metadata = domain('metadata'),
      credentials = domain('credentials');
    const policy: TeamSignedPolicy = sealTeamPolicy(
      {
        format: 'ssterm-team-policy-v1',
        scope,
        generation,
        previousHash: current?.policy.commitment ?? SYNC_ZERO,
        previousOwnerFingerprint: fingerprint(authority),
        ownerSpki: createPublicKey(nextAuthority)
          .export({ format: 'der', type: 'spki' })
          .toString('base64url'),
        ownerPrincipalId: owner.principal.principalId,
        ownerDeviceId: ownerDevice.deviceId,
        metadataControlHash: controlCommitment(
          Buffer.from(metadata.controlWire, 'base64url'),
        ),
        credentialControlHash: controlCommitment(
          Buffer.from(credentials.controlWire, 'base64url'),
        ),
        principals: members
          .map((m) => m.principal)
          .sort((a, b) => a.principalId.localeCompare(b.principalId)),
        devices: members
          .filter((m) => m.principal.status === 'active')
          .flatMap((m) =>
            m.devices.map((d) => ({
              deviceId: d.deviceId,
              principalId: m.principal.principalId,
            })),
          )
          .sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
      },
      authority,
      nextAuthority,
    );
    const accepted = acceptTeamCheckpoint(
      { policy, metadataControl: metadata, credentialControl: credentials },
      scope,
      current?.policy.ownerKey ?? createPublicKey(authority),
      current,
    );
    const metadataSnapshot = operation(
        'metadata',
        ownerDevice,
        { format: 'ssterm-team-metadata-v1', hosts: [], memberNames: [] },
        metaHead ? [metaHead] : [],
        accepted,
      ),
      credentialSnapshot = operation(
        'credentials',
        ownerDevice,
        { format: 'ssterm-team-credentials-v1', credentials: [] },
        credHead ? [credHead] : [],
        accepted,
      );
    return {
      request: {
        expectedPolicyHash: current?.policy.commitment ?? null,
        expectedMetadataHash: metaHead,
        expectedCredentialHash: credHead,
        publication: {
          policy,
          metadata: { control: metadata, snapshot: metadataSnapshot },
          credentials: { control: credentials, snapshot: credentialSnapshot },
          recovery: opts.recovery ?? null,
        },
      },
      accepted,
      authority: nextAuthority,
    };
  }
  return {
    scope,
    owner,
    get authority() {
      return authority;
    },
    get current() {
      return current!;
    },
    get currentPub() {
      return currentPub!;
    },
    get metadataHead() {
      return metaHead!;
    },
    get credentialHead() {
      return credHead!;
    },
    prepare,
    operation,
    commit(prepared: ReturnType<typeof prepare>) {
      current = prepared.accepted;
      currentPub = prepared.request.publication;
      metaHead = hashOperation(currentPub.metadata.snapshot);
      credHead = hashOperation(currentPub.credentials.snapshot);
      authority = prepared.authority;
    },
    setHead(domain: 'metadata' | 'credentials', head: string) {
      if (domain === 'metadata') metaHead = head;
      else credHead = head;
    },
    transport(url: string, m: LabMember, device = m.devices[0]): TeamTransport {
      return createTeamTransport({
        endpoint: { url, scope },
        principalId: m.principal.principalId,
        deviceId: device.deviceId,
        readToken: async () => Buffer.from(m.token),
        signRequest: async (b) => ({
          deviceId: device.deviceId,
          signature: sign(null, b, device.signingKey),
        }),
      });
    },
  };
}
import { operationCommitment } from '../../../packages/adapters/src/sync-crypto.ts';
export const hashOperation = (p: SyncOperationPublication) =>
  operationCommitment(Buffer.from(p.wire, 'base64url'));
