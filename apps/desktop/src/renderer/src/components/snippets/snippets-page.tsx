import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import {
  CheckIcon,
  LayersIcon,
  LockKeyholeIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  SearchXIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  MAX_CATALOG_ITEMS,
  type CatalogSnippet,
  type CatalogState,
  type ErrorCode,
  type Owner,
  type SnippetProtectionProblem,
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import type { Catalog } from "@/hooks/use-catalog";
import { call, imeEnterGuard } from "@/components/identities/secret-input";
import { compareLabel, normalized } from "@/lib/catalog-filter";
import { labelError, serverFieldErrors } from "@/lib/catalog-validation";
import { bodyBytes, bodyError, filterSnippets, saveFieldError, sizeText } from "@/lib/snippet-filter";

type Selection = { kind: "new" } | { kind: "snippet"; id: string };
type Notice = { title: string; text: string };
type Draft = { label: string; body: string; tagIds: string[] };

const heading = () => document.querySelector<HTMLElement>('[data-testid="snippets-page"] h2');
const sameDraft = (a: Draft, b: Draft) =>
  a.label === b.label && a.body === b.body && a.tagIds.length === b.tagIds.length && a.tagIds.every((id) => b.tagIds.includes(id));

export function protectionNotice(problem: SnippetProtectionProblem): Notice {
  if (problem.status === "corrupt")
    return {
      title: "This snippet cannot be decrypted",
      text: "Its stored data failed the integrity check and was left unchanged. Delete it, or restore a verified backup.",
    };
  if (problem.status === "unsupported")
    return { title: "This snippet uses an unsupported format", text: "Open it with a compatible version of ssterm. It was left unchanged." };
  switch (problem.reason) {
    case "missing":
      return {
        title: "The snippet key is missing from the Keychain",
        text: "Saved snippet bodies cannot be read without it, and ssterm will not replace it with a new key. Restore the Keychain item, or delete snippets you no longer need.",
      };
    case "locked":
    case "denied":
      return { title: "The Keychain did not allow access", text: "Unlock the Keychain or allow ssterm to use it, then try again." };
    default:
      return { title: "The macOS Keychain is unavailable", text: "Snippet bodies cannot be read or saved right now. Try again." };
  }
}
export function requestNotice(code: ErrorCode, action: string): Notice {
  if (code === "conflict")
    return {
      title: "This snippet changed elsewhere",
      text: "Your edits were not saved. Copy anything you want to keep, then close the snippet and open it again to see the latest version.",
    };
  if (code === "busy") return { title: `The snippet was not ${action}`, text: "The workspace is busy. Try again in a moment." };
  return {
    title: `The snippet was not ${action}`,
    text: "Snippets are unavailable while the workspace is locked or closed. Try again.",
  };
}
function NoticeAlert({ notice }: { notice: Notice }) {
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>{notice.text}</AlertDescription>
    </Alert>
  );
}

