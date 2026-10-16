import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CatalogChangeIntent,
  CatalogState,
  Owner,
} from "@ssterm/contracts";

export function useCatalog(owner: Owner | undefined) {
  const [state, setState] = useState<CatalogState>();
  const [error, setError] = useState(false);
  const accept = useRef<(next: CatalogState) => void>(undefined);
  const latest = useRef<CatalogState>(undefined);
  const windowId = owner?.windowId;
  const generation = owner?.generation;
  useEffect(() => {
    setState(undefined);
    setError(false);
    latest.current = undefined;
    const bridge = window.ssterm;
    if (!windowId || !generation || !bridge) return;
    let disposed = false;
    let current: CatalogState | undefined;
    const apply = (next: CatalogState) => {
      if (
        disposed ||
        next.owner.windowId !== windowId ||
        next.owner.generation !== generation ||
        // A requested snapshot repeats the last pushed sequence but is read later, so it may be newer.
        (current && next.sequence < current.sequence)
      )
        return;
      current = next;
      latest.current = next;
      setState(next);
      setError(false);
    };
    accept.current = apply;
    const unsubscribe = bridge.onCatalogState(apply);
    void bridge
      .catalogState({ owner: { windowId, generation } })
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
      accept.current = undefined;
      unsubscribe();
    };
  }, [windowId, generation]);

  const reload = useCallback(async () => {
    const bridge = window.ssterm;
    if (!windowId || !generation || !bridge) return;
    try {
      const result = await bridge.catalogState({
        owner: { windowId, generation },
      });
      if (result.ok) accept.current?.(result.value);
    } catch {
      // The pushed stream still delivers later changes.
    }
  }, [windowId, generation]);

  const prepare = useCallback(
    async (intent: CatalogChangeIntent) => {
      const bridge = window.ssterm;
      if (!windowId || !generation || !bridge) return unavailable;
      try {
        return await bridge.prepareCatalogChange({
          owner: { windowId, generation },
          intent,
        });
      } catch {
        return unavailable;
      }
    },
    [windowId, generation],
  );

  /** Resolves once this hook's state includes the applied revision, so callers can select created ids. */
  const apply = useCallback(
    async (token: string) => {
      const bridge = window.ssterm;
      if (!windowId || !generation || !bridge) return unavailable;
      try {
        const result = await bridge.applyCatalogChange({
          owner: { windowId, generation },
          token,
        });
        // Main pushes the new state before answering, so the reload is usually redundant.
        if (result.ok && (latest.current?.revision ?? -1) < result.value.revision)
          await reload();
        return result;
      } catch {
        return unavailable;
      }
    },
    [windowId, generation, reload],
  );

  // A changed owner cannot render a preceding document's catalog.
  const current =
    state &&
    state.owner.windowId === windowId &&
    state.owner.generation === generation
      ? state
      : undefined;
  return { state: current, error, reload, prepare, apply };
}
export type Catalog = ReturnType<typeof useCatalog>;

const unavailable = {
  ok: false,
  error: { code: "unavailable", message: "The application is unavailable." },
} as const;
