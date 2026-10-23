import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyReadOnly, commandLine, probeLine, formatOutput, MarkerScanner, ScreenTracker, TerminalExecutor, MAX_AGENT_OUTPUT,
  TRUNCATION_NOTE, READ_ONLY_RULES, DOCKER_RULES, type ReadOnlyRule,
} from "../../packages/services/src/agent-terminal.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const NONCE = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";
const ready = (nonce = NONCE) => `\x1b]ssterm;ready;${nonce}\x07`;
const start = (nonce = NONCE) => `\x1b]ssterm;start;${nonce}\x07`;
const done = (code: number, nonce = NONCE) => `\x1b]ssterm;done;${nonce};${code}\x07`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Read only allows single allowlisted commands and options, and pipes into allowlisted filters", () => {
  for (const command of [
    "ls -la /var/log", "pwd", "cat /etc/os-release", "grep -rn 'error|warn' /var/log/syslog", "ps aux | grep sshd | wc -l",
    "df -h", "du -sh /home/fixture", "tail -n 50 /var/log/syslog", "ls *.log", "echo 'a;b && c > d'", 'echo "สวัสดี ไทย"',
    "systemctl status nginx --no-pager", "systemctl --no-pager -p ActiveState show nginx", "journalctl -u ssh --no-pager -n 20",
    "docker ps -a", "docker logs --tail 50 web", "find . -name '*.conf' -type f", "sort -n -k2 sizes.txt", "uniq -c counts.txt",
    "cd /var/log", "env", "hostname -f", "date -u", "date +%s", "date -u '+%F %T'", "false", "sleep 1", "cat /dev/null", "cat ///dev//null", "grep -c x /var/log/syslog /dev/null", "date '+%Y/%m/%d'",
    "cat /tmp/a | sort | uniq -c | sort -rn | head -5", "ss -tlnp", "ss -tn state established",
  ]) assert.deepEqual(classifyReadOnly(command), { readOnly: true }, command);
});

