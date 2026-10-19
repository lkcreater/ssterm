# SST-029 delivery — local terminal / platform capabilities

**Status: automated delivery gates complete — 2026-10-19.** Independent ANALYZE/DESIGN/TEST/REVIEW/DELIVER completed. Authorized by “ทำงานถัดไป” after SST-032 commit `eddc7aa`, within the approved later-scope order. Local commit only; no push. [Behavior](../local-terminal.md), [ADR 0005 / platform matrix](../adr/0005-local-terminal-platforms.md), [plan](implementation-plan.md#sst-029-execution-plan--macos-local-pty--platform-declarations-2026-10-18).

## Scope

- Explicit macOS arm64 local terminal using pinned node-pty 1.1.0, with LOCAL / This Mac identity, fresh split/restart and captured active-session snippet Paste/Run.
- One shared registry for local/SSH resource limits, owner/generation/cancellation/lock/suspend/revoke/quit; local context has no saved-host resolution or SSH trust/auth callbacks. Owner-only launch request; shell/environment/cwd are main-owned.
- Raw byte output with credit and bounded buffers, whole-write bounded native input, native resize/exit and confined owned-job cleanup. N-API addon and executable helper staged outside ASAR with strict signature/license/artifact checks.
- Saved templates/multi-target tools remain SSH-only and explain excluded local panes. Local panes grant no SFTP, remote-edit or forwarding capability.
- Honest Windows/Linux/macOS x64 capability matrix with no untested builds or secure-store fallback. Schema remains 4; no local session/output/history persistence.

## Verification

| Check | Result |
|---|---|
| Typecheck | PASS, all three configs after final native cleanup patch |
| Full unit | PASS, 537/537; zero skips/cancel/fail in final idle-host run |
| Focused native adapter | PASS, 11/11; default login zsh in an isolated home, raw bytes/credit/tail, input bounds/cancel, resize, real zsh natural exit/disowned group/grandchild, unsupported native shape, hostile status metadata |
| Build | PASS; existing Rollup/Zod warnings |
| Full development Electron | PASS, 75/75, zero skipped/flaky/unexpected; final foreground Ctrl+C, snippets, fresh split/restart, lock/suspend/crash/quit included |
| macOS arm64 package | PASS on final built source, ad-hoc signed Electron 44.7.2 |
| Full packaged Electron | PASS, 76/76, zero skipped/flaky/unexpected; final license-only package refresh also passed 7/7 targeted artifact/local/Keychain checks |
| Independent review | No unresolved critical/high findings; final medium descriptor cleanup issue resolved |
| Documentation links / staged diff check | PASS |

Initial full unit baseline 530/532 exposed two native fixture/preflight issues: PTY output line discipline and async exec failure assumptions. Executable preflight and an explicitly raw owned fixture resolved them. After hardening, a concurrent unit/E2E run passed 535/536: the existing 5,000-host catalog timing assertion took 1197 ms against a 1000 ms limit. The same runtime source passed 536/536 without concurrent Electron work; no catalog code or threshold changed. One additional isolated-home test then verified the shipped default `/bin/zsh -l` flags (exit 9, exact output); the final independent full unit run passed 537/537.

The first full development run passed 74/75: root had inserted the newly allowed API name into an unsorted expected list while actual bridge keys were sorted. The list was corrected and the final full run passed 75/75. Earlier focused fixture-only menu focus synchronization and internal undefined target normalization were fixed; public local state is explicitly `hostId:null,target:null`.

Ignored evidence lives under `artifacts/sst029/`. Only owned temporary homes/profiles/processes and isolated test Keychain namespaces are used; automatic content traces/screenshots/video are disabled. Explicit visual evidence contains LOCAL target metadata: macOS arm64, CSS 960×640 / Retina 1920×1280, reduced motion and offline fonts. LOCAL contrast 10.37:1; machine/shell 13.54:1. Tests use startup-free isolated Bash for the rendered integration and isolated zsh for native job-control regression; no real user profile/history is read.

After the full 76-test packaged pass, a license-only refresh added the node-addon-api header copyright notice. The final refreshed package passed seven targeted checks: three local-terminal cases, three artifact/signature/license checks and the isolated Keychain round trip. Application code was unchanged. Packaging used the already verified final build via `node scripts/package-desktop.mjs`; no build output was overwritten during runtime suites. The optional `.icon` packager warning remains; the shipped `.icns` passed artifact verification. No Developer ID or notarization is claimed.

The final owned-image Docker query returned no containers; the adapter owner confirmed all ten recorded exploratory process IDs absent. Runtime teardown asserted empty test Keychain namespaces. The initial delivery was interrupted because automatic approval review could not run after a usage limit; the user resumed on 2026-10-19, and the final package/check commands then passed. No unsafe-action rejection or bypass occurred.

## Review and resolutions

- Direct-shell cleanup could miss jobs reparented after a fast exit. A fixed `/bin/sh` guardian remains PTY session leader while the interactive shell runs, writes only numeric wait status into a main-created private file and remains alive through confined process inspection. Real isolated `/bin/zsh -f -i` exits 7 with a disowned background group and grandchild; independent `ps` checks confirm all owned identities stop.
- Cleanup inspection/escalation is finite. A shared native cap of 32 retains admission on unconfirmed process death even after registry teardown times out, preventing unlimited resource reuse. Final failure paths await actual input/status work, close duplicated input descriptors once and remove private numeric-status files best-effort, without claiming process cleanup succeeded.
- Native module loading is lazy and unsupported platforms/missing executables produce fixed feature errors. Saved SSH imports/composition do not eagerly require the PTY binding.
- Bounded native writes use a duplicated owned fd, rather than node-pty's hidden unbounded write queue. The pinned Unix socket seam preserves intentionally paused exit tails beyond the upstream 200 ms timeout. Status reads use a fixed-inode regular file, NOFOLLOW/NONBLOCK, size check, at most four bytes and no overlapping reads; oversized/non-ASCII/symlink/FIFO tests pass.
- UI and native close/quit sheets name LOCAL / This Mac; Stop shell and Restart local shell distinguish process actions. Active snippets capture the local generation; templates/broadcast/SFTP cannot substitute a local session for a saved SSH host.

## Limits / rollback

Local programs have the user's OS privileges. ssterm's environment allowlist excludes app/build/debug/secret inputs, but normal shell startup files may execute commands, set environment or retain shell history. User-created files, network effects and deliberate detached/reparented daemons are outside app rollback/containment. Forced application/OS termination cannot guarantee job cleanup. Native/version-specific PTY seams require repeating the gate on dependency upgrades.

Revert the local commit after disposing owned PTYs; schema stays 4 and no user files/database need deletion. Keep Developer ID/notarization, physical Thai IME/VoiceOver/menu/TCC and native TextEdit UI/autosave as the existing manual release checks. Other platforms remain unsupported/unverified.
