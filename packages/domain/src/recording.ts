/**
 * SST-034 recording: browser-safe policy, value types, shell-integration snippets and text rules. Main (recorder,
 * scanner), contracts (guards) and the renderer (settings, prompt tracker, suggestions) share this one source.
 */

/** Profile-scoped `recordings/policy.json`. Missing or invalid means DEFAULT_RECORDING_POLICY: everything off. */
export interface RecordingPolicy {
  logs: boolean;
  history: boolean;
  logDays: number;
  logMiB: number;
  historyDays: number;
  historyMiB: number;
}
export const RECORDING_BOUNDS = Object.freeze({
  logDays: [1, 365], logMiB: [16, 10_240], historyDays: [1, 365], historyMiB: [1, 64],
} as const satisfies Record<Exclude<keyof RecordingPolicy, 'logs' | 'history'>, readonly [number, number]>);
export const DEFAULT_RECORDING_POLICY: Readonly<RecordingPolicy> = Object.freeze({
  logs: false, history: false, logDays: 30, logMiB: 1024, historyDays: 180, historyMiB: 8,
});
const POLICY_KEYS = ['logs', 'history', 'logDays', 'logMiB', 'historyDays', 'historyMiB'] as const;
/** Exact keys, booleans and integers within RECORDING_BOUNDS; used for the policy file and IPC. */
export function isRecordingPolicy(value: unknown): value is RecordingPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== POLICY_KEYS.length || !POLICY_KEYS.every((key) => Object.hasOwn(record, key))) return false;
  if (typeof record.logs !== 'boolean' || typeof record.history !== 'boolean') return false;
  return (Object.keys(RECORDING_BOUNDS) as (keyof typeof RECORDING_BOUNDS)[]).every((key) => {
    const [min, max] = RECORDING_BOUNDS[key];
    const field = record[key];
    return Number.isSafeInteger(field) && (field as number) >= min && (field as number) <= max;
  });
}

export type RecordingProblem = 'storage-unavailable' | 'key-unavailable' | 'write-failed' | 'size-limit';
/** The pane badge for one terminal generation. Absent means nothing is captured for it. */
export interface TerminalRecording {
  output: boolean;
  commands: boolean;
  state: 'starting' | 'on' | 'stopped';
  /** Output bytes were dropped (slow disk); the log records how many. */
  gaps: boolean;
  problem: RecordingProblem | null;
}
export type RecordingEnvironment = 'DEV' | 'STAGING' | 'PROD' | null;
export interface RecordingSummary {
  id: string;
  label: string;
  environment: RecordingEnvironment;
  local: boolean;
  endpoint: string | null;
  startedAt: number;
  bytes: number;
  state: 'recording' | 'complete' | 'incomplete';
}
export const MAX_LISTED_RECORDINGS = 500;
export interface RecordingState {
  policy: RecordingPolicy;
  /** Why capture would fail closed now (last observed); null when nothing is known to be wrong. */
  problem: 'storage-unavailable' | 'key-unavailable' | null;
  /** Newest first, at most MAX_LISTED_RECORDINGS; the counts cover everything. */
  logs: RecordingSummary[];
  logCount: number;
  logBytes: number;
  historyFiles: number;
  historyBytes: number;
}
export type RecordingKeyProblem = 'uninitialized' | 'missing' | 'locked' | 'denied' | 'unavailable' | 'error';
export type DeleteRecordingTarget = { kind: 'log'; id: string } | { kind: 'logs' } | { kind: 'history' } | { kind: 'all' };
export type ExportRecordingTarget = { kind: 'log'; id: string } | { kind: 'history' };
export type ExportOutcome =
  | { status: 'saved'; incomplete: boolean; gaps: number }
  | { status: 'not-found' | 'key-unavailable' | 'corrupt' | 'failed' | 'aborted' };
export type SuggestOutcome = { status: 'ok'; suggestions: string[] } | { status: 'off' | 'key-unavailable' | 'locked' };
export type ForgetOutcome = { status: 'forgotten' | 'not-found' | 'off' | 'key-unavailable' | 'locked' | 'failed' };
export type ConfigureOutcome =
  | { status: 'saved'; state: RecordingState }
  | { status: 'key-unavailable'; reason: RecordingKeyProblem | 'constraint' }
  | { status: 'failed' };

