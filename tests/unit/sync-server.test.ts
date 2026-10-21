import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile, stat, chmod, symlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createSyncLab, makePublication } from '../fixtures/sync/lab.ts';
import { SyncServer } from '../../apps/sync-server/src/server.ts';
import { provision, loadConfig } from '../../apps/sync-server/src/cli.ts';
import {
  createSyncTransport,
  syncRequestTranscript,
  validSyncEndpoint,
} from '../../packages/adapters/src/sync-transport.ts';
import {
  unframe,
  parseDataHeader,
  sealOperation,
  freshEntropy,
  generateDeviceKeys,
  generateSigningKey,
  fingerprint,
  operationCommitment,
  sealRecovery,
} from '../../packages/adapters/src/sync-crypto.ts';
import {
  enrollmentBody,
  enrollmentHash,
  proveEnrollment,
  challengeEnrollment,
  rosterBytes,
  rosterCommitment,
  sealCertificate,
  sealControl,
  acceptControl,
} from '../../packages/adapters/src/sync-control.ts';
import { recoveryDescriptor, recoveryDescriptorDigest } from '../../packages/adapters/src/sync-recovery.ts';
import { isSyncControlPublication, syncBytes } from '../../packages/domain/src/sync.ts';

test('sync server real loopback: immutable ciphertext, restart, scope and request auth', async (t) => {
  const lab = await createSyncLab();
  t.after(() => lab.close());
  const transport = lab.transport();
  await t.test(
    'bootstrap atomically, discover sanitized public controls and idempotent publication',
    async () => {
      assert.equal((await transport.info()).ok, true);
      assert.deepEqual(await transport.publishControl(lab.initial.publication), {
        ok: true,
        value: { controlHash: lab.initial.accepted.commitment, generation: 1 },
      });
      assert.equal((await transport.publishControl(lab.initial.publication)).ok, true);
      const controls = await transport.controls(0);
      assert.ok(controls.ok);
      assert.deepEqual(controls.value.controls[0].wraps, []);
      assert.equal(controls.value.controls[0].recoveryWire, null);
      const wraps = await transport.wraps(1);
      assert.ok(wraps.ok);
      assert.equal(wraps.value.wraps.length, 1);
    },
  );
  const first = lab.operation();
  await t.test('ordered operation writes and exact retries survive process restart', async () => {
    const result = await transport.exchange({ afterSequence: 0, operations: [first] });
    assert.ok(result.ok);
    assert.equal(result.value.nextSequence, 1);
    const retry = await transport.exchange({ afterSequence: 0, operations: [first] });
    assert.ok(retry.ok);
    assert.equal(retry.value.operations.length, 1);
    await lab.restart();
    const fresh = await lab.transport().exchange({ afterSequence: 0, operations: [] });
    assert.ok(fresh.ok);
    assert.equal(fresh.value.operations[0].wire, first.wire);
    const second = lab.operation([operationCommitment(Buffer.from(first.wire, 'base64url'))]);
    const after = await lab.transport().exchange({ afterSequence: 1, operations: [second] });
    assert.ok(after.ok);
    assert.equal(after.value.nextSequence, 2);
    assert.equal((await stat(lab.config.databasePath)).mode & 0o777, 0o600);
  });
  await t.test('wrong token, cross scope, unknown signer, missing nonce denied', async () => {
    const base = lab.headers();
    for (const headers of [
      { ...base, Authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
      { ...base, 'X-SSTerm-Account': randomUUID() },
    ]) {
      const response = await fetch(`${lab.url}/v1/controls/0`, { headers });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { ok: false, code: 'unauthorized' });
    }
    const response = await fetch(`${lab.url}/v1/exchange`, {
      method: 'POST',
      headers: { ...base, 'Content-Type': 'application/json' },
      body: '{"afterSequence":0,"operations":[]}',
    });
    assert.equal(response.status, 401);
    const bad = createSyncTransport({
      endpoint: { url: lab.url, scope: lab.scope },
      readToken: async () => Buffer.from(lab.token),
      signRequest: async (bytes) => ({
        deviceId: randomUUID(),
        signature: sign(null, bytes, lab.keys.signingKey),
      }),
    });
    assert.deepEqual(await bad.exchange({ afterSequence: 0, operations: [] }), {
      ok: false,
      code: 'forbidden',
    });
  });
  await t.test('nonce cannot replay or authorize changed request body', async () => {
    const headers = lab.headers();
    const challenge = (await (await fetch(`${lab.url}/v1/challenge`, { headers })).json()) as {
      value: { nonce: string };
    };
    const path = '/v1/exchange';
    const body = '{"afterSequence":0,"operations":[]}';
    const signature = sign(
      null,
      syncRequestTranscript('POST', path, lab.scope, challenge.value.nonce, Buffer.from(body)),
      lab.keys.signingKey,
    ).toString('base64url');
    const auth = {
      ...headers,
      'Content-Type': 'application/json',
      'X-SSTerm-Device': lab.deviceId,
      'X-SSTerm-Nonce': challenge.value.nonce,
      'X-SSTerm-Signature': signature,
    };
    assert.equal((await fetch(`${lab.url}${path}`, { method: 'POST', headers: auth, body })).status, 200);
    assert.equal((await fetch(`${lab.url}${path}`, { method: 'POST', headers: auth, body })).status, 401);
  });
  await t.test(
    'tamper, duplicate JSON fields, unknown fields and unknown parents rejected without mutation',
    async () => {
      const p = lab.operation();
      const bytes = Buffer.from(p.wire, 'base64url');
      bytes[bytes.length - 1] ^= 1;
      assert.deepEqual(
        await lab
          .transport()
          .exchange({ afterSequence: 2, operations: [{ ...p, wire: bytes.toString('base64url') }] }),
        { ok: false, code: 'invalid' },
      );
      assert.deepEqual(
        await lab.transport().exchange({ afterSequence: 2, operations: [lab.operation(['a'.repeat(64)])] }),
        { ok: false, code: 'conflict' },
      );
      const response = await fetch(`${lab.url}/v1/controls`, {
        method: 'POST',
        headers: { ...lab.headers(), 'Content-Type': 'application/json' },
        body: '{"controlWire":"","controlWire":""}',
      });
      assert.deepEqual(await response.json(), { ok: false, code: 'invalid' });
      assert.equal(isSyncControlPublication({ ...lab.initial.publication, extra: true }), false);
      const after = await lab.transport().exchange({ afterSequence: 2, operations: [] });
      assert.ok(after.ok);
      assert.equal(after.value.operations.length, 0);
    },
  );
  await t.test('operation ID/salt collisions conflict and failed exchange batch rolls back all', async () => {
    const [header] = unframe(Buffer.from(first.wire, 'base64url'), 3);
    const original = parseDataHeader(header);
    const plaintext = Buffer.from('{"owned":"fixture-only"}');
    const collision = sealOperation(
      { ...original, operationId: randomUUID(), nonce: freshEntropy().nonce },
      [],
      lab.epochKey,
      plaintext,
      lab.keys.signingKey,
    ).toString('base64url');
    const p = lab.operation();
    assert.deepEqual(
      await lab.transport().exchange({ afterSequence: 2, operations: [p, { wire: collision, parents: [] }] }),
      { ok: false, code: 'conflict' },
    );
    const after = await lab.transport().exchange({ afterSequence: 2, operations: [] });
    assert.ok(after.ok);
    assert.equal(after.value.operations.length, 0);
  });
  await t.test('epoch rotation blocks fresh old work, keeps accepted retry idempotent', async () => {
    const rotated = makePublication(
      lab.scope,
      lab.ownerKey,
      lab.keys.signingKey,
      lab.epochKey,
      [lab.certificate],
      lab.initial.accepted,
    );
    assert.equal((await lab.transport().publishControl(rotated.publication)).ok, true);
    assert.deepEqual(await lab.transport().exchange({ afterSequence: 2, operations: [lab.operation()] }), {
      ok: false,
      code: 'stale-control',
    });
    assert.equal((await lab.transport().exchange({ afterSequence: 2, operations: [first] })).ok, true);
  });
});

