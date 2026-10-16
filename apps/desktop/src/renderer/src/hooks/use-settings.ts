import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_TERMINAL_SETTINGS,
  type Owner,
  type TerminalSettings,
} from "@ssterm/contracts";

export type SettingsStatus = "loading" | "ready" | "unavailable";
const reasons: Record<Exclude<SettingsStatus, "ready">, string> = {
  loading: "Loading settings.",
  unavailable: "Settings can't be saved while workspace storage is unavailable. Defaults are in use.",
};

/**
 * Terminal settings for this window. Changes apply at once and are reverted to the stored value
 * when the save is refused; while storage is unavailable the defaults apply and editing is off.
 */
export function useSettings(owner: Owner | undefined) {
  const windowId = owner?.windowId;
  const generation = owner?.generation;
  const [settings, setSettings] = useState<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS);
  const [status, setStatus] = useState<SettingsStatus>("loading");
  const [error, setError] = useState<string>();
  // Only the latest save may settle the shown value; a slider sends many.
  const latest = useRef(0);
  const saved = useRef<TerminalSettings>(DEFAULT_TERMINAL_SETTINGS);

  useEffect(() => {
    setStatus("loading");
    setError(undefined);
    const bridge = window.ssterm;
    if (!windowId || !generation || !bridge) {
      setStatus(bridge ? "loading" : "unavailable");
      return;
    }
    let disposed = false;
    const request = ++latest.current;
    bridge
      .settings({ owner: { windowId, generation } })
      .then(
        (result) => {
          if (disposed || request !== latest.current) return;
          if (!result.ok) return setStatus("unavailable");
          saved.current = result.value;
          setSettings(result.value);
          setStatus("ready");
        },
        () => {
          if (!disposed) setStatus("unavailable");
        },
      );
    return () => {
      disposed = true;
    };
  }, [windowId, generation]);

  const update = useCallback(
    async (changes: Partial<TerminalSettings>): Promise<boolean> => {
      const bridge = window.ssterm;
      if (!windowId || !generation || !bridge || status !== "ready") return false;
      const request = ++latest.current;
      setSettings((current) => ({ ...current, ...changes }));
      setError(undefined);
      const result = await bridge
        .updateSettings({ owner: { windowId, generation }, changes })
        .catch(() => undefined);
      if (result?.ok) saved.current = result.value;
      else {
        const fresh = await bridge.settings({ owner: { windowId, generation } }).catch(() => undefined);
        if (fresh?.ok) saved.current = fresh.value;
      }
      if (request !== latest.current) return !!result?.ok;
      setSettings(saved.current);
      if (!result?.ok)
        setError(
          result?.error.code === "conflict"
            ? "Settings changed elsewhere; the stored values are shown."
            : "The setting could not be saved.",
        );
      return !!result?.ok;
    },
    [windowId, generation, status],
  );

  return {
    settings,
    status,
    /** Why the controls are disabled; undefined when they can be edited. */
    disabledReason: status === "ready" ? undefined : reasons[status],
    /** The last save failure, for the settings dialog. */
    error,
    update,
  };
}
