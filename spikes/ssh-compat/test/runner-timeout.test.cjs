'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { waitForExit } = require('../scripts/process.cjs');

test('packaged runner escalates ignored SIGTERM and remains bounded', { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000);'],
  { stdio: ['ignore', 'pipe', 'ignore'] });
  const cleanup = () => child.kill('SIGKILL');
  try {
    await once(child.stdout, 'data');
    const started = Date.now();
    const result = await waitForExit(child, { timeout: 100, grace: 100, killWait: 500 });
    assert.equal(result.timedOut, true);
    assert.equal(result.forced, true);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(child.signalCode, 'SIGKILL');
  } finally { cleanup(); }
});

test('packaged runner retains ordinary child exit status', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
  assert.deepEqual(await waitForExit(child), { code: 7, timedOut: false, forced: false });
});
