# SST-021 delivery record — transfer jobs

**Status: SST-021/T027 delivery gates complete.** Independent TEST and REVIEW passed. The final pending-count fix was included in the targeted development rerun and packaged suite; the broader development suite had passed immediately before that bookkeeping fix.

## Scope and acceptance

SST-021/T027 adds process-memory SFTP uploads and downloads for regular files in the Files workspace. Accepted jobs capture their source, destination, remote session/generation, and target. The main process owns a metadata-only typed IPC boundary and a two-slot global queue capped at 100 retained jobs. Progress is throttled, unknown totals stay indeterminate, and running work cannot show 100%; completion waits for EOF and successful source and destination closes. Queued and active cancellation, generation cleanup, fixed error codes, exclusive destination creation, and visible retained-partial warnings are in scope.

Acceptance also requires real upload/download content comparison, queue and cancellation behavior, independent job failure, stale-generation fencing, Files UI coverage, and clean typecheck, unit, build, development E2E, macOS arm64 package, and packaged E2E gates. Independent review must have no unresolved critical or high findings.

## Current change

The working tree adds the transfer job service and local file adapter, SFTP source-handle regular-file validation and destination writes, main-process composition and lifecycle wiring, transfer contracts and preload methods, queue/progress UI, and unit/E2E coverage. It also adds [transfer behavior documentation](../transfers.md) and records the authorized SST-021 plan in [the implementation ledger](implementation-plan.md#sst-021-execution-plan--2026-10-17).

No SQLite schema or migration is introduced. Jobs and history live only in process memory. The feature uses the existing test-only SSH fixtures and isolated test Keychain namespace; tests must not use production credentials or namespaces.

## Verification status

| Check | Current evidence |
|---|---|
| `npm run typecheck` | PASS, final run |
| `npm run build` / `npm run package:mac` | PASS; unsigned app at `artifacts/package/SSTerm-darwin-arm64` |
| Focused pending-count/quarantine regression | PASS, 15 tests after final fix |
| `npm test` | PASS, 374/374 |
| `npm run test:e2e` | PASS, full development suite 52/52 before the final pending-count bookkeeping fix |
| Final targeted development transfer E2E | PASS, 1/1 in 13.1s after the final fix |
| `npm run test:packaged` | PASS, 49/49 in 4.2m; includes final transfer and rendered-contrast coverage |
| Rendered contrast | PASS: warning 6.29:1, primary text 13.54:1, error 5.65:1, PROD badge 8.58:1; all exceed 4.5:1. Evidence: `/tmp/ssterm-transfers-rendered-contrast.json`; screenshot: `/tmp/ssterm-transfers-960x640.png` |
| Independent REVIEW | PASS; pending-count fix verified, no unresolved findings or critical/high blockers |
| `git diff --check` | PASS |

The final fix ensures history removal does not decrement the pending count or release a permit before the native operation and late-handle cleanup actually settle. Its focused regression suite passed (15 tests), and the reviewer verified the fix with no unresolved findings. The full development suite passed before this final bookkeeping change; the modified transfer E2E and full packaged suite passed afterward. No final check reported a failure. No lint script exists. The full development run's JSON report was overwritten by the targeted run, so no full-suite JSON artifact path is claimed here.

## Limitations and operational impact

This change has no database migration, persistent queue, resume, overwrite/conflict handling, recursive transfer, temporary-file publication, or automatic partial-file cleanup. Cancelled or failed transfers may leave a new partial destination, which remains visible and is warned about. SFTP v3 pathname replacement between checks and OPEN remains a TOCTOU limitation. JavaScript cannot forcibly stop a stuck local OS file operation; its permit remains quarantined until the native promise settles, which can stall new queue work. Unknown source size remains indeterminate. Active-transfer quit confirmation is covered by unit branches but has not yet been exercised in runtime E2E.

There is no deployment or external-service impact. The eventual packaged verification target is the existing unsigned macOS arm64 application.

## Rollback

No data migration needs reversal. Revert the SST-021 transfer code and its IPC/UI wiring together to return Files to browse-only behavior. Dispose the transfer controller and close acquired handles before removing its wiring. Do not delete partial destination files: they are user-visible outputs and may contain useful transferred data. Preserve unrelated and pre-existing workspace changes.

No push, merge, PR, or deployment has occurred. The local commit is handled by the parent agent after this delivery record is finalized.
