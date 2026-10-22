import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangleIcon } from "lucide-react";
import type {
  CatalogChangeIntent,
  CatalogEffective,
  CatalogGroup,
  CatalogHost,
  CatalogHostImpact,
  CatalogIdentity,
  CatalogState,
  ErrorCode,
} from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer, useDrawerClose } from "@/components/drawer";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Catalog } from "@/hooks/use-catalog";
import {
  groupOptions,
  groupTree,
  memberDefaults,
  provenance,
} from "@/lib/catalog-filter";
import {
  draftsEqual,
  groupDraft,
  groupErrors,
  groupIntent,
  hostDraft,
  hostErrors,
  hostIntent,
  rebaseDraft,
  serverFieldErrors,
  type Field as FieldName,
  type FieldErrors,
  type GroupDraft,
  type HostDraft,
} from "@/lib/catalog-validation";

type Phase =
  | { kind: "edit" }
  | { kind: "busy" }
  | { kind: "confirm"; token: string; hosts: CatalogHostImpact[] }
  | { kind: "conflict" }
  | { kind: "gone" }
  | { kind: "failed"; code: ErrorCode };
interface Entity {
  id: string;
  revision: number;
}
interface EditorOptions<D, E extends Entity> {
  catalog: Catalog;
  state: CatalogState;
  /** The edited entity as it is in the current state; undefined when creating or once deleted. */
  latest?: E;
  editing: boolean;
  initial: () => D;
  toDraft(entity: E): D;
  validate(draft: D): FieldErrors;
  toIntent(draft: D, base?: E): CatalogChangeIntent | undefined;
  /** Focus order of invalid fields. */
  order: FieldName[];
  /** The edited host itself is not "another" affected server. */
  selfHostId?: string;
  onSaved(createdId?: string): void;
  onClose(): void;
}

/** Revision-fenced save: prepare → confirm when other servers change → apply → state includes the revision. */
function useEditor<D extends object, E extends Entity>(options: EditorOptions<D, E>) {
  const { catalog, state, latest, editing, toDraft, validate, toIntent } = options;
  const prefix = useId();
  const [base, setBase] = useState(latest);
  const [draft, setDraft] = useState<D>(options.initial);
  const [initial, setInitial] = useState<D>(options.initial);
  const [checked, setChecked] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [rebasing, setRebasing] = useState(false);
  const errors = { ...(checked ? validate(draft) : {}), ...serverErrors };
  const dirty = !draftsEqual(draft, initial);
  const close = useDrawerClose({ dirty: dirty && phase.kind !== "gone", busy: phase.kind === "busy" });

  useEffect(() => {
    if (!rebasing) return;
    setRebasing(false);
    if (editing && !latest) return setPhase({ kind: "gone" });
    if (base && latest) {
      setDraft((current) => rebaseDraft(current, toDraft(base), toDraft(latest)));
      setInitial(toDraft(latest));
      setBase(latest);
    }
    setPhase({ kind: "edit" });
  }, [rebasing, editing, latest, base, toDraft]);

  const field = (name: FieldName) => `${prefix}-${name}`;
  const focusFirst = (found: FieldErrors) => {
    const first = options.order.find((name) => found[name]);
    if (first) document.getElementById(field(first))?.focus();
  };
  const fail = (code: ErrorCode) =>
    setPhase(code === "conflict" ? { kind: "conflict" } : { kind: "failed", code });
  async function commit(token: string) {
    setPhase({ kind: "busy" });
    const result = await catalog.apply(token);
    if (!result.ok) return fail(result.error.code);
    options.onSaved(result.value.createdIds[0]);
  }
  async function submit() {
    // An Enter that lands in the form while the discard prompt opens must not save behind it.
    if (phase.kind === "busy" || phase.kind === "gone" || close.discarding) return;
    const found = validate(draft);
    setChecked(true);
    setServerErrors({});
    if (Object.keys(found).length) return focusFirst(found);
    const intent = toIntent(draft, base);
    if (!intent) return options.onClose();
    setPhase({ kind: "busy" });
    const result = await catalog.prepare(intent);
    if (!result.ok) return fail(result.error.code);
    if (result.value.kind === "invalid") {
      const reported = serverFieldErrors(result.value.fields);
      setServerErrors(reported);
      setPhase({ kind: "edit" });
      return focusFirst(reported);
    }
    const known = new Set(state.hosts.map((host) => host.id));
    const others = result.value.impacts.hosts.filter(
      (impact) =>
        impact.hostId !== options.selfHostId &&
        known.has(impact.hostId) &&
        (impact.removed ||
          impact.effectiveConnectionChanged ||
          impact.provenanceChanged ||
          impact.pathChanged),
    );
    if (others.length)
      return setPhase({ kind: "confirm", token: result.value.token, hosts: others });
    await commit(result.value.token);
  }
  return {
    draft,
    errors,
    phase,
    field,
    close,
    set(patch: Partial<D>) {
      setDraft((current) => ({ ...current, ...patch }));
      setServerErrors({});
    },
    submit,
    commit,
    back: () => setPhase({ kind: "edit" }),
    reload() {
      // Rebase only once the reloaded state (the latest entity) has arrived.
      void catalog.reload().then(() => setRebasing(true));
    },
  };
}
type Editor<D extends object> = ReturnType<typeof useEditor<D, Entity>>;

