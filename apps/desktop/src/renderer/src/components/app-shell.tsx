import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CircleIcon,
  KeyRoundIcon,
  LayersIcon,
  LockKeyholeIcon,
  ServerIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  TerminalIcon,
  WorkflowIcon,
} from "lucide-react";
import type { CatalogHost, ErrorCode, StorageProblem } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useDesktopState } from "@/hooks/use-desktop-state";
import { useCredentials } from "@/hooks/use-credentials";
import { CredentialPrompts } from "@/components/auth/credential-prompts";
import { useKnownHosts } from "@/hooks/use-known-hosts";
import { useTerminals } from "@/hooks/use-terminals";
import { TerminalWorkspace } from "@/components/workspace/live-terminal";
import {
  KnownHostsWorkspace,
  HostTrustDialogs,
} from "@/components/trust/known-hosts";
import { useCatalog } from "@/hooks/use-catalog";
import {
  CatalogLibrary,
  CatalogSearch,
} from "@/components/catalog/catalog-sidebar";
import {
  HostsPage,
  type ConnectFailure,
} from "@/components/catalog/hosts-page";
import { GroupEditor, HostEditor } from "@/components/catalog/editors";
import {
  DeleteGroupDialog,
  DeleteHostDialog,
} from "@/components/catalog/delete-dialogs";
import {
  filterCatalogHosts,
  groupTree,
  type CatalogScope,
} from "@/lib/catalog-filter";
import iconLogo from "@/assets/icon-logo.png";

const unavailable = [
  { label: "Identities", icon: KeyRoundIcon },
  { label: "Snippets", icon: LayersIcon },
  { label: "Port forwarding", icon: WorkflowIcon },
] as const;

const storageProblems: Record<
  StorageProblem,
  { title: string; description: string }
> = {
  corrupt: {
    title: "Workspace storage needs recovery",
    description:
      "Keep the original workspace files. Use a verified recovery copy or backup before reopening this workspace.",
  },
  "foreign-database": {
    title: "Workspace storage is not recognized",
    description:
      "Keep the original files and restore a verified ssterm workspace copy before trying again.",
  },
  "unsupported-schema": {
    title: "A newer ssterm version is required",
    description:
      "Open this workspace with a compatible newer version of ssterm. Keep the original files intact.",
  },
  "unsupported-protection": {
    title: "Workspace protection is not supported",
    description:
      "Use a ssterm version that supports this workspace's protection format. Keep the original files intact.",
  },
  "recovery-required": {
    title: "Workspace recovery is pending",
    description:
      "Pending credential changes need reconciliation before this workspace can open. Keep the original files and use a compatible recovery version.",
  },
  unwritable: {
    title: "Workspace storage needs private access",
    description:
      "Check disk space, your account's access and private permissions for the workspace folder and files, then reopen ssterm.",
  },
  "migration-failed": {
    title: "Workspace upgrade could not finish",
    description:
      "Keep the original files and the pre-upgrade backup. Use a verified recovery copy with a compatible version of ssterm.",
  },
  busy: {
    title: "Workspace storage is in use",
    description:
      "Close other ssterm instances using this workspace, then close and reopen this window.",
  },
  unavailable: {
    title: "Workspace storage is unavailable",
    description:
      "Close and reopen ssterm to try again. If the problem continues, keep the original files and use a verified backup or recovery copy.",
  },
};

type Page = "hosts" | "terminals" | "known-hosts";
type CatalogDialog =
  | { kind: "host"; id?: string; groupId?: string | null }
  | { kind: "group"; id?: string; parentId?: string | null }
  | { kind: "delete-host"; id: string }
  | { kind: "delete-group"; id: string };
const titles: Record<Page, string> = {
  hosts: "Servers",
  terminals: "Terminals",
  "known-hosts": "Known hosts",
};
const connectMessages: Partial<Record<ErrorCode, string>> = {
  busy: "Too many sessions open; close ended panes.",
  unavailable:
    "Connections are unavailable while the workspace is locked or closed. Unlock it and try again.",
  "invalid-request": "This server can no longer be connected. Review its settings.",
  "stale-owner": "This window changed. Try again.",
};

const hostsHeading = () =>
  document.querySelector<HTMLElement>('[data-testid="hosts-page"] h2');
/** After a create, the opener may be an empty state's Add button that is about to unmount; land on the page heading instead of the body. */
// A task, not a frame: it must run after the dialog's own focus return, and frames stall in a background window.
const focusHeading = () => setTimeout(() => hostsHeading()?.focus());

