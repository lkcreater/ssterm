# SST-032 delivery — remote editing / transfer capabilities

**Status: automated delivery gates complete — 2026-10-18.** Authorized by “ทำงานถัดไปได้” after SST-033 commit `71a3107`, within the approved later-scope order. Local commit only; no push. [Behavior](../remote-edit.md), [plan](implementation-plan.md#sst-032-execution-plan--remote-editing--transfer-capabilities-2026-10-18). Native TextEdit UI/autosave remains a manual release check.

## Scope

- Main-owned remote text editing for one selected Ready SFTP file, captured by owner/session/generation/capability/path and target/PROD. Eight retained edits, two workers, 8 MiB UTF-8/no-NUL bound.
- Private marked working directories/files, immutable snapshots, explicit fixed TextEdit launch, Check changes, fresh snapshot approval and Cancel-first upload/discard confirmation. Content/local paths/digests never cross the feature IPC or enter metadata storage.
- SHA-256 checks before/copy/after download and before staging/publication; same-size/same-mtime remote changes block upload. No override, no automatic save/upload/reconnect/replay, no conditional-rename claim.
- Exclusive private remote stage and negotiated atomic replacement; replacement metadata limitations and retained/uncertain remote paths are visible. Confirmed publication remains authoritative; newer editor saves stay in the working copy until explicit cleanup.
- Owner/session/lock/host-switch/quit cleanup, quarantine of late native I/O, counted/retriable cleanup, safe startup pruning and metadata-only history with accurate `localAvailable` state.
- Optional resume and remote↔remote remain unsupported and are stated in the Files UI. Ordinary Retry starts from byte zero; existing transfer engine behavior stays intact. Schema remains 4; no new external dependency.

## Verification

| Check | Result |
|---|---|
| Typecheck | PASS, all three repository configs after integration |
| Full unit suite | PASS, 514/514, zero skipped/cancelled; authorized host-fixture run |
| Focused final service/boundary | PASS, 21/21; main-only final boundary 5/5 |
| Build | PASS; existing Rollup/Zod warnings |
| Targeted real remote-edit E2E | PASS, 3/3; actual power-monitor lifecycle also passed 1/1 |
| Full development E2E | PASS, 72/72 on final source |
| macOS arm64 package / packaged tests | PASS, ad-hoc signed macOS arm64 / Electron 44.7.2; packaged 73/73 with zero skips/flakes |
| Independent REVIEW | No unresolved critical/high; medium cleanup capability issue fixed |
| Documentation links / staged diff | PASS |

The first full development run passed 71/72. Its sole failure was an owned fixture's `existsSync` → `statSync` race with actual successful native cleanup; the snapshot now treats `ENOENT` as already removed while propagating other errors. Earlier focused focus-trap checks were corrected to poll Base UI's focus correction, matching the existing transfer test convention. The final full rerun passed 72/72, zero skipped/flaky/unexpected tests.

Final packaged verification passed 73/73, including all three remote-edit scenarios, native dependencies, upgrade/same-signature Keychain, package identity/icon/signature and release-quality sweep. Test teardown asserted empty test Keychain namespaces; the final filtered Docker query found no fixture containers. The existing packager warning concerns optional `.icon`; the generated `.icns` passed artifact verification.

Independent analysis/design, adapter/service/main/renderer implementation, initial typecheck/unit and runtime gate work, correctness/privacy review and final delivery evidence review use the repository roles. Root completes the final runtime/package commands and fixes. The initial sandbox-only unit attempt could not bind loopback; the authorized run passed 514/514. There is no lint script.

## Review and integration resolutions

- Failed workspace initialization/abort could lose its cleanup handle when immediate rollback also failed. It now returns an inert cleanup-only capability, with original fixed operation errors and exact ownership validation; service keeps it counted and retries explicit cleanup. Adapter and service regressions cover marker-write/unlink/rmdir/abort failures.
- Lifecycle cleanup preserves only metadata/error/remote-stage information for the current owner, with `localAvailable:false`; UI cannot reopen removed work. Confirmed upload acknowledgement remains Uploaded even after session closure. Owner revocation/app exit drops process-memory history.
- Clean failed downloads originally remained counted as pending work. A reproduced unit regression now confirms zero pending work after actual cleanup while retaining bounded history.
- Main defensively refuses a Ready snapshot lacking a target; close/quit text promises a cleanup attempt and next-start retry of verified marked leftovers, rather than guaranteed immediate deletion.
- Browser-safe SFTP types were extracted without shape changes so remote-edit contracts do not pull Node-dependent domain modules into renderer/preload type graphs. Sandbox and narrow IPC remain enabled.

## Evidence and limits

Real Electron/OpenSSH tests use owned temporary profiles, a disposable SSH host and isolated test Keychain namespaces. The shipped editor launcher adapter runs a project-owned external Node editor through its main-only dependency seam; native TextEdit itself is not launched. Test receipts verify private permissions, actual editor atomic/in-place saves, exact remote hashes, zero automatic upload, cancellation, stale consent, concurrent same-size/timestamp changes, independent documents, binary refusal and lock/disconnect cleanup.

Safe screenshot and measured contrast evidence are kept under ignored `artifacts/sst032/`: CSS 960×640, Retina 1920×1280, reduced motion, Thai paths and PROD. Confirmation contrast: description 4.82:1, title 10.37:1, Cancel 15.87:1, Open 7.14:1, PROD 8.58:1. Automatic credential/file-content traces, screenshots and video are disabled; the captured dialog contains metadata only.

Remote replacement uses requested mode `0600` and can change owner/ACL/timestamps. SFTP has no compare-and-swap; the final-check→rename and hostile same-UID/directory races remain. Remote stages are retained, not silently deleted. Publication-unknown must be checked manually. TextEdit's independent buffers/autosave/history/copies are outside ssterm cleanup; native TextEdit UI/autosave behavior remains a manual macOS release check alongside the existing Thai IME/VoiceOver/menu/TCC and Developer ID/notarization gates.

## Rollback

Revert the commit; storage stays schema 4. Clean only verified marked local working copies with the confined adapter. Keep/check remote stage and uncertain publication paths separately. No arbitrary user files or ordinary transfer stages are deleted; no remote commands or uploads replay on restart.
