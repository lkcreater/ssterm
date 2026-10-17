/**
 * Pure rules for the Files browser: name display, lexical POSIX paths, formatting, sorting,
 * type-ahead, selection, list windowing and reply fencing. Names stay raw for addressing; only
 * comparison ever normalizes them (APFS keeps NFD verbatim and NFC reorders Thai marks).
 */

import type { FileEntry, FileSource, FileType } from "@ssterm/contracts";

type BrowserEntry = Pick<FileEntry, "name" | "addressable" | "type" | "size" | "mtime">;

// Controls, format characters (zero-width, bidi, soft hyphen, tags, BOM…), line/paragraph separators and the
// whole tag block (U+E0000 itself is unassigned, not Cf).
// ZWJ/ZWNJ stay: emoji sequences and Indic/Persian words need them, and they never make two names look equal alone.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{E0000}-\u{E007F}]/u;
const KEPT = new Set(["\u200C", "\u200D"]);
const escape = (char: string) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`;

export interface DisplayName {
  text: string;
  /** The name contains characters shown as `\u{…}`, or leading/trailing spaces; the row says it holds hidden characters. */
  escaped: boolean;
  /** Lossily decoded (U+FFFD) or not addressable: show "(unreadable name)", never open or select. */
  unreadable: boolean;
}

export function displayName(name: string, addressable = true): DisplayName {
  let escaped = false;
  // By code point, so astral tag characters (U+E0000–U+E007F) escape as one.
  const chars = [...name].map((char) => {
    if (!HIDDEN.test(char) || KEPT.has(char)) return char;
    escaped = true;
    return escape(char);
  });
  // Edge whitespace (and whitespace-only names) is invisible in a row: `report.pdf ` must not pass for `report.pdf`.
  const space = (i: number) => /^\s$/u.test(chars[i] ?? "");
  const mark = (i: number) => {
    chars[i] = escape(chars[i]!);
    escaped = true;
  };
  for (let i = 0; space(i); i++) mark(i);
  for (let i = chars.length - 1; space(i); i--) mark(i);
  return { text: chars.join(""), escaped, unreadable: !addressable || name.includes("\uFFFD") };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Splits a shown name for middle truncation: the head may shrink behind an ellipsis, the tail (the last
 * `count` grapheme clusters, so the extension and any numbering stay visible) never does. Splitting by
 * grapheme keeps Thai marks and emoji sequences whole. Names no longer than `count` are not split.
 */
export function splitTail(text: string, count = 12): [head: string, tail: string] {
  const clusters = Array.from(graphemes.segment(text), (part) => part.segment);
  if (clusters.length <= count) return [text, ""];
  return [clusters.slice(0, -count).join(""), clusters.slice(-count).join("")];
}

export const isUnreadable = (entry: Pick<BrowserEntry, "name" | "addressable">) =>
  !entry.addressable || entry.name.includes("\uFFFD");

export const isAbsolutePath = (path: string) => path.startsWith("/");

const trimTrailing = (path: string) => path.replace(/\/+$/, "") || "/";

/** The name is appended verbatim: no normalization, backslashes are ordinary characters. */
export function joinPath(dir: string, name: string): string {
  const base = trimTrailing(dir);
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

export function parentPath(path: string): string {
  const trimmed = trimTrailing(path);
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimTrailing(trimmed.slice(0, slash));
}

export interface Crumb {
  /** Raw segment; display it through `displayName`. */
  label: string;
  path: string;
}

export function breadcrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: "/", path: "/" }];
  let current = "/";
  for (const segment of path.split("/")) {
    if (!segment) continue;
    current = joinPath(current, segment);
    crumbs.push({ label: segment, path: current });
  }
  return crumbs;
}

export function permissionsText(mode: number): { symbolic: string; octal: string } {
  const bits = mode & 0o7777;
  const triplet = (shift: number, special: number, on: string, off: string) => {
    const r = bits & (4 << shift) ? "r" : "-";
    const w = bits & (2 << shift) ? "w" : "-";
    const x = bits & (1 << shift);
    return r + w + (bits & special ? (x ? on : off) : x ? "x" : "-");
  };
  const symbolic = triplet(6, 0o4000, "s", "S") + triplet(3, 0o2000, "s", "S") + triplet(0, 0o1000, "t", "T");
  const octal = bits.toString(8).padStart(bits > 0o777 ? 4 : 3, "0");
  return { symbolic, octal };
}

const TYPE_LABELS: Record<FileType, string> = { file: "File", directory: "Folder", symlink: "Link", other: "Other" };
/** Anything outside the contract (SST-019's domain `unknown`) reads as Other. */
export const typeLabel = (type: FileType | (string & {})) => TYPE_LABELS[type as FileType] ?? "Other";

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Binary units; `null` (directories, links, unknown) is an em dash. */
export function sizeText(size: number | null, locales?: Intl.LocalesArgument): string {
  if (size === null) return "—";
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${new Intl.NumberFormat(locales, { maximumFractionDigits: digits }).format(value)} ${UNITS[unit]}`;
}

