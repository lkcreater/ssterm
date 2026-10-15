# SST-007 — Catalog, inheritance and impact previews

**2026-10-15 · T011–T012 · DONE through implementation, independent TEST/REVIEW and DELIVERY; uncommitted.** Latest authorization: “ทำงานถัดไปได้เลย” after SST-006 commit `9b0ba05`. This ticket adds main-side domain workflows, not the SST-016 catalog UI or SST-008 sessions.

## Modules and contracts

- [Pure catalog Module](../packages/domain/src/catalog.ts): `resolveHostConfig`, `queryCatalogHosts`, `catalogGroupTree`. Returned configurations/views/trees are independently copied and deeply frozen, with no provider access or snippet-body traversal.
- [CatalogModule](../packages/services/src/catalog.ts): `query`, `resolve`, `prepare(intent)`, `apply(previewToken)`. Intents are finite host/group/identity/tag CRUD and host-tag assignment. Create IDs are generated in main. Unknown fields, caller create IDs, raw changes and secret/passwordRef input are rejected.
- [Metadata projection](../packages/adapters/src/index.ts) reuses the existing validated change engine before offering a preview. The actual SQLite commit remains authoritative for persistent constraints and ID history. No schema or dependency change is needed.
- [Main-only entry](../apps/desktop/src/main/catalog.ts) is shipped as `out/main/catalog.js`. Existing preload methods stay unchanged; no generic catalog or secret mutation IPC is exposed.

## Resolution and queries

Port and auth resolve independently from host → nearest ancestor override → defaults. Port defaults to 22. Auth selects a complete Identity and its KeyMetadata/opaque refs; `clear` stops traversal, while an unoverridden root resolves none. Winning provenance includes host/group ID and revision. Address, environment and tags remain direct metadata.

Captured configs contain host and selected identity/key revisions, ancestry, catalog revision and copies of metadata only. Later catalog edits do not retarget or mutate an existing capture. This proves config capture behavior, not live SSH continuity.

Query scope is explicit: all hosts, ungrouped only, or one group with/without descendants. Selected tag IDs are deduplicated and combine with AND against direct assignments. Unknown scope/group/tag IDs reject instead of widening the result. Search trims, normalizes NFC and lowercases text across host label/address, effective identity username, assigned tag labels and ancestry group labels. It does not search secrets or snippet bodies. Ordering uses normalized label then UUID code-point order.

## Preview and apply

`prepare` returns an opaque token, captured catalog revision, expiry, generated IDs and before/after impacts. Plans retain detached changes behind server-owned tokens, capped at 64 previews with a five-minute TTL. `apply` accepts only the token, consumes it and synchronously commits its stored changes against the captured global revision. Any intervening metadata/journal edit conflicts, including a newly added descendant or changed tag membership; stale/expired/consumed plans require a fresh preview.

Impacts distinguish effective connection changes, winning provenance changes and hierarchy path changes. Global catalog revision, timestamps and unrelated ancestor revision bumps do not make every host appear changed. Connection comparison includes selected identity/key IDs, revisions and credential refs; provenance flags compare winner kind/ID, while full config captures retain the source revision. Group operations include descendants whose own overrides cut off inherited changes.

Batch size is limited to the repository's 1,000 changes; an oversized destructive action rejects before preview rather than being split into partial commits. A preview cannot guarantee a later SQL write: final constraint/I/O failures still return a sanitized failure with no partial catalog changes.

## Explicit deletion and credential policy

- Host deletion removes its host-tag memberships and tunnel rules in the same transaction, reports those effects and preserves shared identities, keys, tags and endpoint trust.
- Group deletion explicitly chooses reparenting direct children/hosts to another parent/root, or deleting the full subtree and owned host dependents. A destination inside the deleted subtree and cyclic moves reject atomically; descendants retain their own overrides.
- Identity deletion reports direct Group/Host references and effective inherited users. Detach changes each direct reference to `clear`; reassign selects another existing identity. Keys/trust remain intact. Nonterminal credential publication owned by that identity blocks conflicting edits.
- Identity metadata edits retain a saved password unless explicitly forgotten or switching method. Password detachment/deletion journals cleanup in the same revision-fenced SQL commit. The result reports pending cleanup operation IDs; CatalogModule performs no OS delete and makes no erasure claim. Existing `SecretService.reconcile` handles cleanup later; denial leaves it pending.
- Tag deletion removes host and snippet memberships, touching each surviving owner once before deleting the tag. The new finite `set-snippet-tag` change preserves the exact encrypted body; no decryption/reseal is needed because its AAD does not bind the row revision.

## Verification and limits

Current checks: typecheck PASS; full unit suite **80/80**, including **11 pure catalog** and **14 real SQLite/memory-provider catalog** tests. Independent tester repeated the 25 catalog tests. [Unit workflows](../tests/unit/catalog.test.ts) cover stale/replayed/expired/tampered previews, bounds, moves/cycles/reparent/subtree, identity impacts/clear/reassign/method switch, preserved trust/keys, encrypted snippet membership, pending publication, denied cleanup and final SQL rollback.

[Electron runtime tests](../tests/e2e/catalog.spec.ts) use the shipped production Module on separate temporary databases. They exercise inherited config/provenance, scoped search/AND tags, immutable captures, stale previews, group movement/deletion and atomic queued credential cleanup with a denied memory provider and later reconciliation. Development E2E **13/13** and packaged E2E **10/10** passed, with zero skipped/flaky/unexpected results. Independent review found no actionable findings. Full evidence: [execution record](agent-runs/implementation-plan.md#sst-007-execution-plan--2026-10-15) and [delivery](agent-runs/sst-007-delivery.md).

No new renderer workflow, live session or real host connection is added. Future catalog IPC must validate caller ownership and map safe DTOs rather than forwarding raw MetadataChanges. Existing SST-006 restore/app-lock/provider limitations remain in [secret storage](secret-storage.md#known-limitations). No commit/push/deployment is included in SST-007 authorization.