test('enrollment signatures, reader restriction, device revocation and recovery descriptor binding', async (t) => {
  const lab = await createSyncLab();
  t.after(() => lab.close());
  await lab.transport().publishControl(lab.initial.publication);
  const keys = await generateDeviceKeys();
  const deviceId = randomUUID();
  const secret = randomBytes(32);
  const e = {
    ...lab.scope,
    requestId: randomUUID(),
    newDeviceId: deviceId,
    ...keys,
    requestedRole: 'reader' as const,
    issuerOwnerFingerprint: fingerprint(lab.ownerKey),
    baseControlHash: lab.initial.accepted.commitment,
    nonce: randomBytes(32).toString('hex'),
    expiresAtUnix: Math.floor(Date.now() / 1000) + 200,
  };
  const body = enrollmentBody(e);
  const challenge = challengeEnrollment(e, secret);
  const proof = proveEnrollment(body, challenge, keys.signingKey, keys.wrappingKey);
  const cert = {
    ...lab.scope,
    deviceId,
    ...keys,
    role: 'reader' as const,
    enrollmentHash: enrollmentHash(body, challenge),
    ownerFingerprint: fingerprint(lab.ownerKey),
    firstGeneration: 2,
  };
  const added = makePublication(
    lab.scope,
    lab.ownerKey,
    lab.keys.signingKey,
    lab.epochKey,
    [lab.certificate, cert],
    lab.initial.accepted,
    [proof.toString('base64url')],
  );
  assert.equal((await lab.transport().publishControl(added.publication)).ok, true);
  const reader = createSyncTransport({
    endpoint: { url: lab.url, scope: lab.scope },
    readToken: async () => Buffer.from(lab.token),
    signRequest: async (bytes) => ({ deviceId, signature: sign(null, bytes, keys.signingKey) }),
  });
  assert.equal((await reader.exchange({ afterSequence: 0, operations: [] })).ok, true);
  assert.deepEqual(
    await reader.exchange({ afterSequence: 0, operations: [lab.operation([], added.accepted)] }),
    { ok: false, code: 'forbidden' },
  );
  const removed = makePublication(
    lab.scope,
    lab.ownerKey,
    lab.keys.signingKey,
    lab.epochKey,
    [lab.certificate],
    added.accepted,
  );
  assert.equal((await lab.transport().publishControl(removed.publication)).ok, true);
  assert.deepEqual(await reader.wraps(1), { ok: false, code: 'forbidden' });
  assert.deepEqual(await reader.exchange({ afterSequence: 0, operations: [] }), {
    ok: false,
    code: 'forbidden',
  });
  const recoveryId = randomUUID();
  const recovery = sealRecovery(
    {
      ...lab.scope,
      recoveryId,
      controlHash: removed.accepted.commitment,
      ...freshEntropy(),
      plaintextLength: 3,
    },
    randomBytes(32),
    Buffer.from('kit'),
  );
  const descriptor = recoveryDescriptor({
    ...lab.scope,
    recoveryId,
    recoveryEnvelopeHash: createHash('sha256').update(recovery).digest('hex'),
  });
  const roster = rosterBytes([sealCertificate(lab.certificate, lab.ownerKey)]);
  const c = {
    ...removed.accepted.control,
    generation: 4,
    previousHash: removed.accepted.commitment,
    rosterDigest: rosterCommitment(roster),
    recoveryDescriptorDigest: recoveryDescriptorDigest(descriptor),
  };
  const wire = sealControl(c, lab.ownerKey, lab.ownerKey);
  const accepted = acceptControl(wire, roster, lab.scope, lab.ownerKey, removed.accepted);
  // Rewrap to the descriptor publication's exact commitment.
  const { wrapEpoch } = await import('../../packages/adapters/src/sync-crypto.ts');
  const bound = wrapEpoch(
    {
      ...lab.scope,
      epoch: c.activeEpoch,
      recipientDeviceId: lab.deviceId,
      recipientFingerprint: fingerprint(lab.keys.wrappingKey),
      issuerDeviceId: lab.deviceId,
      issuerFingerprint: fingerprint(lab.keys.signingKey),
      controlHash: accepted.commitment,
    },
    lab.epochKey,
    lab.keys.wrappingKey,
    lab.keys.signingKey,
  );
  const publication = {
    controlWire: wire.toString('base64url'),
    rosterWire: roster.toString('base64url'),
    wraps: [bound.toString('base64url')],
    recoveryDescriptorWire: descriptor.toString('base64url'),
    recoveryWire: recovery.toString('base64url'),
    enrollmentProofs: [],
  };
  assert.equal(
    (
      await lab
        .transport()
        .publishControl({ ...publication, recoveryWire: randomBytes(recovery.length).toString('base64url') })
    ).ok,
    false,
  );
  assert.equal((await lab.transport().publishControl(publication)).ok, true);
  const kit = await lab.transport().recovery();
  assert.ok(kit.ok);
  assert.deepEqual(kit.value.publication?.wraps, []);
  assert.equal(kit.value.publication?.recoveryWire, publication.recoveryWire);
  const recoveryOwner = generateSigningKey();
  const recoveryKeys = await generateDeviceKeys();
  const recoveryDeviceId = randomUUID();
  const recoveryCert = {
    ...lab.scope,
    ...recoveryKeys,
    deviceId: recoveryDeviceId,
    role: 'owner' as const,
    enrollmentHash: createHash('sha256').update(recovery).digest('hex'),
    ownerFingerprint: fingerprint(recoveryOwner),
    firstGeneration: 5,
  };
  const unknownKit = makePublication(
    lab.scope,
    recoveryOwner,
    recoveryKeys.signingKey,
    lab.epochKey,
    [{ ...recoveryCert, enrollmentHash: 'a'.repeat(64) }],
    accepted,
    [],
    lab.ownerKey,
  );
  assert.deepEqual(await lab.transport().publishControl(unknownKit.publication), {
    ok: false,
    code: 'invalid',
  });
  const recovered = makePublication(
    lab.scope,
    recoveryOwner,
    recoveryKeys.signingKey,
    lab.epochKey,
    [recoveryCert],
    accepted,
    [],
    lab.ownerKey,
  );
  assert.equal((await lab.transport().publishControl(recovered.publication)).ok, true);
  assert.deepEqual(await lab.transport().exchange({ afterSequence: 0, operations: [] }), {
    ok: false,
    code: 'forbidden',
  });
  const freshOwner = createSyncTransport({
    endpoint: { url: lab.url, scope: lab.scope },
    readToken: async () => Buffer.from(lab.token),
    signRequest: async (bytes) => ({
      deviceId: recoveryDeviceId,
      signature: sign(null, bytes, recoveryKeys.signingKey),
    }),
  });
  assert.equal((await freshOwner.wraps(recovered.accepted.control.activeEpoch)).ok, true);
});

