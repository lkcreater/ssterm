import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AlertTriangleIcon, FileKeyIcon } from "lucide-react";
import type { CatalogKey, ErrorCode, KeyAlgorithm, Owner, SecretStoreReason } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { labelError } from "@/lib/catalog-validation";
import { algorithmLabel, importProblemText, secretStoreText } from "@/lib/identity-usage";
import { call, imeEnterGuard, secretFieldProps, useSecretInput } from "./secret-input";

export const dialogLayout = "flex max-h-[calc(100dvh-2rem)] flex-col [overflow-wrap:anywhere] sm:max-w-lg motion-reduce:animate-none";
type Problem = { title: string; text: string };

export function requestProblem(code: ErrorCode, title = "Nothing was changed"): Problem {
  return {
    title: code === "conflict" ? "Changed since you opened this" : title,
    text:
      code === "conflict"
        ? "Review the current details, then try again."
        : code === "busy"
          ? "A Keychain change is still unresolved or another request is running. Retry it from Identities, then try again."
          : code === "unavailable"
            ? "The workspace is locked, closed or unavailable. Unlock it and try again."
            : "The workspace could not complete this request. Try again.",
  };
}
export const storeProblem = (reason: SecretStoreReason, title: string): Problem => ({ title, text: secretStoreText[reason] });

export function ProblemAlert({ problem }: { problem?: Problem }) {
  return problem ? (
    <Alert variant="destructive" role="alert">
      <AlertTriangleIcon />
      <AlertTitle>{problem.title}</AlertTitle>
      <AlertDescription>{problem.text}</AlertDescription>
    </Alert>
  ) : null;
}

/** Focus once the re-render has re-enabled controls that were disabled while busy. */
const afterRender = (focus: () => void) => void setTimeout(focus);

type Chosen = { importId: string; encrypted: boolean; algorithm: KeyAlgorithm | null; fingerprint: string | null };

