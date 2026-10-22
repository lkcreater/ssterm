import { useMemo, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import {
  AlertTriangleIcon,
  CheckIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
  SearchXIcon,
  ServerIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import {
  MAX_CATALOG_ITEMS,
  type CatalogHost,
  type CatalogState,
  type TerminalSession,
} from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import {
  ConnectionStatus,
  type ConnectionState,
} from "@/components/connection/connection-status";
import { identityText } from "@/components/catalog/editors";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import type { Catalog } from "@/hooks/use-catalog";
import {
  compareLabel,
  endpointText,
  normalized,
  provenance,
  type CatalogScope,
} from "@/lib/catalog-filter";
import { labelError, serverFieldErrors } from "@/lib/catalog-validation";

export type ConnectFailure = { hostId: string; message: string };

type Identities = ReadonlyMap<string, CatalogState["identities"][number]>;
function target(host: CatalogHost, identities: Identities): string {
  const identity =
    host.effective.authSelection === "identity" && host.effective.identityId
      ? identities.get(host.effective.identityId)
      : undefined;
  return endpointText(host.address, host.effective.port, identity?.username);
}
function connection(sessions: TerminalSession[], hostId: string): ConnectionState | undefined {
  const own = sessions.filter((session) => session.hostId === hostId);
  if (own.some((session) => session.phase === "ready")) return "connected";
  if (own.some((session) => session.phase === "connecting")) return "connecting";
}

export function HostsPage({
  catalog,
  state,
  hosts,
  scope,
  filtering,
  selectedId,
  sessions,
  connectFailure,
  onSelect,
  onAddHost,
  onAddGroup,
  onEditHost,
  onEditGroup,
  onDeleteHost,
  onDeleteGroup,
  onConnect,
  onOpenSftp,
  onClearFilters,
  toolbar,
}: {
  catalog: Catalog;
  /** Search and tag filter, shown first among the header actions. */
  toolbar?: ReactNode;
  state: CatalogState;
  /** Already filtered and ordered. */
  hosts: CatalogHost[];
  scope: CatalogScope;
  filtering: boolean;
  selectedId?: string;
  sessions: TerminalSession[];
  connectFailure?: ConnectFailure;
  onSelect(id: string): void;
  onAddHost(): void;
  onAddGroup(): void;
  onEditHost(id: string): void;
  onEditGroup(id: string): void;
  onDeleteHost(id: string): void;
  onDeleteGroup(id: string): void;
  onConnect(host: CatalogHost): void;
  onOpenSftp(host: CatalogHost): void;
  onClearFilters(): void;
}) {
  const groups = useMemo(() => new Map(state.groups.map((group) => [group.id, group])), [state.groups]);
  const tags = useMemo(() => new Map(state.tags.map((tag) => [tag.id, tag])), [state.tags]);
  const identities = useMemo(
    () => new Map(state.identities.map((row) => [row.id, row])),
    [state.identities],
  );
  const list = useRef<HTMLUListElement>(null);
  const group = scope.kind === "group" ? groups.get(scope.groupId) : undefined;
  const selected = hosts.find((host) => host.id === selectedId) ?? hosts[0];
  const title =
    scope.kind === "all" ? "All servers" : scope.kind === "ungrouped" ? "Ungrouped" : (group?.label ?? "Group");
  const empty = state.hosts.length === 0 && state.groups.length === 0 && !filtering;
  return (
    <div className="catalog-page" data-testid="hosts-page">
      {/* Focus target after a deletion removes the focused control. */}
      <PageHeader
        title={title}
        subtitle={`Your SSH workspace · ${hosts.length} ${hosts.length === 1 ? "server" : "servers"}`}
        actions={
          <>
            {toolbar}
            {group ? (
              <>
                <Button variant="outline" size="sm" onClick={() => onEditGroup(group.id)}>
                  <PencilIcon data-icon="inline-start" /> Edit group
                </Button>
                <Button variant="outline" size="sm" onClick={() => onDeleteGroup(group.id)}>
                  <Trash2Icon data-icon="inline-start" /> Delete group
                </Button>
              </>
            ) : null}
            {/* Empty states carry their own Add action. */}
            {hosts.length > 0 || filtering ? (
              <Button size="sm" onClick={onAddHost}>
                <PlusIcon data-icon="inline-start" /> Add server
              </Button>
            ) : null}
          </>
        }
      />
      {state.truncated ? (
        <p className="type-caption text-muted-foreground">
          Showing the first {MAX_CATALOG_ITEMS.toLocaleString()} items of each kind.
        </p>
      ) : null}
      {empty ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ServerIcon />
            </EmptyMedia>
            <EmptyTitle>No servers yet</EmptyTitle>
            <EmptyDescription>
              Add a server to connect to it. Groups share a port and identity
              with the servers inside them.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button onClick={onAddHost}>
              <PlusIcon data-icon="inline-start" /> Add server
            </Button>
            <Button variant="outline" onClick={onAddGroup}>
              <FolderPlusIcon data-icon="inline-start" /> New group
            </Button>
          </EmptyContent>
        </Empty>
      ) : hosts.length === 0 ? (
        filtering ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon />
              </EmptyMedia>
              <EmptyTitle>No servers match</EmptyTitle>
              <EmptyDescription>
                Search looks at names, addresses, user names, tags and group
                names. Every selected tag must be on a server.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={onClearFilters}>
                Clear search and tags
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {scope.kind === "all"
                  ? "No servers yet"
                  : scope.kind === "ungrouped"
                    ? "No ungrouped servers"
                    : "No servers in this group"}
              </EmptyTitle>
              <EmptyDescription>
                {scope.kind === "all"
                  ? "Your groups are empty. Add a server to connect to it."
                  : scope.kind === "ungrouped"
                    ? "Every server belongs to a group."
                    : "Add a server here, or move one into this group or its subgroups."}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onAddHost}>
                <PlusIcon data-icon="inline-start" /> Add server
              </Button>
            </EmptyContent>
          </Empty>
        )
      ) : (
        <div className="catalog-split">
          <ul
            ref={list}
            className="catalog-list"
            aria-label={`${title} servers`}
            onKeyDown={(event) => {
              const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button[data-host-id]") ?? [])];
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const step: Record<string, number> = {
                ArrowDown: index + 1,
                ArrowUp: index - 1,
                Home: 0,
                End: buttons.length - 1,
              };
              const next = buttons[step[event.key] ?? -1];
              if (index < 0 || !next) return;
              event.preventDefault();
              next.focus();
              onSelect(next.dataset.hostId!);
            }}
          >
            {hosts.map((host) => {
              const current = host.id === selected?.id;
              const status = connection(sessions, host.id);
              const path = host.ancestry.map((row) => row.label).join(" / ");
              return (
                <li key={host.id}>
                  <button
                    type="button"
                    className="catalog-row"
                    data-host-id={host.id}
                    // One tab stop: arrows, Home and End move between rows.
                    tabIndex={current ? 0 : -1}
                    aria-current={current ? "true" : undefined}
                    onClick={() => onSelect(host.id)}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate font-medium" title={host.label}>{host.label}</span>
                      <EnvironmentBadge environment={host.environment} />
                      {status ? <span className="ml-auto shrink-0"><ConnectionStatus state={status} /></span> : null}
                    </span>
                    <span className="host-target truncate" title={target(host, identities)}>{target(host, identities)}</span>
                    {path ? <span className="type-caption truncate text-muted-foreground" title={path}>{path}</span> : null}
                    {host.tagIds.length ? (
                      <span className="flex min-w-0 flex-wrap gap-1">
                        {host.tagIds.map((id) => {
                          const tag = tags.get(id);
                          return tag ? (
                            <Badge key={id} variant="secondary" className="max-w-full" title={tag.label}>
                              <span className="min-w-0 truncate">{tag.label}</span>
                            </Badge>
                          ) : null;
                        })}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {selected ? (
            <HostDetail
              key={selected.id}
              catalog={catalog}
              state={state}
              host={selected}
              groups={groups}
              identities={identities}
              status={connection(sessions, selected.id)}
              failure={connectFailure?.hostId === selected.id ? connectFailure.message : undefined}
              onEdit={() => onEditHost(selected.id)}
              onDelete={() => onDeleteHost(selected.id)}
              onConnect={() => onConnect(selected)}
              onOpenSftp={() => onOpenSftp(selected)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** SST-030: the path outermost first, e.g. "Bastion → Inner → this server", or the proxy, or "Direct". */
function routeText(host: CatalogHost, state: CatalogState): string {
  if (host.proxy) return `${host.proxy.type === "http" ? "HTTP" : "SOCKS5"} proxy ${host.proxy.host}:${host.proxy.port}`;
  if (!host.jumpHostId) return "Direct";
  const byId = new Map(state.hosts.map((row) => [row.id, row]));
  const path: string[] = [];
  const seen = new Set<string>([host.id]);
  for (let id: string | null = host.jumpHostId; id && !seen.has(id) && path.length < 4; ) {
    seen.add(id);
    const jump = byId.get(id);
    if (!jump) { path.unshift("Missing server"); break; }
    path.unshift(jump.environment === "PROD" ? `${jump.label} (PROD)` : jump.label);
    id = jump.jumpHostId;
  }
  return `${path.join(" → ")} → this server`;
}

function HostDetail({
  catalog,
  state,
  host,
  groups,
  identities,
  status,
  failure,
  onEdit,
  onDelete,
  onConnect,
  onOpenSftp,
}: {
  catalog: Catalog;
  state: CatalogState;
  host: CatalogHost;
  groups: ReadonlyMap<string, CatalogState["groups"][number]>;
  identities: Identities;
  status?: ConnectionState;
  failure?: string;
  onEdit(): void;
  onDelete(): void;
  onConnect(): void;
  onOpenSftp(): void;
}) {
  // A tag change in flight is revision-fenced on this host; editing or deleting it meanwhile would conflict.
  const [tagsBusy, setTagsBusy] = useState(false);
  const canConnect = host.effective.authSelection === "identity";
  const reason = `${host.id}-connect-reason`;
  return (
    <section className="catalog-detail" aria-labelledby={`${host.id}-title`} data-testid="host-detail">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 id={`${host.id}-title`} className="type-section min-w-0 break-all">
          {host.label}
        </h3>
        <EnvironmentBadge environment={host.environment} />
        {status ? <ConnectionStatus state={status} /> : null}
      </div>
      <p className="host-target break-all">{target(host, identities)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          aria-disabled={canConnect ? undefined : true}
          aria-describedby={canConnect ? undefined : reason}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (canConnect) onConnect();
          }}
        >
          <TerminalIcon data-icon="inline-start" /> Connect
        </Button>
        <Button
          variant="outline"
          aria-disabled={canConnect ? undefined : true}
          aria-describedby={canConnect ? undefined : reason}
          className="aria-disabled:opacity-50"
          onClick={() => {
            if (canConnect) onOpenSftp();
          }}
        >
          <FolderOpenIcon data-icon="inline-start" /> Open SFTP
        </Button>
        <Button variant="outline" disabled={tagsBusy} onClick={onEdit}>
          <PencilIcon data-icon="inline-start" /> Edit
        </Button>
        <Button variant="outline" disabled={tagsBusy} onClick={onDelete}>
          <Trash2Icon data-icon="inline-start" /> Delete
        </Button>
      </div>
      {canConnect ? null : (
        <p id={reason} className="type-caption text-muted-foreground">
          Choose an identity to connect.
        </p>
      )}
      {failure ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Could not connect</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      <dl className="catalog-facts">
        <dt>Address</dt>
        <dd className="font-mono break-all">{host.address}</dd>
        <dt>Group</dt>
        <dd className="break-all">
          {host.ancestry.length ? host.ancestry.map((row) => row.label).join(" / ") : "No group"}
        </dd>
        <dt>Port</dt>
        <dd>
          {host.effective.port}{" "}
          <span className="text-muted-foreground">· {provenance(host.effective.portSource, groups)}</span>
        </dd>
        <dt>Identity</dt>
        <dd className="break-all">
          {identityText(host.effective, identities)}{" "}
          <span className="text-muted-foreground">· {provenance(host.effective.authSource, groups)}</span>
        </dd>
        <dt>Environment</dt>
        <dd>{host.environment ?? "None"}</dd>
        <dt>Connect via</dt>
        <dd className="break-all" data-testid="host-route">{routeText(host, state)}</dd>
      </dl>
      <HostTags catalog={catalog} state={state} host={host} busy={tagsBusy} setBusy={setTagsBusy} />
    </section>
  );
}

/** One membership change at a time, each revision-fenced on the host. Controls stay enabled (guarded) so keyboard focus is kept. */
function HostTags({
  catalog,
  state,
  host,
  busy,
  setBusy,
}: {
  catalog: Catalog;
  state: CatalogState;
  host: CatalogHost;
  busy: boolean;
  setBusy(busy: boolean): void;
}) {
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const tags = useMemo(() => [...state.tags].sort(compareLabel), [state.tags]);
  async function change(
    intent: Parameters<Catalog["prepare"]>[0],
  ): Promise<string | undefined> {
    const conflict = async () => {
      // Show the current revision so the retry is fenced on what the user now sees.
      await catalog.reload();
      setError("This server changed. Review it and try again.");
    };
    const prepared = await catalog.prepare(intent);
    if (!prepared.ok)
      return prepared.error.code === "conflict"
        ? void (await conflict())
        : void setError("Tags could not be changed. Try again.");
    if (prepared.value.kind === "invalid") {
      const errors = serverFieldErrors(prepared.value.fields);
      return void setError(errors.label ?? errors.tag ?? "Tags could not be changed.");
    }
    const applied = await catalog.apply(prepared.value.token);
    if (!applied.ok)
      return applied.error.code === "conflict"
        ? void (await conflict())
        : void setError("Tags could not be changed. Try again.");
    return applied.value.createdIds[0] ?? "";
  }
  async function toggle(tagId: string, present: boolean) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    await change({ type: "set-host-tag", hostId: host.id, tagId, present, expectedHostRevision: host.revision });
    setBusy(false);
  }
  async function add() {
    if (busy) return;
    const invalid = labelError(label);
    if (invalid) {
      setError(invalid);
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(undefined);
    const existing = state.tags.find((tag) => normalized(tag.label) === normalized(label));
    const tagId = existing?.id ?? (await change({ type: "create-tag", data: { label: label.trim() } }));
    if (tagId && !host.tagIds.includes(tagId)) {
      const done = await change({
        type: "set-host-tag",
        hostId: host.id,
        tagId,
        present: true,
        expectedHostRevision: host.revision,
      });
      if (done !== undefined) setLabel("");
    } else if (tagId) setLabel("");
    setBusy(false);
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2" role="group" aria-labelledby={`${host.id}-tags`}>
      <h4 id={`${host.id}-tags`} className="type-label">
        Tags
      </h4>
      {tags.length ? (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => {
            const assigned = host.tagIds.includes(tag.id);
            return (
              <Toggle
                key={tag.id}
                variant="outline"
                size="sm"
                className="max-w-full"
                title={tag.label}
                pressed={assigned}
                onPressedChange={(pressed) => void toggle(tag.id, pressed)}
              >
                {assigned ? <CheckIcon data-icon="inline-start" /> : null}
                <span className="min-w-0 truncate">{tag.label}</span>
              </Toggle>
            );
          })}
        </div>
      ) : (
        <p className="type-caption text-muted-foreground">No tags yet.</p>
      )}
      <InputGroup className="max-w-xs">
        <InputGroupInput
          ref={input}
          aria-label="New tag"
          placeholder="New tag"
          value={label}
          aria-busy={busy || undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setLabel(event.target.value);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void add();
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton disabled={!label.trim()} onClick={() => void add()}>
            {busy ? <Spinner /> : null}Add tag
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
