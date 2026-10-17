# SST-027 delivery record — MVP end-to-end / accessibility / regression gate

**Status: automated gate complete; manual Thai IME walkthrough pending.** Authorized by “งานนี้เสร็จ ทำ SST-026, 027 ต่อได้เลย”. Local commit only; no push, PR, publish or deployment. SST-028 and DS06 remain paused.

## Scope

Traceability of F01–F06 and the required failure/security matrix to real tests; gap tests (DS05 page-wide sweep at two sizes with reduced motion, unwritable storage, keyboard-interactive on OpenSSH/PAM); SST-014 budget measurement; independent release-blocker audit and fixes. Report: [MVP gate](../mvp-gate.md).

## Changes

- New `tests/e2e/release-gate.spec.ts` (3 tests), added to development and packaged projects.
- Fix: the icon-only combobox trigger (`components/ui/combobox.tsx`) gets an accessible name.
- Fix (audit medium): `TunnelService` refuses starts for owners revoked while the start waited, and refuses a restart superseded by a concurrent stop; the tunnel controller re-checks the window after unlock. Regression test in `tests/unit/tunnels.test.ts`.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | PASS |
| `npm test` | PASS, 422/422 |
| `npm run test:e2e` | PASS, 62/62 on final source. An earlier full run had one `transfers.spec.ts` quit-time process-count miss (2 within 10 s); 2/2 isolated reruns and the final full run passed |
| `npm run package:mac` / `npm run test:packaged` | PASS; 59/59 |
| DS05 sweep | 0 findings across 18 views × checks (contrast, names, overflow, motion, focus, dialog focus return) |
| Budgets | all SST-014 gates met (36.7 MiB/s, 272 KiB, 0 long tasks, 97 ms Ctrl+C, 22 MiB growth, 1-write paste) |
| Release-blocker audit | no open critical/high; one medium fixed |
| `git diff --check` | PASS |

## Not done

Manual macOS Thai IME walkthrough (physical layouts), VoiceOver and real-menu clipboard checks — need a human operator; recorded as deviations in the gate report. T034 and DS05/T051 stay open for that manual part.

## Rollback

Test and small fix changes only; revert the commit.
