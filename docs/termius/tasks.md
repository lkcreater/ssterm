# Task checklist

**SST-037 / T046: Team vault `DONE` (automated)** — [behavior](../team-vault.md), [delivery](../agent-runs/sst-037-delivery.md). Separate human ACL and metadata/credential domains, explicit Owner-shared passwords, principal-wide revoke/rekey, managed terminal gates and independent Team recovery. Final unit769 total/768 pass/1 skip; full packaged85/85 plus exact-final focused10/10. The authorized SST-029–038 range is complete within its recorded bounds; manual release/signing checks remain pending.


**SST-035: independent personal encrypted sync `DONE` (automated)** — [behavior](../sync.md), [delivery](../agent-runs/sst-035-delivery.md). Opt-in manual Publish/Fetch/Review/Apply; self-hosted Node/SQLite, separate Keychain keys/journals, enrollment/recovery/rotation, per-record conflicts/tombstones and latest-control enforcement. Final unit707 total/706 pass/1 skip (Homebrew bash5 absent), focused sync119/119, development full81/81 and final packaged83/83. No deployment or credential sharing; catalog schema4 unchanged. See the SST-037 record above. Existing manual release/signing checks remain pending.


**SST-038: Mosh / FIDO capability investigation `DONE`** — [report](../spikes/mosh-fido-capabilities.md), [ADR 0007](../adr/0007-mosh-and-security-key-capability-gates.md), [delivery](../agent-runs/sst-038-delivery.md). Owned Linux arm64 Mosh probe passed 11/11 plus exact-container removal in implementation and independent test runs; FIDO is ADR-only, all hardware gates untested. No production transport/IPC/schema/dependency changes. SST-035 is delivered in the newer record above. Manual release/signing checks remain pending.

**SST-036: sync cryptography / key lifecycle `DONE` (specification and conformance)** — [protocol](../sync-crypto.md), [ADR 0006](../adr/0006-sync-cryptography-and-key-lifecycle.md), [delivery](../agent-runs/sst-036-delivery.md). New crypto suite 60/60; final focused 96/96; full unit 648 total / 646 passed / 2 skipped; typecheck/build PASS. Independent review has no unresolved critical/high findings. No production sync, dependency, IPC or schema change. SST-038 is delivered next in the record above; existing manual release/signing checks remain pending.

**SST-034: recordings / history / suggestions `DONE` (automated)** — [behavior](../recording.md), [AI privacy scope](../ai-scope.md), [delivery](../agent-runs/sst-034-delivery.md): opt-in encrypted local capture, retention/export/delete, shell-reported history and insert-only suggestions. Review fixes cover size-cap data loss, header ordering, Forget/Delete/lock/export races and bounded quit; packaged verification also closes the SFTP focus race. Unit 587 passed / 1 skipped (588 total), full development 79/79 plus final integration 10/10, final packaged 80/80. Schema remains 4; AI sends nothing and has no provider. This is the earlier runtime baseline; see the SST-036 status above. Existing manual release/signing checks remain pending.

**สถานะ: M0 เสร็จแล้ว ณ 2026-10-15.** SST-001/T001/T047 ส่งมอบและ commit `ad9ed51` ก่อนเริ่ม SST-002/T002–T003 ซึ่งผ่าน fixture/runtime/package checks และ delivery แล้ว SST-003/T004–T005 documentation-only `DONE` ตามคำสั่งถัดไป; Production SST-012–028 และ DS04 ส่งมอบแล้วใน SST-018; DS05–DS06 ยังหยุดรอคำสั่ง; DS02–DS03 ส่งมอบแล้วใน SST-004

## งานเตรียมการที่ทำแล้ว

