import { useRef, useState } from "react";
import { Drawer, firstUsable, useDrawerClose } from "@/components/drawer";
import { PageHeader } from "@/components/page-header";
import {
  CircleAlertIcon, CircleDotIcon, CopyIcon, DownloadIcon, FileClockIcon, HistoryIcon, Trash2Icon, TriangleAlertIcon,
} from "lucide-react";
import {
  SHELL_INTEGRATION, SHELL_MATRIX, type DeleteRecordingTarget, type ExportRecordingTarget, type Owner, type RecordingSummary,
  type SupportedShell,
} from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useRecordings } from "@/hooks/use-recordings";
import { copyText } from "@/lib/clipboard";

const bytes = (value: number) =>
  value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const exportText: Record<string, string> = {
  cancelled: "",
  "not-found": "That recording no longer exists.",
  "key-unavailable": "The recording could not be decrypted: secure storage is unavailable.",
  corrupt: "The recording failed its integrity check and was not exported.",
  failed: "The export could not be written.",
  aborted: "The export stopped because ssterm locked. Nothing was left behind.",
};
type Confirm = { key: number; target: DeleteRecordingTarget; title: string; description: string };

/**
 * SST-034 Recordings: session logs (with Export… and Delete each), command history export/delete, Delete all, and
 * the copyable shell-integration snippets. Exports are plaintext and leave ssterm's control.
 */
