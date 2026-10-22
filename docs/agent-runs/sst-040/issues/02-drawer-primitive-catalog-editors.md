# 02: Drawer primitive with Server and Group editors

**What to build:** Add server, Edit server, connection route, Group/tags editors and their delete confirmations open as a right-edge drawer that keeps the Servers screen visible. Expand step of the dialog→drawer migration: the shared drawer exists beside the old dialogs.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] One shared right-edge drawer built on the existing sheet component: full height below the titlebar, 480–560 px (up to 640 for complex review), full content width on small windows, scrim
- [ ] Fixed header (title, optional target, close), scrolling body, fixed footer (Cancel, primary action); field-level validation with summary when useful
- [ ] Focus enters the first field or heading, is trapped, and returns to the opener when it still exists
- [ ] Esc and Cancel go through a dirty/busy policy, show a discard step inside the same drawer when dirty, and never forward keys to a terminal
- [ ] Opens/closes in about 200 ms with transform/opacity; instant with reduced motion
- [ ] Delete host/group confirmation is a step inside the drawer (no stacked overlay), with red specific action
- [ ] Server and group editor flows use the drawer; existing catalog E2E behaviors still pass; new E2E covers placement, focus, Esc, dirty discard, reduced motion and 960×640 without field overflow
