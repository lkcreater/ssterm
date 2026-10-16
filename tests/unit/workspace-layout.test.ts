import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  activeTab,
  emptyWorkspace,
  layoutReducer,
  MAX_PANES,
  neighbor,
  paneRects,
  panes,
  separators,
  tabOf,
  type LayoutAction,
  type Workspace,
} from "../../apps/desktop/src/renderer/src/lib/workspace-layout.ts";
import {
  effectiveScrollback,
  paneScrollback,
  SCROLLBACK_BUDGET,
} from "../../apps/desktop/src/renderer/src/lib/terminal-theme.ts";

const apply = (workspace: Workspace, ...actions: LayoutAction[]) => actions.reduce(layoutReducer, workspace);
const reconcile = (...sessions: string[]): LayoutAction => ({ type: "reconcile", sessions });
const shape = (workspace: Workspace) =>
  workspace.tabs.map((tab) => ({ panes: panes(tab.root), active: tab.active, mode: tab.mode }));

test("reconcile gives each new session a tab and activates only when nothing is active", () => {
  const workspace = apply(emptyWorkspace, reconcile("a", "b"));
  assert.deepEqual(shape(workspace), [
    { panes: ["a"], active: "a", mode: "split" },
    { panes: ["b"], active: "b", mode: "split" },
  ]);
  assert.equal(activeTab(workspace)?.active, "a");
  assert.equal(apply(workspace, reconcile("a", "b", "c")).activeTab, workspace.activeTab);
});

test("reveal activates a session's tab whether it arrives before or after the state", () => {
  const listedFirst = apply(emptyWorkspace, reconcile("a", "b"), { type: "reveal", sessionId: "b" });
  assert.equal(activeTab(listedFirst)?.active, "b");
  const resultFirst = apply(emptyWorkspace, reconcile("a"), { type: "reveal", sessionId: "b" }, reconcile("a", "b"));
  assert.equal(activeTab(resultFirst)?.active, "b");
  assert.deepEqual(resultFirst.pending, {});
});

test("split places the new session beside its target in either arrival order", () => {
  const split: LayoutAction = { type: "split", target: "a", direction: "row", sessionId: "b" };
  for (const workspace of [
    apply(emptyWorkspace, reconcile("a"), split, reconcile("a", "b")),
    apply(emptyWorkspace, reconcile("a"), reconcile("a", "b"), split),
  ]) {
    assert.deepEqual(shape(workspace), [{ panes: ["a", "b"], active: "b", mode: "split" }]);
    const root = workspace.tabs[0]!.root;
    assert.equal(root.kind === "split" && root.direction, "row");
    assert.deepEqual(workspace.pending, {});
  }
});

test("a full tab refuses another pane; a deferred split then opens a new active tab", () => {
  let workspace = apply(emptyWorkspace, reconcile("a"));
  const ids = ["a"];
  for (const id of ["b", "c", "d"]) {
    ids.push(id);
    workspace = apply(workspace, reconcile(...ids), { type: "merge", source: id, target: "a", direction: "column" });
  }
  assert.equal(panes(workspace.tabs[0]!.root).length, MAX_PANES);
  assert.equal(workspace.tabs.length, 1);
  workspace = apply(workspace, { type: "split", target: "a", direction: "row", sessionId: "e" }, reconcile(...ids, "e"));
  assert.equal(workspace.tabs.length, 2);
  assert.equal(activeTab(workspace)?.active, "e");
  const refused = apply(workspace, { type: "merge", source: "e", target: "a" });
  assert.equal(refused, workspace);
});

test("close promotes the sibling, activates the nearest pane and never re-adds a closing session", () => {
  let workspace = apply(
    emptyWorkspace,
    reconcile("a", "b", "c"),
    { type: "merge", source: "b", target: "a", direction: "row" },
    { type: "merge", source: "c", target: "b", direction: "column" },
  );
  // a | (b / c)
  assert.deepEqual(panes(workspace.tabs[0]!.root), ["a", "b", "c"]);
  workspace = apply(workspace, { type: "focus-pane", sessionId: "b" }, { type: "close", sessionId: "b" });
  assert.equal(workspace.tabs[0]!.active, "c");
  const root = workspace.tabs[0]!.root;
  assert.ok(root.kind === "split" && root.second.kind === "pane" && root.second.sessionId === "c");
  assert.deepEqual(workspace.closing, ["b"]);
  workspace = apply(workspace, reconcile("a", "b", "c"));
  assert.equal(tabOf(workspace, "b"), undefined, "still closing");
  workspace = apply(workspace, reconcile("a", "c"));
  assert.deepEqual(workspace.closing, []);
});

