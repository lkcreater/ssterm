# SST-017 delivery — identities and SSH keys

**Scope:** SST-017/T023 DONE through independent TEST/REVIEW/DELIVER under the standing loop instruction after SST-016 `06cf5b3`; local commit only, no push, PR or deployment.

## Delivered behavior

Users create, edit and delete reusable identities (password saved in the Keychain or asked at connect, SSH key, keyboard-interactive), import SSH keys through a main-process file dialog, bind identities to servers and groups, and see where each is used. Deleting an identity requires detach or reassign with affected servers and PROD shown. Secrets never reach the renderer state, IPC projections, metadata or logs; there is no reveal or export. When the Keychain is unavailable, identities still work by asking at connect.

## Acceptance and boundaries

Acceptance covered: hosts and groups bind identities; supported key import including encrypted keys; no automatic reveal or export; updates apply to next connections while live sessions keep their login; delete offers detach or reassign; denied or unavailable stores give actionable errors. Closes the ADR 0003 imported-key metadata gap.

## Verification evidence

- Final source: typecheck PASS; unit **257/257**; build PASS; development E2E **40/40**; unsigned macOS arm64 package PASS; packaged E2E **37/37**.
- Independent tester: suites on the reviewed tree, identities spec repeated, 100 packaged probes including Keychain counts, `ssh-keygen` fingerprint parity and file scans. Independent review: no critical/high; the KDF-rounds freeze (medium) and lows fixed.
- Note: one tester probe overwrote the macOS clipboard with a fixture public key before restoring it was fixed.

See [detailed evidence](../identities.md) and [execution record](implementation-plan.md#final-sst-017-record--2026-10-17).

## Impact and rollback

No schema or dependency change. Roll back by removing the identities controller, IPC and page, the commit observer, the namespace gate and the extra catalog projection.