/** `mtime` is in seconds; `compact` is the date alone, for narrow panes. */
export function modifiedText(mtime: number | null, locales?: Intl.LocalesArgument, compact = false): string {
  if (mtime === null) return "—";
  try {
    const style: Intl.DateTimeFormatOptions = compact ? { dateStyle: "short" } : { dateStyle: "medium", timeStyle: "short" };
    return new Intl.DateTimeFormat(locales, style).format(mtime * 1000);
  } catch {
    return "—";
  }
}

export type SortKey = "name" | "size" | "modified";
export interface SortOrder {
  key: SortKey;
  direction: "asc" | "desc";
}

/** Directories first in either direction; ties fall back to name, then raw code units (NFC/NFD twins). */
export function sortEntries<T extends BrowserEntry>(entries: readonly T[], order: SortOrder): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const sign = order.direction === "asc" ? 1 : -1;
  const byName = (a: T, b: T) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const byKey = (a: T, b: T) =>
    order.key === "size"
      ? (a.size ?? -1) - (b.size ?? -1)
      : order.key === "modified"
        ? (a.mtime ?? -Infinity) - (b.mtime ?? -Infinity) || 0
        : byName(a, b);
  return [...entries].sort(
    (a, b) =>
      Number(b.type === "directory") - Number(a.type === "directory") ||
      sign * byKey(a, b) ||
      byName(a, b),
  );
}

export const filterHidden = <T extends Pick<BrowserEntry, "name">>(entries: readonly T[], showHidden: boolean) =>
  showHidden ? [...entries] : entries.filter((entry) => !entry.name.startsWith("."));

/**
 * First readable entry at or after `fromIndex` (wrapping) whose name starts with `buffer`, ignoring
 * case and accents; -1 if none. NFC on both sides is for comparison only.
 */
export function typeAheadMatch(
  entries: readonly Pick<BrowserEntry, "name" | "addressable">[],
  buffer: string,
  fromIndex: number,
): number {
  const count = entries.length;
  if (!buffer || count === 0) return -1;
  const prefix = buffer.normalize("NFC");
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });
  const start = ((Math.trunc(fromIndex) % count) + count) % count;
  for (let step = 0; step < count; step++) {
    const index = (start + step) % count;
    const entry = entries[index]!;
    if (isUnreadable(entry)) continue;
    if (collator.compare(entry.name.normalize("NFC").slice(0, prefix.length), prefix) === 0) return index;
  }
  return -1;
}

export interface Selection {
  /** Focused row index, -1 for none. It may rest on an unreadable row; that row is never selected. */
  cursor: number;
  anchor: number;
  selected: ReadonlySet<string>;
}
type Entries = readonly Pick<BrowserEntry, "name" | "addressable">[];
export type SelectionAction =
  | {
      type: "move";
      by: number | "home" | "end" | "pageUp" | "pageDown";
      page?: number;
      shift?: boolean;
      entries: Entries;
    }
  | { type: "click"; index: number; shift?: boolean; meta?: boolean; entries: Entries }
  | { type: "toggle"; index: number; entries: Entries }
  | { type: "selectAll"; entries: Entries }
  | { type: "clear" }
  | { type: "reset" }
  /** Same directory reordered (sort, hidden toggle) or re-listed: keep cursor/anchor on the same rows, drop vanished names. */
  | { type: "relist"; previous: Entries; entries: Entries };

export const emptySelection: Selection = { cursor: -1, anchor: -1, selected: new Set() };

function range(entries: Entries, from: number, to: number): string[] {
  const names: string[] = [];
  for (let index = Math.min(from, to); index <= Math.max(from, to); index++) {
    const entry = entries[index];
    if (entry && !isUnreadable(entry)) names.push(entry.name);
  }
  return names;
}

const single = (entries: Entries, index: number) => new Set(range(entries, index, index));