export function RecordingsPage({ owner, onOpenSettings }: { owner: Owner; onOpenSettings(): void }) {
  const { state, unavailable, remove, exportRecording } = useRecordings(owner);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string }>();
  const [busy, setBusy] = useState<string>();
  const [confirm, setConfirmState] = useState<Confirm>();
  // Each delete opens a fresh drawer instance (keyed), so a closing one is never reused.
  const serial = useRef(0);
  const setConfirm = (next: Omit<Confirm, "key">) => setConfirmState({ ...next, key: ++serial.current });
  const [shell, setShell] = useState<SupportedShell>("bash");
  const heading = useRef<HTMLHeadingElement>(null);
  async function save(target: ExportRecordingTarget, key: string) {
    setBusy(key);
    setNotice(undefined);
    const result = await exportRecording(target);
    setBusy(undefined);
    if (!result.ok) return setNotice({ tone: "error", text: "The export is unavailable right now." });
    const outcome = result.value;
    if (outcome.status === "saved") {
      const extra = [outcome.gaps ? `${outcome.gaps} ${outcome.gaps === 1 ? "gap" : "gaps"} marked` : "", outcome.incomplete ? "the recording was incomplete" : ""].filter(Boolean).join("; ");
      setNotice({ tone: "info", text: `Exported as plaintext${extra ? ` (${extra})` : ""}. Delete in ssterm does not remove that file.` });
    } else if (outcome.status !== "cancelled") setNotice({ tone: "error", text: exportText[outcome.status] ?? "The export failed." });
  }
  const logs = state?.logs ?? [];
  const history = state ? state.historyFiles > 0 : false;
  return (
    <div className="catalog-page" data-testid="recordings-page">
      <PageHeader
        title="Recordings"
        headingRef={heading}
        subtitle={state ? `Encrypted session logs and command history · ${state.logCount} ${state.logCount === 1 ? "log" : "logs"} · ${bytes(state.logBytes + state.historyBytes)}` : "Encrypted session logs and command history"}
        actions={
          <>
          <Button size="sm" variant="outline" disabled={!history || !!busy} onClick={() => void save({ kind: "history" }, "history")}>
            {busy === "history" ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}Export history…
          </Button>
          <Button size="sm" variant="outline" disabled={!history} onClick={() => setConfirm({ target: { kind: "history" }, title: "Delete command history?",
            description: "Every saved command line is deleted from this Mac, including history being recorded now. ⌘; offers nothing until new commands are saved." })}>
            <Trash2Icon data-icon="inline-start" />Delete history
          </Button>
          <Button size="sm" variant="destructive" disabled={!state || (!state.logCount && !history)} onClick={() => setConfirm({ target: { kind: "all" },
            title: "Delete all recordings?", description: "Every session log and all command history are deleted from this Mac, including recordings in progress." })}>
            <Trash2Icon data-icon="inline-start" />Delete all
          </Button>
          </>
        }
      />
      <p className="type-caption text-muted-foreground">
        Session logs hold what each terminal displayed; command history holds the command lines a shell reported. Both are
        encrypted on this Mac, kept within the limits in{" "}
        <button type="button" className="rounded-sm text-primary underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpenSettings}>Settings › Recording</button>, and never
        sent anywhere. Exports are plaintext files outside ssterm's control.
      </p>
      {unavailable ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Recordings could not be read</AlertTitle>
          <AlertDescription>The recordings list is unavailable right now. Open this page again to retry.</AlertDescription>
        </Alert>
      ) : state?.problem ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>New sessions are not being recorded</AlertTitle>
          <AlertDescription>
            {state.problem === "key-unavailable" ? "The encryption key could not be read from the Keychain." : "Secure storage or the recordings folder is unavailable."}
          </AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant={notice.tone === "error" ? "destructive" : "default"} role="status"><AlertDescription>{notice.text}</AlertDescription></Alert>
      ) : null}
      {!state && !unavailable ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Spinner aria-hidden="true" /></EmptyMedia>
            <EmptyTitle role="status">Loading recordings…</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : !state ? null : logs.length === 0 ? (
        <Empty className="flex-none">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileClockIcon /></EmptyMedia>
            <EmptyTitle>No session logs</EmptyTitle>
            <EmptyDescription>
              {state.policy.logs ? "New terminals are recorded; their logs appear here when they start." : "Session output is not recorded. Turn it on in Settings › Recording."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="data-frame">
          <table className="data-table" aria-label="Session logs">
            <thead>
              <tr>
                <th scope="col" title="Session">Session</th>
                <th scope="col" className="w-[22%]" title="Started">Started</th>
                <th scope="col" className="w-24" title="Size">Size</th>
                <th scope="col" className="w-32" title="State">State</th>
                <th scope="col" className="w-40 data-actions-col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => <LogRow key={log.id} log={log} busy={busy === log.id} onExport={() => void save({ kind: "log", id: log.id }, log.id)}
                onDelete={() => setConfirm({ target: { kind: "log", id: log.id }, title: `Delete the log of ${log.label}?`,
                  description: log.state === "recording" ? "Recording stops now and the log is deleted from this Mac." : "The log is deleted from this Mac." })} />)}
            </tbody>
          </table>
          {state.logCount > logs.length ? (
            <p className="type-caption border-t px-3 py-2 text-muted-foreground">Showing the newest {logs.length} of {state.logCount} logs.</p>
          ) : null}
        </div>
      )}
      <section className="recording-integration shrink-0" aria-labelledby="shell-integration-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="shell-integration-heading" className="type-label flex items-center gap-2">
            <HistoryIcon className="size-4" aria-hidden="true" />Shell integration for command history
          </h3>
          <ToggleGroup aria-label="Shell" variant="outline" spacing={0} value={[shell]}
            onValueChange={(value) => { const next = value[0] as SupportedShell | undefined; if (next) setShell(next); }}>
            <ToggleGroupItem value="bash">bash</ToggleGroupItem>
            <ToggleGroupItem value="zsh">zsh</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <p className="type-caption text-muted-foreground">
          Command history and ⌘; suggestions need this snippet at the end of {shell === "bash" ? "~/.bashrc" : "~/.zshrc"} on each
          host (and on this Mac for local terminals). ssterm never installs it. It only prints markers to the terminal.
        </p>
        <pre className="recording-snippet" tabIndex={0} aria-label={`${shell} integration snippet`}>{SHELL_INTEGRATION[shell]}</pre>
        <div>
          <Button size="sm" variant="outline" onClick={() => setNotice(copyText(SHELL_INTEGRATION[shell])
            ? { tone: "info", text: `Copied the ${shell} snippet.` } : { tone: "error", text: "The snippet could not be copied." })}>
            <CopyIcon data-icon="inline-start" />Copy {shell} snippet
          </Button>
        </div>
        <table className="recording-matrix">
          <caption className="sr-only">Supported shells</caption>
          <thead><tr><th scope="col" title="Shell">Shell</th><th scope="col" title="Where">Where</th><th scope="col" title="Status">Status</th></tr></thead>
          <tbody>
            {SHELL_MATRIX.map((row) => <tr key={`${row.shell}-${row.where}`}><td>{row.shell}</td><td>{row.where}</td><td>{row.status}</td></tr>)}
          </tbody>
        </table>
      </section>
      {confirm ? (
        <DeleteDrawer key={confirm.key} confirm={confirm} onClose={() => setConfirmState(undefined)} onDelete={async () => {
          const deleted = await remove(confirm.target);
          if (!deleted) return false;
          setNotice({ tone: "info", text: "Deleted from this Mac. Plaintext exports and OS backups are not affected." });
          return true;
        }} heading={() => heading.current} />
      ) : null}
    </div>
  );
}

