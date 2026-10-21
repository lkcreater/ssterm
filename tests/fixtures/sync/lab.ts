/** Owned real loopback/SQLite fixture, no production resources or crypto reference imports. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createPublicKey, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import {
  SyncServer,
  type SyncServerConfig,
  type SyncServerOptions,
} from '../../../apps/sync-server/src/server.ts';
import { createSyncTransport } from '../../../packages/adapters/src/sync-transport.ts';
import {
  generateSigningKey,
  generateDeviceKeys,
  generateEpochKey,
  fingerprint,
  wrapEpoch,
  freshEntropy,
  sealOperation,
  parentsDigest,
} from '../../../packages/adapters/src/sync-crypto.ts';
import {
  sealCertificate,
  sealControl,
  rosterBytes,
  rosterCommitment,
  acceptControl,
  type Certificate,
  type AcceptedControl,
} from '../../../packages/adapters/src/sync-control.ts';
import type {
  SyncControlPublication,
  SyncOperationPublication,
  SyncScope,
} from '../../../packages/domain/src/sync.ts';
export async function createSyncLab(options: SyncServerOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ssterm-sync-'));
  const token = randomBytes(32);
  const scope: SyncScope = { deploymentId: randomUUID(), accountId: randomUUID(), vaultId: randomUUID() };
  const config: SyncServerConfig = {
    ...scope,
    databasePath: join(directory, 'server.sqlite'),
    tokenHash: createHash('sha256').update(token).digest('hex'),
  };
  let server = new SyncServer(config, options);
  let url = await server.listen();
  const ownerKey = generateSigningKey();
  const keys = await generateDeviceKeys();
  const deviceId = randomUUID();
  const epochKey = generateEpochKey();
  const certificate: Certificate = {
    ...scope,
    deviceId,
    ...keys,
    role: 'owner',
    enrollmentHash: '0'.repeat(64),
    ownerFingerprint: fingerprint(ownerKey),
    firstGeneration: 1,
  };
  const initial = makePublication(scope, ownerKey, keys.signingKey, epochKey, [certificate]);
  const transport = () =>
    createSyncTransport({
      endpoint: { url, scope },
      readToken: async () => Buffer.from(token),
      signRequest: async (bytes) => ({ deviceId, signature: sign(null, bytes, keys.signingKey) }),
    });
  return {
    directory,
    token,
    scope,
    config,
    ownerKey,
    keys,
    deviceId,
    epochKey,
    certificate,
    initial,
    transport,
    get server() {
      return server;
    },
    get url() {
      return url;
    },
    async restart() {
      await server.close();
      server = new SyncServer(config, options);
      url = await server.listen();
    },
    async close() {
      await server.close();
      token.fill(0);
      epochKey.fill(0);
      await rm(directory, { recursive: true, force: true });
    },
    headers() {
      return {
        Authorization: `Bearer ${token.toString('base64url')}`,
        'X-SSTerm-Deployment': scope.deploymentId,
        'X-SSTerm-Account': scope.accountId,
        'X-SSTerm-Vault': scope.vaultId,
      };
    },
    operation(
      parents: string[] = [],
      accepted: AcceptedControl = initial.accepted,
      key: Uint8Array = epochKey,
    ): SyncOperationPublication {
      const plaintext = Buffer.from('{"owned":"fixture-only"}');
      const header = {
        ...scope,
        epoch: accepted.control.activeEpoch,
        operationId: randomUUID(),
        authorDeviceId: deviceId,
        controlHash: accepted.commitment,
        parentsDigest: parentsDigest(parents),
        ...freshEntropy(),
        plaintextLength: plaintext.length,
      };
      return {
        wire: sealOperation(header, parents, key, plaintext, keys.signingKey).toString('base64url'),
        parents,
      };
    },
  };
}
export function makePublication(
  scope: SyncScope,
  ownerKey: KeyObject,
  deviceSigning: KeyObject,
  epochKey: Uint8Array,
  certificates: Certificate[],
  current?: AcceptedControl,
  enrollmentProofs: string[] = [],
  oldOwnerKey: KeyObject = ownerKey,
): { publication: SyncControlPublication; accepted: AcceptedControl } {
  const roster = rosterBytes(
    certificates
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
      .map((cert) => sealCertificate(cert, ownerKey)),
  );
  const control = {
    ...scope,
    generation: (current?.control.generation ?? 0) + 1,
    previousHash: current?.commitment ?? '0'.repeat(64),
    previousOwnerFingerprint: fingerprint(oldOwnerKey),
    newOwnerKey: createPublicKey(ownerKey),
    ownerDeviceId: certificates.find((c) => c.role === 'owner')!.deviceId,
    activeEpoch: current ? current.control.activeEpoch + 1 : 1,
    rosterDigest: rosterCommitment(roster),
    recoveryDescriptorDigest: '0'.repeat(64),
  };
  const wire = sealControl(control, oldOwnerKey, ownerKey);
  const accepted = acceptControl(wire, roster, scope, createPublicKey(ownerKey), current);
  const owner = certificates.find((c) => c.role === 'owner')!;
  const wraps = certificates.map((cert) =>
    wrapEpoch(
      {
        ...scope,
        epoch: control.activeEpoch,
        recipientDeviceId: cert.deviceId,
        recipientFingerprint: fingerprint(cert.wrappingKey),
        issuerDeviceId: owner.deviceId,
        issuerFingerprint: fingerprint(deviceSigning),
        controlHash: accepted.commitment,
      },
      epochKey,
      cert.wrappingKey,
      deviceSigning,
    ).toString('base64url'),
  );
  return {
    accepted,
    publication: {
      controlWire: wire.toString('base64url'),
      rosterWire: roster.toString('base64url'),
      wraps,
      recoveryDescriptorWire: null,
      recoveryWire: null,
      enrollmentProofs,
    },
  };
}
