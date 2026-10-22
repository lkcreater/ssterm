import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import type { Owner, TeamAction, TeamReply, TeamView } from "@ssterm/contracts";
import { Drawer, firstUsable, useDrawerClose } from "@/components/drawer";
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
import {
  call,
  imeEnterGuard,
  secretFieldProps,
  useSecretInput,
  type SecretInput,
} from "@/components/identities/secret-input";

type MemberRole = "Editor" | "Connector" | "Viewer";
type TeamHost = TeamView["hosts"][number];
type Member = TeamView["members"][number];
type SetupMode = "create" | "join" | "recover";
type Scope = {
  endpoint: string;
  deploymentId: string;
  accountId: string;
  teamId: string;
  metadataVaultId: string;
  credentialVaultId: string;
  principalId: string;
  fingerprint: string;
};
type Confirmation = {
  title: string;
  description: string;
  action: TeamAction;
  /** Primary label of the confirmation step. */
  confirm: string;
  destructive: boolean;
};
/** One open drawer. `key` makes each open a fresh instance; `opener` is where focus returns when it is still there. */
type Panel = (
  | { kind: "setup"; mode: SetupMode; scope?: Scope }
  | { kind: "host"; host: Partial<TeamHost> }
  | { kind: "password"; host: TeamHost }
  | { kind: "confirm"; confirmation: Confirmation; target?: ReactNode }
  | { kind: "member"; principalId: string }
  | { kind: "invite" }
  | { kind: "enrollment" }
) & { key: number; opener: HTMLElement | null };
type PanelRequest = Panel extends infer P ? (P extends Panel ? Omit<P, "key" | "opener"> : never) : never;
/** Runs one Team action; failures go to `report` (the drawer that asked, or the page). Resolves true on success. */
type Run = (
  action: TeamAction,
  report?: (text?: string) => void,
  /** The captured hashes are stale: a retry must be rebuilt from the refreshed view, never resent. */
  onConflict?: () => void,
) => Promise<boolean>;

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
const memberName = (member: Member) => member.label || member.principalId;
const endpointText = (host: Pick<TeamHost, "username" | "address" | "port">) =>
  `${host.username}@${host.address}:${host.port}`;

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
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TeamView>();
  const [busy, setBusy] = useState(false),
    [problem, setProblem] = useState<string>();
  const [detail, setDetail] = useState<TeamReply["detail"]>({ kind: "none" });
  const [forgetToken, setForgetToken] = useState(false);
  const [panel, setPanelState] = useState<Panel>();
  const serial = useRef(0);
  const openPanel = (next: PanelRequest) => {
    // As before the drawers: opening an editor or the password form drops a previous action result.
    if (next.kind === "host" || next.kind === "password") setDetail({ kind: "none" });
    setPanelState({
      ...next,
      key: ++serial.current,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    } as Panel);
  };
  // Only the resume form lives on the page; every other secret field lives (and is cleared) in its drawer.
  const token = useSecretInput();
  const heading = () => container.current?.querySelector<HTMLElement>("h2");
  const clear = () => {
    token.clear();
    setDetail({ kind: "none" });
    // Unmounting a drawer detaches its secret fields, which clears them.
    setPanelState(undefined);
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
    };
  }, [owner.windowId, owner.generation]);

  const run: Run = async (action, report = setProblem, onConflict) => {
    if (running.current) {
      if (action.type === "share-password") action.password.fill(0);
      return false;
    }
    running.current = true;
    setBusy(true);
    setProblem(undefined);
    report(undefined);
    setDetail({ kind: "none" });
    const since = epoch.current;
    try {
      const reply = await call((bridge) =>
        bridge.teamCommand({ owner, action }),
      );
      if (!mounted.current || since !== epoch.current) return false;
      if (!reply.ok) {
        // The workspace itself refused (locked, closed): drop every open form and say so on the page.
        clear();
        setProblem(
          "The team action could not finish. Check the workspace and try again.",
        );
        return false;
      }
      setState(reply.value.state);
      setDetail(reply.value.detail);
      if (reply.value.outcome === "failed" && reply.value.code === "conflict") onConflict?.();
      if (reply.value.outcome === "failed")
        report(
          errors[reply.value.code ?? ""] ??
            "The team action could not finish. Pending encrypted work is preserved.",
        );
      if (reply.value.outcome === "cancelled")
        report("Cancelled. Recovery has not been confirmed.");
      return reply.value.outcome === "ok";
    } finally {
      if (action.type === "share-password") action.password.fill(0);
      if (mounted.current && since === epoch.current) {
        token.clear();
        running.current = false;
        setBusy(false);
      }
    }
  };
  async function resume() {
    const bytes = token.take();
    if (!bytes) return;
    try {
      await run({ type: "resume", token: new TextDecoder().decode(bytes) });
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
  // A refreshed view that drops the role closes that role's drawer, as the inline forms did.
  const allowed =
    panel?.kind === "host" ? !!canEdit
      : panel?.kind === "password" || panel?.kind === "member" || panel?.kind === "invite" ? !!canManage
        : true;
  useEffect(() => {
    if (!allowed) setPanelState(undefined);
  }, [allowed]);
  const shared = {
    busy,
    run,
    onClose: () => setPanelState(undefined),
    returnFocus: () => firstUsable(panel?.opener, heading()),
  };
  return (
    <div
      ref={container}
      className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-5"
      data-testid="team-workspace"
    >
      <PageHeader
        title="Team vault"
        subtitle="Use your own server for encrypted shared hosts and Owner-shared SSH passwords. Team membership is separate from personal sync and Google sign-in."
        actions={
          state && !configured ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => openPanel({ kind: "setup", mode: "create" })}
            >
              Set up Team vault
            </Button>
          ) : null
        }
      />
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
      {state && !configured ? (
        <p className="text-sm text-muted-foreground">
          Create a team on your own server, join one with an invitation, or
          recover the Owner with a separate Team recovery kit.
        </p>
      ) : null}
      {state?.status === "revoked" ? (
        <>
          <Alert>
            <AlertDescription>
              This device has no current team access. Data and passwords already
              copied elsewhere cannot be erased remotely. Ask the Owner for a
              fresh invitation or device approval.
            </AlertDescription>
          </Alert>
          <Button
            variant="outline"
            className="self-start"
            disabled={busy}
            onClick={() => {
              setDetail({ kind: "none" });
              openPanel({
                kind: "setup",
                mode: "join",
                scope: {
                  endpoint: state.endpoint ?? "",
                  deploymentId: state.scope?.deploymentId ?? "",
                  accountId: state.scope?.accountId ?? "",
                  teamId: state.scope?.teamId ?? "",
                  metadataVaultId: state.scope?.metadataVaultId ?? "",
                  credentialVaultId: state.scope?.credentialVaultId ?? "",
                  principalId: state.principalId ?? "",
                  fingerprint: state.ownerFingerprint ?? "",
                },
              });
            }}
          >
            Request fresh Team device approval
          </Button>
        </>
      ) : null}
      {configured ? (
        <FieldSet disabled={busy}>
          <FieldLegend>Team actions</FieldLegend>
          <FieldGroup>
            {state?.needsToken ? (
              <>
                <SecretField id={`${prefix}-resume-token`} label="Principal token" input={token} disabled={busy} />
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
      ) : null}
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
              className="self-start"
              disabled={busy || !state?.metadataHash}
              onClick={() =>
                openPanel({
                  kind: "host",
                  host: { label: "", address: "", username: "", port: 22, environment: null },
                })
              }
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
                  <p className="break-all font-mono text-xs">{endpointText(host)}</p>
                </div>
                <Badge variant="secondary">Team</Badge>
                <EnvironmentBadge environment={host.environment} />
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
                      disabled={busy || !state.metadataHash}
                      aria-label={`Edit Team host ${host.label}`}
                      onClick={() => openPanel({ kind: "host", host: { ...host } })}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || !state.metadataHash}
                      aria-label={`Delete Team host ${host.label}`}
                      onClick={() =>
                        openPanel({
                          kind: "confirm",
                          target: <HostTarget host={host} />,
                          confirmation: {
                            title: `Delete Team host ${host.label}?`,
                            description: "Existing sessions retain their captured target.",
                            confirm: "Delete Team host",
                            destructive: true,
                            action: {
                              type: "delete-host",
                              recordId: host.recordId,
                              expectedMetadataHash: state.metadataHash!,
                            },
                          },
                        })
                      }
                    >
                      Delete
                    </Button>
                  </>
                ) : null}
                {canManage ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={busy || !state.metadataHash || !state.credentialHash}
                      aria-label={`Share password for ${host.label}`}
                      onClick={() => openPanel({ kind: "password", host: { ...host } })}
                    >
                      Share or replace password
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || !state.credentialHash}
                      aria-label={`Detach password for ${host.label}`}
                      onClick={() =>
                        openPanel({
                          kind: "confirm",
                          target: <HostTarget host={host} />,
                          confirmation: {
                            title: `Detach the shared password for ${host.label}?`,
                            description: "Copied passwords and existing SSH sessions are unaffected.",
                            confirm: "Detach password",
                            destructive: true,
                            action: {
                              type: "detach-password",
                              recordId: host.recordId,
                              expectedCredentialHash: state.credentialHash!,
                            },
                          },
                        })
                      }
                    >
                      Detach password
                    </Button>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </FieldSet>
      ) : null}
      {configured ? (
        <FieldSet disabled={busy}>
          <FieldLegend>Device enrollment exchange</FieldLegend>
          <FieldDescription>
            Transfer only public candidate/challenge/proof text. Compare the
            complete enrollment fingerprint independently. Approval does not
            send a message to another person.
          </FieldDescription>
          <Button
            variant="outline"
            className="self-start"
            disabled={busy}
            onClick={() => openPanel({ kind: "enrollment" })}
          >
            Open device enrollment
          </Button>
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
            <Button
              variant="outline"
              className="self-start"
              disabled={busy}
              onClick={() => openPanel({ kind: "invite" })}
            >
              Invite member
            </Button>
            {state.members.map((member) => (
              <div
                key={member.principalId}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
                data-team-member-id={member.principalId}
              >
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="break-words font-medium">
                    {memberName(member)}{" "}
                    <Badge variant="outline">{member.role}</Badge>{" "}
                    <Badge variant="secondary">{member.status}</Badge>
                  </p>
                  <p className="break-all font-mono text-xs">
                    {member.principalId}
                  </p>
                </div>
                {member.role !== "Owner" &&
                member.status === "active" &&
                state.policyHash ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    aria-label={`Manage ${memberName(member)}`}
                    onClick={() => openPanel({ kind: "member", principalId: member.principalId })}
                  >
                    Manage
                  </Button>
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
      {!allowed ? null : panel?.kind === "setup" ? (
        <SetupDrawer key={panel.key} {...shared} mode={panel.mode} scope={panel.scope} />
      ) : panel?.kind === "host" ? (
        <HostDrawer key={panel.key} {...shared} initial={panel.host} metadataHash={state?.metadataHash ?? null} />
      ) : panel?.kind === "password" ? (
        <PasswordDrawer key={panel.key} {...shared} host={panel.host} state={state} />
      ) : panel?.kind === "confirm" ? (
        <ConfirmDrawer key={panel.key} {...shared} confirmation={panel.confirmation} target={panel.target} />
      ) : panel?.kind === "member" ? (
        <MemberDrawer key={panel.key} {...shared} principalId={panel.principalId} state={state} />
      ) : panel?.kind === "invite" ? (
        <InviteDrawer key={panel.key} {...shared} />
      ) : panel?.kind === "enrollment" ? (
        <EnrollmentDrawer key={panel.key} {...shared} canManage={!!canManage} />
      ) : null}
    </div>
  );
}

type DrawerProps = {
  busy: boolean;
  run: Run;
  onClose(): void;
  returnFocus(): HTMLElement | true;
};

function EnvironmentBadge({ environment }: { environment: TeamHost["environment"] }) {
  return environment === "PROD" ? (
    <Badge variant="production">PROD</Badge>
  ) : environment ? (
    <Badge variant="outline">{environment}</Badge>
  ) : null;
}
function HostTarget({ host }: { host: Pick<TeamHost, "label" | "username" | "address" | "port" | "environment"> }) {
  return (
    <>
      <span className="min-w-0 break-words font-medium text-foreground">{host.label}</span>
      <span className="min-w-0 break-all font-mono text-xs">{endpointText(host)}</span>
      <EnvironmentBadge environment={host.environment} />
    </>
  );
}
function Problem({ text }: { text?: string }) {
  return text ? (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  ) : null;
}
function TextField({ id, label, value, onChange, disabled }: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
    </Field>
  );
}
function SecretField({ id, label, input, disabled }: { id: string; label: string; input: SecretInput; disabled: boolean }) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} ref={input.ref} {...secretFieldProps} disabled={disabled} />
    </Field>
  );
}
function RoleToggle({ label, value, onChange, disabled }: {
  label: string;
  value: MemberRole;
  onChange(role: MemberRole): void;
  disabled: boolean;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(values) => {
        const role = values[0];
        if (role === "Editor" || role === "Connector" || role === "Viewer")
          onChange(role);
      }}
      disabled={disabled}
    >
      <ToggleGroupItem value="Editor">Editor</ToggleGroupItem>
      <ToggleGroupItem value="Connector">Connector</ToggleGroupItem>
      <ToggleGroupItem value="Viewer">Viewer</ToggleGroupItem>
    </ToggleGroup>
  );
}

