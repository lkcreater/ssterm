// Explicit owned Docker lab. No user profiles, credentials, volumes or remote hosts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, sign, createHash, createPublicKey, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  generateSigningKey,
  generateDeviceKeys,
  generateEpochKey,
  fingerprint,
  wrapEpoch,
  sealOperation,
  freshEntropy,
  parentsDigest,
} from '../../../packages/adapters/src/sync-crypto.ts';
import {
  sealCertificate,
  rosterBytes,
  rosterCommitment,
  sealControl,
  acceptControl,
} from '../../../packages/adapters/src/sync-control.ts';
import { createSyncTransport } from '../../../packages/adapters/src/sync-transport.ts';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  }).trim();
const name = `ssterm-sync-${randomUUID()}`;
const label = `ssterm.fixture.sync=${name}`;
let id;
let checks = 0;
const boot = `import{existsSync,writeFileSync,readFileSync}from'node:fs';import{provision,loadConfig}from'./apps/sync-server/src/cli.ts';import{SyncServer}from'./apps/sync-server/src/server.ts';const path='/tmp/owned-sync/server.json';if(!existsSync(path)){const p=await provision(path);p.config.host='0.0.0.0';writeFileSync(path,JSON.stringify(p.config),{mode:384});writeFileSync('/tmp/owned-sync/token',p.token,{mode:384});}const server=new SyncServer(loadConfig(path));await server.listen();process.on('SIGTERM',()=>{void server.close();});console.log('owned sync fixture ready');`;
try {
  id = docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    label,
    '--publish',
    '127.0.0.1::8787',
    'ssterm-sync-fixture:sst035',
    'node',
    '--experimental-transform-types',
    '--input-type=module',
    '-e',
    boot,
  );
  const port = docker('port', id, '8787/tcp').split(':').at(-1);
  const url = `http://127.0.0.1:${port}`;
  let info;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const r = await fetch(`${url}/v1/info`);
      const p = await r.json();
      if (p.ok) {
        info = p.value;
        break;
      }
    } catch {}
    await delay(50);
  }
  assert.ok(info);
  checks++;
  const token = Buffer.from(docker('exec', id, 'cat', '/tmp/owned-sync/token'), 'base64url');
  const config = JSON.parse(docker('exec', id, 'cat', '/tmp/owned-sync/server.json'));
  assert.equal(config.tokenHash, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(config).includes(token.toString('base64url')), false);
  checks++;
  const scope = { deploymentId: info.deploymentId, accountId: info.accountId, vaultId: info.vaultId };
  const owner = generateSigningKey();
  const keys = await generateDeviceKeys();
  const epoch = generateEpochKey();
  const deviceId = randomUUID();
  const roster = rosterBytes([
    sealCertificate(
      {
        ...scope,
        ...keys,
        deviceId,
        role: 'owner',
        enrollmentHash: '0'.repeat(64),
        ownerFingerprint: fingerprint(owner),
        firstGeneration: 1,
      },
      owner,
    ),
  ]);
  const control = sealControl(
    {
      ...scope,
      generation: 1,
      previousHash: '0'.repeat(64),
      previousOwnerFingerprint: fingerprint(owner),
      newOwnerKey: createPublicKey(owner),
      ownerDeviceId: deviceId,
      activeEpoch: 1,
      rosterDigest: rosterCommitment(roster),
      recoveryDescriptorDigest: '0'.repeat(64),
    },
    owner,
    owner,
  );
  const accepted = acceptControl(control, roster, scope, owner);
  const wrap = wrapEpoch(
    {
      ...scope,
      epoch: 1,
      recipientDeviceId: deviceId,
      recipientFingerprint: fingerprint(keys.wrappingKey),
      issuerDeviceId: deviceId,
      issuerFingerprint: fingerprint(keys.signingKey),
      controlHash: accepted.commitment,
    },
    epoch,
    keys.wrappingKey,
    keys.signingKey,
  );
  const makeTransport = (origin) =>
    createSyncTransport({
      endpoint: { url: origin, scope },
      readToken: async () => Buffer.from(token),
      signRequest: async (transcript) => ({ deviceId, signature: sign(null, transcript, keys.signingKey) }),
    });
  const transport = makeTransport(url);
  assert.equal(
    (
      await transport.publishControl({
        controlWire: control.toString('base64url'),
        rosterWire: roster.toString('base64url'),
        wraps: [wrap.toString('base64url')],
        recoveryDescriptorWire: null,
        recoveryWire: null,
        enrollmentProofs: [],
      })
    ).ok,
    true,
  );
  checks++;
  const plaintext = Buffer.from('owned docker ciphertext marker');
  const operation = {
    wire: sealOperation(
      {
        ...scope,
        epoch: 1,
        operationId: randomUUID(),
        authorDeviceId: deviceId,
        controlHash: accepted.commitment,
        parentsDigest: parentsDigest([]),
        ...freshEntropy(),
        plaintextLength: plaintext.length,
      },
      [],
      epoch,
      plaintext,
      keys.signingKey,
    ).toString('base64url'),
    parents: [],
  };
  const result = await transport.exchange({ afterSequence: 0, operations: [operation] });
  assert.ok(result.ok);
  assert.equal(result.value.operations[0].wire, operation.wire);
  checks++;
  assert.equal((await transport.wraps(1)).ok, true);
  checks++;
  const stored = docker(
    'exec',
    id,
    'node',
    '--input-type=module',
    '-e',
    "import{readFileSync}from'node:fs';console.log(readFileSync('/tmp/owned-sync/sync.sqlite').toString('base64'))",
  );
  assert.equal(Buffer.from(stored, 'base64').includes(plaintext), false);
  checks++;
  docker('restart', '--time', '5', id);
  const restartedUrl = `http://127.0.0.1:${docker('port', id, '8787/tcp').split(':').at(-1)}`;
  const restartedTransport = makeTransport(restartedUrl);
  let fetched;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const r = await restartedTransport.exchange({ afterSequence: 0, operations: [] });
      if (r.ok) {
        fetched = r;
        break;
      }
    } catch {}
    await delay(50);
  }
  if (!fetched?.ok) process.stderr.write(docker('logs', id) + '\n');
  assert.ok(fetched?.ok);
  assert.equal(fetched.value.operations[0].wire, operation.wire);
  checks++;
  const unauth = await fetch(`${restartedUrl}/v1/controls/0`, {
    headers: { Authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
  });
  assert.equal(unauth.status, 401);
  checks++;
  token.fill(0);
  epoch.fill(0);
  plaintext.fill(0);
} finally {
  if (id) {
    const actual = docker('inspect', '--format', '{{index .Config.Labels "ssterm.fixture.sync"}}', id);
    assert.equal(actual, name);
    docker('rm', '--force', id);
  }
}
assert.throws(() => docker('inspect', name));
process.stdout.write(
  JSON.stringify({ checks, containerRemoved: true, image: 'ssterm-sync-fixture:sst035' }) + '\n',
);
