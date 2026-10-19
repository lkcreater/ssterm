/**
 * Streaming OSC 633;E recognizer over raw terminal output, one instance per terminal generation. It mirrors the
 * xterm.js 6 EscapeSequenceParser transitions that decide where an OSC starts and ends:
 *   start     ESC ] or C1 OSC (U+009D, UTF-8 C2 9D) from any state
 *   dispatch  BEL, C1 ST (U+009C), or ESC (xterm dispatches, then parses the ESC)
 *   abort     CAN, SUB, any other C1 control
 *   ignore    other C0 controls inside the payload
 * Every marker is remote-asserted, so a parser difference only adds or misses a suggestion; the mirror keeps
 * fidelity, not trust. Memory is O(1): only a payload that still starts with "633;E;" is buffered, up to a cap.
 */
import { isCommandText, MAX_COMMAND_BYTES } from '@ssterm/domain/recording';

declare const recordable: unique symbol;
/** A command line that passed every recording rule. Only `decodeCommandLine` makes one. */
export type RecordableCommand = string & { readonly [recordable]: true };

const PREFIX = new TextEncoder().encode('633;E;');
/** Escaped field bytes ("\xHH" is four bytes for one). A longer payload is skipped, never truncated. */
export const MAX_ESCAPED_FIELD = 8_192;
const CAPACITY = PREFIX.length + MAX_ESCAPED_FIELD;
const enum State { Ground, Escape, Osc, Skip }
const NONE: readonly RecordableCommand[] = Object.freeze([]);

export class CommandScanner {
  #state = State.Ground;
  /** The previous byte was 0xC2, a possible UTF-8 lead of a C1 control; carried across frames. */
  #c2 = false;
  readonly #payload = new Uint8Array(CAPACITY);
  #length = 0;

  /** Synchronous and O(chunk.length); most frames return the shared empty array. */
  feed(chunk: Uint8Array): readonly RecordableCommand[] {
    let found: RecordableCommand[] | undefined;
    let nextEscape = -1;
    let nextLead = -1;
    for (let i = 0; i < chunk.length; i++) {
      if (this.#state === State.Ground && !this.#c2) {
        // Only ESC or a C2 lead can leave Ground: skip plain text with native scans, each cached until passed.
        if (nextEscape < i) { nextEscape = chunk.indexOf(0x1b, i); if (nextEscape < 0) nextEscape = chunk.length; }
        if (nextLead < i) { nextLead = chunk.indexOf(0xc2, i); if (nextLead < 0) nextLead = chunk.length; }
        i = Math.min(nextEscape, nextLead);
        if (i >= chunk.length) break;
      }
      const byte = chunk[i]!;
      const c1 = this.#c2 && byte >= 0x80 && byte <= 0x9f;
      this.#c2 = byte === 0xc2;
      // The C2 lead of a C1 control was buffered as payload; it is part of the control, not the text.
      if (c1 && this.#state === State.Osc && this.#length > 0) this.#length--;
      if (c1 && byte === 0x9d) { this.#start(); continue; }
      switch (this.#state) {
        case State.Ground:
          if (byte === 0x1b) this.#state = State.Escape;
          break;
        case State.Escape:
          if (byte === 0x5d) this.#start();
          else if (byte !== 0x1b) this.#state = State.Ground;
          break;
        default:
          if (byte === 0x07 || byte === 0x1b || (c1 && byte === 0x9c)) {
            const command = this.#state === State.Osc ? this.#dispatch() : undefined;
            if (command !== undefined) (found ??= []).push(command);
            this.#state = byte === 0x1b ? State.Escape : State.Ground;
          } else if (byte === 0x18 || byte === 0x1a || c1) this.#state = State.Ground;
          else if (byte >= 0x20 && this.#state === State.Osc) {
            if (this.#length >= CAPACITY) this.#state = State.Skip;
            else {
              this.#payload[this.#length++] = byte;
              if (this.#length <= PREFIX.length && byte !== PREFIX[this.#length - 1]) this.#state = State.Skip;
            }
          }
      }
    }
    return found ?? NONE;
  }
  #start(): void {
    this.#state = State.Osc;
    this.#length = 0;
  }
  #dispatch(): RecordableCommand | undefined {
    if (this.#length < PREFIX.length) return undefined;
    let field = this.#payload.subarray(PREFIX.length, this.#length);
    // A raw ";" starts VS Code's optional nonce; an escaped one is "\x3b".
    const separator = field.indexOf(0x3b);
    if (separator >= 0) field = field.subarray(0, separator);
    const command = decodeCommandLine(field);
    this.#payload.fill(0, 0, this.#length);
    this.#length = 0;
    return command;
  }
}

const hex = (byte: number | undefined) =>
  byte === undefined ? -1 : byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : (byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x66 ? (byte | 0x20) - 0x57 : -1;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The one place that decides whether a reported line may be recorded. Drops: a bad escape, invalid UTF-8, more than
 * MAX_COMMAND_BYTES, blank, a leading space, any control (so multi-line lines), bidi/format controls, and lines
 * that look like they carry a credential.
 */
export function decodeCommandLine(field: Uint8Array): RecordableCommand | undefined {
  const bytes = new Uint8Array(field.length);
  let length = 0;
  for (let i = 0; i < field.length; i++) {
    const byte = field[i]!;
    if (byte !== 0x5c) { bytes[length++] = byte; continue; }
    if (field[i + 1] === 0x5c) { bytes[length++] = 0x5c; i += 1; continue; }
    const high = hex(field[i + 2]), low = hex(field[i + 3]);
    if (field[i + 1] !== 0x78 || high < 0 || low < 0) return undefined;
    bytes[length++] = high * 16 + low;
    i += 3;
  }
  if (length > MAX_COMMAND_BYTES) return undefined;
  let text: string;
  try { text = decoder.decode(bytes.subarray(0, length)); } catch { return undefined; } finally { bytes.fill(0); }
  return isCommandText(text) && !sensitiveCommand(text) ? text as RecordableCommand : undefined;
}

// Best effort and documented as such: a match drops the whole line, it is never masked.
const SENSITIVE: readonly RegExp[] = [
  /(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|bearer)[a-z0-9_]*\s*[=:]/iu,
  /(?:^|\s)--?(?:password|passwd|pass|token|secret|api-key)(?:[=\s]|$)/iu,
  /\b(?:mysql|mariadb|mysqldump|mysqladmin)\b.*\s-p\S/iu,
  /\bsshpass\b/iu,
  /\bcurl\b.*\s(?:-u|--user)[\s=]*\S+:\S/iu,
  /\bauthorization\s*:/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY/iu,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/u,
  /\bxox[abprs]-[A-Za-z0-9-]+/u,
  /\bsk-[A-Za-z0-9_-]{20,}/u,
  /\beyJ[\w-]+\.[\w-]+\./u,
];
export function sensitiveCommand(text: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(text));
}
