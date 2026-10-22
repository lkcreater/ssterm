import { createContext, useContext } from "react";
import {
  CircleCheckIcon,
  CircleIcon,
  LoaderCircleIcon,
  ShieldQuestionIcon,
  TriangleAlertIcon,
} from "lucide-react";
export type ConnectionState =
  | "connected"
  | "connecting"
  | "awaiting-trust"
  | "error"
  | "disconnected";
const states = {
  connected: { label: "Connected", icon: CircleCheckIcon },
  connecting: { label: "Connecting", icon: LoaderCircleIcon },
  "awaiting-trust": { label: "Awaiting trust", icon: ShieldQuestionIcon },
  error: { label: "Connection error", icon: TriangleAlertIcon },
  disconnected: { label: "Disconnected", icon: CircleIcon },
} as const;

/** Sessions whose host key waits for an explicit trust decision (from the trust state's prompts). */
export const AwaitingTrust = createContext<ReadonlySet<string>>(new Set());
/** A connecting session that waits for a trust decision shows amber "Awaiting trust", never Connected. */
export function useAwaitingTrust() {
  const awaiting = useContext(AwaitingTrust);
  return (session: { sessionId: string; phase: string }) =>
    session.phase === "connecting" && awaiting.has(session.sessionId);
}

export function ConnectionStatus({
  state,
  announce = false,
}: {
  state: ConnectionState;
  announce?: boolean;
}) {
  const { icon: Icon, label } = states[state];
  return (
    <span
      className="connection-status"
      data-state={state}
      role={announce ? "status" : undefined}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
