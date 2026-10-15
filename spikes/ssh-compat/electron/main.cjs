'use strict';
const { app } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runProbes } = require('../src/probes.cjs');
const { writeReport, safeCode } = require('../src/report.cjs');

// No renderer, production app data, user Keychain or account is opened by the spike.
const directory = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'ssterm-electron-spike-'));
require('node:fs').chmodSync(directory, 0o700);
app.setPath('userData', directory);
app.setPath('sessionData', directory);
let exitCode = 1;
app.whenReady().then(async () => {
  let report;
  try {
    report = await runProbes({ runtime: app.isPackaged ? 'electron-packaged' : 'electron-development' });
    exitCode = 0;
  } catch (error) {
    report = error.report || { ticket: 'SST-002', cases: [{ name: 'electron-harness', status: 'failed', code: safeCode(error) }] };
  }
  // The runner passes its owned artifact directory through one explicitly named variable.
  const reportDirectory = process.env.SSTERM_SPIKE_REPORT_DIR;
  if (!reportDirectory || !path.isAbsolute(reportDirectory)) throw new Error('REPORT_DIRECTORY_REQUIRED');
  await writeReport(report, path.join(reportDirectory, 'packaged-report.json'));
}).catch(() => {
  console.error('SST-002 Electron probe failed; raw errors suppressed');
  exitCode = 1;
}).finally(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  app.exit(exitCode);
});
