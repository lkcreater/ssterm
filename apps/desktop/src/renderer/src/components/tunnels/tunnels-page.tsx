import { useId, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WorkflowIcon,
} from "lucide-react";
import {
  MAX_CATALOG_ITEMS,
  type CatalogState,
  type CatalogTunnelRule,
  type ErrorCode,
  type Owner,
  type TunnelErrorCode,
  type TunnelBindAddress,
  type TunnelState,
  type TunnelStatus,
  type TunnelType,
} from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer, firstUsable, useDrawerClose } from "@/components/drawer";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { Catalog } from "@/hooks/use-catalog";
import { call, imeEnterGuard } from "@/components/identities/secret-input";
import { endpointText } from "@/lib/catalog-filter";
import { addressError, labelError, serverFieldErrors, type FieldErrors } from "@/lib/catalog-validation";

const heading = () => document.querySelector<HTMLElement>('[data-testid="tunnels-page"] h2');

export const tunnelErrorText: Record<TunnelErrorCode, string> = {
  "address-in-use": "The local port is already in use on this Mac.",
  "permission-denied": "macOS did not allow listening on this local port.",
  "address-unavailable": "This local address is unavailable on this Mac.",
  "bind-failed": "The local port could not be opened.",
  "remote-bind-refused": "The server refused to listen on that address and port. It may be in use, or the server's settings (AllowTcpForwarding, GatewayPorts) do not allow it.",
  "rule-not-found": "This rule no longer exists.",
  "already-active": "This tunnel is already active.",
  "resource-limit": "Too many tunnels or sessions are open.",
  locked: "The workspace locked, so the tunnel stopped.",
  "invalid-config": "The server's settings are incomplete.",
  "host-key-untrusted": "The server's host key was not trusted.",
  "host-key-changed": "The server's host key changed. Review it under Known hosts.",
  "auth-denied": "The server refused the sign-in.",
  "credentials-required": "The server's identity has no saved credentials.",
  "credentials-unavailable": "Saved credentials could not be read.",
  "invalid-private-key": "The saved private key could not be opened.",
  "unsupported-private-key": "The saved private key format is unsupported.",
  "key-mismatch": "The saved private key does not match its public key.",
  "prompt-cancelled": "Sign-in was cancelled.",
  timeout: "The connection timed out.",
  dns: "The server's address could not be resolved.",
  network: "The SSH connection was lost.",
  "channel-open-failed": "The server refused the tunnel.",
  "jump-refused": "A jump host refused to connect onward to the server.",
  "proxy-failed": "The proxy did not connect.",
  other: "The tunnel stopped.",
};
const requestText = (code: ErrorCode) =>
  code === "conflict" ? "This rule changed elsewhere. Review it and try again."
    : code === "busy" ? "The workspace is busy. Try again in a moment."
      : "Port forwarding is unavailable right now. Try again.";

/** Status with icon and text (never color alone); `failed` never reads as running. */
function TunnelStatusView({ status }: { status?: TunnelStatus }) {
  const phase = status?.phase ?? "stopped";
  const Icon = phase === "running" ? CircleCheckIcon : phase === "failed" ? CircleAlertIcon
    : phase === "stopped" ? CircleIcon : LoaderCircleIcon;
  const text = phase === "running" ? "Running" : phase === "starting" ? "Starting" : phase === "stopping" ? "Stopping"
    : phase === "failed" ? "Failed" : "Stopped";
  return (
    <span className="tunnel-status" data-phase={phase} aria-live="polite">
      <Icon aria-hidden="true" />
      <span>{text}</span>
      {phase === "running" && status ? (
        <span className="text-muted-foreground">
          · {status.activeConnections} {status.activeConnections === 1 ? "connection" : "connections"}
          {status.remotePort !== null ? <> · server port <span className="host-target" data-testid="tunnel-remote-port">{status.remotePort}</span></> : null}
        </span>
      ) : null}
    </span>
  );
}

// `key` makes each open a fresh drawer instance; `opener` is where focus returns when it is still there.
type Dialogs =
  | { kind: "edit"; id?: string; key: number; opener: HTMLElement | null }
  // The rule is captured at open: it stays shown (and its revision is what Delete confirms) while the drawer closes.
  | { kind: "delete"; rule: CatalogTunnelRule; key: number; opener: HTMLElement | null };

