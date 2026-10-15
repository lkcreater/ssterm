'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { startFixture } = require('../src/fixture.cjs');

test('fixture startup erases generated keys when Docker cannot run', { timeout: 15_000 }, async () => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ssterm-cleanup-test-'));
  await fs.symlink('/usr/bin/ssh-keygen', path.join(bin, 'ssh-keygen'));
  const runId = crypto.randomUUID();
  const previousPath = process.env.PATH;
  const previousId = process.env.SSTERM_SPIKE_RUN_ID;
  const ownedNames = async () => (await fs.readdir(os.tmpdir()))
    .filter((name) => name.startsWith(`ssterm-ssh-spike-${runId}-`));
  try {
    process.env.PATH = bin; // ssh-keygen exists; Docker deliberately does not.
    process.env.SSTERM_SPIKE_RUN_ID = runId;
    await assert.rejects(startFixture(), { message: 'FIXTURE_DOCKER_STATUS_UNAVAILABLE' });
    assert.deepEqual(await ownedNames(), []);
  } finally {
    process.env.PATH = previousPath;
    if (previousId === undefined) delete process.env.SSTERM_SPIKE_RUN_ID;
    else process.env.SSTERM_SPIKE_RUN_ID = previousId;
    for (const name of await ownedNames()) await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true });
    await fs.rm(bin, { recursive: true, force: true });
  }
});
