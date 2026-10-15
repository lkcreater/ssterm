import {
  ConnectionStatus,
  type ConnectionState,
} from "@/components/connection/connection-status";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function SessionTab({
  name,
  state,
  active = false,
  focused = false,
  production = false,
}: {
  name: string;
  state: ConnectionState;
  active?: boolean;
  focused?: boolean;
  production?: boolean;
}) {
  return (
    <div
      className="session-tab"
      data-active={active}
      data-preview={focused ? "focus" : undefined}
    >
      <Tooltip>
        <TooltipTrigger
          render={<span tabIndex={0} className="session-tab-label truncate" />}
        >
          {name}
        </TooltipTrigger>
        <TooltipContent>{name}</TooltipContent>
      </Tooltip>
      {active ? (
        <span className="type-caption text-primary">Active</span>
      ) : null}
      {production ? <Badge variant="production">PROD</Badge> : null}
      <ConnectionStatus state={state} />
    </div>
  );
}