export function TunnelsPage({
  owner,
  catalog,
  state,
  tunnels,
}: {
  owner: Owner;
  catalog: Catalog;
  state: CatalogState;
  tunnels?: TunnelState;
}) {
  const [dialog, setDialogState] = useState<Dialogs>();
  const serial = useRef(0);
  const setDialog = (next: { kind: "edit"; id?: string } | { kind: "delete"; rule: CatalogTunnelRule } | undefined) =>
    setDialogState(next && {
      ...next,
      key: ++serial.current,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mark = (id: string, on: boolean) => setBusy((current) => {
    const next = new Set(current);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const [notice, setNotice] = useState<{ ruleId?: string; text: string }>();
  const hosts = useMemo(() => new Map(state.hosts.map((host) => [host.id, host])), [state.hosts]);
  const statuses = useMemo(() => new Map((tunnels?.tunnels ?? []).map((row) => [row.ruleId, row])), [tunnels]);
  const rules = state.tunnelRules;
  const active = (id: string) => {
    const phase = statuses.get(id)?.phase;
    return phase === "starting" || phase === "running" || phase === "stopping";
  };

  async function start(rule: CatalogTunnelRule) {
    mark(rule.id, true);
    setNotice(undefined);
    const result = await call((bridge) => bridge.startTunnel({ owner, ruleId: rule.id }));
    mark(rule.id, false);
    if (!result.ok) setNotice({ ruleId: rule.id, text: requestText(result.error.code) });
    else if (result.value.status === "failed")
      setNotice({ ruleId: rule.id, text: result.value.code === "locked" ? "The workspace is locked. Unlock your Mac and try again." : tunnelErrorText[result.value.code] });
  }
  async function stop(rule: CatalogTunnelRule) {
    mark(rule.id, true);
    setNotice(undefined);
    const result = await call((bridge) => bridge.stopTunnel({ owner, ruleId: rule.id }));
    mark(rule.id, false);
    if (!result.ok) setNotice({ ruleId: rule.id, text: requestText(result.error.code) });
  }
  const editing = dialog?.kind === "edit" ? dialog : undefined;
  const editingRule = editing?.id ? rules.find((rule) => rule.id === editing.id) : undefined;
  const deleting = dialog?.kind === "delete" ? dialog.rule : undefined;

  return (
    <div className="catalog-page" data-testid="tunnels-page">
      <PageHeader
        title="Port forwarding"
        subtitle={`Local, remote and SOCKS rules through saved servers · ${rules.length} ${rules.length === 1 ? "rule" : "rules"}`}
        actions={rules.length ? (
          <Button size="sm" disabled={!state.hosts.length} onClick={() => setDialog({ kind: "edit" })}>
            <PlusIcon data-icon="inline-start" /> New rule
          </Button>
        ) : null}
      />
      <p className="type-caption text-muted-foreground">
        Local rules forward a port on this Mac to a destination the server opens; remote rules forward a port on the server to a destination this Mac opens; SOCKS rules give apps on this Mac a SOCKS5 proxy whose connections the server opens. Rules never start by themselves.
      </p>
      {state.truncated ? (
        <p className="type-caption text-muted-foreground">Showing the first {MAX_CATALOG_ITEMS.toLocaleString()} items of each kind.</p>
      ) : null}
      {rules.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WorkflowIcon />
            </EmptyMedia>
            <EmptyTitle>No forwarding rules yet</EmptyTitle>
            <EmptyDescription>
              {state.hosts.length
                ? "A rule listens on a local port and forwards each connection through a saved server."
                : "Add a server first. A rule forwards connections through a saved server."}
            </EmptyDescription>
          </EmptyHeader>
          {state.hosts.length ? (
            <EmptyContent>
              <Button onClick={() => setDialog({ kind: "edit" })}>
                <PlusIcon data-icon="inline-start" /> New rule
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <div className="data-frame">
          <table className="data-table" aria-label="Forwarding rules">
            <thead>
              <tr>
                <th scope="col" title="Name">Name</th>
                <th scope="col" className="w-[13%]" title="Server">Server</th>
                <th scope="col" className="w-[13%]" title="Listen">Listen</th>
                <th scope="col" className="w-[13%]" title="Destination">Destination</th>
                <th scope="col" className="w-[19%]" title="Status">Status</th>
                <th scope="col" className="w-44 data-actions-col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
          {rules.map((rule) => {
            const host = hosts.get(rule.hostId);
            const status = statuses.get(rule.id);
            const phase = status?.phase;
            const listen = endpointText(rule.bindAddress, rule.bindPort === 0 ? (status?.remotePort ?? 0) : rule.bindPort);
            const destination = rule.destinationHost !== null && rule.destinationPort !== null ? endpointText(rule.destinationHost, rule.destinationPort) : "";
            const listenText = rule.type === "remote" && rule.bindPort === 0 && status?.remotePort == null ? `${rule.bindAddress.includes(":") ? `[${rule.bindAddress}]` : rule.bindAddress}:assigned` : listen;
            return (
              <tr key={rule.id} data-rule-id={rule.id} data-type={rule.type} data-phase={phase ?? "stopped"}>
                <td>
                  <span className="block truncate font-medium" title={rule.label}>{rule.label}</span>
                  <Badge variant="outline" className="mt-1">{typeText[rule.type]}</Badge>
                </td>
                <td>
                  <span className="data-cell">
                    <span className="min-w-0 max-w-full truncate" title={host?.label}>{host?.label ?? "Missing server"}</span>
                    {host?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
                  </span>
                </td>
                <td>
                  <span className="host-target block truncate" title={rule.type === "remote" ? `Address the server listens on: ${listenText}` : `Local address on this Mac: ${listenText}`}>
                    {listenText}
                  </span>
                  <span className="type-caption text-muted-foreground">{rule.type === "remote" ? "on the server" : "on this Mac"}</span>
                  {rule.type === "remote" && (rule.bindAddress === "0.0.0.0" || rule.bindAddress === "::") ? (
                    <Badge variant="outline" className="mt-1 text-connection-connecting" title="The server listens on every address only if its GatewayPorts setting allows it">
                      <TriangleAlertIcon data-icon="inline-start" />Public requested
                    </Badge>
                  ) : null}
                </td>
                <td>
                  {rule.type === "dynamic" ? (
                    <span className="type-caption">SOCKS5, destinations opened by the server</span>
                  ) : (
                    <>
                      <span className="sr-only">forwards to</span>
                      <span className="host-target block truncate" title={rule.type === "remote" ? `Opened by this Mac: ${destination}` : `Opened by the server: ${destination}`}>{destination}</span>
                      <span className="type-caption text-muted-foreground">{rule.type === "remote" ? "opened by this Mac" : "opened by the server"}</span>
                    </>
                  )}
                </td>
                <td>
                  <TunnelStatusView status={status} />
                  {phase === "failed" && status?.error ? (
                    <span className="tunnel-error block" role="note">{tunnelErrorText[status.error]}</span>
                  ) : null}
                  {notice?.ruleId === rule.id && phase !== "failed" ? <span className="tunnel-error block" role="status">{notice.text}</span> : null}
                </td>
                <td>
                <span className="data-actions">
                  {phase === "starting" || phase === "running" ? (
                    <Button size="sm" variant="outline" disabled={busy.has(rule.id)} aria-label={`Stop ${rule.label}`} title="Stop" onClick={() => void stop(rule)}>
                      {busy.has(rule.id) ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}<span className="data-action-text">Stop</span>
                    </Button>
                  ) : phase === "stopping" ? (
                    <Button size="sm" variant="outline" disabled title="Stopping">
                      <Spinner data-icon="inline-start" /><span className="data-action-text">Stopping</span>
                    </Button>
                  ) : (
                    <Button size="sm" disabled={busy.has(rule.id) || !host} aria-label={`Start ${rule.label}`} title="Start" onClick={() => void start(rule)}>
                      {busy.has(rule.id) ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}<span className="data-action-text">Start</span>
                    </Button>
                  )}
                  <Button size="icon-sm" variant="ghost" aria-label={`Edit ${rule.label}`} title="Edit" onClick={() => setDialog({ kind: "edit", id: rule.id })}>
                    <PencilIcon aria-hidden="true" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${rule.label}`} title="Delete" onClick={() => setDialog({ kind: "delete", rule })}>
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </span>
                </td>
              </tr>
            );
          })}
            </tbody>
          </table>
        </div>
      )}
      {/* A rule deleted elsewhere closes its editor instead of turning it into "new". */}
      {editing && (!editing.id || editingRule) ? (
        <RuleEditor
          key={editing.key}
          returnFocus={() => firstUsable(editing.opener, heading())}
          owner={owner}
          catalog={catalog}
          state={state}
          rule={editingRule}
          running={!!editing.id && active(editing.id)}
          failed={!!editing.id && statuses.get(editing.id)?.phase === "failed"}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
      {deleting ? (
        <DeleteRuleDialog
          key={dialog?.key}
          returnFocus={() => firstUsable(dialog?.opener, heading())}
          owner={owner}
          catalog={catalog}
          rule={deleting}
          running={active(deleting.id)}
          failed={statuses.get(deleting.id)?.phase === "failed"}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  );
}

const typeText: Record<TunnelType, string> = { local: "Local", remote: "Remote", dynamic: "SOCKS" };
const ruleTitle: Record<TunnelType, string> = { local: "local forwarding rule", remote: "remote forwarding rule", dynamic: "SOCKS proxy rule" };
const typeItems = [
  { value: "local", label: "Local: a port on this Mac" },
  { value: "remote", label: "Remote: a port on the server" },
  { value: "dynamic", label: "SOCKS: a proxy on this Mac" },
] as const;
const loopbackItems = [{ value: "127.0.0.1", label: "127.0.0.1 (IPv4 loopback)" }, { value: "::1", label: "::1 (IPv6 loopback)" }];
const serverItems = [
  ...loopbackItems,
  { value: "0.0.0.0", label: "0.0.0.0 (every IPv4 address)" },
  { value: "::", label: ":: (every IPv6 address)" },
];
const publicBind = (address: TunnelBindAddress) => address === "0.0.0.0" || address === "::";

interface Draft {
  label: string;
  hostId: string;
  type: TunnelType;
  bindAddress: TunnelBindAddress;
  bindPort: string;
  destinationHost: string;
  destinationPort: string;
}
const portValue = (text: string) => (/^\d{1,5}$/u.test(text.trim()) ? Number(text.trim()) : NaN);
const validPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65_535;

/** Running rules save with an explicit stop → save → start; nothing else ever starts a tunnel. */
function RuleEditor({
  owner,
  catalog,
  state,
  rule,
  running,
  failed,
  returnFocus,
  onClose,
}: {
  owner: Owner;
  catalog: Catalog;
  state: CatalogState;
  rule?: CatalogTunnelRule;
  running: boolean;
  /** A failed status describes the old settings; it is cleared before saving. */
  failed: boolean;
  returnFocus(): HTMLElement | true;
  onClose(): void;
}) {
  // Captured when the dialog opened: a save that stopped the tunnel must still restart it on retry.
  const restart = useRef(running);
  const stopped = useRef(false);
  const formId = useId();
  const [initial] = useState<Draft>(() => ({
    label: rule?.label ?? "",
    hostId: rule?.hostId ?? state.hosts[0]?.id ?? "",
    type: rule?.type ?? "local",
    bindAddress: rule?.bindAddress ?? "127.0.0.1",
    bindPort: rule ? String(rule.bindPort) : "",
    destinationHost: rule?.destinationHost ?? "127.0.0.1",
    destinationPort: rule?.destinationPort != null ? String(rule.destinationPort) : "",
  }));
  const [draft, setDraft] = useState<Draft>(initial);
  // What the rule holds now: after "Saved, but not restarted" closing discards nothing, but further edits are dirty again.
  const [baseline, setBaseline] = useState<Draft>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<{ title: string; text: string }>();
  const [saving, setSaving] = useState(false);
  const dirty = (Object.keys(baseline) as (keyof Draft)[]).some((name) => baseline[name] !== draft[name]);
  const close = useDrawerClose({ dirty, busy: saving });
  const fail = (text: string) => setProblem(stopped.current
    ? { title: "The tunnel is stopped", text: `The tunnel was stopped and has not been restarted. ${text}` }
    : { title: "The rule was not saved", text });
  const first = useRef<HTMLInputElement>(null);
  const hostItems = useMemo(() => state.hosts.map((host) => ({ value: host.id, label: host.environment === "PROD" ? `${host.label} · PROD` : host.label })), [state.hosts]);
  const update = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(undefined);
  };

  async function save() {
    // An Enter that lands in the form while the discard step opens must not save behind it.
    if (saving || close.discarding) return;
    const bindPort = portValue(draft.bindPort);
    const destinationPort = portValue(draft.destinationPort);
    const remote = draft.type === "remote";
    const forwarding = draft.type !== "dynamic";
    const reach = remote ? "this Mac can reach" : "the server can reach";
    const local: FieldErrors = {
      label: labelError(draft.label),
      bindPort: validPort(bindPort) || (remote && bindPort === 0) ? undefined
        : remote ? "Enter a server port from 1 to 65535, or 0 to let the server choose." : "Enter a local port from 1 to 65535.",
      destinationPort: !forwarding || validPort(destinationPort) ? undefined : "Enter a destination port from 1 to 65535.",
      destination: !forwarding ? undefined : draft.destinationHost.trim()
        ? addressError(draft.destinationHost)?.replace("host name or IP address", `host name or IP address ${reach}`)
        : remote ? "Enter the host this Mac should connect to." : "Enter the host the server should connect to.",
      host: draft.hostId ? undefined : "Choose a server.",
    };
    setErrors(local);
    if (Object.values(local).some(Boolean)) return first.current?.focus();
    const submitted = draft;
    setSaving(true);
    setProblem(undefined);
    const data = {
      label: draft.label.trim(), hostId: draft.hostId, type: draft.type,
      bindAddress: remote || !publicBind(draft.bindAddress) ? draft.bindAddress : "127.0.0.1" as const, bindPort,
      destinationHost: forwarding ? draft.destinationHost.trim() : null, destinationPort: forwarding ? destinationPort : null,
    };
    const intent = rule
      ? { type: "update-tunnel-rule" as const, id: rule.id, expectedRevision: rule.revision, data }
      : { type: "create-tunnel-rule" as const, data };
    try {
      // Explicit restart semantics: the running tunnel keeps its old settings until it is stopped here. Main checks the
      // fields first (a dry run that reports only "running" means everything else is valid), so a bad value never stops it.
      if (running && rule) {
        const checked = await catalog.prepare(intent);
        if (!checked.ok) return fail(requestText(checked.error.code));
        if (checked.value.kind === "invalid") {
          const fields = checked.value.fields.filter((field) => field.field !== "tunnel");
          if (fields.length) return setErrors(serverFieldErrors(fields));
        }
      }
      if ((running || failed) && rule) {
        const result = await call((bridge) => bridge.stopTunnel({ owner, ruleId: rule.id }));
        if (!result.ok) return fail(requestText(result.error.code));
        if (running) stopped.current = true;
      }
      const prepared = await catalog.prepare(intent);
      if (!prepared.ok) return fail(requestText(prepared.error.code));
      if (prepared.value.kind === "invalid") {
        setErrors(serverFieldErrors(prepared.value.fields));
        if (stopped.current) fail("Fix the highlighted fields and save again.");
        return;
      }
      const applied = await catalog.apply(prepared.value.token);
      if (!applied.ok) return fail(requestText(applied.error.code));
      setBaseline(submitted);
      if (restart.current && rule) {
        const restarted = await call((bridge) => bridge.startTunnel({ owner, ruleId: rule.id }));
        const reason = !restarted.ok ? requestText(restarted.error.code)
          : restarted.value.status === "failed" ? tunnelErrorText[restarted.value.code] : undefined;
        if (reason) return setProblem({ title: "Saved, but not restarted", text: reason });
      }
      close.discard();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      close={close}
      onClose={onClose}
      initialFocus={first}
      finalFocus={returnFocus}
      data-testid="tunnel-editor"
      data-type={draft.type}
      title={`${rule ? "Edit" : "New"} ${ruleTitle[draft.type]}`}
      target={rule ? <span className="min-w-0 break-all">{rule.label}</span> : undefined}
      description="Saving never starts the tunnel. Start it from the list when you need it."
      discardText="Your changes to this rule will be lost."
      footer={
        <>
          <Button variant="outline" disabled={saving} onClick={close.request}>Cancel</Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? <Spinner data-icon="inline-start" /> : null}
            {restart.current ? "Save and restart" : rule ? "Save" : "Save rule"}
          </Button>
        </>
      }
    >
        <form
          className="grid min-w-0 gap-4"
          noValidate
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {restart.current ? (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>{stopped.current ? "This tunnel was stopped for this edit" : "This tunnel is running"}</AlertTitle>
              <AlertDescription>Saving stops it, saves the change, and starts it again with the new settings.</AlertDescription>
            </Alert>
          ) : null}
          {problem ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>{problem.title}</AlertTitle>
              <AlertDescription>{problem.text}</AlertDescription>
            </Alert>
          ) : null}
          <Field data-invalid={errors.label ? true : undefined}>
            <FieldLabel htmlFor="tunnel-label">Name</FieldLabel>
            <Input ref={first} id="tunnel-label" value={draft.label} autoComplete="off" spellCheck={false} onKeyDown={imeEnterGuard}
              aria-invalid={errors.label ? true : undefined} onChange={(event) => update({ label: event.target.value })} />
            {errors.label ? <FieldError>{errors.label}</FieldError> : null}
          </Field>
          <Field data-invalid={errors.host ? true : undefined}>
            <FieldLabel htmlFor="tunnel-host">Server</FieldLabel>
            <Select items={hostItems} value={draft.hostId} onValueChange={(next) => { if (typeof next === "string") update({ hostId: next }); }}>
              <SelectTrigger id="tunnel-host" className="w-full" aria-invalid={errors.host ? true : undefined}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {hostItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>The SSH connection that carries the tunnel, with that server's identity and host-key checks.</FieldDescription>
            {errors.host ? <FieldError>{errors.host}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor="tunnel-type">Type</FieldLabel>
            <Select
              items={[...typeItems]}
              value={draft.type}
              onValueChange={(next) => {
                if (next !== "local" && next !== "remote" && next !== "dynamic") return;
                // Public addresses exist only on the server side of a remote rule.
                update({ type: next, ...(next !== "remote" && publicBind(draft.bindAddress) ? { bindAddress: "127.0.0.1" } : {}) });
              }}
            >
              <SelectTrigger id="tunnel-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                <SelectGroup>
                  {typeItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              {draft.type === "local" ? "Apps on this Mac connect to a local port; the server opens the destination."
                : draft.type === "remote" ? "The server listens on a port; each connection comes back over SSH and this Mac opens the destination."
                  : "Apps on this Mac use a SOCKS5 proxy; the server resolves and opens each destination."}
            </FieldDescription>
          </Field>
          {draft.type === "remote" && publicBind(draft.bindAddress) ? (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>Reachable from other machines</AlertTitle>
              <AlertDescription>
                Anyone who can reach the server on this port reaches the destination through this Mac. The server listens publicly only if its GatewayPorts setting allows it.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-3">
            <Field data-invalid={errors.bindAddress ? true : undefined}>
              <FieldLabel htmlFor="tunnel-bind-address">{draft.type === "remote" ? "Server address" : "Local address"}</FieldLabel>
              <Select
                items={draft.type === "remote" ? serverItems : loopbackItems}
                value={draft.bindAddress}
                onValueChange={(next) => {
                  if (next === "127.0.0.1" || next === "::1" || (draft.type === "remote" && (next === "0.0.0.0" || next === "::"))) update({ bindAddress: next });
                }}
              >
                <SelectTrigger id="tunnel-bind-address" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {(draft.type === "remote" ? serverItems : loopbackItems).map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {draft.type === "remote" ? (publicBind(draft.bindAddress) ? "Other machines that reach the server can connect." : "Only programs on the server can connect.") : "Only apps on this Mac can connect."}
              </FieldDescription>
              {errors.bindAddress ? <FieldError>{errors.bindAddress}</FieldError> : null}
            </Field>
            <Field data-invalid={errors.bindPort ? true : undefined}>
              <FieldLabel htmlFor="tunnel-bind-port">{draft.type === "remote" ? "Server port" : "Local port"}</FieldLabel>
              <Input id="tunnel-bind-port" inputMode="numeric" value={draft.bindPort} autoComplete="off" onKeyDown={imeEnterGuard}
                aria-invalid={errors.bindPort ? true : undefined} onChange={(event) => update({ bindPort: event.target.value })} />
              {draft.type === "remote" ? <FieldDescription>0 lets the server choose.</FieldDescription> : null}
              {errors.bindPort ? <FieldError>{errors.bindPort}</FieldError> : null}
            </Field>
          </div>
          {draft.type === "dynamic" ? (
            <p className="type-caption text-muted-foreground" data-testid="socks-usage">
              Set the app's proxy to SOCKS5 at this address and port (socks5h:// so names are resolved by the server). No proxy password is used; only apps on this Mac can connect.
            </p>
          ) : null}
          <div className={draft.type === "dynamic" ? "hidden" : "grid grid-cols-[minmax(0,1fr)_8rem] gap-3"}>
            <Field data-invalid={errors.destination ? true : undefined}>
              <FieldLabel htmlFor="tunnel-destination">Destination host</FieldLabel>
              <Input id="tunnel-destination" value={draft.destinationHost} autoComplete="off" spellCheck={false} onKeyDown={imeEnterGuard}
                aria-invalid={errors.destination ? true : undefined} onChange={(event) => update({ destinationHost: event.target.value })} />
              <FieldDescription>
                {draft.type === "remote" ? "Resolved and connected by this Mac. 127.0.0.1 means this Mac itself."
                  : "Resolved and connected by the SSH server, not this Mac. 127.0.0.1 means the server itself."}
              </FieldDescription>
              {errors.destination ? <FieldError>{errors.destination}</FieldError> : null}
            </Field>
            <Field data-invalid={errors.destinationPort ? true : undefined}>
              <FieldLabel htmlFor="tunnel-destination-port">Port</FieldLabel>
              <Input id="tunnel-destination-port" inputMode="numeric" value={draft.destinationPort} autoComplete="off" onKeyDown={imeEnterGuard}
                aria-label="Destination port" aria-invalid={errors.destinationPort ? true : undefined}
                onChange={(event) => update({ destinationPort: event.target.value })} />
              {errors.destinationPort ? <FieldError>{errors.destinationPort}</FieldError> : null}
            </Field>
          </div>
          {errors.tunnel ? <FieldError>{errors.tunnel}</FieldError> : null}
        </form>
    </Drawer>
  );
}

function DeleteRuleDialog({
  owner,
  catalog,
  rule,
  running,
  failed,
  returnFocus,
  onClose,
}: {
  owner: Owner;
  catalog: Catalog;
  rule: CatalogTunnelRule;
  running: boolean;
  failed: boolean;
  returnFocus(): HTMLElement | true;
  onClose(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const close = useDrawerClose({ busy });
  const [problem, setProblem] = useState<string>();
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      // A failed entry is released too, so nothing about the deleted rule lingers.
      if (running || failed) {
        const stopped = await call((bridge) => bridge.stopTunnel({ owner, ruleId: rule.id }));
        if (!stopped.ok) return setProblem(requestText(stopped.error.code));
      }
      const prepared = await catalog.prepare({ type: "delete-tunnel-rule", id: rule.id, expectedRevision: rule.revision });
      if (!prepared.ok) return setProblem(requestText(prepared.error.code));
      if (prepared.value.kind === "invalid") return setProblem(serverFieldErrors(prepared.value.fields).tunnel ?? "The rule could not be deleted.");
      const applied = await catalog.apply(prepared.value.token);
      if (!applied.ok) return setProblem(requestText(applied.error.code));
      close.discard();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Drawer
      close={close}
      onClose={onClose}
      alert
      initialFocus={cancel}
      finalFocus={returnFocus}
      data-testid="delete-tunnel-dialog"
      title={<span className="break-all">Delete {rule.label}?</span>}
      target={<Badge variant="outline">{typeText[rule.type]}</Badge>}
      description={running ? "The tunnel is running. It is stopped first, closing its open connections, and then the rule is removed." : "The rule is removed from this Mac."}
      footer={
        <>
          <Button ref={cancel} variant="outline" disabled={busy} onClick={close.request}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}{running ? "Stop and delete" : "Delete rule"}
          </Button>
        </>
      }
    >
      {problem ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Nothing more was changed</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
    </Drawer>
  );
}
