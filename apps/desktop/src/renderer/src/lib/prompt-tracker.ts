/**
 * SST-034: the renderer's only use of shell integration. OSC 133 marks locate the editable command line so ⌘; can
 * read what is typed after the prompt; they never supply recorded content (main reads OSC 633;E itself). The
 * handler is synchronous, sends nothing and only moves one buffer marker, so the xterm trust boundary is unchanged
 * in kind: a forged mark can only move where the prefix starts.
 */
import { isDisplayText, MAX_SUGGEST_PREFIX_BYTES, promptMark } from "@ssterm/contracts";

interface Marker { readonly line: number; readonly isDisposed: boolean; dispose(): void }
interface BufferLine { readonly isWrapped: boolean; translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string }
export interface PromptTerminal {
  parser: { registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): { dispose(): void } };
  registerMarker(cursorYOffset?: number): Marker | undefined;
  buffer: { active: { type: string; cursorX: number; cursorY: number; baseY: number; getLine(y: number): BufferLine | undefined } };
}
export interface PromptTracker {
  /**
   * The text between the last OSC 133;B and the cursor (wrapped rows joined), or null when the shell is not at an
   * integrated prompt: no mark since the last C/D, the alternate screen, the cursor before the mark, or the mark
   * scrolled out of the buffer.
   */
  prefix(): string | null;
  reset(): void;
  dispose(): void;
}

export function trackPrompt(term: PromptTerminal): PromptTracker {
  let marker: Marker | undefined;
  let column = 0;
  const reset = () => {
    marker?.dispose();
    marker = undefined;
  };
  const handler = term.parser.registerOscHandler(133, (data) => {
    const mark = promptMark(data);
    if (mark === "B") {
      reset();
      marker = term.registerMarker(0);
      column = term.buffer.active.cursorX;
    } else if (mark) reset();
    return true;
  });
  return {
    prefix() {
      const buffer = term.buffer.active;
      if (!marker || marker.isDisposed || marker.line < 0 || buffer.type !== "normal") return null;
      const cursor = buffer.baseY + buffer.cursorY;
      if (cursor < marker.line || (cursor === marker.line && buffer.cursorX < column)) return null;
      let text = "";
      for (let y = marker.line; y <= cursor; y++) {
        const line = buffer.getLine(y);
        if (!line || (y > marker.line && !line.isWrapped)) return null;
        text += line.translateToString(false, y === marker.line ? column : 0, y === cursor ? buffer.cursorX : undefined);
        if (text.length > MAX_SUGGEST_PREFIX_BYTES) return null;
      }
      return isDisplayText(text, MAX_SUGGEST_PREFIX_BYTES) ? text : null;
    },
    reset,
    dispose() {
      reset();
      handler.dispose();
    },
  };
}
