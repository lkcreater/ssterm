import { useEffect, useState } from "react";
import type { BootstrapData, WindowStateEvent } from "@ssterm/contracts";

type DesktopState =
  | { status: "loading" }
  | { status: "unavailable" }
  // A valid bootstrap can report blocked storage; presentation checks data.storage.
  | { status: "ready"; data: BootstrapData };

/** One subscription per mount, bounded race buffer, and no stale async writes. */
export function useDesktopState(): DesktopState {
  const [state, setState] = useState<DesktopState>({ status: "loading" });
  useEffect(() => {
    const bridge = window.ssterm;
    if (!bridge) {
      setState({ status: "unavailable" });
      return;
    }
    let disposed = false;
    let current: BootstrapData | undefined;
    let pending: WindowStateEvent | undefined;
    const apply = (event: WindowStateEvent) => {
      if (
        !current ||
        event.owner.windowId !== current.owner.windowId ||
        event.owner.generation !== current.owner.generation ||
        event.sequence <= current.window.sequence
      )
        return;
      current = {
        ...current,
        window: { focused: event.focused, sequence: event.sequence },
      };
      if (!disposed) setState({ status: "ready", data: current });
    };
    const unsubscribe = bridge.onWindowState((event) => {
      if (disposed) return;
      if (current) apply(event);
      // Focus can arrive before bootstrap; retain only the newest event.
      else if (!pending || event.sequence > pending.sequence) pending = event;
    });
    void bridge
      .bootstrap()
      .then((result) => {
        if (disposed) return;
        if (!result.ok) {
          setState({ status: "unavailable" });
          return;
        }
        current = result.value;
        setState({ status: "ready", data: current });
        if (pending) apply(pending);
        pending = undefined;
      })
      .catch(() => {
        if (!disposed) setState({ status: "unavailable" });
      });
    return () => {
      disposed = true;
      pending = undefined;
      unsubscribe();
    };
  }, []);
  return state;
}