test('server finite challenge/rate budgets and strict transport endpoints', async (t) => {
  const lab = await createSyncLab({ requestLimit: 8, nonceLimit: 1 });
  t.after(() => lab.close());
  assert.equal((await fetch(`${lab.url}/v1/challenge`, { headers: lab.headers() })).status, 200);
  assert.equal((await fetch(`${lab.url}/v1/challenge`, { headers: lab.headers() })).status, 429);
  for (let n = 0; n < 10; n++) await fetch(`${lab.url}/v1/info`);
  assert.equal((await fetch(`${lab.url}/v1/info`)).status, 429);
  for (const url of [
    'http://example.com',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://localhost:1234',
    'https://example.com/x',
    'https://user:pass@example.com',
    'https://example.com?x=1',
    'https://example.com#x',
  ])
    assert.equal(validSyncEndpoint({ url, scope: lab.scope }), false);
  assert.equal(validSyncEndpoint({ url: 'http://127.0.0.1:8787', scope: lab.scope }), true);
  assert.equal(syncBytes('AB', 2), false);
  assert.equal(syncBytes('AA', 1, 1), true);
});

test('provisioning stores no bearer secret and refuses database/scope replacement', async (t) => {
  const lab = await createSyncLab();
  t.after(() => lab.close());
  const configFile = join(lab.directory, 'provisioned', 'server.json');
  const { config, token } = await provision(configFile);
  assert.equal((await readFile(configFile, 'utf8')).includes(token), false);
  assert.equal((await stat(configFile)).mode & 0o777, 0o600);
  assert.deepEqual(loadConfig(configFile), config);
  await assert.rejects(provision(configFile));
  assert.throws(() => new SyncServer({ ...lab.config, accountId: randomUUID() }), /Foreign/);
});

