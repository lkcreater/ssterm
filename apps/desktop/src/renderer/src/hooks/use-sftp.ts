import { useEffect, useRef, useState } from "react";
import type { ErrorCode, Owner, SftpSessionView, SftpState } from "@ssterm/contracts";
import { toast } from "@/components/ui/toast";

const connectMessages: Partial<Record<ErrorCode, string>> = {
  busy: "Too many sessions are open; close ended panes first.",
  unavailable: "Connections are unavailable while the workspace is locked or closed. Unlock it and try again.",
  "invalid-request": "This server can no longer be connected. Review its settings.",
  "stale-owner": "This window changed. Try again.",
};

export type SftpFailure = { hostId: string; message: string };

/**
 * The window's SFTP sessions (subscribe before snapshot, owner and sequence fenced) and its one
 * remote browser: opening another host retires every earlier session without asking (browse-only).
 */
export function useSftp(owner: Owner | undefined) {
  const [state, setState] = useState<SftpState>();
  const [current, setCurrent] = useState<string>();
  const [failure, setFailure] = useState<SftpFailure>();
  const opening = useRef(false);
  const windowId = owner?.windowId;
  const generation = owner?.generation;
  useEffect(() => {
    setState(undefined);
    setCurrent(undefined);
    setFailure(undefined);
    const bridge = window.ssterm;
    if (!windowId || !generation || !bridge) return;
    let disposed = false;
    let latest: SftpState | undefined;
    const apply = (next: SftpState) => {
      if (
        disposed ||
        next.owner.windowId !== windowId ||
        next.owner.generation !== generation ||
        (latest && next.sequence <= latest.sequence)
      )
        return;
      latest = next;
      setState(next);
    };
    const unsubscribe = bridge.onSftpState(apply);
    void bridge
      .sftpState({ owner: { windowId, generation } })
      .then((result) => {
        if (result.ok) apply(result.value);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [windowId, generation]);
  const sessions =
    state && state.owner.windowId === windowId && state.owner.generation === generation ? state.sessions : [];
  const latestSessions = useRef(sessions);
  latestSessions.current = sessions;
  const found = current ? sessions.find((row) => row.sessionId === current) : undefined;
  // Before a window reload's sessions are adopted, the newest one is the browser's.
  const session: SftpSessionView | undefined = current ? found : sessions.at(-1);
  const shown = useRef(session);
  shown.current = session;

  const retire = (row: SftpSessionView) => {
    const bridge = window.ssterm;
    if (!bridge || !windowId || !generation) return;
    // The newest generation known now: a Reconnect since the snapshot would make the old one a conflict.
    const latest = latestSessions.current.find((entry) => entry.sessionId === row.sessionId) ?? row;
    const target = { owner: { windowId, generation }, sessionId: latest.sessionId, generation: latest.generation };
    const live = latest.phase === "ready" || latest.phase === "connecting";
    void (async () => {
      if (live && !(await bridge.closeSftp(target)).ok) return false;
      return (await bridge.dismissSftp(target)).ok;
    })()
      .catch(() => false)
      .then((ok) => {
        if (ok) return;
        // It is no longer shown anywhere, so this toast stays as its only control.
        const id = toast.add({
          title: `The SFTP session for ${latest.target?.label ?? "the previous server"} could not be closed`,
          type: "error",
          timeout: 0,
          actionProps: {
            children: "Close it",
            onClick: () => {
              toast.close(id);
              retire(latest);
            },
          },
        });
      });
  };

  return {
    sessions,
    /** The remote pane's session; undefined while none is open or a just-opened one is not listed yet. */
    session,
    /** A session was opened and is not listed yet. */
    pending: !!current && !found,
    failure,
    /** Connects `hostId` as saved now; resolves false when it could not start (see `failure`, or a toast while a session is shown). */
    async open(hostId: string): Promise<boolean> {
      const bridge = window.ssterm;
      if (!bridge || !windowId || !generation || opening.current) return false;
      setFailure(undefined);
      const open = shown.current;
      // Already browsing this server: show it where it is.
      if (open?.hostId === hostId && (open.phase === "ready" || open.phase === "connecting")) {
        setCurrent(open.sessionId);
        return true;
      }
      opening.current = true;
      const previous = latestSessions.current;
      let code: ErrorCode = "unavailable";
      try {
        const result = await bridge.connectSftp({ owner: { windowId, generation }, hostId });
        if (result.ok) {
          setCurrent(result.value.sessionId);
          previous.forEach(retire);
          return true;
        }
        code = result.error.code;
      } catch {
        // Reported as unavailable below.
      } finally {
        opening.current = false;
      }
      const message = connectMessages[code] ?? "The connection could not start. Try again.";
      // The picker shows `failure`; while a session is shown instead of it, a toast does.
      if (shown.current) toast.add({ title: "Could not open SFTP", description: message, type: "error" });
      else setFailure({ hostId, message });
      return false;
    },
    /** After the pane's Close: show the server picker again. */
    forget() {
      setCurrent(undefined);
    },
  };
}
export type SftpController = ReturnType<typeof useSftp>;
