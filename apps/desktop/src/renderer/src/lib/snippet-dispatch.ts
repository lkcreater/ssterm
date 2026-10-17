/**
 * How a snippet becomes terminal bytes (SST-024). Pure, so every rule is unit-tested without xterm.
 *
 * - The text is sanitized like a clipboard paste (`sanitizePaste`).
 * - CRLF, LF and lone CR all become CR, as a terminal Enter and xterm's own paste do.
 * - With the shell's bracketed-paste mode on, the text is wrapped in `ESC[200~ … ESC[201~`.
 * - **Insert** sends the text only. **Run** drops one trailing line break and appends exactly one CR
 *   after the closing bracket, so the shell receives the text and then one Enter.
 * - Nothing here claims the remote command ran: bytes accepted by the session are all ssterm knows.
 */
import { hasNewline, MAX_PASTE_BYTES, pasteLines, sanitizePaste } from "./terminal-input";

export type DispatchMode = "insert" | "run";
export type DispatchPlan =
  | { kind: "empty" }
  | { kind: "refuse"; reason: "too-large" }
  | { kind: "send" | "confirm"; bytes: Uint8Array; lines: number; removed: boolean; reasons: ConfirmReason[] };
/** Why Run asks first. */
export type ConfirmReason = "production" | "removed" | "line-by-line";

const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";

export function planDispatch({
  text,
  mode,
  bracketed,
  production,
  maxBytes = MAX_PASTE_BYTES,
}: {
  text: string;
  mode: DispatchMode;
  bracketed: boolean;
  production: boolean;
  maxBytes?: number;
}): DispatchPlan {
  const clean = sanitizePaste(text);
  let body = clean.text;
  if (mode === "run") body = body.replace(/(\r\n|\r|\n)$/u, "");
  if (body.length === 0) return { kind: "empty" };
  if (body.length > maxBytes || new TextEncoder().encode(body).byteLength > maxBytes) return { kind: "refuse", reason: "too-large" };
  const lines = pasteLines(body).length;
  const multiline = hasNewline(body);
  const normalized = body.replace(/\r\n|\n/gu, "\r");
  const wrapped = bracketed ? `${OPEN}${normalized}${CLOSE}` : normalized;
  const bytes = new TextEncoder().encode(mode === "run" ? `${wrapped}\r` : wrapped);
  const reasons: ConfirmReason[] = [];
  if (production && mode === "run") reasons.push("production");
  if (clean.removed) reasons.push("removed");
  // Without bracketing every line break runs a line immediately, for Insert as much as Run.
  if (multiline && !bracketed) reasons.push("line-by-line");
  return { kind: reasons.length ? "confirm" : "send", bytes, lines, removed: clean.removed, reasons };
}

export const linesText = (lines: number) => `${lines} ${lines === 1 ? "line" : "lines"}`;