/** Choose file → label → passphrase when encrypted → import. The private key never reaches this renderer. */
export function ImportKeyDialog({
  owner,
  secretsReady,
  onClose,
  onImported,
}: {
  owner: Owner;
  secretsReady: boolean;
  onClose(): void;
  onImported(keyId: string): void;
}) {
  const id = useId();
  const passphrase = useSecretInput();
  const [chosen, setChosen] = useState<Chosen>();
  const [label, setLabel] = useState("");
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [labelProblem, setLabelProblem] = useState<string>();
  const [passphraseProblem, setPassphraseProblem] = useState<string>();
  const [problem, setProblem] = useState<Problem>();
  const [partial, setPartial] = useState<{ keyId: string; text: string }>();
  const held = useRef<string>(undefined);
  const live = useRef(true);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLButtonElement>(null);

  const release = () => {
    const importId = held.current;
    held.current = undefined;
    if (importId) void call((bridge) => bridge.discardKeyImport({ owner, importId }));
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      release();
    };
    // Discard once, on close; the owner is fixed for this dialog's lifetime.
  }, []);
  useEffect(() => {
    if (chosen) labelInput.current?.focus();
  }, [chosen]);
  useEffect(() => {
    if (partial) done.current?.focus();
  }, [partial]);

  async function choose() {
    if (busy) return;
    release();
    setChosen(undefined);
    setProblem(undefined);
    setBusy(true);
    const result = await call((bridge) => bridge.chooseKeyFile({ owner }));
    if (!live.current) {
      if (result.ok && result.value.status === "chosen") {
        held.current = result.value.importId;
        release();
      }
      return;
    }
    setBusy(false);
    if (!result.ok)
      return setProblem(
        result.error.code === "busy"
          ? { title: "A file chooser is already open", text: "Finish or cancel it, then try again." }
          : requestProblem(result.error.code, "No file was chosen"),
      );
    const value = result.value;
    if (value.status === "cancelled") return;
    if (value.status === "rejected")
      return setProblem({ title: "This file cannot be imported", text: importProblemText[value.problem] });
    held.current = value.importId;
    setChosen({ importId: value.importId, encrypted: value.encrypted, algorithm: value.algorithm, fingerprint: value.fingerprint });
    setLabel(value.suggestedLabel);
    setSave(false);
    setLabelProblem(undefined);
    setPassphraseProblem(undefined);
  }

  async function submit() {
    if (!chosen || busy || partial) return;
    const invalid = labelError(label);
    setLabelProblem(invalid);
    setPassphraseProblem(undefined);
    setProblem(undefined);
    if (invalid) return labelInput.current?.focus();
    if (chosen.encrypted && (!passphrase.filled() || passphrase.tooLong())) {
      setPassphraseProblem(
        passphrase.filled() ? "Use a passphrase of 16 KiB or less." : "Enter the passphrase that unlocks this key.",
      );
      passphrase.clear();
      return passphrase.focus();
    }
    setBusy(true);
    const bytes = chosen.encrypted ? passphrase.take() : null;
    let result;
    try {
      result = await call((bridge) =>
        bridge.importKey({
          owner,
          importId: chosen.importId,
          label: label.trim(),
          passphrase: bytes,
          savePassphrase: chosen.encrypted && save && secretsReady,
        }),
      );
    } finally {
      bytes?.fill(0);
    }
    if (!live.current) return;
    // Committed now so the fields are enabled before `afterRender` moves focus into them.
    flushSync(() => setBusy(false));
    if (!result.ok) return setProblem(requestProblem(result.error.code, "The key was not imported"));
    const value = result.value;
    switch (value.status) {
      case "imported":
        held.current = undefined;
        if (value.passphrase.status !== "secret-store") return onImported(value.keyId);
        return setPartial({
          keyId: value.keyId,
          text: `The key was imported, but its passphrase was not saved. ${secretStoreText[value.passphrase.reason]} ssterm will ask for the passphrase when connecting.`,
        });
      case "wrong-passphrase":
        setPassphraseProblem(importProblemText["wrong-passphrase"]);
        return afterRender(passphrase.focus);
      case "expired":
        held.current = undefined;
        setChosen(undefined);
        setProblem({ title: "Choose the file again", text: importProblemText.expired });
        return afterRender(() => chooseButton.current?.focus());
      case "rejected":
        // The decrypted contents are not a supported key; the held file is used up.
        held.current = undefined;
        setChosen(undefined);
        setProblem({ title: "This file cannot be imported", text: importProblemText[value.problem] });
        return afterRender(() => chooseButton.current?.focus());
      case "secret-store":
        // A Keychain write consumes the chosen file; anything still held is released.
        release();
        setChosen(undefined);
        setProblem({ title: "The key was not imported", text: `${secretStoreText[value.reason]} Choose the file again to retry.` });
        return afterRender(() => chooseButton.current?.focus());
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className={dialogLayout} data-testid="import-key-dialog">
        <DialogHeader>
          <DialogTitle>Import SSH key</DialogTitle>
          <DialogDescription>
            ssterm keeps the private key in the macOS Keychain and never shows it again. OpenSSH Ed25519 and PEM RSA keys are supported.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          noValidate
          autoComplete="off"
          className="-mx-4 grid min-h-0 gap-4 overflow-y-auto px-4 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={imeEnterGuard}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button ref={chooseButton} type="button" variant="outline" disabled={busy || !!partial} onClick={() => void choose()}>
              <FileKeyIcon data-icon="inline-start" /> {chosen ? "Choose another file…" : "Choose file…"}
            </Button>
            {chosen ? (
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                {chosen.algorithm ? <Badge variant="secondary">{algorithmLabel(chosen.algorithm)}</Badge> : null}
                <Badge variant="outline">{chosen.encrypted ? "Passphrase protected" : "No passphrase"}</Badge>
              </span>
            ) : null}
          </div>
          {chosen?.fingerprint ? (
            <p className="min-w-0 font-mono text-xs break-all text-muted-foreground">{chosen.fingerprint}</p>
          ) : null}
          {chosen ? (
            <FieldGroup>
              <Field data-invalid={labelProblem ? true : undefined}>
                <FieldLabel htmlFor={`${id}-label`}>Name</FieldLabel>
                <Input
                  ref={labelInput}
                  id={`${id}-label`}
                  value={label}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy || !!partial}
                  aria-invalid={labelProblem ? true : undefined}
                  onChange={(event) => {
                    setLabel(event.target.value);
                    setLabelProblem(undefined);
                  }}
                />
                {labelProblem ? <FieldError>{labelProblem}</FieldError> : null}
              </Field>
              {chosen.encrypted ? (
                <>
                  <Field data-invalid={passphraseProblem ? true : undefined} data-disabled={busy || undefined}>
                    <FieldLabel htmlFor={`${id}-passphrase`}>Passphrase</FieldLabel>
                    <Input
                      ref={passphrase.ref}
                      id={`${id}-passphrase`}
                      {...secretFieldProps}
                      disabled={busy || !!partial}
                      aria-invalid={passphraseProblem ? true : undefined}
                    />
                    {passphraseProblem ? <FieldError>{passphraseProblem}</FieldError> : (
                      <FieldDescription>Checked now to confirm the key unlocks.</FieldDescription>
                    )}
                  </Field>
                  <Field orientation="horizontal" data-disabled={!secretsReady || busy || undefined}>
                    <Checkbox
                      id={`${id}-save`}
                      checked={save}
                      disabled={!secretsReady || busy || !!partial}
                      onCheckedChange={(checked) => setSave(checked === true)}
                    />
                    <FieldLabel htmlFor={`${id}-save`} className="font-normal">
                      Save passphrase in Keychain
                    </FieldLabel>
                  </Field>
                  <FieldDescription>
                    {secretsReady
                      ? "Off: ssterm asks for the passphrase each time you connect."
                      : "The Keychain is unavailable, so ssterm will ask for the passphrase each time you connect."}
                  </FieldDescription>
                </>
              ) : null}
            </FieldGroup>
          ) : null}
          <ProblemAlert problem={problem} />
          {partial ? (
            <Alert role="status">
              <AlertTriangleIcon />
              <AlertTitle>Imported without a saved passphrase</AlertTitle>
              <AlertDescription>{partial.text}</AlertDescription>
            </Alert>
          ) : null}
        </form>
        <DialogFooter>
          {partial ? (
            <Button ref={done} onClick={() => onImported(partial.keyId)}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form={`${id}-form`} disabled={busy || !chosen}>
                {busy && chosen ? <Spinner data-icon="inline-start" /> : null}Import
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RenameKeyDialog({ owner, keyItem, onClose }: { owner: Owner; keyItem: CatalogKey; onClose(): void }) {
  const id = useId();
  const [label, setLabel] = useState(keyItem.label);
  const [busy, setBusy] = useState(false);
  const [labelProblem, setLabelProblem] = useState<string>();
  const [problem, setProblem] = useState<Problem>();
  async function submit() {
    if (busy) return;
    const invalid = labelError(label);
    setLabelProblem(invalid);
    setProblem(undefined);
    if (invalid) return document.getElementById(`${id}-label`)?.focus();
    if (label.trim() === keyItem.label) return onClose();
    setBusy(true);
    const result = await call((bridge) =>
      bridge.renameKey({ owner, keyId: keyItem.id, expectedRevision: keyItem.revision, label: label.trim() }),
    );
    setBusy(false);
    if (!result.ok) return setProblem(requestProblem(result.error.code, "The key was not renamed"));
    onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className={dialogLayout} data-testid="rename-key-dialog">
        <DialogHeader>
          <DialogTitle>Rename key</DialogTitle>
          <DialogDescription>Only the name changes. The key and its fingerprint stay the same.</DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={imeEnterGuard}
        >
          <Field data-invalid={labelProblem ? true : undefined}>
            <FieldLabel htmlFor={`${id}-label`}>Name</FieldLabel>
            <Input
              id={`${id}-label`}
              value={label}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={labelProblem ? true : undefined}
              onChange={(event) => {
                setLabel(event.target.value);
                setLabelProblem(undefined);
              }}
            />
            {labelProblem ? <FieldError>{labelProblem}</FieldError> : null}
          </Field>
          <ProblemAlert problem={problem} />
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Forget a saved passphrase or delete a key; both are destructive, so Cancel takes focus. */
export function KeyActionDialog({
  owner,
  keyItem,
  action,
  onClose,
}: {
  owner: Owner;
  keyItem: CatalogKey;
  action: "forget-passphrase" | "delete";
  onClose(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const deleting = action === "delete";
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const request = { owner, keyId: keyItem.id, expectedRevision: keyItem.revision };
    const result = deleting
      ? await call((bridge) => bridge.deleteKey(request))
      : await call((bridge) => bridge.forgetKeyPassphrase(request));
    setBusy(false);
    const failed = deleting ? "The key was not deleted" : "The passphrase was not forgotten";
    if (!result.ok) return setProblem(requestProblem(result.error.code, failed));
    const value = result.value;
    if (value.status === "in-use")
      return setProblem({ title: failed, text: "An identity uses this key. Choose another key for it first." });
    if (value.status === "secret-store") return setProblem(storeProblem(value.reason, failed));
    // A pending cleanup shows on the page with Retry.
    onClose();
  }
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent initialFocus={cancel} className={dialogLayout} data-testid={`${action}-key-dialog`}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {deleting ? `Delete key ${keyItem.label}?` : `Forget the saved passphrase for ${keyItem.label}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {deleting
              ? "The private key and any saved passphrase are removed from the Keychain. To use it again, import the file again. Open sessions keep their login."
              : "ssterm will ask for the passphrase each time this key is used. Open sessions keep their login."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ProblemAlert problem={problem} />
        <AlertDialogFooter>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {deleting ? "Delete key" : "Forget passphrase"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