test('transport rejects redirects, oversized streams, malformed results, respects cancellation', async (t) => {
  const lab = await createSyncLab();
  t.after(() => lab.close());
  const base = {
    endpoint: { url: lab.url, scope: lab.scope },
    readToken: async () => Buffer.from(lab.token),
    signRequest: async (bytes: Uint8Array) => ({
      deviceId: lab.deviceId,
      signature: sign(null, bytes, lab.keys.signingKey),
    }),
  };
  const redirect = createSyncTransport({
    ...base,
    fetch: async () => new Response(null, { status: 302, headers: { location: 'https://external.invalid' } }),
  });
  assert.deepEqual(await redirect.info(), { ok: false, code: 'unavailable' });
  const large = createSyncTransport({
    ...base,
    fetch: async () =>
      new Response('', {
        headers: { 'content-type': 'application/json', 'content-length': String(13 * 1024 * 1024) },
      }),
  });
  assert.deepEqual(await large.info(), { ok: false, code: 'too-large' });
  const malformed = createSyncTransport({
    ...base,
    fetch: async () =>
      new Response('{"ok":true,"ok":false,"code":"invalid"}', {
        headers: { 'content-type': 'application/json' },
      }),
  });
  assert.deepEqual(await malformed.info(), { ok: false, code: 'invalid' });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await lab.transport().info(controller.signal), { ok: false, code: 'cancelled' });
});

