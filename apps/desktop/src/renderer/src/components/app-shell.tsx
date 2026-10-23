import { useContext, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  CircleIcon,
  Columns2Icon,
  FileClockIcon,
  FolderOpenIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LayersIcon,
  LockKeyholeIcon,
  PanelLeftIcon,
  PanelsTopLeftIcon,
  PlusIcon,
  Rows2Icon,
  ServerIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  UsersIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { usePanelRef } from "react-resizable-panels";
import { liveWorkCount, type CatalogHost, type ErrorCode, type LiveWork, type StorageProblem } from "@ssterm/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { useDesktopState } from "@/hooks/use-desktop-state";
import { AppLockEnabled } from "@/components/app-lock/app-lock-gate";
import { LockWorkspaceDrawer } from "@/components/app-lock/lock-workspace-drawer";
import { useCredentials } from "@/hooks/use-credentials";
import { CredentialPrompts } from "@/components/auth/credential-prompts";
import { AwaitingTrust } from "@/components/connection/connection-status";
import { useKnownHosts } from "@/hooks/use-known-hosts";
import { useTerminals } from "@/hooks/use-terminals";
import { useSftp } from "@/hooks/use-sftp";
import { FilesWorkspace } from "@/components/sftp/files-workspace";
import { useSettings } from "@/hooks/use-settings";
import { SettingsDrawer, type SettingsTab } from "@/components/settings/settings-dialog";
import { SessionTabs } from "@/components/workspace/session-tabs";
import { ShortcutsDrawer } from "@/components/workspace/shortcuts-dialog";
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
  CatalogAddMenu,
  CatalogLibrary,
  CatalogSearch,
} from "@/components/catalog/catalog-sidebar";
import {
  HostsPage,
  connection,
  type ConnectFailure,
} from "@/components/catalog/hosts-page";
import { GroupEditor, HostEditor } from "@/components/catalog/editors";
import { IdentitiesPage } from "@/components/identities/identities-page";
import { SnippetsPage } from "@/components/snippets/snippets-page";
import { TunnelsPage } from "@/components/tunnels/tunnels-page";
import { RecordingsPage } from "@/components/recordings/recordings-page";
import { TeamWorkspace } from "@/components/team/team-workspace";
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
import iconLogo from "@/assets/icon-logo-v2.png";


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

type Page = "hosts" | "terminals" | "files" | "known-hosts" | "identities" | "snippets" | "tunnels" | "recordings" | "team";
type CatalogDialog =
  | { kind: "host"; id?: string; groupId?: string | null }
  | { kind: "group"; id?: string; parentId?: string | null }
  | { kind: "delete-host"; id: string }
  | { kind: "delete-group"; id: string };
