import {
  useEffect,
  useEffectEvent,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AppWindowIcon,
  BotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  EllipsisIcon,
  LayersIcon,
  FolderOpenIcon,
  Maximize2Icon,
  MergeIcon,
  Minimize2Icon,
  Rows2Icon,
  XIcon,
} from "lucide-react";
import type { CatalogState, ErrorCode, Owner, TerminalSession, TerminalSettings } from "@ssterm/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { AgentPanel } from "@/components/agent/agent-panel";
import { useAgentState } from "@/hooks/use-agent";
import { CloseConfirm, type CloseRequest } from "@/components/workspace/close-confirm";
import { LiveTerminal, type PaneSettings } from "@/components/workspace/live-terminal";
import { WorkspaceTools } from "@/components/workspace/workspace-tools";
import { SnippetPanel } from "@/components/workspace/snippet-panel";
import { TerminalInputsContext, type TerminalInputs } from "@/components/workspace/terminal-inputs";
import { paneScrollback, type PaneScrollback } from "@/lib/terminal-theme";
import {
  activeTab,
  emptyWorkspace,
  layoutReducer,
  MAX_PANES,
  MAX_RATIO,
  MIN_RATIO,
  neighbor,
  paneRects,
  panes,
  RATIO_STEP,
  separators,
  tabOf,
  type LayoutAction,
  type PaneRect,
  type Rect,
  type SeparatorRect,
  type SplitDirection,
  type Tab,
} from "@/lib/workspace-layout";
import { workspaceShortcut, type WorkspaceShortcut } from "@/lib/workspace-shortcuts";
import { startSiblingTerminal, terminalIdentity } from "@/lib/terminal-target";

export type WorkspaceCommand = "toggle-sidebar" | "settings" | "shortcuts";
export type CloseTarget = { sessionId: string } | { tabId: string };

const GAP = 4;
const FOCUS_HEADER = 32;
const EPSILON = 1e-6;
const connectMessages: Partial<Record<ErrorCode, string>> = {
  busy: "Too many sessions are open; close ended panes first.",
  unavailable: "Connections are unavailable while the workspace is locked or closed.",
  "invalid-request": "This server can no longer be connected. Review its settings.",
  "stale-owner": "This window changed. Try again.",
};

const activeTextarea = () =>
  document.querySelector<HTMLElement>('.terminal-workspace section[data-active="true"] .xterm-helper-textarea');
// A task, not an effect: it runs after the committed layout even when the state did not change.
const focusActivePane = () => {
  const from = document.activeElement;
  setTimeout(() => {
    // Input outranks timers, so a busy pane can let Cmd+F or a click move focus first; keep that. While a drawer is
    // open the pane can change behind it, but focus never leaves the drawer (it returns focus itself when it closes).
    const now = document.activeElement;
    if (document.querySelector('[data-slot="drawer"][data-open]')) return;
    if (now === from || !now || now === document.body) activeTextarea()?.focus();
  });
};

/**
 * Tab and split state for one window. The shell owns it so the tab strip (Terminals header) and the
 * terminal layer share it: `useWorkspace(owner, sessions)` once in the shell, then
 * pass the result to `<SessionTabs>` and `<TerminalWorkspace>`.
 */