test("closing the second pane activates the last pane of the first half", () => {
  const workspace = apply(
    emptyWorkspace,
    reconcile("a", "b", "c"),
    { type: "merge", source: "b", target: "a", direction: "column" },
    { type: "merge", source: "c", target: "b", direction: "row" },
    { type: "close", sessionId: "c" },
  );
  assert.equal(workspace.tabs[0]!.active, "b");
});

test("restore brings a pane whose close failed back in its own active tab", () => {
  const workspace = apply(
    emptyWorkspace,
    reconcile("a", "b"),
    { type: "close", sessionId: "b" },
    { type: "restore", sessionId: "b" },
  );
  assert.deepEqual(workspace.closing, []);
  assert.equal(activeTab(workspace)?.active, "b");
});

test("closing or losing the active tab activates its right neighbour, else its left", () => {
  let workspace = apply(emptyWorkspace, reconcile("a", "b", "c"), { type: "activate-index", index: 1 });
  workspace = apply(workspace, reconcile("a", "c"));
  assert.equal(activeTab(workspace)?.active, "c");
  workspace = apply(workspace, { type: "close", sessionId: "c" });
  assert.equal(activeTab(workspace)?.active, "a");
  workspace = apply(workspace, { type: "close", sessionId: "a" });
  assert.equal(workspace.activeTab, null);
  assert.deepEqual(workspace.tabs, []);
});

test("move to new tab and merge change layout only", () => {
  let workspace = apply(emptyWorkspace, reconcile("a", "b"), { type: "merge", source: "b", target: "a" });
  assert.equal(workspace.tabs.length, 1);
  const single = apply(emptyWorkspace, reconcile("a"));
  assert.equal(apply(single, { type: "move-to-new-tab", sessionId: "a" }), single, "a lone pane stays");
  workspace = apply(workspace, { type: "move-to-new-tab", sessionId: "a" });
  assert.deepEqual(shape(workspace).map((tab) => tab.panes), [["b"], ["a"]]);
  assert.equal(activeTab(workspace)?.active, "a");
  assert.equal(new Set(workspace.tabs.map((tab) => tab.id)).size, 2, "tab ids stay unique");
});

test("focus mode toggles per tab and pane cycling wraps", () => {
  let workspace = apply(
    emptyWorkspace,
    reconcile("a", "b"),
    { type: "merge", source: "b", target: "a" },
    { type: "toggle-mode" },
  );
  assert.equal(activeTab(workspace)?.mode, "focus");
  workspace = apply(workspace, { type: "cycle-pane", step: 1 });
  assert.equal(activeTab(workspace)?.active, "a");
  workspace = apply(workspace, { type: "cycle-pane", step: -1 }, { type: "toggle-mode" });
  assert.equal(activeTab(workspace)?.active, "b");
  assert.equal(activeTab(workspace)?.mode, "split");
});

test("focus mode needs two panes and ends when one pane remains", () => {
  const single = apply(emptyWorkspace, reconcile("a"));
  assert.equal(apply(single, { type: "toggle-mode" }), single, "a lone pane has no Focus mode");
  let workspace = apply(single, reconcile("a", "b"), { type: "merge", source: "b", target: "a" }, { type: "toggle-mode" });
  assert.equal(activeTab(workspace)?.mode, "focus");
  workspace = apply(workspace, { type: "move-to-new-tab", sessionId: "b" });
  assert.deepEqual(shape(workspace), [
    { panes: ["a"], active: "a", mode: "split" },
    { panes: ["b"], active: "b", mode: "split" },
  ]);
  // A later split shows both panes rather than only the new one.
  workspace = apply(workspace, { type: "merge", source: "b", target: "a" });
  assert.equal(activeTab(workspace)?.mode, "split");
  workspace = apply(workspace, { type: "toggle-mode" }, { type: "close", sessionId: "a" });
  assert.equal(activeTab(workspace)?.mode, "split");
});

test("revealing a closing session leaves no pending entry", () => {
  const workspace = apply(emptyWorkspace, reconcile("a"), { type: "close", sessionId: "a" }, { type: "reveal", sessionId: "a" });
  assert.deepEqual(workspace.pending, {});
  assert.deepEqual(apply(workspace, reconcile()).pending, {});
});

test("tab activation by index, last and wrapping cycle", () => {
  let workspace = apply(emptyWorkspace, reconcile("a", "b", "c"));
  workspace = apply(workspace, { type: "activate-index", index: "last" });
  assert.equal(activeTab(workspace)?.active, "c");
  workspace = apply(workspace, { type: "cycle-tab", step: 1 });
  assert.equal(activeTab(workspace)?.active, "a");
  workspace = apply(workspace, { type: "cycle-tab", step: -1 });
  assert.equal(activeTab(workspace)?.active, "c");
  assert.equal(apply(workspace, { type: "activate-index", index: 7 }), workspace);
});

