import { strict as assert } from "node:assert";
import { test } from "node:test";
import { workspaceShortcut } from "../../apps/desktop/src/renderer/src/lib/workspace-shortcuts.ts";

type Modifiers = Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing", boolean>>;
const key = (key: string, code: string, modifiers: Modifiers = {}, type = "keydown") => ({
  type,
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});
const cmd = { metaKey: true };
const shiftCmd = { metaKey: true, shiftKey: true };

test("workspace shortcuts on a US layout", () => {
  assert.deepEqual(workspaceShortcut(key("d", "KeyD", cmd)), { kind: "split", direction: "row" });
  assert.deepEqual(workspaceShortcut(key("D", "KeyD", shiftCmd)), { kind: "split", direction: "column" });
  assert.deepEqual(workspaceShortcut(key("w", "KeyW", cmd)), { kind: "close-pane" });
  assert.deepEqual(workspaceShortcut(key("Enter", "Enter", shiftCmd)), { kind: "toggle-mode" });
  assert.deepEqual(workspaceShortcut(key("Enter", "NumpadEnter", shiftCmd)), { kind: "toggle-mode" });
  for (const [code, direction] of [
    ["ArrowLeft", "left"],
    ["ArrowRight", "right"],
    ["ArrowUp", "up"],
    ["ArrowDown", "down"],
  ] as const)
    assert.deepEqual(workspaceShortcut(key(code, code, { metaKey: true, altKey: true })), { kind: "focus-pane", direction });
  for (let digit = 1; digit <= 8; digit += 1)
    assert.deepEqual(workspaceShortcut(key(String(digit), `Digit${digit}`, cmd)), { kind: "tab", index: digit - 1 });
  assert.deepEqual(workspaceShortcut(key("9", "Digit9", cmd)), { kind: "tab", index: "last" });
  assert.deepEqual(workspaceShortcut(key("}", "BracketRight", shiftCmd)), { kind: "cycle-tab", step: 1 });
  assert.deepEqual(workspaceShortcut(key("{", "BracketLeft", shiftCmd)), { kind: "cycle-tab", step: -1 });
  assert.deepEqual(workspaceShortcut(key("s", "KeyS", { metaKey: true, ctrlKey: true })), { kind: "toggle-sidebar" });
  assert.deepEqual(workspaceShortcut(key(",", "Comma", cmd)), { kind: "settings" });
  assert.deepEqual(workspaceShortcut(key("/", "Slash", cmd)), { kind: "shortcuts" });
  assert.deepEqual(workspaceShortcut(key("S", "KeyS", shiftCmd)), { kind: "snippets" });
  assert.deepEqual(workspaceShortcut(key("ห", "KeyS", shiftCmd)), { kind: "snippets" }, "Thai Kedmanee uses the physical key");
  assert.equal(workspaceShortcut(key("s", "KeyS", cmd)), null, "plain Cmd+S is not a workspace shortcut");
});

test("Ctrl and Option combinations without Cmd stay terminal input", () => {
  for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }, {}])
    for (const [char, code] of [["d", "KeyD"], ["w", "KeyW"], ["s", "KeyS"], ["1", "Digit1"], ["ArrowLeft", "ArrowLeft"]])
      assert.equal(workspaceShortcut(key(char, code, modifiers)), null, `${JSON.stringify(modifiers)} ${code}`);
});

