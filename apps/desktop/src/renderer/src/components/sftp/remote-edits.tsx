import { useEffect, useRef, useState, type RefObject } from "react";
import { FilePenLineIcon, TriangleAlertIcon } from "lucide-react";
import type { RemoteEditFailure, RemoteEditStatus, RemoteEditView } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Drawer, firstUsable, useDrawerClose } from "@/components/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RemoteEditController } from "@/hooks/use-remote-edit";
import { endpointText } from "@/lib/catalog-filter";
import { displayName, sizeText } from "@/lib/file-browser";

const states: Record<RemoteEditStatus, string> = {
  queued: "Queued", downloading: "Downloading", ready: "Ready to edit", opening: "Opening TextEdit",
  editing: "Editing", checking: "Checking changes", changed: "Changes ready", conflict: "Remote changed",
  uploading: "Uploading", publishing: "Publishing", uploaded: "Uploaded", cancelling: "Cleaning up",
  failed: "Failed", "cleanup-failed": "Cleanup failed",
};
const problems: Record<RemoteEditFailure, string> = {
  "not-found": "The remote file no longer exists.",
  "not-file": "Only regular files can be edited. Folders and symbolic links are unsupported.",
  "permission-denied": "Permission was denied. Check access to the remote file and folder.",
  "no-space": "There is not enough free space for this edit.",
  "quota-exceeded": "The destination quota was exceeded.",
  failure: "The remote edit action could not complete.",
  "invalid-path": "The captured remote path is invalid.",
  unsupported: "The server does not support this action. Upload requires atomic replacement.",
  "connection-lost": "The SFTP connection was lost.",
  "resource-limit": "The remote edit reached a resource limit.",
  cancelled: "The edit was cancelled.",
  closed: "The SFTP session closed.",
  "invalid-request": "The remote edit request could not be accepted.",
  "too-large": "The file exceeds the 8 MiB remote editing limit.",
  "invalid-text": "The file must be valid UTF-8 text without NUL bytes.",
  "local-changed": "The working copy changed while it was checked. Save the file and check for changes again.",
  "remote-changed": "The remote file changed. Upload is blocked. Preserve your work in the editor, then discard this edit and reopen the remote file.",
  "editor-unavailable": "TextEdit could not be opened. The working copy remains available until you discard it.",
  "cleanup-failed": "The local working copy could not be removed. Retry cleanup after its files close.",
  timeout: "The remote edit stopped responding.",
  "publication-unknown": "The destination may already have changed. Check the destination before opening another edit. This upload will not be retried automatically.",
};
const editable = new Set<RemoteEditStatus>(["ready", "editing", "changed", "uploaded"]);

type Kind = "open" | "upload" | "discard";
type Consent = { serial: number; kind: Kind; edit: RemoteEditView; opener: HTMLElement | null };

export function RemoteEdits({ edits, fallbackFocus }: { edits: RemoteEditController; fallbackFocus: RefObject<HTMLButtonElement | null> }) {
  const serial = useRef(0);
  // One consent drawer at a time, kept here so it can finish closing after its row is gone (a finished discard).
  const [consent, setConsent] = useState<Consent | null>(null);
  const ask = (kind: Kind, edit: RemoteEditView, opener: HTMLElement) => setConsent({ serial: ++serial.current, kind, edit, opener });
  return (
    <section className="remote-edits" aria-label="Remote edits" data-testid="remote-edits">
      <div className="remote-edits-heading">
        <h2 className="type-label">Remote edits{edits.edits.length ? ` (${edits.edits.length})` : ""}</h2>
        <span className="type-caption text-muted-foreground">UTF-8 text · up to 8 MiB · 8 retained edits</span>
      </div>
      <p className="remote-edit-capabilities type-caption text-muted-foreground">
        Local ↔ remote transfers are supported. Remote ↔ remote and resume are unavailable; transfer Retry starts at byte zero.
      </p>
      {edits.failure ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Remote edit action could not complete</AlertTitle>
          <AlertDescription>{edits.failure}</AlertDescription>
        </Alert>
      ) : null}
      {edits.edits.length ? (
        <div className="remote-edit-list" role="region" aria-label="Remote editing working copies" tabIndex={0}>
          {edits.edits.map((edit) => <RemoteEditRow key={edit.id} edit={edit} controller={edits} ask={ask} />)}
        </div>
      ) : null}
      {/* Focus returns to the opener, else its row's Open in TextEdit, else the toolbar's Edit remote file. */}
      {consent ? (
        <ConsentDrawer key={consent.serial} consent={consent} live={edits.edits.find((edit) => edit.id === consent.edit.id)} controller={edits}
          returnFocus={() => firstUsable(consent.opener, consent.opener?.closest("article")?.querySelector("button"), fallbackFocus.current)} onClose={() => setConsent(null)} />
      ) : null}
    </section>
  );
}

