import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import type { TransferJob } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Drawer, firstUsable, useDrawerClose } from "@/components/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { displayName, sizeText } from "@/lib/file-browser";
import { endpointText } from "@/lib/catalog-filter";
import { transferCanCancel, transferCanRetry, transferFinished, transferPercent, transferProblems, transferRenameProblem } from "@/lib/transfer-display";
import type { TransferController } from "@/hooks/use-transfers";
import { cn } from "@/lib/utils";

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
  const cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const serial = useRef(0);
  // Each open is a fresh drawer instance (keyed), so a choice or confirmation never carries over to another conflict.
  const [resolving, setResolving] = useState<number | null>(null);
  const busy = transfers.pending.has(job.id);
  const conflict = job.state === "conflict" && job.conflictId !== null;
  const canCancel = transferCanCancel(job) && !busy;
  const canRetry = transferCanRetry(job) && !busy;
  const percent = transferPercent(job);
  const Icon = job.state === "completed" ? CircleCheckIcon : job.state === "failed" ? TriangleAlertIcon : job.state === "cancelled" || job.state === "skipped" ? CircleXIcon : job.direction === "upload" ? ArrowUpFromLineIcon : ArrowDownToLineIcon;
  return (
    <article className="transfer-job" data-testid="transfer-job" data-job-id={job.id} data-state={job.state} data-source-path={job.sourcePath} data-destination-path={job.destinationPath} data-partial={job.partial || undefined} data-partial-path={job.partialPath ?? undefined}>
      <div className="transfer-job-heading">
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        <span className="type-label">{job.direction === "upload" ? "Upload" : "Download"}</span>
        <TransferTarget target={job.target} />
        <Badge variant={job.state === "failed" ? "destructive" : "secondary"}>{states[job.state]}</Badge>
        {job.partial ? <Badge variant="outline">{job.error === "publication-unknown" ? "Publication uncertain" : "Temporary file retained"}</Badge> : null}
        <Button ref={cancel} size="sm" variant="outline" className="ml-auto" aria-disabled={!canCancel}
          aria-label={`Cancel ${job.direction} ${displayName(job.sourcePath).text}`}
          onClick={() => { if (canCancel) void transfers.cancel(job.id); }}>Cancel</Button>
        {job.state === "failed" || job.state === "cancelled" ? (
          <Button size="sm" variant="outline" aria-disabled={!canRetry} onClick={() => { if (canRetry) void transfers.retry(job.id); }}>Retry</Button>
        ) : null}
      </div>
      <TransferEndpoint target={job.target} />
      <TransferPaths job={job} />
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
          <p className="type-caption">The captured destination already exists. Choose Overwrite, Skip or Rename for this file.</p>
          <Button ref={opener} size="sm" variant="outline" className="self-start" disabled={busy}
            aria-label={`Resolve conflict for ${displayName(job.destinationPath).text}`}
            onClick={() => setResolving(++serial.current)}>Resolve conflict</Button>
        </div>
      ) : null}
      {resolving !== null ? (
        <ConflictDrawer key={resolving} job={job} transfers={transfers}
          returnFocus={() => firstUsable(opener.current, cancel.current)} onClose={() => setResolving(null)} />
      ) : null}
    </article>
  );
}

