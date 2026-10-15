import {
  CircleCheckIcon,
  CircleIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
export type ConnectionState =
  | "connected"
  | "connecting"
  | "error"
  | "disconnected";
const states = {
  connected: { label: "Connected", icon: CircleCheckIcon },
  connecting: { label: "Connecting", icon: LoaderCircleIcon },
  error: { label: "Connection error", icon: TriangleAlertIcon },
  disconnected: { label: "Disconnected", icon: CircleIcon },
} as const;

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
