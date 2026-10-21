/** Owned Docker evidence. No user data, mounts, credentials or remote systems. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createTeamLab, member, hash } from './lab.ts';
const docker = (...args: string[]) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  }).trim();
const name = `ssterm-team-${randomUUID()}`,
  label = `ssterm.fixture.team=${name}`;
let id: string | undefined,
  checks = 0;
const lab = await createTeamLab();
const config = {
  scope: lab.scope,
  databasePath: '/tmp/owned-team/team.sqlite',
  initialOwnerPrincipalId: lab.owner.principal.principalId,
  initialOwnerTokenHash: lab.owner.principal.tokenHash,
  host: '0.0.0.0',
  port: 8788,
};
const boot = `import{TeamServer}from'./apps/sync-server/src/team-server.ts';const server=new TeamServer(JSON.parse(Buffer.from('${Buffer.from(JSON.stringify(config)).toString('base64url')}','base64url')),{requestLimit:10000});await server.listen();process.on('SIGTERM',()=>{void server.close()});console.log('owned team fixture ready');`;
try {
  id = docker(
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    label,
    '--publish',
    '127.0.0.1::8788',
    'ssterm-team-fixture:sst037',
    'node',
    '--experimental-transform-types',
    '--input-type=module',
    '-e',
    boot,
  );
  let url = `http://127.0.0.1:${docker('port', id, '8788/tcp').split(':').at(-1)}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const r = await fetch(url + '/team/v1/info');
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(50);
  }
  assert(ready);
  checks++;
  let owner = lab.transport(url, lab.owner);
  const initial = lab.prepare(),
    receipt = await owner.publish(initial.request);
  assert(receipt.ok);
  lab.commit(initial);
  checks++;
  const viewer = await member('Viewer'),
    editor = await member('Editor'),
    connector = await member('Connector', 2),
    members = [lab.owner, viewer, editor, connector];
  const enrolled = lab.prepare(members);
  assert((await owner.publish(enrolled.request)).ok);
  lab.commit(enrolled);
  checks++;
  const viewerState = await lab
    .transport(url, viewer)
    .state({ knownPolicyHash: null });
  assert(viewerState.ok);
  assert.equal(viewerState.value.credentialSnapshot, null);
  assert.deepEqual(viewerState.value.credentialWraps, []);
  checks++;
  const marker = 'team-owned-metadata-plaintext-marker',
    op = lab.operation('metadata', editor.devices[0], {
      format: 'ssterm-team-metadata-v1',
      hosts: [
        {
          recordId: randomUUID(),
          label: marker,
          address: '127.0.0.1',
          port: 22,
          username: 'fixture',
          environment: 'DEV',
        },
      ],
      memberNames: [],
    });
  const edit = await lab.transport(url, editor).writeMetadata({
    policyHash: lab.current.policy.commitment,
    expectedHead: lab.metadataHead,
    operation: op,
  });
  assert(edit.ok);
  lab.setHead('metadata', edit.value.head);
  checks++;
  const forbidden = await lab.transport(url, connector).writeMetadata({
    policyHash: lab.current.policy.commitment,
    expectedHead: lab.metadataHead,
    operation: lab.operation('metadata', connector.devices[0], {}),
  });
  assert.deepEqual(forbidden, { ok: false, code: 'forbidden' });
  checks++;
  const stored = Buffer.from(
    docker(
      'exec',
      id,
      'node',
      '--input-type=module',
      '-e',
      "import{readFileSync}from'node:fs';console.log(readFileSync('/tmp/owned-team/team.sqlite').toString('base64'))",
    ),
    'base64',
  );
  assert(!stored.includes(Buffer.from(marker)));
  assert(!stored.includes(lab.owner.token));
  checks++;
  docker('restart', '--time', '5', id);
  url = `http://127.0.0.1:${docker('port', id, '8788/tcp').split(':').at(-1)}`;
  owner = lab.transport(url, lab.owner);
  ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(url + '/team/v1/info');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(50);
  }
  assert(ready, docker('logs', id));
  const state = await owner.state({ knownPolicyHash: null });
  assert(state.ok, JSON.stringify(state));
  assert.equal(state.value.metadataHead, edit.value.head);
  checks++;
  connector.principal = { ...connector.principal, status: 'revoked' };
  const revoke = lab.prepare(members, { rotate: true });
  assert((await owner.publish(revoke.request)).ok);
  lab.commit(revoke);
  for (const d of connector.devices)
    assert.deepEqual(
      await lab.transport(url, connector, d).state({ knownPolicyHash: null }),
      { ok: false, code: 'unauthorized' },
    );
  checks++;
  const audit = await owner.audit(0);
  assert(audit.ok);
  assert(audit.value.entries.some((e) => e.action === 'policy-published'));
  assert(!JSON.stringify(audit).includes(marker));
  checks++;
  console.log(`Owned team Docker checks ${checks}/${checks} passed`);
} finally {
  if (id) {
    const actual = docker(
      'inspect',
      '--format',
      '{{index .Config.Labels "ssterm.fixture.team"}}',
      id,
    );
    assert.equal(actual, name);
    docker('rm', '--force', id);
    assert.equal(
      docker('ps', '--all', '--quiet', '--filter', `label=${label}`),
      '',
    );
    console.log('Owned team exact-container cleanup passed');
  }
}
