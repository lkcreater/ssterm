# SST-014 — Terminal flow control, bounds and measured budget

**2026-10-16 · T020 · DONE through independent TEST/REVIEW/DELIVER; committed under the standing loop instruction.** Authorized by the standing loop instruction after SST-013 commit `157b7ba`. Scope is explicit bounds, backpressure, atomic large paste and a measured budget for the terminal stream. Persisted scrollback/settings UI (SST-018), transfer queues (SST-021) and disconnect UX (SST-015) are separate. [Execution plan](agent-runs/implementation-plan.md#sst-014-execution-plan--2026-10-16).

## Bounds

| Layer | Bound | Behavior at the bound |
|---|---|---|
| Output credit (main → renderer, unacknowledged) | `outputWindow` default 256 KiB, configurable 64 KiB–1 MiB | The adapter pauses the ssh2 channel; the SSH window closes and the remote process blocks. Nothing is dropped. |
| ssh2 buffering per session | Compliant peers: ≈ 2 MiB SSH window + 2 MiB readable high-water mark (measured peak 3.75 MiB, 120 chunks) | Hard caps 4.5 MiB or 65,536 buffered chunks across stdout/stderr: a peer that ignores the SSH window or floods tiny packets fails the session with `resource-limit` and the channel is destroyed. |
| Input backlog (main) | `inputBacklog` default 512 KiB, configurable from one maximum write to 2 MiB; counts the channel and the SSH socket write queues | `busy`: the write is refused whole and nothing is queued; the pane pauses later input until “Resume input”. |
| One write | 288 KiB (`MAX_TERMINAL_WRITE` ≥ 256 KiB paste + 12 bracket bytes) | A paste is one all-or-nothing write, so the remote receives the whole bracketed paste or none of it. |
| Renderer input queue | 288 KiB + 32 KiB | Overflow pauses input explicitly. |
| Paste | 256 KiB UTF-8 | Refused with a message. |
| IPC output frame | 1 B–1 MiB (actual frames are single ssh2 chunks, p50 ≈ 2 KiB) | Invalid frames are never sent. |
| xterm write buffer | 50 MB discard watermark | Unreachable: acknowledgements follow xterm's write callback, so pending renderer data stays within the credit window. |
| Scrollback | `TERMINAL_SCROLLBACK` 10,000 lines (AppSettings later allows 100–100,000; SST-018 wires it) | xterm drops the oldest lines. Memory ≈ 12 B × columns × lines per session (10,000 × 163 columns ≈ 18.7 MiB); the aggregate cap is decided with persisted settings in SST-018. |
| Sessions | 32 per registry (configurable downward) | `resource-limit`. |

Stream bounds are a main-only option on `createSavedHostSessions({terminal})`, validated by `terminalBounds()` in the adapter and again in main (`RangeError("invalid-terminal-bounds")`), passed as a frozen copy; they are not user settings. A paste accepted by `write` can still arrive partly if the channel closes before the remote window reopens; refusal is always whole. One frame and one acknowledgement per chunk is the measured design; merging chunks per event-loop tick is the recorded upgrade path if headroom is needed.

## Measured budget

Reference environment: Apple M4 16 GB, macOS 15, Electron 44.7.2, loopback Docker `ssterm-ssh-fixture:m0`, production adapter, shipped renderer.

| Measure | Gate | Development | Packaged |
|---|---|---|---|
| 20 MB flood throughput | ≥ 10 MiB/s | 30.3–35.5 MiB/s | 36.1 MiB/s |
| Maximum unacknowledged | ≤ window + 32 KiB | 271–275 KiB | 273 KiB |
| Long tasks during flood | none > 100 ms | 0 | 0 |
| Animation-frame p95 | recorded (target ≤ 33 ms) | 17.9–18.7 ms | 18.2 ms |
| Marker after Ctrl+C mid-flood | ≤ 1 s | 66–94 ms | 82 ms |
| Renderer blocked 3 s: maximum unacknowledged | ≤ window + 32 KiB | 270–277 KiB | 277 KiB |
| Renderer blocked 3 s: main RSS growth | ≤ 96 MiB (secondary; frames-while-blocked and maximum unacknowledged are the precise gates) | 16.4–38.6 MiB | 21.3–22.1 MiB |
| 256 KiB paste | ≤ 2 s, one write | 49–61 ms, 1 write | 48 ms, 1 write |
| Main RSS / renderer working set peak | recorded | ≈ 170 / 205 MiB | 170 / 205 MiB |

ANALYZE probes outside the app measured the adapter alone at 51–57 MiB/s (sshd-bound), four concurrent floods at 45–54 MiB/s aggregate with main event-loop lag ≤ 4 ms, and confirmed that batching acknowledgements alone gives no end-to-end gain. Metrics exist only as content-free test receipts (frames, bytes, acknowledgements, maximum unacknowledged, timings, process memory); nothing new is logged or sent over IPC.

## Verification

Final source: `npm run typecheck` PASS, `npm test` **197/197**, `npm run build` PASS, `npm run test:e2e` **22/22**, `npm run package:mac` PASS (unsigned arm64), `npm run test:packaged` **19/19**.

[Adapter tests](../tests/unit/ssh-session.test.ts) cover the credit window at the default and at 64 KiB, all-or-nothing maximum writes with `busy`, the socket write queue in the input backlog, bounds validation (adapter and main, frozen copy) and the hostile-peer caps against a real loopback ssh2 server: a peer ignoring the SSH window and a tiny-packet flood both end `Failed/resource-limit` with bounded delivery, while a compliant 16 MB flood with a stalled consumer stays Ready and byte-exact. [Input tests](../tests/unit/terminal-input.test.ts) assert `MAX_TERMINAL_WRITE` and `MAX_QUEUED_INPUT` ≥ paste + 12. [Flow E2E](../tests/e2e/terminal-flow.spec.ts) runs the budget gates above in development and packaged builds; its blocked-renderer phase proves its own instrument by observing the 3 s block as a long task.

The independent tester ran the suites (193/22/19), three repeats of the flow spec and probes: nine out-of-range bounds rejected, configured bounds reaching the session (64 KiB window → ≈ 84 KB unacknowledged), byte-exact delivery and a refused paste sending nothing partial. Review found no critical/high; the medium hostile-peer buffering gap and all lows were fixed (socket backlog, required paste acceptance, no success notice on refusal, adapter-level validation, single insertText for the Ctrl+C marker, RSS gate widened, derived window limit).

## Boundaries and rollback

Unmeasured: real networks with latency (the 2 MiB SSH window then dominates), windows hidden longer than five minutes (Chromium background throttling; `backgroundThrottling` unchanged) and live memory at 32 sessions. Rollback restores the previous constants and the five-write paste split; there is no data change.

## Recording on — SST-034

[Session recording](recording.md) tees each frame in main after the view's consumer: a copy into a 64 KiB buffer and one AES-256-GCM seal per full segment, synchronously; file writes are asynchronous. It never holds credit or acknowledgements: a slow disk drops output above 8 MiB pending (32 MiB for all recordings) with an authenticated gap record, so the flow design above is unchanged. A second flood test runs with recording on and keeps the same gates, plus a main event-loop delay gate (p99 ≤ 4 ms, perf_hooks histogram) and byte accounting (export length + recorded gap bytes = bytes the view received). Four runs on this machine: 21.3–36.0 MiB/s, max unacknowledged ≤ 273 KiB, no long task, loop delay p99 2.03–2.37 ms (max 10–23 ms), 0 gaps, 20 400 648 of 20 400 648 bytes in the log. The recording-off flood, now also measured for loop delay: 26.9–34.4 MiB/s, p99 1.62–2.24 ms, max 3–20 ms.
