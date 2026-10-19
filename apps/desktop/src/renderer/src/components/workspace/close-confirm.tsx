import { useRef } from "react";
import type { TerminalSession } from "@ssterm/contracts";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { terminalIdentity } from "@/lib/terminal-target";

/** The sessions a pane or tab close would end, captured when Close was chosen. */
export interface CloseRequest {
  kind: "pane" | "tab";
  sessions: TerminalSession[];
}

/** Asked only when a connected session would end; Cancel has focus so Enter keeps it open. */
export function CloseConfirm({
  request,
  onCancel,
  onConfirm,
  confirmFocus,
}: {
  request?: CloseRequest;
  onCancel(): void;
  onConfirm(): void;
  /** Where focus goes after "Disconnect and close"; Cancel returns it to where it was. */
  confirmFocus(): HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  const connected = request?.sessions.filter((session) => session.phase === "ready") ?? [];
  const single = request?.sessions.length === 1 ? request.sessions[0] : undefined;
  const title = single
    ? single.local ? `End local shell on This Mac?` : `Disconnect and close ${terminalIdentity(single).label}?`
    : `Close this tab and disconnect ${connected.length} ${connected.length === 1 ? "session" : "sessions"}?`;
  return (
    <AlertDialog
      open={!!request}
      onOpenChange={(open) => {
        if (open) return;
        confirmed.current = false;
        onCancel();
      }}
    >
      <AlertDialogContent
        initialFocus={cancel}
        finalFocus={() => (confirmed.current ? (confirmFocus() ?? true) : true)}
        className="data-[size=default]:sm:max-w-md motion-reduce:animate-none"
        data-testid="close-confirm-dialog"
      >
        {request ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="min-w-0 break-words">{title}</AlertDialogTitle>
              <AlertDialogDescription>
                Sessions and local processes end now. Unsaved work in a running process may be lost. Nothing typed earlier is sent again if you reconnect later.
              </AlertDialogDescription>
            </AlertDialogHeader>
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
            <AlertDialogFooter>
              <Button
                ref={cancel}
                variant="outline"
                onClick={() => {
                  confirmed.current = false;
                  onCancel();
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  confirmed.current = true;
                  onConfirm();
                }}
              >
                Disconnect and close
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}
