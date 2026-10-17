# SST-019 delivery — SFTP capability and ownership

**Scope:** SST-019/T025 DONE through independent TEST/REVIEW/DELIVER under the standing loop instruction after SST-018 `56c85d6`; local commit only, no push, PR or deployment.

## Delivered behavior

SFTP sessions are a session kind with their own SSH connection, sharing host-key trust, credential prompts, keepalive, lock, quit and generation fencing with terminals. A main-only capability browses, stats, reads and writes (exclusive create) with bounded handles and requests, typed failures without server text, and no operation that can hang after the channel ends. Closing SFTP never affects terminals and vice versa. There is no renderer access yet.

## Acceptance and boundaries

Acceptance covered: browse/stat/read/write primitives; shared known-host and authentication policy; an unavailable subsystem as a typed result; closing the capability without closing other sessions; handles returned and late replies invalidated at session end. Browser UI and IPC are SST-020; transfers SST-021; overwrite, temp files and partial-file policy SST-022.

## Verification evidence

- Final source: typecheck PASS; unit **305/305**; build PASS; development E2E **49/49**; unsigned macOS arm64 package PASS; packaged E2E **46/46**.
- Independent tester: suites on the reviewed tree, SFTP spec 3× repeated, real-OpenSSH probes for trust, subsystem failures, independence, hang safety, caps, keepalive and throughput. Independent review: no critical/high; three mediums and lows fixed.

See [detailed evidence](../sftp.md) and [execution record](implementation-plan.md#final-sst-019-record--2026-10-17).

## Impact and rollback

No schema or dependency change. Roll back by removing the session kind, the SFTP adapter and its tests.