export function useWorkspace(owner: Owner | undefined, sessions: TerminalSession[]) {
  const [workspace, dispatch] = useReducer(layoutReducer, emptyWorkspace);
  const [closeRequest, setCloseRequest] = useState<CloseRequest>();
  const closeSerial = useRef(0);
  // A new session to focus once it is placed and Ready, unless the user has moved on.
  const focusWhenReady = useRef<string>(undefined);
  const focusOrigin = useRef<Element | null>(null);
  const splitting = useRef(false);
  const windowId = owner?.windowId;
  const generation = owner?.generation;

  useEffect(() => {
    dispatch({ type: "owner-reset" });
    setCloseRequest(undefined);
    focusWhenReady.current = undefined;
    focusOrigin.current = null;
  }, [windowId, generation]);
  const ids = sessions.map((session) => session.sessionId).join(" ");
  useEffect(() => {
    dispatch({ type: "reconcile", sessions: ids ? ids.split(" ") : [] });
  }, [ids]);

  useEffect(() => {
    const id = focusWhenReady.current;
    const session = sessions.find((row) => row.sessionId === id);
    // A split or Connect result can arrive before the session is listed and placed.
    if (!id || !session || !tabOf(workspace, id) || session.phase === "connecting") return;
    focusWhenReady.current = undefined;
    const focused = document.activeElement;
    if (session.phase !== "ready" || activeTab(workspace)?.active !== id) return;
    if (focused && focused !== document.body && focused !== focusOrigin.current && !focused.closest(".terminal-workspace")) return;
    focusOrigin.current = null;
    focusActivePane();
  }, [workspace, sessions]);

  const tab = activeTab(workspace);
  const ownerOf = () => (windowId && generation ? { windowId, generation } : undefined);

  /** Removes the panes now; the sessions end in the background and come back if that fails. */
  const close = (affected: TerminalSession[], focus = true) => {
    const bridge = window.ssterm;
    const owner = ownerOf();
    if (!bridge || !owner) return;
    for (const session of affected) {
      const target = { owner, sessionId: session.sessionId, generation: session.generation };
      const live = session.phase === "ready" || session.phase === "connecting";
      dispatch({ type: "close", sessionId: session.sessionId });
      void (async () => {
        if (live && !(await bridge.closeTerminal(target)).ok) return false;
        return (await bridge.dismissTerminal(target)).ok;
      })()
        .catch(() => false)
        .then((ok) => {
          if (ok) return;
          dispatch({ type: "restore", sessionId: session.sessionId });
          toast.add({
            title: `${terminalIdentity(session).label} could not be closed`,
            description: "It is shown again in its own tab. Try closing it once more.",
            type: "error",
          });
        });
    }
    if (focus) focusActivePane();
  };

  return {
    workspace,
    dispatch: dispatch as Dispatch<LayoutAction>,
    activeTab: tab,
    /** The active pane's session: the target shown in the status bar and used by later snippets (SST-024). */
    activeSession: sessions.find((session) => session.sessionId === tab?.active),
    sessions,
    closeRequest,
    /** After Connect: shows the session's tab (now or once it is listed) and focuses it when Ready. */
    reveal(sessionId: string) {
      dispatch({ type: "reveal", sessionId });
      focusWhenReady.current = sessionId;
      focusOrigin.current = document.activeElement;
    },
    /** Moves keyboard focus to the active pane once this update has rendered. */
    focusActive: focusActivePane,
    /** Opens a fresh local process or a session to the same saved host beside the pane. */
    async split(direction: SplitDirection, targetId = tab?.active) {
      const bridge = window.ssterm;
      const owner = ownerOf();
      const target = sessions.find((session) => session.sessionId === targetId);
      const home = targetId ? tabOf(workspace, targetId) : undefined;
      if (!bridge || !owner || !target || !home || splitting.current) return;
      if (panes(home.root).length >= MAX_PANES) {
        toast.add({
          title: `A tab holds at most ${MAX_PANES} panes`,
          description: "Close a pane, or connect from Servers to open a new tab.",
        });
        return;
      }
      splitting.current = true;
      try {
        const result = await startSiblingTerminal(bridge, owner, target).catch(() => undefined);
        if (!result?.ok) {
          toast.add({
            title: "Couldn't open another session",
            description: (result && connectMessages[result.error.code]) ?? "The connection could not start. Try again.",
            type: "error",
          });
          return;
        }
        const { sessionId } = result.value;
        dispatch({ type: "split", target: target.sessionId, direction, sessionId });
        focusWhenReady.current = sessionId;
      } finally {
        splitting.current = false;
      }
    },
    /** Disconnect is explicit: the session ends and its pane is removed at once, without a confirmation. */
    disconnect(sessionId: string) {
      const session = sessions.find((row) => row.sessionId === sessionId);
      if (session) close([session]);
    },
    /** Asks first only when a connected session would end; anything else closes at once. */
    requestClose(target: CloseTarget) {
      const row = "tabId" in target ? workspace.tabs.find((candidate) => candidate.id === target.tabId) : undefined;
      const ids = "tabId" in target ? (row ? panes(row.root) : []) : [target.sessionId];
      const affected = sessions.filter((session) => ids.includes(session.sessionId));
      if (affected.length === 0) return;
      if (affected.some((session) => session.phase === "ready"))
        setCloseRequest({ kind: "tabId" in target ? "tab" : "pane", sessions: affected, serial: ++closeSerial.current });
      else close(affected);
    },
    /** Ends the captured sessions; the drawer returns focus to the active pane itself once it has slid out. */
    confirmClose() {
      if (closeRequest) close(closeRequest.sessions, false);
    },
    /** The confirmation drawer has slid out, after Cancel or Disconnect and close. */
    dismissClose() {
      setCloseRequest(undefined);
    },
  };
}
export type WorkspaceController = ReturnType<typeof useWorkspace>;

