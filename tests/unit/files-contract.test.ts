import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  FILE_ERROR_CODES, MAX_FILE_ENTRIES, MAX_FILE_MTIME, isAttributesOutcome, isDirectoryListing, isFileAttributes, isFileEntry, isFileName,
  isFilePath, isFilePathRequest, isFileSource, isListingOutcome, isResolvePathRequest, isResolvedPathOutcome, isSftpSessionView,
  isSftpState,
} from "../../packages/contracts/src/index.ts";

const owner = { windowId: 1, generation: 1 };
const remote = { kind: "remote", sessionId: "s-1", generation: 1 };
const attrs = { type: "file", size: 0, mtime: 0, permissions: 0o644 };
const entry = { name: "a", addressable: true, ...attrs };

test("paths are absolute, NUL-free, well-formed and at most 4,096 UTF-16 units", () => {
  for (const path of ["/", "/a", "/ไทย/กุ่", "/😀", "/a\u001b[31m", "/\u202Eexe.txt", "/" + "a".repeat(4_095), "/a/../b", "//x/"])
    assert.ok(isFilePath(path), JSON.stringify(path));
  for (const path of ["", "a", "~", "./a", "/" + "a".repeat(4_096), "/a\0b", "/\uD800", "/x\uDC00y", 1, null])
    assert.equal(isFilePath(path), false, JSON.stringify(path));
});

test("names keep control, bidi and Thai characters but not '/', NUL, lone surrogates or over 1,024 units", () => {
  for (const name of ["a", ".env", "\u001b", "\u007f", "\u202E", "café", "กุ่", "👩‍💻", "�", "x".repeat(1_024)])
    assert.ok(isFileName(name), JSON.stringify(name));
  for (const name of ["", "a/b", "/", "a\0", "\uD83D", "x".repeat(1_025), 7])
    assert.equal(isFileName(name), false, JSON.stringify(name));
});

test("sources, attributes and entries are exact", () => {
  assert.ok(isFileSource({ kind: "local" }));
  assert.ok(isFileSource(remote));
  for (const source of [{ kind: "local", sessionId: "s-1" }, { kind: "remote", sessionId: "s-1" }, { ...remote, generation: 0 },
    { ...remote, sessionId: "a b" }, { ...remote, extra: 1 }, { kind: "Local" }, null])
    assert.equal(isFileSource(source), false, JSON.stringify(source));

  for (const type of ["file", "directory", "symlink", "other"]) assert.ok(isFileAttributes({ ...attrs, type }));
  assert.ok(isFileAttributes({ type: "other", size: null, mtime: null, permissions: null }));
  assert.ok(isFileAttributes({ ...attrs, size: Number.MAX_SAFE_INTEGER, permissions: 0o7777 }));
  assert.ok(isFileAttributes({ ...attrs, mtime: MAX_FILE_MTIME }), "the last second a Date can show");
  assert.equal(isFileAttributes({ ...attrs, mtime: MAX_FILE_MTIME + 1 }), false, "a later mtime is sent as null");
  for (const invalid of [{ ...attrs, type: "unknown" }, { ...attrs, size: -1 }, { ...attrs, size: 1.5 }, { ...attrs, size: 2 ** 53 },
    { ...attrs, mtime: -1 }, { ...attrs, permissions: 0o10000 }, { ...attrs, permissions: "644" }, { ...attrs, target: "/etc" }])
    assert.equal(isFileAttributes(invalid), false, JSON.stringify(invalid));

  assert.ok(isFileEntry(entry));
  assert.ok(isFileEntry({ ...entry, name: "�", addressable: false }));
  for (const invalid of [{ ...entry, name: "a/b" }, { ...entry, addressable: 1 }, { ...entry, path: "/a" }, attrs])
    assert.equal(isFileEntry(invalid), false);
});

test("listings carry at most 10,000 entries at an absolute path", () => {
  const listing = { path: "/home", entries: [entry], truncated: false, skipped: 0 };
  assert.ok(isDirectoryListing(listing));
  assert.ok(isDirectoryListing({ ...listing, entries: Array(MAX_FILE_ENTRIES).fill(entry), truncated: true, skipped: 3 }));
  for (const invalid of [{ ...listing, entries: Array(MAX_FILE_ENTRIES + 1).fill(entry) }, { ...listing, path: "home" },
    { ...listing, skipped: -1 }, { ...listing, truncated: "no" }, { ...listing, entries: [{ ...entry, name: "" }] }])
    assert.equal(isDirectoryListing(invalid), false);
});

test("file outcomes carry a fixed code and never text", () => {
  for (const error of FILE_ERROR_CODES) {
    assert.ok(isListingOutcome({ ok: false, error }));
    assert.ok(isAttributesOutcome({ ok: false, error }));
  }
  for (const error of ["cancelled", "invalid-request", "No such file (server)", undefined])
    assert.equal(isAttributesOutcome({ ok: false, error }), false, String(error));
  assert.equal(isAttributesOutcome({ ok: false, error: "failure", message: "server text" }), false);
  assert.ok(isAttributesOutcome({ ok: true, value: attrs }));
  assert.ok(isResolvedPathOutcome({ ok: true, value: "/home/fixture" }));
  assert.equal(isResolvedPathOutcome({ ok: true, value: "home" }), false);
  assert.equal(isAttributesOutcome({ ok: true, value: { ...attrs, type: "unknown" } }), false);
});

test("only resolvePath accepts '~' and relative input", () => {
  for (const path of ["~", "~/notes", "notes/ไทย", "..", "/etc"]) assert.ok(isResolvePathRequest({ owner, source: remote, path }), path);
  for (const path of ["~", "~/notes", "notes"]) assert.equal(isFilePathRequest({ owner, source: remote, path }), false, path);
  assert.ok(isFilePathRequest({ owner, source: { kind: "local" }, path: "/Users" }));
  for (const path of ["", "a\0", "\uD800", "x".repeat(4_097)]) assert.equal(isResolvePathRequest({ owner, source: remote, path }), false);
  assert.equal(isFilePathRequest({ owner, source: remote, path: "/", extra: 1 }), false);
  assert.equal(isFilePathRequest({ owner: { ...owner, generation: 0 }, source: remote, path: "/" }), false);
});

test("SFTP session views are terminal sessions without an end and with a home", () => {
  const view = { sessionId: "s-1", generation: 1, hostId: "h-1", phase: "ready", target: null, error: null, home: "/home/fixture" };
  assert.ok(isSftpSessionView(view));
  assert.ok(isSftpSessionView({ ...view, home: null, phase: "failed", error: "subsystem-unavailable" }));
  for (const invalid of [{ ...view, end: null }, { ...view, home: "home" }, { ...view, error: "server text" }, { ...view, phase: "Ready" }])
    assert.equal(isSftpSessionView(invalid), false, JSON.stringify(invalid));
  assert.ok(isSftpState({ owner, sequence: 0, sessions: [view] }));
  assert.equal(isSftpState({ owner, sequence: 0, sessions: Array(33).fill(view) }), false);
  assert.equal(isSftpState({ owner, sequence: -1, sessions: [] }), false);
});
