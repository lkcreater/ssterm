import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPasteIcon, LayersIcon, PlayIcon, SearchIcon, TextCursorInputIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { CatalogSnippet, CatalogState, Owner, TerminalSession } from "@ssterm/contracts";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ConnectionStatus } from "@/components/connection/connection-status";
import { call } from "@/components/identities/secret-input";
import { protectionNotice, requestNotice } from "@/components/snippets/snippets-page";
import { TerminalInputsContext } from "@/components/workspace/terminal-inputs";
import { endpointText } from "@/lib/catalog-filter";
import { filterSnippets } from "@/lib/snippet-filter";
import { linesText, planDispatch, type ConfirmReason, type DispatchMode, type DispatchPlan } from "@/lib/snippet-dispatch";

/** The session an action was invoked for; later focus changes never redirect it. */
interface Captured {
  sessionId: string;
  generation: number;
  label: string;
  production: boolean;
  endpoint: string | null;
}
type SendPlan = Extract<DispatchPlan, { bytes: Uint8Array }>;
type Feedback = { tone: "sent" | "problem"; text: string };
type Confirm = { captured: Captured; text: string; mode: DispatchMode; plan: SendPlan; fromComposer: boolean };

const phases = { connecting: "connecting", ready: "connected", closed: "disconnected", failed: "error" } as const;
const NO_TARGET = "No connected terminal is active. Nothing was sent.";
const reasonText: Record<ConfirmReason, string> = {
  production: "This is a PROD server.",
  removed: "Control characters were removed from the text.",
  "line-by-line": "The shell is not in bracketed-paste mode, so each line runs as soon as it arrives.",
};

function capture(session: TerminalSession | undefined): Captured | undefined {
  if (!session || session.phase !== "ready") return undefined;
  const target = session.target;
  return {
    sessionId: session.sessionId,
    generation: session.generation,
    label: target?.label ?? "Unknown target",
    production: target?.environment === "PROD",
    endpoint: target ? endpointText(target.endpointHost, target.endpointPort, target.username) : null,
  };
}

function Target({ session, captured }: { session?: TerminalSession; captured?: Captured }) {
  const label = captured?.label ?? session?.target?.label;
  const production = captured ? captured.production : session?.target?.environment === "PROD";
  const endpoint = captured?.endpoint ??
    (session?.target ? endpointText(session.target.endpointHost, session.target.endpointPort, session.target.username) : null);
  if (!label) return <span className="text-sm text-muted-foreground">No active terminal</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {session ? <ConnectionStatus state={phases[session.phase]} /> : null}
      <span className="min-w-0 truncate font-medium" title={label}>{label}</span>
      {production ? <Badge variant="production">PROD</Badge> : null}
      {endpoint ? <span className="host-target min-w-0 truncate" title={endpoint}>{endpoint}</span> : null}
    </span>
  );
}

/**
 * Snippet Paste and Run for the terminal workspace. Paste only fills the composer; bytes leave only from an
 * explicit Run or Insert, to the session captured when that action was invoked.
 */
