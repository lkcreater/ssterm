import type { DesktopAPI, Owner, TerminalSession } from "@ssterm/contracts";
import { endpointText } from "./catalog-filter";

/** A local process has its own identity; it never borrows a saved SSH endpoint. */
export function terminalIdentity(session: Pick<TerminalSession, "target" | "local">) {
  if (session.local) return { label: "This Mac", endpoint: session.local.shell, local: true, production: false };
  const target = session.target;
  return {
    label: target?.label ?? "Unknown target",
    endpoint: target ? endpointText(target.endpointHost, target.endpointPort, target.username) : null,
    local: false,
    production: target?.environment === "PROD",
  };
}

/** Captured before decrypting: a later focus change cannot redirect single-pane input. */
export function captureTerminalTarget(session: TerminalSession | undefined) {
  if (!session || session.phase !== "ready") return undefined;
  return { sessionId: session.sessionId, generation: session.generation, ...terminalIdentity(session) };
}

/** Splits start a fresh process/connection, and never route a local pane to saved-host IPC. */
export function startSiblingTerminal(
  bridge: Pick<DesktopAPI, "startLocalTerminal" | "connectHost">,
  owner: Owner,
  session: TerminalSession,
) {
  if (session.local) return bridge.startLocalTerminal({ owner });
  if (!session.hostId) return Promise.resolve(undefined);
  return bridge.connectHost({ owner, hostId: session.hostId });
}
