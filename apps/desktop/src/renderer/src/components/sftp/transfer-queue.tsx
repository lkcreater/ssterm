import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import type { TransferJob } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { displayName, sizeText } from "@/lib/file-browser";
import { endpointText } from "@/lib/catalog-filter";
import { transferCanCancel, transferCanRetry, transferFinished, transferPercent, transferProblems, transferRenameProblem } from "@/lib/transfer-display";
import type { TransferController } from "@/hooks/use-transfers";

const states = { queued: "Queued", running: "Transferring", conflict: "Destination exists", publishing: "Finalizing", cancelling: "Cancelling", completed: "Completed", cancelled: "Cancelled", failed: "Failed", skipped: "Skipped" };

export function TransferQueue({ transfers }: { transfers: TransferController }) {
  const { jobs, pending } = transfers;
  const finished = jobs.some(transferFinished);
  const active = jobs.filter((job) => !transferFinished(job)).length;
  const completed = jobs.filter((job) => job.state === "completed").length;
  const failed = jobs.filter((job) => job.state === "failed").length;
  const cancelled = jobs.filter((job) => job.state === "cancelled").length;
  const skipped = jobs.filter((job) => job.state === "skipped").length;
  return (
    <section className="transfer-queue" aria-label="Transfers" data-testid="transfer-panel">
      <div className="transfer-queue-header">
        <h2 className="type-label">Transfers{jobs.length ? ` (${jobs.length})` : ""}</h2>
        <span className="type-caption text-muted-foreground">Regular files only · 2 at a time</span>
        <Button size="sm" variant="ghost" disabled={!finished || pending.has("clear")} onClick={() => void transfers.clear()}>
          Clear finished
        </Button>
      </div>
      <p className="transfer-warning type-caption text-muted-foreground">
        Files copy to temporary files first. Existing destinations stay untouched until publishing; replacement requires confirmation. Failed or cancelled temporary files are retained. Clear finished only clears this list, never files.
      </p>
      <p role="status" className="sr-only">{active} active transfers, {completed} completed, {failed} failed, {cancelled} cancelled, {skipped} skipped.</p>
      {transfers.failure ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Transfer action could not complete</AlertTitle>
          <AlertDescription>{transfers.failure}</AlertDescription>
        </Alert>
      ) : null}
      <div className="transfer-list" tabIndex={0} role="region" aria-label="Transfer jobs">
        {jobs.length === 0 ? <p className="transfer-empty type-caption text-muted-foreground">Select files, then choose Upload or Download.</p> : null}
        {jobs.map((job) => <TransferRow key={job.id} job={job} transfers={transfers} />)}
      </div>
    </section>
  );
}

