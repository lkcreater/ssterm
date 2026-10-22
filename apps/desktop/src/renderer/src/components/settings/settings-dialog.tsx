import { SyncSettings } from "@/components/sync/sync-settings";
import { useId, useState } from "react";
import { AlertCircleIcon, FileClockIcon } from "lucide-react";
import { RECORDING_BOUNDS, type Owner, type RecordingPolicy, type TerminalSettings } from "@ssterm/contracts";
import { SignInSettings } from "@/components/app-lock/sign-in-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useRecordings } from "@/hooks/use-recordings";
import { Drawer, useDrawerClose } from "@/components/drawer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { useSettings } from "@/hooks/use-settings";
import { effectiveScrollback, SCROLLBACK_BUDGET } from "@/lib/terminal-theme";

const cursors: { value: TerminalSettings["terminalCursor"]; label: string }[] = [
  { value: "block", label: "Block" },
  { value: "bar", label: "Bar" },
  { value: "underline", label: "Underline" },
];
const count = (value: number) => value.toLocaleString("en-US");

export type SettingsTab = "terminal" | "recording" | "security" | "sync";

/**
 * Settings drawer (SST-040/07): Terminal, Recording, Security and Sync tabs. Keyed by the caller per open. Panels stay
 * mounted while the drawer is open, so a catalog lock seen by Sync closes the drawer from any tab and drafts survive tab
 * switches; everything is dropped when the drawer closes. A running sync action keeps the drawer open.
 */
