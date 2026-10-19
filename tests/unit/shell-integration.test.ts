/**
 * The declared SST-034 shell matrix, run in real shells: owned temporary homes, no user startup files, no network.
 * bash 5.2 runs in the owned fixture image (no network) when Docker is available; Homebrew bash 5 when installed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHELL_INTEGRATION } from '../../packages/domain/src/recording.ts';
import { CommandScanner } from '../../packages/services/src/command-scanner.ts';

const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const MARK = /\x1b\](133;[ABCD](?:;\d+)?|633;E;[^\x07]*)\x07/gu;
const docker = ['/opt/homebrew/bin/docker', '/usr/local/bin/docker'].find((path) => existsSync(path));
const imagePresent = (() => {
  if (!docker) return false;
  try { execFileSync(docker, ['image', 'inspect', 'ssterm-ssh-fixture:m0'], { stdio: 'ignore', timeout: 20_000 }); return true; } catch { return false; }
})();
const brewBash = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash'].find((path) => existsSync(path));

interface Session { output(): string; send(line: string): Promise<void>; close(): Promise<void> }
/** Starts a shell and resolves at its first prompt; `prompts` counts OSC 133;B marks (or `ready` text). */
async function shell(file: string, args: string[], env: Record<string, string>, ready: (text: string) => boolean): Promise<Session> {
  const child = pty.spawn(file, args, { name: 'xterm-256color', cols: 200, rows: 40, env, cwd: env.HOME });
  let text = '';
  child.onData((data) => { text += data; });
  const until = async (condition: () => boolean, what: string) => {
    const deadline = Date.now() + 20_000;
    while (!condition()) { if (Date.now() > deadline) assert.fail(`${what}; output: ${JSON.stringify(text.slice(-600))}`); await delay(20); }
  };
  await until(() => ready(text), 'shell did not reach a prompt');
  return {
    output: () => text,
    async send(line) {
      const before = (text.match(/\x1b\]133;B\x07/gu) ?? []).length;
      const marker = `\x1b]133;B\x07`;
      child.write(`${line}\r`);
      if (before === 0) { await delay(400); return; }
      await until(() => (text.split(marker).length - 1) > before, `no prompt after ${JSON.stringify(line)}`);
    },
    async close() {
      const exited = new Promise<void>((done) => { child.onExit(() => done()); });
      try { child.kill(); } catch { /* already gone */ }
      await Promise.race([exited, delay(3_000)]);
    },
  };
}
/** The shell may still be writing its history file as it exits. */
const remove = (directory: string) => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const marks = (text: string) => [...text.matchAll(MARK)].map((match) => match[1]!.replace(/^133;/u, '').replace(/^633;E;.*/su, 'E'));
const commands = (text: string) => [...new CommandScanner().feed(Buffer.from(text, 'utf8'))];
const lines = ['echo one', ' echo hidden', "printf 'a;b\\n'", 'echo สวัสดี', 'false', 'export TOKEN=x', 'for i in 1 2; do\recho $i\rdone'];
const recorded = ['echo one', "printf 'a;b\\n'", 'echo สวัสดี', 'false'];

/** Every command yields exactly A, B, (E), C, D;<status> in order, with the user's own hooks still running. */
function assertCycles(text: string, hasE: boolean[]) {
  const all = marks(text);
  // Prompt 0 has no D; afterwards each command's cycle is [E] C D A B.
  assert.deepEqual(all.slice(0, 2), ['A', 'B'], JSON.stringify(all));
  let at = 2;
  for (const e of hasE) {
    const cycle = all.slice(at, at + (e ? 5 : 4));
    assert.deepEqual(cycle.map((mark) => mark.replace(/^D;\d+$/u, 'D')), [...(e ? ['E'] : []), 'C', 'D', 'A', 'B'], JSON.stringify(all));
    at += cycle.length;
  }
}

function home(rc: string, name: string) {
  const directory = mkdtempSync(join(tmpdir(), 'ssterm-shell-'));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, name), rc, { mode: 0o600 });
  return directory;
}
const env = (directory: string, extra: Record<string, string> = {}) => ({ PATH: '/usr/bin:/bin', HOME: directory, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...extra });