function TransferRow({ job, transfers }: { job: TransferJob; transfers: TransferController }) {
  const id = useId();
  const row = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const rejectOverwrite = useRef<HTMLButtonElement>(null);
  const [rename, setRename] = useState(false);
  const [name, setName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState<{ conflictId: string; path: string; target: TransferJob["target"] } | null>(null);
  const busy = transfers.pending.has(job.id);
  const conflict = job.state === "conflict" && job.conflictId !== null;
  const canCancel = transferCanCancel(job) && !busy;
  const canRetry = transferCanRetry(job) && !busy;
  const percent = transferPercent(job);
  useEffect(() => {
    setRename(false);
    setRenameError(null);
    setOverwrite(null);
  }, [job.conflictId]);
  const focusCancel = () => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || row.current?.contains(focused)) cancel.current?.focus();
  };
  const resolve = async (decision: "skip" | "rename") => {
    if (!conflict || busy || !job.conflictId) return;
    if (decision === "rename") {
      const problem = transferRenameProblem(name);
      setRenameError(problem);
      if (problem) return;
    }
    if (await transfers.resolve(job.id, job.conflictId, decision, decision === "rename" ? name : null)) {
      setRename(false);
      focusCancel();
    }
  };
  const Icon = job.state === "completed" ? CircleCheckIcon : job.state === "failed" ? TriangleAlertIcon : job.state === "cancelled" || job.state === "skipped" ? CircleXIcon : job.direction === "upload" ? ArrowUpFromLineIcon : ArrowDownToLineIcon;
  return (
    <article ref={row} className="transfer-job" data-testid="transfer-job" data-job-id={job.id} data-state={job.state} data-source-path={job.sourcePath} data-destination-path={job.destinationPath} data-partial={job.partial || undefined} data-partial-path={job.partialPath ?? undefined}>
      <div className="transfer-job-heading">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="type-label">{job.direction === "upload" ? "Upload" : "Download"}</span>
        <span className="min-w-0 truncate type-label"><bdi>{displayName(job.target?.label ?? "Unknown target").text}</bdi></span>
        {job.target?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
        <Badge variant={job.state === "failed" ? "destructive" : "secondary"}>{states[job.state]}</Badge>
        {job.partial ? <Badge variant="outline">{job.error === "publication-unknown" ? "Publication uncertain" : "Temporary file retained"}</Badge> : null}
        <Button ref={cancel} size="sm" variant="outline" className="ml-auto" aria-disabled={!canCancel}
          aria-label={`Cancel ${job.direction} ${displayName(job.sourcePath).text}`}
          onClick={() => { if (canCancel) void transfers.cancel(job.id); }}>Cancel</Button>
        {job.state === "failed" || job.state === "cancelled" ? (
          <Button size="sm" variant="outline" aria-disabled={!canRetry} onClick={() => { if (canRetry) void transfers.retry(job.id); }}>Retry</Button>
        ) : null}
      </div>
      {job.target ? <p className="type-caption text-muted-foreground"><bdi>{displayName(endpointText(job.target.endpointHost, job.target.endpointPort, job.target.username ?? undefined)).text}</bdi></p> : null}
      <dl className="transfer-paths type-caption">
        <dt>From {job.direction === "upload" ? "This Mac" : "server"}</dt><dd><bdi>{displayName(job.sourcePath).text}</bdi></dd>
        <dt>To {job.direction === "upload" ? "server" : "This Mac"}</dt><dd><bdi>{displayName(job.destinationPath).text}</bdi></dd>
        {job.partialPath ? <><dt>{job.error === "publication-unknown" ? "Temporary file (may have moved)" : "Retained temporary file"}</dt><dd><bdi>{displayName(job.partialPath).text}</bdi></dd></> : null}
      </dl>
      {job.partial && job.state === "completed" ? <p className="type-caption text-muted-foreground">The full file was published. A temporary copy is also retained at the path above.</p> : null}
      <p className="type-caption tabular-nums" data-testid="transfer-bytes">
        {sizeText(job.bytes)} written{job.total === null ? " · total unknown" : ` of ${sizeText(job.total)}`}{percent === null ? "" : ` · ${percent}%`}
      </p>
      <Progress value={percent} aria-label={`${job.direction === "upload" ? "Upload" : "Download"} progress for ${displayName(job.sourcePath).text}`} />
      {job.state === "publishing" ? <p className="type-caption text-muted-foreground">Finalizing the captured destination. Cancellation is unavailable during publishing.</p> : null}
      {job.error ? <p className="transfer-error type-caption">{transferProblems[job.error]}</p> : null}
      {job.state === "failed" || job.state === "cancelled" ? <p className="type-caption text-muted-foreground">Retry starts a new copy from the beginning using the captured paths and original session. Retained temporary files remain on disk.</p> : null}
      {conflict ? (
        <div className="transfer-conflict" data-testid="transfer-conflict">
          <p className="type-caption">The captured destination already exists. Choose an action for this file.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy || !job.atomicReplace}
              onClick={() => { if (job.conflictId) setOverwrite({ conflictId: job.conflictId, path: job.destinationPath, target: job.target }); }}>Overwrite</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void resolve("skip")}>Skip</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => { setName(job.destinationPath.slice(job.destinationPath.lastIndexOf("/") + 1)); setRenameError(null); setRename(true); }}>Rename</Button>
          </div>
          {!job.atomicReplace ? <p className="type-caption text-muted-foreground">Atomic replacement is unavailable for this destination. Choose Skip or Rename.</p> : null}
          {rename ? (
            <form onSubmit={(event) => { event.preventDefault(); void resolve("rename"); }}>
              <FieldGroup>
                <Field data-invalid={!!renameError}>
                  <FieldLabel htmlFor={`${id}-name`}>New filename</FieldLabel>
                  <Input id={`${id}-name`} value={name} onChange={(event) => { setName(event.target.value); setRenameError(null); }} autoFocus disabled={busy} aria-invalid={!!renameError} aria-describedby={`${id}-name-help${renameError ? ` ${id}-name-error` : ""}`} />
                  <FieldDescription id={`${id}-name-help`}>Only the filename changes. Spaces and Unicode are kept exactly as entered.</FieldDescription>
                  {renameError ? <FieldError id={`${id}-name-error`}>{renameError}</FieldError> : null}
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={busy}>Use new name</Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setRename(false); focusCancel(); }}>Cancel rename</Button>
                </div>
              </FieldGroup>
            </form>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={!!overwrite && conflict && overwrite.conflictId === job.conflictId && overwrite.path === job.destinationPath} onOpenChange={(open) => { if (!open && !busy) setOverwrite(null); }}>
        <AlertDialogContent initialFocus={rejectOverwrite} finalFocus={() => cancel.current ?? true} className="transfer-overwrite-dialog" data-testid="transfer-overwrite-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace this destination file?</AlertDialogTitle>
            <AlertDialogDescription>Only the captured destination below will be replaced, after the new file has been copied in full. The original stays untouched until publishing.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="transfer-overwrite-details">
            <p className="flex flex-wrap items-center gap-2"><bdi>{displayName(overwrite?.target?.label ?? "Unknown target").text}</bdi>{overwrite?.target?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}</p>
            {overwrite?.target ? <p className="type-caption text-muted-foreground"><bdi>{displayName(endpointText(overwrite.target.endpointHost, overwrite.target.endpointPort, overwrite.target.username ?? undefined)).text}</bdi></p> : null}
            <p className="type-caption">Destination on {job.direction === "upload" ? "server" : "This Mac"}</p>
            <p className="type-caption"><bdi>{displayName(overwrite?.path ?? "").text}</bdi></p>
          </div>
          <AlertDialogFooter>
            <Button ref={rejectOverwrite} variant="outline" disabled={busy} onClick={() => setOverwrite(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy || !job.atomicReplace} onClick={async () => {
              if (!overwrite || busy || !job.atomicReplace || overwrite.conflictId !== job.conflictId) return;
              if (await transfers.resolve(job.id, overwrite.conflictId, "overwrite", null)) setOverwrite(null);
            }}>Replace file</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
