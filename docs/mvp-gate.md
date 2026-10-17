# MVP gate — SST-027

**2026-10-17 · T033 DONE; T034 and DS05/T051 automated parts DONE, manual walkthrough pending.** Release checklist proving the MVP workflows. See [ticket](termius/tickets.md#sst-027--end-to-end--accessibility--regression-gate), [execution plan](agent-runs/implementation-plan.md#sst-027-execution-plan--2026-10-17) and [delivery](agent-runs/sst-027-delivery.md).

**Final run (macOS 15 arm64, unsigned package):** typecheck PASS; `npm test` 422/422; `npm run test:e2e` 62/62 (59 desktop + 3 showcase); `npm run package:mac` PASS; `npm run test:packaged` 59/59. Every desktop spec runs in both development and packaged projects. No lint script exists.

Legend: **D** owned Docker OpenSSH fixture, **KC** real Keychain under `dev.ssterm.test.<uuid>`, **L** in-process ssh2 server, **U** unit/fake.

## Workflow traceability (F01–F06)

| Flow | Evidence |
|---|---|
| F01 add host → connect | `catalog-ui.spec.ts` F01 (Thai tree, inherit/override/validate/persist); `catalog-connect.spec.ts` (trust, password prompt, lock, Connect) **D** |
| F02 group defaults + tags | `catalog-ui.spec.ts` F01 and tag AND/search; `catalog.spec.ts`; `catalog-domain.test.ts`, `storage.test.ts` **U** |
| F03 shared identity | `identities.spec.ts` F03 (group port + identity, replace affects new connections) **D KC**; delete/reassign |
| F04 SFTP | `sftp-browser.spec.ts`, `transfers.spec.ts`, `transfer-conflicts.spec.ts`, `sftp.spec.ts` **D** |
| F05 split + snippets | `workspace.spec.ts` tabs/splits **D**; `snippets.spec.ts` **KC**; `snippet-run.spec.ts` (zero bytes on Paste, captured target) **D** |
| F06 local tunnel | `tunnels-ui.spec.ts` F06 (create, start, HTTP, duplicate, explicit restart, no autostart) and `tunnel.spec.ts` (stop, lock, quit, loss) **D** |

## Required failure and security matrix

| Requirement | Evidence |
|---|---|
| Auth: password, Ed25519/RSA keys, encrypted key passphrase | `auth.spec.ts` **D KC**, `credentials.spec.ts` **D**, `identities.spec.ts` encrypted import **D KC** |
| Keyboard-interactive | **new** `release-gate.spec.ts` keyboard-interactive on OpenSSH/PAM **D**; `credentials.spec.ts` multi-round **L**; units |
| Unknown / changed host key | `known-hosts.spec.ts` (dialogs, persistence, changed key blocks before auth, deliberate Replace, revoke) **D**; shared policy units |
| Cancel per phase | `terminal-lifecycle.spec.ts` (Connecting, VerifyingHost, AwaitingInput) **D**; Authenticating/DNS **U** |
| Connection loss | `terminal-lifecycle.spec.ts` silent drop (`docker pause`) and server stop **D**; `tunnel.spec.ts` loss **D**; crash, quit, leak loop |
| Malformed IPC | `desktop.spec.ts`, `known-hosts.spec.ts`, `sessions.spec.ts` through real IPC; one boundary unit suite per channel family |
| Storage denial | `storage.spec.ts` corrupt store; **new** `release-gate.spec.ts` unwritable workspace folder; `identities.spec.ts` no secret store (fail-closed); unit matrix for foreign/newer/FK-invalid |
| Transfer conflict | `transfer-conflicts.spec.ts` Overwrite/Skip/Rename with hashes, cancelled overwrite keeps old file **D** |
| Secrets at rest | `snippets.spec.ts` and units scan DB/WAL; identities privacy scans |

## DS05 release-quality sweep (design-system.md §11)

**New** `release-gate.spec.ts` populates a Thai-heavy catalog (PROD/STAGING/DEV servers, group, tag, identity, rule, snippets) and, with `prefers-reduced-motion: reduce`, visits Servers, Identities, Snippets (editor open), Port forwarding, Known hosts, Files and Terminals plus the Settings and Keyboard shortcuts dialogs at **960×640 and 1280×800**. Per view it asserts:

- every visible text element ≥ 4.5:1 (3:1 large) against its composited background (disabled controls exempt) — 18 views, 27–73 text elements each;
- every visible interactive control has an accessible name;
- no horizontal overflow in the workspace;
- no animation longer than 0.01 ms under reduced motion;
- at 960×640, 25 Tab presses per page each land on a control with a visible outline or ring;
- Settings and Keyboard shortcuts return focus to their opener on Esc.

Screenshots for every view and size are written to ignored `artifacts/`. Result: **0 findings** after one fix (the icon-only combobox trigger in Files had no name). Existing specs add per-feature evidence: credential/trust dialogs, snippets, snippet panel, transfers, tunnels (contrast at 960×640), workspace splits with PROD and failed panes at both sizes, and showcase state independence and 3:1 graphics.

## SST-014 budgets (final development run)

| Measure | Gate | Measured |
|---|---|---|
| 19.5 MiB flood throughput | ≥ 10 MiB/s | 36.7 MiB/s |
| Max unacknowledged output | ≤ 288 KiB | 272–275 KiB |
| Renderer long tasks | none > 100 ms | 0 |
| Frame p95 (recorded) | target 33 ms | 18.7 ms |
| Ctrl+C mid-flood marker | ≤ 1 s | 97 ms |
| Blocked renderer main growth | ≤ 96 MiB | 22 MiB |
| 256 KiB paste | one write, ≤ 2 s | 1 write, 43 ms |
| Peak memory (recorded) | — | main 173–194 MiB, renderer 225–272 MiB |

Throughput is host-load sensitive: one SST-025 full run measured 5.6 MiB/s; isolated reruns passed.

## Release-blocker review

An independent audit of all IPC registrations, the preload bridge, window security (context isolation, sandbox, CSP, navigation/permission handlers), link opening, host-key policy, secret handling, tunnels and file publication found **no open critical or high issue**. Its one medium (a tunnel restart racing a window close could leave an orphaned loopback listener) is fixed with a revoked-owner fence and a regression test.

## Deviations and unrun checks

- **Manual macOS Thai IME walkthrough (T034, DS05) not performed.** It needs a human at the keyboard with physical Thai Kedmanee/Pattachote layouts; this session has no Accessibility permission or operator. All Thai/IME evidence is synthetic (CDP composition, synthetic clipboard). Pending the user.
- VoiceOver, real menu ⌘C/⌘A/⌘V, emoji picker and dictation: unrun (SST-013/020; T035 lists the packaged ones).
- Physical OS lock and sleep/wake, keepalive defaults end to end, real-latency networks, 32-session memory: unrun.
- Keyboard-interactive cancel on a real PAM conversation, server-side SFTP drop, and quit with an active transfer have unit/fake coverage only.

## Unresolved lower-priority issues (carried)

From delivery records, none critical/high: SFTP/local-stage TOCTOU windows with untrusted writers (SST-021/022); unknown publication outcome on lost acknowledgement (SST-022); stuck local file operation quarantines a transfer permit (SST-021); tunnel probe/bind not atomic, 16-open burst limit (SST-025); truncated-catalog servers show "Missing server", server edits while a tunnel runs are not flagged (SST-026); snippet panel may cover the rightmost pane header (SST-024); snippet editor conflict after a tag deletion elsewhere (SST-023); no verified-restore fence and migration refusal for protected vaults (SST-006); `pagent.exe` still packaged and package notices/icons/signing (SST-028).
