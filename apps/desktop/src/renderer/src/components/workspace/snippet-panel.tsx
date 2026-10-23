import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPasteIcon, PlayIcon, SearchIcon, TextCursorInputIcon, TriangleAlertIcon } from "lucide-react";
import type { CatalogSnippet, CatalogState, Owner, TerminalSession } from "@ssterm/contracts";
import { Drawer, firstUsable, useDrawerClose } from "@/components/drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ConnectionStatus } from "@/components/connection/connection-status";
import { call } from "@/components/identities/secret-input";
import { protectionNotice, requestNotice } from "@/components/snippets/snippets-page";
import { TerminalInputsContext } from "@/components/workspace/terminal-inputs";
import { captureTerminalTarget } from "@/lib/terminal-target";
import { filterSnippets } from "@/lib/snippet-filter";
import { cn } from "@/lib/utils";
import { linesText, planDispatch, type ConfirmReason, type DispatchMode, type DispatchPlan } from "@/lib/snippet-dispatch";

/** The session the drawer was opened for; later tab or pane changes never redirect it. */
type Captured = NonNullable<ReturnType<typeof captureTerminalTarget>>;
type SendPlan = Extract<DispatchPlan, { bytes: Uint8Array }>;
type Feedback = { tone: "sent" | "problem"; text: string };
type Confirm = { text: string; mode: DispatchMode; plan: SendPlan; fromComposer: boolean };

const phases = { connecting: "connecting", ready: "connected", closed: "disconnected", failed: "error" } as const;
const NO_TARGET = "No connected terminal is active. Nothing was sent.";
const reasonText: Record<ConfirmReason, string> = {
  production: "This is a PROD server.",
  removed: "Control characters were removed from the text.",
  "line-by-line": "The shell is not in bracketed-paste mode, so each line runs as soon as it arrives.",
};

function Target({ captured, phase }: { captured?: Captured; phase?: keyof typeof phases }) {
  if (!captured) return <span className="text-sm">No connected terminal. Nothing can be sent.</span>;
  const { label, production, endpoint, local } = captured;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {phase ? <ConnectionStatus state={phases[phase]} /> : null}
      <span className="min-w-0 truncate font-medium text-foreground" title={label}>{label}</span>
      {local ? <Badge variant="secondary">LOCAL</Badge> : null}
      {production ? <Badge variant="production">PROD</Badge> : null}
      {endpoint ? <span className="host-target min-w-0 truncate" title={endpoint}>{endpoint}</span> : null}
    </span>
  );
}

/**
 * Snippet Paste and Run as a drawer. The target is the active pane captured when the drawer opens and shown in its
 * header; switching tabs or panes afterwards never changes it. Paste only fills the composer; bytes leave only from
 * an explicit Run or Insert, and a confirmation (PROD, line-by-line, removed controls) is a step inside the drawer.
 * The caller mounts it per open (keyed), so a reopen captures afresh.
 */
