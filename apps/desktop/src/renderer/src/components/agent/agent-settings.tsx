import { useEffect, useId, useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import {
  AGENT_CUSTOM_PLACEHOLDERS, AGENT_EFFORTS, AGENT_MODELS, customProviderProblem, isAgentModelId, isRunnableProviderStatus, MAX_AGENT_INSTRUCTIONS, type AgentCustomProvider,
  type AgentEffort, type AgentProvider, type AgentProviderView, type AgentSettings as Settings, type AgentSettingsView, type ConfigureAgentResponse, type Owner,
} from "@ssterm/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const providerNotes: Record<AgentProviderView["status"], string> = {
  ready: "Verified",
  "ready-live-unverified": "Passed a live check only: what it sends its provider was not seen.",
  missing: "Not found. Install Claude Code with its native installer (~/.local/bin/claude) and sign in.",
  "unsupported-version": "This version has not passed ssterm's isolation check, so it cannot be used.",
  "not-native": "Only the native Claude Code binary can be used; a wrapper or script was found.",
  "managed-policy": "A managed Claude Code policy is installed on this Mac; ssterm cannot verify what it adds, so the agent stays off.",
  disabled: "Disabled: its isolation check failed (user-level AGENTS.md is always sent, apply_patch cannot be removed and sub-agent tools stay exposed).",
  "not-configured": "Not defined yet.",
  invalid: "The definition cannot be used.",
  "check-required": "Needs an isolation check before it can be used.",
  "check-failed": "Disabled: it failed ssterm's isolation check.",
  unverifiable: "Disabled: ssterm's isolation check could not verify it.",
};
const customNotes: Partial<Record<AgentProviderView["status"], string>> = {
  ready: "Passed ssterm's isolation check", missing: "The binary was not found.",
  "managed-policy": "This is Claude Code and a managed Claude Code policy is installed on this Mac, so it cannot be used.",
};
const providerLabels: Record<AgentProvider, string> = { claude: "claude (Anthropic)", codex: "codex (OpenAI)", custom: "Custom CLI provider" };

/** A3: exactly what leaves the Mac, shown before the agent can be turned on. */
export function AgentDisclosure({ provider = "claude" }: { provider?: AgentProvider }) {
  // Ticket 06: a custom CLI sends to whichever provider it is set up for; ssterm cannot see what it adds.
  const to = provider === "claude" ? "Anthropic" : provider === "codex" ? "OpenAI" : "that CLI's provider";
  return (
    <div className="grid gap-2 text-sm" data-testid="agent-disclosure">
      {provider === "custom" ? (
        <p>
          The agent runs through <strong>your custom CLI provider</strong>, so what it sends goes to the provider that CLI is set up
          for, under that account's terms. ssterm cannot see or change what the CLI adds to its requests.
        </p>
      ) : (
        <p>
          The agent runs through your own <strong>{provider}</strong> CLI, so what it sends goes to <strong>{to}</strong> under your
          account. That account's own retention and training terms apply; ssterm cannot change them.
        </p>
      )}
      <p className="font-medium">Sent to {to} for each conversation:</p>
      <ul className="list-disc pl-5">
        <li>your chat messages and the agent's replies;</li>
        <li>every command the agent runs and that command's full output (the last 64 KiB of each). Nothing is redacted;</li>
        <li>the bound server's label, user@host:port and environment, and your additional instructions (both go into the agent's system prompt);</li>
        <li>what the CLI adds itself{provider === "claude" ? ": a temporary working-folder path, macOS version, platform, shell, the model, today's date, the CLI version and your signed-in account email" : ", which ssterm cannot see"}.</li>
      </ul>
      <p className="font-medium">Never sent by ssterm:</p>
      <ul className="list-disc pl-5">
        <li>earlier terminal output, what you type in the terminal, other sessions, your saved servers, snippet contents, passwords and keys.</li>
      </ul>
      <p className="text-muted-foreground">
        {provider === "custom"
          ? "ssterm keeps conversations only in memory. After each run it removes anything the CLI saved that names the run in the transcript folders it knows (Claude, Codex, Gemini); it cannot verify other places the CLI may write. "
          : "Conversations are kept only in memory and the CLI runs without saving a transcript. "}
        Closing the panel, ending the session, locking the workspace or quitting ends the conversation.
      </p>
    </div>
  );
}

