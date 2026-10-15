'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('MACOS_ARM64_REQUIRED');
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'artifacts', 'package');
  await fs.mkdir(output, { recursive: true });
  // Use the exact installed Electron binary so packaging never silently chooses another release.
  const electronBinary = require('electron');
  const electronZipDir = path.join(root, 'artifacts', 'electron-zip');
  await fs.mkdir(electronZipDir, { recursive: true });
  const executableRoot = path.resolve(electronBinary, '..', '..', '..');
  const archive = path.join(electronZipDir, 'electron-v44.7.2-darwin-arm64.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', executableRoot, archive], { timeout: 60_000 });
  const module = await import('@electron/packager');
  const packager = module.packager || module.default;
  const outputs = await packager({
    dir: root, out: output, name: 'SSTermSSHSpike', appBundleId: 'dev.ssterm.spike',
    appVersion: '0.0.0', electronVersion: '44.7.2', electronZipDir,
    platform: 'darwin', arch: 'arm64', overwrite: true, prune: true, asar: false,
    ignore: [/^\/artifacts(?:\/|$)/, /^\/test(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/README\.md$/]
  });
  await fs.writeFile(path.join(root, 'artifacts', 'package-path.json'), `${JSON.stringify({ path: outputs[0], app: 'SSTermSSHSpike.app', signed: false }, null, 2)}\n`);
  console.log('Unsigned macOS arm64 SSH spike packaged in artifacts/package');
}
main().catch(() => { console.error('SPIKE_PACKAGE_FAILED'); process.exitCode = 1; });