/**
 * Wraps per-recording data keys under the vault content key. The vault key never leaves the implementation and is
 * zeroed after each call; each call reads the Keychain once however many items it carries. Main-only.
 */
export interface RecordingKeys {
  /** Creates the vault content key when none exists and no ciphertext does. Never replaces one. */
  prepare(): Promise<{ ok: true } | { ok: false; reason: RecordingKeyProblem | 'constraint' }>;
  /** An empty batch still reads the key, so it doubles as an availability probe. */
  seal(items: readonly { recordingId: string; key: Uint8Array }[]):
    Promise<{ ok: true; vaultId: string; envelopes: Uint8Array[] } | { ok: false; reason: RecordingKeyProblem }>;
  /** Another vault or a failed authentication yields `undefined` for that item; the caller zero-fills the keys. */
  open(items: readonly { recordingId: string; vaultId: string; envelope: Uint8Array }[]):
    Promise<{ ok: true; keys: (Uint8Array | undefined)[] } | { ok: false; reason: RecordingKeyProblem }>;
}

/** Decoded UTF-8 bytes of one recordable command line. */
export const MAX_COMMAND_BYTES = 2_048;
export const MAX_SUGGEST_PREFIX_BYTES = 1_024;
export const MAX_SUGGESTIONS = 8;
// C0, DEL, C1 and the bidi/format controls that can make displayed text differ from the bytes.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const utf8 = (text: string) => new TextEncoder().encode(text).length;
/** No controls or bidi overrides, valid UTF-16 and at most `maxBytes` of UTF-8: what is shown is what is inserted. */
export function isDisplayText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length <= maxBytes && !CONTROLS.test(value) && !LONE_SURROGATE.test(value) && utf8(value) <= maxBytes;
}
/** A storable and suggestible command line: non-blank, no leading space, single line, display-safe. */
export function isCommandText(value: unknown): value is string {
  return isDisplayText(value, MAX_COMMAND_BYTES) && value.trim() !== '' && !value.startsWith(' ');
}

/** OSC 133 prompt marks from xterm's handler payload ("A", "B", "C", "D", "D;0"). */
export function promptMark(data: string): 'A' | 'B' | 'C' | 'D' | null {
  const mark = /^([ABCD])(?:;|$)/u.exec(data)?.[1];
  return mark === 'A' || mark === 'B' || mark === 'C' || mark === 'D' ? mark : null;
}

export type SupportedShell = 'bash' | 'zsh';
/**
 * Copyable snippets, never installed by ssterm. Contract: OSC 133;A/B wrap the prompt (re-applied if a prompt theme
 * rebuilt PS1 earlier in the same prompt cycle), OSC 633;E;<escaped> reports one accepted command line before
 * OSC 133;C, and OSC 133;D;<status> ends it. Escaping: "\" → "\\", ";" → "\x3b", controls → "\xHH" (which main then
 * refuses, so multi-line lines are never recorded). Terminator BEL.
 */
