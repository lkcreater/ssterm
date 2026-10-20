# SST-038 / T044 — bounded Mosh and FIDO investigation

Date: 2026-10-20. Scope: owned Docker Mosh runtime experiment and FIDO ADR only, according to the [recorded authorization](implementation-plan.md#later-scope-authorization--sst-029-to-sst-038-2026-10-17).

## Result

The isolated native Linux arm64 Mosh probe passes 11 checks: strict SSH trust/auth rejection, positive bootstrap/native PTY, UTF-8, remote resize, recovery after a 3-second UDP blackhole in the same shell, source-port rebinding in that shell, bounded blocked-start cancellation, and owned process cleanup. Host runner also verifies removal of its exact owned container. No production transport, identity method, dependency, IPC, schema or UI changes.

- [Capability report](../spikes/mosh-fido-capabilities.md): observed results, identity and unverified scenarios.
- [ADR 0007](../adr/0007-mosh-and-security-key-capability-gates.md): production Mosh gates and untested FIDO hardware matrix.
- [Fixture and commands](../../tests/fixtures/mosh/README.md): standard-library Python, separate image, generated lab-only keys, private network namespace and sanitized receipts.

## Validation and review

Implementation run passed all 11 probe checks and owned-container removal. Independent repeat exited 0 with the same image/package/hash identities, all 11 probe checks true and `ownedContainerRemoved=true`. Python AST syntax and `git diff --check` passed; independent final relative-link checks passed, and host-runner ownership regressions passed 4/4. The fixture uses only Python standard-library imports and has no application imports.

Independent documentation review found no factual/privacy blocker. It identified a mismatch between the original generic hardware acceptance and authorized FIDO ADR-only scope; tickets/tasks now explicitly supersede that scope and reviewer confirmed resolution. Independent fixture review found unconditional name-based removal after failed creation; runner now retains a validated successful container ID, checks its invocation label and removes only that ID. Final independent review confirmed the ownership fix and found no remaining blocker. No critical/high findings were reported. Independent delivery review confirmed final scope/evidence consistency and reran the four ownership regressions, syntax, receipt and diff checks successfully.

Initial setup required opening Docker Desktop with approval. The image metadata fetch took time but completed. Two unsuccessful runtime probes diagnosed bootstrap failure before terminal environment/native wrapper option were supplied. These are preserved as diagnostics in the report and are not reported as passing runs.

App unit/typecheck/build/Electron/packaged suites were not rerun: the change consists only of isolated lab fixtures and documentation, with no application/build input changes. Earlier application evidence remains the SST-036/SST-034 baseline, not new SST-038 verification.

## Limits and rollback

Linux-container protocol results do not establish macOS binary packaging, licensing redistribution approval, app lifecycle, renderer/Thai IME, IP roaming, sleep/wake or WAN reliability. Client cancellation does not imply remote server exit; the lab explicitly cleans owned server processes. Missing-server behavior remains untested. FIDO has no hardware/provider runtime evidence; PIN, touch, retry/cancel and resident-key gates remain future work. Existing manual release and Developer ID/notarization gates remain pending.

Rollback: revert this isolated fixture/docs commit. No user data or stored credentials changed. Only an owned lab image remains cached; no running fixture container should remain. No push, PR, hosting or publication. SST-035 is next in the authorized order.
