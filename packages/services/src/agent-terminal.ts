/**
 * SST-041 ticket 02: the Read only command classifier and the terminal executor (ADR 0009, A2/A3/A9).
 * Pure and main-only: the executor reaches a terminal only through the `write` it is given, and sees output only
 * through `output`. Nothing here knows the catalog, credentials, other sessions or snippets.
 */
import { randomBytes } from "node:crypto";

export const MAX_AGENT_COMMAND = 4_096;
/** A3: the tail of one command's output that is returned, in UTF-8 bytes. */
export const MAX_AGENT_OUTPUT = 65_536;
/** Raw bytes kept while a command runs, before escape stripping; older bytes are dropped (and marked). */
const MAX_RAW = 4 * MAX_AGENT_OUTPUT;
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Read only classifier (A2): a strict allowlist of commands, and for each command an allowlist of its options.
// Anything not listed is refused. Documented as best effort: server-side aliases and functions are not visible.

type Classification = { readOnly: true } | { readOnly: false; reason: string };
export interface ReadOnlyRule {
  /** Value-less short option letters (clusterable). */
  s?: string;
  /** Short option letters that take a value (attached, or the next word). */
  v?: string;
  /** Value-less long options, space-separated, exact (no GNU abbreviations). */
  l?: string;
  /** Long options that take a value (`--opt=value` or `--opt value`). */
  lv?: string;
  /** Operand limit. */
  max?: number;
  /** Every operand must match. */
  operand?: RegExp;
  /** Unquoted globs allowed in operands: only commands with no option that writes or executes. */
  globs?: true;
  /** The first operand must be one of these verbs (space-separated). */
  verbs?: string;
  /** This option must be present (non-interactive output). */
  require?: string;
}
const GREP: ReadOnlyRule = {
  s: "EFGPiyvwxclLoqsbHhnrRaIzZU", v: "eABCmf",
  l: "ignore-case invert-match word-regexp line-regexp count files-with-matches files-without-match only-matching quiet silent " +
    "no-messages with-filename no-filename line-number recursive dereference-recursive text extended-regexp fixed-strings perl-regexp null",
  lv: "regexp after-context before-context context max-count include exclude exclude-dir color colour file", globs: true,
};
const CHECKSUM: ReadOnlyRule = { s: "bctwz", l: "check status quiet strict tag binary text warn ignore-missing", globs: true };
export const READ_ONLY_RULES: Readonly<Record<string, ReadOnlyRule>> = {
  ls: { s: "1aAdFhilLnrRStuX", v: "I", l: "all almost-all human-readable si inode numeric-uid-gid reverse recursive classify directory dereference full-time",
    lv: "sort time-style ignore", globs: true },
  pwd: { s: "LP", max: 0 },
  whoami: { max: 0 },
  id: { s: "ugnrGz", max: 1 },
  uptime: { s: "ps", l: "pretty since", max: 0 },
  uname: { s: "asnrvmpio", l: "all", max: 0 },
  nproc: { l: "all", max: 0 },
  arch: { max: 0 },
  tty: { s: "s", max: 0 },
  groups: { max: 8 },
  who: { s: "aHbqu", max: 0 },
  w: { s: "hsfi", max: 1 },
  last: { s: "axiwF", v: "n", max: 1 },
  locale: { s: "a", max: 0 },
  cat: { s: "AbeEnstTuv", l: "number number-nonblank show-all squeeze-blank show-ends show-tabs", globs: true },
  head: { s: "qvz0123456789", v: "nc", l: "quiet silent verbose", lv: "lines bytes", globs: true },
  tail: { s: "qvfFz0123456789", v: "nc", l: "quiet silent verbose follow", lv: "lines bytes", globs: true },
  wc: { s: "clmwL", l: "lines words bytes chars max-line-length", globs: true },
  cut: { s: "sz", v: "bcfd", l: "only-delimited complement", lv: "bytes characters fields delimiter output-delimiter", globs: true },
  tr: { s: "cdsC", max: 2 },
  nl: { v: "bw", globs: true },
  grep: GREP, egrep: GREP, fgrep: GREP,
  zcat: { s: "f", globs: true },
  jq: { s: "rcnseSjC", l: "raw-output compact-output null-input slurp exit-status sort-keys join-output", globs: true },
  df: { s: "hHiTlaPk", l: "human-readable inodes local all print-type", lv: "output type exclude-type", globs: true },
  du: { s: "hsacxLkmbS", v: "d", l: "human-readable summarize apparent-size all total one-file-system", lv: "max-depth exclude", globs: true },
  free: { s: "hmgkbtlw", v: "sc", l: "human total wide", max: 0 },
  vmstat: { s: "awdDs", v: "S", max: 2, operand: /^\d{1,6}$/u },
  ps: { s: "aAdeflFjHLMTwxuvXZ", v: "opuUgGtCN", l: "forest no-headers headers", lv: "sort format pid ppid user",
    operand: /^(?:[A-Za-z]{1,16}|\d{1,10})$/u },
  stat: { s: "LfctZ", v: "c", l: "dereference file-system terse", lv: "format printf", globs: true },
  lsblk: { s: "afmlpnbdJrS", v: "o", lv: "output" },
  lscpu: { s: "aJ", max: 0 },
  netstat: { s: "tulnpaersicWx46", max: 0 },
  echo: { s: "neE" },
  printenv: { s: "0" },
  which: { s: "a" },
  basename: { s: "az", v: "s", l: "multiple zero", lv: "suffix" },
  dirname: { s: "z" },
  realpath: { s: "emsqPLz", l: "canonicalize-existing canonicalize-missing no-symlinks quiet logical physical zero" },
  readlink: { s: "efmnqsvz", l: "canonicalize canonicalize-existing canonicalize-missing no-newline quiet silent verbose zero" },
  md5sum: CHECKSUM, sha1sum: CHECKSUM, sha256sum: CHECKSUM,
  diff: { s: "uqrNaiwbBEtys", v: "UC", l: "brief recursive ignore-case ignore-all-space ignore-space-change new-file text side-by-side report-identical-files",
    lv: "unified context exclude", globs: true },
  cmp: { s: "bls", v: "in", max: 4 },
  getent: { v: "s", max: 8 },
  true: { max: 0 },
  false: { max: 0 },
  sleep: { max: 1, operand: /^\d{1,6}(?:\.\d{1,3})?[smhd]?$/u },
  // Changes only this shell's directory, which A9 keeps on purpose.
  cd: { s: "LP", max: 1 },
  env: { max: 0 },
  // An operand without `+` would set the clock.
  date: { s: "uR", v: "dr", l: "utc universal rfc-email", lv: "date reference iso-8601 rfc-3339", max: 1, operand: /^\+/u },
  // An operand would set the host name.
  hostname: { s: "fsdiIAa", l: "fqdn short domain ip-address all-ip-addresses all-fqdns alias", max: 0 },
  file: { s: "bLhizNkp", l: "brief mime mime-type mime-encoding dereference no-dereference uncompress keep-going" },
  sort: { s: "bdfgiMhnRrsuVcCz", v: "kt", l: "numeric-sort human-numeric-sort reverse unique ignore-case version-sort general-numeric-sort month-sort check stable ignore-leading-blanks",
    lv: "key field-separator" },
  // A second operand is an output file.
  uniq: { s: "cdDuiz", v: "fsw", l: "count repeated unique ignore-case", lv: "skip-fields skip-chars check-chars", max: 1 },
  // Operands are filter expressions (`state established`); -K kills and -D writes are not listed.
  ss: { s: "tulnpaxwseimoHrO46" },
  systemctl: {
    s: "alq", v: "tpn", l: "no-pager all full no-legend plain failed value quiet user system", lv: "type state property lines output",
    verbs: "status is-active is-enabled is-failed list-units list-unit-files list-timers list-sockets show cat list-dependencies",
    require: "--no-pager",
  },
  journalctl: {
    s: "aeklmqrx", v: "unpSUtgo", l: "no-pager reverse utc catalog all full no-hostname quiet merge dmesg system user follow no-tail",
    lv: "unit lines priority since until identifier grep output boot", require: "--no-pager",
  },
};
/** `docker <verb>`: the verb must be the first word, so no global option (-H, -c, -l, --config…) is ever accepted. */
export const DOCKER_RULES: Readonly<Record<string, ReadOnlyRule>> = {
  ps: { s: "aqsl", v: "fn", l: "all quiet size no-trunc latest", lv: "filter format last", max: 0 },
  images: { s: "aq", v: "f", l: "all quiet no-trunc digests", lv: "filter format", max: 1 },
  inspect: { s: "s", v: "f", l: "size", lv: "format type" },
  logs: { s: "ft", v: "n", l: "follow timestamps details", lv: "tail since until", max: 1 },
  version: { v: "f", lv: "format", max: 0 },
  info: { v: "f", lv: "format", max: 0 },
};
/** find expression words and how many values each takes; every word not listed (-delete, -exec, -fprint…) is refused. */
const FIND: Readonly<Record<string, number>> = {
  "-name": 1, "-iname": 1, "-path": 1, "-ipath": 1, "-wholename": 1, "-regex": 1, "-iregex": 1, "-type": 1, "-xtype": 1,
  "-mtime": 1, "-mmin": 1, "-atime": 1, "-amin": 1, "-ctime": 1, "-cmin": 1, "-size": 1, "-user": 1, "-group": 1, "-uid": 1,
  "-gid": 1, "-perm": 1, "-links": 1, "-inum": 1, "-newer": 1, "-maxdepth": 1, "-mindepth": 1, "-printf": 1, "-print": 0,
  "-print0": 0, "-ls": 0, "-empty": 0, "-readable": 0, "-writable": 0, "-executable": 0, "-nouser": 0, "-nogroup": 0,
  "-prune": 0, "-quit": 0, "-depth": 0, "-xdev": 0, "-mount": 0, "-follow": 0, "-true": 0, "-false": 0, "-o": 0, "-or": 0,
  "-a": 0, "-and": 0, "-not": 0, "-L": 0, "-H": 0, "-P": 0,
};
/** Outside quotes only plain words, spaces, globs, `~` and single pipes are accepted. */
const REFUSED_OUTSIDE: Readonly<Record<string, string>> = {
  ";": "command chaining (;)", "&": "background jobs or chaining (&, &&)", ">": "redirects", "<": "redirects or heredocs",
  "(": "subshells", ")": "subshells", "{": "command groups or brace expansion", "}": "command groups or brace expansion",
  "`": "command substitution", "$": "variable expansion or command substitution", "#": "comments",
};
const REFUSED_IN_DOUBLE: Readonly<Record<string, string>> = { "`": "command substitution", "$": "variable expansion or command substitution" };
const REFUSED_ANYWHERE: Readonly<Record<string, string>> = { "!": "history expansion (!)", "\\": "backslash escapes" };
// Controls, C1 controls and invisible/bidi formatting, which would hide what the pane shows.
const INVISIBLE = /[\x00-\x1f\x7f-\x9f\u{200b}-\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}]/u;
const COMMAND_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
/** A glob segment as a pattern, to ask whether it could expand to `dev`. */
const globPattern = (segment: string) => {
  try { return new RegExp(`^${segment.replace(/[.+^${}()|\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".").replace(/\[!/gu, "[^")}$`, "u"); }
  catch { return /^/u; }
};
/**
 * Device files read forever or touch hardware, and `..` can reach them from anywhere: a path-like word (one with a
 * slash, or any `cd` operand) is refused when it has a `..` segment or a segment that is, or could glob to, `dev`.
 * Only exactly `/dev/null` is accepted. Values after `=`, `:` or `,` are checked the same way.
 */