function EditorFrame<D extends object>({
  editor,
  title,
  target,
  description,
  noun,
  onClose,
  children,
}: {
  editor: Editor<D>;
  title: string;
  target?: ReactNode;
  description: string;
  noun: "server" | "group";
  onClose(): void;
  children: ReactNode;
}) {
  const { phase } = editor;
  const formId = useId();
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (phase.kind === "confirm") back.current?.focus();
  }, [phase.kind]);
  const busy = phase.kind === "busy";
  return (
    <Drawer
      close={editor.close}
      onClose={onClose}
      title={title}
      target={target}
      description={description}
      discardText={`Your edits to this ${noun} will be lost.`}
      data-testid={`${noun}-editor`}
      footer={
        phase.kind === "confirm" ? (
          <>
            <Button ref={back} variant="outline" onClick={editor.back}>
              Back to editing
            </Button>
            <Button onClick={() => void editor.commit(phase.token)}>
              Save changes
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" disabled={busy} onClick={editor.close.request}>
              Cancel
            </Button>
            <Button type="submit" form={formId} disabled={busy || phase.kind === "gone"}>
              {busy ? <Spinner data-icon="inline-start" /> : null}Save
            </Button>
          </>
        )
      }
    >
      {phase.kind === "confirm" ? (
        <ImpactList hosts={phase.hosts} />
      ) : (
        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void editor.submit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing)
              event.preventDefault();
          }}
        >
          <FieldGroup>{children}</FieldGroup>
        </form>
      )}
      {phase.kind === "conflict" ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Changed since you opened this</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>
              Your edits are kept. Reload to review the latest values, then
              save again.
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={editor.reload}
            >
              Reload
            </Button>
          </AlertDescription>
        </Alert>
      ) : phase.kind === "gone" ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>This {noun} was deleted</AlertTitle>
          <AlertDescription>
            It no longer exists, so these changes cannot be saved.
          </AlertDescription>
        </Alert>
      ) : phase.kind === "failed" ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Changes were not saved</AlertTitle>
          <AlertDescription>
            {phase.code === "busy"
              ? "The workspace is busy. Try again in a moment."
              : "The workspace could not save this change. Try again."}
          </AlertDescription>
        </Alert>
      ) : null}
    </Drawer>
  );
}

function ImpactList({ hosts }: { hosts: CatalogHostImpact[] }) {
  return (
    <div className="grid gap-3">
      <Alert>
        <AlertTriangleIcon />
        <AlertTitle>
          This also changes {hosts.length}{" "}
          {hosts.length === 1 ? "other server" : "other servers"}
        </AlertTitle>
        <AlertDescription>
          Review them before saving. Open sessions keep their current
          connection.
        </AlertDescription>
      </Alert>
      <AffectedServers hosts={hosts} />
    </div>
  );
}

