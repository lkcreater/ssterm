import { useEffect, useId, useRef, useState } from "react";
import type { Owner, SyncAction, SyncReply, SyncView } from "@ssterm/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { call } from "@/components/identities/secret-input";

const errors: Record<string, string> = {
  "active-tunnels":
    "Stop all starting, active or stopping tunnels before applying a sync merge, then review again.",
  "too-large":
    "A sync message, history or key-wrap limit was reached. Nothing was truncated; preserve this profile for explicit migration.",
  conflict: "This version changed or needs a merge. Fetch and review again.",
  "stale-control": "The device list changed. Fetch before publishing again.",
  "key-unavailable":
    "Sync keys are unavailable. Preserve this profile and use your separate sync recovery kit if needed.",
  "untrusted-authority":
    "The server authority does not match this device. Compare the full owner fingerprint independently.",
  fenced: "The action ended because this workspace locked or changed.",
  invalid: "Check the supplied connection or enrollment details.",
  unauthorized: "The server did not accept the account token or device.",
  forbidden: "This device does not have permission for that action.",
};
/** Manual, explicit personal sync. Setup/recovery inputs live only while this settings panel is mounted. */
export function SyncSettings({
  owner,
  onBusyChange,
  onLock,
}: {
  owner: Owner;
  onBusyChange?(busy: boolean): void;
  onLock?(): void;
}) {
  const prefix = useId();
  const mounted = useRef(true);
  const running = useRef(false);
  const uiEpoch = useRef(0);
  const [state, setState] = useState<SyncView>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [detail, setDetail] = useState<SyncReply["detail"]>({ kind: "none" });
  const [mode, setMode] = useState<"create" | "join" | "recover">("create");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [deploymentId, setDeploymentId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [consent, setConsent] = useState(false);
  const [exchange, setExchange] = useState("");
  const [secret, setSecret] = useState("");
  const [choices, setChoices] = useState<
    Record<string, "local" | "remote" | "restore">
  >({});
  const clear = () => {
    setToken("");
    setSecret("");
    setExchange("");
    setDetail({ kind: "none" });
    setChoices({});
  };
  useEffect(() => {
    let live = true;
    let lockEpoch: number | undefined;
    mounted.current = true;
    const observeLock = (epoch: number, event: boolean) => {
      const previous = lockEpoch;
      lockEpoch = Math.max(previous ?? 0, epoch);
      if ((!event && previous === undefined) || epoch <= (previous ?? 0))
        return;
      uiEpoch.current++;
      clear();
      running.current = false;
      setBusy(false);
      onBusyChange?.(false);
      onLock?.();
    };
    const off = window.ssterm?.onCatalogState((value) => {
      if (live) observeLock(value.lockEpoch, true);
    });
    void call((bridge) => bridge.catalogState({ owner })).then((result) => {
      if (live && result.ok) observeLock(result.value.lockEpoch, false);
    });
    const epoch = uiEpoch.current;
    void call((bridge) => bridge.syncState({ owner })).then((result) => {
      if (!live || epoch !== uiEpoch.current) return;
      if (result.ok) setState(result.value);
      else
        setProblem(
          "Sync is unavailable in this workspace. Local work remains available.",
        );
    });
    return () => {
      live = false;
      mounted.current = false;
      uiEpoch.current++;
      off?.();
      onBusyChange?.(false);
    };
  }, [owner.windowId, owner.generation]);
  async function run(action: SyncAction) {
    if (running.current) return;
    running.current = true;
    const epoch = uiEpoch.current;
    onBusyChange?.(true);
    setBusy(true);
    setProblem(undefined);
    setChoices({});
    setDetail({ kind: "none" });
    try {
      const result = await call((bridge) =>
        bridge.syncCommand({ owner, action }),
      );
      if (!mounted.current || epoch !== uiEpoch.current) return;
      if (!result.ok) {
        clear();
        setProblem(
          "Sync could not finish. Unlock the workspace and try again.",
        );
        return;
      }
      setState(result.value.state);
      setDetail(result.value.detail);
      if (result.value.outcome === "failed")
        setProblem(
          errors[result.value.code ?? ""] ??
            "Sync could not finish. Your local data and pending encrypted work are preserved.",
        );
      if (result.value.outcome === "cancelled")
        setProblem("Cancelled. Recovery has not been confirmed.");
    } finally {
      if (mounted.current && epoch === uiEpoch.current) {
        onBusyChange?.(false);
        running.current = false;
        setBusy(false);
        setToken("");
        setSecret("");
        setExchange("");
      }
    }
  }
  const connection = {
    endpoint,
    token,
    expectedScope: { deploymentId, accountId, vaultId },
  };
  const configured = !!state?.deviceId;
  const field = (
    name: string,
    label: string,
    value: string,
    change: (v: string) => void,
    password = false,
  ) => (
    <Field>
      <FieldLabel htmlFor={`${prefix}-${name}`}>{label}</FieldLabel>
      <Input
        id={`${prefix}-${name}`}
        value={value}
        onChange={(event) => change(event.target.value)}
        type={password ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
    </Field>
  );
  return (
    <FieldSet data-testid="sync-settings" disabled={busy}>
      <FieldLegend>Encrypted personal sync</FieldLegend>
      <FieldDescription>
        Publish and apply changes explicitly through your own server. Sync
        recovery is separate from the code used to unlock ssterm.
      </FieldDescription>
      {problem ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      {state ? (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{state.status}</Badge>
            {state.role ? (
              <Badge variant="secondary">{state.role}</Badge>
            ) : null}
            {busy ? <Spinner /> : null}
          </div>
          {state.endpoint ? (
            <p className="break-all text-sm">Server: {state.endpoint}</p>
          ) : null}
          {state.deviceId ? (
            <p className="break-all text-sm text-muted-foreground">
              Device: {state.deviceId} · epoch {state.epoch} · control{" "}
              {state.generation}
            </p>
          ) : null}
          {state.status === "revoked" ? (
            <Alert>
              <AlertDescription>
                This device was removed from the current roster. It keeps data
                it already held and cannot fetch or apply new sync data.
              </AlertDescription>
            </Alert>
          ) : null}
          {state.ownerFingerprint ? (
            <p
              className="break-all font-mono text-xs"
              data-testid="sync-owner-fingerprint"
            >
              Owner fingerprint: {state.ownerFingerprint}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Pending uploads: {state.outbox} · Fetched: {state.inbox} ·
            Conflicts: {state.conflicts}
          </p>
          {state.warnings.map((warning, index) => (
            <p key={index} className="text-sm text-muted-foreground">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      {!configured ? (
        <FieldGroup>
          <ToggleGroup
            value={[mode]}
            onValueChange={(values) => {
              const value = values[0];
              if (
                value === "create" ||
                value === "join" ||
                value === "recover"
              ) {
                setMode(value);
                clear();
              }
            }}
            aria-label="Sync setup"
          >
            <ToggleGroupItem value="create">Create vault</ToggleGroupItem>
            <ToggleGroupItem value="join">Join device</ToggleGroupItem>
            <ToggleGroupItem value="recover">Recover owner</ToggleGroupItem>
          </ToggleGroup>
          {field("endpoint", "Server URL", endpoint, setEndpoint)}
          {field("deployment", "Deployment ID", deploymentId, setDeploymentId)}
          {field("account", "Account ID", accountId, setAccountId)}
          {field("vault", "Sync vault ID", vaultId, setVaultId)}
          {field("token", "Server account token", token, setToken, true)}
          {mode !== "create"
            ? field(
                "fingerprint",
                "Expected owner fingerprint (compare independently)",
                fingerprint,
                setFingerprint,
              )
            : null}
          {mode === "recover"
            ? field(
                "recovery-secret",
                "Sync recovery secret",
                secret,
                setSecret,
                true,
              )
            : null}
          <Field orientation="horizontal">
            <Checkbox
              id={`${prefix}-consent`}
              checked={consent}
              onCheckedChange={(value) => setConsent(value === true)}
            />
            <FieldLabel htmlFor={`${prefix}-consent`}>
              I choose this server and understand the sync policy below.
            </FieldLabel>
          </Field>
          <Alert>
            <AlertDescription>
              Sync includes hosts, groups, tags, login names and snippet bodies,
              encrypted before upload. Passwords, SSH keys, known-host trust,
              recordings and local settings stay on this Mac. Imported logins
              may need authentication set up locally.
            </AlertDescription>
          </Alert>
          <Button
            variant="outline"
            disabled={busy || !consent || !token || !endpoint}
            onClick={() =>
              void run(
                mode === "create"
                  ? {
                      type: "create",
                      ...connection,
                      deviceLabel: "This Mac",
                      consent: true,
                    }
                  : mode === "join"
                    ? {
                        type: "begin-join",
                        ...connection,
                        expectedOwnerFingerprint: fingerprint,
                        role: "writer",
                        consent: true,
                      }
                    : {
                        type: "recover",
                        ...connection,
                        expectedOwnerFingerprint: fingerprint,
                        secret,
                        consent: true,
                      },
              )
            }
          >
            {mode === "create"
              ? "Create encrypted vault"
              : mode === "join"
                ? "Create device request"
                : "Choose encrypted recovery kit"}
          </Button>
        </FieldGroup>
      ) : (
        <FieldGroup>
          {state?.needsToken ? (
            <FieldSet>
              <FieldLegend>Reconnect to the same server</FieldLegend>
              <FieldDescription>
                Your enrollment and keys are retained. Enter the account token
                for this server to resume explicit sync actions.
              </FieldDescription>
              {field(
                "resume-token",
                "Server account token",
                token,
                setToken,
                true,
              )}
              <Button
                variant="outline"
                disabled={busy || !token}
                onClick={() => void run({ type: "resume", token })}
              >
                Resume sync
              </Button>
            </FieldSet>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={
                busy ||
                !state ||
                state.needsToken ||
                state.status === "disabled" ||
                state.status === "revoked" ||
                state.canCancelSetup
              }
              onClick={() => void run({ type: "fetch" })}
            >
              {state?.status === "enrolled"
                ? "Fetch changes"
                : "Retry pending sync"}
            </Button>
            <Button
              variant="outline"
              disabled={
                busy ||
                state?.status !== "enrolled" ||
                state.needsToken ||
                state.role === "reader"
              }
              onClick={() => void run({ type: "publish" })}
            >
              Publish local changes
            </Button>
            <Button
              variant="outline"
              disabled={
                busy || state?.status !== "enrolled" || state.needsToken
              }
              onClick={() => void run({ type: "review", operationHashes: [] })}
            >
              Review merge
            </Button>
            {state?.status === "pending" ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ type: "finish-join" })}
              >
                Finish approved enrollment
              </Button>
            ) : null}
          </div>
          {state?.canCancelSetup ? (
            <>
              <p className="text-sm text-muted-foreground">
                If initial setup stopped before any control was staged for
                publication, you can cancel it and remove only its unpublished
                local sync keys. Published or joining-device enrollment is
                preserved.
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ type: "cancel-setup" })}
              >
                Cancel unpublished setup
              </Button>
            </>
          ) : null}
          <FieldSet>
            <FieldLegend>Device enrollment</FieldLegend>
            <FieldDescription>
              Exchange these public messages with the other device. Compare the
              complete fingerprint over an independent trusted channel before
              approval.
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor={`${prefix}-exchange`}>
                Message from the other device
              </FieldLabel>
              <Textarea
                id={`${prefix}-exchange`}
                value={exchange}
                onChange={(event) => setExchange(event.target.value)}
                spellCheck={false}
                autoComplete="off"
                maxLength={65536}
              />
            </Field>
            {field(
              "confirm-fingerprint",
              "Confirmed full enrollment fingerprint",
              fingerprint,
              setFingerprint,
            )}
            <div className="flex flex-wrap gap-2">
              {state?.role === "owner" ? (
                <>
                  <Button
                    variant="outline"
                    disabled={busy || !exchange}
                    onClick={() =>
                      void run({ type: "challenge", candidateText: exchange })
                    }
                  >
                    Challenge device request
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !exchange || fingerprint.length !== 64}
                    onClick={() =>
                      void run({
                        type: "approve",
                        proofText: exchange,
                        confirmedFingerprint: fingerprint,
                      })
                    }
                  >
                    Approve compared proof
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy || !exchange}
                  onClick={() =>
                    void run({ type: "prove", challengeText: exchange })
                  }
                >
                  Prove device possession
                </Button>
              )}
            </div>
          </FieldSet>
          {state?.role === "owner" ? (
            <FieldSet>
              <FieldLegend>Devices and recovery</FieldLegend>
              {state.devices.map((device) => (
                <div
                  key={device.deviceId}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="break-all text-sm">
                    {device.deviceId} · {device.role}
                  </span>
                  {device.deviceId !== state.deviceId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run({
                          type: "rotate",
                          removeDeviceIds: [device.deviceId],
                          readerDeviceIds: [],
                        })
                      }
                    >
                      Remove device and rotate
                    </Button>
                  ) : null}
                </div>
              ))}
              <p className="text-sm text-muted-foreground">
                Recovery kit:{" "}
                {state.recoveryReady
                  ? "verified for retained sync material"
                  : "needs creation or refresh"}
                . Keep the kit and its secret separately.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run({
                      type: "rotate",
                      removeDeviceIds: [],
                      readerDeviceIds: [],
                    })
                  }
                >
                  Rotate epoch
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run({ type: "create-recovery" })}
                >
                  Save new encrypted recovery kit
                </Button>
              </div>
            </FieldSet>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Stopping sync forgets this Mac’s server token and keeps its
            enrollment keys and encrypted data. It does not revoke the device
            remotely; removed devices retain data they already decrypted.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run({ type: "logout", forgetTransportToken: true })
            }
          >
            Stop sync and forget token
          </Button>
        </FieldGroup>
      )}
      {detail.kind === "text" ? (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${prefix}-output`}>
              Message for the other device
            </FieldLabel>
            <Textarea
              id={`${prefix}-output`}
              readOnly
              value={detail.text}
              spellCheck={false}
            />
          </Field>
          {detail.fingerprint ? (
            <p className="break-all font-mono text-xs">
              Enrollment fingerprint: {detail.fingerprint}
            </p>
          ) : null}
        </FieldGroup>
      ) : null}
      {detail.kind === "recovery" ? (
        <FieldGroup>
          <Alert>
            <AlertDescription>
              Save this secret separately now. It is shown only in this panel
              and is required with the encrypted kit. Closing Settings clears
              it.
            </AlertDescription>
          </Alert>
          <p
            className="break-all select-text font-mono text-sm"
            data-testid="sync-recovery-secret"
          >
            {detail.secret}
          </p>
          {field(
            "confirm-secret",
            "Re-enter the saved sync recovery secret",
            secret,
            setSecret,
            true,
          )}
          <Button
            variant="outline"
            disabled={busy || !secret}
            onClick={() =>
              void run({
                type: "confirm-recovery",
                confirmationToken: detail.confirmationToken,
                secret,
              })
            }
          >
            Verify recovery kit
          </Button>
        </FieldGroup>
      ) : null}
      {detail.kind === "review" ? (
        <FieldGroup>
          <p>
            {detail.review.records} records · {detail.review.deletions}{" "}
            deletions
          </p>
          {detail.review.warnings.map((warning, index) => (
            <p key={index} className="text-sm">
              {warning}
            </p>
          ))}
          {detail.review.conflicts.map((conflict) => (
            <Field key={conflict.key}>
              <FieldLabel>
                {conflict.label || conflict.type}: {conflict.reason}
              </FieldLabel>
              <div className="flex flex-col gap-2 text-sm">
                <p>Local version</p>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                  {conflict.localPreview}
                </pre>
                <p>Remote version</p>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                  {conflict.remotePreview}
                </pre>
              </div>
              <ToggleGroup
                aria-label={`Resolve ${conflict.label || conflict.id}`}
                value={choices[conflict.key] ? [choices[conflict.key]!] : []}
                onValueChange={(values) => {
                  const choice = values[0];
                  if (
                    choice === "local" ||
                    choice === "remote" ||
                    choice === "restore"
                  )
                    setChoices((previous) => ({
                      ...previous,
                      [conflict.key]: choice,
                    }));
                }}
              >
                <ToggleGroupItem value="local">Keep local</ToggleGroupItem>
                <ToggleGroupItem value="remote">Use remote</ToggleGroupItem>
                <ToggleGroupItem value="restore">
                  Restore as new
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          ))}
          <Button
            disabled={
              busy ||
              detail.review.conflicts.some((conflict) => !choices[conflict.key])
            }
            onClick={() =>
              void run({
                type: "apply",
                reviewToken: detail.review.reviewToken,
                resolutions: Object.entries(choices).map(([key, choice]) => ({
                  key,
                  choice,
                })),
              })
            }
          >
            Apply reviewed merge
          </Button>
        </FieldGroup>
      ) : null}
    </FieldSet>
  );
}