/** Create, join or recover (setup/recovery, drawer 37). Tokens and the recovery secret stay in uncontrolled fields. */
function SetupDrawer({ busy, run, onClose, returnFocus, mode: initialMode, scope }: DrawerProps & { mode: SetupMode; scope?: Scope }) {
  const prefix = useId();
  const [mode, setMode] = useState(initialMode);
  const [initial] = useState<Scope & { displayName: string }>(() => ({
    endpoint: "",
    deploymentId: "",
    accountId: "",
    teamId: "",
    metadataVaultId: "",
    credentialVaultId: "",
    principalId: "",
    fingerprint: "",
    ...scope,
    displayName: "This team",
  }));
  const [values, setValues] = useState(initial);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string>();
  const token = useSecretInput(),
    recoverySecret = useSecretInput();
  const set = (name: keyof typeof values) => (value: string) => setValues((current) => ({ ...current, [name]: value }));
  const close = useDrawerClose({
    busy,
    dirty: () =>
      consent || token.filled() || recoverySecret.filled() ||
      (Object.keys(initial) as (keyof typeof initial)[]).some((name) => initial[name] !== values[name]),
  });
  const formId = `${prefix}-form`;
  async function submit() {
    if (busy || close.discarding || !consent || !values.endpoint) return;
    const bytes = token.take(),
      secretBytes = mode === "recover" ? recoverySecret.take() : null;
    if (!bytes || (mode === "recover" && !secretBytes)) {
      bytes?.fill(0);
      secretBytes?.fill(0);
      setError("Enter the required token and recovery secret.");
      return;
    }
    try {
      const connection = {
        endpoint: values.endpoint,
        token: new TextDecoder().decode(bytes),
        principalId: values.principalId,
        expectedScope: {
          deploymentId: values.deploymentId,
          accountId: values.accountId,
          teamId: values.teamId,
          metadataVaultId: values.metadataVaultId,
          credentialVaultId: values.credentialVaultId,
        },
        consent: true as const,
      };
      const ok = await run(
        mode === "create"
          ? { type: "create", ...connection, displayName: values.displayName }
          : mode === "join"
            ? { type: "begin-join", ...connection, expectedOwnerFingerprint: values.fingerprint }
            : {
                type: "recover",
                ...connection,
                expectedOwnerFingerprint: values.fingerprint,
                secret: new TextDecoder().decode(secretBytes!),
              },
        setError,
      );
      if (ok) close.discard();
    } finally {
      bytes.fill(0);
      secretBytes?.fill(0);
    }
  }
  const field = (name: keyof typeof values, label: string) => (
    <TextField id={`${prefix}-${name}`} label={label} value={values[name]} onChange={set(name)} disabled={busy} />
  );
  return (
    <Drawer
      close={close}
      onClose={onClose}
      finalFocus={returnFocus}
      data-testid="team-setup-drawer"
      title="Set up Team vault"
      description="The Team server is yours. Compare the Owner fingerprint independently; personal sync and app unlock are separate."
      discardText="The Team setup details you entered will be lost."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button type="submit" form={formId} disabled={busy || !consent || !values.endpoint}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {mode === "create"
              ? "Create encrypted team"
              : mode === "join"
                ? "Create Team device request"
                : "Choose Team recovery kit"}
          </Button>
        </>
      }
    >
      <Problem text={error} />
      <form
        id={formId}
        noValidate
        onKeyDown={imeEnterGuard}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FieldSet disabled={busy}>
          <FieldGroup>
            <ToggleGroup
              value={[mode]}
              aria-label="Team setup"
              disabled={busy}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "create" || value === "join" || value === "recover") {
                  token.clear();
                  recoverySecret.clear();
                  setError(undefined);
                  setMode(value);
                }
              }}
            >
              <ToggleGroupItem value="create">Create team</ToggleGroupItem>
              <ToggleGroupItem value="join">Join team</ToggleGroupItem>
              <ToggleGroupItem value="recover">Recover Owner</ToggleGroupItem>
            </ToggleGroup>
            {field("endpoint", "Team server URL")}
            {field("deploymentId", "Deployment ID")}
            {field("accountId", "Account ID")}
            {field("teamId", "Team ID")}
            {field("metadataVaultId", "Metadata vault ID")}
            {field("credentialVaultId", "Credential vault ID")}
            {field("principalId", "Principal ID")}
            <SecretField id={`${prefix}-token`} label="Principal token" input={token} disabled={busy} />
            {mode === "create"
              ? field("displayName", "Team display name")
              : field("fingerprint", "Expected Owner fingerprint (compare independently)")}
            {mode === "recover" ? (
              <SecretField id={`${prefix}-recovery-secret`} label="Team recovery secret" input={recoverySecret} disabled={busy} />
            ) : null}
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
          </FieldGroup>
        </FieldSet>
      </form>
    </Drawer>
  );
}

