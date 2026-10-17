import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  breadcrumbs,
  displayName,
  emptySelection,
  filterHidden,
  isAbsolutePath,
  joinPath,
  modifiedText,
  nextFence,
  parentPath,
  permissionsText,
  replyApplies,
  revealScrollTop,
  selectionReducer,
  sizeText,
  snapshot,
  sortEntries,
  splitTail,
  typeAheadMatch,
  typeLabel,
  windowRange,
  type Selection,
  type SelectionAction,
} from "../../apps/desktop/src/renderer/src/lib/file-browser.ts";
import type { FileEntry, FileSource } from "../../packages/contracts/src/index.ts";

const entry = (name: string, type: FileEntry["type"] = "file", extra: Partial<FileEntry> = {}): FileEntry => ({
  name,
  addressable: true,
  type,
  size: type === "file" ? 0 : null,
  mtime: null,
  permissions: null,
  ...extra,
});

test("displayName escapes every control, bidi, separator and BOM code point", () => {
  const hidden = [
    ...Array.from({ length: 0x20 }, (_, code) => code),
    0x7f,
    ...Array.from({ length: 0x20 }, (_, offset) => 0x80 + offset),
    0x061c,
    0x200e,
    0x200f,
    0x202a,
    0x202b,
    0x202c,
    0x202d,
    0x202e,
    0x2066,
    0x2067,
    0x2068,
    0x2069,
    0x2028,
    0x2029,
    0xfeff,
  ];
  for (const code of hidden) {
    const shown = displayName(`a${String.fromCharCode(code)}b`);
    assert.equal(shown.text, `a\\u{${code.toString(16).toUpperCase()}}b`);
    assert.equal(shown.escaped, true);
    assert.equal(shown.unreadable, false);
  }
  const spoof = displayName("invoice\u202Etxt.exe");
  assert.equal(spoof.text, "invoice\\u{202E}txt.exe");
  assert.equal(displayName("\u001B[31mred").text, "\\u{1B}[31mred");
});

test("displayName keeps Thai marks, ZWJ/ZWNJ emoji and RTL letters verbatim", () => {
  for (const name of [
    "ภาษาไทย น้ำ ผู้ใหญ่",
    "น้ำ", // Thai with tone mark before sara am: order must survive
    "family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    "ملف عربي",
    "a\u200Cb",
    "e\u0301 decomposed",
  ]) {
    assert.deepEqual(displayName(name), { text: name, escaped: false, unreadable: false });
  }
});

test("displayName escapes invisible format characters by code point, including astral tags", () => {
  const cp = (code: number) => String.fromCodePoint(code);
  const hex = (code: number) => code.toString(16).toUpperCase();
  const invisible = [
    0x00ad, 0x180e, 0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
    0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfff9, 0xfffa, 0xfffb,
    0xe0000, 0xe0001, 0xe0041, 0xe007f,
  ];
  for (const code of invisible) {
    const shown = displayName(`a${cp(code)}b`);
    assert.deepEqual(shown, { text: `a\\u{${hex(code)}}b`, escaped: true, unreadable: false }, hex(code));
  }
  // A ZWSP twin of a real name reads differently.
  const twin = displayName(`report${cp(0x200b)}.pdf`);
  assert.notEqual(twin.text, displayName("report.pdf").text);
  assert.equal(twin.escaped, true);
  // ZWJ, ZWNJ and variation selectors stay as they are.
  for (const name of [`a${cp(0x200d)}b`, `a${cp(0x200c)}b`, `${cp(0x2764)}${cp(0xfe0f)}`])
    assert.deepEqual(displayName(name), { text: name, escaped: false, unreadable: false });
});

test("displayName shows leading, trailing and whitespace-only names", () => {
  assert.deepEqual(displayName("report.pdf "), { text: "report.pdf\\u{20}", escaped: true, unreadable: false });
  assert.deepEqual(displayName("  a b "), { text: "\\u{20}\\u{20}a b\\u{20}", escaped: true, unreadable: false });
  assert.deepEqual(displayName("   "), { text: "\\u{20}\\u{20}\\u{20}", escaped: true, unreadable: false });
  assert.deepEqual(displayName(`${String.fromCodePoint(0xa0)}x`), { text: "\\u{A0}x", escaped: true, unreadable: false });
  assert.deepEqual(displayName("a b"), { text: "a b", escaped: false, unreadable: false }, "inner spaces stay");
});

