/** Local input policy for a terminal pane. Pure, so every rule is unit-tested without xterm. */
import { MAX_TERMINAL_WRITE } from "@ssterm/contracts";

export const MAX_PASTE_BYTES = 256 * 1024;
// A paste arrives as one onData call no larger than MAX_TERMINAL_WRITE and is sent as one write,
// so main accepts or refuses it whole; the extra room is for typing queued around it.
export const MAX_QUEUED_INPUT = MAX_TERMINAL_WRITE + 32_768;

// C0 except HT/LF/CR, DEL and C1. Removing ESC is what stops a pasted `ESC[201~` from ending
// bracketed paste early; the remaining `[201~` is inert text. Bidi embeddings, overrides and
// isolates go too: they can make the preview read differently from the bytes sent. ZWJ and
// variation selectors stay, since emoji need them.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const NEWLINE = /\r\n|\r|\n/;

export function sanitizePaste(text: string): { text: string; removed: boolean } {
  const clean = text.replace(CONTROLS, "");
  return { text: clean, removed: clean.length !== text.length };
}

/** Any newline, including a lone trailing one, presses Enter unless the shell brackets the paste. */
export function hasNewline(text: string): boolean {
  return NEWLINE.test(text);
}

/** Lines as the user sees them; a single trailing newline does not add an empty line. */
export function pasteLines(text: string): string[] {
  return text.replace(/(\r\n|\r|\n)$/, "").split(NEWLINE);
}

export type PasteDecision =
  | { kind: "empty" }
  | { kind: "refuse"; reason: "too-large" }
  | { kind: "confirm"; lines: number }
  | { kind: "paste"; lines: number };

/**
 * Any newline can run a command unless the shell brackets the paste, so multi-line text is
 * confirmed when bracketing is off, the target is PROD, or the sanitizer changed the text.
 * Changed single-line text is confirmed too, so the user sees what will actually be sent.
 */
export function pasteDecision({
  text,
  removed,
  bracketed,
  production,
  maxBytes = MAX_PASTE_BYTES,
}: {
  text: string;
  removed: boolean;
  bracketed: boolean;
  production: boolean;
  maxBytes?: number;
}): PasteDecision {
  if (text.length === 0) return { kind: "empty" };
  // UTF-8 is never shorter than UTF-16 code units, so a long string is refused without encoding.
  if (text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes)
    return { kind: "refuse", reason: "too-large" };
  const lines = pasteLines(text).length;
  const multiline = hasNewline(text);
  if (removed || (multiline && (!bracketed || production))) return { kind: "confirm", lines };
  return { kind: "paste", lines };
}

interface KeyLike {
  type: string;
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The allowlist of keys the pane takes from xterm. Only Cmd+F; Ctrl and Option combinations are
 * terminal input, and Cmd+C/V/A keep their native Edit-menu paths. The physical F key counts
 * when the layout gives a non-Latin character (Thai Kedmanee gives "ด"); a Latin layout that
 * moves F (Dvorak) is matched by its character instead.
 */
export function terminalShortcut(event: KeyLike): "search" | null {
  return event.type === "keydown" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key.toLowerCase() === "f" || (event.code === "KeyF" && !/^[a-z]$/i.test(event.key)))
    ? "search"
    : null;
}

/** xterm activates links on a plain mouseup; only an explicit Cmd+click may open one. */
export function isLinkActivation(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey && !event.ctrlKey;
}