/** Add or edit a managed host (drawer 35). The record id is fixed when the drawer opens. */
function HostDrawer({ busy, run, onClose, returnFocus, initial, metadataHash }: DrawerProps & {
  initial: Partial<TeamHost>;
  metadataHash: string | null;
}) {
  const prefix = useId();
  const recordId = useRef(initial.recordId ?? crypto.randomUUID());
  const [start] = useState(() => ({
    label: initial.label ?? "",
    address: initial.address ?? "",
    username: initial.username ?? "",
    port: String(initial.port ?? 22),
    environment: initial.environment ?? "NONE",
  }));
  const [values, setValues] = useState(start);
  const [error, setError] = useState<string>();
  const set = (name: keyof typeof values) => (value: string) => setValues((current) => ({ ...current, [name]: value }));
  const close = useDrawerClose({
    busy,
    dirty: (Object.keys(start) as (keyof typeof start)[]).some((name) => start[name] !== values[name]),
  });
  const port = Number(values.port);
  const valid =
    !!values.label && !!values.address && !!values.username &&
    Number.isInteger(port) && port >= 1 && port <= 65535 && !!metadataHash;
  const formId = `${prefix}-form`;
  return (
    <Drawer
      close={close}
      onClose={onClose}
      finalFocus={returnFocus}
      data-testid="team-host-drawer"
      title={initial.recordId ? "Edit Team host" : "New Team host"}
      target={initial.recordId && initial.label ? <span className="min-w-0 break-words">{initial.label}</span> : undefined}
      description="Saved encrypted for the team. Existing sessions keep their captured target."
      discardText="Your changes to this Team host will be lost."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button type="submit" form={formId} disabled={busy || !valid}>
            {busy ? <Spinner data-icon="inline-start" /> : null}Save Team host
          </Button>
        </>
      }
    >
      <Problem text={error} />
      <form
        id={formId}
        onKeyDown={imeEnterGuard}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || close.discarding || !valid) return;
          const ok = await run(
            {
              type: "save-host",
              record: {
                recordId: recordId.current,
                label: values.label,
                address: values.address,
                username: values.username,
                port,
                environment:
                  values.environment === "DEV" || values.environment === "STAGING" || values.environment === "PROD"
                    ? values.environment
                    : null,
              },
              expectedMetadataHash: metadataHash!,
            },
            setError,
          );
          if (ok) close.discard();
        }}
      >
        <FieldSet disabled={busy}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${prefix}-host-label`}>Team host label</FieldLabel>
              <Input id={`${prefix}-host-label`} value={values.label} onChange={(event) => set("label")(event.target.value)} maxLength={256} required />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-host-address`}>Team host address</FieldLabel>
              <Input id={`${prefix}-host-address`} value={values.address} onChange={(event) => set("address")(event.target.value)}
                maxLength={253} required autoComplete="off" spellCheck={false} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-host-username`}>Team login name</FieldLabel>
              <Input id={`${prefix}-host-username`} value={values.username} onChange={(event) => set("username")(event.target.value)}
                maxLength={256} required autoComplete="off" spellCheck={false} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${prefix}-host-port`}>Team SSH port</FieldLabel>
              <Input id={`${prefix}-host-port`} value={values.port} onChange={(event) => set("port")(event.target.value)}
                type="number" min={1} max={65535} required />
            </Field>
            <Field>
              <FieldLabel>Team host environment</FieldLabel>
              <ToggleGroup
                value={[values.environment]}
                aria-label="Team host environment"
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "NONE" || value === "DEV" || value === "STAGING" || value === "PROD") set("environment")(value);
                }}
              >
                <ToggleGroupItem value="NONE">None</ToggleGroupItem>
                <ToggleGroupItem value="DEV">DEV</ToggleGroupItem>
                <ToggleGroupItem value="STAGING">STAGING</ToggleGroupItem>
                <ToggleGroupItem value="PROD">PROD</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </FieldGroup>
        </FieldSet>
      </form>
    </Drawer>
  );
}

