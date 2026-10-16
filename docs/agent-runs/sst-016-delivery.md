# SST-016 delivery — hosts, groups, search and connect

**Scope:** SST-016/T022 DONE through independent TEST/REVIEW/DELIVER under the standing loop instruction after SST-015 `b783329`; local commit only, no push, PR or deployment.

## Delivered behavior

Users can create, edit, find and delete servers and nested groups, see effective port and identity with where each value comes from, filter by search and tags, and connect the selected server. Production main now hosts the catalog behind a narrow owner-bound IPC that never carries secret references. Saves are explicit and revision-fenced with inline errors, conflict recovery and confirmations when group changes affect other servers; group deletion requires choosing where contents go. Connect starts a session on the production registry, unlocking after a screen lock as an explicit action.

## Acceptance and boundaries

Acceptance covered: validated drafts with explicit save; nested groups, descendants and tag AND search; inherited values with provenance; connect uses the selected host; keyboard-accessible errors and empty states; delete effects; F01/F02 after restart. Identity creation is SST-017; tabs, splits and settings are SST-018.

## Verification evidence

- Final source: typecheck PASS; unit **236/236**; build PASS; development E2E **34/34**; unsigned macOS arm64 package PASS; packaged E2E **33/33**.
- Independent tester: suites on the reviewed tree, catalog specs 2× repeated, packaged probes (no references in renderer state, IME, accessibility, performance, overflow). Independent review: one high (quadratic preview blocking main) and the mediums/lows fixed before the final suites.

See [detailed evidence](../catalog-ui.md) and [execution record](implementation-plan.md#final-sst-016-record--2026-10-17).

## Impact and rollback

No schema or dependency change. Roll back by removing the catalog controller, `connectHost`, the catalog UI and `resolveHostConfigs`; catalog data is unchanged.
