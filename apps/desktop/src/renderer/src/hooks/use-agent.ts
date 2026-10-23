import { useEffect, useState } from "react";
import type { AgentState, Owner } from "@ssterm/contracts";

/** Owner-fenced agent state (SST-041): pushed conversation views plus one initial snapshot. */
export function useAgentState(owner: Owner | undefined) {
  const [state, setState] = useState<AgentState>();
  const windowId = owner?.windowId;
  const generation = owner?.generation;
  useEffect(() => {
    setState(undefined);
    const bridge = window.ssterm;
    if (!windowId || !generation || !bridge) return;
    let disposed = false;
    let current: AgentState | undefined;
    const apply = (next: AgentState) => {
      if (disposed || next.owner.windowId !== windowId || next.owner.generation !== generation) return;
      if (current && next.sequence < current.sequence) return;
      current = next;
      setState(next);
    };
    const unsubscribe = bridge.onAgentState(apply);
    void bridge.agentState({ owner: { windowId, generation } }).then((result) => { if (result.ok) apply(result.value); }, () => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [windowId, generation]);
  return state && state.owner.windowId === windowId && state.owner.generation === generation ? state : undefined;
}
