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

export const terminalFont =
  '"JetBrains Mono Variable", "Noto Sans Thai Variable", ui-monospace, monospace';
const { selection, ...terminalColors } = signalTerminalTheme;

/**
 * The declared trust boundary for remote bytes: they reach the screen only through xterm's
 * parser via `write(Uint8Array)`, never as HTML. OSC 8 links never open anything (URL actions
 * are SST-013), every window manipulation/report stays off, and no clipboard/OSC 52 or
 * web-links addon is loaded. Logging is off so terminal content never reaches the console.
 */
export const xtermOptions = {
  theme: { ...terminalColors, selectionBackground: selection },
  fontFamily: terminalFont,
  fontSize: 13,
  lineHeight: 1.4,
  scrollback: 10_000,
  allowProposedApi: false,
  linkHandler: { activate() {} },
  windowOptions: {},
  logLevel: "off",
} satisfies ITerminalOptions;

export const terminalStyle = {
  "--terminal-background": signalTerminalTheme.background,
  "--terminal-foreground": signalTerminalTheme.foreground,
  "--terminal-cursor": signalTerminalTheme.cursor,
  "--terminal-selection": signalTerminalTheme.selection,
  "--terminal-font": terminalFont,
  "--terminal-size": "13px",
  "--terminal-line-height": "1.4",
} as CSSProperties;
