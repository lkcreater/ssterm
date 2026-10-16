import type { CSSProperties } from "react";
import type { ITerminalOptions } from "@xterm/xterm";

/** Terminal color ownership is independent of application semantic tokens. */
export const signalTerminalTheme = Object.freeze({
  background: "#0c1220",
  foreground: "#e5edfa",
  cursor: "#6a9fff",
  selection: "#243650",
  black: "#7087aa",
  red: "#e87979",
  green: "#62bd8a",
  yellow: "#e5b765",
  blue: "#6a9fff",
  magenta: "#c79af0",
  cyan: "#6bc8d9",
  white: "#d0daeb",
  brightBlack: "#91a4c1",
  brightRed: "#ffa3a3",
  brightGreen: "#92d9ad",
  brightYellow: "#f5d895",
  brightBlue: "#9cbeff",
  brightMagenta: "#dfbbff",
  brightCyan: "#a1e2ec",
  brightWhite: "#f6f8fc",
});
export const terminalAnsiKeys = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** Scrollback lines shared by the panes open when a pane is created (≈ 12 B × columns × line). */
export const SCROLLBACK_BUDGET = 320_000;
// ponytail: counts lines, not columns × lines; weight by width if wide panes dominate memory.
/** The saved setting, capped to this pane's share of the budget among `panes` mounted panes. */
export function effectiveScrollback(setting: number, panes: number): number {
  return Math.min(setting, Math.max(100, Math.floor(SCROLLBACK_BUDGET / Math.max(1, panes))));
}

export interface PaneScrollback {
  /** The setting the values below were computed from. */
  setting: number;
  panes: Readonly<Record<string, number>>;
}
/**
 * Lowering xterm's scrollback deletes history, so a pane keeps the share it was created with;
 * opening or closing other panes never changes it. Only a new setting re-applies to every pane.
 * Returns `state` itself when nothing changed.
 */
// ponytail: panes opened later can push the total past the budget; reclaim on close if memory matters.
export function paneScrollback(state: PaneScrollback, sessions: readonly string[], setting: number): PaneScrollback {
  const share = effectiveScrollback(setting, sessions.length);
  const reapply = setting !== state.setting;
  let changed = reapply || Object.keys(state.panes).length !== sessions.length;
  const panes: Record<string, number> = {};
  for (const id of sessions) {
    const kept = reapply ? undefined : state.panes[id];
    if (kept === undefined) changed = true;
    panes[id] = kept ?? share;
  }
  return changed ? { setting, panes } : state;
}

export const terminalFont =
  '"JetBrains Mono Variable", "Noto Sans Thai Variable", ui-monospace, monospace';
const { selection, ...terminalColors } = signalTerminalTheme;

/**
 * The declared trust boundary for remote bytes: they reach the screen only through xterm's
 * parser via `write(Uint8Array)`, never as HTML. Proposed APIs are enabled only for Unicode 11
 * widths and search decorations; neither feeds remote bytes anywhere else. No clipboard/OSC 52
 * addon is loaded. Links (web-links addon and http(s) OSC 8) are inert here; the pane replaces
 * `linkHandler` so only an explicit Cmd+click asks main to open the URL. Every window
 * manipulation/report stays off and logging is off so terminal content never reaches the console.
 */
export const xtermOptions = {
  theme: { ...terminalColors, selectionBackground: selection },
  fontFamily: terminalFont,
  fontSize: 13,
  lineHeight: 1.4,
  allowProposedApi: true,
  linkHandler: { activate() {} },
  windowOptions: {},
  logLevel: "off",
  macOptionIsMeta: false,
  macOptionClickForcesSelection: true,
} satisfies ITerminalOptions;

/**
 * Search match colors; xterm requires #RRGGBB. Matched text keeps its own ANSI color, so the
 * active match sits on the background lifted slightly (foreground 14.3:1, every ANSI color at
 * least 4.5:1) and is told apart by its amber border rather than a bright fill.
 */
export const terminalSearchDecorations = {
  matchBackground: signalTerminalTheme.selection,
  matchBorder: signalTerminalTheme.brightBlack,
  matchOverviewRuler: signalTerminalTheme.brightBlack,
  activeMatchBackground: "#141d30",
  activeMatchBorder: signalTerminalTheme.yellow,
  activeMatchColorOverviewRuler: signalTerminalTheme.yellow,
};

export const terminalStyle = {
  "--terminal-background": signalTerminalTheme.background,
  "--terminal-foreground": signalTerminalTheme.foreground,
  "--terminal-cursor": signalTerminalTheme.cursor,
  "--terminal-selection": signalTerminalTheme.selection,
  "--terminal-font": terminalFont,
  "--terminal-size": "13px",
  "--terminal-line-height": "1.4",
} as CSSProperties;
