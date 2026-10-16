# SST-016 — Hosts, groups, search and connect

**2026-10-17 · T022 · DONE through independent TEST/REVIEW/DELIVER; committed under the standing loop instruction.** Authorized by the standing loop instruction after SST-015 commit `b783329`. Scope is creating, editing, finding and connecting saved servers and groups, with inherited values and delete effects. Identity creation (SST-017), tabs/splits and settings (SST-018) are separate. [Execution plan](agent-runs/implementation-plan.md#sst-016-execution-plan--2026-10-17).

## Catalog boundary

Production main now creates the [catalog module](catalog.md) once storage is ready and exposes it through a narrow owner-bound stream. `CatalogState` carries hosts (direct values, ancestry and effective port/identity with provenance), groups (with the values their members inherit), tags and identity summaries (label, username, method). Secret references, key references, cleanup ids, vault ids and resolved connection configs never cross IPC; a unit test serializes state and previews and asserts none appear. Each kind is capped at 10,000 entries with a `truncated` flag.

Changes are two-step and revision-fenced. `prepareCatalogChange` accepts only host, group and tag intents (identity intents belong to SST-017) and returns either a single-use preview token with counts-only impacts or field errors (label empty/too long/control characters/duplicate, address invalid/too long, port invalid, parent cycle, missing group/identity/tag) computed in main. `applyCatalogChange` commits the token; a stale revision, expired or superseded token returns `conflict`. Each window holds at most one preview; revocation discards it. After an apply, every window receives the new state before the reply returns.

## Connect

`connectHost({owner, hostId})` starts a session on the production registry through the terminal handler set. A locked registry is unlocked by this explicit click (same lock-epoch rule as Reconnect); 32 retained sessions return `busy` (“Too many sessions open; close ended panes”). The UI switches to the terminal view before the session is ready, and trust and credential prompts appear as before. There is no PROD confirmation: environment is display metadata, shown on rows, details, panes and dialogs. Connect is disabled with “Choose an identity to connect.” when the effective auth is not an identity.

## UI

The sidebar has search (Escape clears, a live result count), an Add menu (server, group), All servers, Ungrouped, a group disclosure tree and a tag filter where tags combine with AND. Search runs in the renderer with the same rules as the domain query (NFC, case-insensitive, over label, address, username, tags and group path), proved by a parity test. The hosts page lists servers with PROD, target, path and tags, and the detail shows effective port and identity with “set on this server”, “from group …” or “default”. Editors are dialogs with inline errors, explicit save, a confirmation when a group change affects other servers, a conflict alert whose Reload keeps the draft, and a prompt before discarding unsaved edits. Deleting a group requires choosing to move its contents up or delete the subtree; delete dialogs show counts with Cancel focused.

## Verification

Final source: `npm run typecheck` PASS, `npm test` **236/236**, `npm run build` PASS, `npm run test:e2e` **34/34**, `npm run package:mac` PASS (unsigned arm64), `npm run test:packaged` **33/33**.

[Boundary tests](../tests/unit/catalog-boundary.test.ts) cover guards, the safe projection and previews (no references, vault or operation ids), owner-bound single previews, field errors, conflicts, publish ordering and IPC authorization; [filter tests](../tests/unit/catalog-filter.test.ts) prove search parity with the domain query over 288 combinations; [catalog tests](../tests/unit/catalog.test.ts) include a 5,000-host prepare under 1 s. [UI E2E](../tests/e2e/catalog-ui.spec.ts) walks F01/F02 with relaunch persistence, validation, tags and search, keyboard navigation, deletes with dispositions, an out-of-band conflict with Reload, focus return and 960×640 overflow with long Thai labels and tags. [Connect E2E](../tests/e2e/catalog-connect.spec.ts) drives the production main path to Docker OpenSSH: trust, password prompt, Ready with focus in the terminal, lock and Connect-to-unlock, disabled Connect without an identity and server shells reaped.

Review found one high issue: impact previews were quadratic in hosts and blocked the main process (4,000 hosts: 10.8 s). Resolving all hosts from one catalog index and indexed lookups brought prepare to 15 ms at 1,000 hosts, 65 ms at 4,000 and 134 ms at 10,000. Mediums (focus after trust/credential/delete dialogs, named servers in the group-delete preview, renderer cost) and lows were fixed. The independent tester confirmed no references in renderer state, Thai IME guards, keyboard and accessibility names, 1,001-host rendering (≈ 200 ms) and fixed a PROD badge pushed out of view by long tags at 960×640.

## Boundaries and rollback

Tag rename and tag deletion UI, identity creation and drag-and-drop are not included. Changes made by other writers (SST-017 secret writes) do not yet push state. Deleting a host or group whose session is open keeps that session; a later Reconnect reports the saved settings as unusable and the pane loses its target label. An IDN address is stored as punycode, so typing the Unicode form does not match it in search. Rollback removes the catalog controller, connect command and catalog UI; the catalog data and schema are unchanged.
