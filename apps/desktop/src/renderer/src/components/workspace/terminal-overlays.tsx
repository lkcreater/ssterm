import { useRef, type RefObject } from "react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { hasNewline, pasteLines, terminalShortcut } from "@/lib/terminal-input";

export interface SearchResults {
  index: number;
  count: number;
}
export type SearchDirection = "next" | "previous";

export function lineCount(lines: number) {
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

function resultText(results?: SearchResults) {
  if (!results) return "";
  if (results.count === 0) return "No matches";
  // xterm reports index -1 once the highlight limit is exceeded.
  return results.index < 0 ? `${results.count} matches` : `${results.index + 1} of ${results.count}`;
}

/** Lives outside the xterm host, so nothing typed here can reach the remote. */
export function TerminalSearchBar({
  label,
  inputRef,
  results,
  onFind,
  onClose,
}: {
  label: string;
  inputRef: RefObject<HTMLInputElement | null>;
  results?: SearchResults;
  onFind(query: string, direction: SearchDirection, incremental?: boolean): void;
  onClose(): void;
}) {
  const query = () => inputRef.current?.value ?? "";
  return (
    <div
      className="live-terminal-search"
      role="search"
      data-search-count={results?.count ?? ""}
      data-search-index={results ? results.index + 1 : ""}
    >
      <Input
        ref={inputRef}
        autoFocus
        type="search"
        aria-label={`Search terminal output for ${label}`}
        placeholder="Search output"
        className="live-terminal-search-input"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onFind(event.currentTarget.value, "next", true)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onFind(query(), event.shiftKey ? "previous" : "next");
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (terminalShortcut(event.nativeEvent) === "search") {
            event.preventDefault();
            event.currentTarget.select();
          }
        }}
      />
      <span className="type-caption shrink-0 text-muted-foreground" aria-live="polite">
        {resultText(results)}
      </span>
      <Button size="icon-sm" variant="ghost" aria-label="Previous match" onClick={() => onFind(query(), "previous")}>
        <ChevronUpIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Next match" onClick={() => onFind(query(), "next")}>
        <ChevronDownIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Close search" onClick={onClose}>
        <XIcon />
      </Button>
    </div>
  );
}

export interface PendingPaste {
  text: string;
  lines: number;
  removed: boolean;
  bracketed: boolean;
  label: string;
  endpoint: string | null;
  production: boolean;
  /** The session generation the paste was aimed at; a reconnect makes it stale. */
  generation: number;
}

const PREVIEW_LINES = 200;

/** Tabs get a visible marker so they cannot pass for spaces. */
function PreviewLine({ line }: { line: string }) {
  if (!line) return <div>{" "}</div>;
  return (
    <div>
      {line.split("\t").map((part, index) => (
        <span key={index}>
          {index > 0 ? <span className="paste-marker" title="Tab">⇥</span> : null}
          {part}
        </span>
      ))}
    </div>
  );
}

/** The target is the one captured when the paste happened, not whatever the pane shows later. */
export function PasteConfirmDialog({
  pending,
  canPaste,
  returnFocus,
  onCancel,
  onConfirm,
}: {
  pending?: PendingPaste;
  canPaste: boolean;
  returnFocus(): HTMLElement | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const preview = pending ? pasteLines(pending.text) : [];
  const more = preview.length - PREVIEW_LINES;
  const notes = [
    more > 0 ? `and ${lineCount(more)} more` : null,
    pending && /[\r\n]$/.test(pending.text) ? "↵ ends with a newline" : null,
  ].filter(Boolean);
  const reasons = pending
    ? [
        pending.bracketed || !hasNewline(pending.text) ? null : "The shell is not in bracketed paste mode, so each line can run as soon as it arrives.",
        pending.production ? "This is a production target." : null,
        pending.removed ? "Control characters were removed from the clipboard text." : null,
      ].filter(Boolean)
    : [];
  return (
    <AlertDialog
      open={!!pending}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent
        initialFocus={cancel}
        finalFocus={returnFocus}
        className="flex max-h-[calc(100dvh-2rem)] flex-col data-[size=default]:sm:max-w-lg motion-reduce:animate-none"
        data-testid="paste-confirm-dialog"
      >
        {pending ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="min-w-0 break-words">
                Paste {lineCount(pending.lines)} into {pending.label}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {reasons.join(" ")} Nothing is sent until you choose Paste, and no Enter is added.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="-mx-4 grid min-h-0 gap-3 overflow-y-auto px-4">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 font-medium break-all">{pending.label}</span>
                {pending.production ? <Badge variant="production">PROD</Badge> : null}
              </div>
              {pending.endpoint ? (
                <p className="min-w-0 font-mono text-sm break-all text-muted-foreground">
                  {pending.endpoint}
                </p>
              ) : null}
              <div className="paste-preview" role="region" aria-label="Paste preview" tabIndex={0}>
                {preview.slice(0, PREVIEW_LINES).map((line, index) => (
                  <PreviewLine key={index} line={line} />
                ))}
              </div>
              {notes.length > 0 ? (
                <p className="type-caption text-muted-foreground">{notes.join(" · ")}</p>
              ) : null}
            </div>
            <AlertDialogFooter>
              <Button ref={cancel} variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button disabled={!canPaste} onClick={onConfirm}>
                Paste {lineCount(pending.lines)}
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}
