import { useRef, useState } from "react";
import { AlertTriangleIcon, ShieldCheckIcon } from "lucide-react";
import {
  MAX_KNOWN_HOSTS,
  type HostTrustDecision,
  type HostTrustPrompt,
  type KnownHostEntry,
  type KnownHostRevokePreview,
  type Owner,
  type TrustState,
} from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";

function KeyDetails({
  entry,
  label,
}: {
  entry: Pick<KnownHostEntry, "algorithm" | "fingerprint">;
  label: string;
}) {
  return (
    <div className="grid min-w-0 gap-1 rounded-md border p-3">
      <span className="type-caption text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{entry.algorithm}</span>
      <code
        className="min-w-0 break-all text-sm"
        data-testid="trust-fingerprint"
      >
        {entry.fingerprint}
      </code>
    </div>
  );
}
type Failure = false | "conflict" | "error";
function TrustError({ conflict = false }: { conflict?: boolean }) {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>
        {conflict ? "This host's trust changed" : "Trust decision could not finish"}
      </AlertTitle>
      <AlertDescription>
        {conflict
          ? "Review the updated known hosts and try again."
          : "The key or connection may have changed. Review the current state and try again."}
      </AlertDescription>
    </Alert>
  );
}
// Header and actions stay in view; only the details scroll at small window sizes.
const dialogLayout =
  "flex max-h-[calc(100dvh-2rem)] flex-col data-[size=default]:sm:max-w-lg motion-reduce:animate-none";

