import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, KeyRoundIcon, LockKeyholeIcon, TriangleAlertIcon } from "lucide-react";
import {
  passwordSetupErrors, recoveryCodeSchema,
  type AppLockFieldErrors, type AppLockStatus, type AttemptResponse, type GoogleFailure, type Owner,
} from "@ssterm/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { call, copyText, imeEnterGuard } from "@/components/identities/secret-input";
import iconLogo from "@/assets/icon-logo.png";

export const googleFailureText: Record<GoogleFailure, string> = {
  cancelled: "Sign-in was cancelled.",
  timeout: "Google did not answer within 5 minutes. Try again.",
  "port-in-use": "Another app is using port 55411 on this Mac, which Google sign-in needs. Close it and try again.",
  "wrong-account": "That Google account is not the one this Mac was set up with.",
  denied: "Google did not complete the sign-in.",
  network: "Google cannot be reached right now.",
  "invalid-response": "Google's answer could not be verified. Try again.",
  unavailable: "Google sign-in is unavailable right now.",
  "not-allowed": "Google sign-in is not available here.",
};
const attemptText = (result: AttemptResponse | undefined, fallback: string): string | undefined => {
  if (!result) return "ssterm is unavailable right now. Try again.";
  if (result.status === "rejected") return fallback;
  if (result.status === "store-unavailable") return "The macOS Keychain could not be used. Unlock it and try again.";
  if (result.status === "not-allowed") return "This action is not available now.";
  return undefined;
};

function Screen({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <main className="app-lock-screen" data-testid="app-lock">
      <section className="app-lock-card" aria-labelledby="app-lock-title">
        <img src={iconLogo} alt="" className="app-lock-logo" />
        <h1 id="app-lock-title" className="type-title">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
        {children}
      </section>
    </main>
  );
}
function Problem({ text }: { text?: string }) {
  return text ? (
    <Alert variant="destructive" role="alert">
      <TriangleAlertIcon aria-hidden="true" />
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  ) : null;
}
function useCountdown(ms: number) {
  const [until, setUntil] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => { if (ms > 0) setUntil(Date.now() + ms); }, [ms]);
  const left = Math.max(0, until - Date.now());
  useEffect(() => {
    if (!left) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.min(left, 500));
    return () => clearTimeout(timer);
  });
  return Math.ceil(left / 1000);
}

/** Google sign-in through the system browser; Cancel stops the local callback listener. */
export function GoogleButton({ owner, purpose, label, disabled, onDone }: {
  owner: Owner;
  purpose: "setup" | "unlock" | "confirm";
  label: string;
  disabled?: boolean;
  onDone(result: { ok: true; recoveryCode?: string } | { ok: false; text: string; grace: boolean }): void;
}) {
  const [waiting, setWaiting] = useState(false);
  async function start() {
    setWaiting(true);
    const result = await call((bridge) => bridge.googleSignIn({ owner, purpose }));
    setWaiting(false);
    if (!result.ok) return onDone({ ok: false, text: "ssterm is unavailable right now. Try again.", grace: false });
    const value = result.value;
    if (value.status === "failed") return onDone({ ok: false, text: googleFailureText[value.code], grace: value.graceAvailable });
    onDone({ ok: true, recoveryCode: value.status === "configured" ? value.recoveryCode : undefined });
  }
  return waiting ? (
    <div className="grid gap-2" role="status">
      <span className="flex items-center gap-2 text-sm"><Spinner aria-hidden="true" /> Waiting for Google in your browser…</span>
      <Button variant="outline" onClick={() => void call((bridge) => bridge.cancelGoogleSignIn({ owner }))}>Cancel</Button>
    </div>
  ) : (
    <Button variant="outline" disabled={disabled} onClick={() => void start()}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4"><path fill="currentColor" d="M21.35 11.1H12v2.98h5.35c-.23 1.4-1.66 4.1-5.35 4.1a5.98 5.98 0 0 1 0-11.96c1.84 0 3.07.78 3.78 1.46l2.58-2.49A9.3 9.3 0 0 0 12 2.7a9.3 9.3 0 1 0 0 18.6c5.37 0 8.93-3.77 8.93-9.09 0-.61-.07-1.08-.16-1.55z" /></svg>
      {label}
    </Button>
  );
}