const reducedMotion = "(prefers-reduced-motion: reduce)";
function subscribeMotion(change: () => void) {
  const query = matchMedia(reducedMotion);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}
const prefersReducedMotion = () => matchMedia(reducedMotion).matches;

/** Inside the frame, panes keep a small gap on shared edges only. */
function placement(rect: Rect, top = 0): CSSProperties {
  const edges = (start: number, size: number) => [
    start > EPSILON ? GAP / 2 : 0,
    start + size < 1 - EPSILON ? GAP / 2 : 0,
  ] as const;
  const [left, right] = edges(rect.x, rect.width);
  const [above, below] = edges(rect.y, rect.height);
  return {
    position: "absolute",
    left: `calc(${rect.x * 100}% + ${left}px)`,
    top: `calc(${rect.y * 100}% + ${above + top}px)`,
    width: `calc(${rect.width * 100}% - ${left + right}px)`,
    height: `calc(${rect.height * 100}% - ${above + below + top}px)`,
  };
}
const full: Rect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Every session's terminal, each a sibling keyed by session and placed from its tab's layout,
 * so splitting, merging, moving and Focus/Split never remount (or reconnect) a pane. Panes of
 * other tabs, Focus-mode hidden panes and the whole layer while another page shows stay at
 * their real size with `visibility: hidden` and `inert`.
 *
 * Mount it whenever the window has an owner, even with no sessions (Cmd+W then closes the
 * window), inside a `position: relative` container that it fills; pages render above it.
 */