test("modifiedText never throws for an out-of-range time", () => {
  assert.equal(modifiedText(Number.MAX_SAFE_INTEGER), "—");
  assert.notEqual(modifiedText(8_640_000_000_000, "en"), "—", "the last representable second still formats");
});

test("modifiedText compact is the date alone", () => {
  const at = Date.UTC(2026, 9, 17, 15, 4) / 1000;
  assert.equal(modifiedText(at, "en-US", true), new Intl.DateTimeFormat("en-US", { dateStyle: "short" }).format(at * 1000));
  assert.equal(modifiedText(null, "en-US", true), "\u2014");
});

test("splitTail keeps the last grapheme clusters whole and leaves short names alone", () => {
  assert.deepEqual(splitTail("short.txt"), ["short.txt", ""]);
  assert.deepEqual(splitTail("abcdefghijkl"), ["abcdefghijkl", ""], "exactly the tail length");
  assert.deepEqual(splitTail("report-final-2026-10.pdf", 7), ["report-final-2026", "-10.pdf"]);
  // Thai: each consonant keeps its vowel and tone marks (\u0E35 \u0E48, \u0E34 \u0E4C).
  const thai = "\u0E23\u0E32\u0E22\u0E07\u0E32\u0E19\u0E17\u0E35\u0E48\u0E2A\u0E35\u0E48\u0E44\u0E1F\u0E25\u0E4C";
  const [head, tail] = splitTail(thai, 3);
  assert.equal(head + tail, thai);
  assert.equal(tail, "\u0E44\u0E1F\u0E25\u0E4C");
  assert.deepEqual(splitTail(thai.slice(0, 9), 1), ["\u0E23\u0E32\u0E22\u0E07\u0E32\u0E19", "\u0E17\u0E35\u0E48"]);
  // An emoji ZWJ sequence and a flag are single clusters.
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const flag = "\u{1F1F9}\u{1F1ED}";
  assert.deepEqual(splitTail(`trip-${family}${flag}`, 2), ["trip-", `${family}${flag}`]);
  assert.deepEqual(splitTail(`${family}x`, 1), [family, "x"]);
});

test("displayName flags lossy and unaddressable names", () => {
  assert.equal(displayName("bad\uFFFDname").unreadable, true);
  assert.equal(displayName("fine", false).unreadable, true);
  assert.equal(displayName("fine").unreadable, false);
});

test("paths are lexical POSIX and names are joined verbatim", () => {
  assert.equal(joinPath("/", "etc"), "/etc");
  assert.equal(joinPath("/home/fixture", "my file.txt"), "/home/fixture/my file.txt");
  assert.equal(joinPath("/home/fixture/", "a\\b"), "/home/fixture/a\\b");
  const nfd = "e\u0301";
  assert.equal(joinPath("/x", nfd), `/x/${nfd}`);
  assert.notEqual(joinPath("/x", nfd), `/x/${nfd.normalize("NFC")}`);

  assert.equal(parentPath("/"), "/");
  assert.equal(parentPath("/etc"), "/");
  assert.equal(parentPath("/home/fixture"), "/home");
  assert.equal(parentPath("/home/fixture/"), "/home");
  assert.equal(parentPath("/a b/c\\d"), "/a b");
  assert.equal(parentPath("/a//b"), "/a");

  assert.equal(isAbsolutePath("/x"), true);
  assert.equal(isAbsolutePath("~/x"), false);
  assert.equal(isAbsolutePath("x"), false);
});