- [x] ระบุ installed Termius 9.43.1, bundle ID/platform และ ASAR SHA256
- [x] อ่าน skill `reverse-engineer-anything` และเลือก REA CLI fallback
- [x] ทำ focused REA analysis; เก็บ complete parent, summary, coverage/unknowns/integrity contradictions
- [x] ตรวจ shipped process bundles, domain definitions, service callbacks แบบ bounded static inspection
- [x] ตรวจ native wrappers/linkage/symbol candidates พร้อม source identities
- [x] สรุป published feature/workflow และ official source register
- [x] แยก Observed / Published / Inferred / Proposed / Unknown
- [x] จัด architecture proposal, tickets, task dependencies และ phase gates
- [x] บันทึก UI stack ที่ผู้ใช้เลือก: React + Electron + shadcn/ui + Tailwind CSS; ยังไม่เริ่ม implementation
- [x] เชื่อม Signal Blue design spec กับ implementation plan, parent tickets และงานย่อย DS01–DS06; ยังไม่เริ่ม implementation
- [x] ผู้ใช้ confirm เฉพาะ M0 / SST-001–002 พร้อม pipeline + delivery/commit ทีละ ticket เมื่อ 2026-10-14; ดู [authorization](implementation-plan.md#confirmation-boundary--stop-condition)

## M0 — ตัดสินใจและพิสูจน์ feasibility

- [x] **T001 / SST-001:** finalize MVP/platform/app ID/original UX ADR; บันทึก React + Electron + shadcn/ui + Tailwind CSS และเลือก compatible dependency versions/build tooling
- [x] **T002 / SST-002:** สร้าง project-owned SSH/SFTP fixture พร้อม key/password/host-key cases
- [x] **T003 / SST-002:** prove PTY/resize/auth/interactive prompts/SFTP/tunnel/packaging, record limits และเลือก backend

## M1 — Foundation

- [x] **T004 / SST-003:** data dictionary/relations/inherit/delete rules และ field protection matrix — `DONE`; [spec](domain-storage-spec.md), ผ่าน independent TEST/REVIEW
- [x] **T005 / SST-003:** lock/key loss/recovery/backup/schema migration และ non-atomic journal semantics — `DONE`; [spec](domain-storage-spec.md), ผ่าน independent TEST/REVIEW
- [x] **T006 / SST-004:** bootstrap Electron + React/TypeScript renderer, shadcn/ui components, Tailwind CSS/theme tokens และ narrow typed command/events — [evidence](../desktop-shell.md)
- [x] **T007 / SST-004:** IPC validation/sender ownership/CSP/navigation/URL policy — [evidence](../desktop-shell.md)
- [x] **T008 / SST-005:** transactional repository, indexes, versioned migrations และ storage failure handling — [evidence](../local-storage.md)
- [x] **T009 / SST-006:** Keychain SecretRef adapter + fixture provider + denied/missing/error cases — [evidence](../secret-storage.md)
- [x] **T010 / SST-006:** sensitive-content encryption, cache lifetime และ redaction — [evidence](../secret-storage.md)
- [x] **T011 / SST-007:** groups/host CRUD, inheritance/provenance/cycle/move/delete consistency — [evidence](../catalog.md)
- [x] **T012 / SST-007:** tags/search/AND filters และ shared identity impacts — [evidence](../catalog.md)

## M2 — SSH terminal

- [x] **T013 / SST-008:** connection/session registry, state/error/prompt contracts, generation IDs — [evidence](../sessions.md)
- [x] **T014 / SST-008:** resource ownership/idempotent dispose/delayed-event race tests — [evidence](../sessions.md)
- [x] **T015 / SST-009:** KnownHost repository/policy และ accept-once/remember/reject/changed-key UI — [evidence](../known-hosts.md)
- [x] **T016 / SST-010:** password/imported key connection, error translation, supported format list
- [x] **T017 / SST-011:** passphrase/keyboard-interactive prompt broker, cancel/retry/timeout/lifetime
- [x] **T018 / SST-012:** terminal renderer, ordered stream, input routing, PTY resize, EOF/exit
- [x] **T019 / SST-013:** Thai/Unicode/IME, clipboard/paste, focus/shortcuts/search/URL behavior
- [x] **T020 / SST-014:** bounded queues/scrollback/concurrency, backpressure และ measured performance budget
- [x] **T021 / SST-015:** unexpected disconnect/manual reconnect/cancel/app quit cleanup

## M3 — Catalog/workspace UX

- [x] **T022 / SST-016:** hosts/groups/tree/drafts/validation/inherited values/connect/empty states
- [x] **T023 / SST-017:** identity/key CRUD/import/bind/detach/reassign UX
- [x] **T024 / SST-018:** tabs/layout tree/basic splits/focus/close และ persistent terminal settings

## M4 — SFTP / snippets / forwarding

- [x] **T025 / SST-019:** SFTP capability/read/stat/list/write/handle ownership and errors
- [x] **T026 / SST-020:** local/remote browser/path/hidden files/symlink navigation/selection
- [x] **T027 / SST-021:** bounded transfer queue/progress/cancel/disconnect and checksum fixture checks
- [x] **T028 / SST-022:** overwrite/skip/rename, temp/partial files, permissions/quota/path failure
- [x] **T029 / SST-023:** protected snippet persistence/editor/list/search
- [x] **T030 / SST-024:** Paste composer/explicit Run, target capture และ sent/error status
- [x] **T031 / SST-025:** local tunnel adapter/registry/bind conflicts/stop/resource cleanup
- [x] **T032 / SST-026:** tunnel rule CRUD/validation/start-stop-state and restart policy

## M5 — MVP acceptance และ package

- [x] **T033 / SST-027:** integration/E2E requirement coverage F01–F06 และ failure/teardown matrix
- [ ] **T034 / SST-027:** macOS Thai IME/accessibility/keyboard/performance walkthrough + release-blocker fixes
- [ ] **T035 / SST-028:** local packaged artifact/clean fixture/upgrade/storage and native binding checks; รวม [deferred manual checks จาก SST-020](tickets.md#sst-028--macos-package--release-readiness) (⌘C/⌘A ผ่านเมนูจริง, VoiceOver, privacy prompt จาก Finder)
- [x] **T036 / SST-028:** checksums/release notes/known limitations/signing gate และ installation guide

## Post-MVP — authorized

- [x] **T053 / SST-039:** local app lock — password or Google (loopback OAuth), recovery code, main-side IPC gate, Settings
- [x] **T054 / SST-040:** UI v2 Charcoal — tokens/icon, right-edge drawers, shell, Files picker, manual Lock workspace ([spec](../agent-runs/sst-040-spec.md), [delivery](../agent-runs/sst-040-delivery.md))

## Later scope — authorized separately from MVP

SST-029–038 follow the [recorded authorization and choices](../agent-runs/implementation-plan.md#later-scope-authorization--sst-029-to-sst-038-2026-10-17); no per-ticket approval is needed within that scope.

- [x] **T037 / SST-029:** macOS arm64 local PTY and declared additional-OS capability/packaging matrix — automated DONE ([behavior](../local-terminal.md), [delivery](../agent-runs/sst-029-delivery.md)); other platforms remain unsupported/unverified
- [x] **T038 / SST-030:** jump host/multi-hop/proxy resolver, per-hop auth/trust/cleanup — DONE ([jump hosts](../jump-hosts.md), [delivery](../agent-runs/sst-030-delivery.md))
- [x] **T039 / SST-031:** remote/dynamic tunnel capabilities and UI — DONE ([tunnels](../tunnels.md#remote-and-dynamic-socks5-forwarding--sst-031), [delivery](../agent-runs/sst-031-delivery.md))
- [x] **T040 / SST-032:** remote editing/stale version/temp cleanup/advanced transfers — automated DONE ([behavior](../remote-edit.md), [delivery](../agent-runs/sst-032-delivery.md)); native TextEdit manual check pending; resume/remote↔remote unsupported
- [x] **T041 / SST-033:** workspace templates/explicit broadcast/multi-host snippet target orchestration — DONE ([workspace tools](../workspace-tools.md), [delivery](../agent-runs/sst-033-delivery.md))
- [x] **T042 / SST-034:** opt-in encrypted logs/history/suggestions, retention/export/delete and AI privacy-only scope — automated DONE ([behavior](../recording.md), [delivery](../agent-runs/sst-034-delivery.md)); no AI provider or data transmission
- [x] **T043 / SST-036:** threat model/independent crypto key lifecycle/test vectors/review — DONE (specification/conformance; [protocol](../sync-crypto.md), [delivery](../agent-runs/sst-036-delivery.md)); production integration remains SST-035
- [x] **T044 / SST-038:** owned Docker Mosh bootstrap/network recovery investigation and FIDO ADR only; hardware PIN/touch/cancel and proprietary runtime/native work deferred by recorded scope
- [x] **T045 / SST-035:** own backend/device enrollment/encrypted sync/conflict/tombstones — automated DONE ([behavior](../sync.md), [delivery](../agent-runs/sst-035-delivery.md)); personal v1 bounds/exclusions apply, teams SST-037
- [x] **T046 / SST-037:** team ACL/membership/enforcement/revocation/rekey/audit — automated DONE ([behavior](../team-vault.md), [delivery](../agent-runs/sst-037-delivery.md)); managed terminal/password bounds and manual release limits apply

## Design system — งานย่อยเพิ่มตาม Signal Blue spec

อ้างอิง [design-system.md](design-system.md) และ [design-system-implementation.md](design-system-implementation.md) อนุมัติเฉพาะ DS01/T047 ใน SST-001; DS02–DS03 อยู่ใน SST-004 ที่อนุมัติแล้ว; DS04 ส่งมอบแล้วใน SST-018; DS05–DS06 ยังหยุดรอคำสั่งและต้องผ่าน dependencies ของ parent ticket เดิม

- [x] **T047 / SST-001:** DS01 — design integration ADR: spec version, Tailwind compatibility, shadcn base/style/icons/registry, density defaults และ open contrast/ANSI/artwork decisions
- [x] **T048 / SST-004:** DS02 — semantic token mappings, typography/fonts/Thai fallback, geometry/motion, app/terminal theme separation และ missing generated-component slots — [evidence](../desktop-shell.md)
- [x] **T049 / SST-004:** DS03 — shared shadcn variants/domain primitives และ development-only showcase พร้อม deterministic state matrix/edge cases — [evidence](../desktop-shell.md)
- [x] **T050 / SST-018:** DS04 — Signal Blue terminal-first shell, target/environment/status recipes, resize/collapse/titlebar/overflow และ independent terminal preferences
- [ ] **T051 / SST-027:** DS05 — rendered contrast/focus/status/PROD matrix, keyboard/reduced-motion/Thai/IME/window scaling และ visual evidence ตาม spec §11
- [ ] **T052 / SST-028:** DS06 — offline fonts/licenses/fallback; derived icon sizes/macOS format จาก supplied `docs/logo/icon-logo.png`, brand lockup ตาม [asset handoff](../logo/README.md); ตรวจ alpha/edges/padding/Dock/Finder และระบุ limitations ของ exports/QA ที่ยังไม่ครบ

## Task bookkeeping

Current owner: root ปิด SST-020/T026 หลัง independent TEST/REVIEW/DELIVER ผ่านครบ และ commit ตาม loop; loop paused หลัง SST-020 ตามคำสั่งผู้ใช้

T002/T003 completion evidence: [SST-002 compatibility report](../spikes/ssh-compatibility.md) และ [delivery](../agent-runs/sst-002-delivery.md); production SSH/session tasks ยังไม่ถูกติ๊ก

T004/T005 completion evidence: [domain/storage specification](domain-storage-spec.md) และ [SST-003 delivery](../agent-runs/sst-003-delivery.md); specification walkthroughs ไม่ใช่ runtime acceptance ของ SST-005/006.

T006/T007/T048/T049 completion evidence: [desktop shell](../desktop-shell.md) และ [SST-004 delivery](../agent-runs/sst-004-delivery.md).

T008 completion evidence: [local storage](../local-storage.md), [ADR 0002](../adr/0002-local-metadata-storage.md) และ [SST-005 delivery](../agent-runs/sst-005-delivery.md).

T009/T010 completion evidence: [secret storage](../secret-storage.md), [ADR 0003](../adr/0003-secret-storage-and-content-protection.md) และ [SST-006 delivery](../agent-runs/sst-006-delivery.md).

T011/T012 completion evidence: [catalog](../catalog.md) และ [SST-007 delivery](../agent-runs/sst-007-delivery.md).

T013/T014 completion evidence: [sessions](../sessions.md) และ [SST-008 delivery](../agent-runs/sst-008-delivery.md).

T015 completion evidence: [known hosts](../known-hosts.md) และ [SST-009 delivery](../agent-runs/sst-009-delivery.md).

T016 completion evidence: [saved-host authentication](../ssh-auth.md) และ [SST-010 delivery](../agent-runs/sst-010-delivery.md).

T017 completion evidence: [authentication prompts](../auth-prompts.md) และ [SST-011 delivery](../agent-runs/sst-011-delivery.md).
