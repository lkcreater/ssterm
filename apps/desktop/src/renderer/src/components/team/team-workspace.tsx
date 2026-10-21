import { useEffect, useId, useRef, useState } from "react";
import type { Owner, TeamAction, TeamReply, TeamView } from "@ssterm/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  call,
  imeEnterGuard,
  secretFieldProps,
  useSecretInput,
  type SecretInput,
} from "@/components/identities/secret-input";

type MemberRole = "Editor" | "Connector" | "Viewer";
type TeamHost = TeamView["hosts"][number];
const errors: Record<string, string> = {
  unauthorized:
    "This principal token or device is no longer authorized. Fetch current membership or ask the Owner for help.",
  forbidden: "Your current team role or device cannot perform this action.",
  conflict:
    "The team changed. Fetch the current view, review the target, and try again.",
  offline:
    "The server is unavailable. Cached metadata is read-only; new connections require an online permission check.",
  network:
    "The server is unavailable. Cached metadata is read-only; new connections require an online permission check.",
  "key-unavailable":
    "Team keys are unavailable. Preserve this profile; team recovery is separate from personal sync and app unlock.",
  "untrusted-authority":
    "The Owner fingerprint does not match. Compare the complete fingerprint independently before proceeding.",
  "too-large":
    "A team data or history limit was reached. Nothing was truncated; preserve this profile.",
  fenced: "The action ended because this workspace locked or changed.",
};

