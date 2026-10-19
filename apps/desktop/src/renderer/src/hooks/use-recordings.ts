import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConfigureRecordingResponse, DeleteRecordingTarget, ExportRecordingResponse, ExportRecordingTarget, Owner, RecordingPolicy,
  RecordingState, Result,
} from "@ssterm/contracts";
import { call } from "@/components/identities/secret-input";

/** SST-034 recording state for one window. Pulled on mount and after each action; nothing is pushed. */
export function useRecordings(owner: Owner | undefined) {
  const windowId = owner?.windowId;
  const generation = owner?.generation;
  const [state, setState] = useState<RecordingState>();
  const [unavailable, setUnavailable] = useState(false);
  const latest = useRef(0);
  const accept = useCallback((result: Result<RecordingState>, request: number) => {
    if (request !== latest.current) return;
    if (result.ok) { setState(result.value); setUnavailable(false); } else setUnavailable(true);
  }, []);
  const refresh = useCallback(async () => {
    if (!windowId || !generation) return;
    const request = ++latest.current;
    accept(await call((bridge) => bridge.recordingState({ owner: { windowId, generation } })), request);
  }, [windowId, generation, accept]);
  useEffect(() => { void refresh(); }, [refresh]);
  const configure = useCallback(async (policy: RecordingPolicy): Promise<Result<ConfigureRecordingResponse>> => {
    if (!windowId || !generation) return { ok: false, error: { code: "unavailable", message: "" } };
    const request = ++latest.current;
    const result = await call((bridge) => bridge.configureRecording({ owner: { windowId, generation }, policy }));
    if (result.ok && result.value.status === "saved") accept({ ok: true, value: result.value.state }, request);
    else void refresh();
    return result;
  }, [windowId, generation, accept, refresh]);
  const remove = useCallback(async (target: DeleteRecordingTarget): Promise<boolean> => {
    if (!windowId || !generation) return false;
    const request = ++latest.current;
    const result = await call((bridge) => bridge.deleteRecordings({ owner: { windowId, generation }, target }));
    accept(result, request);
    return result.ok;
  }, [windowId, generation, accept]);
  const exportRecording = useCallback(async (target: ExportRecordingTarget): Promise<Result<ExportRecordingResponse>> => {
    if (!windowId || !generation) return { ok: false, error: { code: "unavailable", message: "" } };
    const result = await call((bridge) => bridge.exportRecording({ owner: { windowId, generation }, target }));
    void refresh();
    return result;
  }, [windowId, generation, refresh]);
  return { state, unavailable, refresh, configure, remove, exportRecording };
}
export type Recordings = ReturnType<typeof useRecordings>;