export const SHELL_INTEGRATION: Readonly<Record<SupportedShell, string>> = Object.freeze({
  bash: String.raw`# ssterm shell integration v1 for bash 4.4+ (place at the end of ~/.bashrc).
# Marks the prompt (OSC 133) and reports each command line bash saves in its own history (OSC 633;E).
# It sends nothing anywhere: ssterm keeps a line only while Keep command history is on. Lines bash does
# not save (HISTCONTROL, HISTIGNORE) and lines that start with a space are never reported. Older bash
# (macOS /bin/bash 3.2) skips this block.
if [[ $- == *i* && -z ${"${"}__ssterm_si-} ]] && (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  __ssterm_si=1
  __ssterm_esc() {
    local s=$1 out= c i
    for ((i = 0; i < ${"${"}#s}; i++)); do
      c=${"${"}s:i:1}
      case $c in
        '\') out+='\\' ;;
        ';') out+='\x3b' ;;
        [[:cntrl:]]) printf -v c '\\x%02x' "'$c"; out+=$c ;;
        *) out+=$c ;;
      esac
    done
    printf '%s' "$out"
  }
  __ssterm_status() {
    local s=$?
    [[ -n ${"${"}__ssterm_shown-} ]] && printf '\e]133;D;%s\a' "$s"
    __ssterm_shown=1
    __ssterm_last=$(HISTTIMEFORMAT= builtin history 1)
    return $s
  }
  __ssterm_prompt() {
    local s=$?
    [[ $PS1 == *'133;B'* ]] || PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
    return $s
  }
  __ssterm_report() {
    local line
    line=$(HISTTIMEFORMAT= builtin history 1)
    if [[ -n $line && $line != "$__ssterm_last" ]]; then
      line=${"${"}line#*[0-9]  }
      [[ $line == ' '* ]] || printf '\e]633;E;%s\a' "$(__ssterm_esc "$line")"
    fi
    printf '\e]133;C\a'
  }
  __ssterm_nl=$'\n'
  PROMPT_COMMAND="__ssterm_status$__ssterm_nl${"${"}PROMPT_COMMAND:+$PROMPT_COMMAND$__ssterm_nl}__ssterm_prompt"
  unset __ssterm_nl
  PS0='$(__ssterm_report)'"${"${"}PS0-}"
fi`,
  zsh: String.raw`# ssterm shell integration v1 for zsh 5.0+ (place at the end of ~/.zshrc).
# Marks the prompt (OSC 133) and reports each command line you run (OSC 633;E). It sends nothing
# anywhere: ssterm keeps a line only while Keep command history is on. Lines that start with a space
# or match $HISTORY_IGNORE are never reported.
if [[ -o interactive && -z ${"${"}__ssterm_si-} ]]; then
  typeset -g __ssterm_si=1 __ssterm_shown=
  __ssterm_esc() {
    local s=$1 out= c i
    for (( i = 1; i <= ${"${"}#s}; i++ )); do
      c=${"${"}s[i]}
      case $c in
        ('\') out+='\\' ;;
        (';') out+='\x3b' ;;
        ([[:cntrl:]]) out+=$(printf '\\x%02x' "'$c") ;;
        (*) out+=$c ;;
      esac
    done
    print -rn -- "$out"
  }
  __ssterm_precmd() {
    local s=$?
    [[ -n $__ssterm_shown ]] && print -rn -- $'\e]133;D;'"$s"$'\a'
    __ssterm_shown=1
    [[ $PS1 == *'133;B'* ]] || PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
    return $s
  }
  __ssterm_preexec() {
    if [[ -n $1 && $1 != ' '* ]] && ! [[ -n ${"${"}HISTORY_IGNORE-} && $1 == ${"${"}~HISTORY_IGNORE} ]]; then
      print -rn -- $'\e]633;E;'"$(__ssterm_esc "$1")"$'\a'
    fi
    print -rn -- $'\e]133;C\a'
  }
  autoload -Uz add-zsh-hook && add-zsh-hook precmd __ssterm_precmd && add-zsh-hook preexec __ssterm_preexec
fi`,
});

/** The declared shell matrix (docs/recording.md); anything else is unsupported and ships no snippet. */
export const SHELL_MATRIX: readonly { shell: string; where: string; status: string }[] = Object.freeze([
  { shell: 'bash 5.2', where: 'SSH (Debian fixture)', status: 'Supported, verified end to end' },
  { shell: 'zsh 5.9', where: 'This Mac', status: 'Supported, verified end to end' },
  { shell: 'zsh 5.x', where: 'SSH', status: 'Same snippet, not verified' },
  { shell: 'bash 4.4–5.1', where: 'Any', status: 'Same snippet, not verified' },
  { shell: 'bash 3.2 (macOS /bin/bash)', where: 'Any', status: 'Unsupported: the snippet does nothing' },
  { shell: 'fish, sh, dash, ksh, tcsh, nushell, PowerShell', where: 'Any', status: 'Unsupported' },
  { shell: 'Inside tmux or screen', where: 'Any', status: 'Unsupported' },
]);