function TransferTarget({ target }: { target: TransferJob["target"] }) {
  return (
    <>
      <span className="min-w-0 truncate type-label"><bdi>{displayName(target?.label ?? "Unknown target").text}</bdi></span>
      {target?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
    </>
  );
}

function TransferEndpoint({ target }: { target: TransferJob["target"] }) {
  return target ? <p className="type-caption text-muted-foreground"><bdi>{displayName(endpointText(target.endpointHost, target.endpointPort, target.username ?? undefined)).text}</bdi></p> : null;
}

function TransferPaths({ job }: { job: TransferJob }) {
  return (
    <dl className="transfer-paths type-caption">
      <dt>From {job.direction === "upload" ? "This Mac" : "server"}</dt><dd><bdi>{displayName(job.sourcePath).text}</bdi></dd>
      <dt>To {job.direction === "upload" ? "server" : "This Mac"}</dt><dd><bdi>{displayName(job.destinationPath).text}</bdi></dd>
      {job.partialPath ? <><dt>{job.error === "publication-unknown" ? "Temporary file (may have moved)" : "Retained temporary file"}</dt><dd><bdi>{displayName(job.partialPath).text}</bdi></dd></> : null}
    </dl>
  );
}

type Decision = "skip" | "rename" | "overwrite";

/**
 * The conflict decision as a drawer: an explicit choice (nothing preselected), Rename's filename, and Overwrite's
 * confirmation as a step in the same drawer. It answers only the conflict nonce captured when it opened; when the
 * job leaves that conflict (decided, cancelled, retried as a new job, locked) the drawer closes and nothing is sent.
 */
function ConflictDrawer({ job, transfers, returnFocus, onClose }: {
  job: TransferJob;
  transfers: TransferController;
  returnFocus(): HTMLElement | true;
  onClose(): void;
}) {
  const id = useId();
  const [captured] = useState(() => ({ conflictId: job.conflictId, path: job.destinationPath }));
  const [choice, setChoice] = useState<Decision | null>(null);
  const [name, setName] = useState(() => captured.path.slice(captured.path.lastIndexOf("/") + 1));
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The queue's failure is shared: show it here only once this drawer has acted, never a stale one from before.
  const [acted, setActed] = useState(false);
  const stepCancel = useRef<HTMLButtonElement>(null);
  // Where focus returns when the confirmation step ends.
  const resume = useRef<HTMLElement | null>(null);
  const busy = transfers.pending.has(job.id);
  const valid = job.state === "conflict" && job.conflictId === captured.conflictId && job.destinationPath === captured.path;
  const close = useDrawerClose({ busy });
  const { discard } = close;
  useEffect(() => { if (!valid) discard(); }, [valid]);
  useEffect(() => {
    if (confirming) return void stepCancel.current?.focus();
    const back = firstUsable(resume.current);
    resume.current = null;
    if (back !== true) back.focus();
  }, [confirming]);
  const decide = async (decision: Decision) => {
    if (!valid || busy || !captured.conflictId) return;
    if (decision === "rename") {
      const problem = transferRenameProblem(name);
      setRenameError(problem);
      if (problem) return;
    }
    if (decision === "overwrite" && !job.atomicReplace) return;
    setActed(true);
    if (await transfers.resolve(job.id, captured.conflictId, decision, decision === "rename" ? name : null)) discard();
  };
  const back = () => { if (!busy) setConfirming(false); };
  return (
    <Drawer
      close={{ ...close, request: () => (confirming ? back() : close.request()) }}
      onClose={onClose}
      finalFocus={returnFocus}
      data-testid="transfer-conflict-drawer"
      title="Destination already exists"
      target={<><TransferTarget target={job.target} /><TransferEndpoint target={job.target} /></>}
      description="Choose what happens to this file. The existing destination is not changed until you decide."
      footer={confirming ? (
        <>
          <Button ref={stepCancel} variant="outline" disabled={busy} onClick={back}>Cancel</Button>
          {/* A double click on Continue must not land on this replacement button. */}
          <Button variant="destructive" disabled={busy || !valid || !job.atomicReplace} onClick={(event) => { if (event.detail <= 1) void decide("overwrite"); }}>Replace file</Button>
        </>
      ) : (
        <>
          <Button variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button type="submit" form={`${id}-form`} disabled={busy || !valid || !choice}>Continue</Button>
        </>
      )}
    >
      <TransferPaths job={job} />
      {acted && transfers.failure ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Transfer action could not complete</AlertTitle>
          <AlertDescription>{transfers.failure}</AlertDescription>
        </Alert>
      ) : null}
      {confirming ? (
        <section role="alert" aria-labelledby={`${id}-confirm`} className="grid gap-2" data-testid="transfer-overwrite-confirm">
          <h3 id={`${id}-confirm`} className="font-medium text-foreground">Replace this destination file?</h3>
          <p className="text-muted-foreground" data-testid="transfer-overwrite-description">Only the captured destination on {job.direction === "upload" ? "the server" : "This Mac"} will be replaced, after the new file has been copied in full. The original stays untouched until publishing.</p>
        </section>
      ) : null}
      {/* Hidden, not unmounted, during the confirmation step: the choice stays. */}
      <form id={`${id}-form`} className={cn("grid min-w-0 gap-4", confirming && "hidden")} onSubmit={(event) => {
        event.preventDefault();
        if (choice === "overwrite") {
          if (!valid || busy || !job.atomicReplace) return;
          resume.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setConfirming(true);
        } else if (choice) void decide(choice);
      }}>
        <RadioGroup aria-label="Action for this file" value={choice} disabled={busy}
          onValueChange={(value) => { if (value === "skip" || value === "rename" || value === "overwrite") setChoice(value); }}>
          {([
            ["skip", "Skip", "Keep the existing destination. Nothing is copied."],
            ["rename", "Rename", "Copy to a new filename in the same captured folder."],
            ["overwrite", "Overwrite", "Replace the existing destination once the new file is copied in full. Asks for confirmation."],
          ] as const).map(([value, label, help]) => (
            <Field key={value} orientation="horizontal" data-disabled={value === "overwrite" && !job.atomicReplace ? true : undefined}>
              <RadioGroupItem value={value} id={`${id}-${value}`} disabled={value === "overwrite" && !job.atomicReplace} aria-describedby={`${id}-${value}-help`} />
              <FieldContent>
                <FieldLabel htmlFor={`${id}-${value}`}>{label}</FieldLabel>
                <FieldDescription id={`${id}-${value}-help`}>{help}</FieldDescription>
              </FieldContent>
            </Field>
          ))}
        </RadioGroup>
        {!job.atomicReplace ? <p className="type-caption text-muted-foreground">Atomic replacement is unavailable for this destination. Choose Skip or Rename.</p> : null}
        {choice === "rename" ? (
          <Field data-invalid={!!renameError}>
            <FieldLabel htmlFor={`${id}-name`}>New filename</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(event) => { setName(event.target.value); setRenameError(null); }} disabled={busy} autoComplete="off" spellCheck={false}
              aria-invalid={!!renameError} aria-describedby={`${id}-name-help${renameError ? ` ${id}-name-error` : ""}`} />
            <FieldDescription id={`${id}-name-help`}>Only the filename changes. Spaces and Unicode are kept exactly as entered.</FieldDescription>
            {renameError ? <FieldError id={`${id}-name-error`}>{renameError}</FieldError> : null}
          </Field>
        ) : null}
      </form>
    </Drawer>
  );
}
