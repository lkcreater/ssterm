# SST-018 — Tabs, splits, settings and the terminal-first shell (DS04)

**2026-10-17 · T024 + T050 · DONE through independent TEST/REVIEW/DELIVER; committed under the standing loop instruction.** Authorized by the standing loop instruction after SST-017 commit `fd84629`. Scope is the terminal workspace (tabs, split panes, Focus/Split, focus and shortcuts, close prompts), persisted terminal settings and the DS04 shell. Session restore after restart, broadcast input and Option-as-Meta are not included. [Execution plan](agent-runs/implementation-plan.md#sst-018-execution-plan--2026-10-17).

## Workspace model

Each terminal keeps one xterm for its whole life, so the workspace never re-parents panes. Every pane is a sibling in one layer, keyed by session and positioned from the active tab's layout: tabs hold binary split trees of up to four panes with ratios from 20 % to 80 %. Splitting, merging another tab's session into a split, moving a pane to a new tab and switching between Focus and Split change layout state only; the session, its history and its generation are untouched. Panes that are not visible (other tabs, Focus mode, or the whole layer while a hosts, identities or known-hosts page is shown) are hidden with `visibility:hidden` and `inert` at their real size rather than removed, so every session opens, streams and reports remote exits even before it is first viewed. This removes the SST-012 limitation that a never-viewed session stayed paused.

New sessions get a tab; Split right or down opens a new session to the same host. Separators are accessible (`role=separator`, arrow keys ±5 %, Home/End). The active pane has a blue edge separate from its connection status, and its full target is selectable in the status bar.

## Shortcuts and closing

One capture listener matches shortcuts by physical key where needed so they work under Thai and other layouts: ⌘D / ⇧⌘D split, ⌘W close pane, ⇧⌘↩ Focus/Split, ⌥⌘ arrows move between panes, ⌘1–⌘9 tabs, ⇧⌘] / ⇧⌘[ next and previous tab, ⌃⌘S sidebar, ⌘, settings, ⌘/ shortcut list. Ctrl and Option combinations still reach the shell, and shortcuts never send input. Close Window moved to ⇧⌘W so ⌘W closes a pane. Closing a pane or tab with a connected session asks in-app (Cancel focused, then disconnect and close); ended or connecting panes close directly. Closing the window or quitting while sessions are connected asks with a native sheet listing them with PROD, then the existing bounded quit runs.

## Settings

Font size (10–32), scrollback (100–100,000 lines), cursor style and cursor blink persist in SQLite through a validated `settings`/`updateSettings` IPC and apply to open terminals immediately; blink is off under Reduce motion. Settings writes no longer advance the catalog revision, so they cannot invalidate an open catalog preview. A terminal's scrollback is fixed when it opens at `min(setting, max(100, 320,000 / open terminals))`, so opening or closing sessions never trims another pane's history; changing the scrollback setting re-applies the rule to every open terminal (a lower value removes older lines, as the dialog says). Total scrollback therefore stays near the previous worst case but can exceed it when many terminals open after a high setting. Colors stay Signal Blue Dark.

## Shell (DS04)

The macOS titlebar is hidden in favor of one 40 px bar with a traffic-light safe area, a sidebar toggle, the tab strip and Settings; interactive elements opt out of window dragging. The sidebar is a collapsible 200–400 px panel holding search, groups, tags, Identities and footer entries for Settings and shortcuts. The previous app and workspace toolbars are gone, giving the terminal about 124 px more height at 960×640. Tabs show the active pane's label, PROD and an icon status with accessible text.

## Verification

Final source: `npm run typecheck` PASS, `npm test` **285/285**, `npm run build` PASS, `npm run test:e2e` **48/48**, `npm run package:mac` PASS (unsigned arm64), `npm run test:packaged` **45/45**.

[Layout](../tests/unit/workspace-layout.test.ts) and [shortcut](../tests/unit/workspace-shortcuts.test.ts) unit tests cover split, merge, move, close with sibling promotion, the four-pane cap, ratio clamps, rectangles and neighbours, Focus mode on single panes, pending placement, scrollback rules and key-code matching under Latin, Thai, Russian, Dvorak and AZERTY layouts; [settings tests](../tests/unit/settings-boundary.test.ts) cover validation, persistence and the unchanged catalog revision. [Workspace E2E](../tests/e2e/workspace.spec.ts) on Docker OpenSSH: tabs, Split via ⌘D to the same host, merge, Focus/Split and move-to-tab while a remote loop runs (same generation, unbroken output, searchable history, `stty size` following geometry), pane and tab shortcuts with `read` proving no keystroke leaks, keyboard separators, ⌘W prompts, native close/quit sheets with stubbed dialogs, live font refit, scrollback trimming only on a setting change (opening a fourth session keeps others' history), a never-shown tab observing `exit 7`, Copy target via an intercepted copy event, and visual checks at 960×640 and 1280×800 (compact pane headers, titlebar drag regions and traffic-light clearance, collapsible sidebar, ten Thai tabs). [Settings E2E](../tests/e2e/settings.spec.ts): inline validation, persistence across relaunch, unavailable storage and ⌘W with no sessions.

The independent tester confirmed mouse separator and sidebar drags, window resizes, close/quit sheet behavior, IME in number fields, reduced motion, accessible names, and a four-session flood with hidden tabs within the SST-014 budget (no long tasks, 36–41 MiB/s). Review found no critical/high; two mediums (opening sessions trimmed other panes' scrollback; a clicked tab plus Backspace closed it) and the lows were fixed. Real AppKit key delivery could not be exercised without Accessibility permission; menu accelerators were verified instead.

## Boundaries and rollback

Layout and open sessions are not persisted. Narrow split panes use a compact header (full target in the tooltip and status bar). Theme persistence is satisfied by the single Signal Blue Dark theme; theme switching is later scope. Split panes to the same host share the same accessible region name. With scrollback at 100,000 and four panes the renderer used ≈ 728 MiB. Rollback restores the stacked workspace and toolbars, the previous menu and window options, and removes the settings IPC; stored settings remain valid.

# Saved templates and explicit multi-target input — SST-033

[Workspace tools](workspace-tools.md) adds optional saved configurations to the transient SST-018 workspace: restoring opens fresh sessions and appends tabs/splits, without restoring history or remote processes. An optional saved-snippet reference requires opt-in preparation and subsequent Arm/Insert/Run. Existing panes remain mounted. Broadcast is an explicitly armed text composer; ordinary typing remains local to its pane. [Delivery evidence](agent-runs/sst-033-delivery.md).
