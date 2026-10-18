/**
 * Terminal tabs, each a binary split tree of sessions. Pure, so every rule is unit-tested without
 * React. Panes are only ever referenced by session id: the views stay mounted elsewhere, so no
 * operation here can remount (and so reconnect or lose) a terminal.
 */

/** `row`: side by side (Split right). `column`: stacked (Split down). */
export type SplitDirection = "row" | "column";
export type PaneDirection = "left" | "right" | "up" | "down";
export type LayoutNode =
  | { kind: "pane"; sessionId: string }
  | {
      kind: "split";
      direction: SplitDirection;
      /** Share of the first child, MIN_RATIO..MAX_RATIO. */
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };
export interface Tab {
  id: string;
  root: LayoutNode;
  /** The active pane's session. */
  active: string;
  /** `focus` shows only the active pane; the others stay mounted. */
  mode: "split" | "focus";
}
export interface Placement {
  target: string;
  direction: SplitDirection;
}
export interface Workspace {
  tabs: Tab[];
  activeTab: string | null;
  /** Taken out of the layout while their close is in flight; never re-added unless restored. */
  closing: string[];
  /**
   * Sessions whose Connect/Split result arrived before the terminal state listed them: `null`
   * gives a new active tab, a placement splits beside its target.
   */
  pending: Record<string, Placement | null>;
  /** Template Connect results may precede the first state listing their IDs. */
  awaitingTemplate?: string[];
  serial: number;
}

// ponytail: 4 panes per tab keeps every pane usable at 960×640; Termius allows 16.
export const MAX_PANES = 4;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;
export const RATIO_STEP = 0.05;

export const emptyWorkspace: Workspace = Object.freeze({
  tabs: [],
  activeTab: null,
  closing: [],
  pending: {},
  serial: 0,
}) as Workspace;

export type LayoutAction =
  | { type: "reconcile"; sessions: readonly string[] }
  | { type: "reveal"; sessionId: string }
  | { type: "split"; target: string; direction: SplitDirection; sessionId: string }
  | { type: "merge"; source: string; target: string; direction?: SplitDirection }
  | { type: "move-to-new-tab"; sessionId: string }
  | { type: "close"; sessionId: string }
  | { type: "restore"; sessionId: string }
  | { type: "focus-pane"; sessionId: string }
  | { type: "cycle-pane"; step: 1 | -1 }
  | { type: "set-ratio"; tabId: string; path: string; ratio: number }
  | { type: "toggle-mode"; tabId?: string }
  | { type: "activate-tab"; tabId: string }
  | { type: "activate-index"; index: number | "last" }
  | { type: "cycle-tab"; step: 1 | -1 }
  | { type: "append-template"; tabs: Omit<Tab, "id">[]; activeTab: number; newSessionIds: readonly string[] }
  | { type: "owner-reset" };

export function panes(node: LayoutNode): string[] {
  return node.kind === "pane" ? [node.sessionId] : [...panes(node.first), ...panes(node.second)];
}
export function tabOf(workspace: Workspace, sessionId: string): Tab | undefined {
  return workspace.tabs.find((tab) => panes(tab.root).includes(sessionId));
}
export function activeTab(workspace: Workspace): Tab | undefined {
  return workspace.tabs.find((tab) => tab.id === workspace.activeTab);
}
export const clampRatio = (ratio: number) =>
  Math.min(MAX_RATIO, Math.max(MIN_RATIO, Number.isFinite(ratio) ? ratio : 0.5));

const leaf = (sessionId: string): LayoutNode => ({ kind: "pane", sessionId });

