import { useEffect, useState } from "react";
import type { Owner, TunnelState } from "@ssterm/contracts";

/** Owner-fenced tunnel status: pushed changes plus one initial snapshot. */
export function useTunnels(owner: Owner | undefined) {
  const [state, setState] = useState<TunnelState>();
  const windowId = owner?.windowId;
  const generation = owner?.generation;
  useEffect(() => {
    setState(undefined);
    const bridge = window.ssterm;
    if (!windowId || !generation || !bridge) return;
    let disposed = false;
    let current: TunnelState | undefined;
    const apply = (next: TunnelState) => {
      if (disposed || next.owner.windowId !== windowId || next.owner.generation !== generation) return;
      if (current && next.sequence < current.sequence) return;
      current = next;
      setState(next);
    };
    const unsubscribe = bridge.onTunnelState(apply);
    void bridge.tunnelState({ owner: { windowId, generation } }).then((result) => { if (result.ok) apply(result.value); }, () => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [windowId, generation]);
  return state && state.owner.windowId === windowId && state.owner.generation === generation ? state : undefined;
}
