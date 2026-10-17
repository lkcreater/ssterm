/** Workspace keyboard shortcuts. Pure, so every layout case is unit-tested without a DOM. */
import type { PaneDirection, SplitDirection } from "./workspace-layout.ts";

export type WorkspaceShortcut =
  | { kind: "split"; direction: SplitDirection }
  | { kind: "close-pane" }
  | { kind: "toggle-mode" }
  | { kind: "focus-pane"; direction: PaneDirection }
  | { kind: "tab"; index: number | "last" }
  | { kind: "cycle-tab"; step: 1 | -1 }
  | { kind: "toggle-sidebar" }
  | { kind: "settings" }
  | { kind: "shortcuts" }
  | { kind: "snippets" };

interface KeyLike {
  type: string;
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

const symbols: Record<string, string> = { Comma: ",", Slash: "/", BracketLeft: "[", BracketRight: "]" };
const arrows: Record<string, PaneDirection> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * A Latin layout (QWERTY, Dvorak, AZERTY) is matched by the character it types, so Cmd+Z on
 * AZERTY never closes a pane; a non-Latin layout (Thai Kedmanee, Russian) types its own
 * character, so the physical key decides.
 */
function letter({ key, code }: KeyLike): string | null {
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  if (/^[\x20-\x7e]$/.test(key)) return null;
  return /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : null;
}
function symbol({ key, code }: KeyLike): string | null {
  const typed = key === "{" ? "[" : key === "}" ? "]" : key;
  if (Object.values(symbols).includes(typed)) return typed;
  // A letter or digit typed on that key means a Latin layout moved it (Dvorak Z sits on Slash).
  if (/^[a-z0-9]$/i.test(key)) return null;
  return symbols[code] ?? null;
}

/**
 * Every shortcut needs Cmd; Ctrl and Option combinations without it stay terminal input.
 * Digits use the physical key: AZERTY and Thai type other characters there.
 */
export function workspaceShortcut(event: KeyLike): WorkspaceShortcut | null {
  if (event.type !== "keydown" || event.isComposing || !event.metaKey) return null;
  const modifiers = `${event.ctrlKey ? "ctrl+" : ""}${event.altKey ? "alt+" : ""}${event.shiftKey ? "shift" : ""}`;
  switch (modifiers) {
    case "": {
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit) return { kind: "tab", index: digit === "9" ? "last" : Number(digit) - 1 };
      const char = letter(event);
      if (char === "d") return { kind: "split", direction: "row" };
      if (char === "w") return { kind: "close-pane" };
      const mark = symbol(event);
      if (mark === ",") return { kind: "settings" };
      if (mark === "/") return { kind: "shortcuts" };
      return null;
    }
    case "shift": {
      if (event.code === "Enter" || event.code === "NumpadEnter") return { kind: "toggle-mode" };
      if (letter(event) === "d") return { kind: "split", direction: "column" };
      if (letter(event) === "s") return { kind: "snippets" };
      const mark = symbol(event);
      if (mark === "]") return { kind: "cycle-tab", step: 1 };
      if (mark === "[") return { kind: "cycle-tab", step: -1 };
      return null;
    }
    case "alt+": {
      const direction = arrows[event.code];
      return direction ? { kind: "focus-pane", direction } : null;
    }
    case "ctrl+":
      return letter(event) === "s" ? { kind: "toggle-sidebar" } : null;
    default:
      return null;
  }
}