export function SnippetPanel({
  owner,
  state,
  active,
  sessions,
  returnFocus,
  onClose,
}: {
  owner: Owner;
  state: CatalogState;
  /** The workspace's active pane session: captured once at mount, then only compared against. */
  active?: TerminalSession;
  sessions: TerminalSession[];
  returnFocus(): HTMLElement | null;
  /** After the exit motion. */
  onClose(): void;
}) {
  const inputs = useContext(TerminalInputsContext);
  const [target] = useState(() => captureTerminalTarget(active));
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [composer, setComposer] = useState<{ text: string; label: string }>();
  const [confirm, setConfirm] = useState<Confirm>();
  const searchInput = useRef<HTMLInputElement>(null);
  const composerBox = useRef<HTMLElement>(null);
  const stepCancel = useRef<HTMLButtonElement>(null);
  // Where focus returns when the confirmation step ends.
  const resume = useRef<HTMLElement | null>(null);
  // `epoch` follows the clearing effect; `latest` is read during render so a decrypt resolving just after a lock sees it.
  const epoch = useRef(state.lockEpoch);
  const latest = useRef(state.lockEpoch);
  latest.current = state.lockEpoch;
  // Synchronous guard: a double click must not send twice.
  const sending = useRef(false);
  const [inFlight, setInFlight] = useState(false);
  const shown = useMemo(() => filterSnippets(state.snippets, state.tags, search), [state.snippets, state.tags, search]);
  const tags = useMemo(() => new Map(state.tags.map((tag) => [tag.id, tag.label])), [state.tags]);
  const close = useDrawerClose({ dirty: !!composer, busy: !!busy || inFlight });

  /** Moves focus out of the composer first, so it never falls to the page when the composer goes. */
  const clearComposer = () => {
    if (composerBox.current?.contains(document.activeElement)) searchInput.current?.focus();
    setComposer(undefined);
  };
  const dropConfirm = () => setConfirm((current) => { current?.plan.bytes.fill(0); return undefined; });
  const confirming = !!confirm;
  useEffect(() => {
    if (confirming) return stepCancel.current?.focus();
    const back = resume.current;
    resume.current = null;
    // A confirmed send disables the button that opened the step: fall back to the search box.
    const target = back && firstUsable(back, searchInput.current);
    if (target && target !== true) target.focus();
  }, [confirming]);
  // A lock drops the decrypted composer text and any pending confirmation.
  useEffect(() => {
    if (state.lockEpoch === epoch.current) return;
    epoch.current = state.lockEpoch;
    clearComposer();
    dropConfirm();
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
    if (result === "partial")
      return problem(`Partly sent: ${captured.label} took the text up to the first line break (an agent command's password prompt); the rest was not sent.`);
    if (result !== "sent") return problem(`Not sent: ${captured.label} did not accept input. Nothing more was sent.`);
    if (fromComposer) clearComposer();
    setFeedback({
      tone: "sent",
      text: `${mode === "run" ? "Sent and pressed Enter" : "Inserted"}: ${linesText(plan.lines)} to ${captured.label}. ssterm cannot tell whether the command succeeded.`,
    });
  }

  /** Plans against the captured pane's current state; asks first (a step in this drawer) when the plan says so. */
  async function dispatch(text: string, mode: DispatchMode, fromComposer: boolean, confirmed?: ConfirmReason[]) {
    if (sending.current) return;
    if (!target) return problem(NO_TARGET);
    const handle = inputs?.get(target.sessionId);
    if (!handle || handle.generation !== target.generation || !handle.accepting())
      return problem(`Not sent: ${target.label} is no longer connected or is not accepting input.`);
    const plan = planDispatch({ text, mode, bracketed: handle.bracketed(), production: target.production });
    if (plan.kind === "empty") return problem("This snippet is empty. Nothing was sent.");
    if (plan.kind === "refuse") return problem("Not sent: the text is larger than 256 KiB.");
    if (plan.kind === "confirm" && !plan.reasons.every((reason) => confirmed?.includes(reason))) {
      resume.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirm({ text, mode, plan, fromComposer });
      return;
    }
    // Planned bytes are rebuilt from the text at every attempt; a superseded confirmation's copy is wiped.
    await deliver(target, plan, mode, fromComposer);
  }

  async function act(snippet: CatalogSnippet, mode: "paste" | "run") {
    if (busy) return;
    if (!target) return problem(NO_TARGET);
    setBusy(`${snippet.id}:${mode}`);
    setFeedback(undefined);
    try {
      const text = await body(snippet);
      if (text === undefined) return;
      if (mode === "run") return await dispatch(text, "run", false);
      if (text.length === 0) return problem("This snippet is empty. Nothing was pasted or sent.");
      setComposer({ text, label: snippet.label });
    } finally {
      setBusy(undefined);
    }
  }

  const session = target && sessions.find((row) => row.sessionId === target.sessionId && row.generation === target.generation);
  const live = session?.phase === "ready";
  return (
    <Drawer
      close={{ ...close, request: () => (confirm ? dropConfirm() : close.request()) }}
      onClose={onClose}
      finalFocus={() => returnFocus() ?? true}
      initialFocus={searchInput}
      data-testid="snippet-panel"
      title="Snippets"
      discardText="The pending input is dropped. Nothing is sent."
      target={
        <div className="grid w-full min-w-0 gap-1" data-testid="snippet-target">
          <span className="type-caption">Sends only to</span>
          <Target captured={target} phase={target ? (session?.phase ?? "closed") : undefined} />
          {target && active?.sessionId !== target.sessionId ? (
            <span className="type-caption">This is no longer the active terminal. Snippets still go only here.</span>
          ) : null}
        </div>
      }
      footer={
        confirm ? (
          <>
            <Button ref={stepCancel} variant="outline" onClick={dropConfirm}>Cancel</Button>
            <Button
              variant={target?.production ? "destructive" : "default"}
              disabled={inFlight}
              onClick={() => {
                const current = confirm;
                dropConfirm();
                void dispatch(current.text, current.mode, current.fromComposer, current.plan.reasons);
              }}
            >
              {confirm.mode === "run" ? "Run" : "Insert"}
            </Button>
          </>
        ) : (
          <Button variant="outline" disabled={!!busy || inFlight} onClick={close.request}>Close</Button>
        )
      }
    >
      {confirm && target ? (
        <section role="alert" aria-labelledby="snippet-confirm-title" className="grid gap-2" data-testid="snippet-confirm">
          <h3 id="snippet-confirm-title" className="font-medium text-foreground">
            {confirm.mode === "run" ? "Run" : "Insert"} {linesText(confirm.plan.lines)} on {target.label}?
          </h3>
          <Target captured={target} />
          {confirm.plan.reasons.map((reason) => <p key={reason} className="text-muted-foreground">{reasonText[reason]}</p>)}
          <p className="text-muted-foreground">Sending does not confirm that the command succeeded.</p>
        </section>
      ) : null}
      {/* Hidden, not unmounted, during the confirmation step: the composer draft and scroll position stay. */}
      <div className={cn("grid min-w-0 gap-4", confirm && "hidden")}>
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
                  <Button size="sm" disabled={!!busy} aria-label={`Run ${snippet.label}`} onClick={(event) => { if (event.detail <= 1) void act(snippet, "run"); }}>
                    {busy === `${snippet.id}:run` ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}Run
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
        {composer && target ? (
          <section ref={composerBox} className="snippet-panel-composer" aria-label="Pending input" data-testid="snippet-composer">
            <div className="grid gap-1">
              <h3 className="type-label">Pending input · not sent</h3>
              <span className="type-caption text-muted-foreground">From {composer.label}. Sends only to:</span>
              <Target captured={target} />
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
              <Button size="sm" disabled={!live || inFlight} onClick={() => void dispatch(composer.text, "run", true)}>
                <PlayIcon data-icon="inline-start" /> Run
              </Button>
              <Button size="sm" variant="outline" disabled={!live || inFlight} onClick={() => void dispatch(composer.text, "insert", true)}>
                <TextCursorInputIcon data-icon="inline-start" /> Insert without Enter
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { clearComposer(); setFeedback(undefined); }}>
                Discard
              </Button>
            </div>
            {live ? null : (
              <span className="type-caption">{target.label} is no longer connected. Nothing can be sent from here.</span>
            )}
          </section>
        ) : null}
      </div>
      <p role="status" className="snippet-panel-feedback" data-tone={feedback?.tone} data-testid="snippet-feedback">
        {feedback?.tone === "problem" ? <TriangleAlertIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
        <span>{feedback?.text ?? ""}</span>
      </p>
    </Drawer>
  );
}
