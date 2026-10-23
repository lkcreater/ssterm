import { useEffect, useId, useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import {
  AGENT_EFFORTS, AGENT_MODELS, isAgentModelId, MAX_AGENT_INSTRUCTIONS, type AgentEffort, type AgentProviderView, type AgentSettings as Settings,
  type AgentSettingsView, type ConfigureAgentResponse, type Owner,
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
  missing: "Not found. Install Claude Code with its native installer (~/.local/bin/claude) and sign in.",
  "unsupported-version": "This version has not passed ssterm's isolation check, so it cannot be used.",
  "not-native": "Only the native Claude Code binary can be used; a wrapper or script was found.",
  "managed-policy": "A managed Claude Code policy is installed on this Mac; ssterm cannot verify what it adds, so the agent stays off.",
  disabled: "Disabled: its isolation check failed (user-level AGENTS.md is always sent, apply_patch cannot be removed and sub-agent tools stay exposed).",
};

/** A3: exactly what leaves the Mac, shown before the agent can be turned on. */
export function AgentDisclosure() {
  return (
    <div className="grid gap-2 text-sm" data-testid="agent-disclosure">
      <p>
        The agent runs through your own <strong>claude</strong> CLI, so what it sends goes to <strong>Anthropic</strong> under your
        Claude account. That account's own retention and training terms apply; ssterm cannot change them.
      </p>
      <p className="font-medium">Sent to Anthropic for each conversation:</p>
      <ul className="list-disc pl-5">
        <li>your chat messages and the agent's replies;</li>
        <li>every command the agent runs and that command's full output (the last 64 KiB of each). Nothing is redacted;</li>
        <li>the bound server's label, user@host:port and environment, and your additional instructions (both go into the agent's system prompt);</li>
        <li>what the claude CLI adds itself: a temporary working-folder path, macOS version, platform, shell, the model, today's date, the CLI version and your signed-in account email.</li>
      </ul>
      <p className="font-medium">Never sent by ssterm:</p>
      <ul className="list-disc pl-5">
        <li>earlier terminal output, what you type in the terminal, other sessions, your saved servers, snippet contents, passwords and keys.</li>
      </ul>
      <p className="text-muted-foreground">
        Conversations are kept only in memory and the CLI runs without saving a transcript. Closing the panel, ending the
        session, locking the workspace or quitting ends the conversation.
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
  const enabled = !!view?.settings.enabled;
  const [custom, setCustom] = useState("");
  const save = async (changes: Partial<Settings>, consent = false) => {
    if (!view) return;
    setBusy(true);
    setProblem(undefined);
    const result = await window.ssterm?.configureAgent({
      owner: { windowId, generation }, consent, settings: { ...view.settings, ...changes, provider: "claude" },
    }).catch(() => undefined);
    setBusy(false);
    const outcome: ConfigureAgentResponse | undefined = result?.ok ? result.value : undefined;
    if (outcome?.status === "saved") {
      setView(outcome.view);
      setInstructions(outcome.view.settings.instructions);
      setConsenting(false);
      setAcknowledged(false);
    } else if (outcome?.status === "provider-unavailable") {
      setView(outcome.view);
      setProblem("The claude CLI is not available in a verified version, so the agent stays off.");
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
      {!view && !unavailable ? <p className="flex items-center gap-2 type-caption text-muted-foreground"><Spinner aria-hidden="true" /> Checking the claude CLI…</p> : null}
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
            <dd data-status={codex?.status}>{codex ? providerNotes[codex.status] : ""}</dd>
          </dl>
          {consenting && !enabled ? (
            <div className="grid gap-3 rounded-lg border border-border p-3" role="group" aria-label="Before you turn on the AI agent">
              <AgentDisclosure />
              <Field orientation="horizontal">
                <Checkbox id={`${id}-consent`} checked={acknowledged} onCheckedChange={(value) => setAcknowledged(value === true)} />
                <FieldLabel htmlFor={`${id}-consent`}>I understand what is sent to Anthropic</FieldLabel>
              </Field>
              <div className="flex gap-2">
                <Button size="sm" disabled={!acknowledged || busy || claude?.status !== "ready"} onClick={() => void save({ enabled: true, instructions }, true)}>
                  Turn on AI agent
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConsenting(false)}>Cancel</Button>
              </div>
            </div>
          ) : null}
          {enabled ? <AgentDisclosure /> : null}
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
          <ModelSettings id={id} view={view} busy={busy} custom={custom} onCustom={setCustom} onSave={(changes) => void save(changes)} />
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
