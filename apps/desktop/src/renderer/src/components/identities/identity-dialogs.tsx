import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangleIcon, FileKeyIcon, RotateCwIcon } from "lucide-react";
import type { CatalogIdentity, CatalogIdentityImpact, CatalogState, IdentityMethod, Owner } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Drawer, useDrawerClose } from "@/components/drawer";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DeleteFailure, useDelete } from "@/components/catalog/delete-dialogs";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import type { Catalog } from "@/hooks/use-catalog";
import { draftsEqual, serverFieldErrors, type FieldErrors } from "@/lib/catalog-validation";
import {
  algorithmLabel,
  identityDraft,
  identityErrors,
  identityIntent,
  methodLabels,
  secretStoreText,
  usageText,
  type IdentityDraft,
  type IdentityUsage,
} from "@/lib/identity-usage";
import { ImportKeyDialog, ProblemAlert, requestProblem } from "./key-dialogs";
import { call, imeEnterGuard, secretFieldProps, useSecretInput } from "./secret-input";

type Problem = { title: string; text: string };
type Phase =
  | { kind: "edit" }
  | { kind: "busy" }
  | { kind: "confirm"; token: string; impact: CatalogIdentityImpact | null }
  | { kind: "problem"; problem: Problem }
  | { kind: "partial"; text: string };
type PasswordMode = "keep" | "replace" | "forget";
const fieldOrder = ["label", "username", "keyId", "password"] as const;
const nextConnections = "Changes apply to next connections; open sessions keep their login.";