test("Read only refuses chaining, redirects, subshells, substitution, heredocs, option values posing as verbs, and writes", () => {
  const refused: [string, RegExp][] = [
    ["ls; rm -rf /", /chaining/u], ["ls && rm x", /background|chaining/u], ["ls || rm x", /\|\|/u], ["ls & rm x", /background/u],
    ["ls > out", /redirect/u], ["ls >> out", /redirect/u], ["cat < /etc/passwd", /redirect/u], ["cat <<EOF", /redirect|heredoc/u],
    ["cat <<< hi", /redirect/u], ["ls 2>&1", /redirect|background/u], ["(rm x)", /subshell/u], ["{ rm x; }", /group/u],
    ["echo $(rm x)", /substitution/u], ["echo `rm x`", /substitution/u], ['echo "$(rm x)"', /substitution/u],
    ['echo "`rm x`"', /substitution/u], ["echo $HOME", /variable/u], ["echo ${PATH}", /variable/u], ["cat <(rm x)", /redirect/u],
    ["ls | sh", /not on the Read only allowlist/u], ["ls | xargs rm", /not on the Read only allowlist/u], ["ls | tee out", /allowlist/u],
    ["ls | sed 'w out'", /allowlist/u], ["rm -rf /", /allowlist/u], ["FOO=bar ls", /environment assignments/u],
    ["PAGER='rm x' ls", /environment/u], ["/bin/rm x", /allowlist/u], ["./script.sh", /allowlist/u], ["'r'm x", /allowlist/u],
    ["ls\nrm x", /control|line/u], ["ls\rrm x", /control/u], ["ls\trm", /control/u], ["ls #; rm", /comment/u],
    ["!!", /history/u], ["echo !rm", /history/u], ["echo 'a!b'", /history/u], ["ls \\; rm x", /backslash/u],
    ["grep 'a\\|b' x", /backslash/u], ["echo 'unterminated", /unterminated/u],
    ["find . -delete", /-delete/u], ["find . -exec rm {} +", /group|-exec/u], ["find . -execdir rm x", /-execdir/u],
    ["find . -fprint out", /-fprint/u], ["find . '-del''ete'", /-delete/u], ["find . -name *", /glob/u], ["find . -name", /value/u],
    ["sort -o out in", /-o/u], ["sort -no out in", /-o/u], ["sort --output=out in", /--output/u], ["sort --out=x in", /--out/u],
    ["sort --compress-program=sh in", /--compress-program/u], ["sort -T /tmp x", /-T/u], ["uniq in out", /2 operands/u], ["uniq *", /glob/u],
    ["date -s 2020-01-01", /-s/u], ["date --set=now", /--set/u], ["date 0101000030", /date 0101000030/u], ["date 1200", /date 1200/u],
    ["hostname evil", /1 operands/u], ["hostname -F f", /-F/u], ["hostname -b x", /-b/u],
    ["env rm x", /2 operands/u], ["env -i sh", /-i/u], ["file -C x", /-C/u], ["file -m magic x", /-m/u],
    ["ss -tK", /-K/u], ["ss -D FILE", /-D/u], ["ss --diag=FILE", /--diag/u], ["ss -K dst 10.0.0.1", /-K/u],
    ["systemctl restart nginx --no-pager", /verb/u], ["systemctl status nginx", /--no-pager/u], ["systemctl --no-pager", /verb/u],
    ["systemctl --no-pager -p status poweroff", /verb/u], ["systemctl --no-pager -p status stop sshd", /verb/u],
    ["systemctl --no-pager --message status reboot", /--message/u], ["systemctl --no-pager --root status enable foo", /--root/u],
    ["systemctl --no-pager --root=/ status x", /--root/u], ["systemctl --no-pager -H host status", /-H/u],
    ["systemctl --no-pager -M box status", /-M/u], ["systemctl --no-pager --nop status x", /--nop/u],
    ["journalctl --vacuum-size=1M --no-pager", /--vacuum-size/u], ["journalctl -u ssh", /--no-pager/u],
    ["journalctl --cursor-file=/tmp/c --no-pager", /--cursor-file/u], ["journalctl --cursor-file /tmp/c --no-pager", /--cursor-file/u],
    ["journalctl --rotate --no-pager", /--rotate/u], ["journalctl --flush --no-pager", /--flush/u], ["journalctl -D /x --no-pager", /-D/u],
    ["docker rm x", /docker rm/u], ["docker run alpine", /docker run/u], ["docker -H tcp://x ps", /docker -H/u],
    ["docker -l info run --rm -v /:/h alpine touch /h/pwn", /docker -l/u], ["docker --config logs exec mycontainer rm -rf /data", /docker --config/u],
    ["docker -c ps rm -f web", /docker -c/u], ["docker ps --format x -H tcp://y", /-H/u], ["docker logs -f a b", /2 operands/u],
    ["docker exec web ls", /docker exec/u], ["docker", /docker/u],
    ["cat /dev/sda", /device/u], ["cat /dev/urandom", /device/u], ["head -c 10 /dev/zero", /device/u], ["grep -f /dev/stdin x", /device/u],
    ["cd /dev", /device/u], ["ls --ignore=/dev/x", /device/u], ["ps -o pid,cmd /dev", /device/u],
    ["cat //dev/sda", /device/u], ["cat ../dev/sda", /\.\./u], ["cat ../../dev/watchdog", /\.\./u], ["cat /proc/../dev/sda", /\.\./u],
    ["grep x //dev/sda", /device/u], ["tail -f //dev/zero", /device/u], ["cat dev/sda", /device/u], ["cat /d?v/sda", /device/u],
    ["cat /*/sda", /device/u], ["cat /[d]ev/sda", /device/u], ["ls /var/../etc", /\.\./u], ["cd ..", /\.\./u], ["cd dev", /device/u],
    ["cat /dev/null/../sda", /\.\./u], ["grep -f=../x y", /\.\./u],
    ["git log", /allowlist/u], ["vim x", /allowlist/u], ["less x", /allowlist/u], ["top", /allowlist/u], ["curl http://x", /allowlist/u],
    ["sudo ls", /allowlist/u], ["sleep forever", /sleep forever/u], ["vmstat -n 1", /-n/u],
    ["ls |", /empty pipeline/u], ["| ls", /empty pipeline/u], ["", /empty/u], ["   ", /empty/u], ["ls \u{202e}rm", /control/u],
    ["ls\u{85}rm", /control/u], ["x".repeat(4_097), /longer/u],
  ];
  for (const [command, reason] of refused) {
    const verdict = classifyReadOnly(command);
    assert.equal(verdict.readOnly, false, JSON.stringify(command));
    if (!verdict.readOnly) assert.match(verdict.reason, reason, JSON.stringify(command));
  }
});

