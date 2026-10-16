import { useEffect, useRef, useState } from "react";
import { AlertTriangleIcon } from "lucide-react";
import type { CredentialFieldId, CredentialPrompt, CredentialState, Owner } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

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
  return <Dialog open onOpenChange={(open) => { if (!open) { clear(); void act(true); } }}>
    <DialogContent initialFocus={first} finalFocus={returnFocus} showCloseButton={false}
      className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg motion-reduce:animate-none" data-testid="credential-prompt-dialog">
      <DialogHeader>
        <DialogTitle>SSH authentication</DialogTitle>
        <DialogDescription>{prompt.purpose === "passphrase" ? "Unlock your imported private key for this connection." : prompt.purpose === "password" ? "Enter the password for this connection." : "Respond to the server's authentication challenge."} Attempt {prompt.attempt} of 3.</DialogDescription>
      </DialogHeader>
      <form className="flex min-h-0 flex-col gap-4" autoComplete="off"
        onSubmit={(event) => { event.preventDefault(); if (!composing.current) void act(false); }}
        onKeyDown={(event) => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}>
        <div className="-mx-4 flex min-h-0 flex-col gap-4 overflow-y-auto px-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 break-all font-medium">{prompt.targetLabel}</span>
            {prompt.environment ? <Badge variant={prompt.environment === "PROD" ? "production" : "outline"}>{prompt.environment}</Badge> : null}</div>
          <p className="min-w-0 break-all font-mono text-sm">{prompt.username ? `${prompt.username}@` : ""}{prompt.endpointHost}:{prompt.endpointPort}</p>
          <FieldGroup>{prompt.fields.map((field, index) => <Field key={field.id} data-disabled={busy || undefined}>
            <FieldLabel htmlFor={`credential-${field.id}`}>{label(field.id)}</FieldLabel>
            <Input id={`credential-${field.id}`} name={field.id} type={field.echo ? "text" : "password"} autoComplete="off" spellCheck={false} autoCapitalize="none"
              ref={inputRef(field.id, index)}
              disabled={busy || !available} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
          </Field>)}</FieldGroup>
          {failed || !available ? <Alert variant="destructive"><AlertTriangleIcon /><AlertTitle>{failed === "limit" ? "Authentication responses are too long" : "Authentication could not continue"}</AlertTitle><AlertDescription>{failed === "limit" ? "Each response must be 16 KiB or less, and all responses together must be 64 KiB or less. Fields were cleared. Enter shorter responses." : "The prompt or connection may have changed. Review the current state and try again."}</AlertDescription></Alert> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void act(true)}>Cancel</Button>
          <Button type="submit" disabled={busy || !available}>{busy ? <Spinner data-icon="inline-start" /> : null}Continue</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