/**
 * Share or replace a shared SSH password for the target captured when the drawer opened. The password stays in an
 * uncontrolled field and crosses the bridge once as bytes; sharing is refused if the endpoint or login changed since.
 */
function PasswordDrawer({ busy, run, onClose, returnFocus, host, state }: DrawerProps & { host: TeamHost; state?: TeamView }) {
  const prefix = useId();
  const password = useSecretInput();
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string>();
  const close = useDrawerClose({ busy, dirty: () => consent || password.filled() });
  const current = state?.hosts.find((row) => row.recordId === host.recordId);
  const unchanged =
    !!current && current.address === host.address && current.port === host.port && current.username === host.username;
  const formId = `${prefix}-form`;
  async function share() {
    if (busy || close.discarding || !consent || !unchanged || !state?.metadataHash || !state.credentialHash) return;
    const bytes = password.take();
    if (!bytes) {
      setError("Enter a password to share.");
      return;
    }
    try {
      const ok = await run(
        {
          type: "share-password",
          recordId: host.recordId,
          password: Uint8Array.from(bytes),
          consent: true,
          expectedMetadataHash: state.metadataHash,
          expectedCredentialHash: state.credentialHash,
        },
        setError,
      );
      if (ok) close.discard();
    } finally {
      bytes.fill(0);
    }
  }
  return (
    <Drawer
      close={close}
      onClose={onClose}
      finalFocus={returnFocus}
      // Dismissal by the scrim would cancel a credential mid-entry.
      dismissOnScrim={false}
      data-testid="team-password-drawer"
      title="Share password"
      target={<HostTarget host={host} />}
      description="The password is encrypted for connect-capable members. Owner must share it again after an endpoint or login change."
      discardText="The password you entered will be cleared."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button type="submit" form={formId} disabled={busy || !consent || !unchanged}>
            {busy ? <Spinner data-icon="inline-start" /> : null}Encrypt and share password
          </Button>
        </>
      }
    >
      <Problem text={error} />
      {!unchanged ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            This host changed or was removed since you opened this. Close and open it again to share for the current target.
          </AlertDescription>
        </Alert>
      ) : null}
      <form
        id={formId}
        onKeyDown={imeEnterGuard}
        onSubmit={(event) => {
          event.preventDefault();
          void share();
        }}
      >
        <FieldSet disabled={busy}>
          <FieldGroup>
            <SecretField id={`${prefix}-shared-password`} label="Shared SSH password" input={password} disabled={busy} />
            <Field orientation="horizontal">
              <Checkbox
                id={`${prefix}-password-consent`}
                checked={consent}
                onCheckedChange={(value) => setConsent(value === true)}
              />
              <FieldLabel htmlFor={`${prefix}-password-consent`}>
                I explicitly share this password for the captured target above.
              </FieldLabel>
            </Field>
          </FieldGroup>
        </FieldSet>
      </form>
    </Drawer>
  );
}

