# SST-022 delivery record — transfer conflicts and staged files

**Status: SST-022/T028 delivery gates complete.** Independent TEST and REVIEW passed with no remaining actionable findings or critical/high concerns. The reviewer verified the post-link inode guard reports an unknown outcome and performs no cleanup when the final path no longer identifies the owned inode. The user instructed “ทำ SST-022 ให้เสร็จ”; SST-022/T028 is the only authorized scope; SST-023–028 and DS05–DS06 remain paused.

## Scope and acceptance

SST-022 extends the Files transfer queue with per-file Overwrite, Skip and Rename decisions, staging, publication, visible retained temporary files, typed failure reporting and explicit retry. It preserves existing destination contents until an explicitly approved publication; unsupported atomic replacement is refused. Retry is a new copy from the captured source and generation, starts at byte zero and requires fresh conflict consent. It never resumes data or replays after reconnect.

Acceptance also covers conflict nonce and owner/generation fencing, bounded queue/worker behavior, integrity checks showing old files survive failed or cancelled overwrites, local and remote publication coverage, rendered UI evidence, and final typecheck, unit, build, development E2E, package, packaged E2E and independent review gates. See [conflict and partial-file behavior](../transfer-conflicts.md) and the [SST-022 execution plan](implementation-plan.md#sst-022-execution-plan--2026-10-17).

## Change summary

The transfer engine gains `conflict`, `publishing` and `skipped` states, per-job conflict nonces, explicit resolution and retry commands, fixed error codes, and captured partial paths. Providers stage files in exclusive same-directory `.ssterm-<uuid>.part` files with requested mode `0600`. Local publication uses exclusive link/unlink for new destinations and rename for approved replacement. SFTP replacement is enabled only when the negotiated POSIX rename extension supports it; standard rename is used for new destinations. The renderer shows captured paths and target, asks for overwrite confirmation with Cancel initially focused, offers Skip/Rename, and reports retained stages and uncertain publication outcomes.

The engine retains partial stages, never silently deletes them, disables cancellation after publication dispatch, and represents an unconfirmed result as `publication-unknown`. Retry creates a new job with fresh staging and consent. No database migration or persisted job queue is introduced. The code and tests also cover permission/quota mapping; quota exhaustion on the host itself has not been induced.

Material files: `packages/{domain,contracts,adapters,services}` transfer/SFTP sources, `apps/desktop/src/main/{transfers,sftp}.ts`, `apps/desktop/src/preload/bridge.ts`, the renderer transfer queue/hook/display helper and CSS, unit tests, and the new `tests/e2e/transfer-conflicts.spec.ts` with `tests/e2e/support/transfer-fixture.ts`.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | PASS on final source |
| `npm test` | PASS, 397/397 |
| Final targeted transfer runtime specs | PASS, 3/3 |
| `npm run test:e2e` | PASS, 54/54 |
| `npm run package:mac` | PASS, unsigned macOS arm64 |
| `npm run test:packaged` | PASS, 51/51 on rerun. The first run had 2 failures in terminal-resize and identities specs (outside SST-022) caused by foreign keystrokes reaching the focused terminal window; no source changed before the passing full rerun |
| Rendered contrast | PASS: description 4.82:1, title 10.37:1, Cancel 15.87:1, Replace 6.63:1, PROD 8.58:1, retained path 13.54:1; screenshot at 960×640 under ignored artifacts/tmp |
| Independent REVIEW | PASS; no remaining actionable findings or critical/high concerns |
| `git diff --check` | PASS |

No lint script exists.

## Limitations and operational impact

No schema migration or persistent transfer history is added. Atomic replacement is provider-specific and not guaranteed universally. SFTP POSIX rename is used only when advertised with the supported version. Publication acknowledgement is not an fsync durability guarantee; a lost acknowledgement can leave the result uncertain, so the app reports both captured paths and does not guess by deleting either. Retry does not reuse prior overwrite approval, resume bytes, reconnect, or replay work.

The local stage ownership check uses inode/device identity, but portable checks and path mutations leave a TOCTOU window when another actor can write to the containing directory. Use directories trusted by the user. Local `ENOSPC`/`EDQUOT` mappings are covered with controlled provider cases; no live disk quota or disk-full configuration was changed. Remote SFTP v3 may return generic failure for quota exhaustion, and the app does not infer a quota cause from server text. Selected directories, symlinks and special files remain outside scope. Packaged E2E is sensitive to external keyboard input while its windows are focused.

## Rollback

Stop and settle active transfers, then revert the SST-022 commit (contract, provider, engine, controller and renderer changes together) to return to SST-021 exclusive-create behavior. Do not automatically delete retained stage files or published destinations. Rollback cannot reconstruct destination contents replaced by an approved overwrite. No external systems or credentials are used by this work.

Local commit only; no push, PR, merge, publish or deployment is authorized.
