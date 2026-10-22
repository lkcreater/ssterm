# Remote text editing — SST-032

SST-032/T040 automated delivery is complete (2026-10-18): an explicit external-editor workflow in Files. Typecheck/build/package PASS, unit 514/514, development E2E 72/72, packaged 73/73. [Execution plan](agent-runs/implementation-plan.md#sst-032-execution-plan--remote-editing--transfer-capabilities-2026-10-18), [delivery evidence and limits](agent-runs/sst-032-delivery.md). Native TextEdit UI/autosave remains a manual macOS release check.

## Workflow

Select one regular remote file in a Ready SFTP browser and choose **Edit remote file**. Main captures its owner, session generation, capability, path and target/PROD identity; navigation and reconnect never retarget an existing edit. Supported documents are UTF-8 text without NUL, at most 8 MiB. Selected directories, symlinks, special files, binary/invalid text and oversized files are refused. Atomic replacement support is required for this workflow.

The file downloads privately; no editor opens automatically. **Open in TextEdit** asks first in a right-edge confirmation drawer (SST-040/05) with the captured target/path and Cancel focused. Launch, upload and finish/discard consent each open a fresh drawer that answers only the edit revision and approval captured when it opened; any later change (save check, cleanup, disconnect, lock) closes it without acting. macOS uses fixed `/usr/bin/open -e` arguments and an app-generated `document.txt`, avoiding default application dispatch for a remote `.command`, HTML or other extension. No shell command or executable path comes from the renderer.

Opening shares a plaintext working copy with an independent application. ssterm removes its own copies on cleanup; it cannot revoke TextEdit's memory, backups, autosaves, recent-file history or other copies. The launch confirmation states this limitation.

Save in TextEdit, then choose **Check for changes**. This creates a private immutable snapshot, checks the current remote version, and issues a fresh approval only for an actual local change with an unchanged remote. Neither an editor save, editor exit nor a filesystem event uploads anything.

**Upload changes** asks for confirmation of the captured target/path, revision and snapshot. Subsequent saves cannot silently change the payload already approved. If local bytes changed before dispatch, check again; newer saves while an approved upload is running remain in the working copy. A successful upload keeps that copy for another check or explicit **Finish edit**. Finish/Discard requires confirmation and removes only app-owned local work, not the editor's independent copies or remote partial files.

## Version and publication policy

The version is a SHA-256 digest plus byte length of streamed content. Initial preparation compares the pre-download remote digest, downloaded snapshot and post-download digest, with regular-file/size checks. Equal-size changes with identical whole-second timestamps are detected by content hashing.

Upload checks the remote baseline before staging and immediately before publication. Any observed change, deletion or changed type blocks replacement with a conflict. There is no force-overwrite or automatic retry. Keep independent edits in your editor if needed, then explicitly discard/reopen the current remote file.

Publication uses an exclusive same-directory `.ssterm-<uuid>.part`, requested mode `0600`, successful reads/writes and handle closes, then negotiated OpenSSH atomic replacement. No truncate/unlink-old fallback exists. Replacement does not preserve prior ownership, permissions, ACLs or timestamps; the upload confirmation says so. An acknowledgement does not establish durable fsync.

**SFTP does not provide version compare-and-swap.** Another writer can change a pathname between the final check and rename. Content checks detect observed stale versions; they do not eliminate that race or hostile pathname/directory replacement races.

A failed upload can retain a remote stage; its escaped full path stays visible. Loss or timeout after dispatched publication is `publication-unknown`: the final path may have changed and the stage may have moved. There is no automatic retry. A confirmed publication remains authoritative even if its session closes while the acknowledgement is in flight.

## Lifetimes and cleanup

At most eight retained documents and two active workers are allowed globally. Chunks are at most 64 KiB and honor negotiated remote limits. Main owns every reader, writer, temporary directory, snapshot, approval and cancellation token. Renderer state, SQLite, logs and errors contain metadata only: no file bytes, local working paths, content hashes or launcher commands.

Working directories under `userData/remote-edit-temp` and their UUID children are private `0700`; document/marker files are `0600` and immutable snapshots `0400`. No-follow regular-file checks refuse symlink/FIFO substitutions while supporting normal editor atomic saves. Snapshot creation checks handle and path identity/size/timestamps for concurrent changes. These portable checks cannot prevent a hostile same-UID actor from racing the filesystem.

Discard, lock/suspend, disconnect/generation change, browser host switch, owner revocation and quit invalidate approvals and asynchronous continuations. No editor relaunch, reconnect or upload is replayed. Native operations can outlive visible cancellation; worker permits remain quarantined until their actual results and late handles settle. Pending close/quit counts include idle working copies and cleanup. Once publication is dispatched, cancellation cannot retract it.

Cleanup is limited to verified marked app-owned directories and entries. Failed creation retains an inert cleanup capability if immediate rollback fails, so the document remains counted and explicit cleanup can retry in the same run. Failed cleanup stays visible. Bounded exit attempts cleanup; verified marked leftovers are retried at next startup. Unsafe/unmarked paths are refused rather than broadly deleted, and a startup cleanup failure disables only remote editing.

After lock/disconnect cleanup, a metadata-only result can remain with `localAvailable:false`, disabled editor/check actions and any remote partial path. Such history is not pending work and can be discarded without reopening files. Owner revocation/app exit drops process-memory history; remote stages are never silently deleted.

## Transfer capabilities

The existing local↔remote upload/download queue remains unchanged. **Resume and remote↔remote transfers are not supported in this ticket.** Retry starts from byte zero with fresh staging/consent. Endpoint guards continue to reject same-kind transfer pairs. No server-side direct-copy capability is claimed. The Files panel states these limits.

## Verification and platform limits

Focused tests cover private modes, UTF-8/size bounds, atomic-save and mutation checks, ownership/prune confinement, cleanup retry including failed initialization, fixed launcher arguments, lifecycle/native-I/O quarantine, immutable approvals, same-size/same-mtime remote changes, newer local saves, and publication uncertainty. Main/bridge tests cover sender/frame/app-lock/owner/session/generation/capability and exact metadata guards.

Real Electron/OpenSSH tests run a project-owned external editor process through the shipped launch adapter's dependency seam. They verify no launch/upload before consent, actual editor save/hash round trips, concurrent stale detection, independent documents, local-approval invalidation, lock/disconnect cleanup and stale requests. No real user's TextEdit is launched for automated checks. Native TextEdit UI/autosave behavior remains a manual macOS release check, alongside the existing Thai IME/VoiceOver/menu/TCC and Developer ID/notarization gates.

There is no schema migration; storage remains version 4. Rollback reverts the code and cleans only marked owned working copies. Preserve/check any remote stages or uncertain publication paths separately.
