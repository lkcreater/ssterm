import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CornerLeftUpIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FileQuestionIcon,
  FolderIcon,
  HomeIcon,
  Link2Icon,
  RefreshCwIcon,
  ScanEyeIcon,
  TextCursorInputIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type {
  DirectoryListing,
  ErrorCode,
  FileEntry,
  FileErrorCode,
  FileOutcome,
  FileSource,
  Owner,
  Result,
} from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { copyText } from "@/lib/clipboard";
import {
  breadcrumbs,
  displayName,
  emptySelection,
  filterHidden,
  isUnreadable,
  joinPath,
  modifiedText,
  nextFence,
  parentPath,
  permissionsText,
  replyApplies,
  revealScrollTop,
  ROW_HEIGHT,
  selectionReducer,
  sizeText,
  snapshot,
  sortEntries,
  sourceKey,
  splitTail,
  typeAheadMatch,
  typeLabel,
  windowRange,
  type NavigationFence,
  type SortKey,
  type SortOrder,
} from "@/lib/file-browser";

type PaneError = FileErrorCode | ErrorCode;
type Reply<T> = FileOutcome<T> | { ok: false; error: PaneError };

const problems: Record<PaneError, string> = {
  "not-found": "This folder doesn't exist.",
  "permission-denied": "You don't have permission to open this folder.",
  "invalid-path": "This path isn't valid.",
  unsupported: "The server can't read this folder.",
  failure: "This folder couldn't be read.",
  "connection-lost": "The connection was lost.",
  "resource-limit": "The system ran out of resources for this request. Try again.",
  closed: "The session closed.",
  "not-responding": "The folder's volume is not responding.",
  "invalid-request": "This path can't be requested.",
  unauthorized: "This window can't read files.",
  "stale-owner": "This window is out of date; reopen it to continue.",
  conflict: "The session changed. Try again.",
  busy: "This Mac is still waiting on another folder. Try again in a moment.",
  unavailable: "Files are unavailable right now. Try again.",
};
const gotoProblems: Partial<Record<PaneError, string>> = {
  "not-found": "Nothing exists at that path.",
  "permission-denied": "You don't have permission to open that path.",
};
const TYPE_AHEAD_MS = 1000;
const NOTICE_MS = 4000;
// This Mac serves two reads at once; requests a quick Backspace run superseded may still hold them.
const BUSY_RETRY_MS = 150;
const BUSY_RETRIES = 13;

