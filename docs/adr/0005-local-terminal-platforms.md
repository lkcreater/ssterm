# ADR 0005 — Local terminal and platform delivery boundaries

- Status: accepted for SST-029; runtime evidence is recorded separately in [local terminal](../local-terminal.md).
- Date: 2026-10-18
- Scope: T037, the user's macOS node-pty choice in the [later-scope authorization](../agent-runs/implementation-plan.md#later-scope-authorization--sst-029-to-sst-038-2026-10-17).

## Decision

A local terminal is a transient process capability owned by the same window/session/generation registry as SSH terminals. It is not a catalog host and does not pass through SSH configuration, host-key trust or authentication. The renderer can request a local shell using only its current owner identity. Main chooses the executable, arguments, working directory and environment. The terminal stream contract, input validation, flow limits and lifecycle fences remain shared.

Use the exact official `node-pty` 1.1.0 package and its shipped N-API macOS arm64 addon/helper. Keep native loading in main. Stage only the selected runtime closure, unpack the addon and spawn helper, set helper execute permission, include its license, and verify the actual signed package. `runtime:prepare` prepares the shipped helper after `npm ci --ignore-scripts`; it does not run arbitrary npm lifecycle scripts or download/build a native addon.

Local shell processes have the user's OS privileges. Use a fixed `/bin/sh` guardian as PTY session leader and invoke a fixed `/bin/zsh` interactive child through positional arguments, with home working directory and an allowlisted environment rather than inheriting application build, OAuth, test and debugger variables. Shell startup files/history and commands run by the user remain normal shell behavior; ssterm does not collect that history or persist terminal output. Tests inject a main-only startup-free shell in a fresh private home through the same shipped adapter; no renderer executable/environment capability or production environment-variable bypass is added.

The guardian writes only a numeric child wait status to an owned `0600` file in a transient `0700` OS-temporary directory; confirmed disposal removes it. This preserves a live ownership anchor while ordinary background jobs are inspected after the interactive shell exits. Child status follows shell wait conventions; an explicit high exit code is never guessed to be a signal.

Local target metadata is explicit (`local`, null `hostId`, no SSH endpoint). Show LOCAL and This Mac wherever a user chooses or confirms execution. Split/restart open fresh local processes without replay. Saved workspace templates and multi-target tools remain SSH-only; active single-session snippets retain captured-generation Paste/Run semantics for local shells. Local panes never imply SFTP, forwarding or remote editing.

## Platform matrix

| Platform | Local PTY | Secure store | Desktop packaging | Delivery status |
|---|---|---|---|---|
| macOS arm64 | Verified node-pty 1.1.0 in actual Node/Electron/package | Existing macOS Keychain adapter | Verified ad-hoc macOS package, addon/helper/signature/notices | Delivered automated gates; see verification record |
| macOS x64 | Not enabled by ssterm | Not verified on x64 | No verified artifact | Unsupported/unverified |
| Windows | ConPTY is an upstream possibility; no ssterm adapter gate | Windows credential-store policy/adapter gate pending | Signing, native addon, child cleanup and installer pending | Not delivered; no build claimed |
| Linux | Unix PTY is an upstream possibility; no ssterm adapter gate | Secret Service availability, locked/headless policy and adapter gate pending | Native dependencies, sandbox and distribution gate pending | Not delivered; no build claimed |

Upstream portability is not application verification. The [official node-pty project](https://github.com/microsoft/node-pty) describes its supported platforms; ssterm intentionally gates the delivered adapter to macOS arm64. Other platforms must validate PTY Unicode/flow/exit/job cleanup, secure storage and lock recovery, Electron sandbox/IPC and native packages before advertising support. No Windows/Linux build, installer or credential fallback is introduced here.

## Consequences and limits

The store stays schema 4; local sessions are not restored or synchronized. The adapter must bound input and output, preserve byte ordering and exit tails, and retain cleanup accounting until native work settles. Selected-version private seams must stay isolated and covered by native regression fixtures. Upgrading node-pty requires repeating these gates.

Closing a shell terminates owned foreground/background descendants using confined OS process metadata and bounded cleanup. This is not OS process containment: deliberately detached/reparented daemons, a forcibly killed application or a host crash cannot be promised cleanup. Never kill by process name or accept a renderer PID. Local commands may make their own network requests; the application's SSH/Google network policy covers app-managed connections, not arbitrary programs the user invokes.

Developer ID signing/notarization, OS permission prompts, physical Thai IME, VoiceOver and native TextEdit UI checks remain separate release gates. Rollback removes this feature and its staged dependency after disposing owned local sessions, with no database downgrade.
