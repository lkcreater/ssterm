# SST-040 — UI v2 Charcoal

Status: delivered through per-ticket TEST/independent REVIEW and the final automated gates below. Tickets 01–14 are committed locally; ticket 15 (this record) is ready for its local commit. No push, PR, publishing or deployment.

Sources: [spec](sst-040-spec.md), [ADR 0008](../adr/0008-ui-v2-charcoal.md), [ADR 0004 amendment](../adr/0004-local-app-lock.md#amendment--manual-relock-sst-040-2026-10-22), [decisions and per-ticket records](implementation-plan.md#sst-040-authorization--ui-v2-charcoal-2026-10-22), [tickets](sst-040/README.md), [UI v2 handoff](../logo/ui-v2/README.md) (concept PNGs; its text contracts govern, not pixels).

## Scope delivered

| # | Commit | Delivered |
|---|---|---|
| — | `33dcde6` | Spec, ADR 0008, ADR 0004 amendment and the 15-ticket breakdown |
| 01 | `df148b1` | Charcoal tokens (contrast exception recorded as measured evidence), Charcoal terminal palette, `.icns` and in-app icon from icon v2 |
| 02 | `210e4af` | Shared right-edge `Drawer` (`useDrawerClose`, alert variant, per-open key, dirty/busy Esc policy, ~200 ms motion, instant under reduced motion); catalog editors and deletions |
| 09 | `ec15259` | Shell v2: drag-only titlebar, sidebar with icon v2 and footer, `PageHeader` on every page, tabs and terminal actions on the Terminals page, pane header and pane status bar; global status bar removed |
| 03 | `ad125a2` | Identity/key forms, host trust (unknown/changed), revoke and credential prompts as drawers; amber "Awaiting trust" state |
| 04 | `2a0b0d1` | Snippet Paste/Run (captured target, PROD step), Workspace tools, close and paste confirmations, Shortcuts as drawers |
| 05 | `1735938` | Transfer conflict and remote-edit consent drawers bound to the captured nonce/revision |
| 06 | `f357445` | Snippets, Port forwarding, Recordings and Team vault flows as drawers |
| 07 | `2c7310a` | Settings as one tabbed drawer (Terminal/Recording/Security/Sync), colors read-only "Charcoal" |
| 08 | `f5ef7bf` | `ui/dialog.tsx` and `ui/alert-dialog.tsx` removed; release sweep of every reachable drawer |
| 10 | `98832e0` | Servers column table (Name, Address, Identity, Environment, Status), Connect + ⋯ per row, host drawer, footer summary |
| 11 | `b7012f7` | Files server picker over the existing `sftp.open`; switching with pending work asks first |
| 12 | `e1e8dee` | Lock workspace: validated `app-lock-lock-now`, session lock + app lock in one turn, every window reloads into the gate |
| 13 | `25242da` | Lock workspace confirmation listing live terminals, tunnels, transfers and remote edits ("Lock and close N") |
| 14 | `dc0b28b` | Full-window app-lock gate with a right form panel; Google sign-in tied to its window |
| 15 | (this change) | Page polish, drawer placement checks, teardown hardening, docs, final gates |

### Ticket 15

- **Pages:** Identities (identities and SSH keys), Known hosts, Port forwarding, Recordings and Team vault (hosts and members) are framed v2 column tables built on the Servers table style (`.data-frame`/`.data-table`), with columns only for data that already exists. Snippets moves its search into the page header and frames its list. A long table or list scrolls inside its frame under a sticky header row. Known hosts shows the whole fingerprint (it wraps) so it can be verified without a pointer. Row actions are unchanged in number and accessible name; secondary actions are icon buttons with titles, and in a narrow frame (a 960 px window with larger text) text actions keep their icon while the text stays the accessible name. No sort controls, checkboxes, ⋯ menus or segmented controls were added.
- **States:** v2 loading states with specific copy for Known hosts, Recordings and Team vault (previously a bare spinner, a "not recorded" message while loading, or a badge); a titled failure alert for Recordings; Known hosts and Team hosts get iconed empty states with specific copy.
- **Showcase:** adds an alert-drawer confirmation specimen and a table-states specimen (rows with status, loading, failure), both covered by `showcase.spec.ts`.
- **Drawer placement:** `drawerGeometry()`/`placed()` moved to `tests/e2e/support/drawer.ts`; `expectDrawerPlaced()` waits until the drawer is at rest and checks flush right, top at the titlebar bottom, full height, 480–560 px, no field overflow and no horizontal scroll inside each feature spec (list below).
- **Text scaling:** a new `release-gate.spec.ts` test opens the six pages with Thai labels at 960×640 and 1280×800, at zoom level 0 and 1 (120%, two ⌘+ steps), and fails on clipped text (own overflow or cut by a clipping ancestor, unless a `title` carries the full text), page overflow, horizontal scroll and the shared audit.
- **Teardown hardening:** see below.

## Decisions (recorded in the plan; not re-decided)

Colors “ตาม v2” with the documented contrast exception; shell “ตาม v2”; drawn-only affordances not built (“ตามแนะนำ”); icon v2 without sidebar wordmark; terminal Charcoal palette; Files picker “ตอบ ก”; Lock workspace inside SST-040 and its confirmation “ตามแนะนำ”. Defaults: no tab-strip "+", stored `terminalPalette` value `signal-blue-dark` kept, nested group tree kept, Settings one drawer, Lock workspace hidden when the app lock is off. PROD stays amber (the concept PNGs draw it red; the user did not decide otherwise).

## Review findings fixed (real product bugs)

- **Snippet editor dirty race (08):** the dirty flag reached the close policy through a passive effect, so Esc right after ⌘S could ask to discard and Esc right after adding a tag could drop it; now `useLayoutEffect`.
- **Lock workspace relock bypass (12):** a Settings password/Google change still in flight could reopen the app after a relock; unwritten changes are abandoned and Lock workspace answers `busy` during a Keychain write.
- **Google sign-in tied to the window (14):** closing the window could let setup/unlock finish unseen; main aborts the sign-in when its window is destroyed or its owner rotates.
- **Silent SFTP switch drop (11):** switching Files servers stopped live transfers and ended remote edits silently; it now reads pending work from main and asks in an alert drawer.
- **Undecryptable snippet delete (06):** a snippet that could not be decrypted could no longer be deleted; fixed with an E2E.
- **Double-click drawer dismissal (10):** the second press of the double-click that opened a drawer landed on the scrim and closed it; the drawer ignores it.

Other review fixes per ticket (Awaiting trust state, broadcast abort on double-click Confirm Run, recovery-code regenerate, narrow pane target wrap, failed sessions shown as Disconnected, docs/ADR consistency) are in the plan's per-ticket records.

## Drawer placement coverage

Release sweep (no live state, both sizes, reduced motion): Settings (four tabs), Shortcuts, new/edit/delete server, edit/delete group, new/edit/delete identity, import key, new snippet, new/edit/delete rule, Workspace tools, Team setup; drawer contract test: server editor and delete host.

Feature specs (ticket 15, `expectDrawerPlaced`): credential prompt (passphrase at 1280 and keyboard-interactive at 960, `credentials.spec`), host trust unknown/changed and revoke trust (`known-hosts.spec`), paste confirm (`terminal-input.spec`), close confirm (`workspace.spec`), snippet panel (`snippet-run.spec`), transfer conflict (`transfer-conflicts.spec` via `chooseConflict`), remote-edit open and upload consents (`remote-edit.spec`), key rename/forget passphrase/delete (`identities.spec`; Rename gained its first E2E open), delete recording (`recording.spec`), Team host/password/confirm/member/invite/enrollment (`team.spec`; invite and enrollment gained their first E2E open), Lock workspace confirmation (`app-lock.spec`), Files switch confirmation (`files-picker.spec`), snippet editor (`snippets.spec`).

Not separately placement-checked: the personal sync steps inside Settings › Sync (they render in the Settings drawer, which is checked per tab) and the Team setup recovery/join modes (same `team-setup-drawer`, checked in create mode by the sweep). No drawer on the ticket's list was unreachable.

## Transfers teardown hardening

The intermittent `transfers.spec`/teardown failures were the server-side sshd count staying above zero for up to 10 s after quit. ssh2 runs in main, so the client sockets close when main exits; the fixture's sshd exits only after Docker Desktop's port proxy relays that close, which lags under load (no `ClientAliveInterval`). The fixture image was not changed. `closeAndExpectNoSsh()` (`tests/e2e/support/ssh-teardown.ts`) now: surfaces a quit that fell back to SIGKILL (`Desktop.forcedKill()`, a soft assertion plus a test annotation); asserts after exit that no surviving host process other than Docker's proxy (a helper or orphan; main's own sockets are closed by its exit) still holds an ESTABLISHED connection to the fixture port, treating `lsof` exit 1 as "none" only with empty stderr; then waits up to 60 s for the fixture sshd sessions with a message that names the proxy relay. Used by `transfers`, `transfer-conflicts` (shared transfer fixture), `files-picker` and `sftp-browser` (which previously checked once without waiting). The ticket-11 `transfers.spec` hang (one 420 s timeout, cause unknown) did not recur in the final runs below.

