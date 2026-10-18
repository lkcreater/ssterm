import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CircleIcon,
  FolderOpenIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LayersIcon,
  LockKeyholeIcon,
  PanelLeftIcon,
  PanelsTopLeftIcon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  WorkflowIcon,
} from "lucide-react";
import { usePanelRef } from "react-resizable-panels";
import type { CatalogHost, ErrorCode, StorageProblem, TerminalPhase } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ConnectionStatus,
  type ConnectionState,
} from "@/components/connection/connection-status";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
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
import { useSftp } from "@/hooks/use-sftp";
import { FilesWorkspace } from "@/components/sftp/files-workspace";
import { useSettings } from "@/hooks/use-settings";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { SessionTabs } from "@/components/workspace/session-tabs";
import { ShortcutsDialog } from "@/components/workspace/shortcuts-dialog";
import {
  TerminalWorkspace,
  useWorkspace,
  type WorkspaceCommand,
} from "@/components/workspace/terminal-workspace";
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
import { IdentitiesPage } from "@/components/identities/identities-page";
import { SnippetsPage } from "@/components/snippets/snippets-page";
import { TunnelsPage } from "@/components/tunnels/tunnels-page";
import { useTunnels } from "@/hooks/use-tunnels";
import {
  DeleteGroupDialog,
  DeleteHostDialog,
} from "@/components/catalog/delete-dialogs";
import {
  filterCatalogHosts,
  groupTree,
  type CatalogScope,
} from "@/lib/catalog-filter";
import { endpointText } from "@/lib/catalog-filter";
import iconLogo from "@/assets/icon-logo.png";


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

type Page = "hosts" | "terminals" | "files" | "known-hosts" | "identities" | "snippets" | "tunnels";
type CatalogDialog =
  | { kind: "host"; id?: string; groupId?: string | null }
  | { kind: "group"; id?: string; parentId?: string | null }
  | { kind: "delete-host"; id: string }
  | { kind: "delete-group"; id: string };