export function AffectedServers({ hosts }: { hosts: CatalogHostImpact[] }) {
  return (
    <ul className="grid gap-1 text-sm" aria-label="Affected servers">
      {hosts.map((impact) => (
        <li key={impact.hostId} className="flex min-w-0 flex-wrap gap-x-2">
          <span className="min-w-0 break-all font-medium">{impact.label}</span>
          <span className="text-muted-foreground">
            {[
              impact.removed && "deleted",
              impact.effectiveConnectionChanged && "connection settings change",
              impact.provenanceChanged && "inherited values come from elsewhere",
              impact.pathChanged && "group path changes",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function identityText(
  effective: Pick<CatalogEffective, "authSelection" | "identityId">,
  identities: ReadonlyMap<string, CatalogIdentity>,
): string {
  if (effective.authSelection === "identity" && effective.identityId) {
    const identity = identities.get(effective.identityId);
    return identity ? `${identity.label} (${identity.username})` : "Unavailable identity";
  }
  return effective.authSelection === "clear" ? "No identity" : "None";
}

function useCatalogMaps(state: CatalogState) {
  return useMemo(
    () => ({
      groups: new Map(state.groups.map((group) => [group.id, group])),
      identities: new Map(state.identities.map((identity) => [identity.id, identity])),
      tree: groupTree(state.groups),
    }),
    [state],
  );
}

function TextField({
  id,
  label,
  value,
  error,
  onChange,
  description,
}: {
  id: string;
  label: string;
  value: string;
  error?: string;
  onChange(value: string): void;
  description?: string;
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

function ChoiceField({
  id,
  label,
  value,
  items,
  error,
  description,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  items: { value: string; label: string }[];
  error?: string;
  description?: ReactNode;
  onChange(value: string): void;
}) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        <SelectTrigger id={id} className="w-full" aria-invalid={error ? true : undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

function PortField<D extends HostDraft | GroupDraft>({
  editor,
  inherited,
  groups,
}: {
  editor: Editor<D>;
  inherited: CatalogEffective;
  groups: ReadonlyMap<string, CatalogGroup>;
}) {
  const { draft, errors, field } = editor;
  const label = `${field("port")}-label`;
  return (
    <Field data-invalid={errors.port ? true : undefined}>
      <FieldLabel id={label}>Port</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-labelledby={label}
          variant="outline"
          spacing={0}
          value={[draft.portMode]}
          onValueChange={(value) => {
            const mode = value[0];
            if (mode === "inherit" || mode === "value")
              editor.set({ portMode: mode } as Partial<D>);
          }}
        >
          <ToggleGroupItem value="inherit">Inherit</ToggleGroupItem>
          <ToggleGroupItem value="value">Custom</ToggleGroupItem>
        </ToggleGroup>
        {draft.portMode === "value" ? (
          <Input
            id={field("port")}
            aria-label="Custom port"
            inputMode="numeric"
            className="w-28"
            value={draft.port}
            aria-invalid={errors.port ? true : undefined}
            onChange={(event) => editor.set({ port: event.target.value } as Partial<D>)}
          />
        ) : null}
      </div>
      {draft.portMode === "inherit" ? (
        <FieldDescription>
          Uses {inherited.port}, {provenance(inherited.portSource, groups)}.
        </FieldDescription>
      ) : null}
      {errors.port ? <FieldError>{errors.port}</FieldError> : null}
    </Field>
  );
}

function IdentityField<D extends HostDraft | GroupDraft>({
  editor,
  state,
  inherited,
  groups,
  identities,
}: {
  editor: Editor<D>;
  state: CatalogState;
  inherited: CatalogEffective;
  groups: ReadonlyMap<string, CatalogGroup>;
  identities: ReadonlyMap<string, CatalogIdentity>;
}) {
  const items = [
    { value: "inherit", label: "Inherit" },
    { value: "clear", label: "No identity" },
    ...state.identities.map((identity) => ({
      value: identity.id,
      label: `${identity.label} (${identity.username})`,
    })),
  ];
  return (
    <ChoiceField
      id={editor.field("identity")}
      label="Identity"
      value={editor.draft.auth}
      items={items}
      error={editor.errors.identity}
      onChange={(auth) => editor.set({ auth } as Partial<D>)}
      description={
        state.identities.length === 0
          ? "No identities are saved yet. A server needs an identity to connect."
          : editor.draft.auth === "inherit"
            ? `Uses ${identityText(inherited, identities)}, ${provenance(inherited.authSource, groups)}.`
            : undefined
      }
    />
  );
}

const environments = [
  { value: "none", label: "None" },
  { value: "DEV", label: "DEV" },
  { value: "STAGING", label: "STAGING" },
  { value: "PROD", label: "PROD" },
];

export function HostEditor({
  catalog,
  state,
  hostId,
  groupId = null,
  onClose,
  onSaved,
}: {
  catalog: Catalog;
  state: CatalogState;
  hostId?: string;
  groupId?: string | null;
  onClose(): void;
  onSaved(createdId?: string): void;
}) {
  const latest = hostId ? state.hosts.find((host) => host.id === hostId) : undefined;
  const { groups, identities, tree } = useCatalogMaps(state);
  const editor = useEditor<HostDraft, CatalogHost>({
    catalog,
    state,
    latest,
    editing: !!hostId,
    initial: () => hostDraft(latest, groupId),
    toDraft: hostDraft,
    validate: hostErrors,
    toIntent: hostIntent,
    order: ["label", "address", "group", "jump", "proxy", "port", "identity"],
    selfHostId: hostId,
    onSaved,
    onClose,
  });
  const { draft, errors, field } = editor;
  const inherited = memberDefaults(draft.groupId ? groups.get(draft.groupId) : undefined);
  return (
    <EditorFrame
      editor={editor as Editor<HostDraft>}
      noun="server"
      title={hostId ? "Edit server" : "New server"}
      target={
        latest ? (
          <>
            <span className="min-w-0 break-all">{latest.label}</span>
            {latest.environment ? (
              <Badge variant={latest.environment === "PROD" ? "production" : "outline"}>
                {latest.environment}
              </Badge>
            ) : null}
          </>
        ) : undefined
      }
      description="Port and identity can come from the server's group. Address and environment are set here."
      onClose={onClose}
    >
      <TextField
        id={field("label")}
        label="Name"
        value={draft.label}
        error={errors.label}
        onChange={(label) => editor.set({ label })}
      />
      <TextField
        id={field("address")}
        label="Address"
        value={draft.address}
        error={errors.address}
        description="Host name or IP address."
        onChange={(address) => editor.set({ address })}
      />
      <ChoiceField
        id={field("group")}
        label="Group"
        value={draft.groupId ?? "none"}
        items={[
          { value: "none", label: "No group" },
          ...groupOptions(tree).map((option) => ({
            value: option.id,
            label: option.path,
          })),
        ]}
        error={errors.group}
        onChange={(value) => editor.set({ groupId: value === "none" ? null : value })}
      />
      <ChoiceField
        id={field("environment" as FieldName)}
        label="Environment"
        value={draft.environment ?? "none"}
        items={environments}
        description={
          draft.environment === "PROD"
            ? "Marked PROD wherever this server appears."
            : undefined
        }
        onChange={(value) =>
          editor.set({
            environment: value === "none" ? null : (value as HostDraft["environment"]),
          })
        }
      />
      <ChoiceField
        id={field("via" as FieldName)}
        label="Connect via"
        value={draft.via}
        items={[
          { value: "direct", label: "Direct" },
          { value: "jump", label: "A jump host (another saved server)" },
          { value: "proxy", label: "A proxy (SOCKS5 or HTTP)" },
        ]}
        description={
          draft.via === "jump"
            ? "The jump host signs in with its own identity and host-key check, then opens the connection to this server. Its address is resolved by the jump host."
            : draft.via === "proxy"
              ? "The proxy opens the connection to this server. No proxy password is used."
              : undefined
        }
        onChange={(value) => editor.set({ via: value as HostDraft["via"] })}
      />
      {draft.via === "jump" ? (
        <ChoiceField
          id={field("jump")}
          label="Jump host"
          value={draft.jumpHostId ?? "none"}
          items={[
            { value: "none", label: "Choose a server" },
            ...state.hosts
              .filter((host) => host.id !== hostId)
              .map((host) => ({ value: host.id, label: host.environment === "PROD" ? `${host.label} · PROD` : host.label })),
          ]}
          error={errors.jump}
          onChange={(value) => editor.set({ jumpHostId: value === "none" ? null : value })}
        />
      ) : null}
      {draft.via === "proxy" ? (
        <>
          <ChoiceField
            id={field("proxyType" as FieldName)}
            label="Proxy type"
            value={draft.proxyType}
            items={[
              { value: "socks5", label: "SOCKS5 (names resolved by the proxy)" },
              { value: "http", label: "HTTP CONNECT" },
            ]}
            onChange={(value) => editor.set({ proxyType: value as HostDraft["proxyType"] })}
          />
          <TextField
            id={field("proxy")}
            label="Proxy address"
            value={draft.proxyHost}
            error={errors.proxy}
            description="Host name or IP address of the proxy."
            onChange={(proxyHost) => editor.set({ proxyHost })}
          />
          <TextField
            id={field("proxyPort" as FieldName)}
            label="Proxy port"
            value={draft.proxyPort}
            onChange={(proxyPort) => editor.set({ proxyPort })}
          />
        </>
      ) : null}
      <PortField editor={editor as Editor<HostDraft>} inherited={inherited} groups={groups} />
      <IdentityField
        editor={editor as Editor<HostDraft>}
        state={state}
        inherited={inherited}
        groups={groups}
        identities={identities}
      />
    </EditorFrame>
  );
}

export function GroupEditor({
  catalog,
  state,
  groupId,
  parentId = null,
  onClose,
  onSaved,
}: {
  catalog: Catalog;
  state: CatalogState;
  groupId?: string;
  parentId?: string | null;
  onClose(): void;
  onSaved(createdId?: string): void;
}) {
  const latest = groupId ? state.groups.find((group) => group.id === groupId) : undefined;
  const { groups, identities, tree } = useCatalogMaps(state);
  const editor = useEditor<GroupDraft, CatalogGroup>({
    catalog,
    state,
    latest,
    editing: !!groupId,
    initial: () => groupDraft(latest, parentId),
    toDraft: groupDraft,
    validate: groupErrors,
    toIntent: groupIntent,
    order: ["label", "parent", "port", "identity"],
    onSaved,
    onClose,
  });
  const { draft, errors, field } = editor;
  const inherited = memberDefaults(draft.parentId ? groups.get(draft.parentId) : undefined);
  return (
    <EditorFrame
      editor={editor as Editor<GroupDraft>}
      noun="group"
      title={groupId ? "Edit group" : "New group"}
      target={latest ? <span className="min-w-0 break-all">{latest.label}</span> : undefined}
      description="Servers and subgroups in this group inherit its port and identity unless they set their own."
      onClose={onClose}
    >
      <TextField
        id={field("label")}
        label="Name"
        value={draft.label}
        error={errors.label}
        onChange={(label) => editor.set({ label })}
      />
      <ChoiceField
        id={field("parent")}
        label="Parent group"
        value={draft.parentId ?? "none"}
        items={[
          { value: "none", label: "Top level" },
          ...groupOptions(tree, groupId).map((option) => ({
            value: option.id,
            label: option.path,
          })),
        ]}
        error={errors.parent}
        onChange={(value) => editor.set({ parentId: value === "none" ? null : value })}
      />
      <PortField editor={editor as Editor<GroupDraft>} inherited={inherited} groups={groups} />
      <IdentityField
        editor={editor as Editor<GroupDraft>}
        state={state}
        inherited={inherited}
        groups={groups}
        identities={identities}
      />
    </EditorFrame>
  );
}