export function KnownHostsWorkspace({
  owner,
  state,
  error,
}: {
  owner?: Owner;
  state?: TrustState;
  error: boolean;
}) {
  const [preview, setPreview] = useState<KnownHostRevokePreview>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure>(false);
  const cancel = useRef<HTMLButtonElement>(null);
  // The trigger is disabled while preparing, so the dialog cannot infer it from document focus.
  const trigger = useRef<HTMLButtonElement | null>(null);
  const activePreview =
    preview &&
    state?.knownHosts.some(
      (entry) =>
        entry.id === preview.entry.id &&
        entry.revision === preview.entry.revision,
    )
      ? preview
      : undefined;
  async function prepare(entry: KnownHostEntry) {
    if (!owner || !window.ssterm || busy || state?.availability !== "ready")
      return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await window.ssterm.prepareKnownHostRevoke({
        owner,
        id: entry.id,
        expectedRevision: entry.revision,
      });
      if (result.ok) setPreview(result.value);
      else setFailed(result.error.code === "conflict" ? "conflict" : "error");
    } catch {
      setFailed("error");
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!owner || !activePreview || !window.ssterm || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await window.ssterm.revokeKnownHost({
        owner,
        token: activePreview.token,
      });
      if (result.ok) setPreview(undefined);
      else setFailed(result.error.code === "conflict" ? "conflict" : "error");
    } catch {
      setFailed("error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-auto p-5"
      data-testid="known-hosts-workspace"
    >
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="size-5" />
        <h2 className="type-heading">Known hosts</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Saved SSH server identities are shared across terminals, file transfers
        and port forwarding. Verify fingerprints with your administrator before
        trusting a key.
      </p>
      {error || failed || state?.availability === "unavailable" ? (
        <TrustError conflict={failed === "conflict"} />
      ) : null}
      {state?.truncated ? (
        <p className="type-caption text-muted-foreground">
          Showing the first {MAX_KNOWN_HOSTS.toLocaleString()} known hosts.
        </p>
      ) : null}
      {!state && !error ? <Spinner aria-label="Loading known hosts" /> : null}
      {state?.availability === "ready" && state.knownHosts.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No trusted hosts yet</EmptyTitle>
            <EmptyDescription>
              Remembered server keys will appear here after you explicitly trust
              them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {state?.knownHosts.map((entry) => (
        <article
          key={entry.id}
          className="grid min-w-0 gap-3 rounded-lg border p-4"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 className="min-w-0 break-all font-medium">
              {entry.endpointHost}:{entry.endpointPort}
            </h3>
            <Button
              variant="outline"
              disabled={busy}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                void prepare(entry);
              }}
            >
              Revoke trust
            </Button>
          </div>
          <KeyDetails entry={entry} label="Remembered key" />
          <p className="type-caption text-muted-foreground">
            Last verified: {new Date(entry.lastVerifiedAt).toLocaleString()}
          </p>
        </article>
      ))}
      <AlertDialog
        open={!!activePreview}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setPreview(undefined);
            setFailed(false);
          }
        }}
      >
        <AlertDialogContent
          initialFocus={cancel}
          finalFocus={trigger}
          className={dialogLayout}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this host's trust?</AlertDialogTitle>
            <AlertDialogDescription>
              The next connection will require a new trust decision. Active
              sessions keep their current connection.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="-mx-4 grid min-h-0 gap-4 overflow-y-auto px-4">
            {activePreview ? (
              <>
                <p className="min-w-0 break-all font-mono text-sm">
                  {activePreview.entry.endpointHost}:
                  {activePreview.entry.endpointPort}
                </p>
                <KeyDetails
                  entry={activePreview.entry}
                  label="Key being revoked"
                />
              </>
            ) : null}
            {failed ? <TrustError conflict={failed === "conflict"} /> : null}
          </div>
          <AlertDialogFooter>
            <Button
              ref={cancel}
              variant="outline"
              disabled={busy}
              onClick={() => setPreview(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void revoke()}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}Revoke trust
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Keyed by attempt and prompt, so a new prompt never inherits confirmation or errors. */
export function HostTrustDialogs({ state }: { state?: TrustState }) {
  const prompt = state?.prompts[0];
  return prompt && state ? (
    <HostTrustDialog
      key={`${state.owner.generation}:${prompt.sessionId}:${prompt.generation}:${prompt.promptId}`}
      owner={state.owner}
      prompt={prompt}
      available={state.availability === "ready"}
    />
  ) : null;
}
function HostTrustDialog({
  owner,
  prompt,
  available,
}: {
  owner: Owner;
  prompt: HostTrustPrompt;
  available: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const reject = useRef<HTMLButtonElement>(null);
  async function answer(decision: HostTrustDecision) {
    if (busy || !window.ssterm || (!available && decision !== "reject")) return;
    setBusy(true);
    setFailed(false);
    try {
      const result = await window.ssterm.answerHostTrust({
        owner,
        sessionId: prompt.sessionId,
        generation: prompt.generation,
        promptId: prompt.promptId,
        decision,
      });
      if (!result.ok) {
        setFailed(true);
        setBusy(false);
      }
      // A successful answer removes this captured prompt through the ordered state stream.
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }
  // Alert semantics: an outside click never decides; Escape is an explicit reject.
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) void answer("reject");
      }}
    >
      <AlertDialogContent
        initialFocus={reject}
        className={dialogLayout}
        data-testid="host-trust-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {prompt.status === "changed"
              ? "Server identity changed"
              : "Trust this server?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {prompt.status === "changed"
              ? "Connection is blocked. A changed key can indicate an attack or a server rebuild. Verify the new fingerprint through a trusted channel before replacing it."
              : "This server's identity is unknown. Verify the fingerprint through a trusted channel before connecting."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="-mx-4 grid min-h-0 gap-4 overflow-y-auto px-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 break-all font-medium">
              {prompt.targetLabel}
            </span>
            {prompt.environment ? (
              <Badge
                variant={
                  prompt.environment === "PROD" ? "production" : "outline"
                }
              >
                {prompt.environment}
              </Badge>
            ) : null}
          </div>
          <p className="min-w-0 break-all font-mono text-sm">
            {prompt.endpointHost}:{prompt.endpointPort}
          </p>
          {prompt.status === "changed" ? (
            <>
              <Alert variant="destructive">
                <AlertTriangleIcon />
                <AlertTitle>Host key mismatch</AlertTitle>
                <AlertDescription>
                  Authentication will stay blocked until you deliberately
                  replace the remembered key.
                </AlertDescription>
              </Alert>
              <KeyDetails
                entry={{
                  algorithm: prompt.previousAlgorithm,
                  fingerprint: prompt.previousFingerprint,
                }}
                label="Previous key"
              />
            </>
          ) : null}
          <KeyDetails
            entry={prompt}
            label={prompt.status === "changed" ? "New key" : "Server key"}
          />
          {prompt.status === "changed" ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="confirm-host-replacement"
                checked={confirmed}
                onCheckedChange={(checked) => setConfirmed(checked === true)}
                disabled={busy}
              />
              <Label
                htmlFor="confirm-host-replacement"
                className="leading-snug"
              >
                I verified the new fingerprint and want to replace this host's
                remembered key.
              </Label>
            </div>
          ) : null}
          {failed || !available ? <TrustError /> : null}
        </div>
        <AlertDialogFooter>
          <Button
            ref={reject}
            variant="outline"
            disabled={busy}
            onClick={() => void answer("reject")}
          >
            Reject
          </Button>
          {prompt.status === "unknown" ? (
            <>
              <Button
                variant="outline"
                disabled={busy || !available}
                onClick={() => void answer("accept-once")}
              >
                Accept once
              </Button>
              <Button
                disabled={busy || !available}
                onClick={() => void answer("remember")}
              >
                {busy ? <Spinner data-icon="inline-start" /> : null}Remember
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              disabled={busy || !confirmed || !available}
              onClick={() => void answer("replace")}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}Replace key
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
