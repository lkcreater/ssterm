# SST-034 delivery — local recordings, command history and suggestions

**Status: automated delivery gates complete — 2026-10-19.** Unit, typecheck, package build, full development E2E, final-build integration, final full packaged suite and both independent review axes passed. Scope was authorized after SST-029 commit `44bbcfb`: opt-in encrypted local logs and shell-reported command history, retention/export/delete, prompt suggestions, and an AI privacy specification only. Local commit only; no push or publication. See [behavior](../recording.md), [AI scope](../ai-scope.md), and the [execution plan](implementation-plan.md#sst-034-execution-plan--local-logs--history--autocomplete--ai-privacy-scope-2026-10-19).

## Delivered scope

- Local output recording and shell-reported history are off by default, encrypted under per-file keys, and kept outside the catalog (schema remains 4). Typed input is not captured; displayed output can contain secrets and is not redacted.
- The Recordings page provides per-file and bulk export/delete, bounded age/size retention, and visible incomplete/gap states. Prompt suggestions are scoped to the live target, insert without pressing Enter, and support Forget. AI remains documentation only; no provider or outbound terminal-data path was added.
- The review found three critical recorder defects and reproduced them against the real `RecordingFiles` adapter: reaching a size limit could erase both the capped recording and older recordings, Forget could interleave with deletion/rewrite, and the file header could race the first data write. A fourth failure mode was also reproduced: refusal by `remove()` could be reported as successful deletion.
- `recorder.ts` now accounts for the header, encrypted frames, final marker and possible gap before accepting data; hitting a cap marks only the affected kind incomplete and stops that kind while other capture continues. The UI labels this as partial. Recorder metadata mutations are serialized. Forget rewrites are staged and are removed on lock/error before publication; failed removal remains a failure. Opening/header writes complete before the frame pump starts, and late creation after deletion is discarded. Incomplete recordings keep an incomplete verdict through rewrite.
- The cap preserves the bounded recording that reached its per-file limit. Normal configured total-retention policy can still evict older closed recordings when the kind's total size exceeds its configured budget.
- Export captures the lock epoch before opening the save dialog, reauthorizes in main, and checks again in the file adapter immediately before native rename. A lock before rename aborts the stage and leaves an existing destination intact; after native rename has been dispatched, the operation reports the actual saved result. Corrupt or unwrappable history makes the whole export fail instead of silently omitting records.
- Quit revokes the current epoch and drains recording writers, queued mutations and retention sweep within a shared two-second bound. A gated regression first exposed an unbounded sweep wait; the final drain path now has a finite bound.
- The first full packaged run exposed an existing SFTP focus race: Closed could arrive before the close reply, consuming the pending focus action while Reconnect was disabled. A gated real-IPC regression reproduced the failure on the old package. The two-line fix retains the focus action while busy and retries when the reply settles; it still respects focus moved outside the pane. Both review axes approved the correction.

## Verification

Final evidence is retained under ignored `artifacts/sst034-*` logs and reports. Runtime profiles, keys, processes, Docker hosts and Keychain namespaces are project-owned; credential-bearing tests disable automatic content artifacts.

| Check | Result |
|---|---|
| Recorder and boundary regression suites | PASS, 32/32 |
| Full unit suite | PASS, 587 passed / 1 skipped (588 total), 18.11 s |
| `npm run typecheck` | PASS |
| `npm run package:mac` | PASS; final unsigned/ad-hoc macOS arm64 rebuild. Existing optional `.icon` warning remains. |
| Full development E2E | PASS, 79/79, zero skips/flakes (7.4 min). This run predates the last small pre-rename lock guard and corrupt-history export changes, plus bounded quit-drain changes. |
| Final-build development integration | PASS, 10/10 (57.3 s): recording, flow, release sweep and SFTP after the final focus correction; the earlier export/drain build also passed 8/8. |
| Full packaged suite | PASS, 80/80 (7.2 min), zero skips/flakes on the final corrected package. First run: 79 passed / 1 failed, the SFTP focus race above; the gated old-package reproduction failed, then the corrected full run passed. |
| Tunnel unit regression | PASS, 16/16. The listener collision probe cleanup is included in the current changes. |
| Independent Standards review | PASS; no unresolved critical/high findings (0 outstanding). |
| Independent Spec review | PASS; no unresolved critical/high findings (0 outstanding). |
| Independent lifecycle Standards review | PASS. |
| `git diff --check` and documentation-link check | PASS. |

There is no lint script. The prior 78/78 development and 78 passed / 1 skipped packaged baseline, and the earlier 8/8 targeted packaged run, do not include all final review guards.

## Standards

The independent reviewer confirmed the initial size-accounting, header-ordering, Forget/Delete and refused-unlink findings are resolved. Further checks covered lock across Save and native publication, incomplete rewrite verdicts, bounded disposal and the SFTP focus correction. No unresolved critical/high findings remain.

## Spec

The independent reviewer confirmed opt-in capture, incomplete capped files, independent kind limits, ordered deletion/rewrite and visible partial status match the approved scope. The final export and SFTP corrections preserve the privacy and keyboard-focus contracts. AI remains a privacy specification only. No unresolved critical/high findings remain.

Outstanding findings: Standards 0 (worst remaining: none); Spec 0 (worst remaining: none).

## Acceptance and limits

SST-034/T042 is DONE through automated delivery gates. The size-cap, Forget/Delete, header ordering, refused removal, export lock/publication, incomplete-history and quit-drain regressions pass; both independent review axes have zero unresolved critical/high findings. SST-036 is next in the authorized order.

Forget across several closed files can rewrite earlier files before a later rewrite fails. In that case it reports failure, leaves the uncommitted originals available, and does not claim the command was forgotten everywhere. Delete removes only copies controlled by ssterm; encrypted remnants may remain in APFS free blocks or backups, and plaintext exports or the shell's own history are outside the app's control. Existing manual Thai IME, VoiceOver, menu, TCC, signing/notarization and native TextEdit checks remain pending release checks.

## Rollback and rollout

Rollback is a local revert of the SST-034 changes; the catalog schema remains 4. Preserve `userData/recordings/` during rollback because it contains the user's encrypted recordings and history. Do not remove that directory as part of reverting code. No deployment or publication has occurred.
