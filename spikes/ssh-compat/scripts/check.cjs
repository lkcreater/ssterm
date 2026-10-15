'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const directory of ['src', 'test', 'electron', 'scripts']) {
  for (const file of fs.readdirSync(path.join(root, directory))) {
    if (file.endsWith('.cjs')) execFileSync(process.execPath, ['--check', path.join(root, directory, file)], { stdio: 'inherit' });
  }
}
console.log('CommonJS syntax checks passed');