/** Username, password and confirmation, validated with the shared zod schema before main checks it again. */
export function PasswordSetupForm({ owner, initialUsername = "", submitLabel, onConfigured }: {
  owner: Owner;
  initialUsername?: string;
  submitLabel: string;
  onConfigured(recoveryCode: string): void;
}) {
  const [values, setValues] = useState({ username: initialUsername, password: "", confirmPassword: "" });
  const [errors, setErrors] = useState<AppLockFieldErrors>({});
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const field = (name: keyof typeof values) => ({
    id: `app-lock-${name}`,
    value: values[name],
    "aria-invalid": errors[name] ? true : undefined,
    onKeyDown: imeEnterGuard,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setValues((current) => ({ ...current, [name]: event.target.value }));
      setErrors((current) => ({ ...current, [name]: undefined }));
    },
  });
  async function submit() {
    if (busy) return;
    const invalid = passwordSetupErrors(values);
    if (invalid) {
      setErrors(invalid);
      return first.current?.focus();
    }
    setBusy(true);
    setProblem(undefined);
    const result = await call((bridge) => bridge.setupAppLockPassword({ owner, ...values }));
    setBusy(false);
    // Typed passwords never outlive a final answer.
    if (!result.ok || result.value.status !== "invalid") setValues((current) => ({ ...current, password: "", confirmPassword: "" }));
    if (!result.ok) return setProblem("ssterm is unavailable right now. Try again.");
    if (result.value.status === "invalid") return setErrors(result.value.fields);
    if (result.value.status !== "configured")
      return setProblem(result.value.status === "store-unavailable" ? "The macOS Keychain could not save it. Unlock the Keychain and try again." : "This action is not available now.");
    setValues({ username: "", password: "", confirmPassword: "" });
    onConfigured(result.value.recoveryCode);
  }
  return (
    <form className="grid gap-4" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Problem text={problem} />
      <Field data-invalid={errors.username ? true : undefined}>
        <FieldLabel htmlFor="app-lock-username">User name</FieldLabel>
        <Input ref={first} autoComplete="username" spellCheck={false} autoCapitalize="none" {...field("username")} />
        {errors.username ? <FieldError>{errors.username}</FieldError> : null}
      </Field>
      <Field data-invalid={errors.password ? true : undefined}>
        <FieldLabel htmlFor="app-lock-password">Password</FieldLabel>
        <Input type="password" autoComplete="new-password" {...field("password")} />
        <FieldDescription>At least 12 characters. It unlocks ssterm on this Mac; it does not encrypt your files.</FieldDescription>
        {errors.password ? <FieldError>{errors.password}</FieldError> : null}
      </Field>
      <Field data-invalid={errors.confirmPassword ? true : undefined}>
        <FieldLabel htmlFor="app-lock-confirmPassword">Confirm password</FieldLabel>
        <Input type="password" autoComplete="new-password" {...field("confirmPassword")} />
        {errors.confirmPassword ? <FieldError>{errors.confirmPassword}</FieldError> : null}
      </Field>
      <Button type="submit" disabled={busy}>{busy ? <Spinner data-icon="inline-start" /> : null}{submitLabel}</Button>
    </form>
  );
}

/** Shown once; continuing requires acknowledging it was saved. */
export function RecoveryCodeView({ code, onContinue }: { code: string; onContinue(): void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-4" data-testid="recovery-code">
      <code className="app-lock-code" aria-label="Recovery code">{code}</code>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setCopied(copyText(code))}>
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}{copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox checked={saved} onCheckedChange={(value) => setSaved(value === true)} aria-label="I saved the recovery code" />
        <span>I saved this code somewhere safe. It is the only way back in if I forget my sign-in.</span>
      </label>
      <Button disabled={!saved} onClick={onContinue}>Continue</Button>
    </div>
  );
}