test("property: for every allowlisted command, every option outside its allowlist is refused and every listed one is accepted", () => {
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const longs = ["output", "file", "exec", "root", "host", "config", "delete", "set", "kill", "diag", "cursor-file", "message", "x"];
  const check = (prefix: string, rule: ReadOnlyRule) => {
    // The smallest valid command line for this rule: its verb and required flag, no operands.
    const base = [prefix, rule.verbs?.split(" ")[0], rule.require].filter(Boolean).join(" ");
    assert.deepEqual(classifyReadOnly(base), { readOnly: true }, base);
    const allowed = (rule.s ?? "") + (rule.v ?? "");
    for (const letter of letters) {
      const command = `${base} -${letter}${rule.v?.includes(letter) ? " 1" : ""}`;
      assert.equal(classifyReadOnly(command).readOnly, allowed.includes(letter), command);
    }
    const listed = [...(rule.l ?? "").split(" "), ...(rule.lv ?? "").split(" ")].filter(Boolean);
    for (const option of longs) {
      const command = `${base} --${option}=1`;
      assert.equal(classifyReadOnly(command).readOnly, (rule.lv ?? "").split(" ").includes(option), command);
      if (!listed.includes(option)) assert.equal(classifyReadOnly(`${base} --${option}`).readOnly, false, `${base} --${option}`);
    }
    for (const option of listed) {
      const valued = (rule.lv ?? "").split(" ").includes(option);
      const command = `${base} --${option}${valued ? "=1" : ""}`;
      assert.deepEqual(classifyReadOnly(command), { readOnly: true }, command);
      // GNU abbreviations are never accepted unless they are themselves listed.
      const abbreviation = option.slice(0, -1);
      if (abbreviation.length > 0 && !listed.includes(abbreviation))
        assert.equal(classifyReadOnly(`${base} --${abbreviation}${valued ? "=1" : ""}`).readOnly, false, `${base} --${abbreviation}`);
    }
  };
  for (const [name, rule] of Object.entries(READ_ONLY_RULES)) check(name, rule);
  for (const [verb, rule] of Object.entries(DOCKER_RULES)) check(`docker ${verb}`, rule);
});

test("the marker scanner verifies the payload shape and survives every chunk split", () => {
  const stream = bytes(`${probeLine(NONCE)}\r\n${ready()}$ echo ${commandLine("ls", NONCE)}\r\n${start()}out${done(3, OTHER)}more${done(0)}$ `);
  const whole = new MarkerScanner().feed(stream);
  assert.deepEqual(whole.map((event) => [event.kind, event.nonce, event.kind === "done" ? event.code : null]),
    [["ready", NONCE, null], ["start", NONCE, null], ["done", OTHER, 3], ["done", NONCE, 0]], "echoed command lines are literal text, never markers");
  for (let size = 1; size <= 7; size++) {
    const scanner = new MarkerScanner();
    const events = [];
    for (let at = 0; at < stream.length; at += size) events.push(...scanner.feed(stream.subarray(at, at + size)));
    assert.deepEqual(events, whole, `chunks of ${size}`);
  }
  const odd = new MarkerScanner().feed(bytes(`\x1b]ssterm;done;${NONCE};256\x07\x1b]ssterm;done;${NONCE.toUpperCase()};0\x07` +
    `\x1b]ssterm;done;${NONCE};0\x1b\\\x1b]ssterm;start;${NONCE}x\x07\x1b]ssterm;\x18done;${NONCE};0\x07`));
  assert.deepEqual(odd, [], "out-of-range status, wrong case, ST terminator, extra bytes and CAN are not markers");
});