export function SnippetPanel({
  owner,
  state,
  active,
  sessions,
  onClose,
}: {
  owner: Owner;
  state: CatalogState;
  /** The workspace's active pane session, read again at every action. */
  active?: TerminalSession;
  sessions: TerminalSession[];
  onClose(): void;
}) {
  const inputs = useContext(TerminalInputsContext);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [composer, setComposer] = useState<{ captured: Captured; text: string; label: string }>();
  const [confirm, setConfirm] = useState<Confirm>();
  const searchInput = useRef<HTMLInputElement>(null);
  // `epoch` follows the clearing effect; `latest` is read during render so a decrypt resolving just after a lock sees it.
  const epoch = useRef(state.lockEpoch);
  const latest = useRef(state.lockEpoch);
  latest.current = state.lockEpoch;
  // Synchronous guard: a double click must not send twice.
  const sending = useRef(false);
  const [inFlight, setInFlight] = useState(false);
  const shown = useMemo(() => filterSnippets(state.snippets, state.tags, search), [state.snippets, state.tags, search]);
  const tags = useMemo(() => new Map(state.tags.map((tag) => [tag.id, tag.label])), [state.tags]);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => searchInput.current?.focus(), []);
  // A lock drops the decrypted composer text and any pending confirmation.
  useEffect(() => {
    if (state.lockEpoch === epoch.current) return;
    epoch.current = state.lockEpoch;
    setComposer(undefined);
    setConfirm((current) => { current?.plan.bytes.fill(0); return undefined; });
    setBusy(undefined);
    setFeedback({ tone: "problem", text: "The workspace locked. Pending input was cleared and nothing was sent." });
  }, [state.lockEpoch]);

  const problem = (text: string) => setFeedback({ tone: "problem", text });
  /** Decrypts for this explicit action only; undefined after reporting why not, or if a lock arrived meanwhile. */
  async function body(snippet: CatalogSnippet): Promise<string | undefined> {
    const since = latest.current;
    const result = await call((bridge) => bridge.openSnippet({ owner, snippetId: snippet.id, expectedRevision: snippet.revision }));
    if (latest.current !== since) return undefined;
    if (!result.ok) {
      const notice = requestNotice(result.error.code, "opened");
      return void problem(`${notice.title}. ${notice.text}`);
    }
    if (result.value.status !== "open") {
      const notice = protectionNotice(result.value);
      return void problem(`${notice.title}. ${notice.text}`);
    }
    return result.value.body;
  }

  async function deliver(captured: Captured, plan: SendPlan, mode: DispatchMode, fromComposer: boolean) {
    if (sending.current) return plan.bytes.fill(0), undefined;
    sending.current = true;
    setInFlight(true);
    const handle = inputs?.get(captured.sessionId);
    const result = await (handle ? handle.deliver(plan.bytes, captured.generation) : Promise.resolve("refused" as const))
      .finally(() => {
        sending.current = false;
        setInFlight(false);
      });
    plan.bytes.fill(0);
    if (result !== "sent") return problem(`Not sent: ${captured.label} did not accept input. Nothing more was sent.`);
    if (fromComposer) setComposer(undefined);
    setFeedback({
      tone: "sent",
      text: `${mode === "run" ? "Sent and pressed Enter" : "Inserted"}: ${linesText(plan.lines)} to ${captured.label}. ssterm cannot tell whether the command succeeded.`,
    });
  }

  /** Plans against the captured pane's current state; asks first when the plan says so. */
  async function dispatch(captured: Captured, text: string, mode: DispatchMode, fromComposer: boolean, confirmed?: ConfirmReason[]) {
    if (sending.current) return;
    const handle = inputs?.get(captured.sessionId);
    if (!handle || handle.generation !== captured.generation || !handle.accepting())
      return problem(`Not sent: ${captured.label} is no longer connected or is not accepting input.`);
    const plan = planDispatch({ text, mode, bracketed: handle.bracketed(), production: captured.production });
    if (plan.kind === "empty") return problem("This snippet is empty. Nothing was sent.");
    if (plan.kind === "refuse") return problem("Not sent: the text is larger than 256 KiB.");
    if (plan.kind === "confirm" && !plan.reasons.every((reason) => confirmed?.includes(reason))) {
      setConfirm({ captured, text, mode, plan, fromComposer });
      return;
    }
    // Planned bytes are rebuilt from the text at every attempt; a superseded confirmation's copy is wiped.
    await deliver(captured, plan, mode, fromComposer);
  }
  const dropConfirm = () => setConfirm((current) => { current?.plan.bytes.fill(0); return undefined; });

  async function act(snippet: CatalogSnippet, mode: "paste" | "run") {
    if (busy) return;
    // Captured now: switching panes while the body decrypts cannot redirect it.
    const captured = capture(activeRef.current);
    if (!captured) return problem(NO_TARGET);
    setBusy(`${snippet.id}:${mode}`);
    setFeedback(undefined);
    try {
      const text = await body(snippet);
      if (text === undefined) return;
      if (mode === "run") return await dispatch(captured, text, "run", false);
      if (text.length === 0) return problem("This snippet is empty. Nothing was pasted or sent.");
      setComposer({ captured, text, label: snippet.label });
    } finally {
      setBusy(undefined);
    }
  }

  const composerSession = composer && sessions.find((row) => row.sessionId === composer.captured.sessionId);
  const composerLive = composerSession?.phase === "ready" && composerSession.generation === composer?.captured.generation;
  return (
    <aside
      className="snippet-panel"
      aria-label="Snippets"
      data-testid="snippet-panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || confirm) return;
        // Esc first clears a filled search box, as a search field does.
        if (event.target === searchInput.current && search) return setSearch("");
        event.preventDefault();
        onClose();
      }}
    >
      <div className="flex items-center gap-2">
        <LayersIcon className="size-4 shrink-0" aria-hidden="true" />
        <h2 className="type-label">Snippets</h2>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Close snippets" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-1" data-testid="snippet-target">
        <span className="type-caption text-muted-foreground">Active terminal</span>
        <Target session={active} />
      </div>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchInput}
          type="search"
          aria-label="Search snippets to send"
          placeholder="Search names and tags"
          value={search}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setSearch(event.target.value)}
        />
      </InputGroup>
      {state.snippets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No snippets yet. Create them on the Snippets page.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No snippets match. Search looks at names and tags.</p>
      ) : (
        <ul className="snippet-panel-list" aria-label="Snippets to send">
          {shown.map((snippet) => (
            <li key={snippet.id} className="snippet-panel-row" data-snippet-id={snippet.id}>
              <span className="grid min-w-0 gap-1">
                <span className="truncate font-medium" title={snippet.label}>{snippet.label}</span>
                {snippet.tagIds.length ? (
                  <span className="truncate type-caption text-muted-foreground">
                    {snippet.tagIds.map((id) => tags.get(id)).filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button size="sm" variant="outline" disabled={!!busy} aria-label={`Paste ${snippet.label} to composer`} onClick={() => void act(snippet, "paste")}>
                  {busy === `${snippet.id}:paste` ? <Spinner data-icon="inline-start" /> : <ClipboardPasteIcon data-icon="inline-start" />}Paste
                </Button>
                <Button size="sm" disabled={!!busy} aria-label={`Run ${snippet.label}`} onClick={() => void act(snippet, "run")}>
                  {busy === `${snippet.id}:run` ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}Run
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {composer ? (
        <section className="snippet-panel-composer" aria-label="Pending input" data-testid="snippet-composer">
          <div className="grid gap-1">
            <h3 className="type-label">Pending input · not sent</h3>
            <span className="type-caption text-muted-foreground">From {composer.label}. Sends only to:</span>
            <Target session={composerSession} captured={composer.captured} />
            {active?.sessionId !== composer.captured.sessionId ? (
              <span className="type-caption text-muted-foreground">This is not the active terminal.</span>
            ) : null}
          </div>
          <textarea
            className="snippet-body"
            aria-label="Pending input text"
            rows={6}
            wrap="off"
            value={composer.text}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setComposer({ ...composer, text: event.target.value })}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!composerLive || inFlight} onClick={() => void dispatch(composer.captured, composer.text, "run", true)}>
              <PlayIcon data-icon="inline-start" /> Run
            </Button>
            <Button size="sm" variant="outline" disabled={!composerLive || inFlight} onClick={() => void dispatch(composer.captured, composer.text, "insert", true)}>
              <TextCursorInputIcon data-icon="inline-start" /> Insert without Enter
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setComposer(undefined); setFeedback(undefined); }}>
              Discard
            </Button>
          </div>
          {composerLive ? null : (
            <span className="type-caption">{composer.captured.label} is no longer connected. Nothing can be sent from here.</span>
          )}
        </section>
      ) : null}
      <p role="status" className="snippet-panel-feedback" data-tone={feedback?.tone} data-testid="snippet-feedback">
        {feedback?.tone === "problem" ? <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
        <span>{feedback?.text ?? ""}</span>
      </p>
      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) dropConfirm(); }}>
        {confirm ? (
          <AlertDialogContent className="[overflow-wrap:anywhere] motion-reduce:animate-none" data-testid="snippet-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm.mode === "run" ? "Run" : "Insert"} {linesText(confirm.plan.lines)} on {confirm.captured.label}?
              </AlertDialogTitle>
              <AlertDialogDescription render={<div />} className="grid gap-2">
                <Target captured={confirm.captured} />
                {confirm.plan.reasons.map((reason) => <span key={reason}>{reasonText[reason]}</span>)}
                <span>Sending does not confirm that the command succeeded.</span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="outline" autoFocus onClick={dropConfirm}>Cancel</Button>
              <Button
                variant={confirm.captured.production ? "destructive" : "default"}
                disabled={inFlight}
                onClick={() => {
                  const current = confirm;
                  dropConfirm();
                  void dispatch(current.captured, current.text, current.mode, current.fromComposer, current.plan.reasons);
                }}
              >
                {confirm.mode === "run" ? "Run" : "Insert"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </aside>
  );
}
