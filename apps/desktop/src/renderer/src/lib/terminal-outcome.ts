/** Pane copy for how a session generation ended. Every string is app-authored; upstream text never reaches it. */
import type { ErrorCode, TerminalErrorCode, TerminalSession } from "@ssterm/contracts";

const reasons = {
  "invalid-config": "the saved host settings are not usable",
  "host-key-untrusted": "the host key was not trusted",
  "host-key-changed": "the host key changed; review it in Known hosts",
  "auth-denied": "the server rejected the credentials",
  "credentials-required": "a password or key is required",
  "credentials-unavailable": "saved credentials could not be read",
  "invalid-private-key": "the private key could not be read",
  "unsupported-private-key": "the private key type is not supported",
  "key-mismatch": "the saved private key does not match its public key",
  "prompt-cancelled": "authentication was cancelled",
  timeout: "the server did not respond in time",
  dns: "the host name could not be resolved",
  network: "the server could not be reached",
  "channel-open-failed": "the server did not open a terminal",
  "subsystem-unavailable": "the connection could not be started",
  "resource-limit": "a session limit was reached",
  locked: "ssterm is locked",
} as const satisfies Record<TerminalErrorCode, string>;

/**
 * `connected` means this generation reached Ready, so output was possible: a network or timeout
 * failure after that is a lost connection rather than a failed attempt.
 */
export function terminalOutcome(
  session: Pick<TerminalSession, "phase" | "end" | "error">,
  connected: boolean,
): string | null {
  const { phase, end, error } = session;
  if (end?.kind === "exit") return `Remote process exited with status ${end.code}`;
  if (end?.kind === "signal") return `Remote process was terminated by ${end.signal}`;
  if (end?.kind === "eof") return "The remote end closed the session";
  if (phase === "connecting" || phase === "ready") return null;
  if (error === "locked") return "Closed because ssterm locked (screen lock or sleep)";
  // A failed generation that is then closed keeps its failure, which stays the reason shown.
  if (phase === "closed" && error === null) return "Session closed";
  if (connected && (error === null || error === "network" || error === "timeout")) return "Connection lost";
  if (error === null) return "Couldn't connect";
  if (connected && error === "resource-limit") return "Session failed: output exceeded the safety limit";
  return `${connected ? "Session failed" : "Couldn't connect"}: ${reasons[error]}`;
}

export type LifecycleAction = "close" | "reconnect" | "dismiss";

/**
 * Why a Cancel/Disconnect/Reconnect/Close pane request was refused. `locked`: the pane was closed by a
 * lock, so a refused Reconnect (the unlock action) means ssterm could not unlock.
 */
export function lifecycleFailure(action: LifecycleAction, code: ErrorCode, locked = false): string {
  // Teardown is awaited before Reconnect/Close pane act, so a conflict means another action changed the session.
  if (code === "conflict") return "This session changed since you clicked; check the pane and try again.";
  if (code === "stale-owner") return "This window is out of date; reopen it to continue.";
  if (code === "unavailable" && action === "reconnect")
    return locked ? "Couldn't reconnect: ssterm could not unlock. Try again." : "Couldn't reconnect. Try again.";
  return "That didn't work; try again.";
}