function RemoteEditRow({ edit, controller, ask }: { edit: RemoteEditView; controller: RemoteEditController; ask(kind: Kind, edit: RemoteEditView, opener: HTMLElement): void }) {
  const busy = controller.pending.has(edit.id);
  // A failed check/editor/upload may still own the successfully downloaded working copy.
  const canEdit = edit.localAvailable && (editable.has(edit.state) || (edit.state === "failed" && edit.size !== null && edit.error !== "publication-unknown")) && !edit.cleanupPending;
  const canDiscard = edit.state !== "publishing" && edit.state !== "cancelling";
  return (
    <article className="remote-edit-row" data-testid="remote-edit" data-edit-id={edit.id} data-state={edit.state} data-remote-path={edit.remotePath}>
      <div className="remote-edits-heading">
        <FilePenLineIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 type-label"><bdi>{displayName(edit.target.label).text}</bdi></span>
        {edit.target.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
        <Badge variant={edit.state === "failed" || edit.state === "cleanup-failed" ? "destructive" : "secondary"}>{states[edit.state]}</Badge>
        <span className="type-caption text-muted-foreground">{sizeText(edit.size)}</span>
      </div>
      <RemoteEditDestination edit={edit} />
      <div className="remote-edit-actions">
        <Button size="sm" variant="outline" disabled={busy || !canEdit} onClick={(event) => ask("open", edit, event.currentTarget)}>Open in TextEdit</Button>
        <Button size="sm" variant="outline" disabled={busy || !canEdit} onClick={() => void controller.check(edit)}>Check for changes</Button>
        <Button size="sm" disabled={busy || edit.state !== "changed" || !edit.approvalId || edit.cleanupPending} onClick={(event) => ask("upload", edit, event.currentTarget)}>Upload changes</Button>
        <Button size="sm" variant="outline" disabled={busy || !canDiscard} onClick={(event) => ask("discard", edit, event.currentTarget)}>
          {edit.state === "cleanup-failed" ? "Retry cleanup" : edit.state === "uploaded" ? "Finish edit" : "Discard edit"}
        </Button>
      </div>
      {edit.state === "ready" ? <p className="type-caption text-muted-foreground">Downloaded privately. Open TextEdit explicitly to begin editing.</p> : null}
      {edit.state === "editing" ? <p className="type-caption text-muted-foreground">Save in TextEdit, then check for changes. Saving or closing the editor never uploads automatically.</p> : null}
      {edit.state === "changed" ? <p className="type-caption text-muted-foreground">A checked snapshot is ready. Upload requires confirmation; later editor saves need another check.</p> : null}
      {edit.state === "uploaded" ? <p className="type-caption text-muted-foreground">The checked snapshot was uploaded. {edit.localAvailable ? "Your working copy is kept; check again for later saves or finish the edit explicitly." : "The app-owned working copy was removed."}</p> : null}
      {!edit.localAvailable && edit.state === "failed" && !edit.cleanupPending ? <p className="type-caption text-muted-foreground">The app-owned working copy was removed. Only this result and any remote staging path remain.</p> : null}
      {edit.state === "publishing" ? <p className="type-caption text-muted-foreground">Publishing the captured destination. This replacement cannot be cancelled now.</p> : null}
      {edit.cleanupPending ? <p role="status" className="type-caption text-muted-foreground">Owned files are still closing or being cleaned up.</p> : null}
      {edit.error ? <p role="status" className="remote-edit-error type-caption">{problems[edit.error]}</p> : null}
      {edit.partialPath ? (
        <p className="type-caption"><strong>{edit.error === "publication-unknown" ? "Remote temporary file (may have moved): " : "Retained remote temporary file: "}</strong><bdi>{displayName(edit.partialPath).text}</bdi> This remote file is not removed by local cleanup.</p>
      ) : null}
    </article>
  );
}

/**
 * TextEdit launch, snapshot upload and discard consent as a confirmation drawer. It answers only the edit revision
 * and approval captured when it opened: any later change (an editor save, a check, cleanup, a lock) closes it unsent.
 */
function ConsentDrawer({ consent: { kind, edit: captured }, live, controller, returnFocus, onClose }: {
  consent: Consent;
  live?: RemoteEditView;
  controller: RemoteEditController;
  returnFocus(): HTMLElement | true;
  onClose(): void;
}) {
  const reject = useRef<HTMLButtonElement>(null);
  const busy = controller.pending.has(captured.id);
  const valid = !!live && live.revision === captured.revision && live.approvalId === captured.approvalId;
  const close = useDrawerClose({ busy });
  const { discard } = close;
  useEffect(() => { if (!valid) discard(); }, [valid]);
  // The controller's failure is shared: show it here only once this drawer has acted, never a stale one from before.
  const [acted, setActed] = useState(false);
  const finish = kind === "discard" && captured.state === "uploaded";
  const confirm = async () => {
    if (!valid || busy) return;
    setActed(true);
    const accepted = kind === "open" ? await controller.open(captured)
      : kind === "upload" ? await controller.upload(captured)
        : await controller.discard(captured);
    if (accepted) discard();
  };
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={reject}
      finalFocus={returnFocus}
      data-testid={`remote-edit-${kind}-confirm`}
      title={kind === "open" ? "Open this file in TextEdit?" : kind === "upload" ? "Replace this remote file?" : finish ? "Finish this remote edit?" : "Discard this remote edit?"}
      target={<><bdi className="min-w-0 font-medium text-foreground">{displayName(captured.target.label).text}</bdi>{captured.target.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}</>}
      description={kind === "open" ? "This opens a plaintext local working copy in TextEdit. TextEdit's independent buffers, autosaves, history and other copies cannot be cleaned up or revoked by ssterm."
        : kind === "upload" ? "Upload replaces the captured remote file with exactly the checked snapshot. Later editor saves are not included."
          : "Cancel pending work and remove this edit's local working copy, including any later saves. Preserve needed work independently in TextEdit first. External editor buffers, autosaves and history remain outside ssterm's control."}
      footer={
        <>
          <Button ref={reject} variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button variant={kind === "open" ? "default" : "destructive"} disabled={busy || !valid} onClick={() => void confirm()}>
            {kind === "open" ? "Open TextEdit" : kind === "upload" ? "Replace remote file" : finish ? "Finish edit" : "Discard working copy"}
          </Button>
        </>
      }
    >
      <RemoteEditDestination edit={captured} />
      {kind === "upload" ? (
        <p className="type-caption text-muted-foreground">Atomic replacement uses mode 0600. Owner, ACLs and timestamps are not preserved. Content checks are best effort: SFTP cannot compare and replace atomically, so another writer can still change the file between the final check and replacement.</p>
      ) : null}
      {kind === "discard" && captured.partialPath ? <p className="type-caption text-muted-foreground">The remote temporary file shown in this row is retained. Local cleanup does not remove it.</p> : null}
      {acted && controller.failure ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>Remote edit action could not complete</AlertTitle>
          <AlertDescription>{controller.failure}</AlertDescription>
        </Alert>
      ) : null}
    </Drawer>
  );
}

function RemoteEditDestination({ edit }: { edit: RemoteEditView }) {
  return (
    <div className="remote-edit-destination">
      <p className="type-caption text-muted-foreground"><bdi>{displayName(endpointText(edit.target.endpointHost, edit.target.endpointPort, edit.target.username ?? undefined)).text}</bdi></p>
      <p className="type-caption"><bdi>{displayName(edit.remotePath).text}</bdi></p>
    </div>
  );
}