/** A confirmation-only alert drawer for one captured Team change. */
function ConfirmDrawer({ busy, run, onClose, returnFocus, confirmation, target }: DrawerProps & {
  confirmation: Confirmation;
  target?: ReactNode;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string>();
  // After a conflict the captured action is stale: Cancel, review the refreshed page and start again.
  const [stale, setStale] = useState(false);
  const close = useDrawerClose({ busy });
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      finalFocus={returnFocus}
      data-testid="team-confirm-drawer"
      title={<span className="break-words">{confirmation.title}</span>}
      target={target}
      description={confirmation.description}
      footer={
        <>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button
            variant={confirmation.destructive ? "destructive" : "default"}
            disabled={busy || stale}
            onClick={async () => {
              if (await run(confirmation.action, setError, () => setStale(true))) close.discard();
            }}
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {confirmation.confirm}
          </Button>
        </>
      }
    >
      <Problem text={error} />
    </Drawer>
  );
}

/**
 * One member's role, token and revocation (drawer 36). Each change is a confirmation step in this drawer whose action
 * captures the policy hash current when the step opens; a conflict ends the step, so a retry is rebuilt from the
 * refreshed view.
 */
function MemberDrawer({ busy, run, onClose, returnFocus, principalId, state }: DrawerProps & { principalId: string; state?: TeamView }) {
  const member = state?.members.find((row) => row.principalId === principalId);
  const manageable = !!member && member.role !== "Owner" && member.status === "active" && !!state?.policyHash;
  const [role, setRole] = useState<MemberRole>(() =>
    member && member.role !== "Owner" ? member.role : "Connector",
  );
  const [step, setStep] = useState<Confirmation>();
  const [error, setError] = useState<string>();
  // After a successful change the member may no longer be manageable; the closing drawer must not say so.
  const [done, setDone] = useState(false);
  const stepCancel = useRef<HTMLButtonElement>(null);
  const changed = !!member && member.role !== role;
  const close = useDrawerClose({ busy, dirty: changed });
  useEffect(() => {
    if (step) stepCancel.current?.focus();
  }, [step]);
  const name = member ? memberName(member) : principalId;
  const ask = (next: Omit<Confirmation, "action"> & { action: TeamAction }) => {
    setError(undefined);
    setStep(next);
  };
  const back = () => {
    if (!busy) setStep(undefined);
  };
  return (
    <Drawer
      close={step ? { ...close, request: back } : close}
      onClose={onClose}
      finalFocus={returnFocus}
      data-testid="team-member-drawer"
      title={step ? step.title : `Manage ${name}`}
      target={
        <>
          <span className="min-w-0 break-all font-mono text-xs">{principalId}</span>
          {member ? <Badge variant="outline">{member.role}</Badge> : null}
          {member ? <Badge variant="secondary">{member.status}</Badge> : null}
        </>
      }
      description={step ? undefined : "Changing a role removes this person's devices, rotates both encrypted domains and requires fresh device approval."}
      discardText="The role change you chose will not be applied."
      footer={
        step ? (
          <>
            <Button ref={stepCancel} variant="outline" disabled={busy} onClick={back}>Cancel</Button>
            {/* A double click on the button that opened this step must not land on this replacement. */}
            <Button
              variant={step.destructive ? "destructive" : "default"}
              disabled={busy || !manageable}
              onClick={async (event) => {
                if (event.detail > 1) return;
                if (!(await run(step.action, setError, () => setStep(undefined)))) return;
                setDone(true);
                close.discard();
              }}
            >
              {busy ? <Spinner data-icon="inline-start" /> : null}
              {step.confirm}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
            <Button
              disabled={busy || !manageable || !changed}
              onClick={() =>
                ask({
                  title: `Change the role for ${name}?`,
                  description: "All of their devices need fresh approval. Both encrypted domains rotate before publication.",
                  confirm: "Confirm Team change",
                  destructive: false,
                  action: { type: "change-role", principalId, role, expectedPolicyHash: state!.policyHash! },
                })
              }
            >
              Apply role change
            </Button>
          </>
        )
      }
    >
      <Problem text={error} />
      {!manageable && !done ? (
        <Alert role="alert">
          <AlertDescription>This member can no longer be managed here. Fetch Team changes and try again.</AlertDescription>
        </Alert>
      ) : null}
      {step ? (
        <section role="alert" aria-label={step.title} className="grid gap-2" data-testid="team-member-confirm">
          <p className="text-muted-foreground">{step.description}</p>
        </section>
      ) : (
        <FieldSet disabled={busy || !manageable}>
          <FieldGroup>
            <Field>
              <FieldLabel>Role</FieldLabel>
              <RoleToggle label={`Role for ${name}`} value={role} onChange={setRole} disabled={busy || !manageable} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || !manageable}
                onClick={() =>
                  ask({
                    title: `Replace the token for ${name}?`,
                    description: "Transfer the replacement explicitly. The previous token will no longer authorize server requests.",
                    confirm: "Replace principal token",
                    destructive: false,
                    action: { type: "reissue-token", principalId, expectedPolicyHash: state!.policyHash! },
                  })
                }
              >
                Replace principal token
              </Button>
              <Button
                variant="outline"
                className="text-destructive"
                disabled={busy || !manageable}
                onClick={() =>
                  ask({
                    title: `Revoke all devices for ${name}?`,
                    description: "Rotate remote SSH passwords separately. Passwords and data already copied elsewhere cannot be erased.",
                    confirm: "Revoke member",
                    destructive: true,
                    action: { type: "revoke-principal", principalId, expectedPolicyHash: state!.policyHash! },
                  })
                }
              >
                Revoke member
              </Button>
            </div>
          </FieldGroup>
        </FieldSet>
      )}
    </Drawer>
  );
}

