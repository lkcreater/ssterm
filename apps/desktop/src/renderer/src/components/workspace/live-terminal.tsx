import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  BanIcon,
  CircleIcon,
  CopyIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import {
  MAX_LINK_URL,
  MAX_TERMINAL_SIZE,
  MAX_TERMINAL_WRITE,
  type Owner,
  type TerminalPhase,
  type TerminalSession,
} from "@ssterm/contracts";
import {
  ConnectionStatus,
  type ConnectionState,
} from "@/components/connection/connection-status";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  PasteConfirmDialog,
  TerminalSearchBar,
  lineCount,
  type PendingPaste,
  type SearchDirection,
  type SearchResults,
} from "@/components/workspace/terminal-overlays";
import {
  hasNewline,
  isLinkActivation,
  MAX_QUEUED_INPUT,
  pasteDecision,
  sanitizePaste,
  terminalShortcut,
} from "@/lib/terminal-input";
import { endpointText } from "@/lib/catalog-filter";
import { copyText } from "@/lib/clipboard";
import { lifecycleFailure, terminalOutcome, type LifecycleAction } from "@/lib/terminal-outcome";
import {
  terminalSearchDecorations,
  terminalStyle,
  xtermOptions,
} from "@/lib/terminal-theme";

const NOTICE_MS = 4000;
// Written locally, never sent: leaves the alternate screen, soft-resets and turns mouse reporting
// off (DECSTR alone keeps both in xterm 6), restores the default palette, colors and cursor color
// (OSC 104/110/111/112) and line-feed mode, so a full-screen app that died cannot strand the view.
// The leading DECSC matters: xterm's ?1049l restores the saved cursor even when the normal screen
// is already active, which would jump to the top row and overwrite history.
const RECONNECTED =
  "\x1b7\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b]104\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07\x1b[?20l\r\n\x1b[2m── Reconnected ──\x1b[0m\r\n";
const methods = {
  close: "closeTerminal",
  reconnect: "reconnectTerminal",
  dismiss: "dismissTerminal",
} as const satisfies Record<LifecycleAction, string>;
const statuses = {
  connecting: "connecting",
  ready: "connected",
  closed: "disconnected",
  failed: "error",
} as const satisfies Record<TerminalPhase, ConnectionState>;
const faults = {
  stream: {
    title: "Terminal output was interrupted",
    description:
      "Output arrived out of order, so this view stopped updating instead of showing incomplete content.",
  },
  open: {
    title: "The terminal could not start",
    description: "The session did not accept this view. Its output is not shown.",
  },
} as const;
type Fault = keyof typeof faults;
interface Controls {
  term: Terminal;
  search: SearchAddon;
  /** Starts a session generation: stale frames are ignored and nothing queued carries over. */
  begin(generation: number): void;
  setReady(ready: boolean): void;
  resume(): void;
  /** Sends text through xterm's paste path only while this view accepts input. */
  paste(text: string): boolean;
  apply(settings: PaneSettings): void;
}

/** What a pane renders with: the saved settings after the scrollback cap and reduced motion. */
export interface PaneSettings {
  fontSize: number;
  scrollback: number;
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
}

/**
 * One xterm per logical session: a reconnect keeps its history but carries no input or stream state.
 * A hidden pane keeps its real size (never `display: none`) so it opens, streams and sees remote exits.
 */