export function TerminalWorkspace({
  owner,
  controller,
  settings,
  hidden,
  onCommand,
  onShowTerminals,
  onOpenSftp,
  catalog,
  tools = 0,
  onCloseTools,
  header,
  empty,
}: {
  owner: Owner;
  controller: WorkspaceController;
  settings: TerminalSettings;
  /** Snippet labels and the lock epoch; absent while the catalog is unavailable (no snippet panel). */
  catalog?: CatalogState;
  /** The open Workspace tools drawer's key; 0 when closed. */
  tools?: number;
  onCloseTools?(): void;
  /** The Terminals page header (title, actions and the tab strip); it hides with the panes, so their size never changes. */
  header?: ReactNode;
  /** Shown in place of the panes while no session is open. */
  empty?: ReactNode;
  /** Another page is shown; terminals keep streaming underneath. */
  hidden: boolean;
  onCommand?(command: WorkspaceCommand): void;
  /** A tab shortcut was used while another page was shown. */
  onShowTerminals?(): void;
  /** "Open in SFTP": the pane's saved host, captured when the item is chosen. */
  onOpenSftp?(hostId: string): void;
}) {
  const { workspace, dispatch, sessions, activeTab: tab } = controller;
  useEffect(() => { if (hidden || !catalog) onCloseTools?.(); }, [hidden, !!catalog]);
  const layer = useRef<HTMLDivElement>(null);
  const inputs = useRef<TerminalInputs>(new Map()).current;
  // The open snippet drawer's key: each open is a fresh instance that captures the active pane again.
  const [snippets, setSnippets] = useState(0);
  const snippetSerial = useRef(0);
  const openSnippets = () => setSnippets(++snippetSerial.current);
  const showSnippets = snippets > 0 && !hidden && !!catalog && sessions.length > 0;
  // Leaving the terminals (or losing the catalog) closes the drawer; returning never reopens it and steals focus.
  if (snippets && !showSnippets) setSnippets(0);
  const reduced = useSyncExternalStore(subscribeMotion, prefersReducedMotion);
  const [savedScrollback, setScrollback] = useState<PaneScrollback>(() => ({
    setting: settings.terminalScrollback,
    panes: {},
  }));
  const scrollback = paneScrollback(
    savedScrollback,
    sessions.map((session) => session.sessionId),
    settings.terminalScrollback,
  );
  if (scrollback !== savedScrollback) setScrollback(scrollback);
  const paneSettings = (sessionId: string): PaneSettings => ({
    fontSize: settings.terminalFontSize,
    scrollback: scrollback.panes[sessionId]!,
    cursorStyle: settings.terminalCursor,
    cursorBlink: settings.terminalCursorBlink && !reduced,
  });
  const layouts = new Map<string, { rect: PaneRect; tab: Tab }>();
  for (const row of workspace.tabs)
    for (const rect of paneRects(row.root)) layouts.set(rect.sessionId, { rect, tab: row });
  const order = tab ? panes(tab.root) : [];
  const focusMode = tab?.mode === "focus" && order.length > 1;

  // SST-041: one AI Agent panel per window, bound to the session it was opened from (never to the active tab).
  const agent = useAgentState(owner);
  const [agentSession, setAgentSession] = useState<string>();
  useEffect(() => setAgentSession(undefined), [owner.windowId, owner.generation]);
  const agentEligible = (session: TerminalSession) =>
    !!agent?.enabled && session.phase === "ready" && !session.local && session.target?.source !== "team";
  const openAgent = async (session: TerminalSession) => {
    const bridge = window.ssterm;
    if (!bridge) return;
    if (agentSession === session.sessionId) return;
    // Opening it for another pane ends the previous conversation.
    if (agentSession) void bridge.closeAgent({ owner, sessionId: agentSession }).catch(() => undefined);
    setAgentSession(undefined);
    const result = await bridge.openAgent({ owner, sessionId: session.sessionId, generation: session.generation }).catch(() => undefined);
    if (result?.ok && result.value.status === "opened") return setAgentSession(session.sessionId);
    const reason = result?.ok && result.value.status === "refused" ? result.value.reason : undefined;
    toast.add({
      title: "AI Agent could not open",
      description: reason === "disabled" ? "Turn it on in Settings › AI Agent first."
        : reason === "provider" ? "The claude CLI is not available in a verified version. See Settings › AI Agent."
          : reason === "limit" ? "Too many agent conversations are open. Close one first."
            : "The session is no longer connected.",
      type: "error",
    });
  };
  const closeAgentPanel = () => {
    const sessionId = agentSession;
    setAgentSession(undefined);
    if (sessionId) void window.ssterm?.closeAgent({ owner, sessionId }).catch(() => undefined);
    controller.focusActive();
  };

  const run = (shortcut: WorkspaceShortcut, repeat: boolean): boolean => {
    switch (shortcut.kind) {
      case "toggle-sidebar":
      case "settings":
      case "shortcuts":
        if (!onCommand) return false;
        if (!repeat) onCommand(shortcut.kind);
        return true;
      case "tab":
        if (workspace.tabs.length === 0) return false;
        dispatch({ type: "activate-index", index: shortcut.index });
        break;
      case "cycle-tab":
        if (workspace.tabs.length === 0) return false;
        dispatch({ type: "cycle-tab", step: shortcut.step });
        break;
      case "close-pane":
        if (sessions.length === 0) {
          // Main asks before closing a window with connected sessions; here there are none.
          if (!repeat) window.close();
          return true;
        }
        if (hidden) return false;
        // Holding Cmd+W must not close pane after pane.
        if (!repeat && tab) controller.requestClose({ sessionId: tab.active });
        return true;
      case "split":
        if (hidden) return false;
        if (!repeat) void controller.split(shortcut.direction);
        return true;
      case "toggle-mode":
        if (hidden) return false;
        if (!repeat) dispatch({ type: "toggle-mode" });
        controller.focusActive();
        return true;
      case "snippets":
        if (hidden || !catalog || sessions.length === 0) return false;
        // An open drawer keeps its own keys (see onKeyDown), so this always opens a fresh one.
        if (!repeat) openSnippets();
        return true;
      case "focus-pane": {
        if (hidden || !tab) return false;
        const next = neighbor(paneRects(tab.root), tab.active, shortcut.direction);
        if (next) dispatch({ type: "focus-pane", sessionId: next });
        controller.focusActive();
        return true;
      }
    }
    onShowTerminals?.();
    controller.focusActive();
    return true;
  };
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const shortcut = workspaceShortcut(event);
    if (!shortcut) return;
    // A dialog or menu keeps its own keys (and a pane must not close behind a prompt).
    if (event.target instanceof Element && event.target.closest('[role="dialog"],[role="alertdialog"],[role="menu"]'))
      return;
    // A combobox keeps focus in its input while its list is open; a modal may not hold focus yet.
    // The Files lists are always mounted listboxes, not popups.
    if (document.querySelector('[role="listbox"]:not(.file-list),[aria-modal="true"]')) return;
    if (!run(shortcut, event.repeat)) return;
    event.preventDefault();
    event.stopPropagation();
  });
  // Capture phase on window runs before xterm's textarea handler, so a shortcut never reaches the shell.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  return (
    <TerminalInputsContext.Provider value={inputs}>
      {tools > 0 && !hidden && catalog ? <WorkspaceTools
        key={`${owner.windowId}:${owner.generation}:${catalog.lockEpoch}:${tools}`}
        owner={owner} catalog={catalog} controller={controller} returnFocus={activeTextarea}
        onClose={() => { onCloseTools?.(); controller.focusActive(); }}
      /> : null}
      <div
        className="terminal-workspace"
        data-hidden={hidden || undefined}
        inert={hidden}
        style={{ position: "absolute", inset: 0, visibility: hidden ? "hidden" : undefined }}
        onFocus={(event) => {
          const id = (event.target as Element).closest?.("section[data-session-id]")?.getAttribute("data-session-id");
          if (id) dispatch({ type: "focus-pane", sessionId: id });
        }}
      >
        {header}
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel id="terminal-layer-area" minSize={320}>
        <div ref={layer} className="terminal-layer relative h-full min-h-0">
          {sessions.length === 0 ? empty : null}
          {focusMode && tab ? (
            <div
              role="group"
              aria-label="Focused pane"
              className="absolute inset-x-0 top-0 z-20 flex h-8 items-center gap-1 rounded-t-lg border border-border bg-card px-1"
            >
              <Button size="icon-sm" variant="ghost" aria-label="Previous pane" onClick={() => dispatch({ type: "cycle-pane", step: -1 })}>
                <ChevronLeftIcon aria-hidden="true" />
              </Button>
              <span className="type-caption" aria-live="polite">
                Pane {order.indexOf(tab.active) + 1} of {order.length}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label="Next pane" onClick={() => dispatch({ type: "cycle-pane", step: 1 })}>
                <ChevronRightIcon aria-hidden="true" />
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => dispatch({ type: "toggle-mode", tabId: tab.id })}>
                <Columns2Icon data-icon="inline-start" aria-hidden="true" />
                Show all panes
              </Button>
            </div>
          ) : null}
          {sessions.map((session) => {
            const entry = layouts.get(session.sessionId);
            const inActiveTab = !!entry && entry.tab.id === tab?.id;
            const visible = !hidden && inActiveTab && (!focusMode || session.sessionId === tab?.active);
            const style =
              focusMode && inActiveTab && session.sessionId === tab?.active
                ? placement(full, FOCUS_HEADER)
                : placement(entry?.rect ?? full);
            return (
              <LiveTerminal
                key={session.sessionId}
                owner={owner}
                session={session}
                settings={paneSettings(session.sessionId)}
                active={inActiveTab && session.sessionId === tab?.active}
                hidden={!visible}
                style={style}
                onDisconnect={() => controller.disconnect(session.sessionId)}
                actions={
                  entry ? (
                    <>
                      {agentEligible(session) ? (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label="AI Agent"
                          title="AI Agent"
                          aria-pressed={agentSession === session.sessionId}
                          onClick={() => void openAgent(session)}
                        >
                          <BotIcon aria-hidden="true" />
                        </Button>
                      ) : null}
                      <PaneMenu
                        controller={controller}
                        session={session}
                        home={entry.tab}
                        onOpenSftp={onOpenSftp}
                        onSnippets={catalog ? openSnippets : undefined}
                      />
                    </>
                  ) : null
                }
              />
            );
          })}
          {tab && !hidden && !focusMode
            ? separators(tab.root).map((split) => (
                <Divider key={`${tab.id}:${split.path}`} split={split} tabId={tab.id} layer={layer} dispatch={dispatch} />
              ))
            : null}
        </div>
        </ResizablePanel>
        {agentSession ? (
          <>
            <ResizableHandle aria-label="Resize AI Agent panel" />
            <ResizablePanel id="agent-panel-area" defaultSize={380} minSize={300} maxSize="60" groupResizeBehavior="preserve-pixel-size">
              <AgentPanel
                key={agentSession}
                owner={owner}
                sessionId={agentSession}
                conversation={agent?.conversations.find((conversation) => conversation.sessionId === agentSession)}
                onClose={closeAgentPanel}
              />
            </ResizablePanel>
          </>
        ) : null}
        </ResizablePanelGroup>
        {showSnippets ? (
          <SnippetPanel
            key={snippets}
            owner={owner}
            state={catalog}
            active={controller.activeSession}
            sessions={sessions}
            returnFocus={activeTextarea}
            onClose={() => setSnippets(0)}
          />
        ) : null}
        {controller.closeRequest ? (
          <CloseConfirm
            key={controller.closeRequest.serial}
            request={controller.closeRequest}
            onConfirm={controller.confirmClose}
            onClose={controller.dismissClose}
            confirmFocus={activeTextarea}
          />
        ) : null}
      </div>
    </TerminalInputsContext.Provider>
  );
}

