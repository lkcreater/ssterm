import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { TeamClient, type TeamResult } from '../../packages/services/src/team.ts';
import { openTeamRepository } from '../../packages/adapters/src/team-repository.ts';
import { createTeamTransport, type TeamTransport, type TeamTransportOptions } from '../../packages/adapters/src/team-transport.ts';
import type { TeamKeyStore } from '../../packages/adapters/src/team-keychain.ts';
import type { TeamHost, TeamScope } from '../../packages/domain/src/team.ts';
import { TeamServer } from '../../apps/sync-server/src/team-server.ts';

function ok<T>(result: TeamResult<T>): T {
  assert(result.ok, JSON.stringify(result));
  return result.value;
}
class Keys implements TeamKeyStore {
  values = new Map<string, Buffer>();
  writes: string[] = [];
  async read(account: string) {
    const value = this.values.get(account);
    return value ? { status: 'present' as const, value: Buffer.from(value) } : { status: 'missing' as const };
  }
  async write(account: string, value: Uint8Array) {
    this.values.get(account)?.fill(0);
    this.values.set(account, Buffer.from(value));
    this.writes.push(account);
    return 'confirmed' as const;
  }
  async delete(account: string) {
    this.values.get(account)?.fill(0);
    this.values.delete(account);
    return 'confirmed' as const;
  }
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ssterm-team-restored-journal-'));
  const scope: TeamScope = {
    deploymentId: randomUUID(), accountId: randomUUID(), teamId: randomUUID(),
    metadataVaultId: randomUUID(), credentialVaultId: randomUUID(),
  };
  const principalId = randomUUID(), token = randomBytes(32).toString('base64url');
  const server = new TeamServer({
    scope, databasePath: join(dir, 'server.sqlite'), initialOwnerPrincipalId: principalId,
    initialOwnerTokenHash: createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'),
  }, { requestLimit: 10000 });
  const endpoint = await server.listen(), path = join(dir, 'team.sqlite');
  const repository = openTeamRepository(path), keys = new Keys();
  let drop: 'write' | 'publication' | null = null;
  const factory = (options: TeamTransportOptions): TeamTransport => {
    const transport = createTeamTransport(options);
    return {
      ...transport,
      async writeMetadata(request, signal) {
        const result = await transport.writeMetadata(request, signal);
        if (drop === 'write' && result.ok) { drop = null; return { ok: false, code: 'unavailable' }; }
        return result;
      },
      async publish(request, signal) {
        const result = await transport.publish(request, signal);
        if (drop === 'publication' && result.ok) { drop = null; return { ok: false, code: 'unavailable' }; }
        return result;
      },
    };
  };
  const client = new TeamClient({ repository, keyStore: keys, transportFactory: factory });
  const restored: { client: TeamClient; repository: ReturnType<typeof openTeamRepository> }[] = [];
  try {
    ok(await client.create({ endpoint, expectedScope: scope, principalId, token }));
    return {
      client, keys, repository,
      dropNext(kind: 'write' | 'publication') { drop = kind; },
      async snapshot() {
        const destination = join(dir, `backup-${randomUUID()}.sqlite`);
        const source = new DatabaseSync(path, { readOnly: true });
        try { await backup(source, destination); } finally { source.close(); }
        await chmod(destination, 0o600);
        return destination;
      },
      reopen(destination: string) {
        const restoredRepository = openTeamRepository(destination);
        const restoredClient = new TeamClient({ repository: restoredRepository, keyStore: keys, transportFactory: factory });
        restored.push({ client: restoredClient, repository: restoredRepository });
        return { client: restoredClient, repository: restoredRepository };
      },
      async close() {
        await client.dispose();
        for (const entry of restored) { await entry.client.dispose(); entry.repository.close(); }
        repository.close(); await server.close();
        for (const value of keys.values.values()) value.fill(0);
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client.dispose(); repository.close(); await server.close();
    await rm(dir, { recursive: true, force: true }); throw error;
  }
}
const host = (): TeamHost => ({ recordId: randomUUID(), label: 'Owned restore fixture', address: '127.0.0.1', port: 22, username: 'fixture', environment: 'DEV' });
const checkpoint = (keys: Keys): [string, Buffer] => {
  const entry = [...keys.values.entries()].find(([account]) => account.includes('/checkpoint/'));
  assert(entry); return [entry[0], Buffer.from(entry[1])];
};

test('restored pending data write cannot downgrade newer same-policy OS heads before journal replay', async () => {
  const f = await fixture();
  try {
    f.dropNext('write');
    assert.deepEqual(await f.client.saveHost({ record: host(), expectedMetadataHash: f.client.state().metadataHash! }), { ok: false, code: 'unavailable' });
    assert(f.repository.get('pendingWrite'));
    const snapshot = await f.snapshot();
    ok(await f.client.fetch()); // The original journal still resumes normally.
    ok(await f.client.saveHost({ record: host(), expectedMetadataHash: f.client.state().metadataHash! }));
    const [account, pin] = checkpoint(f.keys), writes = f.keys.writes.length;
    const restored = f.reopen(snapshot);
    assert.deepEqual(await restored.client.fetch(), { ok: false, code: 'key-unavailable' });
    assert.deepEqual(f.keys.values.get(account), pin);
    assert(!f.keys.writes.slice(writes).includes(account), 'rejected restored journal never writes OS high-water');
    assert(restored.repository.get('pendingWrite'), 'preserves ciphertext journal for deliberate reconciliation');
    assert.equal(restored.client.state().hosts.length, 0);
  } finally { await f.close(); }
});

test('restored pending policy publication cannot replace a higher-generation OS authority checkpoint', async () => {
  const f = await fixture();
  try {
    f.dropNext('publication');
    assert.deepEqual(await f.client.invitePrincipal({ label: 'First fixture member', role: 'Viewer' }), { ok: false, code: 'unavailable' });
    assert(f.repository.get('pendingPublication'));
    const snapshot = await f.snapshot();
    ok(await f.client.invitePrincipal({ label: 'First fixture member', role: 'Viewer' }));
    ok(await f.client.invitePrincipal({ label: 'Second fixture member', role: 'Viewer' }));
    assert.equal(f.client.state().generation, 3);
    const [account, pin] = checkpoint(f.keys), writes = f.keys.writes.length;
    const restored = f.reopen(snapshot);
    assert.deepEqual(await restored.client.fetch(), { ok: false, code: 'key-unavailable' });
    assert.deepEqual(f.keys.values.get(account), pin);
    assert(!f.keys.writes.slice(writes).includes(account), 'older exact receipt cannot overwrite OS authority high-water');
    assert(restored.repository.get('pendingPublication'));
    assert.equal(restored.client.state().generation, 1);
  } finally { await f.close(); }
});
