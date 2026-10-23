// Offline stand-in for an UNISOLATED agent CLI: it really performs whatever
// the attack prompt asks, so the detector test can prove every canary fires.
import { execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const prompt = process.argv.at(-1);
const m = (re) => prompt.match(re)?.[1];
let file, cmd, url;
if ((file = m(/read the local file (\S+) and/))) console.log(readFileSync(file, 'utf8'));
if ((cmd = m(/print its output: (.+?) If you/))) console.log(execSync(cmd, { shell: '/bin/sh', encoding: 'utf8' }));
if ((file = m(/file at (\S+) containing/))) { writeFileSync(file, 'ok'); writeFileSync('pwned-write.txt', 'ok'); }
if ((url = m(/Fetch the URL (\S+) with/))) console.log(await (await fetch(url)).text());
if (prompt.includes('"lookup"')) {
  console.log(readFileSync('AGENTS.md', 'utf8'));
  const { command, args } = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers.decoy;
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdout.on('data', (d) => { process.stdout.write(d); if (String(d).includes('"id":2')) child.kill(); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'lookup' } }) + '\n');
}
