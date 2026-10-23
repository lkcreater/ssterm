import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { PageHeader } from "@/components/page-header";
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, CircleIcon, FilePenLineIcon, LaptopIcon, RotateCcwIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import type { CatalogState, Owner, SftpSessionView } from "@ssterm/contracts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Drawer, firstUsable, useDrawerClose } from "@/components/drawer";
import { ConnectionStatus, useAwaitingTrust, type ConnectionState } from "@/components/connection/connection-status";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Spinner } from "@/components/ui/spinner";
import { SessionHeader } from "@/components/workspace/live-terminal";
import { FilePane, type FilePaneHandle } from "@/components/sftp/file-pane";
import { TransferQueue } from "@/components/sftp/transfer-queue";
import { RemoteEdits } from "@/components/sftp/remote-edits";
import type { SftpController, SftpSwitch } from "@/hooks/use-sftp";
import { useTransfers } from "@/hooks/use-transfers";
import { useRemoteEdit } from "@/hooks/use-remote-edit";
import { joinPath, parentPath } from "@/lib/file-browser";
import { endpointText } from "@/lib/catalog-filter";
import { terminalIdentity } from "@/lib/terminal-target";
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
  const edits = useRemoteEdit(owner);
  const editButton = useRef<HTMLButtonElement>(null);
  const uploaded = useRef(new Map<string, number>());
  useEffect(() => { uploaded.current.clear(); }, [owner.windowId, owner.generation]);
  useEffect(() => {
    const retained = new Set(edits.edits.map((edit) => edit.id));
    for (const id of uploaded.current.keys()) if (!retained.has(id)) uploaded.current.delete(id);
    for (const edit of edits.edits) {
      if (edit.state !== "uploaded" || uploaded.current.get(edit.id) === edit.revision) continue;
      uploaded.current.set(edit.id, edit.revision);
      remotePane.current?.refresh({ kind: "remote", sessionId: edit.sessionId, generation: edit.generation }, parentPath(edit.remotePath));
    }
  }, [edits.edits]);
  const startEdit = () => {
    const captured = remotePane.current?.snapshot();
    if (!captured || captured.source.kind !== "remote") { edits.notify("Wait until the remote folder has finished loading."); return; }
    if (captured.names.length !== 1) { edits.notify("Select one regular remote text file to edit."); return; }
    void edits.start({ owner, source: captured.source, path: joinPath(captured.path, captured.names[0]!) });
  };
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
  const picker = useRef<HTMLButtonElement>(null);
  return (
    <div
      ref={root}
      className="files-workspace files-workspace-with-transfers"
      data-testid="files-workspace"
      data-hidden={hidden || undefined}
      inert={hidden}
      style={{ visibility: hidden ? "hidden" : undefined }}
    >
      <PageHeader
        className="files-header"
        title="Files"
        subtitle="Browse this Mac and one server over SFTP; transfers keep the folders they were started with."
        actions={
          <>
        <ServerPicker
          ref={picker}
          state={catalog}
          session={session}
          pending={sftp.pending}
          failed={!!sftp.failure}
          onOpen={(hostId) => void sftp.open(hostId)}
        />
        <Button size="sm" variant="outline" title="Upload selected files" disabled={session?.phase !== "ready" || transfers.pending.has("enqueue")} onClick={() => transfer("upload")}>
          <ArrowUpFromLineIcon data-icon="inline-start" aria-hidden="true" /><span className="page-action-text">Upload selected files</span>
        </Button>
        <Button size="sm" variant="outline" title="Download selected files" disabled={session?.phase !== "ready" || transfers.pending.has("enqueue")} onClick={() => transfer("download")}>
          <ArrowDownToLineIcon data-icon="inline-start" aria-hidden="true" /><span className="page-action-text">Download selected files</span>
        </Button>
        <Button ref={editButton} size="sm" variant="outline" title="Edit remote file" disabled={session?.phase !== "ready" || edits.pending.has("start")} onClick={startEdit}>
          <FilePenLineIcon data-icon="inline-start" aria-hidden="true" /><span className="page-action-text">Edit remote file</span>
        </Button>
          </>
        }
      />
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
                // Focus lands on the server picker, which opens the next server.
                picker.current?.focus();
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
                        Choose a saved server above. Its files open here with the identity it is saved with.
                      </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
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
      <RemoteEdits edits={edits} fallbackFocus={editButton} />
      {sftp.switching ? (
        <SwitchConfirm
          key={sftp.switching.serial}
          request={sftp.switching}
          catalog={catalog}
          sessions={sftp.sessions}
          onConfirm={() => void sftp.open(sftp.switching!.hostId, true)}
          onClose={() => sftp.endSwitch(sftp.switching!.serial)}
          returnFocus={() => firstUsable(picker.current)}
        />
      ) : null}
    </div>
  );
}

const phaseStates = { ready: "connected", connecting: "connecting", failed: "error", closed: "disconnected" } as const;
const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/**
 * The Files header picker (SST-040/11): the current remote target and its state, and every saved server. Choosing one
 * goes through the same `sftp.open` as Servers → Open files; choosing the current one changes nothing.
 */