function without(node: LayoutNode, sessionId: string): LayoutNode | null {
  if (node.kind === "pane") return node.sessionId === sessionId ? null : node;
  const first = without(node.first, sessionId);
  const second = without(node.second, sessionId);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** The pane that takes a removed pane's place: the nearest one of its promoted sibling. */
function successor(node: LayoutNode, sessionId: string): string | undefined {
  if (node.kind === "pane") return undefined;
  if (node.first.kind === "pane" && node.first.sessionId === sessionId) return panes(node.second)[0];
  if (node.second.kind === "pane" && node.second.sessionId === sessionId) return panes(node.first).at(-1);
  return successor(node.first, sessionId) ?? successor(node.second, sessionId);
}

function replaceLeaf(node: LayoutNode, sessionId: string, next: LayoutNode): LayoutNode {
  if (node.kind === "pane") return node.sessionId === sessionId ? next : node;
  return { ...node, first: replaceLeaf(node.first, sessionId, next), second: replaceLeaf(node.second, sessionId, next) };
}

function updateAt(node: LayoutNode, path: string, ratio: number): LayoutNode {
  if (node.kind === "pane") return node;
  if (path === "") return { ...node, ratio: clampRatio(ratio) };
  const [step, rest] = [path[0], path.slice(1)];
  return step === "0"
    ? { ...node, first: updateAt(node.first, rest, ratio) }
    : { ...node, second: updateAt(node.second, rest, ratio) };
}

function mapTab(workspace: Workspace, id: string, change: (tab: Tab) => Tab): Workspace {
  return { ...workspace, tabs: workspace.tabs.map((tab) => (tab.id === id ? change(tab) : tab)) };
}

function addTab(workspace: Workspace, sessionId: string, activate: boolean): Workspace {
  const serial = workspace.serial + 1;
  const tab: Tab = { id: `tab-${serial}`, root: leaf(sessionId), active: sessionId, mode: "split" };
  return {
    ...workspace,
    serial,
    tabs: [...workspace.tabs, tab],
    activeTab: activate || workspace.activeTab === null ? tab.id : workspace.activeTab,
  };
}

/** Removes a pane; its sibling is promoted, an emptied tab goes and its neighbour becomes active. */
function detach(workspace: Workspace, sessionId: string): Workspace {
  const index = workspace.tabs.findIndex((tab) => panes(tab.root).includes(sessionId));
  if (index < 0) return workspace;
  const tab = workspace.tabs[index]!;
  const root = without(tab.root, sessionId);
  if (!root) {
    const tabs = workspace.tabs.filter((_, at) => at !== index);
    const activeTab =
      workspace.activeTab === tab.id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : workspace.activeTab;
    return { ...workspace, tabs, activeTab };
  }
  const active = tab.active === sessionId ? successor(tab.root, sessionId)! : tab.active;
  const mode = root.kind === "pane" ? "split" : tab.mode;
  return mapTab(workspace, tab.id, (current) => ({ ...current, root, active, mode }));
}

function insert(workspace: Workspace, target: string, sessionId: string, direction: SplitDirection): Workspace | null {
  const tab = tabOf(workspace, target);
  if (!tab || panes(tab.root).length >= MAX_PANES) return null;
  const root = replaceLeaf(tab.root, target, {
    kind: "split",
    direction,
    ratio: 0.5,
    first: leaf(target),
    second: leaf(sessionId),
  });
  return { ...mapTab(workspace, tab.id, (current) => ({ ...current, root, active: sessionId })), activeTab: tab.id };
}

/** Moves an existing pane beside another; refused (null) when the target tab is full. */
function moveBeside(workspace: Workspace, source: string, target: string, direction: SplitDirection): Workspace | null {
  if (source === target || !tabOf(workspace, source) || !tabOf(workspace, target)) return null;
  return insert(detach(workspace, source), target, source, direction);
}

const placed = (workspace: Workspace) => new Set(workspace.tabs.flatMap((tab) => panes(tab.root)));

export function layoutReducer(workspace: Workspace, action: LayoutAction): Workspace {
  switch (action.type) {
    case "reconcile": {
      const present = new Set(action.sessions);
      let next = workspace;
      const awaiting = new Set(workspace.awaitingTemplate ?? []);
      for (const id of placed(workspace)) if (!present.has(id) && !awaiting.has(id)) next = detach(next, id);
      next = { ...next, closing: next.closing.filter((id) => present.has(id) || awaiting.has(id)) };
      const known = new Set([...placed(next), ...next.closing]);
      const pending = { ...next.pending };
      for (const id of action.sessions) {
        if (known.has(id)) continue;
        const placement = pending[id];
        delete pending[id];
        next =
          (placement && insert(next, placement.target, id, placement.direction)) ??
          addTab(next, id, placement !== undefined);
      }
      return { ...next, pending, awaitingTemplate: [...awaiting].filter((id) => !present.has(id)) };
    }
    case "append-template": {
      const allowed = new Set(action.newSessionIds.filter((id) => !workspace.closing.includes(id)));
      const used = new Set<string>();
      function prune(node: LayoutNode): LayoutNode | null {
        if (node.kind === "pane") {
          if (!allowed.has(node.sessionId) || used.has(node.sessionId)) return null;
          used.add(node.sessionId);
          return node;
        }
        const first = prune(node.first), second = prune(node.second);
        if (!first) return second;
        if (!second) return first;
        return { ...node, first, second };
      }
      let next = workspace;
      // Only allocation IDs belonging to this operation may move out of auto-created tabs.
      for (const id of allowed) next = detach(next, id);
      const pending = { ...next.pending };
      for (const id of allowed) delete pending[id];
      const awaiting = new Set(workspace.awaitingTemplate ?? []);
      const alreadyListed = placed(workspace);
      const tabs = [...next.tabs];
      const appended: { id: string; source: number }[] = [];
      let serial = next.serial;
      action.tabs.forEach((tab, index) => {
        const root = prune(tab.root);
        if (!root) return;
        const ids = panes(root);
        for (const id of ids) if (!alreadyListed.has(id)) awaiting.add(id);
        const id = `tab-${++serial}`;
        tabs.push({ id, root, active: ids.includes(tab.active) ? tab.active : ids[0]!, mode: root.kind === "pane" ? "split" : tab.mode });
        appended.push({ id, source: index });
      });
      let active = (appended.find((tab) => tab.source >= action.activeTab) ?? appended.at(-1))?.id ?? next.activeTab;
      if (!tabs.some((tab) => tab.id === active)) active = tabs.at(-1)?.id ?? null;
      return { ...next, tabs, serial, activeTab: active, pending, awaitingTemplate: [...awaiting] };
    }
    case "reveal":
      if (tabOf(workspace, action.sessionId)) return layoutReducer(workspace, { type: "focus-pane", sessionId: action.sessionId });
      // A closing session is never placed again, so an entry for it would only linger.
      return workspace.closing.includes(action.sessionId)
        ? workspace
        : { ...workspace, pending: { ...workspace.pending, [action.sessionId]: workspace.pending[action.sessionId] ?? null } };
    case "split": {
      if (action.sessionId === action.target) return workspace;
      if (!tabOf(workspace, action.sessionId))
        return {
          ...workspace,
          pending: { ...workspace.pending, [action.sessionId]: { target: action.target, direction: action.direction } },
        };
      return moveBeside(workspace, action.sessionId, action.target, action.direction) ?? workspace;
    }
    case "merge":
      return moveBeside(workspace, action.source, action.target, action.direction ?? "row") ?? workspace;
    case "move-to-new-tab": {
      const tab = tabOf(workspace, action.sessionId);
      if (!tab || tab.root.kind === "pane") return workspace;
      return addTab(detach(workspace, action.sessionId), action.sessionId, true);
    }
    case "close": {
      const next = detach(workspace, action.sessionId);
      return next.closing.includes(action.sessionId)
        ? next
        : { ...next, closing: [...next.closing, action.sessionId] };
    }
    case "restore": {
      if (!workspace.closing.includes(action.sessionId)) return workspace;
      const next = { ...workspace, closing: workspace.closing.filter((id) => id !== action.sessionId) };
      return tabOf(next, action.sessionId) ? next : addTab(next, action.sessionId, true);
    }
    case "focus-pane": {
      const tab = tabOf(workspace, action.sessionId);
      if (!tab) return workspace;
      if (tab.active === action.sessionId && workspace.activeTab === tab.id) return workspace;
      return { ...mapTab(workspace, tab.id, (current) => ({ ...current, active: action.sessionId })), activeTab: tab.id };
    }
    case "cycle-pane": {
      const tab = activeTab(workspace);
      if (!tab) return workspace;
      const order = panes(tab.root);
      const at = order.indexOf(tab.active);
      const sessionId = order[(at + action.step + order.length) % order.length]!;
      return layoutReducer(workspace, { type: "focus-pane", sessionId });
    }
    case "set-ratio":
      return mapTab(workspace, action.tabId, (tab) => ({ ...tab, root: updateAt(tab.root, action.path, action.ratio) }));
    case "toggle-mode": {
      const id = action.tabId ?? workspace.activeTab;
      const tab = workspace.tabs.find((row) => row.id === id);
      if (!tab || tab.root.kind === "pane") return workspace;
      return mapTab(workspace, tab.id, (current) => ({ ...current, mode: current.mode === "split" ? "focus" : "split" }));
    }
    case "activate-tab":
      return workspace.tabs.some((tab) => tab.id === action.tabId) && workspace.activeTab !== action.tabId
        ? { ...workspace, activeTab: action.tabId }
        : workspace;
    case "activate-index": {
      const tab = action.index === "last" ? workspace.tabs.at(-1) : workspace.tabs[action.index];
      return tab ? layoutReducer(workspace, { type: "activate-tab", tabId: tab.id }) : workspace;
    }
    case "cycle-tab": {
      const count = workspace.tabs.length;
      if (count === 0) return workspace;
      const at = workspace.tabs.findIndex((tab) => tab.id === workspace.activeTab);
      const tab = workspace.tabs[(Math.max(at, 0) + action.step + count) % count]!;
      return layoutReducer(workspace, { type: "activate-tab", tabId: tab.id });
    }
    case "owner-reset":
      return emptyWorkspace;
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PaneRect extends Rect {
  sessionId: string;
}
/** A split's own rectangle; its divider sits at `ratio` across it. */
export interface SeparatorRect extends Rect {
  path: string;
  direction: SplitDirection;
  ratio: number;
}
const unit: Rect = { x: 0, y: 0, width: 1, height: 1 };

function halves(rect: Rect, direction: SplitDirection, ratio: number): [Rect, Rect] {
  if (direction === "row") {
    const width = rect.width * ratio;
    return [
      { ...rect, width },
      { ...rect, x: rect.x + width, width: rect.width - width },
    ];
  }
  const height = rect.height * ratio;
  return [
    { ...rect, height },
    { ...rect, y: rect.y + height, height: rect.height - height },
  ];
}

/** Pane rectangles as fractions of the layer. */
export function paneRects(node: LayoutNode, rect: Rect = unit): PaneRect[] {
  if (node.kind === "pane") return [{ ...rect, sessionId: node.sessionId }];
  const [first, second] = halves(rect, node.direction, node.ratio);
  return [...paneRects(node.first, first), ...paneRects(node.second, second)];
}

/** Paths step "0" into `first` and "1" into `second`; "" is the root. */
export function separators(node: LayoutNode, rect: Rect = unit, path = ""): SeparatorRect[] {
  if (node.kind === "pane") return [];
  const [first, second] = halves(rect, node.direction, node.ratio);
  return [
    { ...rect, path, direction: node.direction, ratio: node.ratio },
    ...separators(node.first, first, `${path}0`),
    ...separators(node.second, second, `${path}1`),
  ];
}

const EPSILON = 1e-6;
/** The adjacent pane in a direction: nearest edge first, then the longest shared edge. */
export function neighbor(rects: readonly PaneRect[], active: string, direction: PaneDirection): string | null {
  const from = rects.find((rect) => rect.sessionId === active);
  if (!from) return null;
  const horizontal = direction === "left" || direction === "right";
  let best: { id: string; gap: number; overlap: number } | undefined;
  for (const rect of rects) {
    if (rect.sessionId === active) continue;
    const gap =
      direction === "right" ? rect.x - (from.x + from.width)
      : direction === "left" ? from.x - (rect.x + rect.width)
      : direction === "down" ? rect.y - (from.y + from.height)
      : from.y - (rect.y + rect.height);
    if (gap < -EPSILON) continue;
    const overlap = horizontal
      ? Math.min(from.y + from.height, rect.y + rect.height) - Math.max(from.y, rect.y)
      : Math.min(from.x + from.width, rect.x + rect.width) - Math.max(from.x, rect.x);
    if (overlap <= EPSILON) continue;
    if (!best || gap < best.gap - EPSILON || (Math.abs(gap - best.gap) <= EPSILON && overlap > best.overlap + EPSILON))
      best = { id: rect.sessionId, gap, overlap };
  }
  return best?.id ?? null;
}
