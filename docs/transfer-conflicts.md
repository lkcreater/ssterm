# Transfer conflicts and partial files — SST-022

SST-022/T028 extends the [transfer engine](transfers.md) with per-file conflict decisions, staged publication and fresh retries. These are independently implemented ssterm decisions, not claims of Termius compatibility. See [ticket](termius/tickets.md#sst-022--transfer-conflicts--partial-files--errors) and [execution plan](agent-runs/implementation-plan.md#sst-022-execution-plan--2026-10-17).

## Conflict decisions

When a regular file exists at the captured destination, the job enters `conflict` and releases its worker without opening file handles. Its target, PROD label and full source/destination paths stay visible. Choose one action for that job:

- **Overwrite** asks for confirmation with Cancel focused initially. The decision applies to the displayed captured pathname, not a particular inode. It is available only when the destination supports atomic replacement.
- **Skip** ends this job without copying or modifying its destination.
- **Rename** accepts one raw filename in the captured destination directory. It preserves Unicode and spaces; separators, dot-only names, NUL, malformed/unaddressable text and oversized names are refused. Another existing name produces another conflict with a new nonce.

Owner, job ID, current conflict nonce and exact Ready remote session/generation fence each response. Duplicate, stale or foreign responses are refused. Existing directories, selected symlinks and special files cannot be overwritten. No “apply to all” or automatic overwrite preference is stored. Waiting conflicts remain bounded by the 100-job cap and count in close/quit prompts while other jobs can use the two workers.

## Staging and publication

The copy opens a random same-directory `.ssterm-<uuid>.part` exclusively, requesting mode `0600`. The final destination stays untouched during reads, writes and both handle closes. After successful EOF and closes, the job enters `publishing`. Only successful publication displays 100%.

| Destination | New/renamed final path | Explicit overwrite |
|---|---|---|
| This Mac | Exclusive hard link from stage, then stage unlink | Same-directory POSIX rename |
| SFTP | Standard SFTP rename, which refuses an existing destination | OpenSSH POSIX rename only when advertised with supported version `1` |

The protocol distinction and advertised-version gate follow [OpenSSH's protocol extension specification](https://raw.githubusercontent.com/openssh/openssh-portable/master/PROTOCOL) and [SFTP v3 rename semantics](https://www.openssh.org/txt/draft-ietf-secsh-filexfer-02.txt). There is no unlink-old/truncate-old fallback. Servers/filesystems that refuse a supported operation yield a failure; atomic replacement is not claimed universally. Missing publication support fails safely. Successful close/rename is not a durable fsync guarantee. A staged replacement uses the new file's requested permissions and may change prior destination ownership, permissions, timestamps, ACLs or extended metadata; these are not preserved.

A destination created after preflight is preserved by nonreplacement publication. The job fails clearly and retains its stage; a fresh Retry can encounter that conflict normally. Overwrite rechecks target type before publication, but portable APIs do not provide compare-and-swap against the file originally observed in the dialog.

## Partial files, cancellation and uncertain outcomes

Failed/cancelled stages are retained at the exact escaped path shown in the queue. They are not silently deleted or resumed. Clear finished clears history only; it never deletes files. Retained paths/history are not persisted after owner revocation or app exit. When local hard-link publication succeeds but stage unlink fails, the job is Completed and explicitly reports that the full destination was published while a temporary alias remains.

Cancel works for queued, transferring and conflict jobs. Once publication begins, its Cancel action is refused in main/service and disabled in the UI: the filesystem operation may already commit. Lifecycle cancellation still tears down resources. A successful publication acknowledgement is authoritative even if a session closes meanwhile. A timeout or lost connection after an unconfirmed publication request yields `publication-unknown`: the destination may have changed and the stage may have moved. Check both paths; the application never deletes the final path as cleanup and disables Retry for this uncertain job.

Retry is an explicit new job that rereads the source from the beginning with the original captured paths and session/generation. It needs a live matching generation, waits for the previous native cleanup to settle and obtains fresh conflict consent. It does not reconnect, reuse overwrite approval, resume bytes or remove old stages. Reconnect does not replay transfers.

## Filesystem trust and errors

Use directories trusted by the user. Local stage ownership tracks the inode/device created by exclusive open and refuses known substituted stage paths before publication; bounded ownership records do not grant arbitrary deletion access. Inode checks and unlink/rename are separate portable operations. A hostile actor with write access to the directory can race between checks and mutation; the implementation does not claim an atomic conditional unlink or protection against a malicious same-UID/directory owner. Remote SFTP v3 also lacks portable pathname/inode compare-and-swap. Directory symlink/path replacement limitations remain as documented for SST-021.

Local `ENOSPC` and `EDQUOT` map to `no-space` and `quota-exceeded`. Permission, path, missing file, resource, connection and timeout failures have fixed messages. SFTP v3 may return generic failure for disk/quota exhaustion; the app does not parse server text or claim a quota diagnosis from that status. No server exception text, credentials or file bytes cross IPC. The existing native-I/O quarantine and cleanup accounting remain in force.

## Verification

The final [delivery record](agent-runs/sst-022-delivery.md) records actual typecheck/unit/build, independent development and packaged OpenSSH/UI results, review and limits. Controlled adapter/provider tests cover errors and publication races that cannot safely be induced by changing the host's disk/quota configuration. Runtime evidence uses temporary local directories, owned Docker OpenSSH and isolated Keychain namespaces; no production systems or credentials are used.

Rendered evidence on macOS arm64, CSS 960×640/DPR 2 with reduced motion and Thai names: confirmation description 4.82:1, title 10.37:1, Cancel 15.87:1, Replace 6.63:1, PROD 8.58:1 and retained path 13.54:1. Keyboard checks cover Cancel's initial focus, Tab containment, Escape/focus return and rename validation. Real fixture hashes verify both transfer directions and that cancelled overwrite leaves the old final intact; supported/unsupported extension and publication uncertainty branches also have focused provider tests. Host disk-full/quota configuration is not modified for verification.