test('nonce expiry, raw-body signature binding, restart invalidation and upload ceiling', async (t) => {
  let now = Date.now();
  const lab = await createSyncLab({ now: () => now });
  t.after(() => lab.close());
  await lab.transport().publishControl(lab.initial.publication);
  async function signedHeaders(body: string) {
    const result = (await (await fetch(`${lab.url}/v1/challenge`, { headers: lab.headers() })).json()) as {
      value: { nonce: string };
    };
    return {
      ...lab.headers(),
      'Content-Type': 'application/json',
      'X-SSTerm-Device': lab.deviceId,
      'X-SSTerm-Nonce': result.value.nonce,
      'X-SSTerm-Signature': sign(
        null,
        syncRequestTranscript('POST', '/v1/exchange', lab.scope, result.value.nonce, Buffer.from(body)),
        lab.keys.signingKey,
      ).toString('base64url'),
    };
  }
  const body = '{"afterSequence":0,"operations":[]}';
  const expired = await signedHeaders(body);
  now += 61000;
  assert.equal(
    (await fetch(`${lab.url}/v1/exchange`, { method: 'POST', headers: expired, body })).status,
    401,
  );
  const altered = await signedHeaders(body);
  assert.equal(
    (
      await fetch(`${lab.url}/v1/exchange`, {
        method: 'POST',
        headers: altered,
        body: '{"afterSequence":1,"operations":[]}',
      })
    ).status,
    401,
  );
  const restart = await signedHeaders(body);
  await lab.restart();
  assert.equal(
    (await fetch(`${lab.url}/v1/exchange`, { method: 'POST', headers: restart, body })).status,
    401,
  );
  const large = await fetch(`${lab.url}/v1/controls`, {
    method: 'POST',
    headers: { ...lab.headers(), 'Content-Type': 'application/json' },
    body: ' '.repeat(12 * 1024 * 1024 + 1),
  });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), { ok: false, code: 'too-large' });
  assert.deepEqual(await lab.transport().publishControl({ ...lab.initial.publication, wraps: [] }), {
    ok: false,
    code: 'conflict',
  });
});

test('exchange pagination remains ordered and bounded without empty hasMore pages', async (t) => {
  const lab = await createSyncLab();
  t.after(() => lab.close());
  await lab.transport().publishControl(lab.initial.publication);
  const operations = Array.from({ length: 10 }, () => lab.operation());
  assert.equal(
    (await lab.transport().exchange({ afterSequence: 0, operations: operations.slice(0, 8) })).ok,
    true,
  );
  const result = await lab.transport().exchange({ afterSequence: 0, operations: operations.slice(8) });
  assert.ok(result.ok);
  assert.equal(result.value.operations.length, 8);
  assert.equal(result.value.hasMore, true);
  assert.equal(result.value.nextSequence, 8);
  const tail = await lab.transport().exchange({ afterSequence: 8, operations: [] });
  assert.ok(tail.ok);
  assert.deepEqual(
    tail.value.operations.map((p) => p.sequence),
    [9, 10],
  );
  assert.equal(tail.value.hasMore, false);
});

