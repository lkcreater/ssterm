'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const { promisify } = require('node:util');
const runFile = promisify(require('node:child_process').execFile);
const { waitForExit } = require('./process.cjs');

async function cleanupRun(runId) {
  let failed = false;
  // Remove only credential directories belonging to this particular invocation.
  for (const name of await fs.readdir(os.tmpdir())) {
    if (name.startsWith(`ssterm-ssh-spike-${runId}-`)) {
      try { await fs.rm(path.join(os.tmpdir(), name), { recursive: true, force: true }); }
      catch { failed = true; }
    }
  }
  try {
    const { stdout } = await runFile('docker', ['ps', '-aq', '--filter',
      'label=dev.ssterm.spike.fixture=true', '--filter', `label=dev.ssterm.spike.run-id=${runId}`],
    { timeout: 10_000, maxBuffer: 16 * 1024 });
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (!ids.every((id) => /^[a-f0-9]{12,64}$/.test(id))) throw new Error('INVALID_OWNED_CONTAINER_ID');
    if (ids.length) await runFile('docker', ['rm', '--force', ...ids], { timeout: 10_000 });
  } catch { failed = true; }
  if (failed) throw new Error('PACKAGED_CLEANUP_FAILED');
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('MACOS_ARM64_REQUIRED');
  const root = path.resolve(__dirname, '..');
  const artifacts = path.join(root, 'artifacts');
  const packaged = JSON.parse(await fs.readFile(path.join(artifacts, 'package-path.json'), 'utf8'));
  const allowed = path.join(artifacts, 'package');
  if (!path.resolve(packaged.path).startsWith(`${allowed}${path.sep}`)) throw new Error('UNEXPECTED_PACKAGE_PATH');
  const binary = path.join(packaged.path, 'SSTermSSHSpike.app', 'Contents', 'MacOS', 'SSTermSSHSpike');
  const reportFile = path.join(artifacts, 'packaged-report.json');
  await fs.rm(reportFile, { force: true });
  const runId = crypto.randomUUID();
  const env = { ...process.env, SSTERM_SPIKE_REPORT_DIR: artifacts, SSTERM_SPIKE_RUN_ID: runId };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const child = spawn(binary, [], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    // Chromium/platform diagnostics can include arbitrary paths. Keep only exit status/report.
    child.stderr.resume();
    const result = await waitForExit(child);
    if (result.timedOut) throw new Error('PACKAGED_PROBES_TIMED_OUT');
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    assert.equal(result.code, 0);
    assert.equal(report.runtime, 'electron-packaged');
    assert.equal(report.versions.electron, '44.7.2');
    assert.equal(report.arch, 'arm64');
    assert.ok(report.cases.length >= 19 && report.cases.every((entry) => entry.status === 'passed'));
    console.log(`Packaged Electron ${report.versions.electron} arm64: ${report.cases.length} real fixture probes passed`);
  } finally { await cleanupRun(runId); }
}
main().catch(() => { console.error('PACKAGED_PROBES_FAILED; inspect sanitized artifacts/packaged-report.json'); process.exitCode = 1; });
