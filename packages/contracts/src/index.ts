/** Serializable values crossing the isolated preload boundary. */
export type ErrorCode =
  | "invalid-request"
  | "unauthorized"
  | "stale-owner"
  | "unavailable";
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string } };
export interface Owner {
  windowId: number;
  generation: number;
}
export interface BootstrapData {
  app: { name: string; version: string; platform: string };
  owner: Owner;
  window: { focused: boolean; sequence: number };
}
export interface PingRequest {
  owner: Owner;
  requestId: string;
}
export interface WindowStateEvent {
  owner: Owner;
  sequence: number;
  type: "focus-changed";
  focused: boolean;
}
export interface DesktopAPI {
  bootstrap(): Promise<Result<BootstrapData>>;
  ping(
    request: PingRequest,
  ): Promise<Result<{ requestId: string; ready: true }>>;
  onWindowState(callback: (event: WindowStateEvent) => void): () => void;
}

// These names are never exposed through contextBridge.
export const channels = Object.freeze({
  bootstrap: "ssterm:bootstrap",
  ping: "ssterm:ping",
  windowState: "ssterm:window-state",
});

const messages: Record<ErrorCode, string> = {
  "invalid-request": "The request is invalid.",
  unauthorized: "The request is not authorized.",
  "stale-owner": "The window has changed. Reload its state.",
  unavailable: "The application is unavailable.",
};
export function failure<T = never>(code: ErrorCode): Result<T> {
  return { ok: false, error: { code, message: messages[code] } };
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function isOwner(value: unknown): value is Owner {
  return (
    exactObject(value, ["windowId", "generation"]) &&
    isCounter(value.windowId) &&
    value.windowId > 0 &&
    isCounter(value.generation) &&
    value.generation > 0
  );
}
export function isPingRequest(value: unknown): value is PingRequest {
  return (
    exactObject(value, ["owner", "requestId"]) &&
    isOwner(value.owner) &&
    typeof value.requestId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value.requestId)
  );
}
export function isWindowStateEvent(value: unknown): value is WindowStateEvent {
  return (
    exactObject(value, ["owner", "sequence", "type", "focused"]) &&
    isOwner(value.owner) &&
    isCounter(value.sequence) &&
    value.type === "focus-changed" &&
    typeof value.focused === "boolean"
  );
}
export function isBootstrapData(value: unknown): value is BootstrapData {
  if (!exactObject(value, ["app", "owner", "window"]) || !isOwner(value.owner))
    return false;
  return (
    exactObject(value.app, ["name", "version", "platform"]) &&
    ["name", "version", "platform"].every((key) => {
      const field = value.app as Record<string, unknown>;
      return (
        typeof field[key] === "string" &&
        field[key].length > 0 &&
        field[key].length <= 128
      );
    }) &&
    exactObject(value.window, ["focused", "sequence"]) &&
    typeof value.window.focused === "boolean" &&
    isCounter(value.window.sequence)
  );
}
export function isPingResponse(
  value: unknown,
): value is { requestId: string; ready: true } {
  return (
    exactObject(value, ["requestId", "ready"]) &&
    typeof value.requestId === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(value.requestId) &&
    value.ready === true
  );
}
export function isResult<T>(
  value: unknown,
  validate: (value: unknown) => value is T,
): value is Result<T> {
  if (exactObject(value, ["ok", "value"]) && value.ok === true)
    return validate(value.value);
  return (
    exactObject(value, ["ok", "error"]) &&
    value.ok === false &&
    exactObject(value.error, ["code", "message"]) &&
    typeof value.error.code === "string" &&
    Object.hasOwn(messages, value.error.code) &&
    value.error.message === messages[value.error.code as ErrorCode]
  );
}