/** Explicit online team actions. Secrets are transient; shared SSH passwords never enter React state. */
export function TeamWorkspace({
  owner,
  onConnect,
}: {
  owner: Owner;
  onConnect(virtualHostId: string): Promise<void>;
}) {
  const prefix = useId();
  const mounted = useRef(true),
    running = useRef(false),
    epoch = useRef(0);
  const container = useRef<HTMLDivElement>(null),
    opener = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<TeamView>();
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<string>();
  const [detail, setDetail] = useState<TeamReply["detail"]>({ kind: "none" });
  const [mode, setMode] = useState<"create" | "join" | "recover">("create");
  const [endpoint, setEndpoint] = useState("");
  const [deploymentId, setDeploymentId] = useState(""),
    [accountId, setAccountId] = useState("");
  const [teamId, setTeamId] = useState(""),
    [metadataVaultId, setMetadataVaultId] = useState(""),
    [credentialVaultId, setCredentialVaultId] = useState("");
  const [principalId, setPrincipalId] = useState(""),
    [fingerprint, setFingerprint] = useState("");
  const [displayName, setDisplayName] = useState("This team"),
    [consent, setConsent] = useState(false);
  const [exchange, setExchange] = useState(""),
    [confirmedFingerprint, setConfirmedFingerprint] = useState("");
  const [enrollPrincipal, setEnrollPrincipal] = useState(""),
    [enrollRole, setEnrollRole] = useState<MemberRole>("Connector");
  const [inviteLabel, setInviteLabel] = useState(""),
    [inviteRole, setInviteRole] = useState<MemberRole>("Connector");
  const [roleChanges, setRoleChanges] = useState<Record<string, MemberRole>>(
    {},
  );
  const [editing, setEditing] = useState<Partial<TeamHost>>();
  const [passwordHost, setPasswordHost] = useState<TeamHost>();
  const [passwordConsent, setPasswordConsent] = useState(false);
  const [forgetToken, setForgetToken] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    action: TeamAction;
  }>();
  const token = useSecretInput(),
    recoverySecret = useSecretInput(),
    password = useSecretInput();
  const rememberFocus = () => {
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  };
  const returnFocus = () => {
    const since = epoch.current;
    requestAnimationFrame(() => {
      if (mounted.current && since === epoch.current)
        (opener.current?.isConnected
          ? opener.current
          : container.current?.querySelector<HTMLElement>("h2")
        )?.focus();
    });
  };
  const clear = () => {
    token.clear();
    recoverySecret.clear();
    password.clear();
    setDetail({ kind: "none" });
    setExchange("");
    setConfirmedFingerprint("");
    setEditing(undefined);
    setPasswordHost(undefined);
    setPasswordConsent(false);
    setConfirmation(undefined);
  };
  useEffect(() => {
    mounted.current = true;
    let live = true,
      lockEpoch: number | undefined;
    const observeLock = (next: number, event: boolean) => {
      const previous = lockEpoch;
      lockEpoch = Math.max(previous ?? 0, next);
      if ((!event && previous === undefined) || next <= (previous ?? 0)) return;
      epoch.current++;
      clear();
      setState(undefined);
      setBusy(false);
      running.current = false;
    };
    const off = window.ssterm?.onCatalogState((value) => {
      if (live) observeLock(value.lockEpoch, true);
    });
    void call((bridge) => bridge.catalogState({ owner })).then((reply) => {
      if (live && reply.ok) observeLock(reply.value.lockEpoch, false);
    });
    const since = epoch.current;
    void call((bridge) => bridge.teamState({ owner })).then((reply) => {
      if (!live || since !== epoch.current) return;
      if (reply.ok) setState(reply.value);
      else setProblem("Team vault is unavailable in this workspace.");
    });
    return () => {
      live = false;
      mounted.current = false;
      epoch.current++;
      off?.();
      token.clear();
      recoverySecret.clear();
      password.clear();
    };
  }, [owner.windowId, owner.generation]);

  async function run(action: TeamAction) {
    if (running.current) {
      if (action.type === "share-password") action.password.fill(0);
      return;
    }
    running.current = true;
    setBusy(true);
    setProblem(undefined);
    setDetail({ kind: "none" });
    const since = epoch.current;
    try {
      const reply = await call((bridge) =>
        bridge.teamCommand({ owner, action }),
      );
      if (!mounted.current || since !== epoch.current) return;
      if (!reply.ok) {
        clear();
        setProblem(
          "The team action could not finish. Check the workspace and try again.",
        );
        return;
      }
      setState(reply.value.state);
      setDetail(reply.value.detail);
      if (reply.value.outcome === "failed")
        setProblem(
          errors[reply.value.code ?? ""] ??
            "The team action could not finish. Pending encrypted work is preserved.",
        );
      if (reply.value.outcome === "cancelled")
        setProblem("Cancelled. Recovery has not been confirmed.");
      if (reply.value.outcome === "ok") {
        if (action.type === "begin-join") setReenrolling(false);
        setEditing(undefined);
        setPasswordHost(undefined);
        setPasswordConsent(false);
        if (action.type === "save-host" || action.type === "share-password")
          returnFocus();
      }
    } finally {
      if (action.type === "share-password") action.password.fill(0);
      if (mounted.current && since === epoch.current) {
        token.clear();
        recoverySecret.clear();
        password.clear();
        running.current = false;
        setBusy(false);
      }
    }
  }
  const field = (
    name: string,
    label: string,
    value: string,
    change: (value: string) => void,
  ) => (
    <Field key={name}>
      <FieldLabel htmlFor={`${prefix}-${name}`}>{label}</FieldLabel>
      <Input
        id={`${prefix}-${name}`}
        value={value}
        onChange={(event) => change(event.target.value)}
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
      />
    </Field>
  );
  const secretField = (name: string, label: string, input: SecretInput) => (
    <Field>
      <FieldLabel htmlFor={`${prefix}-${name}`}>{label}</FieldLabel>
      <Input
        id={`${prefix}-${name}`}
        ref={input.ref}
        {...secretFieldProps}
        disabled={busy}
      />
    </Field>
  );
  const roles = (
    label: string,
    value: MemberRole,
    change: (role: MemberRole) => void,
  ) => (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(values) => {
        const role = values[0];
        if (role === "Editor" || role === "Connector" || role === "Viewer")
          change(role);
      }}
      disabled={busy}
    >
      <ToggleGroupItem value="Editor">Editor</ToggleGroupItem>
      <ToggleGroupItem value="Connector">Connector</ToggleGroupItem>
      <ToggleGroupItem value="Viewer">Viewer</ToggleGroupItem>
    </ToggleGroup>
  );
  async function setup() {
    const bytes = token.take(),
      secretBytes = mode === "recover" ? recoverySecret.take() : null;
    if (!bytes || (mode === "recover" && !secretBytes)) {
      bytes?.fill(0);
      secretBytes?.fill(0);
      setProblem("Enter the required token and recovery secret.");
      return;
    }
    try {
      const connection = {
        endpoint,
        token: new TextDecoder().decode(bytes),
        principalId,
        expectedScope: {
          deploymentId,
          accountId,
          teamId,
          metadataVaultId,
          credentialVaultId,
        },
        consent: true as const,
      };
      await run(
        mode === "create"
          ? { type: "create", ...connection, displayName }
          : mode === "join"
            ? {
                type: "begin-join",
                ...connection,
                expectedOwnerFingerprint: fingerprint,
              }
            : {
                type: "recover",
                ...connection,
                expectedOwnerFingerprint: fingerprint,
                secret: new TextDecoder().decode(secretBytes!),
              },
      );
    } finally {
      bytes.fill(0);
      secretBytes?.fill(0);
    }
  }
  async function resume() {
    const bytes = token.take();
    if (!bytes) return;
    try {
      await run({ type: "resume", token: new TextDecoder().decode(bytes) });
    } finally {
      bytes.fill(0);
    }
  }
  async function sharePassword() {
    if (
      !passwordHost ||
      !state?.metadataHash ||
      !state.credentialHash ||
      !passwordConsent
    )
      return;
    const bytes = password.take();
    if (!bytes) {
      setProblem("Enter a password to share.");
      return;
    }
    try {
      await run({
        type: "share-password",
        recordId: passwordHost.recordId,
        password: Uint8Array.from(bytes),
        consent: true,
        expectedMetadataHash: state.metadataHash,
        expectedCredentialHash: state.credentialHash,
      });
    } finally {
      bytes.fill(0);
    }
  }
  const enrolled = state?.status === "enrolled" && !state.needsToken;
  const canEdit =
    enrolled && (state?.role === "Owner" || state?.role === "Editor");
  const canConnect =
    enrolled && state?.role !== "Viewer" && state?.role !== null;
  const canManage = enrolled && state?.canManage;
  const configured = !!state?.deviceId;
  const [reenrolling, setReenrolling] = useState(false);
  const selectedHost =
    passwordHost &&
    state?.hosts.find((host) => host.recordId === passwordHost.recordId);
  return (
    <div
      ref={container}
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-5"
      data-testid="team-workspace"
    >
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold" tabIndex={-1}>
          Team vault
        </h2>
        <p className="text-sm text-muted-foreground">
          Use your own server for encrypted shared hosts and Owner-shared SSH
          passwords. Team membership is separate from personal sync and Google
          sign-in.
        </p>
      </div>
      <Alert>
        <AlertDescription>
          New connections and edits require an online permission check. While
          Team sessions are open, ssterm checks policy every 15 seconds.
          Existing SSH can continue while offline until removal is observed.
          Removing a member closes their observed app sessions; rotate remote
          passwords separately. Opt-in terminal recording also applies to Team
          output.
        </AlertDescription>
      </Alert>
      {problem ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <Badge variant="outline">{state?.status ?? "Loading team"}</Badge>
        {state?.role ? <Badge variant="secondary">{state.role}</Badge> : null}
        {busy ? <Spinner aria-label="Working on team vault" /> : null}
      </div>
      {state?.endpoint ? (
        <p className="break-all text-sm">Server: {state.endpoint}</p>
      ) : null}
      {state?.ownerFingerprint ? (
        <p
          className="break-all font-mono text-xs"
          data-testid="team-owner-fingerprint"
        >
          Owner fingerprint: {state.ownerFingerprint}
        </p>
      ) : null}
      {state?.deviceId ? (
        <p className="break-all text-sm text-muted-foreground">
          Device: {state.deviceId} · policy {state.generation} · metadata epoch{" "}
          {state.metadataEpoch} · credential epoch {state.credentialEpoch} ·
          pending {state.pending}
        </p>
      ) : null}
      {state?.warnings.map((warning, index) => (
        <p key={index} className="text-sm text-muted-foreground">
          {warning}
        </p>
      ))}
      {state?.status === "revoked" ? (
        <Alert>
          <AlertDescription>
            This device has no current team access. Data and passwords already
            copied elsewhere cannot be erased remotely. Ask the Owner for a
            fresh invitation or device approval.
          </AlertDescription>
        </Alert>
      ) : null}
      {state?.status === "revoked" && !reenrolling ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            clear();
            setEndpoint(state.endpoint ?? "");
            setDeploymentId(state.scope?.deploymentId ?? "");
            setAccountId(state.scope?.accountId ?? "");
            setTeamId(state.scope?.teamId ?? "");
            setMetadataVaultId(state.scope?.metadataVaultId ?? "");
            setCredentialVaultId(state.scope?.credentialVaultId ?? "");
            setPrincipalId(state.principalId ?? "");
            setFingerprint(state.ownerFingerprint ?? "");
            setMode("join");
            setReenrolling(true);
          }}
        >
          Request fresh Team device approval
        </Button>
      ) : null}
      {!configured || reenrolling ? (
        <FieldSet disabled={busy}>
          <FieldLegend>Set up Team vault</FieldLegend>
          <FieldGroup>
            <ToggleGroup
              value={[mode]}
              aria-label="Team setup"
              disabled={busy}
              onValueChange={(values) => {
                const value = values[0];
                if (
                  value === "create" ||
                  value === "join" ||
                  value === "recover"
                ) {
                  clear();
                  setMode(value);
                }
              }}
            >
              <ToggleGroupItem value="create">Create team</ToggleGroupItem>
              <ToggleGroupItem value="join">Join team</ToggleGroupItem>
              <ToggleGroupItem value="recover">Recover Owner</ToggleGroupItem>
            </ToggleGroup>
            {field("endpoint", "Team server URL", endpoint, setEndpoint)}
            {field(
              "deployment",
              "Deployment ID",
              deploymentId,
              setDeploymentId,
            )}
            {field("account", "Account ID", accountId, setAccountId)}
            {field("team", "Team ID", teamId, setTeamId)}
            {field(
              "metadata-vault",
              "Metadata vault ID",
              metadataVaultId,
              setMetadataVaultId,
            )}
            {field(
              "credential-vault",
              "Credential vault ID",
              credentialVaultId,
              setCredentialVaultId,
            )}
            {field("principal", "Principal ID", principalId, setPrincipalId)}
            {secretField("token", "Principal token", token)}
            {mode === "create"
              ? field(
                  "display-name",
                  "Team display name",
                  displayName,
                  setDisplayName,
                )
              : field(
                  "owner-fingerprint",
                  "Expected Owner fingerprint (compare independently)",
                  fingerprint,
                  setFingerprint,
                )}
            {mode === "recover"
              ? secretField(
                  "recovery-secret",
                  "Team recovery secret",
                  recoverySecret,
                )
              : null}
            <Field orientation="horizontal">
              <Checkbox
                id={`${prefix}-consent`}
                checked={consent}
                onCheckedChange={(value) => setConsent(value === true)}
              />
              <FieldLabel htmlFor={`${prefix}-consent`}>
                I choose this server and understand the Team connection and
                sharing policy.
              </FieldLabel>
            </Field>
            <Button
              variant="outline"
              disabled={busy || !consent || !endpoint}
              onClick={() => void setup()}
            >
              {mode === "create"
                ? "Create encrypted team"
                : mode === "join"
                  ? "Create Team device request"
                  : "Choose Team recovery kit"}
            </Button>
          </FieldGroup>
        </FieldSet>
      ) : (
        <FieldSet disabled={busy}>
          <FieldLegend>Team actions</FieldLegend>
          <FieldGroup>
            {state?.needsToken ? (
              <>
                {secretField("resume-token", "Principal token", token)}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void resume()}
                >
                  Resume Team access
                </Button>
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || state?.needsToken}
                onClick={() => void run({ type: "fetch" })}
              >
                Fetch Team changes
              </Button>
              {state?.status !== "enrolled" ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run({ type: "finish-join" })}
                >
                  Finish Team device approval
                </Button>
              ) : null}
              {state?.status === "pending" || state?.status === "reconcile" ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run({ type: "cancel-setup" })}
                >
                  Cancel unpublished Team setup
                </Button>
              ) : null}
            </div>
            <Field orientation="horizontal">
              <Checkbox
                id={`${prefix}-forget-token`}
                checked={forgetToken}
                onCheckedChange={(value) => setForgetToken(value === true)}
              />
              <FieldLabel htmlFor={`${prefix}-forget-token`}>
                Also forget the saved principal token on this Mac
              </FieldLabel>
            </Field>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run({ type: "logout", forgetTransportToken: forgetToken })
              }
            >
              Lock Team vault
            </Button>
          </FieldGroup>
        </FieldSet>
      )}
      {configured ? (
        <FieldSet disabled={busy}>
          <FieldLegend>Team hosts</FieldLegend>
          <FieldDescription>
            Cached metadata is read-only offline. Team hosts support direct SSH
            terminals; Files, forwarding, jumps, proxies and templates are
            unavailable.
          </FieldDescription>
          {canEdit ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                rememberFocus();
                clear();
                setEditing({
                  label: "",
                  address: "",
                  username: "",
                  port: 22,
                  environment: null,
                });
              }}
            >
              Add Team host
            </Button>
          ) : null}
          <div className="flex flex-col gap-3">
            {state?.hosts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Team hosts are available.
              </p>
            ) : null}
            {state?.hosts.map((host) => (
              <div
                key={host.recordId}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
                data-team-host-id={host.recordId}
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium">{host.label}</p>
                  <p className="break-all font-mono text-xs">
                    {host.username}@{host.address}:{host.port}
                  </p>
                </div>
                <Badge variant="secondary">Team</Badge>
                {host.environment === "PROD" ? (
                  <Badge variant="production">PROD</Badge>
                ) : host.environment ? (
                  <Badge variant="outline">{host.environment}</Badge>
                ) : null}
                <Button
                  variant="outline"
                  disabled={busy || !canConnect}
                  aria-label={`Connect to Team host ${host.label}`}
                  onClick={() => void onConnect(host.virtualHostId)}
                >
                  Connect
                </Button>
                {canEdit ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy}
                      aria-label={`Edit Team host ${host.label}`}
                      onClick={() => {
                        rememberFocus();
                        clear();
                        setEditing({ ...host });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || !state.metadataHash}
                      aria-label={`Delete Team host ${host.label}`}
                      onClick={() => {
                        setConfirmation({
                          title: `Delete Team host ${host.label}?`,
                          description:
                            "Existing sessions retain their captured target.",
                          action: {
                            type: "delete-host",
                            recordId: host.recordId,
                            expectedMetadataHash: state.metadataHash!,
                          },
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </>
                ) : null}
                {canManage ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy}
                      aria-label={`Share password for ${host.label}`}
                      onClick={() => {
                        rememberFocus();
                        clear();
                        setPasswordHost({ ...host });
                      }}
                    >
                      Share or replace password
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || !state.credentialHash}
                      aria-label={`Detach password for ${host.label}`}
                      onClick={() => {
                        setConfirmation({
                          title: `Detach the shared password for ${host.label}?`,
                          description:
                            "Copied passwords and existing SSH sessions are unaffected.",
                          action: {
                            type: "detach-password",
                            recordId: host.recordId,
                            expectedCredentialHash: state.credentialHash!,
                          },
                        });
                      }}
                    >
                      Detach password
                    </Button>
                  </>
                ) : null}
              </div>
            ))}
          </div>
          {editing && state?.metadataHash ? (
            <HostEditor
              key={editing.recordId ?? "new"}
              prefix={prefix}
              initial={editing}
              busy={busy}
              onCancel={() => {
                setEditing(undefined);
                returnFocus();
              }}
              onSave={(record) =>
                void run({
                  type: "save-host",
                  record,
                  expectedMetadataHash: state.metadataHash!,
                })
              }
            />
          ) : null}
          {passwordHost && canManage ? (
            <FieldSet>
              <FieldLegend>Share password for {passwordHost.label}</FieldLegend>
              <FieldDescription>
                {passwordHost.username}@{passwordHost.address}:
                {passwordHost.port} ·{" "}
                {passwordHost.environment ?? "No environment"}. The password is
                encrypted for connect-capable members. Owner must share it again
                after an endpoint or login change.
              </FieldDescription>
              <FieldGroup>
                {secretField(
                  "shared-password",
                  "Shared SSH password",
                  password,
                )}
                <Field orientation="horizontal">
                  <Checkbox
                    id={`${prefix}-password-consent`}
                    checked={passwordConsent}
                    onCheckedChange={(value) =>
                      setPasswordConsent(value === true)
                    }
                  />
                  <FieldLabel htmlFor={`${prefix}-password-consent`}>
                    I explicitly share this password for the captured target
                    above.
                  </FieldLabel>
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      !passwordConsent ||
                      !selectedHost ||
                      selectedHost.address !== passwordHost.address ||
                      selectedHost.port !== passwordHost.port ||
                      selectedHost.username !== passwordHost.username
                    }
                    onClick={() => void sharePassword()}
                  >
                    Encrypt and share password
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      password.clear();
                      setPasswordHost(undefined);
                      returnFocus();
                    }}
                  >
                    Cancel password sharing
                  </Button>
                </div>
              </FieldGroup>
            </FieldSet>
          ) : null}
        </FieldSet>
      ) : null}
      {configured ? (
        <FieldSet disabled={busy}>
          <FieldLegend>Device enrollment exchange</FieldLegend>
          <FieldDescription>
            Transfer only public candidate/challenge/proof text here. Compare
            the complete enrollment fingerprint independently. Approval does not
            send a message to another person.
          </FieldDescription>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${prefix}-exchange`}>
                Enrollment exchange text
              </FieldLabel>
              <Textarea
                id={`${prefix}-exchange`}
                value={exchange}
                onChange={(event) => setExchange(event.target.value)}
                disabled={busy}
                spellCheck={false}
              />
            </Field>
            <Button
              variant="outline"
              disabled={busy || !exchange}
              onClick={() =>
                void run({ type: "prove", challengeText: exchange })
              }
            >
              Prove Team device challenge
            </Button>
            {canManage ? (
              <>
                {field(
                  "enroll-principal",
                  "Invited principal ID",
                  enrollPrincipal,
                  setEnrollPrincipal,
                )}
                {roles("Enrollment role", enrollRole, setEnrollRole)}
                <Button
                  variant="outline"
                  disabled={busy || !exchange || !enrollPrincipal}
                  onClick={() =>
                    void run({
                      type: "challenge",
                      candidateText: exchange,
                      principalId: enrollPrincipal,
                      role: enrollRole,
                    })
                  }
                >
                  Create Team enrollment challenge
                </Button>
                {field(
                  "confirmed-fingerprint",
                  "Independently confirmed enrollment fingerprint",
                  confirmedFingerprint,
                  setConfirmedFingerprint,
                )}
                <Button
                  variant="outline"
                  disabled={busy || !exchange || !confirmedFingerprint}
                  onClick={() =>
                    void run({
                      type: "approve",
                      proofText: exchange,
                      confirmedFingerprint,
                    })
                  }
                >
                  Approve Team device
                </Button>
              </>
            ) : null}
          </FieldGroup>
        </FieldSet>
      ) : null}
      {canManage && state ? (
        <FieldSet disabled={busy}>
          <FieldLegend>Members and shared access</FieldLegend>
          <FieldDescription>
            Owner manages people and passwords; Editor edits hosts and connects;
            Connector connects; Viewer reads metadata only. Changing a role
            removes that principal's devices, rotates both encrypted domains and
            requires fresh device approval. Revocation removes every device for
            that person.
          </FieldDescription>
          <FieldGroup>
            {field("invite-label", "Member label", inviteLabel, setInviteLabel)}
            {roles("Invitation role", inviteRole, setInviteRole)}
            <Button
              variant="outline"
              disabled={busy || !inviteLabel}
              onClick={() =>
                void run({
                  type: "invite",
                  label: inviteLabel,
                  role: inviteRole,
                })
              }
            >
              Create member invitation
            </Button>
            {state.members.map((member) => (
              <div
                key={member.principalId}
                className="flex flex-col gap-2 rounded-lg border border-border p-3"
              >
                <p className="break-words font-medium">
                  {member.label || member.principalId}{" "}
                  <Badge variant="outline">{member.role}</Badge>{" "}
                  <Badge variant="secondary">{member.status}</Badge>
                </p>
                <p className="break-all font-mono text-xs">
                  {member.principalId}
                </p>
                {member.role !== "Owner" &&
                member.status === "active" &&
                state.policyHash ? (
                  <>
                    {roles(
                      `Role for ${member.label || member.principalId}`,
                      roleChanges[member.principalId] ?? member.role,
                      (role) =>
                        setRoleChanges((current) => ({
                          ...current,
                          [member.principalId]: role,
                        })),
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={
                          busy ||
                          !roleChanges[member.principalId] ||
                          roleChanges[member.principalId] === member.role
                        }
                        onClick={() => {
                          setConfirmation({
                            title: `Change the role for ${member.label || member.principalId}?`,
                            description:
                              "All of their devices need fresh approval. Both encrypted domains rotate before publication.",
                            action: {
                              type: "change-role",
                              principalId: member.principalId,
                              role: roleChanges[member.principalId]!,
                              expectedPolicyHash: state.policyHash!,
                            },
                          });
                        }}
                      >
                        Apply role change
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            title: `Revoke all devices for ${member.label || member.principalId}?`,
                            description:
                              "Rotate remote SSH passwords separately. Passwords and data already copied elsewhere cannot be erased.",
                            action: {
                              type: "revoke-principal",
                              principalId: member.principalId,
                              expectedPolicyHash: state.policyHash!,
                            },
                          })
                        }
                      >
                        Revoke member
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          setConfirmation({
                            title: `Replace the token for ${member.label || member.principalId}?`,
                            description:
                              "Transfer the replacement explicitly. The previous token will no longer authorize server requests.",
                            action: {
                              type: "reissue-token",
                              principalId: member.principalId,
                              expectedPolicyHash: state.policyHash!,
                            },
                          })
                        }
                      >
                        Replace principal token
                      </Button>
                    </div>
                  </>
                ) : null}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ type: "create-recovery" })}
              >
                Save Team recovery kit
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ type: "audit", afterSequence: 0 })}
              >
                Read Team audit
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Recovery: {state.recoveryReady ? "confirmed" : "not confirmed"}.
              Keep the encrypted kit and recovery secret separately.
            </p>
          </FieldGroup>
        </FieldSet>
      ) : null}
      {detail.kind !== "none" ? (
        <FieldSet>
          <FieldLegend>Action result</FieldLegend>
          <FieldGroup>
            {detail.kind === "text" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={`${prefix}-result`}>
                    Public enrollment text
                  </FieldLabel>
                  <Textarea
                    id={`${prefix}-result`}
                    value={detail.text}
                    readOnly
                    spellCheck={false}
                  />
                </Field>
                {detail.fingerprint ? (
                  <p className="break-all font-mono text-xs">
                    Enrollment fingerprint: {detail.fingerprint}
                  </p>
                ) : null}
              </>
            ) : null}
            {detail.kind === "invitation" ? (
              <>
                <Alert>
                  <AlertDescription>
                    This token is shown only after the explicit invitation or
                    replacement. Transfer it securely to the intended person.
                    Nothing is sent automatically.
                  </AlertDescription>
                </Alert>
                <Field>
                  <FieldLabel htmlFor={`${prefix}-invitation`}>
                    Private member invitation
                  </FieldLabel>
                  <Textarea
                    id={`${prefix}-invitation`}
                    value={JSON.stringify(detail.invitation, null, 2)}
                    readOnly
                    spellCheck={false}
                  />
                </Field>
              </>
            ) : null}
            {detail.kind === "recovery" ? (
              <>
                <p className="text-sm">
                  Encrypted Team recovery kit{" "}
                  {detail.saved ? "saved" : "not saved"}. Keep this secret
                  separate from the kit.
                </p>
                <Field>
                  <FieldLabel htmlFor={`${prefix}-recovery-result`}>
                    Team recovery secret
                  </FieldLabel>
                  <Input
                    id={`${prefix}-recovery-result`}
                    value={detail.secret}
                    readOnly
                    {...secretFieldProps}
                  />
                </Field>
                <Button
                  variant="outline"
                  disabled={busy || !detail.saved}
                  onClick={() =>
                    void run({
                      type: "confirm-recovery",
                      confirmationToken: detail.confirmationToken,
                      secret: detail.secret,
                    })
                  }
                >
                  Confirm saved Team recovery kit
                </Button>
              </>
            ) : null}
            {detail.kind === "audit" ? (
              <>
                <p className="text-sm">
                  Audit starts at sequence {detail.page.firstAvailableSequence}.
                  Connection Ready/End entries are client reports, not proof of
                  remote commands or a complete tamper-resistant record.
                </p>
                <ol className="flex flex-col gap-2 text-xs">
                  {detail.page.entries.map((entry) => (
                    <li key={entry.sequence} className="break-all font-mono">
                      {entry.sequence} · {entry.action} · {entry.outcome} ·
                      principal {entry.principalId ?? "unknown"} · record{" "}
                      {entry.recordId ?? "none"}
                    </li>
                  ))}
                </ol>
                {detail.page.hasMore ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run({
                        type: "audit",
                        afterSequence: detail.page.nextSequence,
                      })
                    }
                  >
                    Read next Team audit page
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button variant="ghost" onClick={() => setDetail({ kind: "none" })}>
              Dismiss action result
            </Button>
          </FieldGroup>
        </FieldSet>
      ) : null}
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(undefined);
        }}
      >
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto motion-reduce:animate-none">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (confirmation) {
                  const action = confirmation.action;
                  setConfirmation(undefined);
                  void run(action);
                }
              }}
            >
              Confirm Team change
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function HostEditor({
  prefix,
  initial,
  busy,
  onSave,
  onCancel,
}: {
  prefix: string;
  initial: Partial<TeamHost>;
  busy: boolean;
  onSave(record: Omit<TeamHost, "virtualHostId">): void;
  onCancel(): void;
}) {
  const recordId = useRef(initial.recordId ?? crypto.randomUUID());
  const [label, setLabel] = useState(initial.label ?? ""),
    [address, setAddress] = useState(initial.address ?? "");
  const [username, setUsername] = useState(initial.username ?? ""),
    [port, setPort] = useState(String(initial.port ?? 22));
  const [environment, setEnvironment] = useState(initial.environment ?? "NONE");
  const validPort = Number(port);
  return (
    <FieldSet disabled={busy}>
      <FieldLegend>
        {initial.recordId ? "Edit Team host" : "New Team host"}
      </FieldLegend>
      <form
        onKeyDown={imeEnterGuard}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          onSave({
            recordId: recordId.current,
            label,
            address,
            username,
            port: validPort,
            environment:
              environment === "DEV" ||
              environment === "STAGING" ||
              environment === "PROD"
                ? environment
                : null,
          });
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${prefix}-host-label`}>
              Team host label
            </FieldLabel>
            <Input
              id={`${prefix}-host-label`}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={256}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-host-address`}>
              Team host address
            </FieldLabel>
            <Input
              id={`${prefix}-host-address`}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              maxLength={253}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-host-username`}>
              Team login name
            </FieldLabel>
            <Input
              id={`${prefix}-host-username`}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              maxLength={256}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${prefix}-host-port`}>
              Team SSH port
            </FieldLabel>
            <Input
              id={`${prefix}-host-port`}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              type="number"
              min={1}
              max={65535}
              required
            />
          </Field>
          <Field>
            <FieldLabel>Team host environment</FieldLabel>
            <ToggleGroup
              value={[environment]}
              aria-label="Team host environment"
              onValueChange={(values) => {
                const value = values[0];
                if (
                  value === "NONE" ||
                  value === "DEV" ||
                  value === "STAGING" ||
                  value === "PROD"
                )
                  setEnvironment(value);
              }}
            >
              <ToggleGroupItem value="NONE">None</ToggleGroupItem>
              <ToggleGroupItem value="DEV">DEV</ToggleGroupItem>
              <ToggleGroupItem value="STAGING">STAGING</ToggleGroupItem>
              <ToggleGroupItem value="PROD">PROD</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              type="submit"
              disabled={
                busy ||
                !label ||
                !address ||
                !username ||
                !Number.isInteger(validPort) ||
                validPort < 1 ||
                validPort > 65535
              }
            >
              Save Team host
            </Button>
            <Button variant="ghost" type="button" onClick={onCancel}>
              Cancel host edit
            </Button>
          </div>
        </FieldGroup>
      </form>
    </FieldSet>
  );
}
