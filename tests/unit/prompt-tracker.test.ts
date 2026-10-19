import { strict as assert } from "node:assert";
import { test } from "node:test";
import { trackPrompt, type PromptTerminal } from "../../apps/desktop/src/renderer/src/lib/prompt-tracker.ts";

/** A minimal buffer: rows of text (wrapped flags), a cursor and markers that follow absolute rows. */
function fakeTerminal(columns = 20) {
  const rows: { text: string; wrapped: boolean }[] = [{ text: "", wrapped: false }];
  let handler: ((data: string) => boolean | Promise<boolean>) | undefined;
  const buffer = { type: "normal", cursorX: 0, cursorY: 0, baseY: 0,
    getLine: (y: number) => rows[y] && { isWrapped: rows[y]!.wrapped,
      translateToString: (_trim?: boolean, start = 0, end = columns) => rows[y]!.text.padEnd(columns).slice(start, end) } };
  const term: PromptTerminal = {
    parser: { registerOscHandler: (ident, callback) => { assert.equal(ident, 133); handler = callback; return { dispose: () => { handler = undefined; } }; } },
    registerMarker: () => { const line = buffer.baseY + buffer.cursorY; let disposed = false; return { line, get isDisposed() { return disposed; }, dispose: () => { disposed = true; } }; },
    buffer: { active: buffer },
  };
  const type = (text: string) => {
    for (const char of text) {
      if (buffer.cursorX === columns) { rows.push({ text: "", wrapped: true }); buffer.cursorY += 1; buffer.cursorX = 0; }
      const row = rows[buffer.baseY + buffer.cursorY]!;
      row.text = row.text.padEnd(buffer.cursorX) + char;
      buffer.cursorX += 1;
    }
  };
  const newline = () => { rows.push({ text: "", wrapped: false }); buffer.cursorY += 1; buffer.cursorX = 0; };
  return { term, buffer, type, newline, mark: (data: string) => handler?.(data) };
}

test("the tracker reads what is typed after OSC 133;B, across wrapped rows, and nothing elsewhere", () => {
  const f = fakeTerminal();
  const prompt = trackPrompt(f.term);
  assert.equal(prompt.prefix(), null, "no integrated prompt yet");
  f.mark("A");
  f.type("user@host:~$ ");
  assert.equal(f.mark("B"), true, "handled synchronously");
  assert.equal(prompt.prefix(), "");
  f.type("git sta");
  assert.equal(prompt.prefix(), "git sta");
  f.type("tus --short and more");
  assert.equal(prompt.prefix(), "git status --short and more", "wrapped rows join");
  f.mark("C");
  assert.equal(prompt.prefix(), null, "a running command is not a prompt");
  f.newline();
  f.mark("D;0");
  f.mark("A");
  f.type("$ ");
  f.mark("B");
  f.type("ls");
  f.newline();
  f.type("> ");
  assert.equal(prompt.prefix(), null, "a continuation line on a new, unwrapped row is not the prompt line");
  f.mark("B");
  f.buffer.type = "alternate";
  assert.equal(prompt.prefix(), null, "full-screen programs never offer suggestions");
  f.buffer.type = "normal";
  f.type("\u0007bell");
  assert.equal(prompt.prefix(), null, "controls in the prefix refuse it");
  prompt.reset();
  assert.equal(prompt.prefix(), null);
  prompt.dispose();
  assert.equal(f.mark("B"), undefined, "the handler is gone after dispose");
});
