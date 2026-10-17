import { createContext } from "react";

/**
 * A pane's input, for actions outside the pane (snippets). Bytes join the pane's own ordered queue, so they
 * never overtake or interleave with typing, and follow the same pause rules.
 */
export interface TerminalInputHandle {
  /** The session generation the pane currently streams; bytes for another generation are never sent. */
  readonly generation: number;
  /** Ready, not paused, and the view is live. */
  accepting(): boolean;
  /** The shell's bracketed-paste mode (DECSET 2004), as xterm tracks it. */
  bracketed(): boolean;
  /**
   * `sent` once main accepted the write for `generation`; `refused` if the pane is not accepting, the
   * generation moved on, or the write was refused (which pauses the pane, as for typing).
   */
  deliver(bytes: Uint8Array, generation: number): Promise<"sent" | "refused">;
}
export type TerminalInputs = Map<string, TerminalInputHandle>;
export const TerminalInputsContext = createContext<TerminalInputs | null>(null);