test("extra or missing modifiers, other events and IME composition never match", () => {
  assert.equal(workspaceShortcut(key("W", "KeyW", shiftCmd)), null, "Shift+Cmd+W is the menu's Close Window");
  assert.equal(workspaceShortcut(key("d", "KeyD", { metaKey: true, altKey: true })), null);
  assert.equal(workspaceShortcut(key("d", "KeyD", { metaKey: true, ctrlKey: true })), null);
  assert.equal(workspaceShortcut(key("ArrowLeft", "ArrowLeft", cmd)), null, "Cmd+Left is line start");
  assert.equal(workspaceShortcut(key("ArrowLeft", "ArrowLeft", { metaKey: true, altKey: true, shiftKey: true })), null);
  assert.equal(workspaceShortcut(key("s", "KeyS", cmd)), null);
  assert.equal(workspaceShortcut(key("!", "Digit1", shiftCmd)), null);
  assert.equal(workspaceShortcut(key("]", "BracketRight", cmd)), null);
  assert.equal(workspaceShortcut(key("Enter", "Enter", cmd)), null);
  for (const pass of [["c", "KeyC"], ["v", "KeyV"], ["f", "KeyF"], ["a", "KeyA"], ["0", "Digit0"]])
    assert.equal(workspaceShortcut(key(pass[0]!, pass[1]!, cmd)), null, `Cmd+${pass[0]} passes through`);
  assert.equal(workspaceShortcut(key("d", "KeyD", cmd, "keyup")), null);
  assert.equal(workspaceShortcut(key("d", "KeyD", { metaKey: true, isComposing: true })), null);
});

test("non-Latin layouts match the physical key", () => {
  // Thai Kedmanee
  assert.deepEqual(workspaceShortcut(key("ก", "KeyD", cmd)), { kind: "split", direction: "row" });
  assert.deepEqual(workspaceShortcut(key("ฎ", "KeyD", shiftCmd)), { kind: "split", direction: "column" });
  assert.deepEqual(workspaceShortcut(key("ไ", "KeyW", cmd)), { kind: "close-pane" });
  assert.deepEqual(workspaceShortcut(key("ๅ", "Digit1", cmd)), { kind: "tab", index: 0 });
  assert.deepEqual(workspaceShortcut(key("ม", "Comma", cmd)), { kind: "settings" });
  assert.deepEqual(workspaceShortcut(key("ฝ", "Slash", cmd)), { kind: "shortcuts" });
  assert.deepEqual(workspaceShortcut(key("ห", "KeyS", { metaKey: true, ctrlKey: true })), { kind: "toggle-sidebar" });
  // Russian ЙЦУКЕН
  assert.deepEqual(workspaceShortcut(key("в", "KeyD", cmd)), { kind: "split", direction: "row" });
  assert.deepEqual(workspaceShortcut(key("ц", "KeyW", cmd)), { kind: "close-pane" });
  assert.deepEqual(workspaceShortcut(key("б", "Comma", cmd)), { kind: "settings" });
  assert.deepEqual(workspaceShortcut(key(".", "Slash", cmd)), { kind: "shortcuts" });
  assert.deepEqual(workspaceShortcut(key("Ъ", "BracketRight", shiftCmd)), { kind: "cycle-tab", step: 1 });
  assert.deepEqual(workspaceShortcut(key("Х", "BracketLeft", shiftCmd)), { kind: "cycle-tab", step: -1 });
});

test("Latin layouts that move keys match the typed character", () => {
  // Dvorak: W is on Comma, D on KeyH, Z on Slash, "/" on BracketLeft, "," on KeyW.
  assert.deepEqual(workspaceShortcut(key("w", "Comma", cmd)), { kind: "close-pane" });
  assert.deepEqual(workspaceShortcut(key("d", "KeyH", cmd)), { kind: "split", direction: "row" });
  assert.equal(workspaceShortcut(key("e", "KeyD", cmd)), null);
  assert.equal(workspaceShortcut(key("z", "Slash", cmd)), null, "Cmd+Z never opens a dialog");
  assert.deepEqual(workspaceShortcut(key("/", "BracketLeft", cmd)), { kind: "shortcuts" });
  assert.deepEqual(workspaceShortcut(key(",", "KeyW", cmd)), { kind: "settings" });
  // AZERTY: Z sits where QWERTY has W, and digits need Shift to type.
  assert.equal(workspaceShortcut(key("z", "KeyW", cmd)), null, "Cmd+Z never closes a pane");
  assert.deepEqual(workspaceShortcut(key("&", "Digit1", cmd)), { kind: "tab", index: 0 });
});