/** Revision-fenced identity save, then (step two) the password through the secret store. */
export function IdentityEditor({
  owner,
  catalog,
  state,
  identityId,
  usage,
  onClose,
  onSaved,
  onRetrySecrets,
}: {
  owner: Owner;
  catalog: Catalog;
  state: CatalogState;
  identityId?: string;
  usage?: IdentityUsage;
  onClose(): void;
  onSaved(id: string): void;
  onRetrySecrets(): Promise<void>;
}) {
  const id = useId();
  const password = useSecretInput();
  const [currentId, setCurrentId] = useState(identityId);
  const latest = currentId ? state.identities.find((row) => row.id === currentId) : undefined;
  const [base, setBase] = useState(latest);
  const [draft, setDraft] = useState<IdentityDraft>(() => identityDraft(latest));
  const [passwordMode, setPasswordMode] = useState<PasswordMode>(latest?.passwordSaved ? "keep" : "replace");
  const [checked, setChecked] = useState(false);
  const [reported, setReported] = useState<FieldErrors & { password?: string }>({});
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  // Keyed per open, so reopening during the import drawer's exit motion gets a fresh one.
  const [importing, setImporting] = useState<number>();
  // After an apply, rebase on the saved identity once this window's state includes that catalog revision.
  const [awaiting, setAwaiting] = useState<number>();
  const back = useRef<HTMLButtonElement>(null);
  const save = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);

  useEffect(() => {
    if (awaiting === undefined || state.revision < awaiting) return;
    setAwaiting(undefined);
    if (!latest) return;
    setBase(latest);
    setDraft(identityDraft(latest));
    setPasswordMode(latest.passwordSaved ? "keep" : "replace");
  }, [awaiting, state.revision, latest]);
  useEffect(() => {
    // Into the impact step: Back takes focus; out of it (Back to editing): Save does, since Back is gone.
    if (phase.kind === "confirm") back.current?.focus();
    else if (confirmed.current && phase.kind === "edit") save.current?.focus();
    confirmed.current = phase.kind === "confirm";
  }, [phase.kind]);

  const gone = !!identityId && !latest;
  // Until the saved identity is the base, another save could create it twice.
  const busy = phase.kind === "busy" || awaiting !== undefined;
  const secretsReady = state.secrets.availability === "ready";
  const pending = !!latest?.pending;
  const errors = { ...(checked ? identityErrors(draft) : {}), ...reported };
  const initialMode: PasswordMode = base?.passwordSaved ? "keep" : "replace";
  const showPassword = draft.method === "password" && passwordMode === "replace" && secretsReady;
  const field = (name: string) => `${id}-${name}`;
  const set = (patch: Partial<IdentityDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setReported({});
  };
  const focusFirst = (found: Record<string, string | undefined>) => {
    const first = fieldOrder.find((name) => found[name]);
    if (first) document.getElementById(field(first))?.focus();
  };
  // Read when closing: typing into the uncontrolled password field does not re-render.
  const drawer = useDrawerClose({
    dirty: () =>
      !gone &&
      phase.kind !== "partial" &&
      (!draftsEqual(draft, identityDraft(base)) || passwordMode !== initialMode || password.filled()),
    busy,
  });
  // On the impact step, Esc and × mean Back to editing.
  const close = phase.kind === "confirm" ? { ...drawer, request: () => setPhase({ kind: "edit" }) } : drawer;

  async function submit() {
    if (busy || gone || close.discarding || importing !== undefined) return;
    const found = identityErrors(draft);
    setChecked(true);
    setReported({});
    if (phase.kind !== "partial") setPhase({ kind: "edit" });
    if (Object.keys(found).length) return focusFirst(found);
    if (showPassword && password.tooLong()) {
      password.clear();
      setReported({ password: "Use a password of 16 KiB or less. The field was cleared." });
      return password.focus();
    }
    const intent = identityIntent(draft, base, passwordMode === "forget");
    if (!intent) return showPassword && password.filled() ? commit() : close.discard();
    setPhase({ kind: "busy" });
    const result = await catalog.prepare(intent);
    if (!result.ok) return setPhase({ kind: "problem", problem: requestProblem(result.error.code, "Changes were not saved") });
    if (result.value.kind === "invalid") {
      const fields = result.value.fields;
      if (fields.some((row) => row.field === "identity"))
        return setPhase({ kind: "problem", problem: { title: "This identity was deleted", text: "It no longer exists, so these changes cannot be saved." } });
      const mapped = serverFieldErrors(fields);
      setReported(mapped);
      setPhase({ kind: "edit" });
      return focusFirst(mapped);
    }
    const impact = result.value.impacts.identity;
    if (base && (impact?.removesSavedPassword || draft.method !== base.method))
      return setPhase({ kind: "confirm", token: result.value.token, impact });
    await commit(result.value.token);
  }

  async function commit(token?: string) {
    setPhase({ kind: "busy" });
    let targetId = base?.id;
    if (token) {
      const applied = await catalog.apply(token);
      if (!applied.ok)
        return setPhase({ kind: "problem", problem: requestProblem(applied.error.code, "Changes were not saved") });
      targetId ??= applied.value.createdIds[0];
      setCurrentId(targetId);
      setAwaiting(applied.value.revision);
    }
    if (!targetId) return setPhase({ kind: "problem", problem: requestProblem("unavailable", "Changes were not saved") });
    if (showPassword && password.filled()) {
      const created = !base;
      // Fenced on the revision the apply above produced, read directly so a lagging render cannot supply an older one.
      const fresh = await call((bridge) => bridge.catalogState({ owner }));
      const revision = fresh.ok ? fresh.value.identities.find((row) => row.id === targetId)?.revision : undefined;
      const bytes = password.take();
      let reason: string | undefined;
      try {
        if (!revision || !bytes) reason = requestProblem("conflict").text;
        else {
          const result = await call((bridge) =>
            bridge.setIdentityPassword({ owner, identityId: targetId, expectedRevision: revision, value: bytes }),
          );
          if (!result.ok) reason = requestProblem(result.error.code).text;
          else if (result.value.status !== "saved") reason = secretStoreText[result.value.reason];
        }
      } finally {
        bytes?.fill(0);
      }
      if (reason) {
        if (created) return setPhase({ kind: "partial", text: `Saved without a password; it will ask when connecting. ${reason}` });
        return setPhase({ kind: "problem", problem: { title: "The password was not saved", text: reason } });
      }
    }
    onSaved(targetId);
  }

  const keyItems = useMemo(
    () => state.keys.map((key) => ({ value: key.id, label: `${key.label} · ${algorithmLabel(key.algorithm)}` })),
    [state.keys],
  );
  const editing = !!base;
  const changesMethod = !!base && draft.method !== base.method;
  return (
    <Drawer
      close={close}
      onClose={onClose}
      data-testid="identity-editor"
      title={editing ? "Edit identity" : "New identity"}
      target={base ? <span className="min-w-0 break-all">{base.label}</span> : undefined}
      description="A user name and how to sign in. Servers and groups choose an identity; secrets stay in the macOS Keychain."
      discardText="Your edits to this identity will be lost."
      footer={
        phase.kind === "confirm" ? (
          <>
            <Button ref={back} variant="outline" onClick={() => setPhase({ kind: "edit" })}>
              Back to editing
            </Button>
            <Button variant="destructive" onClick={() => void commit(phase.token)}>
              Save changes
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={close.request}>
              {phase.kind === "partial" ? "Close" : "Cancel"}
            </Button>
            <Button ref={save} type="submit" form={field("form")} disabled={busy || gone || pending}>
              {busy ? <Spinner data-icon="inline-start" /> : null}Save
            </Button>
          </>
        )
      }
    >
      {phase.kind === "confirm" ? (
        // The impact review is a step of this drawer; the form stays mounted (hidden) so a typed password survives Back.
        <section aria-labelledby={field("confirm")} className="grid min-w-0 gap-3">
          <h3 id={field("confirm")} className="font-medium text-foreground">
            {changesMethod ? "Change how this identity signs in?" : "Forget the saved password?"}
          </h3>
          <p className="text-muted-foreground">
            {usage ? `${usageText(usage)}. ` : ""}
            {nextConnections}
          </p>
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            {base && changesMethod ? (
              <li>
                Sign in with {methodLabels[draft.method]} instead of {methodLabels[base.method]}.
              </li>
            ) : null}
            {phase.impact?.removesSavedPassword ? <li>The saved password is removed from the Keychain.</li> : null}
          </ul>
          <IdentityImpactLists state={state} impact={phase.impact} />
        </section>
      ) : null}
      <div className={phase.kind === "confirm" ? "hidden" : "grid min-w-0 gap-4"}>
        {pending ? (
          <Alert>
            <AlertTriangleIcon />
            <AlertTitle>Keychain change unresolved</AlertTitle>
            <AlertDescription className="grid gap-2">
              <span>Retry it before changing this identity.</span>
              <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => void onRetrySecrets()}>
                <RotateCwIcon data-icon="inline-start" /> Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <form
          id={field("form")}
          noValidate
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={imeEnterGuard}
        >
          <FieldGroup>
            <Field data-invalid={errors.label ? true : undefined}>
              <FieldLabel htmlFor={field("label")}>Name</FieldLabel>
              <Input
                id={field("label")}
                value={draft.label}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={errors.label ? true : undefined}
                onChange={(event) => set({ label: event.target.value })}
              />
              {errors.label ? <FieldError>{errors.label}</FieldError> : null}
            </Field>
            <Field data-invalid={errors.username ? true : undefined}>
              <FieldLabel htmlFor={field("username")}>User name</FieldLabel>
              <Input
                id={field("username")}
                value={draft.username}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                aria-invalid={errors.username ? true : undefined}
                onChange={(event) => set({ username: event.target.value })}
              />
              {errors.username ? <FieldError>{errors.username}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel id={field("method-label")}>Sign in with</FieldLabel>
              <ToggleGroup
                aria-labelledby={field("method-label")}
                variant="outline"
                spacing={0}
                className="flex-wrap"
                value={[draft.method]}
                onValueChange={(value) => {
                  const method = value[0] as IdentityMethod | undefined;
                  if (method) set({ method });
                }}
              >
                {(Object.keys(methodLabels) as IdentityMethod[]).map((method) => (
                  <ToggleGroupItem key={method} value={method}>
                    {methodLabels[method]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              {base?.method === "password" && base.passwordSaved && draft.method !== "password" ? (
                <FieldDescription>Saving removes the saved password from the Keychain.</FieldDescription>
              ) : null}
            </Field>
            {draft.method === "password" ? (
              <PasswordField
                id={field("password")}
                mode={passwordMode}
                saved={!!base?.passwordSaved}
                secretsReady={secretsReady}
                error={reported.password}
                input={password}
                disabled={busy}
                onMode={(mode) => {
                  password.clear();
                  setPasswordMode(mode);
                  setReported({});
                }}
              />
            ) : draft.method === "key" ? (
              <Field data-invalid={errors.keyId ? true : undefined}>
                <FieldLabel htmlFor={field("keyId")}>SSH key</FieldLabel>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Select
                    items={keyItems}
                    value={draft.keyId}
                    onValueChange={(next) => {
                      if (typeof next === "string") set({ keyId: next });
                    }}
                  >
                    <SelectTrigger id={field("keyId")} className="min-w-0 flex-1" aria-invalid={errors.keyId ? true : undefined}>
                      <SelectValue placeholder={keyItems.length ? "Choose a key" : "No keys yet"} />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {keyItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" disabled={!secretsReady} onClick={() => setImporting((n) => (n ?? 0) + 1)}>
                    <FileKeyIcon data-icon="inline-start" /> Import key…
                  </Button>
                </div>
                {secretsReady ? null : (
                  <FieldDescription>Importing needs the macOS Keychain, which is unavailable.</FieldDescription>
                )}
                {errors.keyId ? <FieldError>{errors.keyId}</FieldError> : null}
              </Field>
            ) : (
              <FieldDescription>
                The server's questions are asked each time you connect. Nothing is saved.
              </FieldDescription>
            )}
          </FieldGroup>
        </form>
        <p className="type-caption text-muted-foreground">{nextConnections}</p>
        {gone ? (
          <ProblemAlert problem={{ title: "This identity was deleted", text: "It no longer exists, so these changes cannot be saved." }} />
        ) : phase.kind === "problem" ? (
          <ProblemAlert problem={phase.problem} />
        ) : phase.kind === "partial" ? (
          <Alert role="status">
            <AlertTriangleIcon />
            <AlertTitle>Identity saved</AlertTitle>
            <AlertDescription>{phase.text}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      {importing !== undefined ? (
        <ImportKeyDialog
          key={importing}
          owner={owner}
          secretsReady={secretsReady}
          onClose={() => setImporting(undefined)}
          onImported={(keyId) => {
            setImporting(undefined);
            set({ keyId });
          }}
        />
      ) : null}
    </Drawer>
  );
}

function PasswordField({
  id,
  mode,
  saved,
  secretsReady,
  error,
  input,
  disabled,
  onMode,
}: {
  id: string;
  mode: PasswordMode;
  saved: boolean;
  secretsReady: boolean;
  error?: string;
  input: ReturnType<typeof useSecretInput>;
  disabled: boolean;
  onMode(mode: PasswordMode): void;
}) {
  if (mode === "replace" && secretsReady)
    return (
      <Field data-invalid={error ? true : undefined} data-disabled={disabled || undefined}>
        <FieldLabel htmlFor={id}>{saved ? "New password" : "Password"}</FieldLabel>
        <Input ref={input.ref} id={id} {...secretFieldProps} disabled={disabled} aria-invalid={error ? true : undefined} />
        {error ? <FieldError>{error}</FieldError> : (
          <FieldDescription>
            {saved ? "Leave blank to keep the saved password." : "Leave blank to be asked when connecting."}
          </FieldDescription>
        )}
        {saved ? (
          <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => onMode("keep")}>
            Keep saved password
          </Button>
        ) : null}
      </Field>
    );
  return (
    <Field>
      <FieldLabel>Password</FieldLabel>
      <FieldDescription>
        {mode === "forget"
          ? "The saved password is removed when you save. ssterm will ask for it when connecting."
          : saved
            ? "Saved in Keychain."
            : "The Keychain is unavailable, so ssterm will ask for the password when connecting."}
      </FieldDescription>
      {saved ? (
        <div className="flex flex-wrap gap-2">
          {mode === "forget" ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onMode("keep")}>
              Keep saved password
            </Button>
          ) : (
            <>
              {secretsReady ? (
                <Button type="button" variant="outline" size="sm" onClick={() => onMode("replace")}>
                  Replace
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={() => onMode("forget")}>
                Forget saved password
              </Button>
            </>
          )}
        </div>
      ) : null}
    </Field>
  );
}

export function DeleteIdentityDialog({
  catalog,
  state,
  identity,
  usage,
  onClose,
  onDeleted,
  afterDelete,
}: {
  catalog: Catalog;
  state: CatalogState;
  identity: CatalogIdentity;
  usage: IdentityUsage;
  onClose(): void;
  onDeleted(): void;
  afterDelete(): HTMLElement | null;
}) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const bound = usage.direct + usage.groups > 0;
  const [mode, setMode] = useState<"detach" | "reassign" | undefined>(bound ? undefined : "detach");
  const [target, setTarget] = useState<string>();
  const others = state.identities.filter((row) => row.id !== identity.id);
  const { preview, failure, busy, confirm, retry, finalFocus } = useDelete(
    catalog,
    mode === "detach"
      ? { type: "delete-identity", id: identity.id, expectedRevision: identity.revision, disposition: { mode: "detach" } }
      : mode === "reassign" && target
        ? { type: "delete-identity", id: identity.id, expectedRevision: identity.revision, disposition: { mode: "reassign", identityId: target } }
        : undefined,
    onDeleted,
  );
  const impact = preview?.impacts.identity;
  const targetLabel = others.find((row) => row.id === target)?.label;
  const close = useDrawerClose({ busy });
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      finalFocus={finalFocus(afterDelete)}
      data-testid="delete-identity-dialog"
      title={<span className="break-all">Delete identity {identity.label}?</span>}
      target={<span className="min-w-0 break-all font-mono">{identity.username}</span>}
      description={`${usageText(usage)}. ${nextConnections}`}
      footer={
        <>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={close.request}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!preview || busy} onClick={() => void confirm()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}Delete identity
          </Button>
        </>
      }
    >
      {bound ? (
        <RadioGroup
          aria-label="Servers and groups using this identity"
          value={mode ?? null}
          disabled={busy}
          onValueChange={(value) => {
            if (value === "detach" || value === "reassign") setMode(value);
          }}
        >
          <Field orientation="horizontal">
            <RadioGroupItem value="detach" id={`${id}-detach`} />
            <FieldLabel htmlFor={`${id}-detach`} className="font-normal">
              Detach: they get No identity and cannot connect until one is chosen
            </FieldLabel>
          </Field>
          <Field orientation="horizontal" data-disabled={others.length ? undefined : true}>
            <RadioGroupItem value="reassign" id={`${id}-reassign`} disabled={!others.length} />
            <FieldLabel htmlFor={`${id}-reassign`} className="font-normal">
              Reassign them to another identity
            </FieldLabel>
          </Field>
        </RadioGroup>
      ) : null}
      {mode === "reassign" ? (
        <Field>
          <FieldLabel htmlFor={`${id}-target`}>Use instead</FieldLabel>
          <Select
            items={others.map((row) => ({ value: row.id, label: `${row.label} (${row.username})` }))}
            value={target ?? null}
            onValueChange={(next) => {
              if (typeof next === "string") setTarget(next);
            }}
          >
            <SelectTrigger id={`${id}-target`} className="w-full">
              <SelectValue placeholder="Choose an identity" />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {others.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.label} ({row.username})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {failure ? (
        <DeleteFailure code={failure} retry={retry} />
      ) : mode === "detach" || (mode === "reassign" && target) ? (
        !preview ? (
          <Spinner aria-label="Checking what will change" />
        ) : (
          <div className="grid gap-3" data-testid="delete-impacts">
            <IdentityImpactLists state={state} impact={impact} />
            <p className="text-sm">
              {!bound
                ? "No server or group uses this identity."
                : mode === "reassign"
                  ? `They will use ${targetLabel ?? "the chosen identity"}.`
                  : "They will have No identity."}
              {impact?.removesSavedPassword ? " The saved password is removed from the Keychain." : ""}
            </p>
          </div>
        )
      ) : null}
    </Drawer>
  );
}

/** The servers (with environment badges) and groups an identity change reaches, directly or through groups. */
function IdentityImpactLists({ state, impact }: { state: CatalogState; impact?: CatalogIdentityImpact | null }) {
  const hosts = useMemo(() => new Map(state.hosts.map((host) => [host.id, host])), [state.hosts]);
  const groups = useMemo(() => new Map(state.groups.map((group) => [group.id, group])), [state.groups]);
  if (!impact) return null;
  const direct = new Set(impact.directHostIds);
  const serverList = (ids: readonly string[], label: string) =>
    ids.length ? (
      <section className="grid gap-1">
        <h4 className="type-label">{label}</h4>
        <ul className="grid gap-1 text-sm" aria-label={label}>
          {ids.map((hostId) => {
            const host = hosts.get(hostId);
            return host ? (
              <li key={hostId} className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span className="min-w-0 font-medium">{host.label}</span>
                <EnvironmentBadge environment={host.environment} />
              </li>
            ) : null;
          })}
        </ul>
      </section>
    ) : null;
  return (
    <>
      {serverList(impact.directHostIds, "Servers set to this identity")}
      {impact.directGroupIds.length ? (
        <section className="grid gap-1">
          <h4 className="type-label">Groups set to this identity</h4>
          <ul className="grid gap-1 text-sm" aria-label="Groups set to this identity">
            {impact.directGroupIds.map((groupId) => (
              <li key={groupId} className="min-w-0">
                {groups.get(groupId)?.label ?? "Unavailable group"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {serverList(impact.effectiveHostIds.filter((hostId) => !direct.has(hostId)), "Servers inheriting it through groups")}
    </>
  );
}
