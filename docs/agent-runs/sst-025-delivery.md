# SST-025 delivery record — local tunnel service

**Status: SST-025/T031 delivery gates complete.** Authorized by “เริ่ม SST-025 ได้”; the user then instructed “งานนี้เสร็จ ทำ SST-026, 027 ต่อได้เลย”. Local commit only; no push, PR, publish or deployment.

## Scope

Session kind `tunnel` with a `TunnelChannel` over `forwardOut`; loopback listener adapter with typed bind errors and a wildcard-shadow probe; `TunnelService` (bind-first start, Ready gating, bounded forwarding, teardown on stop/failure/lock/quit/owner revocation); main composition. Details in [tunnels](../tunnels.md).

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | PASS |
| `npm test` | PASS, 418/418 |
| `npm run test:e2e` | 57/58 on final source; the failure was `terminal-flow` throughput (5.6 < 10 MiB/s) under full-suite host load, a path SST-025 does not touch; rerun 3/3 PASS in isolation. `tunnel.spec.ts` PASS |
| `npm run package:mac` / `npm run test:packaged` | PASS; 55/55 |
| Independent REVIEW | no critical/high. Fixed: listener leak after bind timeout, stale failed event after restart, wildcard-occupant shadowing (verified on macOS), half-close, stop/dispose awaiting failed teardowns, listener error after bind, revoked observers, quit drain ordering, observer comment. Recorded: probe/bind race, 16-open burst limit, observer-budget starting state |
| `git diff --check` | PASS |

## Rollback

No schema or IPC change; revert the commit. Nothing persists tunnel state.
