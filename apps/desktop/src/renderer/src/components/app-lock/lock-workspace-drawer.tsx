import { useEffect, useRef, useState } from "react";
import { LockKeyholeIcon } from "lucide-react";
import { liveWorkCount, type CatalogState, type LiveWork } from "@ssterm/contracts";
import { Button } from "@/components/ui/button";
import { Drawer, useDrawerClose } from "@/components/drawer";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import { terminalIdentity } from "@/lib/terminal-target";

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/**
 * Lock workspace with live work (SST-040/13): a confirmation-only drawer listing what the lock closes in every window,
 * Cancel focused (Enter, Esc and × keep everything). `work` undefined: main could not say, so it asks anyway rather
 * than lock silently. The list is a snapshot; Lock closes whatever is live at that moment, including work started
 * since. Mounted per open (keyed); an OS screen lock while it is open has already closed the work, so it closes.
 */
export function LockWorkspaceDrawer({
  work,
  catalog,
  onConfirm,
  onClose,
}: {
  work: LiveWork | undefined;
  catalog: CatalogState | undefined;
  onConfirm(): void;
  onClose(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  const close = useDrawerClose();
  const { discard } = close;
  const [epoch] = useState(catalog?.lockEpoch);
  const relocked = catalog !== undefined && epoch !== undefined && catalog.lockEpoch !== epoch;
  useEffect(() => {
    if (relocked && !confirmed.current) discard();
  }, [relocked, discard]);
  const count = work ? liveWorkCount(work) : undefined;
  const rule = (id: string) => catalog?.tunnelRules.find((item) => item.id === id);
  const host = (id: string | undefined) => (id ? catalog?.hosts.find((item) => item.id === id) : undefined);
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      data-testid="lock-workspace-drawer"
      title="Lock workspace?"
      description={
        work
          ? "Locking closes this work in every ssterm window and returns to the sign-in screen. Cancel keeps everything running."
          : "ssterm couldn't check for live work. Locking closes any terminals, port forwards, transfers and remote edits in every window and returns to the sign-in screen."
      }
      footer={
        <>
          <Button ref={cancel} variant="outline" onClick={close.request}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!close.open || relocked}
            onClick={(event) => {
              // The second press of a double-click is not a second confirmation.
              if (event.detail > 1 || confirmed.current || relocked) return;
              confirmed.current = true;
              onConfirm();
              close.discard();
            }}
          >
            <LockKeyholeIcon />
            {count === undefined ? "Lock and close all" : `Lock and close ${count}`}
          </Button>
        </>
      }
    >
      {work ? (
        <>
          {work.terminals.length ? (
            <section className="grid gap-2" aria-label="Terminals">
              <h3 className="font-medium text-foreground">{plural(work.terminals.length, "terminal")}</h3>
              <ul className="grid gap-2" data-testid="lock-workspace-terminals">
                {work.terminals.map((session, index) => {
                  const identity = terminalIdentity(session);
                  return (
                    // A snapshot that never reorders while open; window-independent rows have no other identity.
                    <li key={index} className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate text-foreground">{identity.label}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {identity.local ? `LOCAL · ${identity.endpoint}` : identity.endpoint}
                          {session.phase === "connecting" ? " · Connecting" : ""}
                        </span>
                      </span>
                      <EnvironmentBadge environment={session.target?.environment} />
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {work.tunnels.length ? (
            <section className="grid gap-2" aria-label="Port forwarding">
              <h3 className="font-medium text-foreground">{plural(work.tunnels.length, "port forward")}</h3>
              <ul className="grid gap-2" data-testid="lock-workspace-tunnels">
                {work.tunnels.map((tunnel, index) => {
                  const item = rule(tunnel.ruleId);
                  const server = host(item?.hostId);
                  return (
                    // The same rule can run in two windows.
                    <li key={index} className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2">
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate text-foreground">{item?.label ?? "Port forward"}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {item ? `${item.bindAddress}:${item.bindPort}` : "Port forwarding rule"}
                          {server ? ` · ${server.label}` : ""}
                          {tunnel.phase === "starting" ? " · Starting" : ""}
                        </span>
                      </span>
                      <EnvironmentBadge environment={server?.environment} />
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          {work.transfers || work.remoteEdits ? (
            <ul className="grid list-disc gap-2 pl-5" aria-label="Files work that will stop">
              {work.transfers ? (
                <li>
                  {plural(work.transfers, "pending transfer")} will be cancelled. Temporary files are retained at the
                  paths shown in Transfers; a publication already in progress may finish.
                </li>
              ) : null}
              {work.remoteEdits ? (
                <li>
                  {plural(work.remoteEdits, "remote edit")} will be discarded. ssterm will attempt cleanup of private
                  working files; your editor may retain its own copies.
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      ) : (
        <p role="alert" className="text-foreground">Unknown live work may close.</p>
      )}
    </Drawer>
  );
}