/** Creates one invitation; its private token appears once in the page's action result. */
function InviteDrawer({ busy, run, onClose, returnFocus }: DrawerProps) {
  const prefix = useId();
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<MemberRole>("Connector");
  const [error, setError] = useState<string>();
  const close = useDrawerClose({ busy, dirty: !!label || role !== "Connector" });
  const formId = `${prefix}-form`;
  return (
    <Drawer
      close={close}
      onClose={onClose}
      finalFocus={returnFocus}
      data-testid="team-invite-drawer"
      title="Invite member"
      description="The invitation token is shown once after it is created. Transfer it securely; nothing is sent automatically."
      discardText="The invitation details you entered will be lost."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button type="submit" form={formId} disabled={busy || !label}>
            {busy ? <Spinner data-icon="inline-start" /> : null}Create member invitation
          </Button>
        </>
      }
    >
      <Problem text={error} />
      <form
        id={formId}
        onKeyDown={imeEnterGuard}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || close.discarding || !label) return;
          if (await run({ type: "invite", label, role }, setError)) close.discard();
        }}
      >
        <FieldSet disabled={busy}>
          <FieldGroup>
            <TextField id={`${prefix}-invite-label`} label="Member label" value={label} onChange={setLabel} disabled={busy} />
            <Field>
              <FieldLabel>Role</FieldLabel>
              <RoleToggle label="Invitation role" value={role} onChange={setRole} disabled={busy} />
            </Field>
          </FieldGroup>
        </FieldSet>
      </form>
    </Drawer>
  );
}