// Sidebar order, as in the v2 concepts.
const pages: Page[] = ["hosts", "terminals", "files", "identities", "known-hosts", "snippets", "tunnels", "recordings", "team"];
const pageIcons: Record<Page, LucideIcon> = {
  hosts: ServerIcon,
  terminals: SquareTerminalIcon,
  files: FolderOpenIcon,
  identities: KeyRoundIcon,
  "known-hosts": ShieldCheckIcon,
  snippets: LayersIcon,
  tunnels: WorkflowIcon,
  recordings: FileClockIcon,
  team: UsersIcon,
};
const titles: Record<Page, string> = {
  hosts: "Servers",
  terminals: "Terminals",
  files: "Files",
  "known-hosts": "Known hosts",
  identities: "Identities",
  snippets: "Snippets",
  tunnels: "Port forwarding",
  recordings: "Recordings",
  team: "Team vault",
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
  // Each open gets its own drawer instance, so reopening during the previous one's exit motion is never closed by it.
  const [dialog, setDialogState] = useState<CatalogDialog & { key: number }>();
  const dialogKey = useRef(0);
  const setDialog = (next: CatalogDialog) => setDialogState({ ...next, key: ++dialogKey.current });
  const [connectFailure, setConnectFailure] = useState<ConnectFailure>();
  const [startingLocal, setStartingLocal] = useState(false);
  const localLaunch = useRef(false);
  const [overlay, setOverlay] = useState<"settings" | "shortcuts">();
  // Each open is a fresh drawer instance, even one requested while the last is still sliding out.
  const [shortcutsKey, setShortcutsKey] = useState(0);
  const openShortcuts = () => {
    setOverlay("shortcuts");
    setShortcutsKey((key) => key + 1);
  };
  const [settingsOpen, setSettingsOpen] = useState<{ key: number; tab?: SettingsTab }>({ key: 0 });
  const openSettings = (tab?: SettingsTab) => {
    // An open (or closing) Settings drawer is kept: a reopen must not drop a running sync action.
    if (overlay === "settings") return;
    setOverlay("settings");
    setSettingsOpen(({ key }) => ({ key: key + 1, tab }));
  };
  // The open Workspace tools drawer's key (0 = closed): each open is a fresh instance, even during the exit motion.
  const [workspaceTools, setWorkspaceTools] = useState(0);
  const toolsSerial = useRef(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarPanel = usePanelRef();
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  const owner = desktop.status === "ready" ? desktop.data.owner : undefined;
  const trust = useKnownHosts(owner);
  const credentials = useCredentials(owner);
  const catalog = useCatalog(owner);
  const sessions = useTerminals(owner).state?.sessions ?? [];
  const controller = useWorkspace(owner, sessions);
  const awaitingTrust = useMemo(() => new Set(trust.state?.prompts.map((prompt) => prompt.sessionId)), [trust.state]);
  const sftp = useSftp(owner);
  const settings = useSettings(owner);
  const tunnelState = useTunnels(owner);
  const lockEnabled = useContext(AppLockEnabled);
  // Lock workspace's confirmation (SST-040/13): keyed per open; `work` undefined when main could not say.
  const [lockConfirm, setLockConfirm] = useState<{ key: number; work: LiveWork | undefined }>();
  const lockKey = useRef(0);
  const lockAsking = useRef(false);
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

  /**
   * Asks main what the lock would close in every window: nothing → lock at once; otherwise (or when main cannot say)
   * confirm in a drawer first. Lock itself closes whatever is live then, including work started after the question.
   */
  async function requestLock() {
    const bridge = window.ssterm;
    if (!owner || !bridge || lockAsking.current || lockConfirm) return;
    lockAsking.current = true;
    try {
      const result = await bridge.liveWork({ owner }).catch(() => undefined);
      const work = result?.ok ? result.value : undefined;
      if (work && liveWorkCount(work) === 0) await lockWorkspace();
      else setLockConfirm({ key: ++lockKey.current, work });
    } finally {
      lockAsking.current = false;
    }
  }

  /** Main closes live work in every window and reloads them into the gate; this document goes with them. */
  async function lockWorkspace() {
    const bridge = window.ssterm;
    if (!owner || !bridge) return;
    const result = await bridge.lockNow({ owner }).catch(() => undefined);
    if (!result?.ok || result.value.status !== "locked")
      toast.add({ title: "Couldn't lock the workspace", type: "error", description: result?.ok && result.value.status === "busy"
        ? "A sign-in change is being saved. Try again in a moment." : "Try again." });
  }

  async function startLocal() {
    const bridge = window.ssterm;
    if (!owner || !bridge || localLaunch.current) return;
    localLaunch.current = true;
    setStartingLocal(true);
    setPage("terminals");
    try {
      const result = await bridge.startLocalTerminal({ owner });
      if (result.ok) controller.reveal(result.value.sessionId);
      else toast.add({ title: "Couldn't open a local terminal", description: result.error.code === "busy"
        ? "Close an ended pane and try again."
        : result.error.code === "stale-owner" ? "This window is out of date; reopen it to continue."
        : "The local terminal is unavailable. Check the workspace state and try again.", type: "error" });
    } catch {
      toast.add({ title: "Couldn't open a local terminal", description: "The local shell could not start. Try again.", type: "error" });
    } finally {
      localLaunch.current = false;
      setStartingLocal(false);
    }
  }

  async function connectTeam(virtualHostId: string) {
    const bridge = window.ssterm;
    if (!owner || !bridge) return;
    setPage("terminals");
    try {
      const result = await bridge.connectHost({ owner, hostId: virtualHostId });
      if (result.ok) return controller.reveal(result.value.sessionId);
      toast.add({ title: "Couldn't connect to Team host", description: connectMessages[result.error.code] ?? "Fetch Team membership and review this target before trying again.", type: "error" });
    } catch {
      toast.add({ title: "Couldn't connect to Team host", description: "Team access is unavailable. Fetch current membership and try again.", type: "error" });
    }
    setPage("team");
  }

  /**
   * One remote browser per window: another host replaces the current one, after a confirmation on Files when that
   * would stop pending transfers or remote edits (the same path as the Files server picker).
   */
  const openSftp = (hostId: string) => {
    setPage("files");
    void sftp.open(hostId);
  };

  // The toggle lives in the sidebar header, or in a rail while the sidebar is collapsed; when it (or the sidebar)
  // had focus, focus follows it to its new place.
  const refocusToggle = useRef(false);
  const toggleSidebar = () => {
    const panel = sidebarPanel.current;
    if (!panel) return;
    const focus = document.activeElement;
    refocusToggle.current = !!focus && (focus === sidebarToggle.current || !!document.getElementById("app-sidebar")?.contains(focus));
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  };
  useEffect(() => {
    if (!refocusToggle.current) return;
    refocusToggle.current = false;
    sidebarToggle.current?.focus();
  }, [sidebarOpen]);
  const onCommand = (command: WorkspaceCommand) => {
    if (command === "toggle-sidebar") toggleSidebar();
    else if (command === "shortcuts") openShortcuts();
    else openSettings();
  };
  const showTerminals = () => setPage("terminals");
  const terminalsShown = page === "terminals" && !!owner;
  const filesShown = page === "files" && !!owner;
  const snippetsShown = page === "snippets" && !!owner && !!state && ready;
  const running = tunnelState?.tunnels.filter((row) => row.phase === "running").length ?? 0;
  const navDisabled: Record<Page, boolean> = {
    hosts: false,
    terminals: false,
    files: !owner,
    identities: !ready,
    "known-hosts": storage?.status !== "ready",
    snippets: !ready,
    tunnels: !ready,
    recordings: !owner,
    team: !ready,
  };
  // Servers rows and summary: terminal and SFTP sessions alike.
  const hostSessions = useMemo(() => [...sessions, ...sftp.sessions], [sessions, sftp.sessions]);
  const navCount: Partial<Record<Page, number>> = { terminals: sessions.length, tunnels: running || undefined };

  const sidebarToggleButton = (
    <Button
      ref={sidebarToggle}
      size="icon-sm"
      variant="ghost"
      aria-label="Sidebar"
      aria-expanded={sidebarOpen}
      aria-controls="app-sidebar"
      aria-keyshortcuts="Control+Meta+S"
      title="Show or hide the sidebar (⌃⌘S)"
      onClick={toggleSidebar}
    >
      <PanelLeftIcon aria-hidden="true" />
    </Button>
  );
  const terminalsHeader = (
    <PageHeader
      className="terminals-header"
      title="Terminals"
      subtitle="Local shells and SSH sessions."
      actions={
        <>
          <Button
            size="sm"
            aria-label="New local terminal"
            title="New local terminal · This Mac"
            disabled={!owner || startingLocal}
            onClick={() => void startLocal()}
          >
            {startingLocal ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" aria-hidden="true" />}
            New local terminal
          </Button>
          <Button size="sm" variant="outline" title="Split right (⌘D)" disabled={!controller.activeSession} onClick={() => void controller.split("row")}>
            <Columns2Icon data-icon="inline-start" aria-hidden="true" />
            <span className="page-action-text">Split right</span>
          </Button>
          <Button size="sm" variant="outline" title="Split down (⇧⌘D)" disabled={!controller.activeSession} onClick={() => void controller.split("column")}>
            <Rows2Icon data-icon="inline-start" aria-hidden="true" />
            <span className="page-action-text">Split down</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            title="Workspace tools: templates and multi-target input"
            disabled={!owner || !ready}
            onClick={() => setWorkspaceTools(++toolsSerial.current)}
          >
            <PanelsTopLeftIcon data-icon="inline-start" aria-hidden="true" />
            <span className="page-action-text">Workspace tools</span>
          </Button>
        </>
      }
    >
      <SessionTabs controller={controller} onSelect={showTerminals} />
    </PageHeader>
  );
  // Why the workspace cannot open; shown on the fallback page and on an empty Terminals page.
  const workspaceAlerts = (
    <>
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
    </>
  );
  const terminalsEmpty = (
    <div className="absolute inset-0 flex flex-col overflow-auto">
      <div className="workspace-empty">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No open terminals</EmptyTitle>
            <EmptyDescription>
              Open a local shell on this Mac with New local terminal, or connect to a saved SSH server.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => showHosts()}>
              <ServerIcon data-icon="inline-start" /> Show servers
            </Button>
          </EmptyContent>
        </Empty>
      </div>
      {owner ? workspaceAlerts : null}
    </div>
  );

  const showHosts = (next?: CatalogScope) => {
    setPage("hosts");
    if (next) setScope(next);
  };
  const groupScope = view.scope.kind === "group" ? view.scope.groupId : null;
  const closeDialog = () => setDialogState(undefined);
  const deletingGroup =
    dialog?.kind === "delete-group"
      ? state?.groups.find((group) => group.id === dialog.id)
      : undefined;
  const deletingHost =
    dialog?.kind === "delete-host"
      ? state?.hosts.find((host) => host.id === dialog.id)
      : undefined;

  return (
    <AwaitingTrust.Provider value={awaitingTrust}>
    <div
      className="app-shell"
      data-window-focused={
        desktop.status === "ready" ? desktop.data.window.focused : undefined
      }
    >
      {/* Only the traffic lights and a drag region: page actions live in each page header. */}
      <header className="app-titlebar">
        <div className="titlebar-safe-area" aria-hidden="true" />
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
              <SidebarHeader className="flex-row items-center justify-between px-4 pt-3 pb-1">
                <img src={iconLogo} alt="ssterm" className="sidebar-mark" />
                {sidebarOpen ? sidebarToggleButton : null}
              </SidebarHeader>
              <SidebarContent>
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu aria-label="Pages">
                      {pages.map((id) => {
                        const Icon = pageIcons[id];
                        return (
                          <SidebarMenuItem key={id}>
                            <SidebarMenuButton
                              isActive={page === id}
                              aria-current={page === id ? "page" : undefined}
                              disabled={navDisabled[id]}
                              onClick={() => (id === "hosts" ? showHosts() : setPage(id))}
                            >
                              <Icon />
                              <span>{titles[id]}</span>
                              {navCount[id] !== undefined ? <span className="ml-auto type-caption">{navCount[id]}</span> : null}
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
                <CatalogLibrary
                  state={state}
                  tree={tree}
                  current={page === "hosts" ? view.scope : undefined}
                  expanded={expanded}
                  action={
                    <CatalogAddMenu
                      disabled={!ready}
                      onAdd={(kind) =>
                        setDialog(
                          kind === "host"
                            ? { kind: "host", groupId: groupScope }
                            : { kind: "group", parentId: groupScope },
                        )
                      }
                    />
                  }
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
              </SidebarContent>
              <SidebarFooter className="gap-2 border-t border-sidebar-border p-2">
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton disabled={!owner} aria-keyshortcuts="Meta+Comma" onClick={() => openSettings()}>
                      <Settings2Icon />
                      <span>Settings</span>
                      <span className="ml-auto type-caption text-muted-foreground" aria-hidden="true">⌘,</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton disabled={!owner} aria-keyshortcuts="Meta+Slash" onClick={openShortcuts}>
                      <KeyboardIcon />
                      <span>Keyboard shortcuts</span>
                      <span className="ml-auto type-caption text-muted-foreground" aria-hidden="true">⌘/</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {lockEnabled ? (
                    <SidebarMenuItem>
                      <SidebarMenuButton disabled={!owner} onClick={() => void requestLock()}>
                        <LockKeyholeIcon />
                        <span>Lock workspace</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ) : null}
                </SidebarMenu>
                {/* What the removed global status bar said about the app and its storage. */}
                <p className="px-2 type-caption text-muted-foreground">
                  {desktop.status === "loading" ? (
                    <span className="flex items-center gap-2">
                      <Spinner aria-label="Loading workspace information" /> Opening workspace
                    </span>
                  ) : desktop.status === "ready" ? (
                    `ssterm ${desktop.data.app.version} · ${problem ? "Storage unavailable" : "Local workspace"}`
                  ) : (
                    "Local workspace"
                  )}
                </p>
              </SidebarFooter>
            </Sidebar>
          </ResizablePanel>
          <ResizableHandle aria-label="Resize sidebar" />
          <ResizablePanel style={{ overflow: "hidden" }}>
            <div className="flex h-full min-w-0">
            {sidebarOpen ? null : <div className="sidebar-rail">{sidebarToggleButton}</div>}
            <main className="app-workspace min-w-0 flex-1">
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
                  tools={workspaceTools}
                  onCloseTools={() => setWorkspaceTools(0)}
                  header={terminalsHeader}
                  empty={terminalsEmpty}
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
                    // Only before the window has an owner; afterwards the terminal layer shows this header itself.
                    <>
                      {terminalsHeader}
                      <div className="relative flex-1">{terminalsEmpty}</div>
                    </>
                  ) : page === "team" && owner && ready ? (
                    <TeamWorkspace key={`${owner.windowId}:${owner.generation}:${state?.lockEpoch}`} owner={owner} onConnect={connectTeam} />
                  ) : page === "identities" && owner && state && ready ? (
                    <IdentitiesPage owner={owner} catalog={catalog} state={state} />
                  ) : page === "tunnels" && owner && state && ready ? (
                    <TunnelsPage owner={owner} catalog={catalog} state={state} tunnels={tunnelState} />
                  ) : page === "recordings" && owner ? (
                    // Works while storage is blocked too: capture there fails closed, and Delete still works.
                    <RecordingsPage owner={owner} onOpenSettings={() => openSettings("recording")} />
                  ) : page !== "identities" && page !== "snippets" && page !== "tunnels" && page !== "recordings" && page !== "team" && state && ready ? (
                    <HostsPage
                      state={state}
                      hosts={view.hosts}
                      scope={view.scope}
                      filtering={view.filtering}
                      selectedId={selectedId}
                      sessions={hostSessions}
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
                      toolbar={
                        <CatalogSearch
                          state={state}
                          disabled={!ready}
                          search={search}
                          tagIds={view.tagIds}
                          resultCount={view.filtering ? view.hosts.length : undefined}
                          onSearch={setSearch}
                          onSubmit={() => {
                            // The deferred view may still lag the typed search.
                            const first = filterCatalogHosts(state, { scope: view.scope, search, tagIds: view.tagIds })[0];
                            if (!first) return;
                            setSelectedId(first.id);
                            requestAnimationFrame(() =>
                              document.querySelector<HTMLElement>(`[data-host-id="${first.id}"]`)?.focus(),
                            );
                          }}
                          onTags={setTagIds}
                        />
                      }
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
                  {workspaceAlerts}
                </div>
              )}
            </main>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarProvider>
      {state && dialog?.kind === "host" ? (
        <HostEditor
          key={dialog.key}
          catalog={catalog}
          state={state}
          hostId={dialog.id}
          groupId={dialog.groupId}
          status={
            dialog.id
              ? connection(hostSessions, dialog.id, (session) => session.phase === "connecting" && awaitingTrust.has(session.sessionId))
              : undefined
          }
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
          key={dialog.key}
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
          key={dialog?.key}
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
          key={dialog?.key}
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
      {overlay === "settings" ? (
        <SettingsDrawer
          key={settingsOpen.key}
          tab={settingsOpen.tab}
          onClose={() => setOverlay(undefined)}
          settings={settings}
          terminals={sessions.length}
          owner={owner}
          onOpenRecordings={() => setPage("recordings")}
        />
      ) : null}
      {lockConfirm ? (
        <LockWorkspaceDrawer
          key={lockConfirm.key}
          work={lockConfirm.work}
          catalog={state}
          onConfirm={() => void lockWorkspace()}
          onClose={() => setLockConfirm((current) => (current?.key === lockConfirm.key ? undefined : current))}
        />
      ) : null}
      {overlay === "shortcuts" ? (
        <ShortcutsDrawer key={shortcutsKey} onClose={() => setOverlay(undefined)} />
      ) : null}
      <HostTrustDialogs state={trust.state} />
      <CredentialPrompts state={trust.state?.prompts.length ? undefined : credentials.state} />
    </div>
    </AwaitingTrust.Provider>
  );
}
