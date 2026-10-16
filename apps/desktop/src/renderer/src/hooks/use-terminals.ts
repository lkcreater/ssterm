import { useEffect, useState } from "react";
import type { Owner, TerminalState } from "@ssterm/contracts";

export function useTerminals(owner: Owner | undefined) {
  const [state, setState] = useState<TerminalState>();
  const [error, setError] = useState(false);
  const windowId = owner?.windowId;
  const generation = owner?.generation;
  useEffect(() => {
    setState(undefined);
    setError(false);
    const bridge = window.ssterm;
    if (!windowId || !generation || !bridge) return;
    let disposed = false;
    let current: TerminalState | undefined;
    const apply = (next: TerminalState) => {
      if (
        disposed ||
        next.owner.windowId !== windowId ||
        next.owner.generation !== generation ||
        (current && next.sequence <= current.sequence)
      )
        return;
      current = next;
      setState(next);
      setError(false);
    };
    const unsubscribe = bridge.onTerminalState(apply);
    void bridge
      .terminalState({ owner: { windowId, generation } })
      .then((result) => {
        if (disposed) return;
        if (result.ok) apply(result.value);
        else setError(true);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [windowId, generation]);
  // A changed owner cannot render a preceding document's sessions.
  const current =
    state &&
    state.owner.windowId === windowId &&
    state.owner.generation === generation
      ? state
      : undefined;
  return { state: current, error };
}
