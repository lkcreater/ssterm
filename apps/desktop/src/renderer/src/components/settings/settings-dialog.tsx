import { useId, useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import type { Owner, TerminalSettings } from "@ssterm/contracts";
import { SignInSettings } from "@/components/app-lock/sign-in-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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

/** Terminal settings. Every change applies to open panes at once and is saved for this Mac. */
export function SettingsDialog({
  open,
  onOpenChange,
  settings: { settings, disabledReason, error, update },
  terminals,
  owner,
}: {
  owner?: Owner;
  open: boolean;
  onOpenChange(open: boolean): void;
  settings: ReturnType<typeof useSettings>;
  /** Open terminals share the scrollback budget. */
  terminals: number;
}) {
  const id = useId();
  const disabled = !!disabledReason;
  const perPane = effectiveScrollback(settings.terminalScrollback, terminals);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100%-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Terminal settings apply to every open pane and are saved on this Mac.</DialogDescription>
        </DialogHeader>
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
          <dl className="settings-facts">
            <dt>Terminal colors</dt>
            <dd>Signal Blue Dark</dd>
            <dt>App theme</dt>
            <dd>Dark</dd>
          </dl>
          {owner ? <SignInSettings owner={owner} /> : null}
        </FieldGroup>
      </DialogContent>
    </Dialog>
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