const titles: Record<Page, string> = {
  hosts: "Servers",
  terminals: "Terminals",
  files: "Files",
  "known-hosts": "Known hosts",
  identities: "Identities",
  snippets: "Snippets",
  tunnels: "Port forwarding",
};
const phaseStates = {
  connecting: "connecting",
  ready: "connected",
  closed: "disconnected",
  failed: "error",
} as const satisfies Record<TerminalPhase, ConnectionState>;
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
  const [overlay, setOverlay] = useState<"settings" | "shortcuts">();
  const [workspaceToolsOpen, setWorkspaceToolsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarPanel = usePanelRef();
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const owner = desktop.status === "ready" ? desktop.data.owner : undefined;
  const trust = useKnownHosts(owner);
  const credentials = useCredentials(owner);
  const catalog = useCatalog(owner);
  const sessions = useTerminals(owner).state?.sessions ?? [];
  const controller = useWorkspace(owner, sessions);
  const sftp = useSftp(owner);
  const settings = useSettings(owner);
  const tunnelState = useTunnels(owner);
  const connected = [...sessions, ...sftp.sessions].filter((session) => session.phase === "ready").length;
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

  async function connect(host: CatalogHost) {
    const bridge = window.ssterm;
    if (!owner || !bridge) return;
    setConnectFailure(undefined);
    // Switch first: the new pane renders in a visible workspace while it connects.
    setPage("terminals");
    let code: ErrorCode = "unavailable";
    try {
      const result = await bridge.connectHost({ owner, hostId: host.id });
      if (result.ok) return controller.reveal(result.value.sessionId);
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

  /** One remote browser per window: another host replaces the current one (browse-only, no prompt). */
  const openSftp = (hostId: string) => {
    setPage("files");
    void sftp.open(hostId);
  };

  /** No animation: the panel snaps, so focus can move before it is hidden. */
  const toggleSidebar = () => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    if (panel.isCollapsed()) return panel.expand();
    if (document.getElementById("app-sidebar")?.contains(document.activeElement))
      sidebarToggle.current?.focus();
    panel.collapse();
  };
  const onCommand = (command: WorkspaceCommand) => {
    if (command === "toggle-sidebar") toggleSidebar();
    else setOverlay(command);
  };
  const showTerminals = () => setPage("terminals");
  const active = controller.activeSession;
  const terminalsShown = page === "terminals" && !!owner && sessions.length > 0;
  const filesShown = page === "files" && !!owner;
  const snippetsShown = page === "snippets" && !!owner && !!state && ready;
  const remote = sftp.session;
  const statusSession = terminalsShown ? active : filesShown ? remote : undefined;
  const statusTarget = statusSession?.target;

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
      <header className="app-titlebar">
        {/* The macOS traffic lights sit here; nothing interactive may overlap them. */}
        <div className="titlebar-safe-area" aria-hidden="true" />
        <Button
          ref={sidebarToggle}
          size="icon-sm"
          variant="ghost"
          aria-label="Sidebar"
          aria-expanded={sidebarOpen}
          aria-controls="app-sidebar"
          title="Show or hide the sidebar (⌃⌘S)"
          onClick={toggleSidebar}
        >
          <PanelLeftIcon aria-hidden="true" />
        </Button>
        <div className="titlebar-tabs">
          {controller.workspace.tabs.length > 0 ? (
            <SessionTabs controller={controller} onSelect={showTerminals} />
          ) : (
            <span className="titlebar-title">ssterm</span>
          )}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Workspace tools"
          title="Workspace templates and multi-target input"
          disabled={!owner || !ready}
          onClick={() => { setPage("terminals"); setWorkspaceToolsOpen(true); }}
        >
          <PanelsTopLeftIcon aria-hidden="true" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Settings"
          title="Settings (⌘,)"
          disabled={!owner}
          onClick={() => setOverlay("settings")}
        >
          <Settings2Icon aria-hidden="true" />
        </Button>
      </header>
      <SidebarProvider className="app-layout min-h-0">
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel
            panelRef={sidebarPanel}
            collapsible
            collapsedSize={0}
            minSize={200}
            maxSize={400}
            defaultSize={240}
            groupResizeBehavior="preserve-pixel-size"
            inert={!sidebarOpen}
            style={{ overflow: "hidden" }}
            onResize={(size) => setSidebarOpen(size.inPixels > 0)}
          >
            <Sidebar id="app-sidebar" collapsible="none" className="app-sidebar w-full">
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
                          isActive={page === "files"}
                          aria-current={page === "files" ? "page" : undefined}
                          onClick={() => setPage("files")}
                          disabled={!owner}
                        >
                          <FolderOpenIcon />
                          <span>Files</span>
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
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={page === "identities"}
                          aria-current={page === "identities" ? "page" : undefined}
                          onClick={() => setPage("identities")}
                          disabled={!ready}
                        >
                          <KeyRoundIcon />
                          <span>Identities</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={page === "snippets"}
                          aria-current={page === "snippets" ? "page" : undefined}
                          onClick={() => setPage("snippets")}
                          disabled={!ready}
                        >
                          <LayersIcon />
                          <span>Snippets</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          isActive={page === "tunnels"}
                          aria-current={page === "tunnels" ? "page" : undefined}
                          onClick={() => setPage("tunnels")}
                          disabled={!ready}
                        >
                          <WorkflowIcon />
                          <span>Port forwarding</span>
                          {tunnelState?.tunnels.some((row) => row.phase === "running") ? (
                            <span className="ml-auto type-caption">
                              {tunnelState.tunnels.filter((row) => row.phase === "running").length}
                            </span>
                          ) : null}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </SidebarContent>
              <SidebarFooter className="gap-2 p-2">
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton disabled={!owner} onClick={() => setOverlay("settings")}>
                      <Settings2Icon />
                      <span>Settings</span>
                      <span className="ml-auto type-caption text-muted-foreground">⌘,</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton disabled={!owner} onClick={() => setOverlay("shortcuts")}>
                      <KeyboardIcon />
                      <span>Keyboard shortcuts</span>
                      <span className="ml-auto type-caption text-muted-foreground">⌘/</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
                <Separator />
                <div className="flex items-center gap-2 px-2 type-caption text-muted-foreground">
                  <LockKeyholeIcon className="size-4" aria-hidden="true" />
                  <span>On this Mac</span>
                </div>
              </SidebarFooter>
            </Sidebar>
          </ResizablePanel>
          <ResizableHandle aria-label="Resize sidebar" />
          <ResizablePanel style={{ overflow: "hidden" }}>
            <main className="app-workspace">
              <h1 className="sr-only">{titles[page]}</h1>
              {owner ? (
                <TerminalWorkspace
                  owner={owner}
                  controller={controller}
                  settings={settings.settings}
                  hidden={page !== "terminals"}
                  onShowTerminals={showTerminals}
                  onCommand={onCommand}
                  onOpenSftp={openSftp}
                  catalog={ready ? state : undefined}
                  toolsOpen={workspaceToolsOpen}
                  onCloseTools={() => setWorkspaceToolsOpen(false)}
                />
              ) : null}
              {owner ? (
                <FilesWorkspace owner={owner} sftp={sftp} catalog={state} hidden={!filesShown} />
              ) : null}
              {owner && state && ready ? (
                // Kept mounted so an unsaved draft survives switching pages; a lock still drops it.
                <div
                  className="workspace-page"
                  inert={!snippetsShown}
                  style={{ display: snippetsShown ? undefined : "none" }}
                >
                  <SnippetsPage owner={owner} catalog={catalog} state={state} />
                </div>
              ) : null}
              {terminalsShown || filesShown || snippetsShown ? null : (
                <div className="workspace-page">
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
                  ) : page === "identities" && owner && state && ready ? (
                    <IdentitiesPage owner={owner} catalog={catalog} state={state} />
                  ) : page === "tunnels" && owner && state && ready ? (
                    <TunnelsPage owner={owner} catalog={catalog} state={state} tunnels={tunnelState} />
                  ) : page !== "identities" && page !== "snippets" && page !== "tunnels" && state && ready ? (
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
                      onOpenSftp={(host) => openSftp(host.id)}
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
                </div>
              )}
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>
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
      <SettingsDialog
        open={overlay === "settings"}
        onOpenChange={(open) => setOverlay(open ? "settings" : undefined)}
        settings={settings}
        terminals={sessions.length}
        owner={owner}
      />
      <ShortcutsDialog
        open={overlay === "shortcuts"}
        onOpenChange={(open) => setOverlay(open ? "shortcuts" : undefined)}
      />
      <HostTrustDialogs state={trust.state} />
      <CredentialPrompts state={trust.state?.prompts.length ? undefined : credentials.state} />
      <footer className="app-statusbar">
        {statusSession ? (
          <div
            role="group"
            aria-label={terminalsShown ? "Active pane" : "Remote files"}
            className="statusbar-target"
          >
            <ConnectionStatus state={phaseStates[statusSession.phase]} />
            <span className="statusbar-label truncate" title={statusTarget?.label}>
              {statusTarget?.label ?? "Unknown target"}
            </span>
            {statusTarget?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
            {statusTarget ? (
              <span className="host-target truncate">
                {endpointText(statusTarget.endpointHost, statusTarget.endpointPort, statusTarget.username)}
              </span>
            ) : null}
          </div>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <CircleIcon className="size-3" aria-hidden="true" />
          {connected === 0
            ? "No connections"
            : `${connected} ${connected === 1 ? "connection" : "connections"}`}
        </span>
        <span className="shrink-0">
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
