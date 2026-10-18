import { useContext, useEffect, useId, useRef, useState } from "react";
import type { CatalogState, Owner, TerminalSession, WorkspaceTemplateNode, WorkspaceTemplateView } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TerminalInputsContext } from "@/components/workspace/terminal-inputs";
import type { WorkspaceController } from "@/components/workspace/terminal-workspace";
import { captureTargets, dispatchTargets, inspectTargets, type CapturedTarget, type TargetDispatchResult, type TargetInspection } from "@/lib/multi-target-dispatch";
import type { ConfirmReason, DispatchMode } from "@/lib/snippet-dispatch";
import { captureWorkspaceTemplate, materializeWorkspaceTemplate } from "@/lib/workspace-templates";

const MAX_TARGETS = 8;
const reasonText: Record<ConfirmReason, string> = {
  production: "PROD server: Run sends Enter.",
  removed: "Control characters will be removed.",
  "line-by-line": "Bracketed paste is off; each line runs as it arrives, including Insert.",
};
interface ConnectionRow { key: string; label: string; status: string }
interface Operation { abort: AbortController; created: Map<string, number>; kind: "metadata" | "prepare" | "send" }
interface Confirmation { targets: readonly CapturedTarget[]; text: string; mode: DispatchMode; inspection: TargetInspection[] }
function leaves(node: WorkspaceTemplateNode): { slotId: string; hostId: string }[] {
  return node.kind === "pane" ? [node] : [...leaves(node.first), ...leaves(node.second)];
}
function TargetLabel({ target }: { target: CapturedTarget }) {
  return <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="font-medium">{target.label}</span>{target.production ? <Badge variant="production">PROD</Badge> : null}<span className="host-target break-all">{target.endpoint}</span><span className="text-muted-foreground type-caption">Session {target.sessionId.slice(-8)}</span></span>;
}

