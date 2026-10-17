import { useEffect, useRef, useState } from "react";
import type { EnqueueTransfersRequest, ErrorCode, Owner, ResolveTransferConflictRequest, TransferState } from "@ssterm/contracts";
import { acceptTransferState } from "@/lib/transfer-display";

const problems: Partial<Record<ErrorCode, string>> = {
  busy: "The transfer queue is full. Clear finished transfers or wait for a transfer to finish.",
  conflict: "The SFTP session changed. Review both folders and try again.",
  "invalid-request": "Select between 1 and 100 files and check both folders before transferring.",
  "stale-owner": "This window changed. Reopen Files to continue.",
  unavailable: "Transfers are unavailable. Check the SFTP connection and try again.",
};

/** Metadata only. Subscribe before requesting the snapshot; main owns all file I/O and scheduling. */
export function useTransfers(owner: Owner) {
  const [state, setState] = useState<TransferState>();
  const [failure, setFailure] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const { windowId, generation } = owner;
  const liveOwner = useRef(owner);
  liveOwner.current = owner;
  useEffect(() => {
    setState(undefined);
    setFailure(undefined);
    setPending(new Set());
    inFlight.current.clear();
    const bridge = window.ssterm;
    if (!bridge) return;
    let disposed = false;
    let latest: TransferState | undefined;
    const captured = { windowId, generation };
    const apply = (next: TransferState) => {
      if (disposed || !acceptTransferState(latest, next, captured)) return;
      latest = next;
      setState(next);
    };
    const unsubscribe = bridge.onTransferState(apply);
    void bridge.transferState({ owner: captured }).then((result) => {
      if (result.ok) apply(result.value);
      else if (!disposed) setFailure("The transfer queue could not be read.");
    }).catch(() => {
      if (!disposed) setFailure("The transfer queue could not be read.");
    });
    return () => { disposed = true; unsubscribe(); };
  }, [windowId, generation]);

  const invoke = async (key: string, call: () => Promise<{ ok: boolean; error?: { code: ErrorCode } }>, action?: "retry" | "resolve") => {
    if (inFlight.current.has(key)) return false;
    const captured = liveOwner.current;
    const current = () => liveOwner.current.windowId === captured.windowId && liveOwner.current.generation === captured.generation;
    inFlight.current.add(key);
    setPending(new Set(inFlight.current));
    setFailure(undefined);
    try {
      const result = await call();
      if (!result.ok && current()) {
        const code = result.error?.code ?? "unavailable";
        setFailure(action === "retry" && code === "busy"
          ? "The previous transfer is still closing its files. Wait for cleanup, then choose Retry again."
          : action === "retry" && code === "conflict"
            ? "The original SFTP session is no longer available. Open a fresh session manually, review both folders, and start a new transfer."
            : action === "resolve" && code === "conflict"
              ? "This conflict changed. Review the current destination and choose again."
              : problems[code] ?? "The transfer action could not be completed.");
      }
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
  const jobs = state?.owner.windowId === windowId && state.owner.generation === generation ? state.jobs : [];
  return {
    jobs,
    failure,
    pending,
    notify: setFailure,
    enqueue: (request: EnqueueTransfersRequest) => bridge && invoke("enqueue", () => bridge.enqueueTransfers(request)),
    cancel: (jobId: string) => bridge && invoke(jobId, () => bridge.cancelTransfer({ owner, jobId })),
    clear: () => bridge && invoke("clear", () => bridge.clearFinishedTransfers({ owner })),
    resolve: (jobId: string, conflictId: string, decision: ResolveTransferConflictRequest["decision"], name: string | null) =>
      bridge && invoke(jobId, () => bridge.resolveTransferConflict({ owner, jobId, conflictId, decision, name }), "resolve"),
    retry: (jobId: string) => bridge && invoke(jobId, () => bridge.retryTransfer({ owner, jobId }), "retry"),
  };
}
export type TransferController = ReturnType<typeof useTransfers>;
