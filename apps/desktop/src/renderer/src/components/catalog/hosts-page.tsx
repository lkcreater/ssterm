import { useMemo, useRef, type ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import {
  AlertTriangleIcon,
  EllipsisIcon,
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  ConnectionStatus,
  useAwaitingTrust,
  type ConnectionState,
} from "@/components/connection/connection-status";
import { hostTarget, identityText } from "@/components/catalog/editors";
import { EnvironmentBadge } from "@/components/connection/host-identity";
import type { CatalogScope } from "@/lib/catalog-filter";

export type ConnectFailure = { hostId: string; message: string };

type Session = Pick<TerminalSession, "sessionId" | "hostId" | "phase">;

/**
 * A server's state from its terminal and SFTP sessions, the healthiest first: any ready one is Connected; a connecting
 * one waiting for a trust decision is Awaiting trust (as on its tab); a failed one is Connection error.
 */
export function connection(
  sessions: readonly Session[],
  hostId: string,
  awaiting: (session: Session) => boolean = () => false,
): ConnectionState | undefined {
  const own = sessions.filter((session) => session.hostId === hostId);
  if (own.some((session) => session.phase === "ready")) return "connected";
  const connecting = own.filter((session) => session.phase === "connecting");
  if (connecting.length) return connecting.some(awaiting) ? "awaiting-trust" : "connecting";
  if (own.some((session) => session.phase === "failed")) return "error";
}

/**
 * Servers (SST-040/10): a column table sorted by name, one tab stop (arrows, Home and End move between rows), Connect
 * and a ⋯ menu per row. Activating a row opens the host drawer, which holds what the former detail panel showed.
 */
export function HostsPage({
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
  /** Search and tag filter, shown first among the header actions. */
  toolbar?: ReactNode;
  state: CatalogState;
  /** Already filtered and ordered. */
  hosts: CatalogHost[];
  scope: CatalogScope;
  filtering: boolean;
  selectedId?: string;
  /** This window's terminal and SFTP sessions. */
  sessions: readonly Session[];
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
  const identities = useMemo(
    () => new Map(state.identities.map((row) => [row.id, row])),
    [state.identities],
  );
  const body = useRef<HTMLTableSectionElement>(null);
  const awaiting = useAwaitingTrust();
  // As the removed global status bar counted them: ready terminals and ready SFTP sessions.
  const connected = sessions.filter((session) => session.phase === "ready").length;
  const group = scope.kind === "group" ? groups.get(scope.groupId) : undefined;
  const current = (hosts.find((host) => host.id === selectedId) ?? hosts[0])?.id;
  const scopeLabel =
    scope.kind === "all" ? "All servers" : scope.kind === "ungrouped" ? "Ungrouped" : (group?.label ?? "Group");
  const empty = state.hosts.length === 0 && state.groups.length === 0 && !filtering;
  const failed = connectFailure && state.hosts.find((host) => host.id === connectFailure.hostId);
  const open = (id: string) => {
    onSelect(id);
    onEditHost(id);
  };
  const count = (n: number) => `${n} ${n === 1 ? "server" : "servers"}`;
  return (
    <div className="catalog-page" data-testid="hosts-page">
      <PageHeader
        title="Servers"
        subtitle={
          <>
            <span data-testid="hosts-scope" className="[overflow-wrap:anywhere]">{scopeLabel}</span> · {count(hosts.length)}
          </>
        }
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
      {failed ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle className="[overflow-wrap:anywhere]">Could not connect to {failed.label}</AlertTitle>
          <AlertDescription>{connectFailure.message}</AlertDescription>
        </Alert>
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
        <div className="servers-frame">
          <table className="servers-table" aria-label={`${scopeLabel} servers`}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="servers-address">Address</th>
                <th scope="col" className="servers-identity">Identity</th>
                <th scope="col" className="servers-env">Environment</th>
                <th scope="col" className="servers-status">Status</th>
                <th scope="col" className="servers-actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody
              ref={body}
              onKeyDown={(event) => {
                const buttons = [...(body.current?.querySelectorAll<HTMLButtonElement>("button[data-host-id]") ?? [])];
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
                const isCurrent = host.id === current;
                // One tab stop for the table: only the current row's controls are in the tab order.
                const tab = isCurrent ? 0 : -1;
                const address = hostTarget(host, identities);
                const identity = identityText(host.effective, identities);
                const canConnect = host.effective.authSelection === "identity";
                const reason = `${host.id}-connect-reason`;
                const path = host.ancestry.map((row) => row.label).join(" / ");
                return (
                  <tr
                    key={host.id}
                    data-current={isCurrent || undefined}
                    onClick={(event) => {
                      // The row's own buttons (and the ⋯ menu, portalled but bubbling through React) act for themselves.
                      if (
                        event.detail > 1 ||
                        !event.currentTarget.contains(event.target as Node) ||
                        (event.target as Element).closest("button")
                      )
                        return;
                      open(host.id);
                    }}
                  >
                    <td>
                      <span className="flex min-w-0 items-center gap-2">
                        <ServerIcon aria-hidden="true" className="servers-row-icon size-4 shrink-0 text-muted-foreground" />
                        <button
                          type="button"
                          className="servers-name"
                          data-host-id={host.id}
                          tabIndex={tab}
                          aria-current={isCurrent ? "true" : undefined}
                          title={path ? `${host.label} — ${path}` : host.label}
                          onClick={(event) => {
                            if (event.detail <= 1) open(host.id);
                          }}
                        >
                          {host.label}
                        </button>
                      </span>
                    </td>
                    <td>
                      <span className="host-target block truncate" title={address}>
                        {address}
                      </span>
                    </td>
                    <td>
                      <span className="block truncate" title={identity}>
                        {identity}
                      </span>
                    </td>
                    <td>
                      <EnvironmentBadge environment={host.environment} />
                    </td>
                    <td>
                      <ConnectionStatus
                        state={
                          connection(sessions, host.id, awaiting) ??
                          (connectFailure?.hostId === host.id ? "error" : "disconnected")
                        }
                      />
                    </td>
                    <td>
                      <span className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          tabIndex={tab}
                          aria-label={`Connect ${host.label}`}
                          aria-disabled={canConnect ? undefined : true}
                          aria-describedby={canConnect ? undefined : reason}
                          title={canConnect ? undefined : "Choose an identity to connect."}
                          className="aria-disabled:opacity-50"
                          onClick={(event) => {
                            onSelect(host.id);
                            if (canConnect && event.detail <= 1) onConnect(host);
                          }}
                        >
                          <TerminalIcon data-icon="inline-start" />
                          <span className="servers-action-text">Connect</span>
                        </Button>
                        {canConnect ? null : (
                          <span id={reason} className="sr-only">
                            Choose an identity to connect.
                          </span>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={<Button size="icon-sm" variant="ghost" tabIndex={tab} />}
                            aria-label={`Actions for ${host.label}`}
                            // The row becomes current, so arrows and Tab go on from it once the menu closes.
                            onClick={() => onSelect(host.id)}
                          >
                            <EllipsisIcon aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-40">
                            <DropdownMenuItem onClick={() => open(host.id)}>
                              <PencilIcon /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!canConnect}
                              aria-describedby={canConnect ? undefined : reason}
                              title={canConnect ? undefined : "Choose an identity to connect."}
                              onClick={() => onOpenSftp(host)}
                            >
                              <FolderOpenIcon /> Open files
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => {
                                onSelect(host.id);
                                onDeleteHost(host.id);
                              }}
                            >
                              <Trash2Icon /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {/* What the removed global status bar said about this workspace (SST-040 decision 2). */}
      <p className="servers-footer" data-testid="servers-summary" data-connected={connected > 0 || undefined}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="servers-dot" aria-hidden="true" />
          Local workspace
        </span>
        <span className="ml-auto">{count(state.hosts.length)}</span>
        <span className="servers-connected">{connected} connected</span>
      </p>
    </div>
  );
}
