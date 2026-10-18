/** Browser-safe configuration metadata only: never commands, credentials, or live session IDs. */
export const MAX_WORKSPACE_TEMPLATE_TARGETS = 8;
export const MAX_WORKSPACE_TEMPLATES = 64;
export type WorkspaceTemplateNode =
  | { kind: 'pane'; slotId: string; hostId: string }
  | { kind: 'split'; direction: 'row' | 'column'; ratio: number; first: WorkspaceTemplateNode; second: WorkspaceTemplateNode };
export interface WorkspaceTemplateConfiguration {
  version: 1;
  tabs: { root: WorkspaceTemplateNode; activeSlot: string; mode: 'split' | 'focus' }[];
  activeTab: number;
  snippetId: string | null;
}
export interface WorkspaceTemplateView {
  id: string;
  revision: number;
  label: string;
  configuration: WorkspaceTemplateConfiguration;
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v);
const exact = (v: unknown, fields: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' &&
  Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === fields.length && fields.every(k => Object.hasOwn(v, k));
/** Bounded before recursion; cycles and over-deep layouts are refused without walking their contents. */
export function isWorkspaceTemplateConfiguration(v: unknown): v is WorkspaceTemplateConfiguration {
  if (!exact(v, ['version', 'tabs', 'activeTab', 'snippetId']) || v.version !== 1 ||
    !Array.isArray(v.tabs) || v.tabs.length < 1 || v.tabs.length > 8 ||
    !Number.isInteger(v.activeTab) || (v.activeTab as number) < 0 || (v.activeTab as number) >= v.tabs.length ||
    !(v.snippetId === null || id(v.snippetId))) return false;
  const slots = new Set<string>();
  function node(n: unknown, depth: number, tabSlots: Set<string>): boolean {
    if (exact(n, ['kind', 'slotId', 'hostId']) && n.kind === 'pane') {
      if (typeof n.slotId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(n.slotId) || slots.has(n.slotId) || !id(n.hostId)) return false;
      slots.add(n.slotId); tabSlots.add(n.slotId);
      return slots.size <= MAX_WORKSPACE_TEMPLATE_TARGETS && tabSlots.size <= 4;
    }
    return depth < 3 && exact(n, ['kind', 'direction', 'ratio', 'first', 'second']) && n.kind === 'split' &&
      (n.direction === 'row' || n.direction === 'column') && typeof n.ratio === 'number' && Number.isFinite(n.ratio) &&
      n.ratio >= 0.2 && n.ratio <= 0.8 && node(n.first, depth + 1, tabSlots) && node(n.second, depth + 1, tabSlots);
  }
  return Array.from(v.tabs).every(tab => {
    if (!exact(tab, ['root', 'activeSlot', 'mode']) || (tab.mode !== 'split' && tab.mode !== 'focus')) return false;
    const tabSlots = new Set<string>();
    return node(tab.root, 0, tabSlots) && typeof tab.activeSlot === 'string' && tabSlots.has(tab.activeSlot);
  });
}
/** Rebuild the fixed projection at process boundaries (call only after validation). */
export function copyWorkspaceTemplateConfiguration(v: WorkspaceTemplateConfiguration): WorkspaceTemplateConfiguration {
  const node = (n: WorkspaceTemplateNode): WorkspaceTemplateNode => n.kind === 'pane'
    ? { kind: 'pane', slotId: n.slotId, hostId: n.hostId }
    : { kind: 'split', direction: n.direction, ratio: n.ratio, first: node(n.first), second: node(n.second) };
  return { version: 1, tabs: v.tabs.map(tab => ({ root: node(tab.root), activeSlot: tab.activeSlot, mode: tab.mode })), activeTab: v.activeTab, snippetId: v.snippetId };
}
export function workspaceTemplateHostIds(v: WorkspaceTemplateConfiguration): string[] {
  const ids: string[] = [];
  const visit = (n: WorkspaceTemplateNode): void => { if (n.kind === 'pane') ids.push(n.hostId); else { visit(n.first); visit(n.second); } };
  v.tabs.forEach(tab => visit(tab.root));
  return ids;
}