export function selectionReducer(state: Selection, action: SelectionAction): Selection {
  switch (action.type) {
    case "move": {
      const { entries } = action;
      if (entries.length === 0) return state;
      const page = Math.max(1, action.page ?? 1);
      const target =
        action.by === "home"
          ? 0
          : action.by === "end"
            ? entries.length - 1
            : state.cursor + (action.by === "pageUp" ? -page : action.by === "pageDown" ? page : action.by);
      const cursor = Math.min(entries.length - 1, Math.max(0, target));
      if (action.shift) {
        const anchor = state.anchor < 0 ? cursor : state.anchor;
        return { cursor, anchor, selected: new Set(range(entries, anchor, cursor)) };
      }
      return { cursor, anchor: cursor, selected: single(entries, cursor) };
    }
    case "click": {
      const { entries, index } = action;
      if (!entries[index]) return state;
      if (action.shift) {
        const anchor = state.anchor < 0 ? index : state.anchor;
        const names = range(entries, anchor, index);
        return { cursor: index, anchor, selected: new Set(action.meta ? [...state.selected, ...names] : names) };
      }
      if (action.meta) return selectionReducer(state, { type: "toggle", index, entries });
      return { cursor: index, anchor: index, selected: single(entries, index) };
    }
    case "toggle": {
      const entry = action.entries[action.index];
      if (!entry) return state;
      const selected = new Set(state.selected);
      if (selected.has(entry.name)) selected.delete(entry.name);
      else if (!isUnreadable(entry)) selected.add(entry.name);
      return { cursor: action.index, anchor: action.index, selected };
    }
    case "selectAll":
      return { ...state, selected: new Set(range(action.entries, 0, action.entries.length - 1)) };
    case "clear":
      return { ...state, selected: new Set() };
    case "reset":
      return emptySelection;
    case "relist": {
      const { previous, entries } = action;
      // Object identity first (a re-sort keeps the objects), then the name (a fresh listing).
      const relocate = (index: number) => {
        const old = previous[index];
        if (!old) return -1;
        const same = entries.indexOf(old);
        return same >= 0 ? same : entries.findIndex((entry) => entry.name === old.name);
      };
      const present = new Set(entries.filter((entry) => !isUnreadable(entry)).map((entry) => entry.name));
      return {
        cursor: relocate(state.cursor),
        anchor: relocate(state.anchor),
        selected: new Set([...state.selected].filter((name) => present.has(name))),
      };
    }
  }
}

/** Selected names in list order, captured when an action is invoked. */
export const snapshot = (state: Selection, entries: Entries): string[] =>
  entries.filter((entry) => state.selected.has(entry.name) && !isUnreadable(entry)).map((entry) => entry.name);

export const ROW_HEIGHT = 32;

export interface WindowRange {
  start: number;
  /** Exclusive. */
  end: number;
  padTop: number;
  padBottom: number;
}

export function windowRange({
  scrollTop,
  viewport,
  rowHeight = ROW_HEIGHT,
  count,
  overscan = 10,
}: {
  scrollTop: number;
  viewport: number;
  rowHeight?: number;
  count: number;
  overscan?: number;
}): WindowRange {
  const top = Math.max(0, scrollTop);
  const end = Math.min(count, Math.ceil((top + Math.max(0, viewport)) / rowHeight) + overscan);
  const start = Math.min(end, Math.max(0, Math.floor(top / rowHeight) - overscan));
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/** The scrollTop that brings row `index` fully into view with the least movement. */
export function revealScrollTop(index: number, scrollTop: number, viewport: number, rowHeight = ROW_HEIGHT): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return Math.max(0, top + rowHeight - viewport);
  return scrollTop;
}

export interface NavigationFence {
  key: string;
  generation: number;
  token: number;
}

/** Stable per pane source across generations; the generation is fenced separately. */
export const sourceKey = (source: FileSource) =>
  source.kind === "local" ? "local" : `remote:${source.sessionId}`;

/** Stamp a new navigation request; it supersedes every earlier one in the pane. */
export const nextFence = (source: FileSource, previous: NavigationFence | null): NavigationFence => ({
  key: sourceKey(source),
  generation: source.kind === "local" ? 0 : source.generation,
  token: (previous?.token ?? 0) + 1,
});

/** A reply applies only to the latest request and only while the pane still shows that source generation. */
export function replyApplies(
  sent: NavigationFence,
  latest: NavigationFence | null,
  current: FileSource | null,
): boolean {
  if (!latest || !current) return false;
  const now = nextFence(current, null);
  return (
    sent.token === latest.token &&
    sent.key === latest.key &&
    sent.generation === latest.generation &&
    sent.key === now.key &&
    sent.generation === now.generation
  );
}