test("the screen tracker sees DECSET 47/1047/1049 split, as 8-bit CSI, and RIS resets it", () => {
  const tracker = new ScreenTracker();
  assert.equal(tracker.feed(bytes("hello \x1b[?25h")), false);
  assert.equal(tracker.feed(bytes("\x1b[")), false);
  assert.equal(tracker.feed(bytes("?10")), false);
  assert.equal(tracker.feed(bytes("49h")), true);
  assert.equal(tracker.active, true);
  assert.equal(tracker.feed(bytes("\x1b[?1049l")), false);
  assert.equal(tracker.active, false);
  assert.equal(tracker.feed(bytes("\x1b[?1;47h")), true);
  assert.equal(tracker.feed(bytes("text \x1bc")), false);
  assert.equal(tracker.active, false, "RIS");
  assert.equal(tracker.feed(bytes("\u{9b}?1049h")), true, "UTF-8 encoded C1 CSI");
  tracker.feed(bytes("\x1bc"));
  assert.equal(tracker.feed(Uint8Array.of(0x9b, ...bytes("?47h"))), true, "raw 8-bit CSI");
});

test("output is plain text without C0/C1 controls, tail-capped at 64 KiB with a marker, never split inside a character", () => {
  assert.deepEqual(formatOutput(bytes("\x1b[1;31mred\x1b[0m\r\nline2\r\n50%\r100%\r\n\x1b]0;title\x07\u{9b}2Jend\u{85}\u{9c}")),
    { output: "red\nline2\n100%\nend", truncated: false });
  const big = formatOutput(bytes("ก".repeat(30_000)));
  assert.equal(big.truncated, true);
  assert.ok(big.output.startsWith(TRUNCATION_NOTE));
  const kept = new TextEncoder().encode(big.output.slice(TRUNCATION_NOTE.length));
  assert.ok(kept.length <= MAX_AGENT_OUTPUT && kept.length > MAX_AGENT_OUTPUT - 3);
  assert.ok(!big.output.includes("\u{fffd}"));
});

function executor(options: { timeoutMs?: number; settleMs?: number; probeMs?: number; startMs?: number; write?: "ok" | "busy" | "closed" } = {}) {
  const writes: string[] = [];
  let changes = 0;
  const run = new TerminalExecutor({
    write: (data) => { writes.push(new TextDecoder().decode(data)); return options.write ?? "ok"; },
    nonce: () => NONCE, timeoutMs: options.timeoutMs ?? 5_000, settleMs: options.settleMs ?? 20, maxSettleMs: 200,
    probeMs: options.probeMs ?? 1_000, startMs: options.startMs ?? 1_000, onChange: () => { changes += 1; },
  });
  const feed = (text: string) => run.output(bytes(text));
  /** The shell answers the probe and starts the command. */
  const started = () => { feed(`${probeLine(NONCE)}\r\n${ready()}$ `); feed(`${commandLine("x", NONCE)}\r\n${start()}`); };
  return { run, writes, changes: () => changes, feed, started };
}

test("run probes first, types the command only after the probe answers, and returns only that command's span and status", async () => {
  const { run, writes, feed, changes } = executor();
  feed("old scrollback secret\r\n$ ");
  const pending = run.run("ls -la");
  assert.ok(pending instanceof Promise);
  assert.equal(run.running, "ls -la");
  assert.equal(changes(), 1);
  assert.deepEqual(writes, [`\x05\x15${probeLine(NONCE)}\r`], "only the probe, after clearing any half-typed line");
  feed(`user-typed-draft\x08\x08${probeLine(NONCE)}\r\n${ready(OTHER)}`);
  assert.equal(writes.length, 1, "a foreign ready marker does not release the command");
  feed(`${ready()}$ `);
  assert.deepEqual(writes.slice(1), [`${commandLine("ls -la", NONCE)}\r`]);
  feed(`${commandLine("ls -la", NONCE)}\r\n`);
  feed(`${start()}total 0\r\nfile ${done(9, OTHER)}spoof-ignored\r\n`);
  feed(`last line\r\n${done(2)}$ `);
  const result = await pending;
  assert.deepEqual(result, { status: "completed", command: "ls -la", exitCode: 2, output: "total 0\nfile spoof-ignored\nlast line\n", truncated: false });
  assert.equal(run.running, undefined);
  assert.equal(changes(), 2);
  assert.deepEqual(run.last, result);
});