test("breadcrumbs start at root and keep raw segments", () => {
  assert.deepEqual(breadcrumbs("/"), [{ label: "/", path: "/" }]);
  assert.deepEqual(breadcrumbs("/home/my docs/a\\b/"), [
    { label: "/", path: "/" },
    { label: "home", path: "/home" },
    { label: "my docs", path: "/home/my docs" },
    { label: "a\\b", path: "/home/my docs/a\\b" },
  ]);
});

test("permissionsText renders symbolic and octal modes including special bits", () => {
  assert.deepEqual(permissionsText(0o755), { symbolic: "rwxr-xr-x", octal: "755" });
  assert.deepEqual(permissionsText(0o644), { symbolic: "rw-r--r--", octal: "644" });
  assert.deepEqual(permissionsText(0), { symbolic: "---------", octal: "000" });
  assert.deepEqual(permissionsText(0o4755), { symbolic: "rwsr-xr-x", octal: "4755" });
  assert.deepEqual(permissionsText(0o2644), { symbolic: "rw-r-Sr--", octal: "2644" });
  assert.deepEqual(permissionsText(0o1777), { symbolic: "rwxrwxrwt", octal: "1777" });
  assert.deepEqual(permissionsText(0o100644), { symbolic: "rw-r--r--", octal: "644" });
});

test("labels and formatting", () => {
  assert.equal(typeLabel("directory"), "Folder");
  assert.equal(typeLabel("symlink"), "Link");
  assert.equal(typeLabel("unknown"), "Other");
  assert.equal(sizeText(null), "—");
  assert.equal(sizeText(0, "en"), "0 B");
  assert.equal(sizeText(1023, "en"), "1,023 B");
  assert.equal(sizeText(1536, "en"), "1.5 KiB");
  assert.equal(sizeText(5 * 1024 ** 3, "en"), "5 GiB");
  assert.equal(sizeText(1536, "th"), "1.5 KiB");
  assert.equal(modifiedText(null), "—");
  assert.equal(modifiedText(0, "en"), new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(0));
  assert.match(modifiedText(1_700_000_000, "th"), /2566|2023/);
});

test("sortEntries puts directories first, sorts numerically and handles Thai", () => {
  const names = (list: FileEntry[]) => list.map((item) => item.name);
  const list = [entry("file10"), entry("file2"), entry("zdir", "directory"), entry("File1"), entry("adir", "directory")];
  assert.deepEqual(names(sortEntries(list, { key: "name", direction: "asc" })), ["adir", "zdir", "File1", "file2", "file10"]);
  assert.deepEqual(names(sortEntries(list, { key: "name", direction: "desc" })), ["zdir", "adir", "file10", "file2", "File1"]);

  const thai = [entry("ไก่"), entry("ค"), entry("กา"), entry("ขา"), entry("เก")];
  assert.deepEqual(names(sortEntries(thai, { key: "name", direction: "asc" })), ["กา", "เก", "ไก่", "ขา", "ค"]);

  const sized = [entry("b", "file", { size: 10 }), entry("a", "file", { size: 10 }), entry("c", "file", { size: 1 }), entry("d", "directory")];
  assert.deepEqual(names(sortEntries(sized, { key: "size", direction: "desc" })), ["d", "a", "b", "c"]);
  const dated = [entry("old", "file", { mtime: 1 }), entry("none"), entry("new", "file", { mtime: 2 })];
  assert.deepEqual(names(sortEntries(dated, { key: "modified", direction: "asc" })), ["none", "old", "new"]);

  // NFC/NFD twins compare equal under the collator; raw order keeps the result deterministic.
  const twins = [entry("e\u0301"), entry("\u00E9")];
  assert.deepEqual(names(sortEntries(twins, { key: "name", direction: "asc" })), ["e\u0301", "\u00E9"]);
  assert.deepEqual(names(sortEntries([...twins].reverse(), { key: "name", direction: "asc" })), ["e\u0301", "\u00E9"]);
  assert.equal(list[0]!.name, "file10", "input is not mutated");
});

test("filterHidden hides only dot-prefixed names", () => {
  const list = [entry(".env"), entry("a.txt"), entry("..x"), entry(" .space")];
  assert.deepEqual(filterHidden(list, false).map((item) => item.name), ["a.txt", " .space"]);
  assert.equal(filterHidden(list, true).length, 4);
});