export function LiveTerminal({
  owner,
  session,
  settings,
  active = false,
  hidden = false,
  style,
  actions,
}: {
  owner: Owner;
  session: TerminalSession;
  settings: PaneSettings;
  active?: boolean;
  hidden?: boolean;
  /** Position and size from the workspace layout. */
  style?: CSSProperties;
  /** Extra header controls, such as the pane menu. */
  actions?: ReactNode;
}) {
  const { sessionId, generation, phase, target } = session;
  const ready = phase === "ready";
  const ended = phase === "failed" || phase === "closed";
  const { windowId, generation: ownerGeneration } = owner;
  const pane = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<Controls | null>(null);
  // Read when the xterm is created; later changes go through apply().
  const initial = useRef(settings);
  const started = useRef(0);
  // After Reconnect, focus goes back to the terminal once a newer generation is Ready.
  const focusAfter = useRef<number>(undefined);
  const [connected, setConnected] = useState(0);
  if (ready && connected !== generation) setConnected(generation);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [size, setSize] = useState<{ columns: number; rows: number }>();
  const [fault, setFault] = useState<Fault>();
  const [inputPaused, setInputPaused] = useState(false);
  const [notice, setNotice] = useState<{ text: string }>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [results, setResults] = useState<SearchResults>();
  // Clearing decorations on close can still report results; a closed bar must not keep them.
  const searchVisible = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<PendingPaste>();

  // Keys typed after a tab switch must never reach a hidden pane, whatever `inert` does with focus.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (hidden && focused instanceof HTMLElement && pane.current?.contains(focused)) focused.blur();
  }, [hidden]);

  // A dialog that can no longer paste is closed rather than left with a disabled button.
  useEffect(() => {
    if (!pending || (ready && !inputPaused)) return;
    setPending(undefined);
    setNotice({
      text: ready ? "Input is paused; nothing was pasted." : "Not connected; nothing was pasted.",
    });
  }, [pending, ready, inputPaused]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const element = host.current;
    const bridge = window.ssterm;
    if (!element || !bridge) return;
    const owner = { windowId, generation: ownerGeneration };
    // StrictMode runs this twice; the first instance's font continuation must never open or bind.
    let cancelled = false;
    // Everything below is per generation and reset by begin(); 0 means none started yet.
    let current = 0;
    let live = false;
    let broken = false;
    let next = 0;
    const identity = () => ({ owner, sessionId, generation: current });
    const notify = (text: string) => {
      if (!cancelled) setNotice({ text });
    };
    // Web links and OSC 8 both land here; main validates the URL and asks before opening it.
    const openLink = (event: MouseEvent, url: string) => {
      if (cancelled || !isLinkActivation(event)) return;
      if (url.length > MAX_LINK_URL) {
        notify("Link not opened: it is longer than 2,048 characters.");
        return;
      }
      bridge.openLink({ owner, url }).then(
        (result) => {
          if (result.ok) return;
          notify(
            result.error.code === "invalid-request"
              ? "Link not opened: only http and https links without credentials can open."
              : "The link could not be opened.",
          );
        },
        () => notify("The link could not be opened."),
      );
    };
    const term = new Terminal({
      ...xtermOptions,
      fontSize: initial.current.fontSize,
      scrollback: initial.current.scrollback,
      cursorStyle: initial.current.cursorStyle,
      cursorBlink: initial.current.cursorBlink,
      disableStdin: true,
      linkHandler: { activate: openLink },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon(openLink));
    const search = new SearchAddon();
    term.loadAddon(search);
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (!cancelled && searchVisible.current) setResults({ index: resultIndex, count: resultCount });
    });
    term.attachCustomKeyEventHandler((event) => {
      if (terminalShortcut(event) !== "search") return true;
      event.preventDefault();
      if (!cancelled) {
        const input = searchInput.current;
        if (input) {
          input.focus();
          input.select();
        } else {
          searchVisible.current = true;
          setResults(undefined);
          setSearchOpen(true);
        }
      }
      return false;
    });

    const stopOutput = bridge.onTerminalOutput((frame) => {
      if (cancelled || broken || frame.sessionId !== sessionId || frame.generation !== current) return;
      if (frame.sequence !== next) {
        broken = true;
        setFault("stream");
        return;
      }
      next += 1;
      const bytes = frame.bytes.byteLength;
      const { generation } = frame;
      term.write(frame.bytes, () => {
        if (!cancelled) void bridge.ackTerminal({ owner, sessionId, generation, bytes });
      });
    });

    // Input is sent strictly in order. After any refused write nothing later is sent until the
    // user resumes, so the remote only ever sees a prefix of what was typed.
    const queue: Uint8Array[] = [];
    let queued = 0;
    let sending = false;
    let paused = false;
    const discard = () => {
      for (const chunk of queue) chunk.fill(0);
      queue.length = 0;
      queued = 0;
    };
    const pause = () => {
      paused = true;
      discard();
      if (cancelled) return;
      setInputPaused(true);
      // A "Pasted …" notice may already show for input that was just refused.
      setNotice(undefined);
    };
    const pump = async () => {
      if (sending) return;
      sending = true;
      while (queue.length > 0 && !cancelled && !paused) {
        const bytes = queue.shift()!;
        queued -= bytes.byteLength;
        const request = { ...identity(), bytes };
        const result = await bridge.writeTerminal(request).catch(() => undefined);
        bytes.fill(0);
        // A refusal for a generation that has since been replaced must not pause the new one.
        if (!result?.ok && request.generation === current) pause();
      }
      sending = false;
    };
    const send = (input: Uint8Array) => {
      if (cancelled || paused || !live || queued + input.byteLength > MAX_QUEUED_INPUT) {
        input.fill(0);
        if (!cancelled && !paused && live) pause();
        return;
      }
      for (let at = 0; at < input.byteLength; at += MAX_TERMINAL_WRITE)
        queue.push(input.subarray(at, at + MAX_TERMINAL_WRITE));
      queued += input.byteLength;
      void pump();
    };
    const encoder = new TextEncoder();
    term.onData((data) => send(encoder.encode(data)));
    term.onBinary((data) => send(Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff)));

    const report = () => {
      const columns = term.cols;
      const rows = term.rows;
      setSize((previous) =>
        previous?.columns === columns && previous.rows === rows ? previous : { columns, rows },
      );
    };
    term.onResize(({ cols: columns, rows }) => {
      report();
      if (live && columns <= MAX_TERMINAL_SIZE && rows <= MAX_TERMINAL_SIZE)
        void bridge.resizeTerminal({ ...identity(), columns, rows });
    });
    // A hidden workspace has no size; opening or fitting there would send a zero-sized PTY.
    const show = () => {
      if (cancelled || element.clientWidth === 0 || element.clientHeight === 0) return;
      const first = !term.element;
      if (first) term.open(element);
      fit.fit();
      report();
      if (first) setOpened(true);
    };
    let observer: ResizeObserver | undefined;
    void document.fonts
      .load(`${term.options.fontSize}px "JetBrains Mono Variable"`)
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return;
        observer = new ResizeObserver(show);
        observer.observe(element);
        show();
      });

    controls.current = {
      term,
      search,
      begin(generation) {
        if (generation === current) return;
        const reconnected = current !== 0;
        current = generation;
        live = false;
        broken = false;
        next = 0;
        paused = false;
        term.options.disableStdin = true;
        discard();
        if (reconnected) term.write(RECONNECTED);
        setFault(undefined);
        setInputPaused(false);
      },
      setReady(next) {
        live = next;
        term.options.disableStdin = !next;
      },
      resume() {
        paused = false;
        setInputPaused(false);
        term.focus();
      },
      paste(text) {
        if (cancelled || !live || paused) return false;
        term.paste(text);
        // term.paste sends synchronously, so a refused queue has already paused input here.
        return !paused;
      },
      apply(next) {
        term.options.fontSize = next.fontSize;
        term.options.scrollback = next.scrollback;
        term.options.cursorStyle = next.cursorStyle;
        term.options.cursorBlink = next.cursorBlink;
        // A new font size changes the cell size without resizing the element, so nothing else refits.
        if (term.element) show();
      },
    };
    return () => {
      cancelled = true;
      if (controls.current?.term === term) controls.current = null;
      stopOutput();
      observer?.disconnect();
      discard();
      term.dispose();
    };
  }, [windowId, ownerGeneration, sessionId]);

  const { fontSize, scrollback, cursorStyle, cursorBlink } = settings;
  useEffect(() => {
    initial.current = { fontSize, scrollback, cursorStyle, cursorBlink };
    controls.current?.apply(initial.current);
  }, [fontSize, scrollback, cursorStyle, cursorBlink]);

  // Must run before the open effect below, so a new generation starts clean before it is opened.
  useEffect(() => {
    controls.current?.begin(generation);
  }, [windowId, ownerGeneration, sessionId, generation]);

  useEffect(() => {
    const current = controls.current;
    const bridge = window.ssterm;
    if (!opened || !current || !bridge) return;
    current.setReady(ready);
    if (ready && focusAfter.current !== undefined && generation > focusAfter.current) {
      focusAfter.current = undefined;
      const active = document.activeElement;
      // Only if the user has not moved on to something else while it connected.
      if (!active || active === document.body || pane.current?.contains(active)) current.term.focus();
    }
    if (!ready || started.current === generation) return;
    started.current = generation;
    const identity = { owner: { windowId, generation: ownerGeneration }, sessionId, generation };
    const { cols: columns, rows } = current.term;
    let stale = false;
    void (async () => {
      if (columns <= MAX_TERMINAL_SIZE && rows <= MAX_TERMINAL_SIZE)
        await bridge.resizeTerminal({ ...identity, columns, rows });
      if (stale) return;
      const result = await bridge.openTerminal(identity);
      if (!result.ok && !stale) setFault("open");
    })().catch(() => { if (!stale) setFault("open"); });
    return () => { stale = true; };
  }, [opened, ready, windowId, ownerGeneration, sessionId, generation]);

  const endpoint = target
    ? endpointText(target.endpointHost, target.endpointPort, target.username)
    : null;
  const label = target?.label ?? "Unknown target";
  const production = target?.environment === "PROD";
  const notify = (text: string) => setNotice({ text });
  const outcome = terminalOutcome(session, connected === generation);
  const inTerminal = (node: EventTarget) =>
    !!controls.current?.term.element?.contains(node as Node);

  // Capture phase at the React root runs before xterm's own textarea listener, so unsanitized
  // clipboard text never reaches xterm.
  const interceptPaste = (event: ClipboardEvent<HTMLElement>) => {
    const current = controls.current;
    if (!current || !inTerminal(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!ready || inputPaused) {
      notify(inputPaused ? "Input is paused; nothing was pasted." : "Not connected; nothing was pasted.");
      return;
    }
    const { text, removed } = sanitizePaste(event.clipboardData.getData("text/plain"));
    const bracketed = current.term.modes.bracketedPasteMode;
    const decision = pasteDecision({ text, removed, bracketed, production });
    if (decision.kind === "empty") {
      if (removed) notify("The clipboard held only control characters; nothing was pasted.");
    } else if (decision.kind === "refuse") {
      notify("Paste refused: the text is larger than 256 KiB. Nothing was sent.");
    } else if (decision.kind === "confirm") {
      setPending({ text, lines: decision.lines, removed, bracketed, label, endpoint, production, generation });
    } else if (current.paste(text)) {
      notify(`Pasted ${lineCount(decision.lines)} into ${label}`);
    }
  };
  // The shell can leave bracketed paste while the dialog is open; ask again with the real risk.
  const confirmPaste = () => {
    if (!pending) return;
    if (pending.generation !== generation) {
      setPending(undefined);
      notify("Not pasted: the session reconnected since you pasted.");
      return;
    }
    const term = controls.current?.term;
    if (pending.bracketed && term && !term.modes.bracketedPasteMode && hasNewline(pending.text)) {
      setPending({ ...pending, bracketed: false });
      return;
    }
    setPending(undefined);
    notify(
      controls.current?.paste(pending.text)
        ? `Pasted ${lineCount(pending.lines)} into ${pending.label}`
        : "Not pasted: this session no longer accepts input.",
    );
  };
  // `detail` is the click count (0 from the keyboard). Cancel/Disconnect and Close pane occupy the same
  // spot, so the second click of a double click must not close a pane that appeared under the pointer.
  const act = (action: LifecycleAction, detail = 0) => {
    const bridge = window.ssterm;
    if (!bridge || busy || (action !== "reconnect" && detail > 1)) return;
    setBusy(true);
    if (action === "reconnect") focusAfter.current = generation;
    const fail = (text: string) => {
      if (action === "reconnect") focusAfter.current = undefined;
      notify(text);
    };
    bridge[methods[action]]({ owner: { windowId, generation: ownerGeneration }, sessionId, generation })
      .then(
        (result) => {
          if (!result.ok) fail(lifecycleFailure(action, result.error.code, session.error === "locked"));
          // The keyboard-activated button is replaced by the next phase's button; keep focus in this pane.
          else if (action === "close" && detail === 0) controls.current?.term.focus();
        },
        () => fail(lifecycleFailure(action, "unavailable")),
      )
      .finally(() => setBusy(false));
  };
  const reportCopy = (event: ClipboardEvent<HTMLElement>) => {
    const term = controls.current?.term;
    if (!term?.hasSelection() || !inTerminal(event.target)) return;
    const characters = [...term.getSelection()].length;
    notify(`Copied ${characters} ${characters === 1 ? "character" : "characters"}`);
  };
  const find = (query: string, direction: SearchDirection, incremental = false) => {
    const search = controls.current?.search;
    if (!search) return;
    if (!query) {
      search.clearDecorations();
      setResults(undefined);
      return;
    }
    const options = { decorations: terminalSearchDecorations, incremental };
    if (direction === "previous") search.findPrevious(query, options);
    else search.findNext(query, options);
  };
  const closeSearch = () => {
    controls.current?.search.clearDecorations();
    searchVisible.current = false;
    setSearchOpen(false);
    setResults(undefined);
    controls.current?.term.focus();
  };

  return (
    <section
      ref={pane}
      className="terminal-pane live-terminal-pane"
      inert={hidden}
      data-active={active || undefined}
      onPasteCapture={interceptPaste}
      onCopy={reportCopy}
      aria-label={`Terminal for ${label}`}
      data-session-id={sessionId}
      data-phase={phase}
      data-generation={generation}
      data-columns={size?.columns}
      data-rows={size?.rows}
      style={{ ...terminalStyle, ...style, visibility: hidden ? "hidden" : undefined }}
    >
      <SessionHeader
        target={target}
        phase={phase}
        outcome={outcome}
        busy={busy}
        actions={actions}
        onAction={act}
        onNotify={notify}
      />
      {ended ? (
        <div className="live-terminal-notice">
          {/* The header status line announces the outcome; this offers the next step without interrupting. */}
          <Alert role={undefined} className="has-data-[slot=alert-action]:pr-30" variant={phase === "failed" ? "destructive" : "default"}>
            {phase === "failed" ? <TriangleAlertIcon aria-hidden="true" /> : <CircleIcon aria-hidden="true" />}
            <AlertTitle>{connected ? "History is kept in this pane." : "Nothing was received in this pane."}</AlertTitle>
            <AlertDescription>Reconnect starts a new session. Nothing typed earlier is sent again.</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act("reconnect")}>
                <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
                Reconnect
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}
      {fault ? (
        <div className="live-terminal-notice">
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>{faults[fault].title}</AlertTitle>
            <AlertDescription>{faults[fault].description}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {inputPaused && ready ? (
        <div className="live-terminal-notice">
          <Alert>
            <TriangleAlertIcon aria-hidden="true" />
            <AlertTitle>Input was not delivered.</AlertTitle>
            <AlertDescription>Later keystrokes are paused.</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => controls.current?.resume()}>
                Resume input
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : null}
      {/* Search and feedback float over the frame: changing the layout would resize the PTY. */}
      <div className="live-terminal-frame">
        <div ref={host} className="live-terminal" />
        {searchOpen ? (
          <TerminalSearchBar
            label={label}
            inputRef={searchInput}
            results={results}
            onFind={find}
            onClose={closeSearch}
          />
        ) : null}
        <div role="status" className="live-terminal-feedback" data-testid="terminal-feedback">
          {notice ? <span className="type-caption">{notice.text}</span> : null}
        </div>
      </div>
      <PasteConfirmDialog
        pending={pending}
        canPaste={ready && !inputPaused}
        returnFocus={() => controls.current?.term.textarea ?? null}
        onCancel={() => setPending(undefined)}
        onConfirm={confirmPaste}
      />
    </section>
  );
}

/**
 * The pane header shared by terminal and SFTP panes: `[name · endpoint] [PROD] [state] [outcome] [Copy
 * target] [extra actions] [Cancel | Disconnect | Close pane]`, compacted by the pane's container queries.
 */
export function SessionHeader({
  target,
  phase,
  outcome,
  busy,
  actions,
  onAction,
  onNotify,
}: {
  target: TerminalSession["target"];
  phase: TerminalPhase;
  outcome: string | null;
  busy: boolean;
  actions?: ReactNode;
  /** `detail` is the click count, 0 from the keyboard. */
  onAction(action: LifecycleAction, detail: number): void;
  onNotify(text: string): void;
}) {
  const endpoint = target ? endpointText(target.endpointHost, target.endpointPort, target.username) : null;
  const label = target?.label ?? "Unknown target";
  const fullTarget = endpoint ?? label;
  const copyTarget = () =>
    onNotify(copyText(fullTarget) ? `Copied ${fullTarget}` : "The target could not be copied.");
  return (
    <div className="pane-header flex h-8 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-card px-2">
      <Tooltip>
        <TooltipTrigger render={<span tabIndex={0} className="host-identity min-w-0 flex-1 basis-0" />}>
          <span className="type-label truncate">{label}</span>
          {endpoint ? <span className="host-target truncate">{endpoint}</span> : null}
        </TooltipTrigger>
        <TooltipContent>
          <span className="break-all select-text">{endpoint ? `${label} · ${endpoint}` : label}</span>
        </TooltipContent>
      </Tooltip>
      {target?.environment === "PROD" ? <Badge variant="production" className="pane-badge">PROD</Badge> : null}
      <ConnectionStatus state={statuses[phase]} />
      <span role="status" className="pane-outcome type-caption min-w-0 shrink truncate text-muted-foreground" title={outcome ?? undefined}>
        {outcome}
      </span>
      <div className="pane-actions flex shrink-0 items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="Copy target" title={`Copy ${fullTarget}`} onClick={copyTarget}>
          <CopyIcon aria-hidden="true" />
        </Button>
        {actions}
        {/* Distinct keys: a phase change mounts a new button rather than relabelling a focused or pressed one. */}
        {phase === "connecting" ? (
          <PaneAction key="cancel" label="Cancel" icon={BanIcon} variant="outline" disabled={busy} onClick={(detail) => onAction("close", detail)} />
        ) : phase === "ready" ? (
          <PaneAction key="disconnect" label="Disconnect" icon={UnplugIcon} variant="outline" disabled={busy} onClick={(detail) => onAction("close", detail)} />
        ) : (
          <PaneAction key="dismiss" label="Close pane" icon={XIcon} variant="ghost" disabled={busy} onClick={(detail) => onAction("dismiss", detail)} />
        )}
      </div>
    </div>
  );
}

/** A narrow pane shows only the icon (CSS); the text stays the accessible name and the title shows it. */
function PaneAction({
  label,
  icon: Icon,
  variant,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof XIcon;
  variant: "outline" | "ghost";
  disabled: boolean;
  onClick(detail: number): void;
}) {
  return (
    <Button size="sm" variant={variant} className="pane-action" title={label} disabled={disabled} onClick={(event) => onClick(event.detail)}>
      <Icon data-icon="inline-start" aria-hidden="true" />
      <span className="pane-action-text">{label}</span>
    </Button>
  );
}