type EnrollmentStep = "prove" | "challenge" | "approve";
/** The public enrollment exchange. Results (public text and fingerprints) appear in the page's action result. */
function EnrollmentDrawer({ busy, run, onClose, returnFocus, canManage }: DrawerProps & { canManage: boolean }) {
  const prefix = useId();
  const [step, setStep] = useState<EnrollmentStep>("prove");
  const [exchange, setExchange] = useState("");
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState<MemberRole>("Connector");
  const [fingerprint, setFingerprint] = useState("");
  const [error, setError] = useState<string>();
  const close = useDrawerClose({ busy, dirty: !!exchange || !!principal || !!fingerprint });
  const ready =
    !!exchange && (step === "prove" || (step === "challenge" ? !!principal : !!fingerprint));
  const formId = `${prefix}-form`;
  return (
    <Drawer
      close={close}
      onClose={onClose}
      finalFocus={returnFocus}
      data-testid="team-enrollment-drawer"
      title="Device enrollment"
      description="Transfer only public candidate/challenge/proof text here. Compare the complete enrollment fingerprint independently."
      discardText="The enrollment text you entered will be lost."
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button type="submit" form={formId} disabled={busy || !ready}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {step === "prove"
              ? "Prove Team device challenge"
              : step === "challenge"
                ? "Create Team enrollment challenge"
                : "Approve Team device"}
          </Button>
        </>
      }
    >
      <Problem text={error} />
      <form
        id={formId}
        onKeyDown={imeEnterGuard}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || close.discarding || !ready) return;
          const action: TeamAction =
            step === "prove"
              ? { type: "prove", challengeText: exchange }
              : step === "challenge"
                ? { type: "challenge", candidateText: exchange, principalId: principal, role }
                : { type: "approve", proofText: exchange, confirmedFingerprint: fingerprint };
          if (await run(action, setError)) close.discard();
        }}
      >
        <FieldSet disabled={busy}>
          <FieldGroup>
            {canManage ? (
              <ToggleGroup
                value={[step]}
                aria-label="Enrollment step"
                disabled={busy}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "prove" || value === "challenge" || value === "approve") {
                    setError(undefined);
                    setStep(value);
                  }
                }}
              >
                <ToggleGroupItem value="prove">Prove challenge</ToggleGroupItem>
                <ToggleGroupItem value="challenge">Create challenge</ToggleGroupItem>
                <ToggleGroupItem value="approve">Approve device</ToggleGroupItem>
              </ToggleGroup>
            ) : null}
            <Field>
              <FieldLabel htmlFor={`${prefix}-exchange`}>Enrollment exchange text</FieldLabel>
              <Textarea
                id={`${prefix}-exchange`}
                value={exchange}
                onChange={(event) => setExchange(event.target.value)}
                disabled={busy}
                spellCheck={false}
              />
              <FieldDescription>
                {step === "prove"
                  ? "Paste the challenge the Owner created for this device."
                  : step === "challenge"
                    ? "Paste the candidate text from the new device."
                    : "Paste the proof text from the new device."}
              </FieldDescription>
            </Field>
            {step === "challenge" ? (
              <>
                <TextField id={`${prefix}-enroll-principal`} label="Invited principal ID" value={principal} onChange={setPrincipal} disabled={busy} />
                <Field>
                  <FieldLabel>Role</FieldLabel>
                  <RoleToggle label="Enrollment role" value={role} onChange={setRole} disabled={busy} />
                </Field>
              </>
            ) : null}
            {step === "approve" ? (
              <TextField
                id={`${prefix}-confirmed-fingerprint`}
                label="Independently confirmed enrollment fingerprint"
                value={fingerprint}
                onChange={setFingerprint}
                disabled={busy}
              />
            ) : null}
          </FieldGroup>
        </FieldSet>
      </form>
    </Drawer>
  );
}