function pathProblem(word: Word, always: boolean): string | undefined {
  for (const part of word.text.split(/[=:,]/u)) {
    if (!always && !part.includes("/")) continue;
    const collapsed = part.replace(/\/+/gu, "/");
    if (collapsed === "/dev/null") continue;
    const segments = collapsed.split("/");
    if (segments.includes("..")) return `\`..\` in paths (${word.text})`;
    if (segments.some((segment) => segment === "dev" || (word.glob && /[*?[]/u.test(segment) && globPattern(segment).test("dev"))))
      return `device files (${word.text})`;
  }
  return undefined;
}
interface Word { text: string; glob: boolean }

const refuse = (reason: string): Classification => ({ readOnly: false, reason });
const list = (value: string | undefined) => value ? value.split(" ") : [];

/** Splits one line into pipeline segments of dequoted words, or names the first construct that is not allowed. */
function tokenize(command: string): Word[][] | string {
  const segments: Word[][] = [[]];
  let word: Word | undefined;
  let quote: "'" | '"' | undefined;
  const end = () => { if (word) segments.at(-1)!.push(word); word = undefined; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (REFUSED_ANYWHERE[char]) return REFUSED_ANYWHERE[char]!;
    if (quote) {
      if (char === quote) { quote = undefined; continue; }
      if (quote === '"' && REFUSED_IN_DOUBLE[char]) return REFUSED_IN_DOUBLE[char]!;
      word!.text += char;
      continue;
    }
    if (char === " ") { end(); continue; }
    if (char === "|") {
      if (command[i + 1] === "|") return "command chaining (||)";
      end();
      segments.push([]);
      continue;
    }
    if (REFUSED_OUTSIDE[char]) return REFUSED_OUTSIDE[char]!;
    word ??= { text: "", glob: false };
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "*" || char === "?" || char === "[") word.glob = true;
    word.text += char;
  }
  if (quote) return "an unterminated quote";
  end();
  return segments;
}

