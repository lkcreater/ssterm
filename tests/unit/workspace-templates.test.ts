import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { TerminalSession, WorkspaceTemplateConfiguration } from "../../packages/contracts/src/index.ts";
import { captureWorkspaceTemplate, materializeWorkspaceTemplate } from "../../apps/desktop/src/renderer/src/lib/workspace-templates.ts";
import { emptyWorkspace, layoutReducer, panes, type LayoutAction, type Workspace } from "../../apps/desktop/src/renderer/src/lib/workspace-layout.ts";
import { isWorkspaceTemplateConfiguration } from "../../packages/domain/src/workspace-templates.ts";

const host = "11111111-1111-4111-8111-111111111111";
const snippet = "22222222-2222-4222-8222-222222222222";
const apply = (workspace: Workspace, ...actions: LayoutAction[]) => actions.reduce(layoutReducer, workspace);
const session = (sessionId: string): TerminalSession => ({ sessionId, generation: 1, hostId: host, phase: "ready", target: null, end: null, error: null });
function template(): WorkspaceTemplateConfiguration {
  return { version: 1, tabs: [
    { root: { kind: "split", direction: "column", ratio: 0.35,
      first: { kind: "pane", slotId: "one", hostId: host },
      second: { kind: "pane", slotId: "two", hostId: host } }, activeSlot: "two", mode: "focus" },
    { root: { kind: "pane", slotId: "three", hostId: host }, activeSlot: "three", mode: "split" },
  ], activeTab: 1, snippetId: snippet };
}
test("capture persists only host/snippet references and exact tab geometry, with distinct duplicate-host slots", () => {
  let workspace = apply(emptyWorkspace, { type: "reconcile", sessions: ["a", "b", "c"] }, { type: "merge", source: "b", target: "a", direction: "column" });
  workspace = apply(workspace, { type: "set-ratio", tabId: workspace.tabs[0]!.id, path: "", ratio: 0.35 }, { type: "toggle-mode" }, { type: "activate-index", index: 1 });
  const captured = captureWorkspaceTemplate(workspace, [session("a"), session("b"), session("c")], snippet)!;
  assert.ok(isWorkspaceTemplateConfiguration(captured));
  assert.equal(captured.tabs[0]!.mode, "focus");
  assert.equal(captured.activeTab, 1);
  const serialized = JSON.stringify(captured);
  assert.ok(!serialized.includes("sessionId") && !serialized.includes("generation") && !serialized.includes("target"));
  assert.equal(captured.snippetId, snippet);
  const restored = materializeWorkspaceTemplate(captured, new Map([["slot-1", "new-a"], ["slot-2", "new-b"], ["slot-3", "new-c"]]));
  assert.deepEqual(restored.tabs.map((tab) => panes(tab.root)), [["new-a", "new-b"], ["new-c"]]);
  assert.equal(restored.tabs[0]!.root.kind === "split" && restored.tabs[0]!.root.ratio, 0.35);
  assert.equal(restored.tabs[0]!.active, "new-b");
});
test("capture prunes closing/unlisted panes and refuses empty or over-eight configuration", () => {
  const workspace = apply(emptyWorkspace, { type: "reconcile", sessions: ["a", "b"] }, { type: "close", sessionId: "a" });
  assert.equal(captureWorkspaceTemplate(workspace, []), null);
  const captured = captureWorkspaceTemplate(workspace, [session("a"), session("b")])!;
  assert.equal(captured.tabs.length, 1);
  assert.equal(captured.tabs[0]!.root.kind, "pane");
  const ids = Array.from({ length: 9 }, (_, index) => `s${index}`);
  assert.equal(captureWorkspaceTemplate(apply(emptyWorkspace, { type: "reconcile", sessions: ids }), ids.map(session)), null);
});
test("template capture excludes local panes and collapses their split without saving process data", () => {
  const workspace = apply(emptyWorkspace, { type: "reconcile", sessions: ["ssh", "local"] }, { type: "merge", source: "local", target: "ssh" });
  const local: TerminalSession = { ...session("local"), hostId: null, local: { shell: "zsh", platform: "darwin" } };
  const captured = captureWorkspaceTemplate(workspace, [session("ssh"), local])!;
  assert.equal(captured.tabs.length, 1);
  assert.deepEqual(captured.tabs[0]!.root, { kind: "pane", slotId: "slot-1", hostId: host });
  assert.equal(captured.tabs[0]!.activeSlot, "slot-1");
  assert.ok(!JSON.stringify(captured).includes("zsh"));
  assert.equal(captureWorkspaceTemplate(workspace, [local]), null);
});
test("materialization prunes failed allocations, keeps surviving focus/ratios, and never duplicates a session", () => {
  const full = materializeWorkspaceTemplate(template(), new Map([["one", "a"], ["two", "b"], ["three", "c"]]));
  assert.equal(full.tabs[0]!.mode, "focus");
  assert.equal(full.activeTab, 1);
  const partial = materializeWorkspaceTemplate(template(), new Map([["one", "a"], ["three", "c"]]));
  assert.deepEqual(partial.tabs[0], { root: { kind: "pane", sessionId: "a" }, active: "a", mode: "split" });
  assert.equal(partial.activeTab, 1);
  const duplicate = materializeWorkspaceTemplate(template(), new Map([["one", "a"], ["two", "a"]]));
  assert.deepEqual(duplicate.tabs.map((tab) => panes(tab.root)), [["a"]]);
  assert.equal(duplicate.activeTab, 0);
  assert.deepEqual(materializeWorkspaceTemplate(template(), new Map()), { tabs: [], activeTab: 0 });
});
test("append-template preserves existing tab identity, mounts and serial while regrouping only new auto-listed IDs", () => {
  const before = apply(emptyWorkspace, { type: "reconcile", sessions: ["old"] });
  const alreadyListed = apply(before, { type: "reconcile", sessions: ["old", "a", "b", "c"] });
  const layout = materializeWorkspaceTemplate(template(), new Map([["one", "a"], ["two", "b"], ["three", "c"]]));
  const appended = apply(alreadyListed, { type: "append-template", ...layout, newSessionIds: ["a", "b", "c"] });
  assert.equal(appended.tabs[0], before.tabs[0]);
  assert.deepEqual(appended.tabs.map((tab) => panes(tab.root)), [["old"], ["a", "b"], ["c"]]);
  assert.equal(appended.serial, alreadyListed.serial + 2);
  assert.equal(appended.activeTab, appended.tabs[2]!.id);
  assert.deepEqual(appended.awaitingTemplate, []);
  assert.deepEqual(apply(appended, { type: "reconcile", sessions: ["old", "a", "b", "c"] }).tabs, appended.tabs);
});
test("Connect response before terminal state retains saved shape across intermediate state and removes pending markers once listed", () => {
  const before = apply(emptyWorkspace, { type: "reconcile", sessions: ["old"] });
  const layout = materializeWorkspaceTemplate(template(), new Map([["one", "a"], ["two", "b"], ["three", "c"]]));
  const appended = apply(before, { type: "append-template", ...layout, newSessionIds: ["a", "b", "c"] });
  let next = apply(appended, { type: "reconcile", sessions: ["old"] });
  assert.deepEqual(next.tabs, appended.tabs);
  next = apply(next, { type: "reconcile", sessions: ["old", "a"] });
  assert.deepEqual(next.tabs, appended.tabs);
  assert.deepEqual(next.awaitingTemplate, ["b", "c"]);
  next = apply(next, { type: "reconcile", sessions: ["old", "a", "b", "c"] });
  assert.deepEqual(next.tabs, appended.tabs);
  assert.deepEqual(next.awaitingTemplate, []);
  next = apply(next, { type: "reconcile", sessions: ["old", "a", "c"] });
  assert.deepEqual(next.tabs.map((tab) => panes(tab.root)), [["old"], ["a"], ["c"]]);
});
test("closing an awaiting template pane never resurrects it when a delayed state arrives", () => {
  const layout = materializeWorkspaceTemplate(template(), new Map([["one", "a"], ["two", "b"]]));
  let workspace = apply(emptyWorkspace, { type: "append-template", ...layout, newSessionIds: ["a", "b"] }, { type: "close", sessionId: "b" });
  workspace = apply(workspace, { type: "reconcile", sessions: [] });
  assert.deepEqual(workspace.closing, ["b"]);
  workspace = apply(workspace, { type: "reconcile", sessions: ["a", "b"] });
  assert.deepEqual(workspace.tabs.map((tab) => panes(tab.root)), [["a"]]);
  workspace = apply(workspace, { type: "reconcile", sessions: ["a"] });
  assert.deepEqual(workspace.closing, []);
});
test("append pruning refuses old or closing IDs and duplicated leaves", () => {
  const before = apply(emptyWorkspace, { type: "reconcile", sessions: ["old", "closed"] }, { type: "close", sessionId: "closed" });
  const layout = materializeWorkspaceTemplate(template(), new Map([["one", "old"], ["two", "closed"], ["three", "new"]]));
  const next = apply(before, { type: "append-template", ...layout, newSessionIds: ["closed", "new"] });
  assert.equal(next.tabs[0], before.tabs[0]);
  assert.deepEqual(next.tabs.map((tab) => panes(tab.root)), [["old"], ["new"]]);
  const duplicate = apply(emptyWorkspace, { type: "append-template", tabs: [
    { root: { kind: "pane", sessionId: "a" }, active: "a", mode: "split" },
    { root: { kind: "pane", sessionId: "a" }, active: "a", mode: "split" },
  ], activeTab: 1, newSessionIds: ["a"] });
  assert.deepEqual(duplicate.tabs.map((tab) => panes(tab.root)), [["a"]]);
});
