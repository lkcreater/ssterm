import { useRef } from "react";
import type { TerminalSession } from "@ssterm/contracts";
import { Drawer, useDrawerClose } from "@/components/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { terminalIdentity } from "@/lib/terminal-target";

/** The sessions a pane or tab close would end, captured when Close was chosen. */
export interface CloseRequest {
  kind: "pane" | "tab";
  sessions: TerminalSession[];
  /** A fresh drawer per request, even one made while the last is still sliding out. */
  serial: number;
}

/**
 * Asked only when a connected session would end: a confirmation-only drawer. Cancel has focus so Enter keeps the
 * sessions; Esc and × cancel. The caller mounts it per request (keyed by `serial`).
 */
export function CloseConfirm({
  request,
  onConfirm,
  onClose,
  confirmFocus,
}: {
  request: CloseRequest;
  /** Ends the captured sessions now; the drawer then slides out. */
  onConfirm(): void;
  /** After the exit motion, whether confirmed or cancelled. */
  onClose(): void;
  /** Where focus goes after "Disconnect and close"; Cancel returns it to where it was. */
  confirmFocus(): HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  const close = useDrawerClose();
  const connected = request.sessions.filter((session) => session.phase === "ready");
  const single = request.sessions.length === 1 ? request.sessions[0] : undefined;
  const title = single
    ? single.local ? `End local shell on This Mac?` : `Disconnect and close ${terminalIdentity(single).label}?`
    : `Close this tab and disconnect ${connected.length} ${connected.length === 1 ? "session" : "sessions"}?`;
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      finalFocus={() => (confirmed.current ? (confirmFocus() ?? true) : true)}
      data-testid="close-confirm-dialog"
      title={<span className="min-w-0 break-words">{title}</span>}
      description="Sessions and local processes end now. Unsaved work in a running process may be lost. Nothing typed earlier is sent again if you reconnect later."
      footer={
        <>
          <Button ref={cancel} variant="outline" onClick={close.request}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!close.open}
            onClick={() => {
              if (confirmed.current) return;
              confirmed.current = true;
              onConfirm();
              close.discard();
            }}
          >
            Disconnect and close
          </Button>
        </>
      }
    >
      <ul className="grid min-w-0 gap-2" aria-label="Sessions that will close">
        {request.sessions.map((session) => (
          <li key={session.sessionId} className="grid min-w-0 gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 font-medium break-all">{terminalIdentity(session).label}</span>
              {session.local ? <Badge variant="secondary">LOCAL</Badge> : null}
              {session.target?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
            </span>
            {terminalIdentity(session).endpoint ? (
              <span className="font-mono text-sm break-all text-muted-foreground">
                {terminalIdentity(session).endpoint}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Drawer>
  );
}
