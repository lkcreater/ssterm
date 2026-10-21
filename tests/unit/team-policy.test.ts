import assert from "node:assert/strict";
import test from "node:test";
import { createPublicKey, createPrivateKey, randomUUID } from "node:crypto";
import { createTeamLab, member } from "../fixtures/team/lab.ts";
import {
  acceptTeamCheckpoint,
  acceptTeamPolicy,
  teamPolicyBody,
  teamPolicyHash,
  sealTeamPolicy,
  teamTargetDigest,
} from "../../packages/adapters/src/team-policy.ts";
import { fingerprint } from "../../packages/adapters/src/sync-crypto.ts";
import {
  isTeamPolicy,
  isTeamMetadataSnapshot,
  isTeamCredentialSnapshot,
  isTeamVirtualHostId,
} from "../../packages/domain/src/team.ts";
import { SYNC_ZERO } from "../../packages/domain/src/sync.ts";
const clone = <T>(v: T): T => structuredClone(v);
test("team policy canonical signed golden vector and scope substitution rejection", () => {
  const owner = createPrivateKey({
      key: Buffer.from(
        "302e020100300506032b657004220420" + "01".repeat(32),
        "hex",
      ),
      format: "der",
      type: "pkcs8",
    }),
    uuid = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const body = {
    format: "ssterm-team-policy-v1" as const,
    scope: {
      deploymentId: uuid(1),
      accountId: uuid(2),
      teamId: uuid(3),
      metadataVaultId: uuid(4),
      credentialVaultId: uuid(5),
    },
    generation: 1,
    previousHash: SYNC_ZERO,
    previousOwnerFingerprint: fingerprint(owner),
    ownerSpki: createPublicKey(owner)
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
    ownerPrincipalId: uuid(6),
    ownerDeviceId: uuid(7),
    metadataControlHash: "11".repeat(32),
    credentialControlHash: "22".repeat(32),
    principals: [
      {
        principalId: uuid(6),
        role: "Owner" as const,
        status: "active" as const,
        tokenHash: "33".repeat(32),
      },
    ],
    devices: [{ deviceId: uuid(7), principalId: uuid(6) }],
  };
  const signed = sealTeamPolicy(body, owner, owner);
  assert.equal(teamPolicyBody(body).length, 976);
  assert.equal(
    teamPolicyHash(signed),
    "86dda67903987a755be42c2e1dee073c5d7d4de2a26bf56f7852bcd405614cfe",
  );
  assert.equal(
    acceptTeamPolicy(signed, body.scope, createPublicKey(owner)).commitment,
    teamPolicyHash(signed),
  );
  assert.throws(() =>
    acceptTeamPolicy(
      signed,
      { ...body.scope, teamId: uuid(8) },
      createPublicKey(owner),
    ),
  );
  const bad = clone(signed);
  bad.body.principals[0].tokenHash = "44".repeat(32);
  assert.throws(() =>
    acceptTeamPolicy(bad, body.scope, createPublicKey(owner)),
  );
});
test("team role rosters, paired domain commitments and cross-domain enrollment binding", async () => {
  const lab = await createTeamLab();
  const genesis = lab.prepare();
  lab.commit(genesis);
  const viewer = await member("Viewer"),
    editor = await member("Editor"),
    connector = await member("Connector");
  const next = lab.prepare([lab.owner, viewer, editor, connector]);
  assert.equal(next.accepted.metadata.certificates.length, 4);
  assert.equal(next.accepted.credentials.certificates.length, 3);
  assert(
    !next.accepted.credentials.certificates.some(
      (c) => c.deviceId === viewer.devices[0].deviceId,
    ),
  );
  const bad = clone(next.request.publication);
  bad.policy.body.credentialControlHash = bad.policy.body.metadataControlHash;
  assert.throws(() =>
    acceptTeamCheckpoint(
      {
        policy: bad.policy,
        metadataControl: bad.metadata.control,
        credentialControl: bad.credentials.control,
      },
      lab.scope,
      createPublicKey(lab.authority),
      lab.current,
    ),
  );
});
test("strict policies reject duplicate tokens, unknown fields, owner devices and revoked mappings", async () => {
  const lab = await createTeamLab(),
    p = lab.prepare().request.publication.policy.body;
  assert(isTeamPolicy(p));
  assert(!isTeamPolicy({ ...p, hidden: "value" }));
  const duplicate = clone(p);
  duplicate.devices.push({
    deviceId: randomUUID(),
    principalId: p.ownerPrincipalId,
  });
  duplicate.devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  assert(!isTeamPolicy(duplicate));
  const revoked = clone(p);
  revoked.principals[0].status = "revoked";
  assert(!isTeamPolicy(revoked));
});
test("role changes remove all old devices and rotate both epochs", async () => {
  const lab = await createTeamLab();
  lab.commit(lab.prepare());
  const viewer = await member("Viewer", 2);
  lab.commit(lab.prepare([lab.owner, viewer]));
  viewer.principal = { ...viewer.principal, role: "Connector" };
  assert.throws(() => lab.prepare([lab.owner, viewer], { rotate: true }));
  viewer.devices = [];
  const prepared = lab.prepare([lab.owner, viewer], { rotate: true });
  assert.equal(prepared.accepted.metadata.control.activeEpoch, 2);
  assert.equal(prepared.accepted.credentials.control.activeEpoch, 2);
});
test("metadata and credential plaintext validators reject ambiguous targets and fields", () => {
  const host = {
    recordId: randomUUID(),
    label: "owned",
    address: "127.0.0.1",
    port: 22,
    username: "fixture",
    environment: "PROD" as const,
  };
  assert(
    isTeamMetadataSnapshot({
      format: "ssterm-team-metadata-v1",
      hosts: [host],
      memberNames: [],
    }),
  );
  assert.notEqual(
    teamTargetDigest(randomUUID(), host),
    teamTargetDigest(randomUUID(), host),
  );
  const id = randomUUID();
  assert.notEqual(
    teamTargetDigest(id, host),
    teamTargetDigest(id, { ...host, username: "other" }),
  );
  assert(
    !isTeamMetadataSnapshot({
      format: "ssterm-team-metadata-v1",
      hosts: [{ ...host, address: "bad\nhost" }],
      memberNames: [],
    }),
  );
  assert(
    !isTeamMetadataSnapshot({
      format: "ssterm-team-metadata-v1",
      hosts: [{ ...host, password: "secret" }],
      memberNames: [],
    }),
  );
  assert(
    !isTeamCredentialSnapshot({
      format: "ssterm-team-credentials-v1",
      credentials: [
        {
          credentialId: randomUUID(),
          recordId: host.recordId,
          targetDigest: "a".repeat(64),
          password: "a\nb",
        },
      ],
    }),
  );
  assert(isTeamVirtualHostId("7ea03700-1234-8123-9123-123456789012"));
  assert(!isTeamVirtualHostId(host.recordId));
});

test("paired ordinary admission rejects different metadata and credential candidates for the same device", async () => {
  const lab = await createTeamLab();
  lab.commit(lab.prepare());
  const editor = await member("Editor");
  const a = lab.prepare([lab.owner, editor]),
    b = lab.prepare([lab.owner, editor]),
    p = a.request.publication;
  p.credentials = b.request.publication.credentials;
  p.policy = sealTeamPolicy(
    {
      ...p.policy.body,
      credentialControlHash:
        b.request.publication.policy.body.credentialControlHash,
    },
    lab.authority,
    lab.authority,
  );
  assert.throws(() =>
    acceptTeamCheckpoint(
      {
        policy: p.policy,
        metadataControl: p.metadata.control,
        credentialControl: p.credentials.control,
      },
      lab.scope,
      createPublicKey(lab.authority),
      lab.current,
    ),
  );
});
