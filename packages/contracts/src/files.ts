import { exactObject, isCounter, isOwner, type Owner } from "./index.ts";
import { isTerminalSession, type TerminalSession } from "./terminals.ts";

export const MAX_FILE_ENTRIES = 10_000;
/** UTF-16 bounds; main enforces the 1,024- and 4,096-byte UTF-8 limits. */
export const MAX_FILE_NAME = 1_024;
export const MAX_FILE_PATH = 4_096;
/** The last second a JavaScript Date can show; a later `mtime` is reported as null. */
export const MAX_FILE_MTIME = 8_640_000_000_000;

export type FileSource = { kind: "local" } | { kind: "remote"; sessionId: string; generation: number };
export type FileType = "file" | "directory" | "symlink" | "other";
/** `mtime` in whole seconds; `permissions` masked to 0o7777; null when unknown. */
export interface FileAttributes { type: FileType; size: number | null; mtime: number | null; permissions: number | null }
/** `addressable: false`: the name decoded lossily (U+FFFD) and cannot be sent back. */
export interface FileEntry extends FileAttributes { name: string; addressable: boolean }
/** Lstat-based entries in listing order; `skipped` counts names refused as unsafe. */
export interface DirectoryListing { path: string; entries: FileEntry[]; truncated: boolean; skipped: number }
export const FILE_ERROR_CODES = [
  "not-found", "permission-denied", "invalid-path", "unsupported", "failure", "connection-lost", "resource-limit", "closed",
  "not-responding",
] as const;
export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];
/** A file-level failure is a value, not an envelope error: the request itself was valid and authorized. */
export type FileOutcome<T> = { ok: true; value: T } | { ok: false; error: FileErrorCode };
/** `path` is absolute; only `resolvePath` also accepts `~` and relative input. */
export interface FilePathRequest { owner: Owner; source: FileSource; path: string }
export type SftpSessionView = Omit<TerminalSession, "end"> & { home: string | null };
export interface SftpState { owner: Owner; sequence: number; sessions: SftpSessionView[] }

const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:_-]{1,160}$/.test(v);
const nullableCounter = (v: unknown) => v === null || isCounter(v);
// Lone surrogates cannot be encoded as UTF-8; names keep control characters, which the renderer escapes for display.
const wellFormed = (v: string) => !v.includes("\0") && !/\p{Cs}/u.test(v);
const pathText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_FILE_PATH && wellFormed(v);

export function isFilePath(v: unknown): v is string { return pathText(v) && v.startsWith("/"); }
export function isFileName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_FILE_NAME && !v.includes("/") && wellFormed(v);
}
export function isFileSource(v: unknown): v is FileSource {
  if (exactObject(v, ["kind"])) return v.kind === "local";
  return exactObject(v, ["kind", "sessionId", "generation"]) && v.kind === "remote" && identifier(v.sessionId) &&
    isCounter(v.generation) && v.generation > 0;
}
export function isFileAttributes(v: unknown): v is FileAttributes {
  return exactObject(v, ["type", "size", "mtime", "permissions"]) && attributes(v);
}
function attributes(v: Record<string, unknown>): boolean {
  return ["file", "directory", "symlink", "other"].includes(v.type as string) && nullableCounter(v.size) &&
    (v.mtime === null || (isCounter(v.mtime) && v.mtime <= MAX_FILE_MTIME)) &&
    (v.permissions === null || (isCounter(v.permissions) && v.permissions <= 0o7777));
}
export function isFileEntry(v: unknown): v is FileEntry {
  return exactObject(v, ["name", "addressable", "type", "size", "mtime", "permissions"]) && isFileName(v.name) &&
    typeof v.addressable === "boolean" && attributes(v);
}
export function isDirectoryListing(v: unknown): v is DirectoryListing {
  return exactObject(v, ["path", "entries", "truncated", "skipped"]) && isFilePath(v.path) && Array.isArray(v.entries) &&
    v.entries.length <= MAX_FILE_ENTRIES && v.entries.every(isFileEntry) && typeof v.truncated === "boolean" && isCounter(v.skipped);
}
export function isFileOutcome<T>(v: unknown, validate: (value: unknown) => value is T): v is FileOutcome<T> {
  if (exactObject(v, ["ok", "value"])) return v.ok === true && validate(v.value);
  return exactObject(v, ["ok", "error"]) && v.ok === false && (FILE_ERROR_CODES as readonly unknown[]).includes(v.error);
}
export const isListingOutcome = (v: unknown): v is FileOutcome<DirectoryListing> => isFileOutcome(v, isDirectoryListing);
export const isAttributesOutcome = (v: unknown): v is FileOutcome<FileAttributes> => isFileOutcome(v, isFileAttributes);
export const isResolvedPathOutcome = (v: unknown): v is FileOutcome<string> => isFileOutcome(v, isFilePath);
/** `listDirectory` and `statPath`: absolute paths only. */
export function isFilePathRequest(v: unknown): v is FilePathRequest {
  return exactObject(v, ["owner", "source", "path"]) && isOwner(v.owner) && isFileSource(v.source) && isFilePath(v.path);
}
/** `resolvePath`: also `~`, `~/…` and relative input, resolved against the source's home directory. */
export function isResolvePathRequest(v: unknown): v is FilePathRequest {
  return exactObject(v, ["owner", "source", "path"]) && isOwner(v.owner) && isFileSource(v.source) && pathText(v.path);
}
export function isSftpSessionView(v: unknown): v is SftpSessionView {
  if (!exactObject(v, ["sessionId", "generation", "hostId", "phase", "target", "error", "home"])) return false;
  const { home, ...session } = v;
  return (home === null || isFilePath(home)) && isTerminalSession({ ...session, end: null });
}
export function isSftpState(v: unknown): v is SftpState {
  return exactObject(v, ["owner", "sequence", "sessions"]) && isOwner(v.owner) && isCounter(v.sequence) &&
    Array.isArray(v.sessions) && v.sessions.length <= 32 && v.sessions.every(isSftpSessionView);
}
