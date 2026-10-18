import { useEffect, useRef, useState } from "react";
import type { ErrorCode, Owner, RemoteEditState, RemoteEditView, StartRemoteEditRequest } from "@ssterm/contracts";

const problems: Partial<Record<ErrorCode, string>> = {
  busy: "Remote edits are busy. Finish an edit or wait for its files to close before trying again.",
  conflict: "This edit changed. Review its current state and check for changes again before uploading.",
  "invalid-request": "Select one regular remote text file, up to 8 MiB, then try again.",
  "stale-owner": "This window changed. Reopen Files to continue.",
  unauthorized: "Unlock the app to continue.",
  unavailable: "Remote editing is unavailable. Check the SFTP connection and try again.",
};

/** Metadata only; main owns working copies, approvals, scheduling and cleanup. */
export function useRemoteEdit(owner: Owner) {
  const [state, setState] = useState<RemoteEditState>();
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const latest = useRef<RemoteEditState | undefined>(undefined);
  const liveOwner = useRef(owner);
  liveOwner.current = owner;
  const { windowId, generation } = owner;
  useEffect(() => {
    setState(undefined);
    setFailure(undefined);
    setPending(new Set());
    inFlight.current = new Set();
    latest.current = undefined;
    const bridge = window.ssterm;
    if (!bridge) return;
    let disposed = false;
    const apply = (next: RemoteEditState) => {
      if (disposed || next.owner.windowId !== windowId || next.owner.generation !== generation ||
        (latest.current && next.sequence <= latest.current.sequence)) return;
      latest.current = next;
      setState(next);
    };
    const unsubscribe = bridge.onRemoteEditState(apply);
    void bridge.remoteEditState({ owner: { windowId, generation } }).then((result) => {
      if (result.ok) apply(result.value);
      else if (!disposed) setFailure("Remote edits could not be read.");
    }).catch(() => { if (!disposed) setFailure("Remote edits could not be read."); });
    return () => { disposed = true; unsubscribe(); };
  }, [windowId, generation]);

  const invoke = async (key: string, call: () => Promise<{ ok: boolean; error?: { code: ErrorCode } }>) => {
    const captured = owner;
    const current = () => liveOwner.current.windowId === captured.windowId && liveOwner.current.generation === captured.generation;
    if (!current() || inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    setPending(new Set(inFlight.current));
    setFailure(undefined);
    try {
      const result = await call();
      if (!result.ok && current()) setFailure(problems[result.error?.code ?? "unavailable"] ?? "The remote edit action could not be completed.");
      return result.ok && current();
    } catch {
      if (current()) setFailure(problems.unavailable);
      return false;
    } finally {
      if (current()) {
        inFlight.current.delete(key);
        setPending(new Set(inFlight.current));
      }
    }
  };
  const bridge = window.ssterm;
  const act = (edit: RemoteEditView, action: "openRemoteEditor" | "checkRemoteEdit" | "discardRemoteEdit") => {
    const current = latest.current?.edits.find((row) => row.id === edit.id);
    if (!bridge || !current || current.revision !== edit.revision) return Promise.resolve(false);
    return invoke(edit.id, () => bridge[action]({ owner, editId: edit.id, revision: edit.revision }));
  };
  return {
    edits: state?.owner.windowId === windowId && state.owner.generation === generation ? state.edits : [],
    failure,
    pending,
    notify: setFailure,
    start: (request: StartRemoteEditRequest) => bridge ? invoke("start", () => bridge.startRemoteEdit(request)) : Promise.resolve(false),
    open: (edit: RemoteEditView) => act(edit, "openRemoteEditor"),
    check: (edit: RemoteEditView) => act(edit, "checkRemoteEdit"),
    discard: (edit: RemoteEditView) => act(edit, "discardRemoteEdit"),
    upload: (edit: RemoteEditView) => {
      const current = latest.current?.edits.find((row) => row.id === edit.id);
      if (!bridge || !current || current.revision !== edit.revision || current.approvalId !== edit.approvalId || !edit.approvalId || current.state !== "changed") return Promise.resolve(false);
      return invoke(edit.id, () => bridge.uploadRemoteEdit({ owner, editId: edit.id, revision: edit.revision, approvalId: edit.approvalId! }));
    },
  };
}
export type RemoteEditController = ReturnType<typeof useRemoteEdit>;