test("ratios clamp to 0.2–0.8 and owner reset empties everything", () => {
  let workspace = apply(emptyWorkspace, reconcile("a", "b"), { type: "merge", source: "b", target: "a" });
  const tabId = workspace.tabs[0]!.id;
  const ratio = (value: number) => {
    const root = apply(workspace, { type: "set-ratio", tabId, path: "", ratio: value }).tabs[0]!.root;
    return root.kind === "split" ? root.ratio : NaN;
  };
  assert.equal(ratio(0.05), 0.2);
  assert.equal(ratio(0.95), 0.8);
  assert.equal(ratio(0.35), 0.35);
  assert.equal(ratio(Number.NaN), 0.5);
  workspace = apply(workspace, { type: "split", target: "a", direction: "row", sessionId: "z" }, { type: "owner-reset" });
  assert.deepEqual(workspace, emptyWorkspace);
});

test("paneRects, separators and neighbor follow the split tree", () => {
  const workspace = apply(
    emptyWorkspace,
    reconcile("a", "b", "c"),
    { type: "merge", source: "b", target: "a", direction: "row" },
    { type: "merge", source: "c", target: "b", direction: "column" },
  );
  const root = workspace.tabs[0]!.root;
  const rects = paneRects(root);
  assert.deepEqual(rects, [
    { sessionId: "a", x: 0, y: 0, width: 0.5, height: 1 },
    { sessionId: "b", x: 0.5, y: 0, width: 0.5, height: 0.5 },
    { sessionId: "c", x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  ]);
  assert.deepEqual(separators(root), [
    { path: "", direction: "row", ratio: 0.5, x: 0, y: 0, width: 1, height: 1 },
    { path: "1", direction: "column", ratio: 0.5, x: 0.5, y: 0, width: 0.5, height: 1 },
  ]);
  assert.equal(neighbor(rects, "a", "right"), "b", "equal edges: the first, upper pane");
  assert.equal(neighbor(rects, "c", "left"), "a");
  assert.equal(neighbor(rects, "b", "down"), "c");
  assert.equal(neighbor(rects, "c", "up"), "b");
  assert.equal(neighbor(rects, "a", "left"), null);
  assert.equal(neighbor(rects, "b", "up"), null);
  assert.equal(neighbor(rects, "missing", "up"), null);
  // A wider overlap wins at the same distance.
  const skewed = [
    { sessionId: "a", x: 0, y: 0, width: 0.5, height: 1 },
    { sessionId: "b", x: 0.5, y: 0, width: 0.5, height: 0.3 },
    { sessionId: "c", x: 0.5, y: 0.3, width: 0.5, height: 0.7 },
  ];
  assert.equal(neighbor(skewed, "a", "right"), "c");
});

test("effective scrollback shares the budget across mounted panes", () => {
  assert.equal(SCROLLBACK_BUDGET, 320_000);
  assert.equal(effectiveScrollback(10_000, 1), 10_000);
  assert.equal(effectiveScrollback(100_000, 0), 100_000, "no panes counts as one");
  assert.equal(effectiveScrollback(100_000, 4), 80_000);
  assert.equal(effectiveScrollback(100_000, 32), 10_000);
  assert.equal(effectiveScrollback(100_000, 3), 100_000);
  assert.equal(effectiveScrollback(100_000, 7), 45_714);
  assert.equal(effectiveScrollback(100, 32), 100);
  assert.equal(effectiveScrollback(100_000, 5_000), 100, "never below 100 lines");
});

test("a pane keeps the scrollback it was created with until the setting changes", () => {
  let state = paneScrollback({ setting: 100_000, panes: {} }, ["a", "b", "c"], 100_000);
  assert.deepEqual(state.panes, { a: 100_000, b: 100_000, c: 100_000 });
  assert.equal(paneScrollback(state, ["a", "b", "c"], 100_000), state, "unchanged state is returned as is");
  // Opening a fourth pane gives it its share only; lowering the others would delete their history.
  state = paneScrollback(state, ["a", "b", "c", "d"], 100_000);
  assert.deepEqual(state.panes, { a: 100_000, b: 100_000, c: 100_000, d: 80_000 });
  // Closing panes changes nobody either.
  state = paneScrollback(state, ["b", "d"], 100_000);
  assert.deepEqual(state.panes, { b: 100_000, d: 80_000 });
  // A new setting re-applies to every pane at its share of the panes now open.
  state = paneScrollback(state, ["b", "d", "e", "f", "g"], 90_000);
  assert.deepEqual(state.panes, { b: 64_000, d: 64_000, e: 64_000, f: 64_000, g: 64_000 });
  assert.equal(state.setting, 90_000);
  state = paneScrollback(state, ["b"], 5_000);
  assert.deepEqual(state.panes, { b: 5_000 });
});
