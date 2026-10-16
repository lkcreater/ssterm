import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MAX_PASTE_BYTES,
  MAX_QUEUED_INPUT,
  isLinkActivation,
  pasteDecision,
  pasteLines,
  sanitizePaste,
  terminalShortcut,
} from "../../apps/desktop/src/renderer/src/lib/terminal-input.ts";
import {
  signalTerminalTheme,
  terminalAnsiKeys,
  terminalSearchDecorations,
} from "../../apps/desktop/src/renderer/src/lib/terminal-theme.ts";
import { MAX_TERMINAL_WRITE } from "../../packages/contracts/src/index.ts";

test("sanitizePaste keeps text, tabs and newlines and removes C0, DEL and C1", () => {
  assert.deepEqual(sanitizePaste("ls -la\tสวัสดี 👍\r\nexit\n"), {
    text: "ls -la\tสวัสดี 👍\r\nexit\n",
    removed: false,
  });
  const all = Array.from({ length: 0xa0 }, (_, code) => String.fromCharCode(code)).join("");
  const kept = sanitizePaste(all).text;
  assert.deepEqual(
    [...kept].map((char) => char.charCodeAt(0)).filter((code) => code < 0x20 || code >= 0x7f),
    [0x09, 0x0a, 0x0d],
  );
  assert.equal(kept.length, 3 + (0x7f - 0x20));
  assert.equal(sanitizePaste("a\u0000b\u007fc\u0085d\u009be").text, "abcde");
  assert.equal(sanitizePaste(" é").removed, false, "U+00A0 and above are text");
});

test("sanitizePaste removes bidi embeddings, overrides and isolates but keeps emoji joiners", () => {
  const spoof = "echo \u202eoof\u202c \u2066x\u2069 \u202a\u202b\u202d\u2067\u2068";
  assert.deepEqual(sanitizePaste(spoof), { text: "echo oof x ", removed: true });
  const emoji = "👩\u200d💻 \u2764\ufe0f 1\ufe0f\u20e3";
  assert.deepEqual(sanitizePaste(emoji), { text: emoji, removed: false });
});

test("a pasted end-of-bracket sequence cannot escape bracketed paste", () => {
  const attack = "safe\u001b[201~\nrm -rf ~\n";
  const { text, removed } = sanitizePaste(attack);
  assert.equal(removed, true);
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text, "safe[201~\nrm -rf ~\n");
  assert.equal(sanitizePaste("\u009b201~").text, "201~", "the 8-bit CSI is removed as well");
});

test("pasteDecision pastes single lines and bracketed non-PROD multi-line text directly", () => {
  const base = { removed: false, bracketed: false, production: false };
  assert.deepEqual(pasteDecision({ ...base, text: "echo hi" }), { kind: "paste", lines: 1 });
  assert.deepEqual(pasteDecision({ ...base, text: "echo hi", production: true }), {
    kind: "paste",
    lines: 1,
  });
  assert.deepEqual(pasteDecision({ ...base, text: "a\nb\nc", bracketed: true }), {
    kind: "paste",
    lines: 3,
  });
});

test("pasteDecision confirms text that could run commands or that the sanitizer changed", () => {
  const base = { removed: false, bracketed: true, production: false };
  assert.deepEqual(pasteDecision({ ...base, text: "a\nb", bracketed: false }), {
    kind: "confirm",
    lines: 2,
  });
  assert.deepEqual(pasteDecision({ ...base, text: "ls\n", bracketed: false }), {
    kind: "confirm",
    lines: 1,
  }, "a trailing newline alone would press Enter");
  assert.deepEqual(pasteDecision({ ...base, text: "a\r\nb", production: true }), {
    kind: "confirm",
    lines: 2,
  });
  assert.deepEqual(pasteDecision({ ...base, text: "a", removed: true }), {
    kind: "confirm",
    lines: 1,
  });
  assert.equal(pasteDecision({ ...base, text: "a\rb", bracketed: false }).kind, "confirm");
});