/** A 1 px divider with an 8 px hit area; arrows move it 5 %, Home/End to the limits. */
function Divider({
  split,
  tabId,
  layer,
  dispatch,
}: {
  split: SeparatorRect;
  tabId: string;
  layer: RefObject<HTMLDivElement | null>;
  dispatch: Dispatch<LayoutAction>;
}) {
  const vertical = split.direction === "row";
  const at = vertical ? split.x + split.width * split.ratio : split.y + split.height * split.ratio;
  const style: CSSProperties = vertical
    ? { left: `calc(${at * 100}% - 4px)`, top: `${split.y * 100}%`, width: 8, height: `${split.height * 100}%`, cursor: "col-resize" }
    : { top: `calc(${at * 100}% - 4px)`, left: `${split.x * 100}%`, height: 8, width: `${split.width * 100}%`, cursor: "row-resize" };
  const set = (ratio: number) => dispatch({ type: "set-ratio", tabId, path: split.path, ratio });
  const steps: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={vertical ? "Resize panes left and right" : "Resize panes above and below"}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(split.ratio * 100)}
      aria-valuemin={MIN_RATIO * 100}
      aria-valuemax={MAX_RATIO * 100}
      className="group absolute z-10 flex touch-none items-center justify-center outline-none"
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // No focus change: typing continues in the terminal after a drag.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const box = layer.current?.getBoundingClientRect();
        if (!box?.width || !box.height) return;
        const fraction = vertical ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
        set(vertical ? (fraction - split.x) / split.width : (fraction - split.y) / split.height);
      }}
      onKeyDown={(event) => {
        const step = steps[event.key];
        if (step) set(split.ratio + step * RATIO_STEP);
        else if (event.key === "Home") set(MIN_RATIO);
        else if (event.key === "End") set(MAX_RATIO);
        else return;
        event.preventDefault();
      }}
    >
      <div
        className={`${vertical ? "h-full w-px" : "h-px w-full"} bg-border group-hover:bg-ring group-focus-visible:bg-ring group-focus-visible:outline-2 group-focus-visible:outline-ring`}
      />
    </div>
  );
}

