# SST-026 delivery record — tunnel rules and status UI

**Status: SST-026/T032 delivery gates complete.** Authorized by “งานนี้เสร็จ ทำ SST-026, 027 ต่อได้เลย”. Local commit only; no push, PR, publish or deployment. SST-027 follows; SST-028 and DS05–DS06 remain paused.

## Scope

Catalog tunnel-rule intents and projection; running-rule guards (prepare and apply); owner-bound tunnel IPC and controller; Port forwarding page with state, validation, explicit restart and delete; delete-host message for running tunnels. Details in [tunnels](../tunnels.md#tunnel-rules-and-status-ui--sst-026).

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` / `npm run build` | PASS |
| `npm test` | PASS, 421/421 |
| `npm run test:e2e` | PASS, 59/59 (adds `tunnels-ui.spec.ts`) |
| `npm run package:mac` / `npm run test:packaged` | PASS; 56/56 |
| Independent REVIEW | no critical/high. Fixed: edit flow could leave the tunnel stopped silently (dry-run before stop, restart intent kept, explicit message), stale failed status after edit/delete, locked-start text, edit dialog turning into create, shared busy state, preview rule cleanup, duplicate notices, arrow label, live status, alert titles. Recorded: truncated-catalog servers, service-wide guard, server edits while running |
| `git diff --check` | PASS |

## Rollback

No schema change. Revert the commit to return to the main-only service; saved rules stay in storage.
