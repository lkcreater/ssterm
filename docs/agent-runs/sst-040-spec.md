# SST-040 spec — UI v2 Charcoal

**Status:** `ready-for-agent` · 2026-10-22 · T054. Decisions: [implementation plan](implementation-plan.md#sst-040-authorization--ui-v2-charcoal-2026-10-22), [ADR 0008](../adr/0008-ui-v2-charcoal.md), [ADR 0004 amendment](../adr/0004-local-app-lock.md#amendment--manual-relock-sst-040-2026-10-22). Tickets: [SST-040 breakdown](sst-040/README.md). Visual reference: [UI v2 handoff](../logo/ui-v2/README.md) (concept PNGs; its visual and drawer contracts govern, not pixels).

## Problem Statement

The current ssterm UI uses the navy Signal Blue look, a titlebar crowded with session tabs and global buttons, centered modal dialogs that hide the screen they act on, and a navy terminal and icon that no longer match the brand. The user has approved a new Charcoal v2 direction (logo, icon and 42 screen concepts) and wants the whole application to look and behave like it, without losing any existing safety behavior (explicit target, PROD labels, trust decisions, Paste/Run separation, locks).

## Solution

Every screen moves to neutral charcoal surfaces with the v2 tokens. Forms, settings, workspace tools, shortcuts and confirmations open as right-edge drawers that keep the source screen visible. The shell is simplified: a sidebar with the v2 icon, the nine pages, the group tree, and Settings plus Lock workspace in its footer; each page has a header with title, subtitle and actions; terminal tabs live on the Terminals page. Servers becomes a column table. Files gets a working server picker. A manual Lock workspace closes live work after an explicit confirmation and returns to the app-lock gate. The terminal and the packaged app icon use the Charcoal palette and icon v2.

## User Stories

1. As a developer, I want the app on neutral charcoal surfaces, so that it matches the approved brand and long sessions are calm to look at.
2. As a developer, I want the SST icon v2 at the top of the sidebar without extra text, so that the brand is present but does not take navigation space.
3. As a developer, I want the Dock and Finder icon to be icon v2, so that the installed app matches the new brand.
4. As a developer, I want blue to mean action, focus and selection only, so that I never confuse it with connection health.
5. As a developer, I want connected, connecting, error and disconnected to show an icon and a word in green/amber/red/grey, so that status is readable without relying on color.
6. As a keyboard user, I want a visible blue focus ring on every control, so that I know where my input goes.
7. As a developer, I want a sidebar listing Servers, Terminals, Files, Identities, Known hosts, Snippets, Port forwarding, Recordings and Team vault, so that every area is one click away.
8. As a developer, I want my nested groups in the sidebar with counts, so that I can scope the Servers table quickly.
9. As a developer, I want Settings at the bottom of the sidebar, so that the titlebar stays clean.
10. As a developer, I want Keyboard shortcuts still reachable from the sidebar and ⌘/, so that I keep discoverability.
11. As a developer, I want each page to have a header with title, short subtitle and its primary actions, so that I always know where I am and what I can do.
12. As a developer, I want the titlebar to contain only traffic lights and a drag area, so that the window looks native and uncluttered.
13. As a developer, I want every existing keyboard shortcut to keep working, so that the redesign does not break muscle memory.
14. As a developer, I want Servers shown as a table with Name, Address, Identity, Environment and Status, so that I can scan many hosts at once.
15. As a developer, I want each Servers row to have Connect and a ⋯ menu of existing actions, so that common actions are one click.
16. As a developer, I want to open a server's details and edit them in a drawer, so that the table stays visible behind it.
17. As a developer, I want DEV, STAGING and PROD badges in the table and everywhere a target is shown, so that I never act on production by accident.
18. As a developer, I want a footer summary on Servers (workspace, server count, connected count), so that I can see open sessions without leaving the page.
19. As a developer, I want Add server, Edit server, connection route, group and tag editors as right drawers, so that I keep context while editing.
20. As a developer, I want drawers to have a fixed header with title, target and close, a scrolling body and a fixed footer with Cancel and the primary action, so that long forms stay usable.
21. As a developer, I want validation errors under each field and a summary when useful, so that I can fix input quickly.
22. As a developer, I want drawers to slide in about 200 ms and appear instantly with reduced motion, so that motion helps without bothering me.
23. As a keyboard user, I want focus to move into the drawer, stay trapped there, and return to the opener when it closes, so that I never lose my place.
24. As a terminal user, I want Esc and Cancel in a drawer never to send keys to the terminal, so that closing a form cannot run anything.
25. As a developer, I want a dirty or busy drawer to ask before discarding, so that I do not lose an unsaved edit.
26. As a developer, I want delete, reassign, discard, revoke, overwrite and PROD Run confirmations as a step inside the same drawer, so that I never face stacked popups.
27. As a developer, I want destructive buttons in red with specific wording, so that I understand the impact before confirming.
28. As a developer on a 960×640 window, I want drawers to take the needed content width without field overflow, so that the app stays usable on small screens.
29. As a developer, I want Identities and SSH key import/rename as v2 pages and drawers, so that credential management matches the rest.
30. As a developer, I want Known hosts as a v2 table with Revoke through a drawer confirmation, so that trust management is consistent.
31. As a developer, I want an unknown host key to open a trust drawer while the tab shows amber "Awaiting trust", so that I decide deliberately and never see a fake connected state.
32. As a developer, I want a changed host key to block in a red drawer with both fingerprints and an unchecked verification box, so that replacement is always deliberate.
33. As a developer, I want password, passphrase and keyboard-interactive prompts in a drawer with empty fields, so that authentication is clear and secrets never prefill.
34. As a terminal user, I want session tabs on the Terminals page with status dot, label and PROD badge, so that the active tab and connection state stay independently legible.
35. As a terminal user, I want New local terminal, Split right, Split down and Workspace tools in the Terminals header, so that terminal actions sit with the terminals.
36. As a terminal user, I want each pane header to show user@host:port, environment badge and a ⋯ menu of existing pane actions, so that I always know the execution target.
37. As a terminal user, I want each pane status bar to show state, target and environment, so that split panes are unambiguous.
38. As a terminal user, I want the focused pane outlined in blue, so that I know which pane receives my typing.
39. As a terminal user, I want a local shell tab to show Local · This Mac with no SSH endpoint, so that local and remote are never confused.
40. As a terminal user, I want the terminal in a charcoal palette (dark background, white text and cursor, readable green/blue), so that it fits the app while staying independent of app styling.
41. As a terminal user, I want Settings to show the terminal colors as "Charcoal", so that I know which palette is active.
42. As a terminal user, I want the snippet Paste/Run composer as a drawer that shows the captured target, so that switching tabs afterward never changes where the snippet goes.
43. As a terminal user, I want PROD Run to require an explicit confirmation step in that drawer, so that production commands are deliberate.
44. As a terminal user, I want workspace templates and the explicit multi-target composer as drawers, so that broadcast stays explicit and ordinary typing stays pane-local.
45. As an operator, I want Files to show Local and Remote panes and the transfer queue in v2 styling, so that file work matches the app.
46. As an operator, I want a server picker in the Files header that opens SFTP to the chosen server, so that I can switch servers without going back to Servers.
47. As an operator, I want switching the Files server to go through the existing close and confirmation path when transfers are live, so that I never lose a transfer silently.
48. As an operator, I want Open files on Servers to keep working, so that both entry points behave the same.
49. As an operator, I want overwrite/skip/rename conflicts and external edit consent as drawers, so that file decisions keep the browser visible.
50. As a developer, I want Snippets as a v2 library with create/edit in a drawer, so that encrypted snippets are managed like everything else.
51. As a developer, I want Port forwarding to list local, remote and dynamic rules in v2 styling with per-type drawers, so that tunnel setup is consistent.
52. As a developer, I want Recordings and the recording privacy settings in v2 styling, so that opt-in capture stays clear.
53. As a developer, I want Settings as one drawer with Terminal, Recording, Security and Sync tabs, so that all preferences are in one place.
54. As a developer, I want personal sync setup, manual actions, conflict review and enrollment/recovery as drawers, so that sync steps stay explicit.
55. As a Team member, I want Team vault, managed host, members and setup/recovery in v2 styling, so that Team work matches personal work and roles stay visible.
56. As a developer, I want the app-lock gate and first setup/recovery as a full-window gate with the form panel on the right and no workspace data behind it, so that a locked app reveals nothing.
57. As a developer, I want a Lock workspace action at the bottom of the sidebar, so that I can lock ssterm when I step away.
58. As a developer, I want Lock workspace to lock immediately when nothing is live, so that locking is fast.
59. As a developer, I want Lock workspace to list the live terminals, tunnels, transfers and remote edits that will close and ask "Lock and close N", so that I do not lose running work by a misclick.
60. As a developer, I want Cancel on that confirmation to leave everything running, so that a misclick is harmless.
61. As a developer, I want locking to close live work and purge transient secrets like an OS screen lock, so that a locked app holds nothing usable.
62. As a developer, I want every window to show the unlock gate after Lock workspace, so that no other window stays usable.
63. As a developer, I want the unlock after a manual lock to work exactly like at app start (same method, backoff, Google offline grace), so that there is one unlock to learn.
64. As a developer, I want every feature action to be refused until I unlock again, so that the lock is enforced in main, not only on screen.
65. As a developer, I want OS screen lock and sleep to keep their current immediate behavior, so that nothing new prompts me there.
66. As a developer, I want empty, loading and failure states in v2 styling with specific actionable copy, so that problems are understandable.
67. As a developer, I want the Keyboard shortcuts drawer to list the real shortcuts, so that it never advertises keys that do nothing.
68. As a Thai user, I want Thai labels and IME input to render with the bundled fallback fonts in the new layout, so that nothing clips or misaligns.
69. As a user who scales text, I want the layout to reflow without overflow at 960×640 and 1280×800, so that larger text stays usable.
70. As a reviewer, I want measured contrast ratios attached as test evidence, so that the deliberate blue/boundary exception is visible, not hidden.
71. As a maintainer, I want the development showcase to show v2 tokens, drawers and state specimens, so that design review uses the shipping components.
72. As a maintainer, I want each phase delivered as a separate local commit, so that regressions can be bisected and reverted.

## Implementation Decisions

- **Phasing:** (1) tokens, terminal palette and icon; (2) drawer primitive and migration of every centered dialog; (3) shell structure, page headers, Lock workspace; (4) per-page alignment and full gates. Each phase is a separate local commit after TEST and REVIEW. No push.
- **Tokens:** the renderer's semantic tokens take the v2 values (canvas, sidebar, surface/drawer, field, line, text, secondary text, primary). Primary blue is also the focus ring, selection outline and blue text; the line color is also the control boundary (user choice, ADR 0008 exception). Status colors are re-tuned for charcoal to keep text ≥4.5:1. Token names stay; components keep using semantic tokens, never raw hex.
- **Terminal palette:** the terminal theme module stays independent of app tokens and becomes Charcoal (background `#131313`, foreground/cursor `#F3F3F3`, green `#22C55E`, blue `#3B82F6`, neutral black `#737373`, selection primary blue at partial alpha, other hues unchanged). The persisted `terminalPalette` setting keeps its existing value; no settings migration.
- **Icon:** the icon build derives from icon v2 with its existing alpha/padding QA; the renderer uses a copy of icon v2 in the sidebar and app-lock gate. Original artwork is untouched; no monogram is cut from generated images.
- **Drawer primitive:** one shared right-edge drawer built on the existing sheet component: full height below the titlebar, 480–560 px (up to 640 for complex review/settings, full content width on small windows), fixed header (title, optional target, close) and footer (Cancel, primary), scrolling body, scrim, focus entry/trap/return, Esc routed through a dirty/busy policy that never forwards keys to the terminal, transform/opacity motion of about 200 ms and instant with reduced motion. Confirmations are a body step of the same drawer (no stacking). All 19 dialog-owning feature areas move to it; AlertDialog/Dialog usage for in-app flows ends.
- **Shell:** the titlebar keeps only traffic lights and a drag region. The sidebar shows icon v2 (no wordmark), nine pages, the existing nested group tree with counts, and a footer with Settings, Keyboard shortcuts and Lock workspace. The global status bar is removed; Servers gets a footer summary and terminal panes get their own status bars. All shortcuts remain.
- **Terminals page:** owns the session tab strip and the New local terminal, Split right, Split down and Workspace tools actions. No tab-strip "+".
- **Servers page:** column table sorted by name as today; no sort controls, no row checkboxes, no ⌘K hint. The former detail panel becomes the host drawer.
- **Pane chrome:** pane header has target, environment badge and a ⋯ menu of existing actions; pane status bar has state, target and environment. No per-pane font or encoding controls.
- **Files server picker:** a header picker over catalog hosts that calls the existing SFTP open; it has the same single-remote-pane semantics, close/confirmation path and trust/auth flow as Servers → Open files.
- **Settings:** one drawer with Terminal, Recording, Security and Sync tabs; terminal colors shown read-only as "Charcoal".
- **Lock workspace (new main command):** a new validated IPC command "lock now" on the existing app-lock boundary. Main runs the existing session lock path (the same one used for screen lock/suspend) for the whole process, then sets the app-lock controller back to locked so the existing gate refuses feature IPC with `unauthorized` and every window shows the gate. Unlock reuses the existing methods, backoff and Google offline grace. The renderer asks main for the live-resource summary (terminals SSH/local, tunnels, transfers, remote edits) and shows the confirmation drawer only when it is non-empty; main re-checks nothing beyond locking (locking is always safe), so a resource started between summary and confirm is still closed. The action is hidden when the app lock is off. OS screen lock/suspend are unchanged and never show the gate.
- **Terminology:** *session lock* = closing live resources and purging transient secrets; *app lock* = the access gate. Lock workspace = session lock then app lock.
- **No schema change:** catalog schema stays 4; sync/Team/recording formats unchanged.

## Testing Decisions

- **Good tests** drive the app the way a user does and assert what the user or main observes: rendered roles/names, focus location, drawer placement and contents, IPC outcomes, closed sessions, bytes written. No assertions on component internals, class names or token variable names.
- **Primary seam: existing Playwright Electron E2E** through `launchDesktop(profile)` in development and packaged runs, with owned Docker OpenSSH fixtures, test Keychain namespaces and temporary profiles. Existing specs are updated for the new shell (tabs on Terminals page, drawers instead of dialogs) rather than rewritten; their behavioral assertions (trust, auth, Paste/Run target capture, transfers, tunnels, sync, Team, recording, app lock) must keep passing unchanged in meaning.
- **New/extended E2E coverage:** drawer contract (placement at right edge, focus entry/trap/return, Esc does not reach the terminal, dirty discard step, reduced-motion instant open, 960×640 and 1280×800 without overflow) inside the existing release-gate sweep; Files server picker switching with and without a live transfer; Lock workspace with nothing live (immediate gate), with live SSH/local terminal, tunnel and transfer (confirmation lists them, Cancel keeps them, confirm closes them and every window shows the gate, feature IPC answers `unauthorized` until unlock), using `SSTERM_TEST_APP_LOCK=on`.
- **Second seam: existing app-lock unit tests** for the relock state transition and races (lock-now during an in-flight unlock, repeated lock-now, IPC arriving between session lock and app lock answers `unauthorized`).
- **Contrast:** existing rendered-contrast helpers keep ≥4.5:1 for primary/secondary/status/destructive text; for the ADR 0008 excepted roles the measured ratio is attached as evidence instead of asserted against the old bar. Showcase contrast pairs follow the same split.
- **Icon/package:** existing icon QA output and `package-artifact.spec.ts` confirm the packaged icon comes from icon v2.
- **Prior art:** `release-gate.spec.ts` (page sweep, sizes, reduced motion), `app-lock.spec.ts` (gate, fake Google), `transfers.spec.ts` (rendered contrast), `workspace-tools.spec.ts` (modal trust/focus), `snippet-run.spec.ts` (captured target), `tests/unit/app-lock.test.ts`.
- **Commands per phase:** `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`; final phase also `npm run package:mac`, `npm run test:packaged`, `git diff --check`.

## Out of Scope

- Sorting, multi-select/bulk actions, ⌘K command palette, per-pane appearance, encoding selection, quick-connect "+" and terminal theme picker.
- Light theme.
- Any new backend behavior other than the Files picker wiring and Lock workspace.
- Showing the app-lock gate on OS screen lock or sleep.
- Native macOS Open/Save, Keychain and Google UI.
- A vector or transparent monogram export, wordmark font identification and Developer ID signing/notarization.
- Push, PR, publishing or deployment.

## Further Notes

- The ADR 0008 contrast exception is a deliberate accessibility regression chosen by the user; a lighter focus/text blue is the documented upgrade path.
- Manual checks that automation cannot cover remain pending: Thai IME with the native input method, VoiceOver, visual comparison against the concept PNGs.
- Rollback: revert the phase commits; no data or schema migration is involved, and the persisted settings value is unchanged.
