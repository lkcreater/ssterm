// Project-owned processes only. No shell startup files, host credentials or user history.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const mode = process.argv[2];
if (process.stdin.isTTY) process.stdin.setRawMode(true);
execFileSync('/bin/stty', ['-opost'], { stdio: ['inherit', 'ignore', 'ignore'] });
if (mode === 'bytes') {
  process.stdout.write(Buffer.concat([Buffer.from('ไทย😀'), Buffer.from([0, 255, 128, 13, 10])]), () => process.exit(7));
} else if (mode === 'flood') {
  process.stdout.write(Buffer.alloc(655360, 0x61), () => process.exit(0));
} else if (mode === 'echo') {
  process.stdout.write('READY;');
  process.stdin.on('data', (bytes) => process.stdout.write(bytes));
  process.stdin.resume();
} else if (mode === 'size') {
  const size = () => process.stdout.write(`SIZE:${process.stdout.columns}:${process.stdout.rows};`);
  size();
  process.on('SIGWINCH', size);
  process.stdin.resume();
} else if (mode === 'children') {
  process.on('SIGTERM', () => {});
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'trap "" TERM; sleep 1000'], { stdio: 'ignore' });
  fs.writeFileSync(process.argv[3], JSON.stringify({ root: process.pid, child: child.pid }));
  process.stdout.write('CHILDREN;');
  process.stdin.resume();
}