function ServerPicker({
  ref,
  state,
  session,
  pending,
  failed,
  onOpen,
}: {
  ref: Ref<HTMLButtonElement>;
  state: CatalogState | undefined;
  session: SftpSessionView | undefined;
  pending: boolean;
  failed: boolean;
  onOpen(hostId: string): void;
}) {
  const awaiting = useAwaitingTrust();
  const identities = useMemo(() => new Map((state?.identities ?? []).map((row) => [row.id, row])), [state?.identities]);
  const hosts = state?.hosts ?? [];
  const ready = state?.availability === "ready";
  const status: ConnectionState | undefined = session
    ? session.phase === "connecting" && awaiting(session) ? "awaiting-trust" : phaseStates[session.phase]
    : pending ? "connecting" : failed ? "error" : undefined;
  return (
    <div className="files-picker flex min-w-0 max-w-full items-center gap-2" data-files-picker>
      <Select
        // Only a live session is "current": choosing an ended session's server opens it again, as Open files does.
        value={session?.phase === "ready" || session?.phase === "connecting" ? session.hostId : null}
        disabled={!ready || hosts.length === 0}
        onValueChange={(id: string | null) => {
          if (id) onOpen(id);
        }}
      >
        <SelectTrigger ref={ref} size="sm" aria-label="Server to browse" className="w-60 max-w-full min-w-0">
          <ServerIcon aria-hidden="true" />
          <SelectValue className="min-w-0 truncate">
            {() =>
              session ? (
                <span className="truncate">{session.target?.label ?? "Unknown target"}</span>
              ) : (
                <span className="truncate text-muted-foreground">
                  {!ready ? "Saved servers are unavailable" : hosts.length ? "Choose a server" : "No saved servers"}
                </span>
              )
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent align="end" alignItemWithTrigger={false} className="w-80 max-w-[calc(100vw-2rem)]">
          {hosts.map((host) => {
            // Same rule and reason as Connect: a server opens only with a chosen identity.
            const usable = host.effective.authSelection === "identity";
            const identity = host.effective.identityId ? identities.get(host.effective.identityId) : undefined;
            return (
              <SelectItem key={host.id} value={host.id} label={host.label} disabled={!usable} data-host-id={host.id} className="*:min-w-0! *:shrink!">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{host.label}</span>
                    <EnvironmentBadge environment={host.environment} />
                  </span>
                  <span className="type-caption truncate text-muted-foreground">
                    {usable ? endpointText(host.address, host.effective.port, identity?.username) : "Choose an identity to connect."}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {status ? <ConnectionStatus state={status} announce /> : null}
    </div>
  );
}

/**
 * Switching servers would stop pending transfers or end remote edits on the session it closes: a confirmation-only
 * drawer, Cancel focused (Enter, Esc and × keep everything). Mounted per request (keyed by its serial).
 */
function SwitchConfirm({
  request,
  catalog,
  sessions,
  onConfirm,
  onClose,
  returnFocus,
}: {
  request: SftpSwitch;
  catalog: CatalogState | undefined;
  sessions: readonly SftpSessionView[];
  onConfirm(): void;
  onClose(): void;
  returnFocus(): HTMLElement | true;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);
  const close = useDrawerClose();
  const { discard } = close;
  // A lock (or the session ending) has already stopped what this asks about: close without acting.
  const [epoch] = useState(catalog?.lockEpoch);
  const current = request.from && sessions.find((row) => row.sessionId === request.from!.sessionId);
  const valid =
    (catalog?.lockEpoch ?? epoch) === epoch &&
    (!request.from || current?.phase === "ready" || current?.phase === "connecting");
  useEffect(() => {
    if (!valid && !confirmed.current) discard();
  }, [valid, discard]);
  const from = request.from ? terminalIdentity(request.from) : undefined;
  const to = catalog?.hosts.find((host) => host.id === request.hostId)?.label ?? "the other server";
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      finalFocus={returnFocus}
      data-testid="sftp-switch-dialog"
      title={<span className="min-w-0 break-words">{`Close ${from?.label ?? "the current server"} and open ${to}?`}</span>}
      target={
        from?.endpoint ? (
          <>
            <span className="min-w-0 font-mono text-sm break-all">{from.endpoint}</span>
            <EnvironmentBadge environment={request.from?.target?.environment} />
          </>
        ) : null
      }
      description="Files shows one server at a time. Opening another closes this SFTP session now; nothing stopped here is retried later."
      footer={
        <>
          <Button ref={cancel} variant="outline" onClick={close.request}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!close.open || !valid}
            onClick={() => {
              if (confirmed.current || !valid) return;
              confirmed.current = true;
              onConfirm();
              close.discard();
            }}
          >
            Close and switch
          </Button>
        </>
      }
    >
      <ul className="grid list-disc gap-2 pl-5" aria-label="Work that will stop">
        {request.transfers ? (
          <li>
            {plural(request.transfers, "pending transfer")} will be cancelled. Temporary files are retained at the paths
            shown in Transfers.
          </li>
        ) : null}
        {request.edits ? (
          <li>
            {plural(request.edits, "remote edit")} will be discarded. ssterm will attempt cleanup of private working files;
            your editor may retain its own copies.
          </li>
        ) : null}
        {request.publishing ? <li>A publication already in progress may finish; check the remote file.</li> : null}
      </ul>
    </Drawer>
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
    if (!pending || busy) return;
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
  }, [phase, generation, ended, busy]);
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