export function AppShell() {
  const desktop = useDesktopState();
  const [page, setPage] = useState<Page>("hosts");
  const [scope, setScope] = useState<CatalogScope>({ kind: "all" });
  const [search, setSearch] = useState("");
  // Typing stays responsive while a large catalog re-filters.
  const deferredSearch = useDeferredValue(search);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<CatalogDialog>();
  const [connectFailure, setConnectFailure] = useState<ConnectFailure>();
  const [focusSession, setFocusSession] = useState<string>();
  const scrolled = useRef<string>(undefined);
  const owner = desktop.status === "ready" ? desktop.data.owner : undefined;
  const trust = useKnownHosts(owner);
  const credentials = useCredentials(owner);
  const catalog = useCatalog(owner);
  const sessions = useTerminals(owner).state?.sessions ?? [];
  const connected = sessions.filter((session) => session.phase === "ready").length;
  const storage = desktop.status === "ready" ? desktop.data.storage : undefined;
  const problem =
    storage?.status === "blocked" ? storageProblems[storage.code] : undefined;
  const state = catalog.state;
  const ready = storage?.status === "ready" && state?.availability === "ready";

  // A deleted group or tag silently drops out of the filter instead of failing it.
  const view = useMemo(() => {
    const activeScope: CatalogScope =
      scope.kind === "group" &&
      !state?.groups.some((group) => group.id === scope.groupId)
        ? { kind: "all" }
        : scope;
    const activeTags = tagIds.filter((id) =>
      state?.tags.some((tag) => tag.id === id),
    );
    return {
      scope: activeScope,
      tagIds: activeTags,
      filtering: deferredSearch.trim() !== "" || activeTags.length > 0,
      hosts: state
        ? filterCatalogHosts(state, { scope: activeScope, search: deferredSearch, tagIds: activeTags })
        : [],
    };
  }, [state, scope, deferredSearch, tagIds]);
  const tree = useMemo(() => groupTree(state?.groups ?? []), [state?.groups]);

  // Reveal a selected group (e.g. one just created inside a collapsed parent).
  const scopeGroupId = view.scope.kind === "group" ? view.scope.groupId : undefined;
  useEffect(() => {
    if (!scopeGroupId || !state) return;
    const parents = new Map(state.groups.map((group) => [group.id, group.parentId]));
    const ancestors: string[] = [];
    for (let id = parents.get(scopeGroupId); id; id = parents.get(id)) ancestors.push(id);
    if (ancestors.length)
      setExpanded((current) =>
        ancestors.every((id) => current.has(id)) ? current : new Set([...current, ...ancestors]),
      );
    // Only when the selected group changes; later collapses are the user's choice.
  }, [scopeGroupId]);

  // Any newly opened session (Connect, or one present when the window loads) shows the terminals view.
  const seen = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const fresh = sessions.some((session) => !seen.current.has(session.sessionId));
    seen.current = new Set(sessions.map((session) => session.sessionId));
    if (fresh) setPage("terminals");
  }, [sessions]);

  // Scroll the new pane into view once, then focus it on Ready unless focus has moved elsewhere.
  useEffect(() => {
    if (!focusSession) return;
    const session = sessions.find((row) => row.sessionId === focusSession);
    if (!session) return;
    const pane = document.querySelector<HTMLElement>(
      `.terminal-workspace section[data-session-id="${CSS.escape(focusSession)}"]`,
    );
    if (scrolled.current !== focusSession) {
      scrolled.current = focusSession;
      pane?.scrollIntoView({ block: "nearest" });
    }
    const { phase } = session;
    if (phase === "connecting") return;
    setFocusSession(undefined);
    const active = document.activeElement;
    if (
      phase === "ready" &&
      page === "terminals" &&
      (!active || active === document.body || pane?.contains(active))
    )
      pane?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
  }, [sessions, page, focusSession]);

  async function connect(host: CatalogHost) {
    const bridge = window.ssterm;
    if (!owner || !bridge) return;
    setConnectFailure(undefined);
    setFocusSession(undefined);
    // Switch first: the new pane renders in a visible workspace while it connects.
    setPage("terminals");
    let code: ErrorCode = "unavailable";
    try {
      const result = await bridge.connectHost({ owner, hostId: host.id });
      if (result.ok) return setFocusSession(result.value.sessionId);
      code = result.error.code;
    } catch {
      // Reported as unavailable below.
    }
    setPage("hosts");
    setSelectedId(host.id);
    setConnectFailure({
      hostId: host.id,
      message: connectMessages[code] ?? "The connection could not start. Try again.",
    });
  }

  const showHosts = (next?: CatalogScope) => {
    setPage("hosts");
    if (next) setScope(next);
  };
  const groupScope = view.scope.kind === "group" ? view.scope.groupId : null;
  const closeDialog = () => setDialog(undefined);
  const deletingGroup =
    dialog?.kind === "delete-group"
      ? state?.groups.find((group) => group.id === dialog.id)
      : undefined;
  const deletingHost =
    dialog?.kind === "delete-host"
      ? state?.hosts.find((host) => host.id === dialog.id)
      : undefined;

  return (
    <div
      className="app-shell"
      data-window-focused={
        desktop.status === "ready" ? desktop.data.window.focused : undefined
      }
    >
      <header className="app-toolbar">
        <img src={iconLogo} alt="" className="size-8" />
        <span className="type-label">ssterm</span>
        <Separator orientation="vertical" className="mx-1 h-4 self-center" />
        <span className="type-caption text-muted-foreground">
          Local workspace
        </span>
        <Badge variant="outline" className="ml-auto">
          <LockKeyholeIcon data-icon="inline-start" /> No account needed
        </Badge>
      </header>
      <SidebarProvider
        className="app-layout min-h-0"
        style={{ "--sidebar-width": "240px" } as React.CSSProperties}
      >
        <Sidebar collapsible="none" className="app-sidebar">
          <SidebarHeader className="gap-3 p-4">
            <CatalogSearch
              state={state}
              disabled={!ready}
              search={search}
              tagIds={view.tagIds}
              resultCount={view.filtering ? view.hosts.length : undefined}
              onSearch={(value) => {
                setSearch(value);
                setPage("hosts");
              }}
              onSubmit={() => {
                // The deferred view may still lag the typed search.
                const first = state
                  ? filterCatalogHosts(state, { scope: view.scope, search, tagIds: view.tagIds })[0]
                  : undefined;
                setPage("hosts");
                if (!first) return;
                setSelectedId(first.id);
                requestAnimationFrame(() =>
                  document
                    .querySelector<HTMLElement>(`[data-host-id="${first.id}"]`)
                    ?.focus(),
                );
              }}
              onTags={(ids) => {
                setTagIds(ids);
                setPage("hosts");
              }}
              onAdd={(kind) =>
                setDialog(
                  kind === "host"
                    ? { kind: "host", groupId: groupScope }
                    : { kind: "group", parentId: groupScope },
                )
              }
            />
          </SidebarHeader>
          <SidebarContent>
            <CatalogLibrary
              state={state}
              tree={tree}
              current={page === "hosts" ? view.scope : undefined}
              expanded={expanded}
              onScope={showHosts}
              onToggle={(id, open) =>
                setExpanded((current) => {
                  const next = new Set(current);
                  if (open) next.add(id);
                  else next.delete(id);
                  return next;
                })
              }
            />
            <SidebarGroup>
              <SidebarGroupLabel>Workspace tools</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={page === "terminals"}
                      aria-current={page === "terminals" ? "page" : undefined}
                      onClick={() => setPage("terminals")}
                    >
                      <SquareTerminalIcon />
                      <span>Terminals</span>
                      <span className="ml-auto type-caption">{sessions.length}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      isActive={page === "known-hosts"}
                      aria-current={page === "known-hosts" ? "page" : undefined}
                      onClick={() => setPage("known-hosts")}
                      disabled={storage?.status !== "ready"}
                    >
                      <ShieldCheckIcon />
                      <span>Known hosts</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {unavailable.map(({ label, icon: Icon }) => (
                    <SidebarMenuItem key={label}>
                      <SidebarMenuButton disabled>
                        <Icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="gap-3 p-4">
            <Separator />
            <div className="flex items-center gap-2 type-caption text-muted-foreground">
              <LockKeyholeIcon className="size-4" aria-hidden="true" />
              <span>On this Mac</span>
            </div>
          </SidebarFooter>
        </Sidebar>
        <main className="app-workspace">
          <div className="workspace-toolbar">
            <div className="flex items-center gap-2">
              <TerminalIcon
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <h1 className="type-label">{titles[page]}</h1>
            </div>
            <span className="type-caption text-muted-foreground">
              {sessions.length === 0
                ? "No active sessions"
                : `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}
            </span>
          </div>
          {owner && sessions.length > 0 ? (
            <TerminalWorkspace
              owner={owner}
              sessions={sessions}
              hidden={page !== "terminals"}
            />
          ) : null}
          {page === "known-hosts" ? (
            <KnownHostsWorkspace
              key={
                owner ? `${owner.windowId}:${owner.generation}` : "unavailable"
              }
              owner={owner}
              state={trust.state}
              error={trust.error}
            />
          ) : page === "terminals" ? (
            sessions.length > 0 ? null : (
              <div className="workspace-empty">
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No open terminals</EmptyTitle>
                    <EmptyDescription>
                      Connect to a saved server to open a terminal here.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button variant="outline" onClick={() => showHosts()}>
                      <ServerIcon data-icon="inline-start" /> Show servers
                    </Button>
                  </EmptyContent>
                </Empty>
              </div>
            )
          ) : state && ready ? (
            <HostsPage
              catalog={catalog}
              state={state}
              hosts={view.hosts}
              scope={view.scope}
              filtering={view.filtering}
              selectedId={selectedId}
              sessions={sessions}
              connectFailure={connectFailure}
              onSelect={setSelectedId}
              onAddHost={() => setDialog({ kind: "host", groupId: groupScope })}
              onAddGroup={() => setDialog({ kind: "group", parentId: groupScope })}
              onEditHost={(id) => setDialog({ kind: "host", id })}
              onEditGroup={(id) => setDialog({ kind: "group", id })}
              onDeleteHost={(id) => setDialog({ kind: "delete-host", id })}
              onDeleteGroup={(id) => setDialog({ kind: "delete-group", id })}
              onConnect={(host) => void connect(host)}
              onClearFilters={() => {
                setSearch("");
                setTagIds([]);
              }}
            />
          ) : (
            <div className="workspace-empty">
              <Empty>
                <EmptyHeader>
                  <img
                    src={iconLogo}
                    alt="ssterm monogram"
                    className="empty-mark"
                  />
                  <EmptyTitle>
                    {problem ||
                    desktop.status === "unavailable" ||
                    catalog.error ||
                    state?.availability === "unavailable"
                      ? "Workspace is unavailable"
                      : "Opening workspace"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {problem || desktop.status === "unavailable"
                      ? "Your workspace must open successfully before saved servers can be shown."
                      : catalog.error || state?.availability === "unavailable"
                        ? "Saved servers cannot be read right now. Close and reopen ssterm to try again."
                        : "Loading saved servers."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            </div>
          )}
          {problem ? (
            <div className="px-5 pb-4">
              <Alert>
                <AlertCircleIcon aria-hidden="true" />
                <AlertTitle>{problem.title}</AlertTitle>
                <AlertDescription>{problem.description}</AlertDescription>
              </Alert>
            </div>
          ) : null}
          {desktop.status === "unavailable" ? (
            <div className="px-5 pb-4">
              <Alert>
                <CircleIcon aria-hidden="true" />
                <AlertTitle>Workspace information is unavailable</AlertTitle>
                <AlertDescription>
                  Close this window and reopen ssterm to try again.
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
        </main>
      </SidebarProvider>
      {state && dialog?.kind === "host" ? (
        <HostEditor
          catalog={catalog}
          state={state}
          hostId={dialog.id}
          groupId={dialog.groupId}
          onClose={closeDialog}
          onSaved={(id) => {
            closeDialog();
            if (!id) return;
            focusHeading();
            setSearch("");
            setTagIds([]);
            setSelectedId(id);
            setPage("hosts");
          }}
        />
      ) : null}
      {state && dialog?.kind === "group" ? (
        <GroupEditor
          catalog={catalog}
          state={state}
          groupId={dialog.id}
          parentId={dialog.parentId}
          onClose={closeDialog}
          onSaved={(id) => {
            closeDialog();
            if (!id) return;
            showHosts({ kind: "group", groupId: id });
            focusHeading();
          }}
        />
      ) : null}
      {deletingHost ? (
        <DeleteHostDialog
          catalog={catalog}
          host={deletingHost}
          onClose={closeDialog}
          onDeleted={closeDialog}
          afterDelete={() =>
            document.querySelector<HTMLElement>(
              `[data-testid="hosts-page"] button[data-host-id]:not([data-host-id="${CSS.escape(deletingHost.id)}"])`,
            ) ?? hostsHeading()
          }
        />
      ) : null}
      {deletingGroup ? (
        <DeleteGroupDialog
          catalog={catalog}
          group={deletingGroup}
          parent={state?.groups.find((group) => group.id === deletingGroup.parentId)}
          onClose={closeDialog}
          onDeleted={() => {
            closeDialog();
            setScope(
              deletingGroup.parentId
                ? { kind: "group", groupId: deletingGroup.parentId }
                : { kind: "all" },
            );
          }}
          afterDelete={hostsHeading}
        />
      ) : null}
      <HostTrustDialogs state={trust.state} />
      <CredentialPrompts state={trust.state?.prompts.length ? undefined : credentials.state} />
      <footer className="app-statusbar">
        <CircleIcon className="size-3" aria-hidden="true" />
        <span>
          {connected === 0
            ? "No connections"
            : `${connected} ${connected === 1 ? "connection" : "connections"}`}
        </span>
        <span className="ml-auto">
          {desktop.status === "loading" ? (
            <span className="flex items-center gap-2">
              <Spinner aria-label="Loading workspace information" /> Opening
              workspace
            </span>
          ) : desktop.status === "ready" ? (
            `ssterm ${desktop.data.app.version} · ${problem ? "Storage unavailable" : "Local workspace"}`
          ) : (
            "Local workspace"
          )}
        </span>
      </footer>
    </div>
  );
}