async function settle<T>(call: () => Promise<Result<FileOutcome<T>>> | undefined): Promise<Reply<T>> {
  try {
    const result = await call();
    if (!result) return { ok: false, error: "unavailable" };
    return result.ok ? result.value : { ok: false, error: result.error.code };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const visibleRows = (listing: DirectoryListing | null, showHidden: boolean, sort: SortOrder) =>
  listing ? sortEntries(filterHidden(listing.entries, showHidden), sort) : [];
const command = (event: KeyboardEvent, shift = false) =>
  event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey === shift;

/** Captured when an action is invoked (SST-021 transfers): the exact source, directory and raw names. */
export interface FilePaneHandle {
  snapshot(): { source: FileSource; path: string; names: string[] } | null;
  /** Refresh a captured destination only if the pane is still showing it. Never navigates. */
  refresh(source: FileSource, path: string): void;
}

interface View {
  /** The directory shown, or being opened (breadcrumbs follow it so Go up works from an error). */
  path: string | null;
  listing: DirectoryListing | null;
  loading: boolean;
  error: PaneError | null;
}

/**
 * One directory browser: toolbar (Up, breadcrumbs, Go to path, hidden toggle, Refresh), a windowed
 * multi-select listbox and a detail footer. Every request carries a latest-wins fence; a reply for an
 * older request, another session or an older generation is dropped. A new `source` generation (after
 * Reconnect) re-lists the same path.
 */
export function FilePane({
  owner,
  source,
  home,
  active,
  label,
  unavailable,
  handle,
}: {
  owner: Owner;
  /** null while the source cannot be read (remote session not Ready). */
  source: FileSource | null;
  /** Where Go home and the first listing go; null resolves `~`. */
  home: string | null;
  /** The Files page is shown; nothing is read before it first is. */
  active: boolean;
  /** "This Mac" or the server label, for accessible names. */
  label: string;
  /** Shown in place of the list while `source` is null. */
  unavailable?: ReactNode;
  handle?: Ref<FilePaneHandle>;
}) {
  const id = useId();
  const [view, setView] = useState<View>({ path: null, listing: null, loading: false, error: null });
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<SortOrder>({ key: "name", direction: "asc" });
  const [selection, dispatch] = useReducer(selectionReducer, emptySelection);
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string>();
  const [goto, setGoto] = useState<{ value: string; error?: string; busy?: boolean }>();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const gotoInput = useRef<HTMLInputElement>(null);
  const crumbs = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const fence = useRef<NavigationFence | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const typed = useRef({ text: "", at: 0 });
  const refocus = useRef(false);
  const pendingRefresh = useRef<{ source: FileSource; path: string } | null>(null);
  const rows = useMemo(() => visibleRows(view.listing, showHidden, sort), [view.listing, showHidden, sort]);
  const settings = useRef({ showHidden, sort });
  settings.current = { showHidden, sort };

  const api = (current: FileSource) => {
    const bridge = window.ssterm;
    const request = (path: string) => ({ owner, source: current, path });
    return {
      list: (path: string) => settle(() => bridge?.listDirectory(request(path))),
      stat: (path: string) => settle(() => bridge?.statPath(request(path))),
      resolve: (path: string) => settle(() => bridge?.resolvePath(request(path))),
    };
  };

  /**
   * `typed`: a path from Go to path (`~`, relative, or a file whose folder opens with it selected).
   * `focus`: the control that asked is about to unmount; the list takes keyboard focus once shown.
   */
  async function navigate(
    target: string,
    options: { typed?: boolean; select?: string; keep?: boolean; focus?: boolean } = {},
  ) {
    const current = sourceRef.current;
    if (!current) return;
    const sent = nextFence(current, fence.current);
    fence.current = sent;
    const applies = () => replyApplies(sent, fence.current, sourceRef.current);
    const files = api(current);
    // Only the newest request waits out `busy`; a superseded one stops retrying.
    const patient = async <T,>(call: (path: string) => Promise<Reply<T>>, path: string) => {
      let reply = await call(path);
      for (let tries = 0; tries < BUSY_RETRIES && !reply.ok && reply.error === "busy" && applies(); tries++) {
        await new Promise((done) => setTimeout(done, BUSY_RETRY_MS));
        if (!applies()) break;
        reply = await call(path);
      }
      return reply;
    };
    // A typed path keeps the Go to field (and its focus) until it resolves.
    refocus.current = !!options.focus && !options.typed;
    let path = target;
    let select = options.select;
    if (options.typed) {
      setGoto((value) => value && { ...value, error: undefined, busy: true });
      const resolved = await patient(files.resolve, target);
      if (!applies()) return;
      const stat = resolved.ok ? await patient(files.stat, resolved.value) : resolved;
      if (!applies()) return;
      if (!resolved.ok || !stat.ok) {
        const error = (!resolved.ok ? resolved : (stat as { error: PaneError })).error;
        setGoto((value) => value && { ...value, busy: false, error: gotoProblems[error] ?? problems[error] });
        return;
      }
      refocus.current = !!options.focus;
      path = resolved.value;
      if (stat.value.type !== "directory") {
        select = baseName(path);
        path = parentPath(path);
      }
      setGoto(undefined);
    }
    setView((previous) => ({
      path,
      listing: options.keep && previous.path === path ? previous.listing : null,
      loading: true,
      error: null,
    }));
    const listed = await patient(files.list, path);
    if (!applies()) return;
    if (!listed.ok) {
      refocus.current = false;
      setView({ path, listing: null, loading: false, error: listed.error });
      return;
    }
    const listing = listed.value;
    if (!options.keep || shownRows.current.path !== listing.path) {
      dispatch({ type: "reset" });
      setBroken(new Set());
    }
    setView({ path: listing.path, listing, loading: false, error: null });
    if (select !== undefined) {
      const reveal = select.startsWith(".") && !settings.current.showHidden;
      if (reveal) setShowHidden(true);
      const shown = visibleRows(listing, reveal || settings.current.showHidden, settings.current.sort);
      const index = shown.findIndex((entry) => entry.name === select);
      if (index >= 0) dispatch({ type: "click", index, entries: shown });
    }
  }

  // The first listing waits for the page; a new generation (Reconnect) lists the same path again.
  const listed = useRef<string>(undefined);
  const generation = source?.kind === "remote" ? source.generation : 0;
  const key = source ? `${sourceKey(source)}:${generation}` : undefined;
  useEffect(() => {
    if (!active || !key || listed.current === key) return;
    listed.current = key;
    if (view.path) void navigate(view.path, { keep: true });
    else if (home) void navigate(home);
    else void navigate("~", { typed: true });
    // `navigate` reads the latest state through refs.
  }, [active, key]);

  // A re-sorted, filtered or refreshed same folder keeps the cursor and the selection on the same names.
  const shownRows = useRef({ rows, path: view.listing?.path });
  useEffect(() => {
    const previous = shownRows.current;
    shownRows.current = { rows, path: view.listing?.path };
    if (previous.rows !== rows && previous.path && previous.path === view.listing?.path)
      dispatch({ type: "relist", previous: previous.rows, entries: rows });
  }, [rows, view.listing?.path]);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewport(element.clientHeight));
    observer.observe(element);
    setViewport(element.clientHeight);
    return () => observer.disconnect();
    // The list unmounts only for an error or an unavailable source.
  }, [view.error === null, source === null]);

  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    setScrollTop(0);
    typed.current = { text: "", at: 0 };
    setNotice(undefined);
  }, [view.listing?.path]);

  // The deepest folder stays in view, also after a resize; earlier crumbs scroll away to the left.
  useLayoutEffect(() => {
    const element = crumbs.current;
    if (!element) return;
    const toEnd = () => (element.scrollLeft = element.scrollWidth);
    toEnd();
    const observer = new ResizeObserver(toEnd);
    observer.observe(element);
    return () => observer.disconnect();
  }, [view.path, !!goto]);

  useLayoutEffect(() => {
    const element = list.current;
    if (!element || selection.cursor < 0) return;
    const next = revealScrollTop(selection.cursor, element.scrollTop, element.clientHeight);
    if (next !== element.scrollTop) element.scrollTop = next;
    // Same pass, so the cursor row renders and becomes the active descendant without waiting for `scroll`.
    setScrollTop(element.scrollTop);
  }, [selection.cursor]);

  // An error replaces the focused list; keep keyboard focus in the pane on its first action.
  useEffect(() => {
    const focused = document.activeElement;
    if (!view.error || (focused && focused !== document.body && !root.current?.contains(focused))) return;
    root.current?.querySelector<HTMLElement>(".files-message button")?.focus();
  }, [view.error]);

  // After Go to path, Go up, Go home or Try again from the error: the list, once it is shown.
  useEffect(() => {
    if (!refocus.current || view.error || !list.current) return;
    refocus.current = false;
    list.current.focus();
  });

  // Edit > Copy and Edit > Select All reach the page as a copy event and a select-all command, not keys.
  useEffect(() => {
    const focused = () => !!list.current && document.activeElement === list.current;
    // With no text selected, Copy is enabled only when beforecopy is cancelled.
    const onBeforeCopy = (event: Event) => {
      if (focused() && copiedText.current()) event.preventDefault();
    };
    const onCopy = (event: ClipboardEvent) => {
      if (!focused() || !event.clipboardData) return;
      const text = copiedText.current();
      if (!text) return;
      event.clipboardData.setData("text/plain", text.paths);
      event.preventDefault();
      setNotice(text.notice);
    };
    // Select All starts at the document root; a drag inside the list targets a row instead.
    const onSelectStart = (event: Event) => {
      if (!focused() || list.current!.contains(event.target as Node)) return;
      event.preventDefault();
      selectAll.current();
    };
    document.addEventListener("beforecopy", onBeforeCopy);
    document.addEventListener("copy", onCopy);
    document.addEventListener("selectstart", onSelectStart);
    return () => {
      document.removeEventListener("beforecopy", onBeforeCopy);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("selectstart", onSelectStart);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useImperativeHandle(
    handle,
    () => ({
      snapshot: () =>
        source && view.listing && !view.loading && !view.error
          ? { source, path: view.listing.path, names: snapshot(selection, rows) }
          : null,
      refresh: (captured, path) => {
        if (!source || sourceKey(source) !== sourceKey(captured) ||
          (source.kind === "remote" && captured.kind === "remote" && source.generation !== captured.generation) ||
          view.error || view.path !== path) return;
        // A completion racing an existing read requires another read after it settles.
        if (view.loading) { pendingRefresh.current = { source: captured, path }; return; }
        if (view.listing?.path !== path) return;
        void navigate(path, { keep: true });
      },
    }),
    [source, view.path, view.listing, view.loading, view.error, selection, rows],
  );

  useEffect(() => {
    const pending = pendingRefresh.current;
    if (!pending || view.loading) return;
    pendingRefresh.current = null;
    if (!source || view.error || view.path !== pending.path || view.listing?.path !== pending.path ||
      sourceKey(source) !== sourceKey(pending.source) ||
      (source.kind === "remote" && pending.source.kind === "remote" && source.generation !== pending.source.generation)) return;
    void navigate(pending.path, { keep: true });
  }, [view.loading, view.path, view.error, source]);

  const path = view.path;
  const goUp = (focus?: boolean) => {
    if (path && path !== "/") void navigate(parentPath(path), { focus });
  };
  const goHome = (focus?: boolean) => void navigate(home ?? "~", { typed: !home, focus });
  const refresh = (focus?: boolean) => {
    setBroken(new Set());
    setNotice(undefined);
    if (path) void navigate(path, { keep: true, focus });
    else goHome(focus);
  };
  const openGoto = () => {
    if (goto) gotoInput.current?.select();
    else setGoto({ value: path ?? "" });
  };
  const closeGoto = () => {
    setGoto(undefined);
    setTimeout(() => list.current?.focus());
  };

  async function open(index: number) {
    const entry = rows[index];
    const current = sourceRef.current;
    if (!entry || !path || !current || isUnreadable(entry)) return;
    const target = joinPath(path, entry.name);
    if (entry.type === "directory") return void navigate(target);
    if (entry.type !== "symlink") return;
    // A link is entered at its own path (never its target's), so Up returns to where it was opened.
    const sent = nextFence(current, fence.current);
    fence.current = sent;
    const stat = await api(current).stat(target);
    if (!replyApplies(sent, fence.current, sourceRef.current)) return;
    if (stat.ok && stat.value.type === "directory") return void navigate(target);
    if (stat.ok) {
      // The rows may have changed (Refresh, sort, hidden toggle) while the link was read.
      const now = shownRows.current.rows;
      const at = now.findIndex((row) => row.name === entry.name && !isUnreadable(row));
      if (at >= 0) dispatch({ type: "click", index: at, entries: now });
      return;
    }
    if (stat.error === "not-found") {
      setBroken((names) => new Set(names).add(entry.name));
      setNotice(`${displayName(entry.name).text}: Broken link`);
    } else setNotice(problems[stat.error]);
  }

  /** The selected rows' full raw paths, one per line. */
  const copied = () => {
    const names = path ? snapshot(selection, rows) : [];
    if (!path || names.length === 0) return undefined;
    return {
      paths: names.map((name) => joinPath(path, name)).join("\n"),
      notice: `Copied ${names.length === 1 ? "1 path" : `${names.length} paths`}`,
    };
  };
  const copiedText = useRef(copied);
  copiedText.current = copied;
  const selectAll = useRef(() => {});
  selectAll.current = () => dispatch({ type: "selectAll", entries: rows });
  const copyPaths = () => {
    const text = copied();
    if (text) setNotice(copyText(text.paths) ? text.notice : "The paths could not be copied.");
  };

  // Pane-wide keys work from the toolbar and from the list.
  const onPaneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Text fields keep their own shortcuts (⌘↑ moves the caret in Go to path).
    if (event.nativeEvent.isComposing || !source || event.target instanceof HTMLInputElement) return;
    if (command(event, true) && (event.code === "KeyG" || event.key.toLowerCase() === "g")) openGoto();
    else if (command(event, true) && (event.code === "Period" || event.key === "." || event.key === ">"))
      setShowHidden((value) => !value);
    else if (command(event) && event.key === "ArrowUp") goUp();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1);
    const shift = event.shiftKey;
    const now = performance.now();
    const typing = typed.current.text !== "" && now - typed.current.at < TYPE_AHEAD_MS;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    const move = (by: number | "home" | "end" | "pageUp" | "pageDown") =>
      dispatch({ type: "move", by, page, shift, entries: rows });
    if (plain && event.key === "ArrowDown") move(1);
    else if (plain && event.key === "ArrowUp") move(-1);
    else if (plain && event.key === "Home") move("home");
    else if (plain && event.key === "End") move("end");
    else if (plain && event.key === "PageUp") move("pageUp");
    else if (plain && event.key === "PageDown") move("pageDown");
    else if ((plain && !shift && event.key === "Enter") || (command(event) && event.key === "ArrowDown"))
      void open(selection.cursor);
    else if (plain && !shift && event.key === "Backspace") {
      if (typing) typed.current = { text: typed.current.text.slice(0, -1), at: now };
      else goUp();
    } else if (plain && !shift && event.key === " " && !typing) {
      if (selection.cursor >= 0) dispatch({ type: "toggle", index: selection.cursor, entries: rows });
    } else if (plain && !shift && event.key === "Escape") dispatch({ type: "clear" });
    else if (command(event) && (event.code === "KeyA" || event.key.toLowerCase() === "a")) selectAll.current();
    else if (command(event) && (event.code === "KeyC" || event.key.toLowerCase() === "c")) copyPaths();
    else if (!event.metaKey && !event.ctrlKey && [...event.key].length === 1) {
      const text = (typing ? typed.current.text : "") + event.key;
      typed.current = { text, at: now };
      // A new search starts after the current row; a longer one may stay on it.
      const index = typeAheadMatch(rows, text, text.length === 1 ? selection.cursor + 1 : Math.max(0, selection.cursor));
      if (index >= 0) dispatch({ type: "click", index, entries: rows });
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const range = windowRange({ scrollTop, viewport, count: rows.length });
  const cursorId = selection.cursor >= range.start && selection.cursor < range.end ? `${id}-row-${selection.cursor}` : undefined;
  const pathText = path ? displayName(path).text : "";
  const focused = rows[selection.cursor];
  const hiddenCount = view.listing ? view.listing.entries.length - filterHidden(view.listing.entries, false).length : 0;
  const sortButton = (sortKey: SortKey, text: string, className: string) => {
    const on = sort.key === sortKey;
    return (
      <button
        type="button"
        className={`file-sort ${className}`}
        data-active={on || undefined}
        onClick={() =>
          setSort({ key: sortKey, direction: on && sort.direction === "asc" ? "desc" : "asc" })
        }
      >
        <span className="truncate">{text}</span>
        {on ? (
          sort.direction === "asc" ? <ArrowUpIcon aria-hidden="true" /> : <ArrowDownIcon aria-hidden="true" />
        ) : null}
        <span className="sr-only">
          {on ? `, sorted ${sort.direction === "asc" ? "ascending" : "descending"}` : `, sort by ${text.toLowerCase()}`}
        </span>
      </button>
    );
  };

  return (
    <div ref={root} className="files-browser" onKeyDown={onPaneKeyDown}>
      <div className="files-toolbar" role="toolbar" aria-label={`${label} folder`}>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Enclosing folder"
          title="Enclosing folder (⌘↑)"
          disabled={!source || !path || path === "/"}
          onClick={() => goUp()}
        >
          <CornerLeftUpIcon aria-hidden="true" />
        </Button>
        {goto ? (
          <InputGroup className="files-goto h-7 min-w-0 flex-1">
            <InputGroupInput
              ref={gotoInput}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              aria-label="Go to path"
              placeholder="/path, ~/path or a name in your home folder"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={goto.value}
              aria-invalid={goto.error ? true : undefined}
              aria-describedby={goto.error ? `${id}-goto-error` : undefined}
              onChange={(event) => setGoto({ value: event.target.value })}
              onBlur={(event) => {
                if (!event.currentTarget.closest(".files-goto")?.contains(event.relatedTarget as Node) && !goto.error)
                  setGoto(undefined);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter" && goto.value.trim()) {
                  event.preventDefault();
                  void navigate(goto.value, { typed: true, focus: true });
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeGoto();
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              {goto.busy ? <Spinner aria-label="Opening path" /> : null}
              <InputGroupButton onClick={() => goto.value.trim() && void navigate(goto.value, { typed: true, focus: true })}>
                Go
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        ) : (
          <nav className="files-crumbs" aria-label={`${label} path`} ref={crumbs}>
            {path
              ? breadcrumbs(path).map((crumb, index, all) => {
                  const last = index === all.length - 1;
                  const text = crumb.label === "/" ? "/" : displayName(crumb.label).text;
                  return (
                    <span key={crumb.path} className="files-crumb">
                      {index > 1 ? <span aria-hidden="true" className="files-crumb-separator">/</span> : null}
                      <button
                        type="button"
                        title={displayName(crumb.path).text}
                        aria-current={last ? "location" : undefined}
                        disabled={!source}
                        onClick={() => void navigate(crumb.path)}
                      >
                        <bdi className="truncate">{text}</bdi>
                      </button>
                    </span>
                  );
                })
              : null}
          </nav>
        )}
        <div className="files-tools">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Go to path"
            title="Go to path (⇧⌘G)"
            disabled={!source}
            onClick={openGoto}
          >
            <TextCursorInputIcon aria-hidden="true" />
          </Button>
          <Toggle
            size="sm"
            aria-label="Show hidden files"
            title="Show hidden files (⇧⌘.)"
            pressed={showHidden}
            disabled={!source}
            onPressedChange={setShowHidden}
          >
            {showHidden ? <EyeIcon aria-hidden="true" /> : <EyeOffIcon aria-hidden="true" />}
          </Toggle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh"
            title="Refresh"
            disabled={!source}
            onClick={() => refresh()}
          >
            <RefreshCwIcon aria-hidden="true" />
          </Button>
        </div>
      </div>
      {goto?.error ? (
        <FieldError id={`${id}-goto-error`} className="files-goto-error">
          {goto.error}
        </FieldError>
      ) : null}
      {!source ? (
        <div className="files-message">{unavailable}</div>
      ) : view.error ? (
        <div className="files-message">
          <Alert variant="destructive" data-error={view.error}>
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>{problems[view.error]}</AlertTitle>
            <AlertDescription>
              <bdi className="break-all">{pathText}</bdi>
              <span className="mt-2 flex flex-wrap gap-2">
                {path && path !== "/" ? (
                  <Button size="sm" variant="outline" onClick={() => goUp(true)}>
                    <CornerLeftUpIcon data-icon="inline-start" aria-hidden="true" /> Go up
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => goHome(true)}>
                  <HomeIcon data-icon="inline-start" aria-hidden="true" /> Go home
                </Button>
                <Button size="sm" variant="ghost" onClick={() => refresh(true)}>
                  <RefreshCwIcon data-icon="inline-start" aria-hidden="true" /> Try again
                </Button>
              </span>
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <>
          <div className="file-columns" role="group" aria-label="Sort">
            {sortButton("name", "Name", "file-name-column")}
            {sortButton("size", "Size", "file-size")}
            {sortButton("modified", "Modified", "file-modified")}
          </div>
          <div
            ref={list}
            id={`${id}-list`}
            className="file-list"
            role="listbox"
            tabIndex={0}
            aria-label={`${label} files in ${pathText}`}
            aria-multiselectable="true"
            aria-activedescendant={cursorId}
            aria-busy={view.loading || undefined}
            // The listed folder; it lags `path` (the breadcrumbs) while a new folder loads.
            data-path={view.listing && !view.loading ? displayName(view.listing.path).text : undefined}
            data-count={rows.length}
            onKeyDown={onListKeyDown}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            {!view.listing ? (
              <p className="files-empty flex items-center justify-center gap-2 type-caption text-muted-foreground" role="presentation">
                <Spinner aria-hidden="true" role="presentation" /> Loading
              </p>
            ) : rows.length === 0 ? (
              <p className="files-empty type-caption text-muted-foreground" role="presentation">
                {hiddenCount > 0 ? `This folder has only hidden items (${hiddenCount}).` : "This folder is empty."}
              </p>
            ) : (
              <>
                <div role="presentation" style={{ height: range.padTop }} />
                {rows.slice(range.start, range.end).map((entry, offset) => {
                  const index = range.start + offset;
                  return (
                    <FileRow
                      // Lossily decoded names can repeat; every other name is unique in its folder.
                      key={isUnreadable(entry) ? `#${index}` : entry.name}
                      id={`${id}-row-${index}`}
                      entry={entry}
                      index={index}
                      count={rows.length}
                      cursor={index === selection.cursor}
                      selected={selection.selected.has(entry.name) && !isUnreadable(entry)}
                      broken={broken.has(entry.name)}
                      onClick={(event) => {
                        list.current?.focus();
                        dispatch({ type: "click", index, shift: event.shiftKey, meta: event.metaKey, entries: rows });
                      }}
                      onOpen={() => void open(index)}
                    />
                  );
                })}
                <div role="presentation" style={{ height: range.padBottom }} />
              </>
            )}
          </div>
        </>
      )}
      <div className="files-footer type-caption">
        <span className="files-footer-count">
          {view.listing && source ? (
            <>
              {rows.length.toLocaleString()} {rows.length === 1 ? "item" : "items"}
              {hiddenCount > 0 && !showHidden ? ` (${hiddenCount.toLocaleString()} hidden)` : ""}
              {selection.selected.size > 0 ? ` · ${selection.selected.size.toLocaleString()} selected` : ""}
              {view.listing.truncated ? ` · showing the first ${view.listing.entries.length.toLocaleString()}` : ""}
              {view.listing.skipped > 0
                ? ` · ${view.listing.skipped.toLocaleString()} unsafe ${view.listing.skipped === 1 ? "name" : "names"} not shown`
                : ""}
            </>
          ) : null}
        </span>
        {focused && source && !isUnreadable(focused) ? (
          <span className="files-footer-detail" data-testid="file-detail" title={displayName(focused.name).text}>
            {/* The full escaped name: rows truncate, and two long names may differ only at the end. */}
            <bdi>{displayName(focused.name).text}</bdi> · {entryDetail(focused)}
          </span>
        ) : null}
        <span role="status" className="files-notice truncate">
          {view.loading && view.listing ? "Refreshing…" : notice}
        </span>
      </div>
    </div>
  );
}

function entryDetail(entry: FileEntry): string {
  const parts: string[] = [typeLabel(entry.type)];
  if (entry.permissions !== null) {
    const { symbolic, octal } = permissionsText(entry.permissions);
    parts.push(`${symbolic} (${octal})`);
  }
  if (entry.size !== null && entry.type === "file") parts.push(sizeText(entry.size));
  return parts.join(" · ");
}

const icons = { directory: FolderIcon, file: FileIcon, symlink: Link2Icon, other: FileQuestionIcon };

function FileRow({
  id,
  entry,
  index,
  count,
  cursor,
  selected,
  broken,
  onClick,
  onOpen,
}: {
  id: string;
  entry: FileEntry;
  index: number;
  count: number;
  cursor: boolean;
  selected: boolean;
  broken: boolean;
  onClick(event: MouseEvent): void;
  onOpen(): void;
}) {
  const shown = displayName(entry.name, entry.addressable);
  const Icon = icons[entry.type] ?? FileQuestionIcon;
  const link = entry.type === "symlink";
  const folderLike = entry.type === "directory" || link;
  const [head, tail] = splitTail(shown.text);
  const linkText = link ? (broken ? "Broken link" : "Link") : undefined;
  // One spoken string: separate flex children would each be read with a space before their comma.
  const spoken = [
    shown.unreadable ? "(unreadable name)" : shown.text,
    shown.escaped && !shown.unreadable ? "contains hidden characters" : undefined,
    linkText,
    entry.type === "other" ? "other" : entry.type === "directory" ? "folder" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const modified = modifiedText(entry.mtime);
  return (
    <div
      id={id}
      role="option"
      className="file-row"
      aria-selected={selected}
      aria-disabled={shown.unreadable || undefined}
      aria-setsize={count}
      aria-posinset={index + 1}
      data-cursor={cursor || undefined}
      data-type={entry.type}
      data-name={shown.unreadable ? undefined : shown.text}
      data-escaped={shown.escaped || undefined}
      data-broken={broken || undefined}
      title={shown.unreadable ? "Unreadable name" : `${shown.text}\n${entryDetail(entry)}`}
      onMouseDown={(event) => {
        // Shift-click extends the selection; it must not also select text.
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={onClick}
      onDoubleClick={() => {
        if (!shown.unreadable) onOpen();
      }}
    >
      <span className="file-name">
        <Icon className="file-icon" data-type={entry.type} aria-hidden="true" />
        {shown.unreadable ? (
          <span className="file-unreadable" aria-hidden="true">(unreadable name)</span>
        ) : (
          // Middle truncation: names sharing a long prefix still differ in their visible tail.
          <bdi className="file-name-text" aria-hidden="true">
            <span className="file-name-head">{head}</span>
            {tail ? <span className="file-name-tail">{tail}</span> : null}
          </bdi>
        )}
        {shown.escaped && !shown.unreadable ? (
          <span className="file-flag" title="Contains hidden characters" aria-hidden="true">
            <ScanEyeIcon />
          </span>
        ) : null}
        {linkText ? (
          <span className={broken ? "file-link file-link-broken" : "file-link"} aria-hidden="true">
            {linkText}
          </span>
        ) : null}
        <span className="sr-only">{spoken}</span>
      </span>
      <span className="file-size">{folderLike ? "—" : sizeText(entry.size)}</span>
      <span className="file-modified" title={modified}>
        <span className="file-modified-long">{modified}</span>
        <span className="file-modified-short">{modifiedText(entry.mtime, undefined, true)}</span>
      </span>
    </div>
  );
}
