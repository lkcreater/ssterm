# SST-015 delivery — cancel, disconnect, manual reconnect and cleanup

**Scope:** SST-015/T021 DONE through independent TEST/REVIEW/DELIVER under the standing loop instruction after SST-014 `0d665e0`; local commit only, no push, PR or deployment.

## Delivered behavior

Every terminal pane can Cancel while connecting, Disconnect while ready, and Reconnect or Close once ended, through generation-fenced commands; stale or duplicate clicks never affect a newer attempt. SSH keepalive (15 s × 3 by default) turns a silent network drop into “Connection lost”. Reconnect keeps the same terminal with its history, adds a “Reconnected” line, sizes the new PTY and never replays input. A screen lock or sleep closes sessions with an explicit reason, and Reconnect is the user action that unlocks; a Reconnect that arrived before the lock cannot unlock afterward. Failure reasons are app-owned text. Close pane frees the session slot; quit and renderer crashes reap remote shells.

## Acceptance and boundaries

Acceptance covered: cancel during DNS, trust, auth and ready; unexpected loss as an error state; manual reconnect with a new generation and PTY and no replay; leak-free close/quit; independent sessions. The connect entry point is SST-016; close/quit confirmation and tabs are SST-018.

## Verification evidence

- Final source: typecheck PASS; unit **217/217**; build PASS; development E2E **28/28**; unsigned macOS arm64 package PASS; packaged E2E **25/25**.
- Independent tester: suites on the reviewed tree, lifecycle 3× repeat, production-handler and DNS-cancel probes. Independent review: no critical/high; three mediums and the lows fixed before the final suites.
- Limitations: quit/lock/crash E2E use a fixture registry mirroring main until SST-016 connect; keepalive defaults and real OS sleep are not exercised end to end.

See [detailed evidence](../terminal-lifecycle.md) and [execution record](implementation-plan.md#final-sst-015-record--2026-10-17).

## Impact and rollback

No schema or persistent data change. Roll back by removing the three lifecycle commands, error projection, keepalive option, settled wait, lock epoch and the one-xterm-per-session pane.