test("no prompt answer: not-at-prompt, the command is never typed and nothing else is sent", async () => {
  const { run, writes, feed } = executor({ probeMs: 30 });
  const pending = run.run("cat /etc/hostname") as Promise<{ status: string }>;
  feed("probe text swallowed by some program\r\n");
  assert.equal((await pending).status, "not-at-prompt");
  assert.equal(writes.length, 1, "no command line, no Ctrl+C");
  feed(`${ready()}`);
  assert.equal(writes.length, 1, "a late answer types nothing");
  assert.equal(run.input(bytes("x")), true, "input flows again");
});

test("the command is typed but never starts: not-started after the start deadline, without Ctrl+C", async () => {
  const { run, writes, feed } = executor({ startMs: 30 });
  const pending = run.run("ls") as Promise<{ status: string }>;
  feed(ready());
  assert.equal(writes.length, 2);
  assert.equal((await pending).status, "not-started");
  assert.equal(writes.length, 2, "no Ctrl+C to whatever holds the terminal");
});

test("markers split across frames, even byte by byte, still cut the span exactly", async () => {
  const { run, feed } = executor();
  const pending = run.run("cat x") as Promise<unknown>;
  for (const char of `${ready()}$ ${commandLine("cat x", NONCE)}\r\n${start()}a\r\nb\r\n${done(0)}$ `) feed(char);
  assert.deepEqual(await pending, { status: "completed", command: "cat x", exitCode: 0, output: "a\nb\n", truncated: false });
});

test("a long output keeps the 64 KiB tail and is marked", async () => {
  const { run, feed, started } = executor();
  const pending = run.run("cat big") as Promise<{ output: string; truncated: boolean }>;
  started();
  for (let i = 0; i < 400; i++) feed(`${String(i).padStart(5, "0")} ${"x".repeat(1_000)}\r\n`);
  feed(done(0));
  const result = await pending;
  assert.equal(result.truncated, true);
  assert.ok(result.output.startsWith(TRUNCATION_NOTE));
  assert.ok(result.output.endsWith(`00399 ${"x".repeat(1_000)}\n`));
  assert.ok(new TextEncoder().encode(result.output).length <= MAX_AGENT_OUTPUT + TRUNCATION_NOTE.length);
});

test("one command at a time; input is held from the probe on, except a lone Ctrl+C, which interrupts", async () => {
  const { run, writes, feed, started } = executor();
  const pending = run.run("sleep 30") as Promise<{ status: string; exitCode: number | null }>;
  assert.equal(run.input(bytes("typed during the probe")), false);
  assert.equal(run.run("ls"), "busy");
  assert.equal(writes.length, 1, "a refused run types nothing");
  started();
  assert.equal(run.input(bytes("rm -rf /\r")), false);
  assert.equal(run.input(bytes("\x03\r")), false, "Ctrl+C mixed with other input is held");
  assert.equal(run.input(bytes("\x03")), true);
  assert.equal(writes.length, 2, "the user's own Ctrl+C is not doubled");
  feed("^C\r\n$ ");
  assert.deepEqual(await pending, { status: "interrupted", command: "sleep 30", exitCode: null, output: "^C\n$ ", truncated: false });
  assert.equal(run.input(bytes("typing again")), true);
});