test('foreign databases and symlink targets remain untouched on refusal', async (t) => {
  const lab = await createSyncLab();
  t.after(() => lab.close());
  const foreign = join(lab.directory, 'foreign.sqlite');
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserve')");
  db.close();
  await chmod(foreign, 0o640);
  const before = await readFile(foreign);
  assert.throws(() => new SyncServer({ ...lab.config, databasePath: foreign }), /Unsupported/);
  assert.deepEqual(await readFile(foreign), before);
  assert.equal((await stat(foreign)).mode & 0o777, 0o640);
  const linked = join(lab.directory, 'linked.sqlite');
  await symlink(foreign, linked);
  assert.throws(() => new SyncServer({ ...lab.config, databasePath: linked }), /Invalid/);
  assert.deepEqual(await readFile(foreign), before);
});

test('empty-vault bootstrap is token-authorized and independently pinned clients reject a squatter', async (t) => {
  const lab = await createSyncLab();
  t.after(() => lab.close());
  const intendedBytes = JSON.stringify(lab.initial.publication);
  const intendedFingerprint = fingerprint(lab.ownerKey);
  const rogueOwner = generateSigningKey();
  const rogueKeys = await generateDeviceKeys();
  const rogueCert = {
    ...lab.scope,
    ...rogueKeys,
    deviceId: randomUUID(),
    role: 'owner' as const,
    enrollmentHash: '0'.repeat(64),
    ownerFingerprint: fingerprint(rogueOwner),
    firstGeneration: 1,
  };
  const rogue = makePublication(lab.scope, rogueOwner, rogueKeys.signingKey, randomBytes(32), [rogueCert]);
  assert.equal((await lab.transport().publishControl(rogue.publication)).ok, true);
  assert.deepEqual(await lab.transport().publishControl(lab.initial.publication), {
    ok: false,
    code: 'conflict',
  });
  const discovery = await lab.transport().controls(0);
  assert.ok(discovery.ok);
  assert.throws(() =>
    acceptControl(
      Buffer.from(discovery.value.controls[0].controlWire, 'base64url'),
      Buffer.from(discovery.value.controls[0].rosterWire, 'base64url'),
      lab.scope,
      lab.ownerKey,
    ),
  );
  assert.equal(JSON.stringify(lab.initial.publication), intendedBytes);
  assert.equal(fingerprint(lab.ownerKey), intendedFingerprint);
  assert.equal(discovery.value.controls[0].controlWire, rogue.publication.controlWire);
});

test('four active body uploads bound memory and release admission after cancelled clients', async (t) => {
  const { request } = await import('node:http');
  const lab = await createSyncLab();
  const pending: ReturnType<typeof request>[] = [];
  t.after(async () => {
    for (const req of pending) req.destroy();
    await lab.close();
  });
  let seen = 0;
  let ready!: () => void;
  const arrived = new Promise<void>((resolve) => {
    ready = resolve;
  });
  lab.server.server.on('request', (req) => {
    if (req.headers['x-owned-hold'] === 'yes' && ++seen === 4) ready();
  });
  for (let n = 0; n < 4; n++) {
    const req = request(`${lab.url}/v1/controls`, {
      method: 'POST',
      headers: {
        ...lab.headers(),
        'Content-Type': 'application/json',
        'Content-Length': '1048576',
        'X-Owned-Hold': 'yes',
      },
    });
    req.on('error', () => {});
    req.write('{');
    pending.push(req);
  }
  await arrived;
  const busy = await fetch(`${lab.url}/v1/controls`, {
    method: 'POST',
    headers: { ...lab.headers(), 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(busy.status, 429);
  assert.deepEqual(await busy.json(), { ok: false, code: 'rate-limited' });
  for (const req of pending) req.destroy();
  let status = 429;
  for (let n = 0; n < 20 && status === 429; n++)
    status = (await fetch(`${lab.url}/v1/challenge`, { headers: lab.headers() })).status;
  assert.equal(status, 200);
});