// A pre-existing PROMPT_COMMAND (with a trailing ";") that counts prompts, and a theme that rebuilds PS1 each prompt.
const bashUser = `__user_count=0\nPROMPT_COMMAND='__s=$?; __user_count=$((__user_count+1)); PS1="theme[$__s]\\$ ";'\n`;
async function bashMatrix(start: (rc: string) => Promise<{ session: Session; cleanup(): Promise<void> }>) {
  const { session, cleanup } = await start(`${bashUser}${SHELL_INTEGRATION.bash}\n`);
  try {
    for (const line of lines) await session.send(line);
    await session.send('set +o history');
    await session.send('echo off-record');
    await session.send('echo "COUNT=$__user_count"');
    const text = session.output();
    // bash's cmdhist saves the loop as one line, which is then recordable; lines it does not save are never reported.
    assert.deepEqual(commands(text), [...recorded, 'for i in 1 2; do echo $i; done', 'set +o history']);
    assertCycles(text, [true, false, true, true, true, true, true, true, false, false]);
    assert.match(text, /D;1\x07/u, 'the status of false is reported');
    assert.match(text, /theme\[1\]\$ /u, 'the user prompt hook still sees the command status');
    assert.match(text, /COUNT=1[01]\b/u, 'the user PROMPT_COMMAND ran on every prompt');
  } finally { await cleanup(); }
}

test('bash 3.2 (macOS /bin/bash) is unsupported: the snippet does nothing', async () => {
  const directory = home(`${SHELL_INTEGRATION.bash}\nPS1='plain$ '\n`, '.bashrc');
  const session = await shell('/bin/bash', ['--noprofile', '--rcfile', join(directory, '.bashrc'), '-i'], env(directory), (text) => text.includes('plain$ '));
  try {
    await session.send('echo probe-$((1+1))');
    await delay(300);
    assert.match(session.output(), /probe-2/u);
    assert.doesNotMatch(session.output(), /\x1b\](?:133|633);/u);
  } finally { await session.close(); remove(directory); }
});

test('bash 5.2 in the owned fixture image reports each saved command line once', { skip: !imagePresent && 'Docker or ssterm-ssh-fixture:m0 unavailable' }, async () => {
  await bashMatrix(async (rc) => {
    const directory = home(rc, 'rc');
    const name = `ssterm-shell-${randomUUID()}`;
    const session = await shell(docker!, ['run', '--rm', '-it', '--name', name, '--network', 'none', '-e', 'LANG=C.UTF-8', '-v', `${directory}:/probe:ro`,
      '--entrypoint', '/bin/bash', 'ssterm-ssh-fixture:m0', '--noprofile', '--rcfile', '/probe/rc', '-i'],
    { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? directory, TERM: 'xterm-256color' }, (text) => text.includes('\x1b]133;B\x07'));
    return { session, async cleanup() {
      await session.close();
      try { execFileSync(docker!, ['rm', '--force', name], { stdio: 'ignore', timeout: 20_000 }); } catch { /* --rm already removed it */ }
      remove(directory);
    } };
  });
});

test('Homebrew bash 5 reports each saved command line once', { skip: !brewBash && 'Homebrew bash 5 is not installed (unrun)' }, async () => {
  await bashMatrix(async (rc) => {
    const directory = home(rc, '.bashrc');
    const session = await shell(brewBash!, ['--noprofile', '--rcfile', join(directory, '.bashrc'), '-i'], env(directory), (text) => text.includes('\x1b]133;B\x07'));
    return { session, async cleanup() { await session.close(); remove(directory); } };
  });
});

test('zsh 5.9 (macOS /bin/zsh) reports each command line once, after an existing precmd and a theme', async () => {
  const user = `typeset -g __user_count=0\nprecmd() { __user_count=$((__user_count+1)) }\ntheme_precmd() { PS1="theme[%?]%# " }\nprecmd_functions+=(theme_precmd)\n`;
  const directory = home(`${user}${SHELL_INTEGRATION.zsh}\n`, '.zshrc');
  const session = await shell('/bin/zsh', ['-i'], env(directory), (text) => text.includes('\x1b]133;B\x07'));
  try {
    for (const line of lines) await session.send(line);
    await session.send('echo "COUNT=$__user_count"');
    const text = session.output();
    assert.deepEqual(commands(text), [...recorded, 'echo "COUNT=$__user_count"']);
    assertCycles(text, [true, false, true, true, true, true, true, true]);
    assert.match(text, /D;1\x07/u);
    assert.match(text, /theme\[1\]% /u, 'the theme still sees the command status');
    assert.match(text, /COUNT=\d+/u);
  } finally { await session.close(); remove(directory); }
});