/** Options from the rule's allowlists only; values are consumed so they are never mistaken for operands or verbs. */
function checkArgs(name: string, rule: ReadOnlyRule, args: Word[]): string | undefined {
  const short = rule.s ?? "", valued = rule.v ?? "", long = list(rule.l), longValued = list(rule.lv);
  const operands: Word[] = [];
  const present = new Set<string>();
  let dashes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const text = arg.text;
    if (dashes || text === "-" || !text.startsWith("-")) { operands.push(arg); continue; }
    if (arg.glob) return `unquoted globs in options of \`${name}\``;
    if (text === "--") { dashes = true; continue; }
    present.add(text);
    const value = (): string | undefined => {
      const next = args[++i];
      return !next ? `\`${name} ${text}\` without its value` : next.glob ? `unquoted globs in option values of \`${name}\`` : undefined;
    };
    if (text.startsWith("--")) {
      const at = text.indexOf("=");
      const option = at < 0 ? text.slice(2) : text.slice(2, at);
      if (at < 0 && long.includes(option)) continue;
      if (longValued.includes(option)) {
        const problem = at < 0 ? value() : undefined;
        if (problem) return problem;
        continue;
      }
      return `\`${name} --${option}\` (not on its read-only option list)`;
    }
    for (let j = 1; j < text.length; j++) {
      const letter = text[j]!;
      if (short.includes(letter)) continue;
      if (valued.includes(letter)) {
        const problem = j === text.length - 1 ? value() : undefined;
        if (problem) return problem;
        break;
      }
      return `\`${name} -${letter}\` (not on its read-only option list)`;
    }
  }
  if (rule.verbs) {
    const verb = operands.shift();
    if (!verb || verb.glob || !list(rule.verbs).includes(verb.text)) return `\`${name}\` without a read-only verb (${rule.verbs.replaceAll(" ", ", ")})`;
  }
  if (rule.max !== undefined && operands.length > rule.max) return `\`${name}\` with ${operands.length} operands`;
  for (const operand of operands) {
    if (operand.glob && !rule.globs) return `unquoted globs with \`${name}\``;
    if (rule.operand && !rule.operand.test(operand.text)) return `\`${name} ${operand.text}\``;
  }
  if (rule.require && !present.has(rule.require)) return `\`${name}\` without ${rule.require} (it would wait in a pager)`;
  return undefined;
}

