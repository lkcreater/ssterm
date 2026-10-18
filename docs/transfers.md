# Transfer jobs, progress and cancellation — SST-021/022

SST-021/T027 adds process-memory upload/download jobs (extended by [SST-022 conflicts and staged publication](transfer-conflicts.md)) to the Files workspace. This is proposed ssterm behavior, independently implemented; Termius observations are contextual evidence only. See [ticket](termius/tickets.md#sst-021--transfer-jobs--progress--cancel), [execution plan](agent-runs/implementation-plan.md#sst-021-execution-plan--2026-10-17) and [browser](sftp-browser.md).

## User contract

Select names in one pane and choose **Upload selected files** or **Download selected files**. Both panes must have a loaded directory and the remote session must be Ready. The invocation captures the raw names, source/destination directories, remote session/generation and its target identity. Later navigation, host edits and reconnect never retarget accepted work. Completion refreshes the captured destination only if that same source/directory is still displayed.

Only regular files transfer. Directories, selected symlinks, sockets, devices, FIFOs and unknown types fail individually with `not-file`; there is no recursion or automatic symlink following. Names retain their Unicode bytes without normalization. Display uses the browser's escaping for control/format characters and edge spaces.

SST-022 copies into exclusive same-directory `.ssterm-<uuid>.part` files with requested mode `0600`. Existing regular destinations require per-file Overwrite (supported atomic replacement only), Skip or Rename; symlinks and special destinations are refused. Final names publish after successful EOF and both closes. See the [conflict/publication contract](transfer-conflicts.md) for consent, race handling and metadata changes.

**Cancelled or failed jobs can leave an incomplete staging file at the displayed temporary path.** It is retained and the queue warns about this policy and marks possible partial outputs. A cancelled remote request may still land before the server processes CLOSE; cancellation does not prove the destination stopped changing at the exact click time. Clear finished never deletes retained files. Explicit Retry creates a fresh attempt against the captured generation; it does not resume or replay automatically. Jobs/history disappear on window ownership revocation or app exit and are never persisted.

## Progress and scheduling

Two worker permits are shared process-wide. At most 100 jobs are retained globally, including queued jobs and finished history. Clear finished removes terminal jobs for the current owner; it never cancels active work. A full queue refuses an entire submission rather than accepting a partial selection.

States are `queued`, `running`, `conflict`, `publishing`, `cancelling`, `completed`, `cancelled`, `failed` and `skipped`. Waiting conflicts release workers but remain pending. Confirmed destination writes advance `bytes`. `total` is nullable; unknown totals are indeterminate. The source's preflight size is an estimate: growth/shrinkage changes total to unknown when observed bytes disagree. A short read continues; only EOF ends copying. Empty files also require successful opens and closes.

The engine awaits one read and one write per chunk. Chunks are at most 64 KiB and respect both providers' negotiated limits. No file is buffered whole. Byte progress is coalesced to at most ten updates per second; state changes publish immediately. Only `completed` displays 100%, after EOF, successful source and staging close, and publication. Closing a file is an acknowledgement, not a claim of durable fsync or a cryptographic integrity check performed by the application.

Queued cancellation opens nothing. Cancellation is refused during dispatched publication; an unconfirmed result is publication-unknown, not proof that the final destination stayed unchanged. Active cancellation fences subsequent writes, aborts supported operations and closes both handles. A single permission/existence/read/write/close failure does not stop independent jobs. Disconnect, explicit SFTP close, host switch, lock/suspend and generation change stop that generation's jobs; reconnect creates a new generation without replay. Window/app close includes pending transfers in the existing confirmation flow. Revocation and shutdown invalidate work before session teardown.

## Boundaries and limitations

`packages/services/src/transfers.ts` owns scheduling/copy/cleanup; `packages/adapters/src/local-transfers.ts` owns local file bytes; the SFTP adapter owns remote handles. `apps/desktop/src/main/transfers.ts` validates sender, owner, endpoint pairing, UTF-8 path/name bounds and exact Ready SFTP capability. Contracts/preload carry metadata and fixed error codes only, with owner/sequence event fences. No file-content IPC, arbitrary filesystem grants, secrets, server messages or persisted transfer queues are introduced.

Local readers use `O_NOFOLLOW | O_NONBLOCK` and validate the opened handle as regular before reading. Remote readers validate handle FSTAT after OPEN. Portable SFTP v3 cannot eliminate pathname replacement races: a selected regular path could become a symlink between lstat and OPEN, and intermediate directory symlinks follow ordinary explicit-path filesystem semantics. No recursive traversal is involved. A remote FIFO OPEN can stall before FSTAT, so watchdog teardown remains necessary.

Each operation has a 30-second watchdog; cleanup has a two-second deadline. A stalled remote request closes only its captured SFTP generation; other SSH terminal sessions remain independent. A local OS filesystem call cannot be forcibly cancelled from JavaScript. Its internal worker permit remains quarantined until the actual native promise and late-handle cleanup settle, even after a visible terminal state or history clear. Two indefinitely stalled local operations therefore stall queue admission rather than accumulating native work. Pending close/quit counts include these workers even after a visible failure or history clear. A killable utility process is deferred.

## Verification

Historical SST-021 commands/counts are in its [delivery record](agent-runs/sst-021-delivery.md); current conflict/staging verification is in the [SST-022 delivery record](agent-runs/sst-022-delivery.md). Tests cover bounded scheduling, close-gated completion, unknown/zero/changing totals, short reads, queued/active/late-open cancellation, operation/cleanup timeouts, owner/generation fences, exclusive creation and local link/FIFO refusal. The real OpenSSH/Electron walk checks upload/download hashes, multiple jobs, cancellation, retained partials, independent failures, disconnect/lock/reconnect without replay and the rendered queue.

Rendered queue evidence on macOS arm64 at CSS 960×640 (DPR 2), with Thai paths and reduced motion: warning text 6.29:1, primary text 13.54:1, error text 5.65:1 and PROD badge 8.58:1 against actual composited surfaces. Cancel retains keyboard focus through terminal updates; long paths wrap and the queue remains scrollable without horizontal overflow.

## Remote-edit and advanced capability clarification — SST-032

[Remote editing](remote-edit.md) is a separate bounded workflow with immutable local snapshots and content-version consent. Ordinary upload/download behavior above remains unchanged. Resume and remote↔remote copying are unavailable; Retry creates a fresh copy from byte zero. No server-side-copy capability is claimed. Remote-edit local copies are cleaned under their own ownership rules; this never removes ordinary retained `.part` transfer files.
