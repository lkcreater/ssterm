# SST-014 delivery — terminal flow control, bounds and measured budget

**Scope:** SST-014/T020 DONE through independent TEST/REVIEW/DELIVER under the standing loop instruction after SST-013 `157b7ba`; local commit only, no push, PR or deployment.

## Delivered behavior

Every terminal bound is named and documented: output credit (default 256 KiB, configurable 64 KiB–1 MiB), input backlog (default 512 KiB, configurable, counting channel and socket queues), one write of 288 KiB so a maximum paste is a single all-or-nothing write, the renderer input queue, scrollback 10,000 lines and 32 sessions. A slow or blocked renderer throttles the remote through the SSH window; a peer that ignores the window or floods tiny packets is cut off with `resource-limit` after 4.5 MiB or 65,536 buffered chunks. A refused paste sends nothing and shows no success notice. Metrics are content-free test receipts only.

## Acceptance and boundaries

Acceptance covered: explicit limits configurable within bounds, preserved order without silent loss, producer throttle or explicit `resource-limit`, and a measured budget recorded with hardware and workload. Persisted scrollback and its aggregate memory cap are SST-018; transfer queues SST-021; disconnect UX SST-015.

## Verification evidence

- Final source: typecheck PASS; unit **197/197**; build PASS; development E2E **22/22**; unsigned macOS arm64 package PASS; packaged E2E **19/19**.
- Budget (M4, Electron 44.7.2): 30–38 MiB/s flood, ≤ 279 KiB unacknowledged, no long tasks, Ctrl+C ≤ 143 ms, blocked renderer sends no frames, 256 KiB paste one write ≤ 96 ms.
- Independent tester: suites, three flow repeats and bounds/atomicity probes. Independent review: no critical/high; the hostile-peer buffering gap (medium) and six lows were fixed before the final suites.

See [detailed evidence](../terminal-flow.md) and [execution record](implementation-plan.md#final-sst-014-record--2026-10-16).

## Impact and rollback

No schema, dependency or persistent data change. Roll back by restoring the previous constants, removing the bounds option and caps and returning to the split paste.
