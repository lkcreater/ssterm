import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { TriangleAlertIcon } from "lucide-react";
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
import {
  terminalSearchDecorations,
  terminalStyle,
  xtermOptions,
} from "@/lib/terminal-theme";

const NOTICE_MS = 4000;
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
  setReady(ready: boolean): void;
  resume(): void;
  /** Sends text through xterm's paste path only while this view accepts input. */
  paste(text: string): boolean;
}

/** Remote outcomes stay distinct from a local close or a lost connection. */
export function outcome(session: TerminalSession): string | null {
  const end = session.end;
  if (end?.kind === "exit") return `Remote process exited with status ${end.code}`;
  if (end?.kind === "signal") return `Remote process was terminated by ${end.signal}`;
  if (end?.kind === "eof") return "The remote end closed the session";
  if (session.phase === "closed") return "Session closed";
  if (session.phase === "failed") return "Connection failed";
  return null;
}

/** Every owner session stays mounted, even while another page is shown, so its stream keeps flowing. */
export function TerminalWorkspace({
  owner,
  sessions,
  hidden,
}: {
  owner: Owner;
  sessions: TerminalSession[];
  hidden: boolean;
}) {
  return (
    <div className="terminal-workspace" hidden={hidden}>
      {sessions.map((session) => (
        <LiveTerminal
          key={`${session.sessionId}:${session.generation}`}
          owner={owner}
          session={session}
        />
      ))}
    </div>
  );
}

/** One xterm instance per session generation; a reconnect mounts a new one with no carried input. */
function LiveTerminal({
  owner,
  session,
}: {
  owner: Owner;
  session: TerminalSession;
}) {
  const { sessionId, generation, phase, target } = session;
  const ready = phase === "ready";
  const { windowId, generation: ownerGeneration } = owner;
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<Controls | null>(null);
  const started = useRef(false);
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
    const identity = { owner: { windowId, generation: ownerGeneration }, sessionId, generation };
    // StrictMode runs this twice; the first instance's font continuation must never open or bind.
    let cancelled = false;
    let live = false;
    let broken = false;
    let next = 0;
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
      bridge.openLink({ owner: identity.owner, url }).then(
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
      if (cancelled || broken || frame.sessionId !== sessionId || frame.generation !== generation) return;
      if (frame.sequence !== next) {
        broken = true;
        setFault("stream");
        return;
      }
      next += 1;
      const bytes = frame.bytes.byteLength;
      term.write(frame.bytes, () => {
        if (!cancelled) void bridge.ackTerminal({ ...identity, bytes });
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
        const result = await bridge.writeTerminal({ ...identity, bytes }).catch(() => undefined);
        bytes.fill(0);
        if (!result?.ok) pause();
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
        void bridge.resizeTerminal({ ...identity, columns, rows });
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
      .load(`${xtermOptions.fontSize}px "JetBrains Mono Variable"`)
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
    };
    return () => {
      cancelled = true;
      if (controls.current?.term === term) controls.current = null;
      stopOutput();
      observer?.disconnect();
      discard();
      term.dispose();
    };
  }, [windowId, ownerGeneration, sessionId, generation]);

  useEffect(() => {
    const current = controls.current;
    const bridge = window.ssterm;
    if (!opened || !current || !bridge) return;
    current.setReady(ready);
    if (!ready || started.current) return;
    started.current = true;
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
    ? `${target.username ? `${target.username}@` : ""}${target.endpointHost}:${target.endpointPort}`
    : null;
  const label = target?.label ?? "Unknown target";
  const production = target?.environment === "PROD";
  const notify = (text: string) => setNotice({ text });
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
      setPending({ text, lines: decision.lines, removed, bracketed, label, endpoint, production });
    } else if (current.paste(text)) {
      notify(`Pasted ${lineCount(decision.lines)} into ${label}`);
    }
  };
  // The shell can leave bracketed paste while the dialog is open; ask again with the real risk.
  const confirmPaste = () => {
    if (!pending) return;
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
      className="terminal-pane live-terminal-pane"
      onPasteCapture={interceptPaste}
      onCopy={reportCopy}
      aria-label={`Terminal for ${label}`}
      data-phase={phase}
      data-generation={generation}
      data-columns={size?.columns}
      data-rows={size?.rows}
      style={terminalStyle}
    >
      <div className="terminal-context">
        <div className="host-identity">
          <span className="type-label truncate">{label}</span>
          {endpoint ? <span className="host-target truncate">{endpoint}</span> : null}
          {production ? <Badge variant="production">PROD</Badge> : null}
        </div>
        <ConnectionStatus state={statuses[phase]} />
        <span role="status" className="type-caption text-muted-foreground">
          {outcome(session)}
        </span>
      </div>
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