export function SnippetsPage({ owner, catalog, state }: { owner: Owner; catalog: Catalog; state: CatalogState }) {
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<Selection>();
  // Each opened editor is a fresh session; creating a snippet keeps the session (and focus) alive.
  const [session, setSession] = useState(0);
  // The lock epoch an editor opened under: a later lock drops its plaintext and unsaved draft.
  const [openedEpoch, setOpenedEpoch] = useState(state.lockEpoch);
  const [pending, setPending] = useState<Selection | "close">();
  const [deleting, setDeleting] = useState<CatalogSnippet>();
  const dirty = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const tags = useMemo(() => new Map(state.tags.map((tag) => [tag.id, tag])), [state.tags]);
  const shown = useMemo(() => filterSnippets(state.snippets, state.tags, search), [state.snippets, state.tags, search]);
  const selectedRow = selection?.kind === "snippet" ? state.snippets.find((row) => row.id === selection.id) : undefined;
  const locked = !!selection && state.lockEpoch > openedEpoch;

  // A snippet deleted elsewhere closes its editor. A just-created one may not be in the pushed state yet.
  const seen = useRef<string>(undefined);
  useEffect(() => {
    if (selection?.kind !== "snippet") return;
    if (selectedRow) seen.current = selectedRow.id;
    else if (seen.current === selection.id) {
      dirty.current = false;
      setSelection(undefined);
    }
  }, [selection, selectedRow]);
  useEffect(() => {
    if (!locked) return;
    dirty.current = false;
    // The draft is already gone; there is nothing left to discard.
    setPending(undefined);
  }, [locked]);

  const open = (next: Selection | undefined) => {
    dirty.current = false;
    setSelection(next);
    setSession((n) => n + 1);
    setOpenedEpoch(state.lockEpoch);
  };
  const request = (next: Selection | "close") => {
    if (dirty.current && !locked) return setPending(next);
    open(next === "close" ? undefined : next);
  };
  const empty = state.snippets.length === 0;
  const newButton = (
    <Button size="sm" onClick={() => request({ kind: "new" })}>
      <PlusIcon data-icon="inline-start" /> New snippet
    </Button>
  );

  return (
    <div className="catalog-page" data-testid="snippets-page">
      <PageHeader
        title="Snippets"
        subtitle={`Reusable commands, encrypted on this Mac · ${state.snippets.length} ${state.snippets.length === 1 ? "snippet" : "snippets"}`}
        actions={empty && !selection ? null : newButton}
      />
      <p className="flex items-center gap-2 type-caption text-muted-foreground">
        <ShieldCheckIcon className="size-4 shrink-0" aria-hidden="true" />
        Snippet bodies are encrypted on this Mac. Saving never runs a command.
      </p>
      {state.truncated ? (
        <p className="type-caption text-muted-foreground">Showing the first {MAX_CATALOG_ITEMS.toLocaleString()} items of each kind.</p>
      ) : null}
      {empty && !selection ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>No snippets yet</EmptyTitle>
            <EmptyDescription>Save commands and scripts you reuse. Their contents are encrypted and stay on this Mac.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => request({ kind: "new" })}>
              <PlusIcon data-icon="inline-start" /> New snippet
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="catalog-split">
          <div className="flex min-h-0 min-w-0 flex-col gap-2">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label="Search snippets"
                placeholder="Search names and tags"
                value={search}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setSearch(event.target.value)}
              />
            </InputGroup>
            <span role="status" className="sr-only">
              {search.trim() ? `${shown.length} ${shown.length === 1 ? "snippet matches" : "snippets match"}` : ""}
            </span>
            {shown.length === 0 && !empty ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <SearchXIcon />
                  </EmptyMedia>
                  <EmptyTitle>No snippets match</EmptyTitle>
                  <EmptyDescription>Search looks at snippet names and tags, never at their contents.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={() => setSearch("")}>Clear search</Button>
                </EmptyContent>
              </Empty>
            ) : (
              <ul
                ref={list}
                className="catalog-list"
                aria-label="Snippets"
                onKeyDown={(event) => {
                  const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button[data-snippet-id]") ?? [])];
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const step: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 };
                  const next = buttons[step[event.key] ?? -1];
                  if (index < 0 || !next) return;
                  event.preventDefault();
                  next.focus();
                }}
              >
                {shown.map((snippet, index) => {
                  const current = selection?.kind === "snippet" && selection.id === snippet.id;
                  const focusable = current || (selection?.kind !== "snippet" && index === 0);
                  return (
                    <li key={snippet.id}>
                      <button
                        type="button"
                        className="catalog-row"
                        data-snippet-id={snippet.id}
                        tabIndex={focusable ? 0 : -1}
                        aria-current={current ? "true" : undefined}
                        onClick={() => {
                          if (!current || locked) request({ kind: "snippet", id: snippet.id });
                        }}
                      >
                        <span className="min-w-0 truncate font-medium" title={snippet.label}>{snippet.label}</span>
                        {snippet.tagIds.length ? (
                          <span className="flex min-w-0 flex-wrap gap-1">
                            {snippet.tagIds.map((id) => {
                              const tag = tags.get(id);
                              return tag ? (
                                <Badge key={id} variant="secondary" className="max-w-full" title={tag.label}>
                                  <span className="min-w-0 truncate">{tag.label}</span>
                                </Badge>
                              ) : null;
                            })}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {!selection ? (
            <div className="catalog-detail">
              <p className="text-sm text-muted-foreground">Choose a snippet to open it, or create a new one.</p>
            </div>
          ) : locked ? (
            <section className="catalog-detail" aria-label="Snippet closed" data-testid="snippet-locked">
              <div className="flex items-center gap-2">
                <LockKeyholeIcon className="size-4 shrink-0" aria-hidden="true" />
                <h3 className="type-label">The workspace locked</h3>
              </div>
              <p className="text-sm">The open snippet was closed and any unsaved changes were discarded. Open it again to continue.</p>
              <div className="flex flex-wrap gap-2">
                {selection.kind === "snippet" ? (
                  <Button size="sm" onClick={() => open(selection)}>Open again</Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => open(undefined)}>Close</Button>
              </div>
            </section>
          ) : (
            <SnippetEditor
              key={session}
              owner={owner}
              catalog={catalog}
              state={state}
              snippet={selectedRow}
              onDirty={(value) => { dirty.current = value; }}
              onCreated={(id) => setSelection({ kind: "snippet", id })}
              onClose={() => request("close")}
              onDelete={(row) => setDeleting(row)}
            />
          )}
        </div>
      )}
      <AlertDialog open={pending !== undefined} onOpenChange={(value) => { if (!value) setPending(undefined); }}>
        <AlertDialogContent className="motion-reduce:animate-none" data-testid="discard-snippet-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>The changes to this snippet have not been saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" autoFocus onClick={() => setPending(undefined)}>Keep editing</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const next = pending;
                setPending(undefined);
                open(next === "close" || next === undefined ? undefined : next);
              }}
            >
              Discard
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {deleting ? (
        <DeleteSnippetDialog
          owner={owner}
          snippet={deleting}
          onClose={() => setDeleting(undefined)}
          onDeleted={() => {
            setDeleting(undefined);
            open(undefined);
          }}
          afterDelete={() =>
            list.current?.querySelector<HTMLElement>(`button[data-snippet-id]:not([data-snippet-id="${CSS.escape(deleting.id)}"])`) ?? heading()}
        />
      ) : null}
    </div>
  );
}

function SnippetEditor({
  owner,
  catalog,
  state,
  snippet,
  onDirty,
  onCreated,
  onClose,
  onDelete,
}: {
  owner: Owner;
  catalog: Catalog;
  state: CatalogState;
  /** Undefined: a new snippet. */
  snippet?: CatalogSnippet;
  onDirty(dirty: boolean): void;
  onCreated(id: string): void;
  onClose(): void;
  onDelete(snippet: CatalogSnippet): void;
}) {
  const [target, setTarget] = useState(snippet ? { id: snippet.id, revision: snippet.revision } : undefined);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">(snippet ? "loading" : "ready");
  const [baseline, setBaseline] = useState<Draft>({ label: "", body: "", tagIds: [] });
  const [draft, setDraft] = useState<Draft>(baseline);
  const [errors, setErrors] = useState<{ label?: string; body?: string; tag?: string }>({});
  const [notice, setNotice] = useState<Notice>();
  const [saving, setSaving] = useState(false);
  // Synchronous guard: two submits before a render must not create two snippets.
  const inFlight = useRef(false);
  const [status, setStatus] = useState("");
  const [newTag, setNewTag] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const labelInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const dirty = phase === "ready" && !sameDraft(draft, baseline);
  const tags = useMemo(() => [...state.tags].sort(compareLabel), [state.tags]);
  const bytes = useMemo(() => bodyBytes(draft.body), [draft.body]);

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  // Only the opened snippet: a later revision elsewhere is reported on save, never silently merged.
  useEffect(() => {
    if (!snippet) {
      labelInput.current?.focus();
      return;
    }
    let stale = false;
    void call((bridge) => bridge.openSnippet({ owner, snippetId: snippet.id, expectedRevision: snippet.revision })).then((result) => {
      if (stale) return;
      if (!result.ok) {
        setNotice(requestNotice(result.error.code, "opened"));
        return setPhase("failed");
      }
      if (result.value.status !== "open") {
        setNotice(protectionNotice(result.value));
        return setPhase("failed");
      }
      const loaded = { label: snippet.label, body: result.value.body, tagIds: [...snippet.tagIds] };
      setBaseline(loaded);
      setDraft(loaded);
      setPhase("ready");
    });
    return () => {
      stale = true;
    };
    // Opened once per editor session.
  }, []);

  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setStatus("");
  };

  async function save() {
    if (inFlight.current || phase !== "ready") return;
    const existing = new Set(state.tags.map((tag) => tag.id));
    const submitted: Draft = { label: draft.label, body: draft.body, tagIds: draft.tagIds.filter((id) => existing.has(id)) };
    const next = { label: labelError(submitted.label), body: bodyError(submitted.body) };
    setErrors(next);
    setNotice(undefined);
    if (next.label) return labelInput.current?.focus();
    if (next.body) return bodyInput.current?.focus();
    inFlight.current = true;
    setSaving(true);
    const result = await call((bridge) => bridge.saveSnippet({
      owner,
      snippetId: target?.id ?? null,
      expectedRevision: target?.revision ?? null,
      label: submitted.label,
      body: submitted.body,
      tagIds: submitted.tagIds,
    })).finally(() => {
      inFlight.current = false;
    });
    setSaving(false);
    if (!result.ok) return setNotice(requestNotice(result.error.code, "saved"));
    const value = result.value;
    if (value.status === "invalid") {
      const problem = saveFieldError(value);
      setErrors({ [problem.field]: problem.text });
      if (problem.field === "label") labelInput.current?.focus();
      else if (problem.field === "body") bodyInput.current?.focus();
      return;
    }
    if (value.status !== "saved") return setNotice(protectionNotice(value));
    const saved = { ...submitted, label: submitted.label.trim() };
    setBaseline(saved);
    setDraft(saved);
    setTarget({ id: value.snippetId, revision: value.revision });
    setStatus("Snippet saved");
    if (!target) onCreated(value.snippetId);
  }

  async function addTag() {
    if (tagBusy) return;
    const label = newTag;
    const invalid = labelError(label);
    if (invalid) return setErrors((current) => ({ ...current, tag: invalid }));
    const existing = state.tags.find((tag) => normalized(tag.label) === normalized(label));
    if (existing) {
      if (!draft.tagIds.includes(existing.id)) update({ tagIds: [...draft.tagIds, existing.id] });
      setNewTag("");
      return setErrors((current) => ({ ...current, tag: undefined }));
    }
    setTagBusy(true);
    const prepared = await catalog.prepare({ type: "create-tag", data: { label: label.trim() } });
    let created: string | undefined;
    let problem = "The tag could not be created. Try again.";
    if (prepared.ok && prepared.value.kind === "preview") {
      const applied = await catalog.apply(prepared.value.token);
      if (applied.ok) created = applied.value.createdIds[0];
    } else if (prepared.ok && prepared.value.kind === "invalid") {
      problem = serverFieldErrors(prepared.value.fields).label ?? "The tag could not be created.";
    }
    setTagBusy(false);
    if (!created) return setErrors((current) => ({ ...current, tag: problem }));
    setDraft((current) => ({ ...current, tagIds: [...current.tagIds, created] }));
    setNewTag("");
    setErrors((current) => ({ ...current, tag: undefined }));
  }

  const title = target ? baseline.label || "Snippet" : "New snippet";
  return (
    <section className="catalog-detail snippet-editor" aria-label={title} data-testid="snippet-editor">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="type-label min-w-0 break-all">{title}</h3>
        {target && snippet ? (
          <Button size="sm" variant="outline" disabled={saving} onClick={() => onDelete(snippet)}>
            <Trash2Icon data-icon="inline-start" /> Delete
          </Button>
        ) : null}
      </div>
      {notice ? <NoticeAlert notice={notice} /> : null}
      {phase === "loading" ? (
        <Spinner aria-label="Opening snippet" />
      ) : phase === "failed" ? (
        <div>
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        </div>
      ) : (
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          onKeyDown={(event) => {
            if (event.metaKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() === "s") {
              event.preventDefault();
              void save();
            }
          }}
        >
          <Field data-invalid={errors.label ? true : undefined}>
            <FieldLabel htmlFor="snippet-label">Name</FieldLabel>
            <Input
              ref={labelInput}
              id="snippet-label"
              value={draft.label}
              aria-invalid={errors.label ? true : undefined}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={imeEnterGuard}
              onChange={(event) => {
                update({ label: event.target.value });
                setErrors((current) => ({ ...current, label: undefined }));
              }}
            />
            {errors.label ? <FieldError>{errors.label}</FieldError> : null}
          </Field>
          <Field data-invalid={errors.body ? true : undefined}>
            <FieldLabel htmlFor="snippet-body">Script</FieldLabel>
            <textarea
              ref={bodyInput}
              id="snippet-body"
              className="snippet-body"
              rows={12}
              wrap="off"
              value={draft.body}
              aria-invalid={errors.body ? true : undefined}
              aria-describedby="snippet-body-help"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => {
                update({ body: event.target.value });
                setErrors((current) => ({ ...current, body: undefined }));
              }}
            />
            <FieldDescription id="snippet-body-help">
              {sizeText(bytes)} · Saved exactly as written, including blank lines. Tab moves to the next control.
            </FieldDescription>
            {errors.body ? <FieldError>{errors.body}</FieldError> : null}
          </Field>
          <div className="grid gap-2" role="group" aria-labelledby="snippet-tags">
            <h4 id="snippet-tags" className="type-label">Tags</h4>
            {tags.length ? (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const assigned = draft.tagIds.includes(tag.id);
                  return (
                    <Toggle
                      key={tag.id}
                      variant="outline"
                      size="sm"
                      className="max-w-full"
                      title={tag.label}
                      pressed={assigned}
                      onPressedChange={(pressed) =>
                        update({ tagIds: pressed ? [...draft.tagIds, tag.id] : draft.tagIds.filter((id) => id !== tag.id) })}
                    >
                      {assigned ? <CheckIcon data-icon="inline-start" /> : null}
                      <span className="min-w-0 truncate">{tag.label}</span>
                    </Toggle>
                  );
                })}
              </div>
            ) : (
              <p className="type-caption text-muted-foreground">No tags yet.</p>
            )}
            <InputGroup className="max-w-xs">
              <InputGroupInput
                aria-label="New tag"
                placeholder="New tag"
                value={newTag}
                aria-busy={tagBusy || undefined}
                aria-invalid={errors.tag ? true : undefined}
                onChange={(event) => {
                  setNewTag(event.target.value);
                  setErrors((current) => ({ ...current, tag: undefined }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault();
                    void addTag();
                  }
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton disabled={!newTag.trim()} onClick={() => void addTag()}>
                  {tagBusy ? <Spinner /> : null}Add tag
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {errors.tag ? <FieldError>{errors.tag}</FieldError> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
              {target ? "Save" : "Save snippet"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || !dirty}
              onClick={() => {
                setDraft(baseline);
                setErrors({});
                setNotice(undefined);
              }}
            >
              Revert
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onClose}>
              Close
            </Button>
            <span role="status" className="type-caption text-muted-foreground" data-testid="snippet-status">
              {status || (dirty ? "Unsaved changes" : "")}
            </span>
          </div>
        </form>
      )}
    </section>
  );
}

