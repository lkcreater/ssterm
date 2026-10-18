# SST-033 delivery — templates / broadcast / multi-host snippets

**Status: delivery gates complete — 2026-10-18.** Authorized by “ทำงานถัดไป” after SST-030 and the recorded SST-029–038 scope. Local commit only; no push. [Behavior](../workspace-tools.md), [plan](implementation-plan.md#sst-033-execution-plan--templates--broadcast--multi-host-snippets-2026-10-18).

## Delivered scope

- Versioned metadata-only workspace templates: tabs, splits/ratios, active pane/tab, Focus mode and saved host/snippet references. Schema 4, exact bounded validation, owner-bound CRUD and optimistic revisions; verified source-version backup preserves protected content/journals.
- Restore appends fresh sessions without changing existing pane instances or replaying commands. Optional saved-snippet preparation is unchecked; later Arm and Insert/Run remain explicit. Missing hosts block restore; missing optional snippets permit unchecked layout-only restore with a warning.
- Explicit Existing/New session modes, immutable recipients and generations, per-target paste planning, PROD/risk confirmation, visibly armed text composer, cancellation and partial results. Ordinary typing stays pane-local; no xterm protocol reports are broadcast.
- Atomic main-side `onlyConnecting:true` cancellation retains Ready sessions. The caller wipes its plan buffer immediately after the pane copies it; in-flight writes report actual acceptance and remaining targets are cancelled.
- Titlebar entry works without open sessions; bounded scrolling, reduced motion, keyboard focus return and rendered contrast at 960×640.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | PASS after integration and focus fix |
| `npm test` | PASS, 474/474 under authorized host-fixture access |
| `npm run build` | PASS; preload requires only `electron`, browser bundle has no Node imports/shims |
| Targeted `workspace-tools.spec.ts` | PASS, 3/3; real two-host production-main fixture flows |
| Targeted `desktop.spec.ts workspace-tools.spec.ts` | PASS, 7/7 after updating the explicit API allowlist; includes unknown-key trust while tools remains open |
| Full development E2E | PASS, 69/69 on final source |
| `npm run package:mac` / `npm run test:packaged` | PASS, ad-hoc signed macOS arm64 / Electron 44.7.2; packaged 70/70, no skips/flakes |
| `git diff --check` / documentation links | PASS |
| Independent REVIEW | No unresolved critical/high; findings below resolved |

The first full development run passed 68/69: the shell test's explicit preload API allowlist needed the three new template methods. That test and the real workspace flows then passed 7/7, followed by a full final 69/69 run. Earlier focused test corrections used approximate ratio comparison, DOM selection for an intentionally background-tab race, and the specified keyed/empty tools state after lock. A real focus-return issue after restore was fixed using the dialog's current active-pane `finalFocus` callback.

Independent analysis/design, persistence/core/renderer implementation, focused tests, and correctness/privacy review used separate agents. The independent tester passed typecheck/full unit and initiated regression; root completes final runtime/package verification and records actual outcomes. The sandbox-only unit attempt failed on restricted loopback binds; the authorized fixture run passed. Existing Rollup/Zod build warnings remain; no lint script exists.

## Review resolutions

- Renderer read-then-close could race a connecting session becoming Ready. The exact owner/session/generation/kind/phase check and close fence now run atomically in main; boundary tests prove Ready retention, connecting cancellation and refusal of late readiness or wrong owners/generations/kinds.
- A separate encoded planning buffer originally lived until acknowledgement. It is now wiped immediately after `deliver` copies synchronously; the in-flight test separately checks caller and pane-owned lifetimes and the real final result after cancellation.
- Cancel is hidden for invoked template save/delete metadata operations, avoiding a false rollback claim. Close/lock still invalidates the UI and a later list refresh sees committed metadata.
- Missing optional snippets permit layout-only restore when preparation is unchecked. No recipient or snippet is substituted.

## Runtime and visual evidence

Owned Docker OpenSSH hosts have distinct fixture passwords in isolated test Keychain namespaces. E2E observes the shipped input handler using content-free write receipts and a gated decrypt, verifies real remote output and session IDs, and restores templates across same-signature relaunch. It covers zero writes by default, optional preparation, captured targets during focus changes, explicit Arm/Disarm/PROD Cancel, Insert/Run, stale generations, lock/late decrypt, fresh-session partial failure, trust modal layering, and a paused owned SSH server for cancellation.

Safe screenshots are kept in ignored `artifacts/sst033/screenshots/`: CSS 960×640, Retina 1920×1280, reduced motion. Template fields/focus and captured Thai target labels, endpoints, PROD and distinct session suffixes are legible with internal scrolling and no horizontal overflow. Automatic traces/screenshots/video are disabled for credential-bearing flows. Logs/reports remain under ignored `artifacts/sst033/`.

The final packaged run passed 70/70, including native dependencies, schema upgrade, same-signature Keychain relaunch, all new workspace flows, package identity/icon/signature and release-gate checks. Test teardown asserts empty test Keychain namespaces; the final filtered Docker query found no fixture containers. The packager's existing optional `.icon` warning does not affect the verified `.icns` artifact.

## Limits and rollback

Broadcast means the explicit text composer, not live keyboard mirroring. At most eight targets, eight tabs/eight total template panes, four panes per tab, 64 templates. Templates reference current saved-host settings and cannot restore terminal history, remote processes or arbitrary CWD. Accepted bytes do not prove remote command success; already handed-off input cannot be retracted. Missing references require repair or layout-only restore as described above.

Revert the commit to remove the feature. Before running an older build, close ssterm, preserve the current schema-4 catalog and restore its verified pre-upgrade v3 backup (or the original v1/v2 backup for a direct upgrade). No plaintext bodies or credentials are stored in templates. Native Thai IME/VoiceOver/menu/TCC and Developer ID/notarization remain separate pending release gates.