/** SST-041 Settings › AI Agent: off by default; turning it on needs the disclosure acknowledged. */
export function AgentSettings({ owner }: { owner: Owner }) {
  const id = useId();
  const [view, setView] = useState<AgentSettingsView>();
  const [unavailable, setUnavailable] = useState(false);
  const [consenting, setConsenting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [instructions, setInstructions] = useState("");
  const windowId = owner.windowId;
  const generation = owner.generation;
  useEffect(() => {
    let current = true;
    void window.ssterm?.agentSettings({ owner: { windowId, generation } }).then((result) => {
      if (!current) return;
      if (!result.ok) return setUnavailable(true);
      setView(result.value);
      setInstructions(result.value.settings.instructions);
    }, () => { if (current) setUnavailable(true); });
    return () => { current = false; };
  }, [windowId, generation]);

  const claude = view?.providers.find((provider) => provider.id === "claude");
  const codex = view?.providers.find((provider) => provider.id === "codex");
  const customView = view?.providers.find((provider) => provider.id === "custom");
  const enabled = !!view?.settings.enabled;
  const [custom, setCustom] = useState("");
  /** The provider the next "Turn on" uses; a change while on asks for consent again. */
  const [choice, setChoice] = useState<AgentProvider>();
  const selected = choice ?? view?.settings.provider ?? "claude";
  /** A changed custom definition waiting for its disclosure to be acknowledged (the agent is on with it). */
  const [pendingCustom, setPendingCustom] = useState<AgentCustomProvider>();
  const selectedView = view?.providers.find((provider) => provider.id === selected);
  const check = async (live: boolean) => {
    setBusy(true);
    setProblem(undefined);
    const result = await window.ssterm?.checkAgentProvider({ owner: { windowId, generation }, live }).catch(() => undefined);
    setBusy(false);
    if (result?.ok) setView(result.value);
    else setProblem("The isolation check could not run.");
  };
  const save = async (changes: Partial<Settings>, consent = false) => {
    if (!view) return;
    setBusy(true);
    setProblem(undefined);
    const result = await window.ssterm?.configureAgent({
      owner: { windowId, generation }, consent, settings: { ...view.settings, ...changes },
    }).catch(() => undefined);
    setBusy(false);
    const outcome: ConfigureAgentResponse | undefined = result?.ok ? result.value : undefined;
    if (outcome?.status === "saved") {
      setView(outcome.view);
      setInstructions(outcome.view.settings.instructions);
      setConsenting(false);
      setAcknowledged(false);
      setChoice(undefined);
      setPendingCustom(undefined);
    } else if (outcome?.status === "provider-unavailable") {
      setView(outcome.view);
      setProblem(`${providerLabels[changes.provider ?? view.settings.provider]} is not available (not verified), so nothing was saved.`);
    } else if (outcome?.status === "consent-required") setProblem("Read and acknowledge what is sent first.");
    else if (outcome?.status === "model-unverified") setProblem("That model has not passed ssterm's isolation check with this claude version, so it cannot be used.");
    else setProblem("AI Agent settings could not be saved.");
  };

  return (
    <FieldSet data-testid="agent-settings">
      <FieldLegend>AI Agent</FieldLegend>
      <FieldDescription>
        Off by default. When on, a connected SSH terminal shows AI Agent, which opens a chat beside the terminal. Each
        conversation starts in Auto: read-only commands run, and anything else runs only from a plan you approve or after
        you approve that command. Read-only classification is best effort.
      </FieldDescription>
      {problem || unavailable ? (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription>{problem ?? "AI Agent settings are unavailable."}</AlertDescription>
        </Alert>
      ) : null}
      {!view && !unavailable ? <p className="flex items-center gap-2 type-caption text-muted-foreground"><Spinner aria-hidden="true" /> Checking the AI providers…</p> : null}
      {view ? (
        <>
          <Field orientation="horizontal" data-disabled={busy || undefined}>
            <Switch
              id={`${id}-enabled`}
              aria-describedby={`${id}-enabled-note`}
              disabled={busy}
              checked={enabled || consenting}
              onCheckedChange={(checked) => {
                if (checked) { setConsenting(true); setAcknowledged(false); }
                else if (consenting) setConsenting(false);
                else void save({ enabled: false });
              }}
            />
            <FieldContent>
              <FieldLabel htmlFor={`${id}-enabled`}>Use the AI agent</FieldLabel>
              <FieldDescription id={`${id}-enabled-note`}>
                {enabled ? "On. Turning it off ends every agent conversation at once." : "Off. Nothing is sent anywhere."}
              </FieldDescription>
            </FieldContent>
          </Field>
          <dl className="settings-facts" data-testid="agent-providers">
            <dt>claude (Anthropic)</dt>
            <dd data-status={claude?.status}>
              {claude?.version ? `${claude.version} · ` : ""}{claude ? providerNotes[claude.status] : ""}
              {claude?.status !== "ready" && view.verified.length ? ` Verified: ${view.verified.join(", ")}.` : ""}
            </dd>
            <dt>codex (OpenAI)</dt>
            <dd data-status={codex?.status} data-testid="agent-codex-status">
              {codex?.version ? `${codex.version} · ` : ""}{codex?.status === "ready" ? "Verified" : "Disabled: its isolation check failed."}
              {codex?.status === "missing" ? " (Not found on this Mac.)" : ""}
              {codex?.status !== "ready" && codex?.reasons.length ? <Reasons reasons={codex.reasons} /> : null}
            </dd>
            <dt>Custom CLI provider</dt>
            <dd data-status={customView?.status}>
              {view.settings.custom ? `${view.settings.custom.label} · ` : ""}{customView ? customNotes[customView.status] ?? providerNotes[customView.status] : ""}
            </dd>
          </dl>
          <Field data-disabled={busy || undefined}>
            <FieldLabel id={`${id}-provider`}>Provider</FieldLabel>
            <ToggleGroup aria-labelledby={`${id}-provider`} variant="outline" spacing={0} disabled={busy} value={[selected]}
              onValueChange={(value) => {
                const next = value[0] as AgentProvider | undefined;
                if (!next || next === selected) return;
                setProblem(undefined);
                // Off: the choice is simply saved. On: the disclosure for the new provider comes first.
                if (!enabled) { setChoice(undefined); void save({ provider: next }); }
                else { setChoice(next === view.settings.provider ? undefined : next); setConsenting(next !== view.settings.provider); setAcknowledged(false); }
              }}>
              {(["claude", "codex", "custom"] as const).map((provider) => (
                <ToggleGroupItem key={provider} value={provider} disabled={provider === "codex" && codex?.status !== "ready"}>{provider === "custom" ? "Custom" : provider}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>Only a provider that passed ssterm's isolation check can be turned on. Conversations keep the provider they opened with.</FieldDescription>
          </Field>
          {consenting && (!enabled || selected !== view.settings.provider || pendingCustom) ? (
            <div className="grid gap-3 rounded-lg border border-border p-3" role="group" aria-label="Before you turn on the AI agent">
              <AgentDisclosure provider={selected} />
              <Field orientation="horizontal">
                <Checkbox id={`${id}-consent`} checked={acknowledged} onCheckedChange={(value) => setAcknowledged(value === true)} />
                <FieldLabel htmlFor={`${id}-consent`}>{selected === "claude" ? "I understand what is sent to Anthropic" : "I understand what is sent to this provider"}</FieldLabel>
              </Field>
              <div className="flex gap-2">
                {selected === "custom" && (pendingCustom ? !pendingCustom.endpointEnv : selectedView?.status === "ready-live-unverified") ? (
                  <p className="text-muted-foreground" data-testid="agent-live-only-note">
                    This provider can only be checked with a live call, so what it sends its provider was not seen by ssterm.
                  </p>
                ) : null}
                <Button size="sm" disabled={!acknowledged || busy || (!pendingCustom && !isRunnableProviderStatus(selectedView?.status))}
                  onClick={() => void save({ enabled: true, instructions, provider: selected, ...(pendingCustom ? { custom: pendingCustom } : {}) }, true)}>
                  {pendingCustom ? "Save and use this provider" : "Turn on AI agent"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setConsenting(false); setChoice(undefined); setPendingCustom(undefined); }}>Cancel</Button>
              </div>
            </div>
          ) : null}
          {enabled ? <AgentDisclosure provider={view.settings.provider} /> : null}
          <Field orientation="horizontal" data-disabled={busy || undefined}>
            <Switch
              id={`${id}-prod-full-allow`}
              aria-describedby={`${id}-prod-full-allow-note`}
              disabled={busy}
              checked={view.settings.allowFullAllowOnProd}
              onCheckedChange={(checked) => void save({ allowFullAllowOnProd: checked })}
            />
            <FieldContent>
              <FieldLabel htmlFor={`${id}-prod-full-allow`}>Allow Full allow on PROD</FieldLabel>
              <FieldDescription id={`${id}-prod-full-allow-note`}>
                Off by default: Full allow cannot be chosen for a PROD server. When on, it still needs the PROD warning in each
                conversation. Turning it off returns PROD conversations in Full allow to Auto.
              </FieldDescription>
            </FieldContent>
          </Field>
          {selected !== "custom" ? <ModelSettings id={id} view={view} busy={busy} custom={custom} onCustom={setCustom} onSave={(changes) => void save(changes)} /> : null}
          <CustomProviderSettings key={JSON.stringify(view.settings.custom)} id={id} view={view} status={customView} busy={busy}
            onSave={(definition) => {
              // A changed definition in use is a different CLI: its disclosure is acknowledged again (it is checked on save).
              if (enabled && view.settings.provider === "custom") { setPendingCustom(definition); setConsenting(true); setAcknowledged(false); }
              else void save({ custom: definition });
            }} onCheck={(live) => void check(live)} />
          <Field data-disabled={busy || undefined}>
            <FieldLabel htmlFor={`${id}-instructions`}>Additional instructions</FieldLabel>
            <Textarea
              id={`${id}-instructions`}
              aria-describedby={`${id}-instructions-note`}
              maxLength={MAX_AGENT_INSTRUCTIONS}
              value={instructions}
              disabled={busy}
              placeholder="For example: prefer journalctl over reading log files directly."
              onChange={(event) => setInstructions(event.target.value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ""))}
            />
            <FieldDescription id={`${id}-instructions-note`}>
              Added after ssterm's built-in instructions; they cannot replace them, and ssterm enforces its rules regardless.
              Applies to agents started afterwards.
            </FieldDescription>
            <Button
              size="sm"
              variant="outline"
              className="justify-self-start"
              disabled={busy || instructions === view.settings.instructions}
              onClick={() => void save({ instructions })}
            >
              Save instructions
            </Button>
          </Field>
        </>
      ) : null}
    </FieldSet>
  );
}

/** A14: the bundled model list (full IDs with aliases), a strict custom ID, and the effort; new conversations use them. */
function ModelSettings({ id, view, busy, custom, onCustom, onSave }: {
  id: string; view: AgentSettingsView; busy: boolean; custom: string; onCustom(value: string): void; onSave(changes: Partial<Settings>): void;
}) {
  const list = AGENT_MODELS.claude;
  const items = list.models.map((entry) => ({ value: entry.id, label: `${entry.label} (${entry.id}${entry.alias ? `, ${entry.alias}` : ""})${entry.verified ? "" : " · not verified"}` }));
  const customInvalid = custom !== "" && !isAgentModelId(custom);
  return (
    <>
      <Field data-disabled={busy || undefined}>
        <FieldLabel htmlFor={`${id}-model`}>Model</FieldLabel>
        <Select items={items} value={view.settings.model} disabled={busy} onValueChange={(value) => { if (typeof value === "string" && value !== view.settings.model) onSave({ model: value }); }}>
          <SelectTrigger id={`${id}-model`} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          Bundled for claude {list.cliVersion}; the CLI cannot list its models. Only models that passed ssterm's isolation check
          with this version can be used. Applies to conversations opened afterwards and their sub agents.
        </FieldDescription>
      </Field>
      <Field data-invalid={customInvalid || undefined} data-disabled={busy || undefined}>
        <FieldLabel htmlFor={`${id}-custom-model`}>Custom model ID</FieldLabel>
        <div className="flex gap-2">
          <Input id={`${id}-custom-model`} value={custom} maxLength={64} disabled={busy} autoComplete="off" spellCheck={false}
            aria-invalid={customInvalid || undefined} onChange={(event) => onCustom(event.target.value.trim())} />
          <Button size="sm" variant="outline" disabled={busy || !custom || customInvalid} onClick={() => onSave({ model: custom })}>Use</Button>
        </div>
        <FieldDescription>Letters, digits and . _ : - only, up to 64 characters. A custom model is not verified, so it is refused until it is.</FieldDescription>
        {customInvalid ? <FieldError>Use letters, digits and . _ : - only, not starting with -.</FieldError> : null}
      </Field>
      <Field data-disabled={busy || undefined}>
        <FieldLabel id={`${id}-effort`}>Effort</FieldLabel>
        <ToggleGroup aria-labelledby={`${id}-effort`} variant="outline" spacing={0} disabled={busy} value={[view.settings.effort]}
          onValueChange={(value) => { const effort = value[0] as AgentEffort | undefined; if (effort && effort !== view.settings.effort) onSave({ effort }); }}>
          {AGENT_EFFORTS.map((effort) => <ToggleGroupItem key={effort} value={effort}>{effort}</ToggleGroupItem>)}
        </ToggleGroup>
      </Field>
    </>
  );
}

function Reasons({ reasons }: { reasons: string[] }) {
  return <ul className="mt-1 list-disc pl-5" data-testid="agent-provider-reasons">{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>;
}

const EMPTY_CUSTOM: AgentCustomProvider = { label: "", path: "", args: [], input: "stream-json", model: "default", effort: "medium", env: [], endpointEnv: null, toolTimeoutSec: 60 };
/**
 * Ticket 06: Settings › AI Agent › Custom CLI provider. The definition is structured (no shell string): an absolute
 * binary path, one argument per line with placeholders, the prompt mode, the model and effort, environment additions
 * and the test endpoint variable. ssterm checks its isolation before first use and after any change.
 */
function CustomProviderSettings({ id, view, status, busy, onSave, onCheck }: {
  id: string; view: AgentSettingsView; status: AgentProviderView | undefined; busy: boolean;
  onSave(definition: AgentCustomProvider): void; onCheck(live: boolean): void;
}) {
  const saved = view.settings.custom;
  const initial = saved ?? EMPTY_CUSTOM;
  const [label, setLabel] = useState(initial.label);
  const [path, setPath] = useState(initial.path);
  const [args, setArgs] = useState(initial.args.join("\n"));
  const [input, setInput] = useState(initial.input);
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState<AgentEffort>(initial.effort);
  const [env, setEnv] = useState(initial.env.map((entry) => `${entry.name}=${entry.value}`).join("\n"));
  const [endpoint, setEndpoint] = useState(initial.endpointEnv ?? "");
  const [live, setLive] = useState(false);
  const [timeout, setTimeoutSec] = useState(String(initial.toolTimeoutSec));
  const draft: AgentCustomProvider = {
    label: label.trim(), path: path.trim(), args: args === "" ? [] : args.replace(/\n$/u, "").split("\n"), input, model: model.trim(), effort,
    env: env.split("\n").filter((line) => line.trim()).map((line) => {
      const at = line.indexOf("=");
      return at < 0 ? { name: line.trim(), value: "" } : { name: line.slice(0, at).trim(), value: line.slice(at + 1) };
    }),
    endpointEnv: endpoint.trim() || null,
    toolTimeoutSec: /^\d{1,5}$/u.test(timeout.trim()) ? Number(timeout.trim()) : Number.NaN,
  };
  const problem = customProviderProblem(draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  return (
    <FieldSet data-testid="agent-custom-provider" data-disabled={busy || undefined}>
      <FieldLegend variant="label">Custom CLI provider</FieldLegend>
      <FieldDescription>
        Any CLI that reads ssterm's MCP config and prints claude-style stream-json events. Nothing goes through a shell: give
        the binary's absolute path and one argument per line, including the flags that turn off its own local tools. ssterm
        runs an isolation check before first use and again whenever this definition, the binary or its version output
        changes; until a check passes it stays disabled.
      </FieldDescription>
      <Field>
        <FieldLabel htmlFor={`${id}-provider-label`}>Name</FieldLabel>
        <Input id={`${id}-provider-label`} value={label} maxLength={64} disabled={busy} autoComplete="off" onChange={(event) => setLabel(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-provider-path`}>Binary (absolute path)</FieldLabel>
        <Input id={`${id}-provider-path`} value={path} disabled={busy} autoComplete="off" spellCheck={false} placeholder="/opt/homebrew/bin/my-agent"
          onChange={(event) => setPath(event.target.value)} />
        <FieldDescription>
          Never a PATH lookup. Shells, env and script interpreters are refused to keep shell strings out; that list is a
          usability guard, not a security boundary: only the isolation check decides whether a provider runs.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-provider-args`}>Arguments (one per line)</FieldLabel>
        <Textarea id={`${id}-provider-args`} className="font-mono" value={args} disabled={busy} spellCheck={false}
          onChange={(event) => setArgs(event.target.value)} />
        <FieldDescription>
          Each line is one argument, passed as is; an empty line is an empty argument. Placeholders: {AGENT_CUSTOM_PLACEHOLDERS.map((name) => `{${name}}`).join(" ")}.
          {" {mcpConfigPath}"} is required. The prompt is never an argument: it goes to the CLI's standard input.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel id={`${id}-provider-input`}>Prompts</FieldLabel>
        <ToggleGroup aria-labelledby={`${id}-provider-input`} variant="outline" spacing={0} disabled={busy} value={[input]}
          onValueChange={(value) => { const next = value[0] as AgentCustomProvider["input"] | undefined; if (next) setInput(next); }}>
          <ToggleGroupItem value="stream-json">stream-json on stdin</ToggleGroupItem>
          <ToggleGroupItem value="one-shot">One process per message</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-provider-model`}>Model ({"{model}"})</FieldLabel>
        <Input id={`${id}-provider-model`} value={model} maxLength={64} disabled={busy} autoComplete="off" spellCheck={false} onChange={(event) => setModel(event.target.value)} />
      </Field>
      <Field>
        <FieldLabel id={`${id}-provider-effort`}>Effort ({"{effort}"})</FieldLabel>
        <ToggleGroup aria-labelledby={`${id}-provider-effort`} variant="outline" spacing={0} disabled={busy} value={[effort]}
          onValueChange={(value) => { const next = value[0] as AgentEffort | undefined; if (next) setEffort(next); }}>
          {AGENT_EFFORTS.map((value) => <ToggleGroupItem key={value} value={value}>{value}</ToggleGroupItem>)}
        </ToggleGroup>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-provider-env`}>Environment additions (NAME=value per line)</FieldLabel>
        <Textarea id={`${id}-provider-env`} className="font-mono" value={env} disabled={busy} spellCheck={false} onChange={(event) => setEnv(event.target.value)} />
        <FieldDescription>Added to ssterm's allowlisted environment. Stored in plain text: never put keys, tokens or passwords here.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-provider-endpoint`}>Test endpoint variable</FieldLabel>
        <Input id={`${id}-provider-endpoint`} value={endpoint} disabled={busy} autoComplete="off" spellCheck={false} placeholder="ANTHROPIC_BASE_URL"
          onChange={(event) => setEndpoint(event.target.value)} />
        <FieldDescription>
          The variable that sets the CLI's provider URL. During the check only, ssterm points it at a local test endpoint, so
          the check reaches no provider as long as the CLI honours it (if it does not, the check cannot judge it). Without
          one, the check needs a live call you agree to each time, and passes only as a weaker live-only check.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-provider-timeout`}>Client tool timeout (seconds)</FieldLabel>
        <Input id={`${id}-provider-timeout`} value={timeout} inputMode="numeric" disabled={busy} autoComplete="off" onChange={(event) => setTimeoutSec(event.target.value)} />
        <FieldDescription>
          How long this CLI waits for one ssterm tool call (many default to 60). A plan or command card expires 5 seconds
          before it, so you can never approve a call the CLI has stopped waiting for.
        </FieldDescription>
      </Field>
      {problem && (label || path || args) ? <FieldError>{problem}</FieldError> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || !!problem || !changed} onClick={() => onSave(draft)}>Save provider</Button>
        <Button size="sm" variant="outline" disabled={busy || !saved || changed} onClick={() => onCheck(false)}>Run isolation check</Button>
      </div>
      {saved && status ? (
        <div className="grid gap-1 text-sm" data-testid="agent-custom-status" data-status={status.status}>
          <p>{status.version ? `${status.version} · ` : ""}{customNotes[status.status] ?? providerNotes[status.status]}</p>
          {status.reasons.length ? <Reasons reasons={status.reasons} /> : null}
        </div>
      ) : null}
      {saved && !changed && !saved.endpointEnv && status?.status !== "ready" ? (
        <div className="grid gap-2 rounded-lg border border-border p-3" role="group" aria-label="Live isolation check">
          <Field orientation="horizontal">
            <Checkbox id={`${id}-provider-live`} checked={live} onCheckedChange={(value) => setLive(value === true)} />
            <FieldLabel htmlFor={`${id}-provider-live`}>
              Send two synthetic test prompts (one per role, with ssterm's built-in instructions only; your additional instructions are not included) to this
              CLI's provider for this check. A live-only pass is weaker: ssterm cannot see what the CLI sends.
            </FieldLabel>
          </Field>
          <Button size="sm" variant="outline" className="justify-self-start" disabled={busy || !live} onClick={() => { setLive(false); onCheck(true); }}>Run live check</Button>
        </div>
      ) : null}
    </FieldSet>
  );
}