/** Explicit composer only: terminal keystrokes continue through each pane's local input. */
export function WorkspaceTools({ owner, catalog, controller, onClose }: {
  owner: Owner; catalog: CatalogState; controller: WorkspaceController; onClose(): void;
}) {
  const inputs = useContext(TerminalInputsContext)!;
  const id = useId();
  const [templates, setTemplates] = useState<WorkspaceTemplateView[]>([]);
  const [name, setName] = useState("");
  const [savedSnippet, setSavedSnippet] = useState("");
  const [prepareSnippet, setPrepareSnippet] = useState(false);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [selected, setSelected] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<readonly CapturedTarget[] | null>(null);
  const [armed, setArmed] = useState<readonly CapturedTarget[] | null>(null);
  const [text, setText] = useState("");
  const [snippetId, setSnippetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<ConnectionRow[]>([]);
  const [results, setResults] = useState<TargetDispatchResult[]>([]);
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<Confirmation>();
  const active = useRef(true);
  const latest = useRef({ controller, catalog });
  latest.current = { controller, catalog };
  const identity = `${owner.windowId}:${owner.generation}:${catalog.lockEpoch}`;
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const operation = useRef<Operation | null>(null);
  const working = useRef(false);
  const valid = () => active.current && identity === latestIdentity.current;
  const readSession = (sessionId: string) => latest.current.controller.sessions.find((session) => session.sessionId === sessionId);

  // Main checks the phase atomically: a newly Ready session is retained even if its event is late.
  async function closeConnecting(sessionId: string, generation: number) {
    await window.ssterm?.closeTerminal({ owner, sessionId, generation, onlyConnecting: true }).catch(() => undefined);
  }
  function abortOperation() {
    const current = operation.current;
    current?.abort.abort();
    if (current?.kind === "prepare") for (const [sessionId, generation] of current.created) void closeConnecting(sessionId, generation);
  }
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; abortOperation(); };
  }, []);
  useEffect(() => {
    let disposed = false;
    void window.ssterm?.workspaceTemplates({ owner }).then((response) => {
      if (disposed || !valid()) return;
      if (response.ok) setTemplates(response.value.templates);
      else setNotice("Workspace templates could not be loaded. Reopen Workspace tools to retry.");
    }).catch(() => { if (!disposed && valid()) setNotice("Workspace templates are unavailable."); });
    return () => { disposed = true; };
  }, []);
  function start(kind: Operation["kind"]) {
    if (working.current || !valid()) return null;
    working.current = true;
    setBusy(true);
    const next: Operation = { kind, abort: new AbortController(), created: new Map() };
    operation.current = next;
    return next;
  }
  function live(op: Operation) { return valid() && operation.current === op && !op.abort.signal.aborted; }
  function finish(op: Operation) {
    if (operation.current !== op) return;
    operation.current = null;
    working.current = false;
    if (valid()) setBusy(false);
  }
  function reset() {
    if (working.current) return;
    setPrepared(null); setArmed(null); setText(""); setResults([]); setRows([]); setConfirm(undefined); setNotice("");
  }
  async function loadSnippet(value: string, op: Operation) {
    const snippet = latest.current.catalog.snippets.find((entry) => entry.id === value);
    if (!snippet) { if (live(op)) setNotice("The saved snippet is missing. No substitute was loaded."); return; }
    const response = await window.ssterm?.openSnippet({ owner, snippetId: snippet.id, expectedRevision: snippet.revision }).catch(() => undefined);
    if (!live(op)) return;
    if (!response?.ok || response.value.status !== "open") { setNotice("The snippet could not be opened. Unlock protected content or review the saved snippet."); return; }
    setText(response.value.body); setArmed(null);
    setNotice("Snippet prepared for the captured targets. Review the text, then Arm broadcast. Nothing was sent.");
  }
  async function saveTemplate() {
    const configuration = captureWorkspaceTemplate(controller.workspace, controller.sessions, savedSnippet || null);
    if (!configuration) return setNotice("Open one to eight saved-host panes before saving a template.");
    const op = start("metadata"); if (!op) return;
    try {
      const response = await window.ssterm?.saveWorkspaceTemplate({ owner, templateId: null, expectedRevision: null, label: name.trim(), configuration });
      if (!live(op)) return;
      if (!response?.ok) return setNotice("Template could not be saved. Check its name and saved host/snippet references; at most 64 templates are allowed.");
      setTemplates((current) => [...current, response.value]); setName(""); setNotice("Workspace template saved. It contains layout and saved references only.");
    } catch { if (live(op)) setNotice("Template could not be saved."); } finally { finish(op); }
  }
  async function deleteTemplate(template: WorkspaceTemplateView) {
    const op = start("metadata"); if (!op) return;
    try {
      const response = await window.ssterm?.deleteWorkspaceTemplate({ owner, templateId: template.id, expectedRevision: template.revision });
      if (!live(op)) return;
      if (!response?.ok) return setNotice("Template could not be deleted. Reopen Workspace tools to refresh it.");
      setTemplates((current) => current.filter((entry) => entry.id !== template.id)); setNotice("Template deleted. Open sessions remain available.");
    } catch { if (live(op)) setNotice("Template could not be deleted."); } finally { finish(op); }
  }
  function updateRow(op: Operation, key: string, status: string) {
    if (live(op)) setRows((current) => current.map((entry) => entry.key === key ? { ...entry, status } : entry));
  }
  async function connectTargets(slots: { slotId: string; hostId: string }[], template?: WorkspaceTemplateView) {
    if (slots.length === 0 || slots.length > MAX_TARGETS) return setNotice("Select between one and eight targets.");
    const missing = slots.filter((slot) => !latest.current.catalog.hosts.some((host) => host.id === slot.hostId));
    if (missing.length) return setNotice(`Missing saved hosts: ${missing.map((slot) => slot.hostId).join(", ")}. No connections were opened and no hosts were substituted.`);
    const missingSnippet = !!template?.configuration.snippetId && !catalog.snippets.some((snippet) => snippet.id === template.configuration.snippetId);
    if (missingSnippet && prepareSnippet)
      return setNotice("This template references a missing saved snippet. No connections were opened. Uncheck Prepare saved snippet to restore layout only; no substitute snippet will be loaded.");
    const missingSnippetWarning = missingSnippet ? " The saved snippet is missing; only the layout is restored and no substitute snippet is loaded." : "";
    const op = start("prepare"); if (!op) return;
    setArmed(null); setPrepared(null); setText(""); setConfirm(undefined); setResults([]);
    setRows(slots.map((slot) => ({ key: slot.slotId, label: latest.current.catalog.hosts.find((host) => host.id === slot.hostId)!.label, status: "connecting" })));
    setNotice(`Opening fresh sessions using each saved host's current settings. Review any trust or credential prompts.${missingSnippetWarning}`);
    const allocated = new Map<string, string>();
    const ready = new Map<string, TerminalSession>();
    try {
      await Promise.all(slots.map(async (slot) => {
        const response = await window.ssterm?.connectHost({ owner, hostId: slot.hostId }).catch(() => undefined);
        if (!response?.ok) return updateRow(op, slot.slotId, "failed to open");
        const { sessionId, generation } = response.value;
        op.created.set(sessionId, generation);
        if (!live(op)) { void closeConnecting(sessionId, generation); return; }
        allocated.set(slot.slotId, sessionId);
        const deadline = Date.now() + 90_000;
        while (live(op)) {
          const session = readSession(sessionId);
          const handle = inputs.get(sessionId);
          if (session?.phase === "ready" && handle?.generation === generation && handle.accepting()) {
            ready.set(slot.slotId, session); updateRow(op, slot.slotId, "ready"); return;
          }
          if (session && (session.generation !== generation || session.phase === "failed" || session.phase === "closed"))
            return updateRow(op, slot.slotId, `failed${session.error ? ` (${session.error})` : ""}`);
          if (Date.now() > deadline) {
            void closeConnecting(sessionId, generation);
            return updateRow(op, slot.slotId, "timed out");
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      }));
      if (!live(op)) return;
      if (template && allocated.size) {
        const layout = materializeWorkspaceTemplate(template.configuration, allocated);
        controller.dispatch({ type: "append-template", ...layout, newSessionIds: [...allocated.values()] });
      }
      const targets = captureTargets(slots.flatMap((slot) => { const session = ready.get(slot.slotId); return session ? [session] : []; }));
      setPrepared(targets);
      setNotice(`${targets.length} of ${slots.length} targets ready. Nothing was sent. Ready sessions remain open if you cancel or close tools.${missingSnippetWarning}`);
      if (targets.length && template && prepareSnippet && template.configuration.snippetId) {
        setSnippetId(template.configuration.snippetId);
        await loadSnippet(template.configuration.snippetId, op);
      }
    } finally { finish(op); }
  }
  async function prepareTargets() {
    if (mode === "new") return connectTargets(selected.map((hostId, index) => ({ hostId, slotId: `new-${index}` })));
    if (working.current || selected.length === 0 || selected.length > MAX_TARGETS) return;
    const chosen = selected.map(readSession);
    if (chosen.some((session) => !session || session.phase !== "ready" || !session.target))
      return setNotice("A selected session is no longer Ready. Reset the selection and choose targets again. Nothing was prepared or sent.");
    try {
      const targets = captureTargets(chosen as TerminalSession[]);
      setPrepared(targets); setArmed(null); setText(""); setResults([]); setRows([]);
      setNotice(`${targets.length} existing targets captured. No sessions were opened and nothing was sent.`);
    } catch {
      setNotice("The target selection changed. Choose up to eight distinct Ready sessions again. Nothing was prepared or sent.");
    }
  }
  function options(targets: readonly CapturedTarget[], value: string, dispatchMode: DispatchMode) {
    return { targets, text: value, mode: dispatchMode, inputs, readSession };
  }
  async function send(targets: readonly CapturedTarget[], value: string, dispatchMode: DispatchMode, approvedReasons?: ReadonlyMap<string, readonly ConfirmReason[]>) {
    const op = start("send"); if (!op) return;
    setResults([]); setArmed(null);
    try {
      const outcome = await dispatchTargets({ ...options(targets, value, dispatchMode), approvedReasons, signal: op.abort.signal,
        onResult: (result) => { if (valid()) setResults((current) => [...current, result]); },
      });
      if (valid()) setNotice(`${outcome.filter((entry) => entry.status === "accepted").length} of ${outcome.length} targets accepted bytes. Remote command success is unknown.${outcome.some((entry) => entry.status === "needs-confirmation") ? " Risk changed; review and Arm broadcast again for fresh confirmation." : " Broadcast disarmed."}`);
    } finally { finish(op); }
  }
  function requestSend(dispatchMode: DispatchMode) {
    if (!armed || working.current) return;
    const inspection = inspectTargets(options(armed, text, dispatchMode));
    if (inspection.some((entry) => entry.reasons.length)) return setConfirm({ targets: armed, text, mode: dispatchMode, inspection });
    void send(armed, text, dispatchMode);
  }
  function select(value: string, checked: boolean) {
    setSelected((current) => checked ? [...new Set([...current, value])] : current.filter((entry) => entry !== value));
  }
  const lockedSelection = busy || prepared !== null;
  const readySessions = controller.sessions.filter((session) => session.phase === "ready");
  const choices = mode === "existing" ? readySessions.map((session) => ({ id: session.sessionId, label: `${session.target?.label ?? "Unknown target"} · Session ${session.sessionId.slice(-8)}` })) : catalog.hosts.map((host) => ({ id: host.id, label: host.label }));
  return <Dialog open onOpenChange={(open) => { if (!open) { abortOperation(); onClose(); } }}>
    <DialogContent className="workspace-tools motion-reduce:animate-none" data-testid="workspace-tools"
      finalFocus={() => document.querySelector<HTMLElement>('.terminal-workspace section[data-active="true"] .xterm-helper-textarea') ?? true}>
      <DialogHeader><DialogTitle>Workspace tools</DialogTitle><DialogDescription>Save layouts and prepare explicit multi-target input. Ordinary terminal typing always stays local.</DialogDescription></DialogHeader>
      <div className="workspace-tools-scroll">
        <section className="grid gap-3" aria-label="Workspace templates">
          <h2 className="type-label">Workspace templates</h2>
          <p className="text-sm text-muted-foreground">Templates restore fresh sessions using current saved-host settings. They do not restore terminal history or running processes.</p>
          <Field><FieldLabel htmlFor={`${id}-name`}>Template name</FieldLabel><Input id={`${id}-name`} value={name} maxLength={200} disabled={busy} onChange={(event) => setName(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor={`${id}-saved-snippet`}>Saved snippet</FieldLabel><Select items={[{ value: "", label: "None" }, ...catalog.snippets.map((snippet) => ({ value: snippet.id, label: snippet.label }))]} value={savedSnippet} disabled={busy} onValueChange={(value) => { if (typeof value === "string") setSavedSnippet(value); }}><SelectTrigger id={`${id}-saved-snippet`} className="w-full"><SelectValue /></SelectTrigger><SelectContent alignItemWithTrigger={false}><SelectGroup><SelectItem value="">None</SelectItem>{catalog.snippets.map((snippet) => <SelectItem key={snippet.id} value={snippet.id}>{snippet.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
          <Button variant="outline" disabled={busy || !name.trim()} onClick={() => void saveTemplate()}>Save workspace template</Button>
          <Field orientation="horizontal"><Checkbox id={`${id}-prepare-snippet`} checked={prepareSnippet} disabled={busy} onCheckedChange={setPrepareSnippet} /><FieldLabel htmlFor={`${id}-prepare-snippet`}>Prepare saved snippet</FieldLabel></Field>
          <p className="text-sm text-muted-foreground">Unchecked by default. Preparing loads text only after actual targets are ready; Arm and Run remain explicit.</p>
          <ul className="grid gap-2" aria-label="Saved workspace templates">{templates.map((template) => <li key={template.id} className="workspace-template-row"><span className="min-w-0 break-words font-medium">{template.label}</span><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} aria-label={`Restore ${template.label}`} onClick={() => void connectTargets(template.configuration.tabs.flatMap((tab) => leaves(tab.root)), template)}>Restore</Button><Button size="sm" variant="ghost" disabled={busy} aria-label={`Delete ${template.label}`} onClick={() => void deleteTemplate(template)}>Delete</Button></div></li>)}</ul>
          {templates.length === 0 ? <p className="text-sm text-muted-foreground">No saved templates.</p> : null}
        </section>
        <section className="grid gap-3 border-t border-border pt-4" aria-label="Multi-target composer" data-testid="multi-target-composer">
          <h2 className="type-label">Multi-target composer</h2>
          <ToggleGroup aria-label="Target source" variant="outline" size="sm" disabled={lockedSelection} value={[mode]} onValueChange={(values) => { const value = values[0]; if (value === "existing" || value === "new") { setMode(value); setSelected([]); } }}><ToggleGroupItem value="existing">Existing sessions</ToggleGroupItem><ToggleGroupItem value="new">New sessions</ToggleGroupItem></ToggleGroup>
          <p className="text-sm text-muted-foreground">{mode === "existing" ? "Choose Ready sessions explicitly; preparation opens no sessions." : "Choose saved hosts; preparation opens fresh sessions without reusing existing terminals."} Maximum eight targets.</p>
          <div className="grid gap-2" role="group" aria-label="Available targets">{choices.map((choice, index) => <Field orientation="horizontal" key={choice.id}><Checkbox id={`${id}-target-${index}`} checked={selected.includes(choice.id)} disabled={lockedSelection || (selected.length >= MAX_TARGETS && !selected.includes(choice.id))} onCheckedChange={(checked) => select(choice.id, checked)} /><FieldLabel htmlFor={`${id}-target-${index}`} className="min-w-0 break-words">{choice.label}</FieldLabel></Field>)}</div>
          {!choices.length ? <p className="text-sm text-muted-foreground">{mode === "existing" ? "No Ready sessions. Connect to a server or choose New sessions." : "No saved hosts. Add one on the Servers page."}</p> : null}
          <div className="flex flex-wrap gap-2"><Button size="sm" disabled={lockedSelection || !selected.length} onClick={() => void prepareTargets()}>Prepare targets</Button><Button size="sm" variant="outline" disabled={busy} onClick={reset}>Reset targets</Button></div>
          {rows.length ? <ul aria-label="Connection preparation" className="grid gap-2">{rows.map((row) => <li key={row.key} className="flex flex-wrap justify-between gap-2"><span>{row.label}</span><span>{row.status}</span></li>)}</ul> : null}
          {prepared ? <div className="grid gap-2"><h3 className="type-label">Captured targets · {prepared.length}</h3><ul aria-label="Captured targets" className="grid gap-2">{prepared.map((target) => <li key={target.sessionId}><TargetLabel target={target} /></li>)}</ul><p className="text-sm text-muted-foreground">Changing terminal focus does not change these targets. Reset targets to choose again.</p></div> : null}
          <Field><FieldLabel htmlFor={`${id}-snippet`}>Snippet to prepare</FieldLabel><Select items={[{ value: "", label: "Choose saved snippet" }, ...catalog.snippets.map((snippet) => ({ value: snippet.id, label: snippet.label }))]} value={snippetId} disabled={busy || !prepared?.length} onValueChange={(value) => { if (typeof value === "string") { setSnippetId(value); setArmed(null); } }}><SelectTrigger id={`${id}-snippet`} className="w-full"><SelectValue /></SelectTrigger><SelectContent alignItemWithTrigger={false}><SelectGroup><SelectItem value="">Choose saved snippet</SelectItem>{catalog.snippets.map((snippet) => <SelectItem key={snippet.id} value={snippet.id}>{snippet.label}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
          <Button size="sm" variant="outline" disabled={busy || !prepared?.length || !snippetId} onClick={() => { const op = start("prepare"); if (op) void loadSnippet(snippetId, op).finally(() => finish(op)); }}>Load snippet to composer</Button>
          <Field><FieldLabel htmlFor={`${id}-input`}>Multi-target input</FieldLabel><Textarea id={`${id}-input`} className="workspace-tools-input" rows={5} value={text} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} disabled={busy || !prepared?.length} onChange={(event) => { setText(event.target.value); setArmed(null); setConfirm(undefined); }} /></Field>
          {armed ? <Alert data-testid="broadcast-armed"><AlertTitle>Broadcast armed</AlertTitle><AlertDescription>Only the captured targets above receive the next explicit Insert or Run.</AlertDescription><Button size="sm" variant="outline" onClick={() => { setArmed(null); setConfirm(undefined); }}>Disarm</Button></Alert> : <p className="text-sm text-muted-foreground">Broadcast disarmed. Preparing or editing text sends nothing.</p>}
          <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || !prepared?.length || !text || !!armed} onClick={() => { setArmed(prepared?.map((target) => ({ ...target })) ?? null); setResults([]); }}>Arm broadcast</Button><Button size="sm" variant="outline" disabled={busy || !armed} onClick={() => requestSend("insert")}>Insert without Enter</Button><Button size="sm" disabled={busy || !armed} onClick={() => requestSend("run")}>Run on targets</Button></div>
          {busy && operation.current?.kind !== "metadata" ? <Button variant="outline" size="sm" onClick={() => { abortOperation(); setArmed(null); setConfirm(undefined); setText(""); setRows((current) => current.map((row) => row.status === "connecting" ? { ...row, status: "cancelled" } : row)); setNotice("Cancelled. Ready sessions remain open; only newly created connecting sessions are closed. An in-flight write reports its actual result; remaining writes are cancelled."); }}>Cancel operation</Button> : null}
          {results.length ? <ul className="grid gap-2" aria-label="Per-target results" data-testid="multi-target-results">{results.map((result) => <li key={result.target.sessionId}><TargetLabel target={result.target} /><span>{result.status === "accepted" ? "Bytes accepted · remote success unknown" : result.status}</span></li>)}</ul> : null}
        </section>
        <p role="status" className="break-words text-sm" data-testid="workspace-tools-feedback">{notice}</p>
      </div>
      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(undefined); }}>
        {confirm ? <AlertDialogContent className="workspace-tools-confirm motion-reduce:animate-none" data-testid="multi-target-confirm"><AlertDialogHeader><AlertDialogTitle>{confirm.mode === "run" ? "Run on captured targets?" : "Insert on captured targets?"}</AlertDialogTitle><AlertDialogDescription render={<div />} className="grid gap-3">{confirm.inspection.map((entry) => <div key={entry.target.sessionId} className="grid gap-1"><TargetLabel target={entry.target} /><span>{entry.status === "ready" ? "Ready" : entry.status}</span>{entry.reasons.map((reason) => <span key={reason}>{reasonText[reason]}</span>)}</div>)}<span>Bytes accepted does not confirm command success.</span></AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><Button variant="outline" autoFocus onClick={() => { setConfirm(undefined); setArmed(null); }}>Cancel</Button><Button variant={confirm.targets.some((target) => target.production) ? "destructive" : "default"} onClick={() => { const current = confirm; setConfirm(undefined); void send(current.targets, current.text, current.mode, new Map(current.inspection.map((entry) => [entry.target.sessionId, entry.reasons]))); }}>Confirm {confirm.mode === "run" ? "Run" : "Insert"}</Button></AlertDialogFooter></AlertDialogContent> : null}
      </AlertDialog>
    </DialogContent>
  </Dialog>;
}