## Validation

Final ticket-15 gates (macOS arm64, Docker Desktop with `ssterm-ssh-fixture:m0` unchanged, 2026-10-23):

| Gate | Actual result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | 777 total / 776 passed / 1 skipped (Homebrew bash5 unavailable) / 0 failed |
| `npm run build` | pass (built again before every E2E run) |
| `npm run test:e2e` (full, development + showcase) | 92/92 passed in 8.0 min, first attempt, no reruns |
| Focused `remote-edit.spec.ts` after adding the upload-consent placement check | 3/3 passed |
| `npm run package:mac` | pass; ad-hoc signed `SSTerm-darwin-arm64` (the existing "no `.icon` format" packager warning is unchanged) |
| `npm run test:packaged` | 92/92 passed in 7.8 min |
| `git diff --check` | clean |
| After the independent review fixes (full fingerprint wraps and is asserted visible, titles on icon-only text actions, failure copy, teardown soft-fail/`lsof` stderr, in-frame table scrolling): typecheck, `npm test`, build | pass; 777 total / 776 passed / 1 skipped |
| Same, focused development E2E: known-hosts, recording, identities, tunnels-ui, team, snippets, release-gate, transfers | 23/23 passed in 2.3 min |

No owned fixture container remained after the runs. The 120% text-scaling test first failed on real clipping (the "Keyboard-interactive" method badge cut by its cell; the "Destination" header truncated without a title), which was fixed before the gates above.