test("pasteDecision refuses over 256 KiB of UTF-8 and ignores empty text", () => {
  const base = { removed: false, bracketed: true, production: false };
  assert.equal(MAX_PASTE_BYTES, 262_144);
  assert.equal(pasteDecision({ ...base, text: "x".repeat(MAX_PASTE_BYTES) }).kind, "paste");
  assert.deepEqual(pasteDecision({ ...base, text: "x".repeat(MAX_PASTE_BYTES + 1) }), {
    kind: "refuse",
    reason: "too-large",
  });
  // 3 bytes per Thai character: under the limit in characters, over it in bytes.
  const thai = "ก".repeat(Math.floor(MAX_PASTE_BYTES / 3) + 1);
  assert.ok(thai.length < MAX_PASTE_BYTES);
  assert.equal(pasteDecision({ ...base, text: thai }).kind, "refuse");
  assert.equal(pasteDecision({ ...base, text: "abcd", maxBytes: 3 }).kind, "refuse");
  assert.deepEqual(pasteDecision({ ...base, text: "", removed: true }), { kind: "empty" });
});

test("a maximum bracketed paste fits one terminal write and the renderer input queue", () => {
  // ESC[200~ + text + ESC[201~: one write means main accepts or refuses the paste whole.
  assert.ok(MAX_TERMINAL_WRITE >= MAX_PASTE_BYTES + 12);
  assert.ok(MAX_QUEUED_INPUT >= MAX_PASTE_BYTES + 12);
});

test("pasteLines splits every newline form and ignores one trailing newline", () => {
  assert.deepEqual(pasteLines("a\r\nb\rc\nd\n"), ["a", "b", "c", "d"]);
  assert.deepEqual(pasteLines("a\n\n"), ["a", ""]);
});

const key = (key: string, modifiers: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}, type = "keydown", code?: string) => ({
  type,
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

test("terminalShortcut takes only Cmd+F keydown", () => {
  assert.equal(terminalShortcut(key("f", { metaKey: true })), "search");
  assert.equal(terminalShortcut(key("F", { metaKey: true })), "search");
  assert.equal(terminalShortcut(key("f", { metaKey: true }, "keyup")), null);
  assert.equal(terminalShortcut(key("f", { metaKey: true }, "keypress")), null);
  assert.equal(terminalShortcut(key("f", { ctrlKey: true })), null, "Ctrl+F is readline forward-char");
  assert.equal(terminalShortcut(key("ƒ", { altKey: true })), null);
  assert.equal(terminalShortcut(key("f", { metaKey: true, altKey: true })), null);
  assert.equal(terminalShortcut(key("f", { metaKey: true, ctrlKey: true })), null);
  assert.equal(terminalShortcut(key("f", { metaKey: true, shiftKey: true })), null);
  assert.equal(terminalShortcut(key("f")), null);
  for (const pass of ["c", "v", "a", "k", "w"])
    assert.equal(terminalShortcut(key(pass, { metaKey: true })), null, `Cmd+${pass} passes through`);
});

test("terminalShortcut finds the physical F key under non-Latin layouts", () => {
  assert.equal(terminalShortcut(key("ด", { metaKey: true }, "keydown", "KeyF")), "search", "Thai Kedmanee");
  assert.equal(terminalShortcut(key("а", { metaKey: true }, "keydown", "KeyF")), "search", "Russian");
  assert.equal(terminalShortcut(key("ด", { ctrlKey: true }, "keydown", "KeyF")), null);
  assert.equal(terminalShortcut(key("ด", { metaKey: true, altKey: true }, "keydown", "KeyF")), null);
  assert.equal(terminalShortcut(key("ด", { metaKey: true }, "keyup", "KeyF")), null);
  // Dvorak: the F position types "u", and "f" lives on KeyY.
  assert.equal(terminalShortcut(key("u", { metaKey: true }, "keydown", "KeyF")), null);
  assert.equal(terminalShortcut(key("f", { metaKey: true }, "keydown", "KeyY")), "search");
});

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((at) => {
      const value = parseInt(hex.slice(at, at + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

test("the active search match keeps the foreground and every ANSI color readable", () => {
  const background = terminalSearchDecorations.activeMatchBackground;
  assert.ok(contrast(signalTerminalTheme.foreground, background) >= 14, "foreground at least 14:1");
  for (const name of terminalAnsiKeys)
    assert.ok(contrast(signalTerminalTheme[name], background) >= 4.5, `${name} at least 4.5:1`);
  assert.ok(
    contrast(terminalSearchDecorations.activeMatchBorder, background) >= 3,
    "the amber border is what marks the active match",
  );
});

test("only Cmd+click activates a link", () => {
  assert.equal(isLinkActivation({ metaKey: true, ctrlKey: false }), true);
  assert.equal(isLinkActivation({ metaKey: false, ctrlKey: false }), false);
  assert.equal(isLinkActivation({ metaKey: false, ctrlKey: true }), false);
  assert.equal(isLinkActivation({ metaKey: true, ctrlKey: true }), false);
});
