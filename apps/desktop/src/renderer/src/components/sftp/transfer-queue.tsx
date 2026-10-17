import { ArrowDownToLineIcon, ArrowUpFromLineIcon, CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { displayName, sizeText } from "@/lib/file-browser";
import { endpointText } from "@/lib/catalog-filter";
import { transferFinished, transferPercent, transferProblems } from "@/lib/transfer-display";
import type { TransferController } from "@/hooks/use-transfers";

const states = { queued: "Queued", running: "Transferring", cancelling: "Cancelling", completed: "Completed", cancelled: "Cancelled", failed: "Failed" };

export function TransferQueue({ transfers }: { transfers: TransferController }) {
  const { jobs, pending } = transfers;
  const finished = jobs.some(transferFinished);
  const active = jobs.filter((job) => !transferFinished(job)).length;
  const completed = jobs.filter((job) => job.state === "completed").length;
  const failed = jobs.filter((job) => job.state === "failed").length;
  const cancelled = jobs.filter((job) => job.state === "cancelled").length;
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
        Existing files are never overwritten. Cancelled or failed transfers can leave an incomplete file at the destination.
      </p>
      <p role="status" className="sr-only">{active} active transfers, {completed} completed, {failed} failed, {cancelled} cancelled.</p>
      {transfers.failure ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Transfer action could not complete</AlertTitle>
          <AlertDescription>{transfers.failure}</AlertDescription>
        </Alert>
      ) : null}
      <div className="transfer-list" tabIndex={0} role="region" aria-label="Transfer jobs">
        {jobs.length === 0 ? <p className="transfer-empty type-caption text-muted-foreground">Select files, then choose Upload or Download.</p> : null}
        {jobs.map((job) => {
          const done = transferFinished(job);
          const percent = transferPercent(job);
          const Icon = job.state === "completed" ? CircleCheckIcon : job.state === "failed" ? TriangleAlertIcon : job.state === "cancelled" ? CircleXIcon : job.direction === "upload" ? ArrowUpFromLineIcon : ArrowDownToLineIcon;
          return (
            <article key={job.id} className="transfer-job" data-testid="transfer-job" data-job-id={job.id} data-state={job.state} data-source-path={job.sourcePath} data-destination-path={job.destinationPath} data-partial={job.partial || undefined}>
              <div className="transfer-job-heading">
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="type-label">{job.direction === "upload" ? "Upload" : "Download"}</span>
                <span className="min-w-0 truncate type-label"><bdi>{displayName(job.target?.label ?? "Unknown target").text}</bdi></span>
                {job.target?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
                <Badge variant={job.state === "failed" ? "destructive" : "secondary"}>{states[job.state]}</Badge>
                {job.partial ? <Badge variant="outline">Incomplete file retained</Badge> : null}
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  aria-disabled={done || job.state === "cancelling" || pending.has(job.id)}
                  aria-label={`Cancel ${job.direction} ${displayName(job.sourcePath).text}`}
                  onClick={() => { if (!done && job.state !== "cancelling" && !pending.has(job.id)) void transfers.cancel(job.id); }}
                >Cancel</Button>
              </div>
              {job.target ? <p className="type-caption text-muted-foreground"><bdi>{displayName(endpointText(job.target.endpointHost, job.target.endpointPort, job.target.username ?? undefined)).text}</bdi></p> : null}
              <dl className="transfer-paths type-caption">
                <dt>From {job.direction === "upload" ? "This Mac" : "server"}</dt><dd><bdi>{displayName(job.sourcePath).text}</bdi></dd>
                <dt>To {job.direction === "upload" ? "server" : "This Mac"}</dt><dd><bdi>{displayName(job.destinationPath).text}</bdi></dd>
              </dl>
              <p className="type-caption tabular-nums" data-testid="transfer-bytes">
                {sizeText(job.bytes)} written{job.total === null ? " · total unknown" : ` of ${sizeText(job.total)}`}{percent === null ? "" : ` · ${percent}%`}
              </p>
              <Progress value={percent} aria-label={`${job.direction === "upload" ? "Upload" : "Download"} progress for ${displayName(job.sourcePath).text}`} />
              {job.error ? <p className="transfer-error type-caption">{transferProblems[job.error]}</p> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
