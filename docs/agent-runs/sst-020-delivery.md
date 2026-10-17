# SST-020 delivery — SFTP local and remote browser

**Scope:** SST-020/T026 DONE through independent TEST/REVIEW/DELIVER under the standing loop instruction after SST-019 `fb8b157`; the user then asked to stop after this ticket. Local commit only, no push, PR or deployment.

## Delivered behavior

A Files page shows This Mac and a remote server side by side. Users open SFTP from a host, from a terminal pane (same host and identity) or from a picker, browse with breadcrumbs, typed paths, hidden-file toggle, symlink navigation and a keyboard-first list that handles 10,000 entries, and copy full paths. Hostile, invisible or undecodable names are shown safely; long names stay distinguishable. The renderer never touches the filesystem: main serves metadata through fenced IPC, and the remote session shares the terminal lifecycle (cancel, disconnect, reconnect, lock recovery).

## Acceptance and boundaries

Acceptance covered: directory and path navigation; hidden toggle; names, types and sizes; loading and error states; clear symlinks; target captured at action time; open-from-host with the correct identity; no broad filesystem grants. Transfers are SST-021 and conflicts SST-022.

## Verification evidence

- Final source: typecheck PASS; unit **348/348**; build PASS; development E2E **51/51**; unsigned macOS arm64 package PASS; packaged E2E **48/48**.
- Independent tester and reviewer: no critical/high; mediums and tester findings fixed before the final suites.

See [detailed evidence](../sftp-browser.md) and [execution record](implementation-plan.md#final-sst-020-record--2026-10-17).

## Impact and rollback

No schema or dependency change. Roll back by removing the Files page, file IPC, local provider and the shared lifecycle helper extraction.
