import { exactObject, isOwner, type Owner } from "./index.ts";

/** The renderer-adjustable subset of the stored AppSettings row. */
export interface TerminalSettings {
  terminalFontSize: number;
  terminalScrollback: number;
  terminalCursor: "block" | "bar" | "underline";
  terminalCursorBlink: boolean;
}
export const DEFAULT_TERMINAL_SETTINGS: Readonly<TerminalSettings> = Object.freeze({
  terminalFontSize: 13,
  terminalScrollback: 10000,
  terminalCursor: "block",
  terminalCursorBlink: false,
});
export interface SettingsRequest { owner: Owner }
export interface UpdateSettingsRequest { owner: Owner; changes: Partial<TerminalSettings> }

const KEYS = ["terminalFontSize", "terminalScrollback", "terminalCursor", "terminalCursorBlink"] as const;
const integer = (v: unknown, min: number, max: number): boolean => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const field: Record<(typeof KEYS)[number], (v: unknown) => boolean> = {
  terminalFontSize: (v) => integer(v, 10, 32),
  terminalScrollback: (v) => integer(v, 100, 100_000),
  terminalCursor: (v) => v === "block" || v === "bar" || v === "underline",
  terminalCursorBlink: (v) => typeof v === "boolean",
};

export function isTerminalSettings(v: unknown): v is TerminalSettings {
  return exactObject(v, KEYS) && KEYS.every((key) => field[key](v[key]));
}
export function isSettingsRequest(v: unknown): v is SettingsRequest {
  return exactObject(v, ["owner"]) && isOwner(v.owner);
}
export function isUpdateSettingsRequest(v: unknown): v is UpdateSettingsRequest {
  if (!exactObject(v, ["owner", "changes"]) || !isOwner(v.owner)) return false;
  const changes = v.changes;
  if (changes === null || typeof changes !== "object" || Array.isArray(changes)) return false;
  const keys = Object.keys(changes);
  return keys.length > 0 && keys.every((key) => Object.hasOwn(field, key) && field[key as (typeof KEYS)[number]]((changes as Record<string, unknown>)[key]));
}