test("typeAheadMatch compares NFC, case and accent insensitively and wraps", () => {
  const list = [entry("alpha"), entry("Caf\u00E9"), entry("cafe\u0301 nfd"), entry("bad\uFFFD"), entry("ข้อมูล"), entry("cherry")];
  assert.equal(typeAheadMatch(list, "caf\u00E9", 0), 1);
  assert.equal(typeAheadMatch(list, "cafe\u0301", 2), 2);
  assert.equal(typeAheadMatch(list, "CAFE", 0), 1);
  assert.equal(typeAheadMatch(list, "c", 3), 5);
  assert.equal(typeAheadMatch(list, "a", 2), 0, "wraps to the top");
  assert.equal(typeAheadMatch(list, "bad", 0), -1, "unreadable rows never match");
  assert.equal(typeAheadMatch(list, "ข้", 0), 4);
  assert.equal(typeAheadMatch(list, "ขา", 0), -1);
  assert.equal(typeAheadMatch(list, "", 0), -1);
  assert.equal(typeAheadMatch([], "a", 0), -1);
  assert.equal(typeAheadMatch(list, "alpha", -1), 0);
});

const rows = [entry("a"), entry("b"), entry("bad\uFFFD"), entry("c"), entry("d"), entry("e", "file", { addressable: false })];
const run = (...actions: SelectionAction[]) => actions.reduce(selectionReducer, emptySelection as Selection);
const picked = (state: Selection) => snapshot(state, rows);

test("selection follows the cursor and extends with shift, skipping unreadable rows", () => {
  let state = run({ type: "move", by: 1, entries: rows });
  assert.deepEqual([state.cursor, picked(state)], [0, ["a"]]);
  state = selectionReducer(state, { type: "move", by: 3, shift: true, entries: rows });
  assert.deepEqual([state.cursor, state.anchor, picked(state)], [3, 0, ["a", "b", "c"]]);
  state = selectionReducer(state, { type: "move", by: -2, shift: true, entries: rows });
  assert.deepEqual(picked(state), ["a", "b"]);
  state = selectionReducer(state, { type: "move", by: 1, entries: rows });
  assert.deepEqual([state.cursor, picked(state)], [2, []], "cursor may rest on an unreadable row");
  assert.equal(run({ type: "move", by: "end", entries: rows }).cursor, 5);
  assert.equal(run({ type: "move", by: "home", entries: rows }).cursor, 0);
  assert.equal(run({ type: "move", by: "pageDown", page: 4, entries: rows }).cursor, 3);
  assert.equal(run({ type: "move", by: "pageDown", page: 40, entries: rows }).cursor, 5);
  assert.equal(run({ type: "move", by: "end", entries: rows }, { type: "move", by: "pageUp", page: 4, entries: rows }).cursor, 1);
  assert.equal(run({ type: "move", by: -1, entries: rows }).cursor, 0);
  assert.equal(run({ type: "move", by: 1, entries: [] }), emptySelection);
});

test("click, meta-click, space toggle and select all respect unreadable rows", () => {
  let state = run({ type: "click", index: 1, entries: rows }, { type: "click", index: 4, meta: true, entries: rows });
  assert.deepEqual(picked(state), ["b", "d"]);
  state = selectionReducer(state, { type: "click", index: 1, meta: true, entries: rows });
  assert.deepEqual([state.cursor, picked(state)], [1, ["d"]]);
  state = selectionReducer(state, { type: "click", index: 4, shift: true, entries: rows });
  assert.deepEqual(picked(state), ["b", "c", "d"]);
  state = run({ type: "click", index: 0, entries: rows }, { type: "click", index: 3, shift: true, meta: true, entries: rows });
  assert.deepEqual(picked(state), ["a", "b", "c"]);

  state = run({ type: "toggle", index: 2, entries: rows });
  assert.deepEqual([state.cursor, picked(state)], [2, []]);
  state = run({ type: "click", index: 2, entries: rows });
  assert.deepEqual(picked(state), []);
  state = run({ type: "toggle", index: 3, entries: rows }, { type: "toggle", index: 0, entries: rows });
  assert.deepEqual(picked(state), ["a", "c"]);
  state = selectionReducer(state, { type: "toggle", index: 3, entries: rows });
  assert.deepEqual(picked(state), ["a"]);

  state = run({ type: "selectAll", entries: rows });
  assert.deepEqual(picked(state), ["a", "b", "c", "d"]);
  assert.deepEqual([...state.selected], ["a", "b", "c", "d"]);
  assert.deepEqual(picked(selectionReducer(state, { type: "clear" })), []);
  assert.equal(selectionReducer(state, { type: "reset" }), emptySelection);
  assert.equal(run({ type: "click", index: 99, entries: rows }), emptySelection);
});

