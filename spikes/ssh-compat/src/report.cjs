'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function createReport(runtime) {
  return {
    ticket: 'SST-002', runtime, observedAt: new Date().toISOString(),
    versions: { node: process.versions.node, electron: process.versions.electron || null, ssh2: require('ssh2/package.json').version },
    platform: process.platform, arch: process.arch,
    optionalNativeBindingLoaded: require('ssh2/lib/protocol/crypto.js').bindingAvailable,
    algorithms: null, cases: [],
    limitations: [
      'One project-owned Debian OpenSSH/PAM server with an Ed25519 host key; not an exhaustive server/key/algorithm compatibility matrix.',
      'Pure JavaScript ssh2 path: optional cpu-features and sshcrypto native accelerators are omitted; no native SSH binding/ABI acceptance.',
      'Backend PTY bytes only; no xterm rendering, Thai IME, production IPC/UI, Keychain/storage or signing/notarization acceptance.',
      'Unsigned local arm64 package is a feasibility artifact, not a production release.'
    ]
  };
}
function safeCode(error) {
  if (error?.name === 'SpikeError' && /^[a-z-]{1,48}$/.test(error.code)) return error.code;
  if (/^FIXTURE_[A-Z_]+$/.test(error?.message || '')) return error.message.toLowerCase().replaceAll('_', '-');
  return 'probe-failed';
}
async function writeReport(report, filename) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
module.exports = { createReport, safeCode, writeReport };