export function SettingsDrawer({
  onClose,
  settings: { settings, disabledReason, error, update },
  terminals,
  owner,
  tab = "terminal",
  onOpenRecordings,
}: {
  owner?: Owner;
  onClose(): void;
  settings: ReturnType<typeof useSettings>;
  /** Open terminals share the scrollback budget. */
  terminals: number;
  tab?: SettingsTab;
  onOpenRecordings?(): void;
}) {
  const id = useId();
  const [syncBusy, setSyncBusy] = useState(false);
  const close = useDrawerClose({ busy: syncBusy });
  const disabled = !!disabledReason;
  const perPane = effectiveScrollback(settings.terminalScrollback, terminals);
  return (
    <Drawer
      close={close}
      onClose={onClose}
      title="Settings"
      description="Saved on this Mac. Terminal changes apply to every open pane at once."
      className="max-w-[640px]"
      footer={
        <>
          {/* Visible from every tab: Done, Esc and the scrim wait for the running sync action. */}
          {syncBusy ? (
            <span role="status" className="mr-auto flex items-center gap-2 text-muted-foreground">
              <Spinner aria-hidden="true" /> Sync running
            </span>
          ) : null}
          <Button onClick={close.request} disabled={syncBusy}>Done</Button>
        </>
      }
    >
      <Tabs defaultValue={tab} className="gap-4">
        <TabsList className="w-full">
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="recording">Recording</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="sync">Sync</TabsTrigger>
        </TabsList>
        <TabsContent value="terminal" keepMounted className="grid gap-4">
          {disabledReason || error ? (
            <Alert variant={error ? "destructive" : "default"}>
              <AlertCircleIcon aria-hidden="true" />
              <AlertDescription>{disabledReason ?? error}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <NumberSetting
              id={`${id}-font`}
              label="Font size"
              unit="px"
              value={settings.terminalFontSize}
              min={10}
              max={32}
              disabled={disabled}
              onCommit={(terminalFontSize) => update({ terminalFontSize })}
            />
            <NumberSetting
              id={`${id}-scrollback`}
              label="Scrollback"
              unit="lines"
              value={settings.terminalScrollback}
              min={100}
              max={100_000}
              disabled={disabled}
              onCommit={(terminalScrollback) => update({ terminalScrollback })}
              description={
                (terminals === 0
                  ? ""
                  : `A change applies now to ${terminals === 1 ? "the open terminal" : `all ${terminals} open terminals`}, up to ${count(perPane)} lines ${terminals === 1 ? "" : "each "}(a lower value removes older lines). `) +
                `A new terminal keeps up to ${count(SCROLLBACK_BUDGET)} lines divided by the terminals then open; opening or closing others never changes it.`
              }
            />
            <Field data-disabled={disabled || undefined}>
              <FieldLabel id={`${id}-cursor`}>Cursor</FieldLabel>
              <ToggleGroup
                aria-labelledby={`${id}-cursor`}
                variant="outline"
                spacing={0}
                disabled={disabled}
                value={[settings.terminalCursor]}
                onValueChange={(value) => {
                  const terminalCursor = value[0] as TerminalSettings["terminalCursor"] | undefined;
                  if (terminalCursor) void update({ terminalCursor });
                }}
              >
                {cursors.map((cursor) => (
                  <ToggleGroupItem key={cursor.value} value={cursor.value}>
                    {cursor.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            <Field orientation="horizontal" data-disabled={disabled || undefined}>
              <Switch
                id={`${id}-blink`}
                aria-describedby={`${id}-blink-note`}
                disabled={disabled}
                checked={settings.terminalCursorBlink}
                onCheckedChange={(terminalCursorBlink) => void update({ terminalCursorBlink })}
              />
              <FieldContent>
                <FieldLabel htmlFor={`${id}-blink`}>Blinking cursor</FieldLabel>
                <FieldDescription id={`${id}-blink-note`}>
                  Stays steady while Reduce motion is on in macOS Accessibility settings.
                </FieldDescription>
              </FieldContent>
            </Field>
            <FieldSeparator />
            {/* Read-only: one terminal palette and one app theme ship (the stored palette value is unchanged). */}
            <dl className="settings-facts">
              <dt>Terminal colors</dt>
              <dd>Charcoal</dd>
              <dt>App theme</dt>
              <dd>Dark</dd>
            </dl>
          </FieldGroup>
        </TabsContent>
        <TabsContent value="recording" keepMounted>
          {owner ? (
            <RecordingSettings
              owner={owner}
              // Waits for a running sync action, whose reply (e.g. a one-time recovery secret) must not be dropped.
              openDisabled={syncBusy}
              onOpenRecordings={onOpenRecordings && (() => { close.discard(); onOpenRecordings(); })}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="security" keepMounted>
          {owner ? <SignInSettings owner={owner} /> : null}
        </TabsContent>
        <TabsContent value="sync" keepMounted>
          {/* A lock always closes, even mid-action (the action is fenced in main). */}
          {owner ? <SyncSettings owner={owner} onBusyChange={setSyncBusy} onLock={close.discard} /> : null}
        </TabsContent>
      </Tabs>
    </Drawer>
  );
}

const keyReasons: Record<string, string> = {
  locked: "The Keychain is locked. Unlock it and try again.",
  denied: "Keychain access was denied.",
  missing: "This workspace's encryption key is missing from the Keychain.",
  constraint: "This workspace has encrypted snippets but no key reference; recording cannot be enabled.",
};

/**
 * SST-034 Settings → Recording: both switches are off by default. Turning one on affects sessions started afterwards;
 * turning it off stops capture in running panes at once and keeps what was saved.
 */
function RecordingSettings({ owner, openDisabled, onOpenRecordings }: { owner: Owner; openDisabled: boolean; onOpenRecordings?(): void }) {
  const id = useId();
  const { state, unavailable, configure } = useRecordings(owner);
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const policy = state?.policy;
  const disabled = !policy || busy;
  async function save(changes: Partial<RecordingPolicy>) {
    if (!policy) return;
    setBusy(true);
    setProblem(undefined);
    const result = await configure({ ...policy, ...changes });
    setBusy(false);
    if (!result.ok) return setProblem("Recording settings could not be saved.");
    if (result.value.status === "key-unavailable") return setProblem(`Recording stays off: ${keyReasons[result.value.reason] ?? "secure storage is unavailable."}`);
    if (result.value.status === "failed") setProblem("Recording settings could not be saved: the recordings folder is unavailable.");
  }
  return (
    <FieldSet data-testid="recording-settings">
      <FieldLegend>Recording</FieldLegend>
      <FieldDescription>
        Off by default. Recordings are encrypted on this Mac and never sent anywhere. Typed input is never saved, so a
        password typed at a hidden prompt is not recorded; anything the terminal displays is, including echoed secrets.
      </FieldDescription>
      {problem || unavailable ? (
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertDescription>{problem ?? "Recording settings are unavailable."}</AlertDescription>
        </Alert>
      ) : null}
      <Field orientation="horizontal" data-disabled={disabled || undefined}>
        <Switch id={`${id}-logs`} aria-describedby={`${id}-logs-note`} disabled={disabled} checked={!!policy?.logs}
          onCheckedChange={(logs) => void save({ logs })} />
        <FieldContent>
          <FieldLabel htmlFor={`${id}-logs`}>Record session output</FieldLabel>
          <FieldDescription id={`${id}-logs-note`}>
            Saves what each new terminal shows. A recording pane shows Recording; turning this off stops it at once.
          </FieldDescription>
        </FieldContent>
      </Field>
      <Field orientation="horizontal" data-disabled={disabled || undefined}>
        <Switch id={`${id}-history`} aria-describedby={`${id}-history-note`} disabled={disabled} checked={!!policy?.history}
          onCheckedChange={(history) => void save({ history })} />
        <FieldContent>
          <FieldLabel htmlFor={`${id}-history`}>Keep command history</FieldLabel>
          <FieldDescription id={`${id}-history-note`}>
            Saves each command line a shell with the ssterm integration reports, and offers them with ⌘; at the prompt.
            Lines starting with a space, multi-line and credential-shaped lines are skipped.
          </FieldDescription>
        </FieldContent>
      </Field>
      {policy ? (
        <>
          <NumberSetting id={`${id}-log-days`} label="Logs kept for" unit="days" value={policy.logDays} min={RECORDING_BOUNDS.logDays[0]}
            max={RECORDING_BOUNDS.logDays[1]} disabled={disabled} onCommit={(logDays) => save({ logDays })} />
          <NumberSetting id={`${id}-log-mib`} label="Session log storage" unit="MiB" value={policy.logMiB} min={RECORDING_BOUNDS.logMiB[0]}
            max={RECORDING_BOUNDS.logMiB[1]} disabled={disabled} onCommit={(logMiB) => save({ logMiB })}
            description="The oldest logs are removed first; a single log that reaches this size stops recording." />
          <NumberSetting id={`${id}-history-days`} label="History kept for" unit="days" value={policy.historyDays}
            min={RECORDING_BOUNDS.historyDays[0]} max={RECORDING_BOUNDS.historyDays[1]} disabled={disabled}
            onCommit={(historyDays) => save({ historyDays })} />
          <NumberSetting id={`${id}-history-mib`} label="History storage" unit="MiB" value={policy.historyMiB}
            min={RECORDING_BOUNDS.historyMiB[0]} max={RECORDING_BOUNDS.historyMiB[1]} disabled={disabled}
            onCommit={(historyMiB) => save({ historyMiB })} />
        </>
      ) : null}
      {onOpenRecordings ? (
        <Button variant="outline" size="sm" className="justify-self-start" disabled={openDisabled} onClick={onOpenRecordings}>
          <FileClockIcon data-icon="inline-start" aria-hidden="true" /> Manage recordings and shell integration
        </Button>
      ) : null}
    </FieldSet>
  );
}

/** Saves on blur or Enter; an out-of-range entry stays in the field with its error and is not saved. */
function NumberSetting({
  id,
  label,
  unit,
  value,
  min,
  max,
  disabled,
  description,
  onCommit,
}: {
  id: string;
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  description?: string;
  onCommit(value: number): unknown;
}) {
  const [draft, setDraft] = useState(String(value));
  const [shown, setShown] = useState(value);
  const [invalid, setInvalid] = useState(false);
  // A saved, reverted or externally loaded value replaces the draft.
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
    setInvalid(false);
  }
  const commit = () => {
    const next = Number(draft.trim());
    const ok = draft.trim() !== "" && Number.isInteger(next) && next >= min && next <= max;
    setInvalid(!ok);
    if (ok && next !== value) void onCommit(next);
  };
  return (
    <Field data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>
        {label} <span className="text-muted-foreground">({unit})</span>
      </FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        className="w-32"
        value={draft}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={`${id}-help`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          commit();
        }}
      />
      <FieldDescription id={`${id}-help`}>
        {count(min)}–{count(max)}.{description ? ` ${description}` : ""}
      </FieldDescription>
      {invalid ? <FieldError>Enter a whole number from {count(min)} to {count(max)}.</FieldError> : null}
    </Field>
  );
}
