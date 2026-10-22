import { useEffect, useState } from "react";
import type { AppLockStatus, Owner } from "@ssterm/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { call, imeEnterGuard } from "@/components/identities/secret-input";
import { GoogleButton, PasswordSetupForm, RecoveryCodeView } from "./app-lock-gate";

type Step = "idle" | "confirmed" | "password" | { code: string };

/** Settings → Sign-in: every change first re-confirms the current method (main grants a 2-minute window). */
export function SignInSettings({ owner }: { owner: Owner }) {
  const [status, setStatus] = useState<AppLockStatus>();
  const [step, setStep] = useState<Step>("idle");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const refresh = () => void call((bridge) => bridge.appLockState({ owner })).then((result) => { if (result.ok) setStatus(result.value); });
  useEffect(refresh, [owner.windowId, owner.generation]);
  if (!status) return null;
  // Test profiles run without the lock; there is nothing to manage.
  if (!status.method) return <p className="text-muted-foreground" data-testid="sign-in-settings">The app lock is off for this profile.</p>;
  const done = (code?: string) => {
    setProblem(undefined);
    setStep(code ? { code } : "idle");
    refresh();
  };
  async function confirm() {
    if (busy) return;
    setBusy(true);
    const result = await call((bridge) => bridge.confirmAppLockPassword({ owner, password }));
    setBusy(false);
    setPassword("");
    if (result.ok && result.value.status === "confirmed") return setStep("confirmed");
    setProblem(result.ok && result.value.status === "rejected" ? `The password is incorrect. Try again in ${Math.ceil(result.value.retryAfterMs / 1000)} s.` : "Sign-in settings are unavailable right now.");
  }
  async function regenerate() {
    const result = await call((bridge) => bridge.regenerateRecoveryCode({ owner }));
    if (result.ok && result.value.status === "regenerated") return done(result.value.recoveryCode);
    setStep("idle");
    setProblem("Confirm again, then create the new code.");
  }
  const current = status.method === "google" ? `Google · ${status.googleEmail ?? ""}` : `Password · ${status.username ?? ""}`;
  return (
    <section className="grid gap-3" aria-labelledby="sign-in-settings" data-testid="sign-in-settings">
      <h3 id="sign-in-settings" className="type-label">Sign-in</h3>
      <p className="text-sm"><span className="text-muted-foreground">ssterm unlocks with </span>{current}</p>
      {problem ? <Alert variant="destructive"><AlertDescription>{problem}</AlertDescription></Alert> : null}
      {typeof step === "object" ? (
        <RecoveryCodeView code={step.code} onContinue={() => setStep("idle")} />
      ) : step === "password" ? (
        <PasswordSetupForm owner={owner} initialUsername={status.username ?? ""} submitLabel="Save password" onConfigured={(code) => done(code)} />
      ) : step === "confirmed" ? (
        <div className="grid gap-2">
          <Button variant="outline" onClick={() => setStep("password")}>{status.method === "password" ? "Change password" : "Use a password instead"}</Button>
          {status.method === "password" ? (
            <GoogleButton owner={owner} purpose="setup" label="Use Google instead" disabled={!status.googleAvailable}
              onDone={(result) => (result.ok ? done(result.recoveryCode) : setProblem(result.text))} />
          ) : null}
          <Button variant="outline" onClick={() => void regenerate()}>New recovery code</Button>
        </div>
      ) : status.method === "password" ? (
        <form className="grid gap-2" noValidate onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
          <Field>
            <FieldLabel htmlFor="sign-in-current">Current password</FieldLabel>
            <Input id="sign-in-current" type="password" value={password} autoComplete="current-password" onKeyDown={imeEnterGuard}
              onChange={(event) => setPassword(event.target.value)} />
            <FieldDescription>Confirm to change the password, switch to Google or create a new recovery code.</FieldDescription>
          </Field>
          <Button type="submit" variant="outline" disabled={busy || !password}>{busy ? <Spinner data-icon="inline-start" /> : null}Confirm</Button>
        </form>
      ) : (
        <GoogleButton owner={owner} purpose="confirm" label="Confirm with Google"
          onDone={(result) => (result.ok ? setStep("confirmed") : setProblem(result.text))} />
      )}
    </section>
  );
}