function LogRow({ log, busy, onExport, onDelete }: { log: RecordingSummary; busy: boolean; onExport(): void; onDelete(): void }) {
  return (
    <tr data-recording-id={log.id} data-state={log.state}>
      <td>
        <span className="data-cell">
          <span className="min-w-0 max-w-full truncate font-medium" title={log.label}>{log.label}</span>
          {log.local ? <Badge variant="secondary">LOCAL</Badge> : null}
          {log.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
        </span>
        {log.endpoint ? <span className="host-target block truncate text-muted-foreground" title={log.endpoint}>{log.endpoint}</span> : null}
      </td>
      <td className="type-caption text-muted-foreground">{when(log.startedAt)}</td>
      <td className="type-caption text-muted-foreground">{bytes(log.bytes)}</td>
      <td>
        {log.state === "recording" ? (
          <Badge variant="recording"><CircleDotIcon data-icon="inline-start" />Recording</Badge>
        ) : log.state === "incomplete" ? (
          <Badge variant="warning"><TriangleAlertIcon data-icon="inline-start" />Incomplete</Badge>
        ) : (
          <span className="type-caption">Complete</span>
        )}
      </td>
      <td>
        <span className="data-actions">
          <Button size="sm" variant="outline" disabled={busy} aria-label={`Export the log of ${log.label}`} title="Export…" onClick={onExport}>
            {busy ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}<span className="data-action-text">Export…</span>
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Delete the log of ${log.label}`} title="Delete" onClick={onDelete}>
            <Trash2Icon aria-hidden="true" />
          </Button>
        </span>
      </td>
    </tr>
  );
}

/** Delete confirmation as an alert drawer; focus returns to the opener when it is still there, else the heading. */
function DeleteDrawer({ confirm, onClose, onDelete, heading }: { confirm: Confirm; onClose(): void; onDelete(): Promise<boolean>; heading(): HTMLElement | null }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const close = useDrawerClose({ busy });
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      finalFocus={() => firstUsable(opener, heading())}
      data-testid="delete-recordings-dialog"
      title={<span className="break-words">{confirm.title}</span>}
      description={`${confirm.description} Copies outside ssterm (plaintext exports, Time Machine backups) are not affected.`}
      footer={
        <>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={async () => {
            setBusy(true);
            setFailed(false);
            const deleted = await onDelete();
            setBusy(false);
            if (deleted) close.discard(); else setFailed(true);
          }}>
            {busy ? <Spinner data-icon="inline-start" /> : null}Delete
          </Button>
        </>
      }
    >
      {failed ? <Alert variant="destructive"><CircleAlertIcon /><AlertDescription>Nothing could be deleted right now.</AlertDescription></Alert> : null}
    </Drawer>
  );
}