/**
 * The app lock (SST-039): nothing else renders, and main serves no feature IPC, until this window's process is unlocked.
 */
export function AppLockGate({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState<Owner>();
  const [status, setStatus] = useState<AppLockStatus>();
  const [failed, setFailed] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string>();
  const refresh = useCallback(async (current: Owner) => {
    const result = await call((bridge) => bridge.appLockState({ owner: current }));
    if (result.ok) setStatus(result.value);
    else setFailed(true);
  }, []);
  useEffect(() => {
    void call((bridge) => bridge.bootstrap()).then((result) => {
      if (!result.ok) return setFailed(true);
      setOwner(result.value.owner);
      void refresh(result.value.owner);
    });
  }, [refresh]);

  if (recoveryCode)
    return (
      <Screen title="Save your recovery code" description="Use it if you forget your password or lose access to your Google account. It is shown only now.">
        <RecoveryCodeView code={recoveryCode} onContinue={() => { setRecoveryCode(undefined); if (owner) void refresh(owner); }} />
      </Screen>
    );
  if (status?.phase === "unlocked") return <>{children}</>;
  if (failed || status?.phase === "unavailable")
    return (
      <Screen title="ssterm cannot check your sign-in" description="The sign-in record in the macOS Keychain could not be read. Unlock the Keychain or allow ssterm to use it, then try again.">
        <Button onClick={() => { setFailed(false); if (owner) void refresh(owner); }}>Try again</Button>
      </Screen>
    );
  if (!owner || !status)
    return (
      <main className="app-lock-screen"><span className="flex items-center gap-2"><Spinner /> Opening ssterm</span></main>
    );
  if (status.phase === "setup") return <SetupScreen owner={owner} status={status} onConfigured={setRecoveryCode} onDone={() => void refresh(owner)} />;
  return <UnlockScreen owner={owner} status={status} onChange={() => void refresh(owner)} />;
}

function SetupScreen({ owner, status, onConfigured, onDone }: { owner: Owner; status: AppLockStatus; onConfigured(code: string): void; onDone(): void }) {
  const [problem, setProblem] = useState<string>();
  return (
    <Screen
      title={status.recovering ? "Set up sign-in again" : "Set up sign-in"}
      description={status.recovering
        ? "Your recovery code was accepted. Choose how to unlock ssterm from now on; you will get a new recovery code."
        : "Choose how ssterm unlocks when it opens. Your servers and keys stay on this Mac."}
    >
      <PasswordSetupForm owner={owner} submitLabel="Create password" onConfigured={onConfigured} />
      <div className="app-lock-divider"><span>or</span></div>
      <Problem text={problem} />
      <GoogleButton
        owner={owner}
        purpose="setup"
        label="Sign in with Google"
        disabled={!status.googleAvailable}
        onDone={(result) => {
          if (!result.ok) return setProblem(result.text);
          if (result.recoveryCode) onConfigured(result.recoveryCode);
          else onDone();
        }}
      />
      {status.googleAvailable ? null : <p className="type-caption text-muted-foreground">Google sign-in is not configured in this build.</p>}
    </Screen>
  );
}

function UnlockScreen({ owner, status, onChange }: { owner: Owner; status: AppLockStatus; onChange(): void }) {
  // No method: the profile says a lock was set up but its Keychain record is gone; only the recovery code helps.
  const recordMissing = status.method === null;
  const [mode, setMode] = useState<"main" | "recover">(recordMissing ? "recover" : "main");
  const [username, setUsername] = useState(status.username ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string>();
  const [grace, setGrace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(status.retryAfterMs);
  const wait = useCountdown(retry);
  const passwordInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (status.method === "password") passwordInput.current?.focus(); }, [status.method]);
  const finish = (result: AttemptResponse | undefined, fallback: string) => {
    const text = attemptText(result, fallback);
    if (result?.status === "rejected") setRetry(result.retryAfterMs);
    if (text) return setProblem(text);
    onChange();
  };
  async function unlock() {
    if (busy || wait) return;
    setBusy(true);
    setProblem(undefined);
    const result = await call((bridge) => bridge.unlockAppLock({ owner, username, password }));
    setBusy(false);
    setPassword("");
    finish(result.ok ? result.value : undefined, "The user name or password is incorrect.");
    passwordInput.current?.focus();
  }
  async function recover() {
    if (busy || wait) return;
    const parsed = recoveryCodeSchema.safeParse(code);
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? "Enter the recovery code.");
    setBusy(true);
    setProblem(undefined);
    const result = await call((bridge) => bridge.recoverAppLock({ owner, code: parsed.data }));
    setBusy(false);
    finish(result.ok ? result.value : undefined, "That recovery code is not correct.");
  }
  async function offline() {
    const result = await call((bridge) => bridge.unlockAppLockOffline({ owner }));
    if (result.ok && result.value.status === "unlocked") return onChange();
    setGrace(false);
    setProblem(result.ok && result.value.status === "failed" && result.value.code === "online"
      ? "Google can be reached now. Sign in with Google."
      : "The offline period has ended. Connect to the internet and sign in with Google, or use your recovery code.");
  }
  const waitText = wait ? `Try again in ${wait} s.` : undefined;
  return (
    <Screen
      title="Unlock ssterm"
      description={recordMissing ? "The sign-in record for this Mac is missing from the Keychain. Enter the recovery code you saved to set up sign-in again."
        : mode === "recover" ? "Enter the recovery code you saved when you set up sign-in."
        : status.method === "google" ? `Sign in with the Google account ${status.googleEmail ?? ""} to continue.`
        : "Enter your ssterm password to continue."}
    >
      <Problem text={problem} />
      {mode === "recover" ? (
        <form className="grid gap-3" noValidate onSubmit={(event) => { event.preventDefault(); void recover(); }}>
          <Field>
            <FieldLabel htmlFor="app-lock-recovery">Recovery code</FieldLabel>
            <Input id="app-lock-recovery" value={code} autoComplete="off" spellCheck={false} autoCapitalize="characters"
              className="font-mono" onKeyDown={imeEnterGuard} onChange={(event) => setCode(event.target.value)} />
            {waitText ? <FieldDescription>{waitText}</FieldDescription> : null}
          </Field>
          <Button type="submit" disabled={busy || !!wait}>{busy ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}Use recovery code</Button>
          {recordMissing ? null : <Button type="button" variant="ghost" onClick={() => { setMode("main"); setProblem(undefined); }}>Back</Button>}
        </form>
      ) : status.method === "google" ? (
        <div className="grid gap-3">
          <GoogleButton owner={owner} purpose="unlock" label="Sign in with Google" onDone={(result) => {
            if (result.ok) return onChange();
            setProblem(result.text);
            setGrace(result.grace);
          }} />
          {grace ? <Button variant="outline" onClick={() => void offline()}>Continue offline (recent Google sign-in)</Button> : null}
        </div>
      ) : (
        <form className="grid gap-3" noValidate onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
          <Field>
            <FieldLabel htmlFor="app-lock-unlock-username">User name</FieldLabel>
            <Input id="app-lock-unlock-username" value={username} autoComplete="username" spellCheck={false} autoCapitalize="none"
              onKeyDown={imeEnterGuard} onChange={(event) => setUsername(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="app-lock-unlock-password">Password</FieldLabel>
            <Input ref={passwordInput} id="app-lock-unlock-password" type="password" value={password} autoComplete="current-password"
              onKeyDown={imeEnterGuard} onChange={(event) => setPassword(event.target.value)} />
            {waitText ? <FieldDescription>{waitText}</FieldDescription> : null}
          </Field>
          <Button type="submit" disabled={busy || !!wait || !password}>{busy ? <Spinner data-icon="inline-start" /> : <LockKeyholeIcon data-icon="inline-start" />}Unlock</Button>
        </form>
      )}
      {mode === "main" ? (
        <Button variant="link" className="justify-self-start px-0" onClick={() => { setMode("recover"); setProblem(undefined); }}>
          Forgot? Use a recovery code
        </Button>
      ) : null}
    </Screen>
  );
}