Per-ticket evidence for 01–14 (focused reruns, review rounds, earlier flakes) is in the plan's per-ticket records.

## Known limitations

- **Contrast exception (ADR 0008):** primary blue `#2563EB` as focus ring, selection outline and blue text measures 2.97:1 on `#252525` and 3.23:1 on `#1E1E1E`; `#383838` control boundaries 1.31:1. Recorded as measured evidence, not asserted. Upgrade path: a lighter focus/text blue.
- **PROD color:** amber, as before; the concept PNGs draw it red and the user has not decided otherwise.
- **Restyle only:** the PNGs' sort controls, row checkboxes, ⌘K, per-pane font/encoding, tab-strip "+", Credential column and recordings Kind/history rows are not built; tables are sorted as before.
- **Text-scaling coverage:** the 120% test uses a populated catalog (identities, rule, snippet, group, server) and empty Known hosts, SSH keys, Recordings and Team states; populated rows of those four render at default zoom in their feature specs only.
- **Manual checks pending:** native Thai IME with the macOS input method, VoiceOver, visual comparison against the concept PNGs, Developer ID signing and notarization (not authorized).

## Rollback

Revert the SST-040 commits (`df148b1`…`dc0b28b` and this ticket's commit), newest first. No schema or data migration is involved (catalog schema 4; sync, Team and recording formats unchanged), and persisted settings are unchanged (`terminalPalette` keeps `signal-blue-dark`). Reverting ticket 12/13 removes the `app-lock-lock-now` and `app-lock-live-work` IPC commands together with their renderer callers.