test("relist keeps the cursor on the same row and drops vanished names", () => {
  const state = run({ type: "click", index: 1, entries: rows }, { type: "click", index: 3, meta: true, entries: rows });
  const resorted = [...rows].reverse();
  const moved = selectionReducer(state, { type: "relist", previous: rows, entries: resorted });
  assert.deepEqual([moved.cursor, moved.anchor], [2, 2]);
  assert.deepEqual(snapshot(moved, resorted), ["c", "b"]);

  const fresh = [entry("c"), entry("a")];
  const relisted = selectionReducer(state, { type: "relist", previous: rows, entries: fresh });
  assert.deepEqual([relisted.cursor, [...relisted.selected]], [0, ["c"]]);
});

test("windowRange clamps at the edges", () => {
  assert.deepEqual(windowRange({ scrollTop: 0, viewport: 320, count: 10_000 }), {
    start: 0,
    end: 20,
    padTop: 0,
    padBottom: 9_980 * 32,
  });
  assert.deepEqual(windowRange({ scrollTop: 32 * 5_000 + 16, viewport: 320, count: 10_000 }), {
    start: 4_990,
    end: 5_021,
    padTop: 4_990 * 32,
    padBottom: 4_979 * 32,
  });
  assert.deepEqual(windowRange({ scrollTop: 32 * 9_990, viewport: 320, count: 10_000 }), {
    start: 9_980,
    end: 10_000,
    padTop: 9_980 * 32,
    padBottom: 0,
  });
  assert.deepEqual(windowRange({ scrollTop: 0, viewport: 320, count: 0 }), { start: 0, end: 0, padTop: 0, padBottom: 0 });
  assert.deepEqual(windowRange({ scrollTop: 99_999, viewport: 320, count: 5 }), { start: 5, end: 5, padTop: 160, padBottom: 0 });
  assert.deepEqual(windowRange({ scrollTop: -40, viewport: 64, count: 5, overscan: 0 }), { start: 0, end: 2, padTop: 0, padBottom: 96 });

  assert.equal(revealScrollTop(0, 64, 320), 0);
  assert.equal(revealScrollTop(5, 0, 320), 0);
  assert.equal(revealScrollTop(10, 0, 320), 32);
});

test("reply fencing applies only the latest request for the same source generation", () => {
  const remote = (generation: number, sessionId = "s1"): FileSource => ({ kind: "remote", sessionId, generation });
  const first = nextFence(remote(1), null);
  const second = nextFence(remote(1), first);
  assert.equal(replyApplies(second, second, remote(1)), true);
  assert.equal(replyApplies(first, second, remote(1)), false, "superseded navigation");
  assert.equal(replyApplies(second, second, remote(2)), false, "reconnected generation");
  assert.equal(replyApplies(second, second, remote(1, "s2")), false, "other session");
  assert.equal(replyApplies(second, second, { kind: "local" }), false);
  assert.equal(replyApplies(second, null, remote(1)), false);
  assert.equal(replyApplies(second, second, null), false);

  const local = nextFence({ kind: "local" }, second);
  assert.deepEqual(local, { key: "local", generation: 0, token: 3 });
  assert.equal(replyApplies(local, local, { kind: "local" }), true);
});