function DeleteSnippetDialog({
  owner,
  snippet,
  onClose,
  onDeleted,
  afterDelete,
}: {
  owner: Owner;
  snippet: CatalogSnippet;
  onClose(): void;
  onDeleted(): void;
  /** Where focus goes once the snippet is gone (the row that opened the editor is removed). */
  afterDelete(): HTMLElement | null;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const deleted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  async function confirm() {
    if (busy) return;
    setBusy(true);
    const result = await call((bridge) => bridge.deleteSnippet({ owner, snippetId: snippet.id, expectedRevision: snippet.revision }));
    setBusy(false);
    if (result.ok) {
      deleted.current = true;
      onDeleted();
    } else setNotice(requestNotice(result.error.code, "deleted"));
  }
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <AlertDialogContent
        initialFocus={cancel}
        finalFocus={() => (deleted.current ? afterDelete() : null) ?? true}
        className="flex max-h-[calc(100dvh-2rem)] flex-col [overflow-wrap:anywhere] motion-reduce:animate-none"
        data-testid="delete-snippet-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="break-all">Delete {snippet.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            The snippet and its tag assignments are removed from this Mac. This cannot be undone. Tags themselves are kept.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {notice ? <NoticeAlert notice={notice} /> : null}
        <AlertDialogFooter>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}Delete snippet
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
