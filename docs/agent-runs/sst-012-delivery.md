# SST-012 delivery — terminal byte stream, resize and exit

**Scope:** SST-012/T018 DONE through independent TEST/REVIEW/DELIVER, authorized by “ทำงานต่อได้” after SST-011 `4ded3e9`. The subsequent user instruction “commit และทำงานทัดไป” authorizes this SST-012 delivery commit and then SST-013. No push, PR, merge or deployment is authorized.

## Delivered behavior

A Ready session now presents a live xterm.js terminal in the workspace. Output is delivered in order as numbered exact-length chunks under a 256 KiB credit window that pauses and resumes the SSH channel, with no main-side queue and no silent drop. Typed input reaches the remote shell in order; a backlog over 256 KiB is refused explicitly and the pane pauses later keystrokes until the user resumes. The pane's grid sets the remote PTY size and follows window resizes.

A remote exit status, exit signal or EOF is reported after the final output and shown distinctly from a local close; a socket loss after Ready is a connection failure. This fixes a pre-existing defect where a remote `exit` left the session `Ready` indefinitely. Reconnect creates a new generation, channel and pane; stale-generation commands return `conflict` and no input is replayed.

Remote bytes reach the screen only through xterm's parser. OSC 8 link activation is inert, no clipboard or web-links addon is loaded, window reports and proposed APIs are off and xterm logging is disabled. Each pane shows the captured target, explicit PROD and a Signal Blue status with icon and text.

## Acceptance and boundaries

The implementation satisfies the SST-012 acceptance: ordered input/output, PTY rows/columns, resize reaching the remote TTY, remote exit status/signal/EOF distinct from local close, reconnect without replay and output through a declared parser trust boundary. `@xterm/xterm` 6.0.0 and `@xterm/addon-fit` 0.11.0 are exact pins ([ADR 0001 outcome](../adr/0001-mvp-platform-stack.md#sst-012-terminal-renderer-outcome--2026-10-16)). No schema change.

There is no renderer connect command (SST-016); E2E starts sessions from main. Unicode/IME/clipboard/URL actions are SST-013, measured flow-control budgets SST-014, disconnect/reconnect UX and failure detail SST-015, tabs/splits SST-018.

## Verification evidence

- Final source: typecheck PASS; unit **173/173**; build PASS; development E2E **20/20**; unsigned macOS arm64 package PASS; packaged E2E **17/17**; zero skipped/unexpected/flaky.
- Independent tester reproduced the full suites on an earlier source revision (173 / 20 / 17) and ran the terminal spec 12 times on the real path without failure. An earlier single packaged failure (a typed `p` repeated about 80 times) was not reproduced; tester and reviewer traced the whole input path and found no duplication mechanism.
- Real Docker OpenSSH E2E through the shipped adapter, controller, handlers, bridge and pane: typed echo, `stty size` before and after resize, alternate screen, 2,000,000 bytes with consecutive frames from 0, `exit 7`, SIGKILL, connection loss, local close, no replay after reconnect, literal HTML and inert OSC 8.
- Independent review found no critical/high findings. Three low findings were fixed after review (username bound aligned with storage, a reset after a recorded exit still reports the exit, a second open on the same generation returns `conflict`); the full suites above ran after those fixes.
- ASAR inspection: xterm only in the renderer bundle, no fixtures/spikes/test content or project private keys, no worker/blob/eval. Zero test-Keychain items and fixture containers remain.

See [detailed evidence](../terminal.md) and [execution record](implementation-plan.md#final-sst-012-record--2026-10-16).

## Impact and rollback

The change adds a live terminal to the local desktop and two renderer dependencies. It adds no database migration or persistent terminal content. The macOS package is a local unsigned verification artifact; nothing has been published or deployed.

To roll back, remove the terminal controller/handlers/bridge methods and the pane, restore the paused-channel adapter and remove the xterm pins. Catalog, known-host and OS-secret records need no change.