test("cancel sends Ctrl+C only to a started command; the timeout sends Ctrl+C; a full-screen program is interrupted and refuses later runs", async () => {
  const early = executor();
  const probing = early.run.run("tail -f log") as Promise<{ status: string }>;
  assert.equal(early.run.cancel(), true);
  assert.equal((await probing).status, "interrupted");
  assert.equal(early.writes.length, 1, "cancel during the probe sends nothing");

  const cancelled = executor();
  const first = cancelled.run.run("tail -f log") as Promise<{ status: string }>;
  cancelled.started();
  assert.equal(cancelled.run.cancel(), true);
  assert.equal(cancelled.run.cancel(), false);
  assert.deepEqual(cancelled.writes.slice(2), ["\x03"]);
  assert.equal((await first).status, "interrupted");

  // Cancelled after the line was typed but before it started: Ctrl+C waits for the start marker, then goes.
  const typed = executor();
  const pendingStart = typed.run.run("sleep 30") as Promise<{ status: string }>;
  typed.feed(`${ready()}$ `);
  assert.equal(typed.run.cancel(), true);
  assert.equal(typed.run.cancel(), false);
  assert.equal(typed.writes.length, 2, "nothing is sent before the command is known to run");
  typed.feed(start());
  assert.deepEqual(typed.writes.slice(2), ["\x03"]);
  typed.feed("^C\r\n$ ");
  assert.equal((await pendingStart).status, "interrupted");
  // …and if it never starts, the run reports not-started and nothing is sent at all.
  const never = executor({ startMs: 30 });
  const lost = never.run.run("sleep 30") as Promise<{ status: string }>;
  never.feed(ready());
  assert.equal(never.run.cancel(), true);
  assert.equal((await lost).status, "not-started");
  assert.equal(never.writes.length, 2);

  const timed = executor({ timeoutMs: 30 });
  const slow = timed.run.run("sleep 30") as Promise<{ status: string }>;
  timed.started();
  await wait(60);
  assert.deepEqual(timed.writes.slice(2), ["\x03"]);
  assert.equal((await slow).status, "timeout");

  const screen = executor();
  const full = screen.run.run("cat screen") as Promise<{ status: string }>;
  screen.started();
  screen.feed("\x1b[?1049h\x1b[H");
  assert.deepEqual(screen.writes.slice(2), ["\x03"]);
  assert.equal((await full).status, "alternate-screen");
  assert.equal(screen.run.run("ls"), "full-screen");
  screen.feed("\x1b[?1049l$ ");
  assert.ok(screen.run.run("ls") instanceof Promise);
  screen.run.end();

  // Entering and leaving within the command's own span still reports the refusal, with the real status.
  const quick = executor();
  const blink = quick.run.run("cat blink") as Promise<{ status: string; exitCode: number | null }>;
  quick.started();
  quick.feed(`\x1b[?1049hx\x1b[?1049l${done(0)}`);
  assert.deepEqual([(await blink).status, (await blink).exitCode], ["alternate-screen", 0]);
});

test("a screen state tracked before the executor existed refuses the first run", () => {
  const tracked = new ScreenTracker();
  tracked.feed(bytes("\x1b[?1049h"));
  const run = new TerminalExecutor({ write: () => "ok", screen: tracked });
  assert.equal(run.run("ls"), "full-screen");
});

test("a marker after Ctrl+C keeps its status; the end of the generation ends a running command", async () => {
  const { run, feed, started } = executor({ settleMs: 1_000 });
  const pending = run.run("sleep 5") as Promise<{ status: string; exitCode: number | null }>;
  started();
  run.input(bytes("\x03"));
  feed(`^C${done(130)}`);
  assert.deepEqual([(await pending).status, (await pending).exitCode], ["interrupted", 130]);

  const ended = executor();
  const lost = ended.run.run("sleep 5") as Promise<{ status: string }>;
  ended.started();
  ended.run.end();
  assert.equal((await lost).status, "ended");
  assert.equal(ended.run.run("ls"), "ended");
});

test("nothing is reported as running when the terminal refuses the probe", () => {
  const { run, writes } = executor({ write: "busy" });
  assert.equal(run.run("ls"), "not-accepted");
  assert.equal(run.running, undefined);
  assert.equal(writes.length, 1);
});
