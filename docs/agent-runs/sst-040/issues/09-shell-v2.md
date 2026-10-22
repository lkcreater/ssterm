# 09: Shell v2: sidebar, page headers and Terminals page

**What to build:** The titlebar holds only traffic lights and a drag region; the sidebar shows icon v2, the nine pages, the group tree and a footer with Settings and Keyboard shortcuts; every page has a title/subtitle/actions header; session tabs and terminal actions live on the Terminals page; panes have their own header and status bar.

**Blocked by:** 01 — Charcoal tokens, terminal palette and icon v2

**Status:** done

- [ ] Titlebar contains no tabs or buttons besides traffic lights and drag region
- [ ] Sidebar shows icon v2 without wordmark, the nine pages, the existing nested group tree with counts, and Settings/Keyboard shortcuts in its footer
- [ ] Each page has a header with title, subtitle and its primary actions
- [ ] Terminals page owns the session tab strip (status dot, label, PROD badge; no '+') and New local terminal, Split right, Split down and Workspace tools
- [ ] Pane header shows user@host:port (or Local · This Mac), environment badge and a ⋯ menu of existing actions; pane status bar shows state, target and environment; focused pane has a blue outline
- [ ] Global status bar is removed
- [ ] Every existing keyboard shortcut still works
- [ ] E2E selectors that used titlebar tabs/buttons are updated; all specs pass
