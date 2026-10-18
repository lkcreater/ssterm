# Workspace templates and multi-target input — SST-033

SST-033/T041 is delivered (2026-10-18): saved workspace configuration and explicit multi-target operations. The execution plan is recorded [here](agent-runs/implementation-plan.md#sst-033-execution-plan--templates--broadcast--multi-host-snippets-2026-10-18). Typecheck/build/package PASS, unit 474/474, development E2E 69/69, packaged 70/70. [Delivery evidence and limits](agent-runs/sst-033-delivery.md).

## Templates

Open **Workspace tools** from the titlebar, including when no terminals are open. **Save workspace template** stores the current tabs, split directions/ratios, active pane/tab and Focus mode, with saved-host references. An optional saved snippet is a reference to its existing encrypted body. Templates contain no terminal history, command text, credentials, or live session IDs.

Restoring appends fresh SSH sessions using the referenced hosts' current settings. Existing sessions keep their layout, generations and history. Duplicate references to the same host open distinct sessions. The app does not restore remote processes or infer a working directory. Authentication and host-key prompts use the existing policies.

**Prepare saved snippet** defaults unchecked. When checked, restore waits for actual Ready sessions and loads the saved snippet into a reviewable composer for those captured targets. It sends no command. Arm and Insert/Run are subsequent explicit actions.

Deleting a host or snippet does not silently rewrite templates. Missing hosts block restore with a visible error; no other host is substituted. A missing optional snippet blocks preparation, while unchecked layout-only restore remains available with a warning. Partial connection failures are reported individually; allocated failed panes remain inspectable and missing allocations are pruned from the split tree.

Templates are bounded to 64 records, eight panes/eight tabs per template, four panes per tab, at most three split levels and split ratios between 20% and 80%.

## Existing and new targets

The multi-target composer has two explicit modes:

- **Existing sessions:** select Ready sessions and **Prepare targets**. It opens no connections. Two sessions on the same host remain distinct recipients.
- **New sessions:** select saved hosts and **Prepare targets**. It opens fresh sessions and waits for their actual Ready/input-accepting state, without reusing existing terminals. Successful targets remain available when others fail.

Preparation captures a fixed set of session IDs and generations, with their labels, endpoints, PROD labels and session suffixes. Focus changes cannot redirect input. Reset targets to choose another set. Snippets are decrypted only after targets have been captured; loading or editing text sends nothing.

## Broadcast composer

**Arm broadcast** visibly arms the prepared composer for the listed targets. Ordinary typing in a terminal remains local to that pane. The app does not fan out xterm protocol responses or source-specific clipboard wrappers.

**Insert without Enter** and **Run on targets** use the existing snippet sanitization and Enter rules. Bytes are planned independently for each destination's current bracketed-paste mode. PROD Run, removed control characters and multiline delivery without bracketed paste require confirmation listing the captured targets. New risk discovered after confirmation requires fresh consent; a reconnected generation is refused rather than substituted.

Sending, editing, Disarm, closing tools, a lock, or an owner change disarms the composer. Closing or locking clears pending text and confirmations. Armed state and operation results are never persisted. Planned byte buffers are wiped as soon as the pane synchronously copies them into its owned input queue; that queue retains its normal bounded cleanup policy.

Per-target results distinguish accepted bytes, refusal, cancellation, empty/oversized input and renewed confirmation. **Accepted bytes do not establish remote command success.** There is no automatic retry or replay.

## Cancellation

Delivery is sequential. Cancel stops undispatched targets; a write already handed to the pane cannot be retracted, so its actual accepted/refused answer remains visible. Cancellation never claims rollback or remote process termination.

During connection preparation, Cancel closes only sessions created by that operation that are still connecting. A main-side `onlyConnecting:true` close guard checks owner, session, generation, kind and phase in the same turn, retaining Ready sessions. Late allocations are fenced and cannot restart cancelled work. Template save/delete metadata requests have no misleading cancel action once invoked.

## Storage and boundaries

Schema 4 adds `workspace_template`. A browser-safe shared validator accepts only the exact version-1 configuration tree and its bounded references. Main authorizes sender/owner/app-lock before reading or writing storage; saves validate current host/snippet references and optimistic revisions. IPC responses project only template metadata.

Migration 3→4 uses the existing verified source-version backup and transaction, preserving protected snippet bytes, secret references and pending credential journals. Older builds refuse schema 4. To roll back, close ssterm, preserve the current catalog, restore the matching `catalog.sqlite.v3-*.backup` (or original v1/v2 backup when upgrading directly), then run the older build.

The pure configuration subpath is bundled into sandboxed preload; no Node-enabled renderer or general filesystem/socket bridge is introduced. No new external service is used.

## Verification scope

Focused unit tests cover exact bounds and extra-field rejection, persistence/revisions/reference deletion, protected schema-3 migration and backup, owner/frame/app-lock fencing, atomic conditional cancellation, layout remapping and delayed state, mixed paste modes, immutable targets, partial results, cancellation in flight and buffer lifetimes. Real Electron development and packaged tests use two owned OpenSSH fixtures, isolated profiles and test Keychain namespaces. Credential-bearing automatic traces/screenshots/video are disabled; visual evidence uses safe fixture content.

Native Thai IME/VoiceOver/menu/TCC release walkthroughs and Developer ID signing/notarization remain separate pending gates.