function checkFind(args: Word[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.glob) return "unquoted globs with `find` (quote the pattern)";
    if (!arg.text.startsWith("-")) continue;
    const arity = FIND[arg.text];
    if (arity === undefined) return `\`find ${arg.text}\` (not on its read-only list)`;
    for (let n = 0; n < arity; n++) {
      const value = args[++i];
      if (!value) return `\`find ${arg.text}\` without its value`;
      if (value.glob) return "unquoted globs with `find` (quote the pattern)";
    }
  }
  return undefined;
}

function checkSegment(words: Word[]): string | undefined {
  const [name, ...args] = words;
  if (!name) return "an empty pipeline stage";
  if (name.text.includes("=")) return "environment assignments";
  if (name.glob || !COMMAND_NAME.test(name.text) || !(Object.hasOwn(READ_ONLY_RULES, name.text) || ["find", "docker"].includes(name.text)))
    return `\`${name.text}\` is not on the Read only allowlist`;
  for (const arg of args) {
    const problem = pathProblem(arg, name.text === "cd");
    if (problem) return problem;
  }
  if (name.text === "find") return checkFind(args);
  if (name.text === "docker") {
    const [verb, ...rest] = args;
    const rule = verb && !verb.glob && Object.hasOwn(DOCKER_RULES, verb.text) ? DOCKER_RULES[verb.text] : undefined;
    if (!rule) return `\`docker ${verb?.text ?? ""}\` (only ${Object.keys(DOCKER_RULES).join(", ")}, as the first word)`;
    return checkArgs(`docker ${verb!.text}`, rule, rest);
  }
  return checkArgs(name.text, READ_ONLY_RULES[name.text]!, args);
}

