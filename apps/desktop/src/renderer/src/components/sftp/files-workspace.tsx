import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, CircleIcon, LaptopIcon, RotateCcwIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import type { CatalogState, Owner, SftpSessionView } from "@ssterm/contracts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { SessionHeader } from "@/components/workspace/live-terminal";
import { FilePane, type FilePaneHandle } from "@/components/sftp/file-pane";
import { TransferQueue } from "@/components/sftp/transfer-queue";
import type { SftpController } from "@/hooks/use-sftp";
import { useTransfers } from "@/hooks/use-transfers";
import { parentPath } from "@/lib/file-browser";
import { endpointText } from "@/lib/catalog-filter";
import { lifecycleFailure, terminalOutcome, type LifecycleAction } from "@/lib/terminal-outcome";

const LOCAL = { kind: "local" } as const;
const methods = {
  close: "closeSftp",
  reconnect: "reconnectSftp",
  dismiss: "dismissSftp",
} as const satisfies Record<LifecycleAction, string>;

/**
 * The Files page: This Mac | one remote server, side by side. Kept mounted while another page is shown
 * (hidden and inert, like the terminal layer) so each pane keeps its folder, selection and session.
 */
export function FilesWorkspace({
  owner,
  sftp,
  catalog,
  hidden,
  local,
  remote,
}: {
  owner: Owner;
  sftp: SftpController;
  catalog: CatalogState | undefined;
  hidden: boolean;
  /** Selection snapshots for transfers (SST-021). */
  local?: Ref<FilePaneHandle>;
  remote?: Ref<FilePaneHandle>;
}) {
  const root = useRef<HTMLDivElement>(null);
  // Keys typed after a page switch must never reach a hidden pane.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (hidden && focused instanceof HTMLElement && root.current?.contains(focused)) focused.blur();
  }, [hidden]);
  const session = sftp.session;
  const localPane = useRef<FilePaneHandle | null>(null);
  const remotePane = useRef<FilePaneHandle | null>(null);
  const attachLocal = useCallback((pane: FilePaneHandle | null) => {
    localPane.current = pane;
    if (typeof local === "function") {
      const cleanup = local(pane);
      if (cleanup) return () => { localPane.current = null; cleanup(); };
      return;
    }
    if (local) local.current = pane;
  }, [local]);
  const attachRemote = useCallback((pane: FilePaneHandle | null) => {
    remotePane.current = pane;
    if (typeof remote === "function") {
      const cleanup = remote(pane);
      if (cleanup) return () => { remotePane.current = null; cleanup(); };
      return;
    }
    if (remote) remote.current = pane;
  }, [remote]);
  const transfers = useTransfers(owner);
  const completed = useRef(new Set<string>());
  useEffect(() => {
    completed.current.clear();
  }, [owner.windowId, owner.generation]);
  useEffect(() => {
    const active = new Set(transfers.jobs.map((job) => job.id));
    for (const id of completed.current) if (!active.has(id)) completed.current.delete(id);
    for (const job of transfers.jobs) {
      if (job.state !== "completed" || completed.current.has(job.id)) continue;
      completed.current.add(job.id);
      const destination = parentPath(job.destinationPath);
      if (job.direction === "download") localPane.current?.refresh(LOCAL, destination);
      else remotePane.current?.refresh({ kind: "remote", sessionId: job.sessionId, generation: job.generation }, destination);
    }
  }, [transfers.jobs]);
  const transfer = (direction: "upload" | "download") => {
    // Capture both panes synchronously at invocation. Later navigation never changes this request.
    const from = (direction === "upload" ? localPane : remotePane).current?.snapshot();
    const to = (direction === "upload" ? remotePane : localPane).current?.snapshot();
    if (!from || !to) { transfers.notify("Wait until both folders have finished loading."); return; }
    if (from.names.length === 0 || from.names.length > 100) {
      transfers.notify("Select between 1 and 100 files to transfer."); return;
    }
    void transfers.enqueue({ owner, source: from.source, sourceDirectory: from.path, names: [...from.names], destination: to.source, destinationDirectory: to.path });
  };
  // After the pane's Close, focus lands on the server picker that replaces it.
  const [pickerFocus, setPickerFocus] = useState(false);
  return (
    <div
      ref={root}
      className="files-workspace files-workspace-with-transfers"
      data-testid="files-workspace"
      data-hidden={hidden || undefined}
      inert={hidden}
      style={{ visibility: hidden ? "hidden" : undefined }}
    >
      <div className="transfer-actions">
        <Button size="sm" variant="outline" disabled={session?.phase !== "ready" || transfers.pending.has("enqueue")} onClick={() => transfer("upload")}>
          <ArrowUpFromLineIcon data-icon="inline-start" aria-hidden="true" />Upload selected files
        </Button>
        <Button size="sm" variant="outline" disabled={session?.phase !== "ready" || transfers.pending.has("enqueue")} onClick={() => transfer("download")}>
          <ArrowDownToLineIcon data-icon="inline-start" aria-hidden="true" />Download selected files
        </Button>
      </div>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="50" minSize={220} style={{ overflow: "hidden" }}>
          <section className="files-pane" aria-label="Local files on This Mac" data-pane="local">
            <div className="pane-header flex h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
              <LaptopIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="type-label truncate">This Mac</span>
              <span className="type-caption text-muted-foreground">Local</span>
            </div>
            <FilePane owner={owner} source={LOCAL} home={null} active={!hidden} label="This Mac" handle={attachLocal} />
          </section>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize file panes" />
        <ResizablePanel defaultSize="50" minSize={220} style={{ overflow: "hidden" }}>
          {session ? (
            <RemotePane
              key={session.sessionId}
              owner={owner}
              session={session}
              active={!hidden}
              handle={attachRemote}
              onDismissed={() => {
                setPickerFocus(true);
                sftp.forget();
              }}
            />
          ) : (
            <section className="files-pane" aria-label="Remote files" data-pane="remote">
              <div className="pane-header flex h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
                <ServerIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="type-label truncate">Remote</span>
                <span className="type-caption text-muted-foreground">No server</span>
              </div>
              <div className="files-message">
                {sftp.pending ? (
                  <span className="flex items-center gap-2 type-caption text-muted-foreground">
                    <Spinner aria-label="Opening the SFTP session" /> Opening
                  </span>
                ) : (
                  <Empty className="p-4">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <ServerIcon />
                      </EmptyMedia>
                      <EmptyTitle>Browse a server</EmptyTitle>
                      <EmptyDescription>
                        Choose a saved server. Its files open here with the identity it is saved with.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                      <ServerPicker state={catalog} autoFocus={pickerFocus} onOpen={(hostId) => void sftp.open(hostId)} />
                      {sftp.failure ? (
                        <Alert variant="destructive">
                          <TriangleAlertIcon aria-hidden="true" />
                          <AlertTitle>Could not open SFTP</AlertTitle>
                          <AlertDescription>{sftp.failure.message}</AlertDescription>
                        </Alert>
                      ) : null}
                    </EmptyContent>
                  </Empty>
                )}
              </div>
            </section>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
      <TransferQueue transfers={transfers} />
    </div>
  );
}

function ServerPicker({
  state,
  autoFocus,
  onOpen,
}: {
  state: CatalogState | undefined;
  autoFocus: boolean;
  onOpen(hostId: string): void;
}) {
  const hosts = useMemo(() => new Map((state?.hosts ?? []).map((host) => [host.id, host])), [state?.hosts]);
  const identities = useMemo(() => new Map((state?.identities ?? []).map((row) => [row.id, row])), [state?.identities]);
  const ids = useMemo(() => [...hosts.keys()], [hosts]);
  const ready = state?.availability === "ready";
  return (
    <div className="flex w-full max-w-72 flex-col gap-1" data-files-picker>
      <Combobox
        items={ids}
        value={null}
        disabled={!ready || ids.length === 0}
        itemToStringLabel={(id: string) => hosts.get(id)?.label ?? ""}
        onValueChange={(id: string | null) => {
          if (id) onOpen(id);
        }}
      >
        <ComboboxInput autoFocus={autoFocus} aria-label="Server to browse" placeholder={ids.length ? "Choose a server" : "No saved servers"} />
        <ComboboxContent>
          <ComboboxEmpty>No servers match.</ComboboxEmpty>
          <ComboboxList>
            {(id: string) => {
              const host = hosts.get(id)!;
              // Same rule as Connect: a server opens only with a chosen identity.
              const usable = host.effective.authSelection === "identity";
              const identity = host.effective.identityId ? identities.get(host.effective.identityId) : undefined;
              return (
                <ComboboxItem key={id} value={id} disabled={!usable} data-host-id={id}>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{host.label}</span>
                      {host.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
                    </span>
                    <span className="type-caption truncate text-muted-foreground">
                      {usable
                        ? endpointText(host.address, host.effective.port, identity?.username)
                        : "Choose an identity to connect"}
                    </span>
                  </span>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {!ready ? <p className="type-caption text-muted-foreground">Saved servers are unavailable right now.</p> : null}
    </div>
  );
}

function RemotePane({
  owner,
  session,
  active,
  handle,
  onDismissed,
}: {
  owner: Owner;
  session: SftpSessionView;
  active: boolean;
  handle?: Ref<FilePaneHandle>;
  onDismissed(): void;
}) {
  const { sessionId, generation, phase, target } = session;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [connected, setConnected] = useState(0);
  if (phase === "ready" && connected !== generation) setConnected(generation);
  const label = target?.label ?? "Unknown target";
  const outcome = terminalOutcome({ ...session, end: null }, connected === generation, "sftp");
  const ended = phase === "failed" || phase === "closed";
  const pane = useRef<HTMLElement>(null);
  // The button that was pressed is replaced by the next phase's; focus follows like a terminal pane's.
  // A pane mounted while connecting takes focus on its first Ready too: the credential dialog that was open
  // meanwhile returns focus to the hidden Open SFTP button, which leaves it on body.
  const focusAfter = useRef<{ action: "close" | "reconnect"; generation: number } | undefined>(
    phase === "ready" ? undefined : { action: "reconnect", generation: 0 },
  );
  useEffect(() => {
    const pending = focusAfter.current;
    if (!pending) return;
    const target =
      pending.action === "close" && ended
        ? pane.current?.querySelector<HTMLElement>(".files-message button")
        : pending.action === "reconnect" && phase === "ready" && generation > pending.generation
          ? pane.current?.querySelector<HTMLElement>('[role="listbox"]')
          : undefined;
    if (!target) return;
    focusAfter.current = undefined;
    const focused = document.activeElement;
    // Only if the user has not moved on to something else meanwhile.
    if (!focused || focused === document.body || pane.current?.contains(focused)) target.focus();
  }, [phase, generation, ended]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const act = (action: LifecycleAction, detail = 0) => {
    const bridge = window.ssterm;
    if (!bridge || busy || (action !== "reconnect" && detail > 1)) return;
    setBusy(true);
    focusAfter.current = action === "dismiss" ? undefined : { action, generation };
    const fail = (text: string) => {
      focusAfter.current = undefined;
      setNotice(text);
    };
    bridge[methods[action]]({ owner, sessionId, generation })
      .then(
        (result) => {
          if (!result.ok) fail(lifecycleFailure(action, result.error.code, session.error === "locked"));
          else if (action === "dismiss") onDismissed();
        },
        () => fail(lifecycleFailure(action, "unavailable")),
      )
      .finally(() => setBusy(false));
  };
  return (
    <section
      ref={pane}
      className="files-pane"
      aria-label={`Remote files on ${label}`}
      data-pane="remote"
      data-session-id={sessionId}
      data-generation={generation}
      data-phase={phase}
    >
      <SessionHeader
        target={target}
        phase={phase}
        outcome={outcome}
        busy={busy}
        onAction={act}
        onNotify={setNotice}
      />
      <FilePane
        owner={owner}
        source={phase === "ready" ? { kind: "remote", sessionId, generation } : null}
        home={session.home}
        active={active}
        label={label}
        handle={handle}
        unavailable={
          ended ? (
            <Alert variant={phase === "failed" ? "destructive" : "default"}>
              {phase === "failed" ? <TriangleAlertIcon aria-hidden="true" /> : <CircleIcon aria-hidden="true" />}
              <AlertTitle>{connected ? "Not connected" : "Nothing was opened"}</AlertTitle>
              <AlertDescription>Reconnect opens a new SFTP session at the same folder.</AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => act("reconnect")}>
                  <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                  Reconnect
                </Button>
              </AlertAction>
            </Alert>
          ) : (
            <span className="flex items-center gap-2 type-caption text-muted-foreground">
              <Spinner aria-label={`Connecting to ${label}`} /> Connecting
            </span>
          )
        }
      />
      <p role="status" className="files-pane-notice type-caption" data-testid="files-feedback">
        {notice}
      </p>
    </section>
  );
}
