import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createPublicKey, sign, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TeamServer,
  type TeamServerConfig,
} from '../../apps/sync-server/src/team-server.ts';
import {
  createTeamLab,
  member,
  hash,
  hashOperation,
  type LabMember,
} from '../fixtures/team/lab.ts';
import {
  createTeamTransport,
  teamRequestTranscript,
  validTeamEndpoint,
} from '../../packages/adapters/src/team-transport.ts';
import {
  sealTeamPolicy,
  teamPolicyHash,
} from '../../packages/adapters/src/team-policy.ts';
import {
  parseRecoveryDescriptor,
  recoveryDescriptor,
} from '../../packages/adapters/src/sync-recovery.ts';
import {
  sealRecovery,
  freshEntropy,
  generateSigningKey,
  generateDeviceKeys,
} from '../../packages/adapters/src/sync-crypto.ts';
import {
  teamMetadataScope,
  teamCredentialScope,
  type TeamPublishRequest,
  type TeamRecoveryKit,
} from '../../packages/domain/src/team.ts';
const payload = {
  format: 'ssterm-team-metadata-v1',
  hosts: [],
  memberNames: [],
};
async function fixture(
  options: {
    databasePath?: string;
    requestLimit?: number;
    auditLimit?: number;
  } = {},
) {
  const lab = await createTeamLab();
  const config: TeamServerConfig = {
    scope: lab.scope,
    databasePath: options.databasePath ?? ':memory:',
    initialOwnerPrincipalId: lab.owner.principal.principalId,
    initialOwnerTokenHash: lab.owner.principal.tokenHash,
  };
  const server = new TeamServer(config, {
    requestLimit: options.requestLimit ?? 10000,
    auditLimit: options.auditLimit,
  });
  const url = await server.listen(),
    owner = lab.transport(url, lab.owner);
  async function publish(
    members: LabMember[] = [lab.owner],
    opts: Parameters<typeof lab.prepare>[1] = {},
  ) {
    const p = lab.prepare(members, opts);
    const r = await owner.publish(p.request);
    assert(r.ok, JSON.stringify(r));
    lab.commit(p);
    return p;
  }
  await publish();
  return { lab, server, url, owner, config, publish };
}
test('real role matrix and Viewer credential ciphertext/wrap isolation', async () => {
  const f = await fixture();
  try {
    const editor = await member('Editor'),
      connector = await member('Connector'),
      viewer = await member('Viewer');
    await f.publish([f.lab.owner, editor, connector, viewer]);
    for (const m of [f.lab.owner, editor, connector, viewer]) {
      const transport = f.lab.transport(f.url, m),
        state = await transport.state({ knownPolicyHash: null });
      assert(state.ok);
      assert.equal(
        state.value.credentialSnapshot === null,
        m.principal.role === 'Viewer',
      );
      assert.equal(
        state.value.credentialWraps.length,
        m.principal.role === 'Viewer' ? 0 : 1,
      );
      assert((await transport.operation('metadata',state.value.metadataHead)).ok);
      const encryptedCredential=await transport.operation('credentials',state.value.credentialHead);
      if(m.principal.role==='Viewer')assert.deepEqual(encryptedCredential,{ok:false,code:'forbidden'});else assert(encryptedCredential.ok);
      const operation = f.lab.operation('metadata', m.devices[0], payload),
        write = await transport.writeMetadata({
          policyHash: f.lab.current.policy.commitment,
          expectedHead: f.lab.metadataHead,
          operation,
        });
      if (['Owner', 'Editor'].includes(m.principal.role)) {
        assert(write.ok, JSON.stringify(write));
        f.lab.setHead('metadata', write.value.head);
      } else assert.deepEqual(write, { ok: false, code: 'forbidden' });
      const credential = f.lab.operation('credentials', m.devices[0], {
          format: 'ssterm-team-credentials-v1',
          credentials: [],
        }),
        cw = await transport.writeCredentials({
          policyHash: f.lab.current.policy.commitment,
          expectedHead: f.lab.credentialHead,
          operation: credential,
        });
      if (m.principal.role === 'Owner') {
        assert(cw.ok);
        f.lab.setHead('credentials', cw.value.head);
      } else assert.deepEqual(cw, { ok: false, code: 'forbidden' });
      const grant = await transport.connect({
        requestId: randomUUID(),
        policyHash: f.lab.current.policy.commitment,
        metadataHash: f.lab.metadataHead,
        credentialHash: f.lab.credentialHead,
        recordId: randomUUID(),
      });
      if (m.principal.role === 'Viewer')
        assert.deepEqual(grant, { ok: false, code: 'forbidden' });
      else {
        assert(grant.ok);
        assert(grant.value.expiresAt <= Math.floor(Date.now() / 1000) + 15);
      }
      if (m.principal.role !== 'Owner') {
        assert.deepEqual(await transport.audit(0), {
          ok: false,
          code: 'forbidden',
        });
        assert.deepEqual(await transport.recovery(), {
          ok: false,
          code: 'forbidden',
        });
      }
    }
  } finally {
    await f.server.close();
  }
});
test('cross-principal token/device and cross-team headers fail before data, nonce single-use', async () => {
  const f = await fixture();
  try {
    const connector = await member('Connector');
    await f.publish([f.lab.owner, connector]);
    const alien = createTeamTransport({
      endpoint: { url: f.url, scope: f.lab.scope },
      principalId: connector.principal.principalId,
      deviceId: f.lab.owner.devices[0].deviceId,
      readToken: async () => Buffer.from(connector.token),
      signRequest: async (b) => ({
        deviceId: f.lab.owner.devices[0].deviceId,
        signature: sign(null, b, f.lab.owner.devices[0].signingKey),
      }),
    });
    assert.deepEqual(await alien.state({ knownPolicyHash: null }), {
      ok: false,
      code: 'forbidden',
    });
    const headers = {
      Authorization: `Bearer ${connector.token.toString('base64url')}`,
      'X-SSTerm-Deployment': f.lab.scope.deploymentId,
      'X-SSTerm-Account': f.lab.scope.accountId,
      'X-SSTerm-Team': f.lab.scope.teamId,
      'X-SSTerm-Principal': connector.principal.principalId,
    };
    const bad = await fetch(f.url + '/team/v1/policies/0', {
      headers: { ...headers, 'X-SSTerm-Team': randomUUID() },
    });
    assert.equal(bad.status, 401);
    const c = await (
        await fetch(f.url + '/team/v1/challenge', { headers })
      ).json(),
      path = '/team/v1/state',
      body = JSON.stringify({ knownPolicyHash: null }),
      d = connector.devices[0];
    const signedHeaders = {
      ...headers,
      'Content-Type': 'application/json',
      'X-SSTerm-Device': d.deviceId,
      'X-SSTerm-Nonce': c.value.nonce,
      'X-SSTerm-Signature': sign(
        null,
        teamRequestTranscript(
          'POST',
          path,
          f.lab.scope,
          connector.principal.principalId,
          c.value.nonce,
          Buffer.from(body),
          d.deviceId,
        ),
        d.signingKey,
      ).toString('base64url'),
    };
    assert.equal(
      (
        await fetch(f.url + path, {
          method: 'POST',
          headers: signedHeaders,
          body,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(f.url + path, {
          method: 'POST',
          headers: signedHeaders,
          body,
        })
      ).status,
      401,
    );
  } finally {
    await f.server.close();
  }
});
test('CAS protects data edits from stale rekey publication; exact bytes retry is idempotent', async () => {
  const f = await fixture();
  try {
    const staged = f.lab.prepare(),
      op = f.lab.operation('metadata', f.lab.owner.devices[0], payload),
      written = await f.owner.writeMetadata({
        policyHash: f.lab.current.policy.commitment,
        expectedHead: f.lab.metadataHead,
        operation: op,
      });
    assert(written.ok);
    assert.deepEqual(await f.owner.publish(staged.request), {
      ok: false,
      code: 'conflict',
    });
    assert.deepEqual(
      await f.owner.writeMetadata({
        policyHash: f.lab.current.policy.commitment,
        expectedHead: f.lab.metadataHead,
        operation: op,
      }),
      written,
    );
    f.lab.setHead('metadata', written.value.head);
    const p = f.lab.prepare(),
      r = await f.owner.publish(p.request);
    assert(r.ok);
    assert.deepEqual(await f.owner.publish(p.request), r);
    f.lab.commit(p);
    const publicChain = await f.owner.policies(0);
    assert(publicChain.ok);
    for (const cp of publicChain.value.checkpoints) {
      assert.deepEqual(cp.metadataControl.wraps, []);
      assert.equal(cp.credentialControl.recoveryWire, null);
    }
  } finally {
    await f.server.close();
  }
});
test('revocation removes every human device and requires both epochs and atomic current snapshots', async () => {
  const f = await fixture();
  try {
    const connector = await member('Connector', 2);
    await f.publish([f.lab.owner, connector]);
    const transports = connector.devices.map((d) =>
      f.lab.transport(f.url, connector, d),
    );
    for (const t of transports)
      assert((await t.state({ knownPolicyHash: null })).ok);
    connector.principal = { ...connector.principal, status: 'revoked' };
    const oldEpoch = f.lab.current.metadata.control.activeEpoch;
    assert.throws(() => f.lab.prepare([f.lab.owner, connector]));
    await f.publish([f.lab.owner, connector], { rotate: true });
    assert.equal(f.lab.current.metadata.control.activeEpoch, oldEpoch + 1);
    assert.equal(f.lab.current.credentials.control.activeEpoch, oldEpoch + 1);
    for (const t of transports)
      assert.deepEqual(await t.state({ knownPolicyHash: null }), {
        ok: false,
        code: 'unauthorized',
      });
  } finally {
    await f.server.close();
  }
});
test('audit transaction ordering, opaque fields, client-reported events and bounded retention', async () => {
  const f = await fixture({ auditLimit: 3 });
  try {
    const e = {
      eventId: randomUUID(),
      requestId: randomUUID(),
      recordId: randomUUID(),
      policyHash: f.lab.current.policy.commitment,
      action: 'connect-ready' as const,
    };
    assert.deepEqual(await f.owner.events([e]), {
      ok: true,
      value: { accepted: 1 },
    });
    assert.deepEqual(await f.owner.events([e]), {
      ok: true,
      value: { accepted: 0 },
    });
    for (let i = 0; i < 4; i++)
      await f.owner.connect({
        requestId: randomUUID(),
        recordId: randomUUID(),
        policyHash: f.lab.current.policy.commitment,
        metadataHash: f.lab.metadataHead,
        credentialHash: f.lab.credentialHead,
      });
    const a = await f.owner.audit(0);
    assert(a.ok);
    assert.equal(a.value.entries.length, 3);
    assert(a.value.firstAvailableSequence > 1);
    assert(a.value.entries.every((e) => e.action === 'connect-authorized'));
    assert(!JSON.stringify(a).includes('password'));
    assert(
      a.value.entries.every(
        (v, i, arr) => i === 0 || v.sequence > arr[i - 1].sequence,
      ),
    );
  } finally {
    await f.server.close();
  }
});
test('private SQLite restart retains exact committed heads and rejects foreign team identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ssterm-team-server-'));
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture({ databasePath: join(dir, 'team.sqlite') });
    const op = f.lab.operation('metadata', f.lab.owner.devices[0], payload),
      r = await f.owner.writeMetadata({
        policyHash: f.lab.current.policy.commitment,
        expectedHead: f.lab.metadataHead,
        operation: op,
      });
    assert(r.ok);
    await f.server.close();
    const reopened = new TeamServer(f.config),
      url = await reopened.listen();
    try {
      const state = await f.lab
        .transport(url, f.lab.owner)
        .state({ knownPolicyHash: null });
      assert(state.ok);
      assert.equal(state.value.metadataHead, r.value.head);
      assert.equal(state.value.metadataSnapshot.wire, op.wire);
    } finally {
      await reopened.close();
    }
    const saved = f;
    assert.throws(
      () =>
        new TeamServer({
          ...saved.config,
          scope: { ...saved.lab.scope, teamId: randomUUID() },
        }),
    );
    const bytes = await readFile(join(dir, 'team.sqlite'));
    assert(!bytes.includes(f.lab.owner.token));
    assert(
      !bytes.includes(Buffer.from(f.lab.owner.token.toString('base64url'))),
    );
  } finally {
    await f?.server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('Owner token recovery reads current ciphertext without device and validates paired kit provenance', async () => {
  const f = await fixture();
  try {
    const secret = randomBytes(32),
      recoveryId = randomUUID(),
      base = f.lab.currentPub.policy;
    const wire = (
      scope: ReturnType<typeof teamMetadataScope>,
      controlHash: string,
    ) =>
      sealRecovery(
        {
          ...scope,
          recoveryId,
          controlHash,
          ...freshEntropy(),
          plaintextLength: 2,
        },
        secret,
        Buffer.from('{}'),
      ).toString('base64url');
    const kit: TeamRecoveryKit = {
      format: 'ssterm-team-recovery-v1',
      basePolicy: base,
      metadataRecoveryWire: wire(
        teamMetadataScope(f.lab.scope),
        base.body.metadataControlHash,
      ),
      credentialRecoveryWire: wire(
        teamCredentialScope(f.lab.scope),
        base.body.credentialControlHash,
      ),
    };
    const descriptor = (
      scope: ReturnType<typeof teamMetadataScope>,
      recovery: string,
    ) =>
      recoveryDescriptor({
        ...scope,
        recoveryId,
        recoveryEnvelopeHash: hash(Buffer.from(recovery, 'base64url')),
      }).toString('base64url');
    await f.publish([f.lab.owner], {
      recovery: kit,
      metadataDescriptor: descriptor(
        teamMetadataScope(f.lab.scope),
        kit.metadataRecoveryWire,
      ),
      credentialDescriptor: descriptor(
        teamCredentialScope(f.lab.scope),
        kit.credentialRecoveryWire,
      ),
    });
    const response = await f.owner.recovery();
    assert(response.ok);
    assert.deepEqual(response.value.kit, kit);
    assert.deepEqual(response.value.checkpoint.metadataControl.wraps, []);
    assert.equal(response.value.metadataHead, f.lab.metadataHead);
    const bad = f.lab.prepare([f.lab.owner], {
      recovery: { ...kit, credentialRecoveryWire: kit.metadataRecoveryWire },
    });
    assert.deepEqual(await f.owner.publish(bad.request), {
      ok: false,
      code: 'invalid',
    });
    const oldOwner = f.owner,
      newDevice = {
        deviceId: randomUUID(),
        principalId: f.lab.owner.principal.principalId,
        ...(await generateDeviceKeys()),
      };
    f.lab.owner.devices = [newDevice];
    const restored = f.lab.prepare([f.lab.owner], {
      rotate: true,
      newAuthority: generateSigningKey(),
      ownerDevice: newDevice,
      metadataDescriptor: null,
      credentialDescriptor: null,
      recoveryHashes: {
        metadata: hash(Buffer.from(kit.metadataRecoveryWire, 'base64url')),
        credentials: hash(Buffer.from(kit.credentialRecoveryWire, 'base64url')),
      },
    });
    const recovery = await oldOwner.publish(restored.request);
    assert(recovery.ok, JSON.stringify(recovery));
    f.lab.commit(restored);
    assert.equal(f.lab.current.metadata.control.activeEpoch, 2);
    assert.equal(f.lab.current.credentials.control.activeEpoch, 2);
    assert.deepEqual(await oldOwner.state({ knownPolicyHash: null }), {
      ok: false,
      code: 'forbidden',
    });
    const fresh = f.lab.transport(f.url, f.lab.owner);
    assert((await fresh.state({ knownPolicyHash: null })).ok);
    const after = await fresh.recovery();
    assert(after.ok);
    assert.equal(after.value.kit, null);
  } finally {
    await f.server.close();
  }
});
test('endpoint rejects remote cleartext, embedded credentials and redirects', async () => {
  const f = await fixture();
  try {
    for (const url of [
      'http://localhost:1234',
      'http://192.0.2.1',
      'https://user:secret@example.test',
      'https://example.test/path',
    ])
      assert(!validTeamEndpoint({ url, scope: f.lab.scope }));
    const t = createTeamTransport({
      endpoint: { url: f.url, scope: f.lab.scope },
      principalId: f.lab.owner.principal.principalId,
      deviceId: f.lab.owner.devices[0].deviceId,
      readToken: async () => Buffer.from(f.lab.owner.token),
      signRequest: async () => {
        throw new Error('unused');
      },
      fetch: async () =>
        new Response('', {
          status: 302,
          headers: { Location: 'https://alien.test' },
        }),
    });
    assert.deepEqual(await t.info(), { ok: false, code: 'unavailable' });
  } finally {
    await f.server.close();
  }
});

test('operation admission cap rejects whole write and preserves current retained head', async () => {
  const f = await fixture();
  try {
    for (let i = 1; i < 256; i++) {
      const operation = f.lab.operation('metadata', f.lab.owner.devices[0], payload);
      const written = await f.owner.writeMetadata({policyHash:f.lab.current.policy.commitment,expectedHead:f.lab.metadataHead,operation});
      assert(written.ok, JSON.stringify(written));
      f.lab.setHead('metadata', written.value.head);
    }
    const head = f.lab.metadataHead;
    const rejected = await f.owner.writeMetadata({policyHash:f.lab.current.policy.commitment,expectedHead:head,operation:f.lab.operation('metadata',f.lab.owner.devices[0],payload)});
    assert.deepEqual(rejected,{ok:false,code:'too-large'});
    const state = await f.owner.state({knownPolicyHash:null});
    assert(state.ok);assert.equal(state.value.metadataHead,head);
  } finally { await f.server.close(); }
});

test('Team CLI provisions one Owner token once and stores hashes only', async () => {
  const {provisionOwnerPrincipalToken,loadTeamConfig}=await import('../../apps/sync-server/src/team-cli.ts');
  const directory=await mkdtemp(join(tmpdir(),'ssterm-team-cli-'));
  try {
    const path=join(directory,'team.json'),result=await provisionOwnerPrincipalToken(path);
    assert.equal(hash(Buffer.from(result.token,'base64url')),result.config.initialOwnerTokenHash);
    assert.deepEqual(loadTeamConfig(path),result.config);
    assert(!(await readFile(path,'utf8')).includes(result.token));
    assert(!(await readFile(result.config.databasePath)).includes(Buffer.from(result.token)));
    await assert.rejects(provisionOwnerPrincipalToken(path));
  } finally {await rm(directory,{recursive:true,force:true});}
});