function PaneMenu({
  controller,
  session,
  home,
  onOpenSftp,
  onSnippets,
}: {
  controller: WorkspaceController;
  session: TerminalSession;
  home: Tab;
  onOpenSftp?(hostId: string): void;
  /** Opens the snippet panel for this pane (made active first). */
  onSnippets?(): void;
}) {
  const { workspace, dispatch, sessions } = controller;
  const { sessionId } = session;
  const count = panes(home.root).length;
  const full = count >= MAX_PANES;
  const others = workspace.tabs
    .filter((row) => row.id !== home.id)
    .flatMap((row) => panes(row.root))
    .flatMap((id) => sessions.filter((row) => row.sessionId === id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" />} aria-label="Pane actions">
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={full} onClick={() => void controller.split("row", sessionId)}>
            <Columns2Icon /> Split right <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={full} onClick={() => void controller.split("column", sessionId)}>
            <Rows2Icon /> Split down <DropdownMenuShortcut>⇧⌘D</DropdownMenuShortcut>
          </DropdownMenuItem>
          {others.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={full}>
                <MergeIcon /> Add to this split
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {others.map((other) => (
                  <DropdownMenuItem
                    key={other.sessionId}
                    onClick={() => dispatch({ type: "merge", source: other.sessionId, target: sessionId })}
                  >
                    <span className="min-w-0 truncate">{terminalIdentity(other).label}</span>
                    {other.local ? <Badge variant="secondary">LOCAL</Badge> : null}
                    {other.target?.environment === "PROD" ? <Badge variant="production">PROD</Badge> : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          {count > 1 ? (
            <>
              <DropdownMenuItem
                onClick={() => {
                  dispatch({ type: "focus-pane", sessionId });
                  dispatch({ type: "toggle-mode", tabId: home.id });
                }}
              >
                {home.mode === "focus" ? <Minimize2Icon /> : <Maximize2Icon />}
                {home.mode === "focus" ? "Show all panes" : "Show only this pane"}
                <DropdownMenuShortcut>⇧⌘↩</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => dispatch({ type: "move-to-new-tab", sessionId })}>
                <AppWindowIcon /> Move to new tab
              </DropdownMenuItem>
            </>
          ) : null}
          {onSnippets ? (
            <DropdownMenuItem
              onClick={() => {
                dispatch({ type: "focus-pane", sessionId });
                onSnippets();
              }}
            >
              <LayersIcon /> Snippets… <DropdownMenuShortcut>⇧⌘S</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
          {onOpenSftp && session.hostId && !session.local && session.target?.source !== "team" ? (
            <DropdownMenuItem onClick={() => { if (session.hostId) onOpenSftp(session.hostId); }}>
              <FolderOpenIcon /> Open in SFTP
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => controller.requestClose({ sessionId })}>
          <XIcon /> Close pane <DropdownMenuShortcut>⌘W</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
