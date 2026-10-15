'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { runProbes } = require('../src/probes.cjs');
const { writeReport } = require('../src/report.cjs');

const filename = path.join(__dirname, '..', 'artifacts', 'node-report.json');
test('SST-002 real project-owned SSH/SFTP/forwarding and lifecycle matrix', { timeout: 180_000 }, async (context) => {
  let report;
  try { report = await runProbes({ runtime: 'node' }); }
  catch (error) {
    if (error.report) {
      await writeReport(error.report, filename);
      for (const entry of error.report.cases) context.diagnostic(`${entry.name}: ${entry.status}${entry.code ? ` (${entry.code})` : ''}`);
    }
    // Never hand the runner a raw SSH/child-process error containing credentials.
    assert.fail('SST-002 mandatory probe failure; see sanitized artifacts/node-report.json');
  }
  await writeReport(report, filename);
  assert.ok(report.cases.length >= 19);
  assert.ok(report.cases.every((entry) => entry.status === 'passed'));
  assert.ok(report.algorithms?.hostKey);
  for (const entry of report.cases) context.diagnostic(`${entry.name}: passed`);
});
