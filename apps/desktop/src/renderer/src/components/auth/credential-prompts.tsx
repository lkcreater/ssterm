import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import type { CredentialFieldId, CredentialPrompt, CredentialState, Owner } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Drawer, useDrawerClose } from "@/components/drawer";
import { Spinner } from "@/components/ui/spinner";

/** The session's terminal input, only while the terminals view is showing. */
export function paneInput(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.terminal-workspace:not([hidden]) section[data-session-id="${CSS.escape(sessionId)}"] .xterm-helper-textarea`,
  );
}
/** Base UI finalFocus: where focus was when the prompt opened, else the session's terminal, else the default. */
export function promptFinalFocus(previous: HTMLElement | null, sessionId: string) {
  return () =>
    (previous?.isConnected && previous !== document.body ? previous : paneInput(sessionId)) ?? true;
}
export function CredentialPrompts({ state }: { state?: CredentialState }) {
  const prompt = state?.prompts[0];
  return prompt && state ? <CredentialPromptDialog key={`${state.owner.windowId}:${state.owner.generation}:${prompt.sessionId}:${prompt.generation}:${prompt.promptId}`}
    owner={state.owner} prompt={prompt} available={state.availability === "ready"} /> : null;
}
const label = (id: CredentialFieldId) => id === "password" ? "Password" : id === "passphrase" ? "Passphrase" : `Response ${id.slice(-1)}`;
function CredentialPromptDialog({ owner, prompt, available }: { owner: Owner; prompt: CredentialPrompt; available: boolean }) {
  const inputs = useRef(new Map<CredentialFieldId, HTMLInputElement>());
  const first = useRef<HTMLInputElement | null>(null);
  const callbacks = useRef(new Map<CredentialFieldId, (input: HTMLInputElement | null) => void>());
  // Ref identities stay stable while unrelated session events update this prompt's projection.
  // Detaching an actual input still clears its DOM value before releasing the reference.
  const inputRef = (id: CredentialFieldId, index: number) => {
    let callback = callbacks.current.get(id);
    if (!callback) {
      callback = (input) => {
        if (input) inputs.current.set(id, input);
        else {
          const previous = inputs.current.get(id);
          if (previous) previous.value = "";
          inputs.current.delete(id);
        }
        if (index === 0) first.current = input;
      };
      callbacks.current.set(id, callback);
    }
    return callback;
  };
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const live = useRef(true);
  const busyRef = useRef(false);
  const composing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<false | "limit" | "request">(false);
  const clear = () => { for (const input of inputs.current.values()) input.value = ""; };
  useEffect(() => {
    live.current = true;
    const fields = inputs.current;
    return () => {
      live.current = false;
      for (const input of fields.values()) input.value = "";
    };
  }, []);
  async function act(cancel: boolean) {
    if (!window.ssterm || busyRef.current || (!available && !cancel)) { clear(); return; }
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    const values = cancel ? [] : prompt.fields.map((field) => ({ id: field.id, value: new TextEncoder().encode(inputs.current.get(field.id)?.value ?? "") }));
    clear();
    try {
      const totalBytes = values.reduce((total, field) => total + field.value.byteLength, 0);
      if (values.some((field) => field.value.byteLength > 16 * 1024) || totalBytes > 64 * 1024) {
        setFailed("limit");
        busyRef.current = false;
        setBusy(false);
        first.current?.focus();
        return;
      }
      const identity = { owner, sessionId: prompt.sessionId, generation: prompt.generation, promptId: prompt.promptId };
      const result = cancel ? await window.ssterm.cancelCredentialPrompt(identity) : await window.ssterm.answerCredentials({ ...identity, values });
      if (!result.ok && live.current) {
        setFailed("request");
        busyRef.current = false;
        setBusy(false);
        first.current?.focus();
      }
    } catch {
      if (live.current) { setFailed("request"); busyRef.current = false; setBusy(false); }
    } finally { for (const field of values) field.value.fill(0); }
  }
  // Esc and × cancel the prompt (a scrim click does nothing) (as Cancel does); main then removes it, which unmounts this drawer.
  const close = { ...useDrawerClose(), request() { clear(); void act(true); } };
  const formId = useId();
  return <Drawer close={close} onClose={() => undefined} dismissOnScrim={false} initialFocus={first} finalFocus={promptFinalFocus(returnFocus.current, prompt.sessionId)}
    data-testid="credential-prompt-dialog" title="SSH authentication"
    target={<><span className="min-w-0 break-all font-medium text-foreground">{prompt.targetLabel}</span>
      {prompt.environment ? <Badge variant={prompt.environment === "PROD" ? "production" : "outline"}>{prompt.environment}</Badge> : null}
      <span className="min-w-0 break-all font-mono">{prompt.username ? `${prompt.username}@` : ""}{prompt.endpointHost}:{prompt.endpointPort}</span></>}
    description={`${prompt.purpose === "passphrase" ? "Unlock your imported private key for this connection." : prompt.purpose === "password" ? "Enter the password for this connection." : "Respond to the server's authentication challenge."} Attempt ${prompt.attempt} of 3.`}
    footer={<>
      <Button type="button" variant="outline" disabled={busy} onClick={() => void act(true)}>Cancel</Button>
      <Button type="submit" form={formId} disabled={busy || !available}>{busy ? <Spinner data-icon="inline-start" /> : null}Continue</Button>
    </>}>
    <form id={formId} className="grid min-w-0 gap-4" autoComplete="off"
      onSubmit={(event) => { event.preventDefault(); if (!composing.current) void act(false); }}
      onKeyDown={(event) => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}>
      {prompt.jumpFor ? <p className="type-caption min-w-0 break-all text-muted-foreground" data-testid="credential-jump-for">Jump host on the way to {prompt.jumpFor}. These credentials are used for the jump host only.</p> : null}
      <FieldGroup>{prompt.fields.map((field, index) => <Field key={field.id} data-disabled={busy || undefined}>
        <FieldLabel htmlFor={`credential-${field.id}`}>{label(field.id)}</FieldLabel>
        <Input id={`credential-${field.id}`} name={field.id} type={field.echo ? "text" : "password"} autoComplete="off" spellCheck={false} autoCapitalize="none"
          ref={inputRef(field.id, index)}
          disabled={busy || !available} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      </Field>)}</FieldGroup>
      {failed || !available ? <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>{failed === "limit" ? "Authentication responses are too long" : "Authentication could not continue"}</AlertTitle><AlertDescription>{failed === "limit" ? "Each response must be 16 KiB or less, and all responses together must be 64 KiB or less. Fields were cleared. Enter shorter responses." : "The prompt or connection may have changed. Review the current state and try again."}</AlertDescription></Alert> : null}
    </form>
  </Drawer>;
}
