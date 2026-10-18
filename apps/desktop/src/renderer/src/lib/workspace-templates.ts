import type { TerminalSession, WorkspaceTemplateConfiguration, WorkspaceTemplateNode } from "@ssterm/contracts";
import { isWorkspaceTemplateConfiguration } from "@ssterm/domain/workspace-templates";
import { panes, type LayoutNode, type Tab, type Workspace } from "./workspace-layout";

export interface TemplateLayout {
  tabs: Omit<Tab, "id">[];
  activeTab: number;
}

/** Only saved-host references and layout metadata cross this boundary. */
export function captureWorkspaceTemplate(
  workspace: Workspace,
  sessions: readonly TerminalSession[],
  snippetId: string | null = null,
): WorkspaceTemplateConfiguration | null {
  const hosts = new Map(sessions.map((session) => [session.sessionId, session.hostId]));
  const slots = new Map<string, string>();
  let serial = 0;
  function capture(node: LayoutNode): WorkspaceTemplateNode | null {
    if (node.kind === "pane") {
      const hostId = hosts.get(node.sessionId);
      if (!hostId || workspace.closing.includes(node.sessionId)) return null;
      const slotId = `slot-${++serial}`;
      slots.set(node.sessionId, slotId);
      return { kind: "pane", slotId, hostId };
    }
    const first = capture(node.first), second = capture(node.second);
    if (!first) return second;
    if (!second) return first;
    return { kind: "split", direction: node.direction, ratio: node.ratio, first, second };
  }
  const tabs: WorkspaceTemplateConfiguration["tabs"] = [];
  const sourceIndices: number[] = [];
  for (const [index, tab] of workspace.tabs.entries()) {
    const root = capture(tab.root);
    if (!root) continue;
    sourceIndices.push(index);
    const firstSlot = (node: WorkspaceTemplateNode): string => node.kind === "pane" ? node.slotId : firstSlot(node.first);
    tabs.push({ root, activeSlot: slots.get(tab.active) ?? firstSlot(root), mode: root.kind === "pane" ? "split" : tab.mode });
  }
  const active = survivingIndex(sourceIndices, workspace.tabs.findIndex((tab) => tab.id === workspace.activeTab));
  const configuration = { version: 1, tabs, activeTab: active, snippetId };
  return isWorkspaceTemplateConfiguration(configuration) ? configuration : null;
}

/** Missing allocation results collapse their branches; successful slots always use fresh IDs. */
export function materializeWorkspaceTemplate(
  configuration: WorkspaceTemplateConfiguration,
  sessions: ReadonlyMap<string, string>,
): TemplateLayout {
  const used = new Set<string>();
  function materialize(node: WorkspaceTemplateNode): LayoutNode | null {
    if (node.kind === "pane") {
      const sessionId = sessions.get(node.slotId);
      if (!sessionId || used.has(sessionId)) return null;
      used.add(sessionId);
      return { kind: "pane", sessionId };
    }
    const first = materialize(node.first), second = materialize(node.second);
    if (!first) return second;
    if (!second) return first;
    return { kind: "split", direction: node.direction, ratio: node.ratio, first, second };
  }
  const tabs: TemplateLayout["tabs"] = [];
  const sourceIndices: number[] = [];
  configuration.tabs.forEach((tab, index) => {
    const root = materialize(tab.root);
    if (!root) return;
    sourceIndices.push(index);
    const ids = panes(root), preferred = sessions.get(tab.activeSlot);
    tabs.push({ root, active: preferred && ids.includes(preferred) ? preferred : ids[0]!, mode: root.kind === "pane" ? "split" : tab.mode });
  });
  return { tabs, activeTab: survivingIndex(sourceIndices, configuration.activeTab) };
}

/** Prefer the original tab, then its right neighbour, otherwise the last surviving tab. */
function survivingIndex(indices: number[], preferred: number): number {
  const index = indices.findIndex((source) => source >= preferred);
  return index >= 0 ? index : Math.max(0, indices.length - 1);
}
