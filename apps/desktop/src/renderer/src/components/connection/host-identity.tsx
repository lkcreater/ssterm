import { CopyIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";

export interface HostTarget {
  name: string;
  user: string;
  host: string;
  port: number;
  production?: boolean;
}
export function targetLabel(target: HostTarget) {
  return `${target.user}@${target.host}:${target.port}`;
}

export function HostIdentity({
  target,
  copy = false,
}: {
  target: HostTarget;
  copy?: boolean;
}) {
  const fullTarget = targetLabel(target);
  const copyTarget = () =>
    toast.add(
      copyText(fullTarget)
        ? { title: "Target copied", description: fullTarget, type: "success" }
        : {
            title: "Could not copy target",
            description: "Select the full target text in the tooltip.",
            type: "error",
          },
    );
  return (
    <div className="host-identity">
      <Tooltip>
        <TooltipTrigger
          render={<span tabIndex={0} className="host-target truncate" />}
        >
          {fullTarget}
        </TooltipTrigger>
        <TooltipContent>
          <span className="select-text break-all">{fullTarget}</span>
        </TooltipContent>
      </Tooltip>
      {target.production ? <Badge variant="production">PROD</Badge> : null}
      {copy ? (
        <Button
          size="icon"
          variant="ghost"
          aria-label={`Copy target ${fullTarget}`}
          onClick={copyTarget}
        >
          <CopyIcon />
        </Button>
      ) : null}
    </div>
  );
}
