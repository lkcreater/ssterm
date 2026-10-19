import { useEffect, useRef, type KeyboardEvent } from "react";
import { XIcon } from "lucide-react";
import type { TerminalPhase, TerminalSession } from "@ssterm/contracts";
import { ConnectionStatus, type ConnectionState } from "@/components/connection/connection-status";
import { Badge } from "@/components/ui/badge";
import type { WorkspaceController } from "@/components/workspace/terminal-workspace";
import { panes, type Tab } from "@/lib/workspace-layout";
import { terminalIdentity } from "@/lib/terminal-target";

// Worst first: a tab shows the least healthy of its panes.
const severity: TerminalPhase[] = ["failed", "closed", "connecting", "ready"];
const states = {
  connecting: "connecting",
  ready: "connected",
  closed: "disconnected",
  failed: "error",
} as const satisfies Record<TerminalPhase, ConnectionState>;

function summary(tab: Tab, sessions: readonly TerminalSession[]) {
  const members = panes(tab.root).flatMap((id) => sessions.filter((session) => session.sessionId === id));
  const active = members.find((session) => session.sessionId === tab.active) ?? members[0];
  const worst = severity.find((phase) => members.some((session) => session.phase === phase)) ?? "closed";
  return {
    label: active ? terminalIdentity(active).label : "Unknown target",
    local: !!active?.local,
    shell: active?.local?.shell,
    others: members.length - 1,
    production: members.some((session) => session.target?.environment === "PROD"),
    state: states[worst],
  };
}

/**
 * The terminal tab strip: a roving tablist (arrows/Home/End select, Delete closes) with each tab's
 * close button beside it. The blue active edge is separate from the connection state it shows.
 */
export function SessionTabs({
  controller,
  onSelect,
}: {
  controller: WorkspaceController;
  /** A tab was chosen; show the terminals. */
  onSelect?(): void;
}) {
  const { workspace, dispatch, sessions } = controller;
  const list = useRef<HTMLDivElement>(null);
  const tabs = workspace.tabs;

  // The whole tab with its close button stays in view, also when the window (and so the strip) resizes.
  useEffect(() => {
    const strip = list.current;
    if (!strip) return;
    const reveal = () =>
      strip
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.closest(".session-tab")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Its first callback also runs for the new selection.
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [workspace.activeTab, tabs.length]);

  /** Arrow keys keep focus on the tabs; a click goes on typing in the tab's active pane. */
  const select = (tab: Tab, focusTab: boolean) => {
    dispatch({ type: "activate-tab", tabId: tab.id });
    onSelect?.();
    if (focusTab) list.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tab.id)}"]`)?.focus();
    else controller.focusActive();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : undefined;
    if (next !== undefined) select(tabs[next]!, true);
    else if (event.key === "Delete") controller.requestClose({ tabId: tabs[index]!.id });
    else return;
    event.preventDefault();
  };

  if (tabs.length === 0) return null;
  return (
    <div
      ref={list}
      role="tablist"
      aria-label="Terminal tabs"
      className="session-tabs flex min-w-0 items-center gap-1 overflow-x-auto"
    >
      {tabs.map((tab, index) => {
        const { label, local, shell, others, production, state } = summary(tab, sessions);
        const selected = tab.id === workspace.activeTab;
        return (
          <div key={tab.id} className="session-tab max-w-64 shrink-0" data-active={selected}>
            <button
              type="button"
              role="tab"
              data-tab-id={tab.id}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              title={`${local ? `LOCAL · ${label} · ${shell}` : label}${others > 0 ? ` and ${others} more` : ""}`}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => select(tab, false)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              <span className="session-tab-label truncate">{label}</span>
              {local ? <span className="host-target truncate">{shell}</span> : null}
              {local ? <Badge variant="secondary">LOCAL</Badge> : null}
              {others > 0 ? (
                <span className="type-caption shrink-0 text-muted-foreground">
                  +{others} {others === 1 ? "pane" : "panes"}
                </span>
              ) : null}
              {production ? <Badge variant="production">PROD</Badge> : null}
              <ConnectionStatus state={state} />
            </button>
            {/* Out of the tab order: Delete on the tab or Cmd+W closes from the keyboard. It stays inside the
                tablist (a tab cannot own a button); moving it out would split each tab from its close control. */}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${label}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => controller.requestClose({ tabId: tab.id })}
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
