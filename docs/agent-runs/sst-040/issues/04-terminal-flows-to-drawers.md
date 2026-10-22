# 04: Terminal flows as drawers

**What to build:** Snippet Paste/Run composer, workspace templates, explicit multi-target composer, close-tab confirmation, terminal overlays and the keyboard shortcuts list open as drawers.

**Blocked by:** 02 — Drawer primitive with Server and Group editors

**Status:** ready-for-agent

- [ ] Paste/Run drawer shows the captured target prominently; switching tab or pane afterwards never changes it
- [ ] PROD Run requires an explicit confirmation step inside the drawer; Paste and Run stay distinct
- [ ] Workspace templates and multi-target composer are drawers; ordinary typing stays pane-local
- [ ] Close-tab/session confirmation is a drawer step
- [ ] Shortcuts drawer lists only real shortcuts
- [ ] Esc in any of these never reaches the terminal; snippet-run, workspace-tools, workspace and terminal E2E keep their behavioral assertions
