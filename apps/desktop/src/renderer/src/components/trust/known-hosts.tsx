import { useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { AlertTriangleIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
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
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Drawer, useDrawerClose } from "@/components/drawer";
import { Spinner } from "@/components/ui/spinner";
import { promptFinalFocus } from "@/components/auth/credential-prompts";

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
function Target({ prompt }: { prompt: Pick<HostTrustPrompt, "targetLabel" | "environment" | "endpointHost" | "endpointPort"> }) {
  return (
    <>
      <span className="min-w-0 break-all font-medium text-foreground">{prompt.targetLabel}</span>
      {prompt.environment ? (
        <Badge variant={prompt.environment === "PROD" ? "production" : "outline"}>{prompt.environment}</Badge>
      ) : null}
      <span className="min-w-0 break-all font-mono">
        {prompt.endpointHost}:{prompt.endpointPort}
      </span>
    </>
  );
}

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
  const hosts = state?.knownHosts ?? [];
  return (
    <div className="catalog-page" data-testid="known-hosts-workspace">
      <PageHeader
        title="Known hosts"
        subtitle={
          state?.availability === "ready"
            ? `Server keys you trusted on this Mac · ${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`
            : "Server keys you trusted on this Mac"
        }
      />
      <p className="type-caption text-muted-foreground">
        Saved SSH server identities are shared across terminals, file transfers and port forwarding. Verify
        fingerprints with your administrator before trusting a key.
      </p>
      {error || failed || state?.availability === "unavailable" ? (
        <TrustError conflict={failed === "conflict"} />
      ) : null}
      {state?.truncated ? (
        <p className="type-caption text-muted-foreground">
          Showing the first {MAX_KNOWN_HOSTS.toLocaleString()} known hosts.
        </p>
      ) : null}
      {!state && !error ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Spinner aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle role="status">Loading known hosts…</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {state?.availability === "ready" && hosts.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ShieldCheckIcon />
            </EmptyMedia>
            <EmptyTitle>No trusted hosts yet</EmptyTitle>
            <EmptyDescription>
              Remembered server keys will appear here after you explicitly trust
              them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {hosts.length ? (
        <div className="data-frame">
          <table className="data-table" aria-label="Known hosts">
            <thead>
              <tr>
                <th scope="col" title="Host">Host</th>
                <th scope="col" className="w-16" title="Port">Port</th>
                <th scope="col" className="w-[14%]" title="Key type">Key type</th>
                <th scope="col" className="w-[24%]" title="Fingerprint">Fingerprint</th>
                <th scope="col" className="w-[16%]" title="Last verified">Last verified</th>
                <th scope="col" className="w-36 data-actions-col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((entry) => (
                <tr key={entry.id} data-known-host-id={entry.id}>
                  <td>
                    <span className="host-target block truncate" title={entry.endpointHost}>
                      {entry.endpointHost}
                    </span>
                  </td>
                  <td className="host-target">{entry.endpointPort}</td>
                  <td className="font-mono">{entry.algorithm}</td>
                  <td>
                    <code className="block text-sm break-all" data-testid="known-host-fingerprint">
                      {entry.fingerprint}
                    </code>
                  </td>
                  <td className="type-caption text-muted-foreground">
                    {new Date(entry.lastVerifiedAt).toLocaleString()}
                  </td>
                  <td>
                    <span className="data-actions">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        title="Revoke trust"
                        onClick={(event) => {
                          trigger.current = event.currentTarget;
                          void prepare(entry);
                        }}
                      >
                        <ShieldOffIcon data-icon="inline-start" />
                        <span className="data-action-text">Revoke trust</span>
                      </Button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {activePreview ? (
        <RevokeDrawer
          key={activePreview.token}
          preview={activePreview}
          busy={busy}
          failed={failed}
          trigger={trigger}
          onRevoke={() => void revoke()}
          onClose={() => {
            setPreview(undefined);
            setFailed(false);
          }}
        />
      ) : null}
    </div>
  );
}

function RevokeDrawer({
  preview,
  busy,
  failed,
  trigger,
  onRevoke,
  onClose,
}: {
  preview: KnownHostRevokePreview;
  busy: boolean;
  failed: Failure;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onRevoke(): void;
  onClose(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const close = useDrawerClose({ busy });
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      finalFocus={trigger}
      title="Revoke this host's trust?"
      target={
        <span className="min-w-0 break-all font-mono">
          {preview.entry.endpointHost}:{preview.entry.endpointPort}
        </span>
      }
      description="The next connection will require a new trust decision. Active sessions keep their current connection."
      footer={
        <>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={close.request}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onRevoke}>
            {busy ? <Spinner data-icon="inline-start" /> : null}Revoke trust
          </Button>
        </>
      }
    >
      <KeyDetails entry={preview.entry} label="Key being revoked" />
      {failed ? <TrustError conflict={failed === "conflict"} /> : null}
    </Drawer>
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
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
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
  // Alert semantics: an outside click never decides; Escape and × are an explicit reject. A successful answer removes
  // the prompt through the ordered state stream, which unmounts this drawer.
  const close = { ...useDrawerClose(), request: () => void answer("reject") };
  const changed = prompt.status === "changed";
  return (
    <Drawer
      close={close}
      onClose={() => undefined}
      alert
      initialFocus={reject}
      finalFocus={promptFinalFocus(returnFocus.current, prompt.sessionId)}
      className={changed ? "border-l-destructive" : undefined}
      data-testid="host-trust-dialog"
      data-status={prompt.status}
      title={
        changed ? (
          <span className="flex items-center gap-2">
            <ShieldAlertIcon aria-hidden="true" className="size-5 shrink-0 text-destructive" />
            Server identity changed
          </span>
        ) : (
          "Trust this server?"
        )
      }
      target={<Target prompt={prompt} />}
      description={
        changed
          ? "Connection is blocked. A changed key can indicate an attack or a server rebuild. Verify the new fingerprint through a trusted channel before replacing it."
          : "This server's identity is unknown. Verify the fingerprint through a trusted channel before connecting."
      }
      footer={
        <>
          <Button ref={reject} variant="outline" disabled={busy} onClick={() => void answer("reject")}>
            Reject
          </Button>
          {changed ? (
            <Button
              variant="destructive"
              disabled={busy || !confirmed || !available}
              onClick={() => void answer("replace")}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}Replace key
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={busy || !available} onClick={() => void answer("accept-once")}>
                Accept once
              </Button>
              <Button disabled={busy || !available} onClick={() => void answer("remember")}>
                {busy ? <Spinner data-icon="inline-start" /> : null}Remember
              </Button>
            </>
          )}
        </>
      }
    >
      {prompt.jumpFor ? (
        <p className="type-caption min-w-0 break-all text-muted-foreground" data-testid="trust-jump-for">
          Jump host on the way to {prompt.jumpFor}. This key belongs to the jump host.
        </p>
      ) : null}
      {prompt.status === "changed" ? (
        <>
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>Host key mismatch</AlertTitle>
            <AlertDescription>
              Authentication will stay blocked until you deliberately replace the remembered key.
            </AlertDescription>
          </Alert>
          <KeyDetails
            entry={{ algorithm: prompt.previousAlgorithm, fingerprint: prompt.previousFingerprint }}
            label="Previous key"
          />
        </>
      ) : null}
      <KeyDetails entry={prompt} label={changed ? "New key" : "Server key"} />
      {changed ? (
        <div className="flex items-start gap-2">
          <Checkbox
            id="confirm-host-replacement"
            checked={confirmed}
            onCheckedChange={(checked) => setConfirmed(checked === true)}
            disabled={busy}
          />
          <Label htmlFor="confirm-host-replacement" className="leading-snug">
            I verified the new fingerprint and want to replace this host's remembered key.
          </Label>
        </div>
      ) : null}
      {failed || !available ? <TrustError /> : null}
    </Drawer>
  );
}
