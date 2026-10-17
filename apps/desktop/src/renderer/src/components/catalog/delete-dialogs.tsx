import { useEffect, useRef, useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import type {
  CatalogChangeIntent,
  CatalogGroup,
  CatalogHost,
  CatalogImpactSummary,
  ErrorCode,
} from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import type { Catalog } from "@/hooks/use-catalog";
import { AffectedServers } from "@/components/catalog/editors";

type Preview = { token: string; impacts: CatalogImpactSummary };
const layout =
  "flex max-h-[calc(100dvh-2rem)] flex-col [overflow-wrap:anywhere] data-[size=default]:sm:max-w-lg motion-reduce:animate-none";

/** Prepares whenever the intent changes (including a newer revision after a conflict) and applies on confirm. */
export function useDelete(catalog: Catalog, intent: CatalogChangeIntent | undefined, onDone: () => void) {
  const [preview, setPreview] = useState<Preview>();
  const [failure, setFailure] = useState<DeleteProblem>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The dialog unmounts when the deleted row leaves the catalog, which can happen before apply resolves.
  const confirming = useRef(false);
  const key = JSON.stringify(intent ?? null);
  useEffect(() => {
    setPreview(undefined);
    setFailure(undefined);
    if (!intent) return;
    let stale = false;
    void catalog.prepare(intent).then((result) => {
      if (stale) return;
      if (!result.ok) setFailure(result.error.code);
      else if (result.value.kind === "preview") setPreview(result.value);
      else setFailure(result.value.fields.some((field) => field.field === "tunnel") ? "tunnel-running" : "invalid-request");
    });
    return () => {
      stale = true;
    };
    // The serialized intent is the dependency; the object is rebuilt each render.
  }, [key, attempt, catalog.prepare]);
  async function confirm() {
    if (!preview || busy) return;
    setBusy(true);
    confirming.current = true;
    const result = await catalog.apply(preview.token);
    setBusy(false);
    if (result.ok) onDone();
    else {
      confirming.current = false;
      setPreview(undefined);
      setFailure(result.error.code);
    }
  }
  return {
    preview,
    failure,
    busy,
    confirm,
    retry: async () => {
      await catalog.reload();
      setAttempt((n) => n + 1);
    },
    /** Base UI finalFocus: after a deletion, the caller's target; otherwise the default return. */
    finalFocus: (afterDelete: () => HTMLElement | null) => () =>
      (confirming.current ? afterDelete() : null) ?? true,
  };
}

/** `tunnel-running`: a server being deleted has a starting, running or stopping tunnel. */
export type DeleteProblem = ErrorCode | "tunnel-running";
export function DeleteFailure({ code, retry }: { code: DeleteProblem; retry(): Promise<void> }) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>
        {code === "conflict" ? "Changed since you opened this" : "Nothing was deleted"}
      </AlertTitle>
      <AlertDescription className="grid gap-2">
        <span>
          {code === "tunnel-running"
            ? "A tunnel on this server is running. Stop it on the Port forwarding page, then delete again."
            : code === "conflict"
            ? "Review the updated details, then delete again."
            : code === "busy"
              ? "The workspace is busy. Try again in a moment."
              : "The workspace could not prepare this change. Try again."}
        </span>
        <Button variant="outline" size="sm" className="w-fit" onClick={() => void retry()}>
          Review again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;
function extras(impacts: CatalogImpactSummary): string[] {
  return [
    impacts.removedTunnelRules && plural(impacts.removedTunnelRules, "port-forwarding rule", "port-forwarding rules"),
    impacts.removedHostTags && plural(impacts.removedHostTags, "tag assignment", "tag assignments"),
    impacts.removedSnippetTags && plural(impacts.removedSnippetTags, "snippet tag", "snippet tags"),
  ].filter((text): text is string => !!text);
}

export function DeleteHostDialog({
  catalog,
  host,
  onClose,
  onDeleted,
  afterDelete,
}: {
  catalog: Catalog;
  host: CatalogHost;
  onClose(): void;
  onDeleted(): void;
  /** Where focus goes once the server is gone. */
  afterDelete(): HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const { preview, failure, busy, confirm, retry, finalFocus } = useDelete(
    catalog,
    { type: "delete-host", id: host.id, expectedRevision: host.revision },
    onDeleted,
  );
  const removed = preview ? extras(preview.impacts) : [];
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent
        initialFocus={cancel}
        finalFocus={finalFocus(afterDelete)}
        className={layout}
        data-testid="delete-host-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Delete {host.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            The saved server is removed from this workspace. Open sessions keep
            their current connection.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="-mx-4 grid min-h-0 gap-3 overflow-y-auto px-4">
          <p className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-sm">
            <span className="break-all">{host.address}</span>
            {host.environment ? (
              <Badge variant={host.environment === "PROD" ? "production" : "outline"}>
                {host.environment}
              </Badge>
            ) : null}
          </p>
          {failure ? (
            <DeleteFailure code={failure} retry={retry} />
          ) : !preview ? (
            <Spinner aria-label="Checking what will be removed" />
          ) : (
            <p className="text-sm" data-testid="delete-impacts">
              {removed.length
                ? `Also removes ${removed.join(", ")}.`
                : "Nothing else is removed."}
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!preview || busy}
            onClick={() => void confirm()}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}Delete server
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteGroupDialog({
  catalog,
  group,
  parent,
  onClose,
  onDeleted,
  afterDelete,
}: {
  catalog: Catalog;
  group: CatalogGroup;
  parent?: CatalogGroup;
  onClose(): void;
  onDeleted(): void;
  /** Where focus goes once the group is gone. */
  afterDelete(): HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<"reparent" | "subtree">();
  const { preview, failure, busy, confirm, retry, finalFocus } = useDelete(
    catalog,
    mode && {
      type: "delete-group",
      id: group.id,
      expectedRevision: group.revision,
      disposition:
        mode === "subtree"
          ? { mode: "subtree" }
          : { mode: "reparent", parentId: group.parentId },
    },
    onDeleted,
  );
  const destination = parent ? `group ${parent.label}` : "the top level";
  const impacts = preview?.impacts;
  const subgroups = impacts?.removedGroupIds.filter((id) => id !== group.id).length ?? 0;
  // Servers in subgroups keep their direct group; only the deleted group's own members move.
  const moving = catalog.state?.hosts.filter((host) => host.groupId === group.id).length ?? 0;
  const affected =
    mode === "reparent" && impacts
      ? impacts.hosts.filter(
          (host) => !host.removed && (host.effectiveConnectionChanged || host.provenanceChanged),
        )
      : [];
  const summary = !impacts
    ? undefined
    : mode === "subtree"
      ? `Deletes ${plural(impacts.removedHostIds.length, "server", "servers")} and ${plural(subgroups, "subgroup", "subgroups")}.`
      : `${plural(moving, "server moves", "servers move")} to ${destination}; ${plural(
          impacts.hosts.filter((host) => host.effectiveConnectionChanged).length,
          "server's",
          "servers'",
        )} inherited port or identity changes.`;
  const removed = impacts ? extras(impacts) : [];
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent
        initialFocus={cancel}
        finalFocus={finalFocus(afterDelete)}
        className={layout}
        data-testid="delete-group-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Delete group {group.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            Choose what happens to the servers and subgroups inside it. Open
            sessions keep their current connection.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="-mx-4 grid min-h-0 gap-4 overflow-y-auto px-4">
          <RadioGroup
            aria-label="Servers and subgroups"
            value={mode ?? null}
            onValueChange={(value) => {
              if (value === "reparent" || value === "subtree") setMode(value);
            }}
            disabled={busy}
          >
            <Field orientation="horizontal">
              <RadioGroupItem value="reparent" id={`${group.id}-reparent`} />
              <FieldLabel htmlFor={`${group.id}-reparent`} className="min-w-0 font-normal">
                Move them to {destination}
              </FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <RadioGroupItem value="subtree" id={`${group.id}-subtree`} />
              <FieldLabel htmlFor={`${group.id}-subtree`} className="font-normal">
                Delete them with this group
              </FieldLabel>
            </Field>
          </RadioGroup>
          {failure ? (
            <DeleteFailure code={failure} retry={retry} />
          ) : mode && !preview ? (
            <Spinner aria-label="Checking what will change" />
          ) : summary ? (
            <>
              <p className="text-sm" data-testid="delete-impacts">
                {summary}
                {removed.length ? ` Also removes ${removed.join(", ")}.` : ""}
              </p>
              {affected.length ? <AffectedServers hosts={affected} /> : null}
            </>
          ) : null}
        </div>
        <AlertDialogFooter>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!preview || busy}
            onClick={() => void confirm()}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}Delete group
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