/** A2 Read only: true only for one line of allowlisted commands and options, optionally piped into allowlisted commands. */
export function classifyReadOnly(command: string): Classification {
  if (typeof command !== "string" || command.trim() === "") return refuse("an empty command");
  if (command.length > MAX_AGENT_COMMAND) return refuse("a command longer than 4096 characters");
  if (INVISIBLE.test(command)) return refuse("control characters or more than one line");
  const segments = tokenize(command);
  if (typeof segments === "string") return refuse(segments);
  for (const segment of segments) {
    const problem = checkSegment(segment);
    if (problem) return refuse(problem);
  }
  return { readOnly: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Markers (A9): `ESC ] ssterm;ready;<nonce> BEL` (prompt probe), then `…;start;<nonce>` before the command and
// `…;done;<nonce>;<status>` after it.

export type MarkerEvent =
  | { kind: "ready" | "start"; nonce: string; start: number; end: number }
  | { kind: "done"; nonce: string; code: number; start: number; end: number };
const MAX_PAYLOAD = 96;
const OPEN = /^ssterm;(ready|start);([0-9a-f]{32})$/u;
const DONE = /^ssterm;done;([0-9a-f]{32});(\d{1,3})$/u;
const enum Scan { Ground, Escape, Osc, Skip }

/**
 * Streaming OSC recognizer for ssterm markers only, across arbitrary chunk splits. Offsets are absolute byte
 * positions in the stream: `start` is the ESC, `end` is one past the BEL. Only BEL-terminated payloads count; any
 * other OSC (or a marker with a foreign nonce) is reported or ignored and left to the caller.
 */
export class MarkerScanner {
  #state = Scan.Ground;
  #payload = "";
  #oscStart = 0;
  offset = 0;
  feed(chunk: Uint8Array): MarkerEvent[] {
    const events: MarkerEvent[] = [];
    const base = this.offset;
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i]!;
      switch (this.#state) {
        case Scan.Ground:
          if (byte === 0x1b) this.#state = Scan.Escape;
          break;
        case Scan.Escape:
          if (byte === 0x5d) { this.#state = Scan.Osc; this.#payload = ""; this.#oscStart = base + i - 1; }
          else if (byte !== 0x1b) this.#state = Scan.Ground;
          break;
        default:
          if (byte === 0x07) {
            if (this.#state === Scan.Osc) {
              const event = this.#dispatch(base + i + 1);
              if (event) events.push(event);
            }
            this.#state = Scan.Ground;
          } else if (byte === 0x1b) this.#state = Scan.Escape;
          else if (byte === 0x18 || byte === 0x1a) this.#state = Scan.Ground;
          else if (this.#state === Scan.Osc) {
            if (this.#payload.length >= MAX_PAYLOAD || byte < 0x20 || byte > 0x7e) this.#state = Scan.Skip;
            else this.#payload += String.fromCharCode(byte);
          }
      }
    }
    this.offset = base + chunk.length;
    return events;
  }
  #dispatch(end: number): MarkerEvent | undefined {
    const start = this.#oscStart;
    const opened = OPEN.exec(this.#payload);
    if (opened) return { kind: opened[1] as "ready" | "start", nonce: opened[2]!, start, end };
    const done = DONE.exec(this.#payload);
    if (done && Number(done[2]) <= 255) return { kind: "done", nonce: done[1]!, code: Number(done[2]), start, end };
    return undefined;
  }
}

// 7-bit CSI, UTF-8-encoded C1 CSI (C2 9B) and a raw 0x9B, read as latin1; RIS (ESC c) resets the screen.
const SCREEN = /(?:\x1b\[|\xc2\x9b|\x9b)\?([0-9;]{1,32})([hl])|\x1bc/gu;

/** Tracks the alternate screen (DECSET 47/1047/1049) across chunk splits; cheap when a chunk cannot contain one. */
export class ScreenTracker {
  #carry = "";
  active = false;
  /** True when this chunk switched to the alternate screen at least once. */
  feed(chunk: Uint8Array): boolean {
    const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (!this.#carry && !view.includes(0x3f) && !view.includes("\x1bc", 0, "latin1")) {
      const lead = Math.max(view.lastIndexOf(0x1b), view.lastIndexOf(0x9b), view.lastIndexOf(0xc2));
      this.#carry = lead >= 0 && view.length - lead < 40 ? view.toString("latin1", lead) : "";
      return false;
    }
    const text = this.#carry + view.toString("latin1");
    let entered = false;
    for (const match of text.matchAll(SCREEN)) {
      if (match.index! + match[0].length <= this.#carry.length) continue;
      if (match[0] === "\x1bc") { this.active = false; continue; }
      if (!match[1]!.split(";").some((mode) => mode === "47" || mode === "1047" || mode === "1049")) continue;
      this.active = match[2] === "h";
      entered ||= this.active;
    }
    // Enough for any split sequence prefix; a whole sequence kept here is skipped next time.
    const lead = Math.max(text.lastIndexOf("\x1b"), text.lastIndexOf("\x9b"), text.lastIndexOf("\xc2"));
    this.#carry = lead >= 0 && text.length - lead < 40 ? text.slice(lead) : "";
    return entered;
  }
}

/** The probe line: proves an idle shell reads and runs a line before the command is typed. */
export function probeLine(nonce: string): string {
  return `printf '\\033]ssterm;ready;${nonce}\\007'`;
}
/** The line typed into the shell: start marker, the command, then the done marker with the command's status. */
export function commandLine(command: string, nonce: string): string {
  return `printf '\\033]ssterm;start;${nonce}\\007'; ${command}; printf '\\033]ssterm;done;${nonce};%s\\007' "$?"`;
}

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();
const ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]?/gu;
export const TRUNCATION_NOTE = "[ssterm: output truncated; showing the last 64 KiB]\n";

/** Terminal bytes to plain text (escapes and C0/C1 controls stripped, CR overwrites applied), tail-capped at 64 KiB. */
export function formatOutput(raw: Uint8Array, dropped = false): { output: string; truncated: boolean } {
  const text = decoder.decode(raw)
    .replace(ESCAPES, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, "")
    .replace(/\r+\n/gu, "\n")
    .split("\n").map((line) => line.slice(line.lastIndexOf("\r") + 1)).join("\n");
  let bytes = encoder.encode(text);
  let truncated = dropped;
  if (bytes.length > MAX_AGENT_OUTPUT) {
    truncated = true;
    let at = bytes.length - MAX_AGENT_OUTPUT;
    while (at < bytes.length && (bytes[at]! & 0xc0) === 0x80) at += 1;
    bytes = bytes.subarray(at);
  }
  const output = decoder.decode(bytes);
  return { output: truncated ? TRUNCATION_NOTE + output : output, truncated };
}

// ---------------------------------------------------------------------------------------------------------------
// Terminal executor (A9): one command at a time per terminal generation.

/**
 * `not-at-prompt`: the probe got no answer, so the command was never typed. `not-started`: the command line was typed
 * but the shell did not start it in time; it may still run when the shell reads it.
 */
export type AgentRunStatus = "completed" | "interrupted" | "timeout" | "alternate-screen" | "ended" | "not-at-prompt" | "not-started";
export interface AgentRunResult {
  status: AgentRunStatus;
  command: string;
  /** From the nonce-verified marker only; null when the command did not report one. */
  exitCode: number | null;
  output: string;
  truncated: boolean;
}
export type AgentRunRefusal = "busy" | "full-screen" | "not-accepted" | "ended";
type Write = (bytes: Uint8Array) => "ok" | "busy" | "closed";
type Interruption = "interrupted" | "timeout" | "alternate-screen";

interface Run {
  command: string;
  nonce: string;
  phase: "probe" | "start" | "capture";
  chunks: Uint8Array[];
  size: number;
  dropped: boolean;
  interrupted?: Interruption;
  /** `cancel` arrived after the line was typed but before it started: Ctrl+C goes as soon as the start marker does. */
  cancelPending?: boolean;
  settleUntil: number;
  /** Probe or start deadline, then the command timeout. */
  timer?: ReturnType<typeof setTimeout>;
  settle?: ReturnType<typeof setTimeout>;
  resolve(result: AgentRunResult): void;
}

export class TerminalExecutor {
  readonly #write: Write;
  readonly #timeoutMs: number;
  readonly #probeMs: number;
  readonly #startMs: number;
  readonly #settleMs: number;
  readonly #maxSettleMs: number;
  readonly #nonce: () => string;
  readonly #changed: () => void;
  readonly #scanner = new MarkerScanner();
  readonly #screen: ScreenTracker;
  #run: Run | undefined;
  #ended = false;
  last: AgentRunResult | undefined;

  constructor(options: {
    write: Write;
    timeoutMs?: number;
    /** How long an idle shell may take to answer the probe. */
    probeMs?: number;
    /** How long the shell may take to start the typed command. */
    startMs?: number;
    /** Quiet period after Ctrl+C before an interrupted command is reported (shells drop the rest of the line). */
    settleMs?: number;
    maxSettleMs?: number;
    nonce?: () => string;
    onChange?: () => void;
    /** The generation's screen state, when it was tracked before this executor existed. */
    screen?: ScreenTracker;
  }) {
    this.#write = options.write;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    this.#probeMs = options.probeMs ?? 3_000;
    this.#startMs = options.startMs ?? 5_000;
    this.#settleMs = options.settleMs ?? 1_000;
    this.#maxSettleMs = options.maxSettleMs ?? 5_000;
    this.#nonce = options.nonce ?? (() => randomBytes(16).toString("hex"));
    this.#changed = options.onChange ?? (() => {});
    this.#screen = options.screen ?? new ScreenTracker();
  }

  /** The running command for the pane banner. */
  get running(): string | undefined { return this.#run?.command; }

  /**
   * Probes the shell, then types one line plus markers. The caller has already applied the mode policy. Input to the
   * pane is held from the probe on.
   */
  run(command: string): Promise<AgentRunResult> | AgentRunRefusal {
    if (this.#ended) return "ended";
    if (this.#run) return "busy";
    // A full-screen program owns the keyboard; typing anything into it could do anything.
    if (this.#screen.active) return "full-screen";
    const nonce = this.#nonce();
    // Ctrl+E Ctrl+U first: whatever the user had half-typed is cleared, never prefixed to the probe.
    if (this.#write(encoder.encode(`\x05\x15${probeLine(nonce)}\r`)) !== "ok") return "not-accepted";
    return new Promise<AgentRunResult>((resolve) => {
      const run: Run = { command, nonce, phase: "probe", chunks: [], size: 0, dropped: false, settleUntil: 0, resolve };
      run.timer = setTimeout(() => this.#finish(run, "not-at-prompt", null), this.#probeMs);
      this.#run = run;
      this.#changed();
    });
  }

  /** Every output frame of this generation, in order. */
  output(chunk: Uint8Array): void {
    const at = this.#scanner.offset;
    const events = this.#scanner.feed(chunk);
    const entered = this.#screen.feed(chunk);
    const run = this.#run;
    if (!run) return;
    let from = 0;
    let done: Extract<MarkerEvent, { kind: "done" }> | undefined;
    for (const event of events) {
      // A marker without this command's nonce is output like any other (and stripped as an escape).
      if (event.nonce !== run.nonce) continue;
      if (event.kind === "ready" && run.phase === "probe" && !run.interrupted) this.#typeCommand(run);
      else if (event.kind === "start" && run.phase === "start") {
        run.phase = "capture";
        clearTimeout(run.timer);
        if (!run.interrupted) run.timer = setTimeout(() => this.#interrupt(run, "timeout"), this.#timeoutMs);
        from = event.end - at;
      } else if (event.kind === "done" && run.phase === "capture") { done = event; break; }
    }
    if (this.#run !== run) return;
    if (run.phase !== "capture") { if (run.interrupted) this.#armSettle(run); return; }
    const to = done ? done.start - at : chunk.length;
    if (to > from) this.#append(run, chunk.slice(from, to));
    else if (to < from) this.#trim(run, from - to);
    if (done) return this.#finish(run, entered ? "alternate-screen" : run.interrupted ?? "completed", done.code);
    if (run.cancelPending && !run.interrupted) return this.#interrupt(run, "interrupted");
    if (entered && !run.interrupted) return this.#interrupt(run, "alternate-screen");
    if (run.interrupted) this.#armSettle(run);
  }

  /** User input to this pane: false holds it. Only a lone Ctrl+C passes while a command runs, and interrupts it. */
  input(bytes: Uint8Array): boolean {
    const run = this.#run;
    if (!run) return true;
    if (bytes.length !== 1 || bytes[0] !== 0x03) return false;
    if (!run.interrupted) {
      run.interrupted = "interrupted";
      clearTimeout(run.timer);
      run.settleUntil = Date.now() + this.#maxSettleMs;
      this.#armSettle(run);
    }
    return true;
  }

  /**
   * The `cancel` tool. Ctrl+C only to a command known to run. During the probe nothing was typed, so the run just ends.
   * Once the line is typed but not yet started, Ctrl+C waits for the start marker; if it never comes the run reports
   * `not-started` (and nothing is sent to whatever holds the terminal).
   */
  cancel(): boolean {
    const run = this.#run;
    if (!run || run.interrupted || run.cancelPending) return false;
    if (run.phase === "capture") this.#interrupt(run, "interrupted");
    else if (run.phase === "start") run.cancelPending = true;
    else this.#finish(run, "interrupted", null);
    return true;
  }

  /** What `read_output` may see: the running command's span so far. */
  peek(): { command: string; output: string; truncated: boolean } | undefined {
    const run = this.#run;
    return run ? { command: run.command, ...formatOutput(Buffer.concat(run.chunks), run.dropped) } : undefined;
  }

  /** The generation ended (close, failure, lock, quit): the running command reports `ended`. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#run) this.#finish(this.#run, "ended", null);
  }

  #typeCommand(run: Run): void {
    clearTimeout(run.timer);
    run.phase = "start";
    // Not-started never sends Ctrl+C: the foreground job is unknown, it may be the user's own.
    run.timer = setTimeout(() => this.#finish(run, "not-started", null), this.#startMs);
    if (this.#write(encoder.encode(`${commandLine(run.command, run.nonce)}\r`)) !== "ok") this.#finish(run, "not-started", null);
  }
  #append(run: Run, bytes: Uint8Array): void {
    run.chunks.push(bytes);
    run.size += bytes.length;
    while (run.size > MAX_RAW && run.chunks.length > 1) {
      const first = run.chunks.shift()!;
      run.size -= first.length;
      run.dropped = true;
    }
  }
  /** The done marker began in an earlier frame: its first bytes were already captured. */
  #trim(run: Run, count: number): void {
    while (count > 0 && run.chunks.length) {
      const last = run.chunks.at(-1)!;
      const cut = Math.min(count, last.length);
      run.chunks[run.chunks.length - 1] = last.subarray(0, last.length - cut);
      run.size -= cut;
      count -= cut;
      if (run.chunks.at(-1)!.length === 0) run.chunks.pop();
    }
  }
  /** Ctrl+C to a command that is known to run (its start marker was seen). */
  #interrupt(run: Run, reason: Interruption): void {
    if (this.#run !== run || run.interrupted) return;
    run.interrupted = reason;
    clearTimeout(run.timer);
    this.#write(Uint8Array.of(0x03));
    run.settleUntil = Date.now() + this.#maxSettleMs;
    this.#armSettle(run);
  }
  /** Interactive shells abandon the rest of the line after Ctrl+C, so the done marker usually never comes. */
  #armSettle(run: Run): void {
    clearTimeout(run.settle);
    const wait = Math.max(0, Math.min(this.#settleMs, run.settleUntil - Date.now()));
    // ponytail: a quiet period stands in for "back at the prompt"; a program that ignores Ctrl+C keeps the pane.
    run.settle = setTimeout(() => this.#finish(run, run.interrupted!, null), wait);
  }
  #finish(run: Run, status: AgentRunStatus, exitCode: number | null): void {
    if (this.#run !== run) return;
    clearTimeout(run.timer);
    clearTimeout(run.settle);
    this.#run = undefined;
    const result: AgentRunResult = { status, command: run.command, exitCode, ...formatOutput(Buffer.concat(run.chunks), run.dropped) };
    for (const chunk of run.chunks) chunk.fill(0);
    run.chunks.length = 0;
    this.last = result;
    run.resolve(result);
    this.#changed();
  }
}
