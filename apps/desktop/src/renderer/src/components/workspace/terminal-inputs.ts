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
   * generation moved on, or the write was refused (which pauses the pane, as for typing); `partial` when only the
   * text up to the first Return was written (an agent command's password prompt took it) and the rest was dropped.
   * Copies bytes synchronously before returning; callers may wipe their buffer immediately. The pane
   * owns and purges its queued copy on acceptance, refusal, generation change or disposal.
   */
  deliver(bytes: Uint8Array, generation: number): Promise<DeliverOutcome>;
}
export type DeliverOutcome = "sent" | "partial" | "refused";
export type TerminalInputs = Map<string, TerminalInputHandle>;
export const TerminalInputsContext = createContext<TerminalInputs | null>(null);
