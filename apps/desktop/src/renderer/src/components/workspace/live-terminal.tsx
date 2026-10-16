import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TriangleAlertIcon } from "lucide-react";
import {
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
import { terminalStyle, xtermOptions } from "@/lib/terminal-theme";

const MAX_QUEUED_INPUT = MAX_TERMINAL_WRITE * 4;
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
  setReady(ready: boolean): void;
  resume(): void;
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
    const term = new Terminal({ ...xtermOptions, disableStdin: true });
    const fit = new FitAddon();
    term.loadAddon(fit);

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
      if (!cancelled) setInputPaused(true);
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
      setReady(next) {
        live = next;
        term.options.disableStdin = !next;
      },
      resume() {
        paused = false;
        setInputPaused(false);
        term.focus();
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
  return (
    <section
      className="terminal-pane live-terminal-pane"
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
          {target?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
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
      <div className="live-terminal-frame">
        <div ref={host} className="live-terminal" />
      </div>
    </section>
  );
}
