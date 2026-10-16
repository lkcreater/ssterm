# SST-018 delivery — tabs, splits, settings and the terminal-first shell

**Scope:** SST-018/T024 with DS04/T050 DONE through independent TEST/REVIEW/DELIVER under the standing loop instruction after SST-017 `fd84629`; local commit only, no push, PR or deployment.

## Delivered behavior

Terminals live in tabs that hold up to four split panes. Splitting, merging, moving panes between tabs and switching Focus/Split never reconnect or lose history, and hidden panes keep streaming. Shortcuts cover splits, pane and tab navigation, closing, the sidebar, settings and a shortcut list without ever sending input to a shell. Closing a connected pane or tab asks in-app; closing the window or quitting with connected sessions asks with a native sheet. Font size, scrollback and cursor settings persist and apply live. The shell is terminal-first: a 40 px titlebar with tabs, a collapsible sidebar and more vertical space for terminals.

## Acceptance and boundaries

Acceptance covered: basic tabs and H/V splits with two or more sessions; Focus/Split without disconnect; correct active pane, focus and resize; close prompts by active resources; persisted font, theme and scrollback; no automatic command restore or broadcast; DS04 shell items at 960×640. Option-as-Meta and UI font or motion settings need a schema migration and stay deferred.

## Verification evidence

- Final source: typecheck PASS; unit **285/285**; build PASS; development E2E **48/48**; unsigned macOS arm64 package PASS; packaged E2E **45/45**.
- Independent tester: suites on the reviewed tree, workspace and settings specs repeated, packaged probes (drags, resizes, sheets, IME, reduced motion, accessibility, four-session flood within the SST-014 budget). Independent review: no critical/high; two mediums and the lows fixed before the final suites.

See [detailed evidence](../workspace.md) and [execution record](implementation-plan.md#final-sst-018-record--2026-10-17).

## Impact and rollback

Settings use the existing AppSettings row; no schema change. Roll back by restoring the stacked workspace, toolbars, previous menu and window options and removing the settings IPC.
