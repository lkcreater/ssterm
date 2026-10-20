# Tickets สำหรับ ssterm

**SST-038: Mosh / FIDO capability investigation `DONE`** — [report](../spikes/mosh-fido-capabilities.md), [ADR 0007](../adr/0007-mosh-and-security-key-capability-gates.md), [delivery](../agent-runs/sst-038-delivery.md). Owned Linux arm64 Mosh probe passed 11/11 plus exact-container removal in implementation and independent test runs; FIDO is ADR-only, all hardware gates untested. No production transport/IPC/schema/dependency changes. SST-035 is next in the authorized order. Manual release/signing checks remain pending.


**SST-036: sync cryptography / key lifecycle `DONE` (specification and conformance)** — [protocol](../sync-crypto.md), [ADR 0006](../adr/0006-sync-cryptography-and-key-lifecycle.md), [delivery](../agent-runs/sst-036-delivery.md). New crypto suite 60/60; final focused 96/96; full unit 648 total / 646 passed / 2 skipped; typecheck/build PASS. Independent review has no unresolved critical/high findings. No production sync, dependency, IPC or schema change. SST-038 is delivered next in the record above; existing manual release/signing checks remain pending.

**SST-034: recordings / history / suggestions `DONE` (automated)** — [behavior](../recording.md), [AI privacy scope](../ai-scope.md), [delivery](../agent-runs/sst-034-delivery.md): opt-in encrypted local capture, retention/export/delete, shell-reported history and insert-only suggestions. Review fixes cover size-cap data loss, header ordering, Forget/Delete/lock/export races and bounded quit; packaged verification also closes the SFTP focus race. Unit 587 passed / 1 skipped (588 total), full development 79/79 plus final integration 10/10, final packaged 80/80. Schema remains 4; AI sends nothing and has no provider. This is the earlier runtime baseline; see the SST-036 status above. Existing manual release/signing checks remain pending.

**ทุก ticket อยู่ใน repo; ไม่ได้เปิด external issue.** M0 ที่อนุมัติส่งมอบแล้ว ณ 2026-10-15: SST-001 `DONE`/commit `ad9ed51` ก่อนเริ่ม SST-002; SST-002 `DONE` ตาม [runtime report](../spikes/ssh-compatibility.md); SST-003/T004–T005 documentation-only `DONE`; SST-001–026 ส่งมอบแล้ว; SST-027/028 ส่วนอัตโนมัติส่งมอบแล้ว (manual checks และ Developer ID รอ) และ SST-029–038 เป็น later scope

Priority: P0 = foundation/critical correctness, P1 = MVP feature, P2 = later. Effort: S/M/L เป็น relative complexity ไม่ใช่ commitment สถานะ SST-028 manual/signing ยังค้าง (รอคำสั่งให้ทำต่อ) (ทำต่อตามลำดับ dependency); later คือ `DEFERRED` Evidence aliases ดู [analysis](system-analysis.md), implementation decisions ดู [architecture](proposed-architecture.md)

UI acceptance ใช้ [Design System v1.0 — Signal Blue](design-system.md) และ [design implementation plan](design-system-implementation.md) เป็น reference เพิ่ม งาน DS01–DS06/T047–T052 อยู่ใน tickets เดิม ไม่เปลี่ยน later scope; อนุมัติเฉพาะ DS01 ใน SST-001 ส่วน DS02–DS03 อยู่ใน SST-004 ที่อนุมัติแล้ว; DS04 ส่งมอบแล้วใน SST-018; DS05–DS06 ยังหยุดรอคำสั่ง

## Backlog index

| ID | Title | Phase | Priority | Effort | Depends on |
|---|---|---|---|---|---|
| SST-001 | Scope / platform / stack ADR | M0 | P0 | S | M0 confirmed 2026-10-14 |
| SST-002 | SSH/SFTP/backend compatibility spike | M0 | P0 | L | 001 |
| SST-003 | Domain / privacy / storage specification | M1 | P0 | M | 001 |
| SST-004 | Desktop shell / design system / typed IPC | M1 | P0 | M | 001 |
| SST-005 | Versioned local repository / migrations | M1 | P0 | M | 003,004 |
| SST-006 | OS secrets and encrypted sensitive content | M1 | P0 | L | 003,004,005 |
| SST-007 | Groups inheritance / tags / catalog domain | M1 | P0 | M | 003,005 |
| SST-008 | Connection/session state and ownership | M2 | P0 | L | 002,004,006,007 |
| SST-009 | Known-host verification and trust replacement | M2 | P0 | M | 005,008 |
| SST-010 | SSH password / imported key auth | M2 | P0 | L | 006,008,009 |
| SST-011 | Passphrase / keyboard-interactive prompts | M2 | P0 | M | 010 |
| SST-012 | Terminal byte stream / resize / exit | M2 | P0 | L | 010,011 |
| SST-013 | Terminal input / Unicode / clipboard | M2 | P1 | M | 012 |
| SST-014 | Flow control / bounded resources | M2 | P0 | M | 012,013 |
| SST-015 | Cancel / disconnect / manual reconnect | M2 | P0 | M | 008,011,014 |
| SST-016 | Hosts / groups / search UI | M3 | P1 | M | 004,007,010 |
| SST-017 | Identity and key management UI | M3 | P1 | M | 006,007,011 |
| SST-018 | Session tabs / split / settings | M3 | P1 | L | 013,015,016,017 |
| SST-019 | SFTP capability / ownership | M4 | P1 | M | 002,009,010,015 |
| SST-020 | SFTP local/remote browser UI | M4 | P1 | M | 018,019 |
| SST-021 | Transfer jobs / progress / cancel | M4 | P0 | L | 019,020 |
| SST-022 | Transfer conflicts / partial files / errors | M4 | P0 | M | 021 |
| SST-023 | Snippet persistence / CRUD | M4 | P1 | S | 005,006,018 |
| SST-024 | Snippet Paste / Run on active session | M4 | P1 | M | 013,023 |
| SST-025 | Local tunnel service | M4 | P1 | M | 002,009,010,015 |
| SST-026 | Tunnel rules and status UI | M4 | P1 | S | 005,018,025 |
| SST-027 | End-to-end / accessibility / regression gate | M5 | P0 | L | 018,022,024,026 |
| SST-028 | macOS package / release readiness | M5 | P0 | M | 027 |
| SST-029 | Local PTY / additional platforms | DONE | P2 | L | 028 |
| SST-030 | Jump host / multi-hop / proxy | DONE | P2 | L | 015,028 |
| SST-031 | Remote and dynamic forwarding | Later | P2 | M | 025,026,028 |
| SST-032 | Remote editing / advanced transfers | DONE | P2 | L | 022,028 |
| SST-033 | Templates / broadcast / multi-host snippets | DONE | P2 | L | 018,024,028 |
| SST-034 | Logs / history / autocomplete / AI scope | DONE | P2 | L | 028 |
| SST-035 | Independent cloud sync | Later | P2 | L | 036,038 |
| SST-036 | Crypto protocol / key lifecycle review | Done | P2 | L | 028 |
| SST-037 | Team vault / ACL / revocation | Later | P2 | L | 035,036 |
| SST-038 | Remaining evidence / Mosh / hardware capability spikes | Done | P2 | L | 028 |
| SST-039 | Local app lock (password / Google) | Post-MVP | P1 | M | 006,016,028 |

Dependency numbers ย่อหมายถึง `SST-` prefix งานบาง phase ทำคู่ขนานได้เมื่อ dependency พร้อม; phase ไม่ใช่คำสั่งให้เริ่มก่อน confirm

## M0 — Decisions และ feasibility

### SST-001 — Scope / platform / stack ADR

**Status:** `DONE` — [ADR 0001](../adr/0001-mvp-platform-stack.md) และ [dependency baseline](../adr/dependency-baseline.json) บันทึก decisions แล้ว; document validation/review/delivery ผ่านแล้ว; T001/T047 done ตาม execution ledger และ delivery note; root commit ก่อน SST-002

**Outcome:** บันทึก scope, original UX, platform และ stack ก่อน bootstrap โดย UI ใช้ React + Electron + shadcn/ui + Tailwind CSS ตามที่ผู้ใช้เลือก. **Evidence:** artifact/R01, W01–W12 สำหรับ target/workflows; UI stack เป็น user requirement ของ ssterm.

**Acceptance:** ยืนยัน MVP/later boundary และ macOS arm64; ADR บันทึก React + TypeScript บน Electron พร้อม shadcn/ui + Tailwind CSS; เลือก compatible versions/build tooling และระบุ Keychain/packaging approach; การเปรียบเทียบ SSH backends อยู่ใน SST-002. หาก spike ไม่ผ่านให้เสนอ revised backend/scope โดยคง UI stack ที่ผู้ใช้เลือก เว้นแต่ผู้ใช้เปลี่ยน requirement.

**Validation:** reviewer อ่าน ADR และตรวจ requirement coverage กับ ticket index. **Tasks:** ตัดสิน default auth/known-host/Paste semantics; กำหนด app ID และ repo layout; ระบุ deviations จาก Termius.

**Design handoff — DS01/T047:** บันทึก Signal Blue v1.0, dark-first/light-later, Inter/JetBrains Mono, semantic state colors, shadcn base/style/icon library/registry, Tailwind compatibility, density และ remaining contrast/ANSI/artwork decisions ตาม [design plan](design-system-implementation.md) โดย SST-001 เป็นเอกสารเท่านั้น ไม่สร้าง assets/scaffold; DS02–DS06 ต้องอนุมัติเพิ่ม

### SST-002 — SSH/SFTP/backend compatibility spike

**Status:** `DONE` — isolated OpenSSH fixture + ssh2 1.17.0 ผ่าน Node 19 probes/3 regressions และ packaged Electron 19 probes, independent TEST/REVIEW/DELIVERY ผ่าน ดู [result/evidence](../spikes/ssh-compatibility.md) ไม่ได้ implement production adapter/UI หรือ release-signing gates

**Outcome:** ลดความเสี่ยง engine ก่อนสร้าง application services. **Evidence:** S03/S05, N01/N06/N07, N-T02.

**Acceptance:** isolated server fixture ผ่าน password + encrypted key auth, host-key reject/change, interactive PTY/resize/exit, SFTP และ local forwarding; record API/lifecycle/algorithm limitations และ package ได้บน target OS; ไม่มี Termius native/cloud dependency. แยก throwaway spike จาก production service.

**Validation:** real integration fixture, disconnect/timeout/teardown checks. **Tasks:** สร้าง lab identity/server keys; capability matrix; เลือก backend หรือ revise ADR.

## M1 — Foundation

### SST-003 — Domain / privacy / storage specification

**Status:** `DONE` — ผู้ใช้อนุมัติเฉพาะ next ticket เมื่อ 2026-10-15; [domain/storage spec](domain-storage-spec.md) ครอบคลุม T004–T005 ผ่าน independent TEST/REVIEW; ไม่รวม schema/code/Keychain implementation หรือ commit/push

**Outcome:** logical versioned entity dictionary/relations และ protection matrix; physical schema/provider acceptance อยู่ SST-005/006. **Evidence:** S04, W02/W03/W10; schema ใหม่เป็น Proposed.

**Acceptance:** ระบุ relations/IDs/delete rules/inheritance/empty semantics; classify metadata/credentials/snippet bodies/settings; ระบุ lock/key loss/backup/recovery/migration และไม่มี plaintext private keys/passwords ใน metadata. Sync fields ไม่กลายเป็น MVP obligation.

**Validation:** [deterministic walkthroughs](domain-storage-spec.md#deterministic-walkthroughs--future-acceptance-oracles) ครอบคลุม create/edit/delete/inherit, ambiguous secret writes, lock/key loss/backup และ migration failures; documentation validation ไม่ใช่ runtime proof. **Tasks:** ER diagram/data dictionary; field protection matrix; migration/version strategy.

**Design metadata:** เพิ่ม optional `Host.environment` สำหรับ target context/PROD label ตาม design spec; กำหนด validation/default unspecified และไม่ใช้ display label เป็น authorization policy

### SST-004 — Desktop shell / design system / typed IPC

**Status:** `DONE` — code และ runtime/package checks ผ่าน; ผ่าน independent TEST/REVIEW/DELIVERY ตาม [evidence](../desktop-shell.md)

**Outcome:** app shell ที่มี narrow application API. **Evidence:** S01/S02, Electron primary docs; ใหม่เป็น Proposed.

**Acceptance:** React + TypeScript renderer ใน Electron; shadcn/ui application components และ Tailwind CSS/theme tokens พร้อม shared component conventions; isolated renderer, no arbitrary require/IPC passthrough; validate sender/payload/session ownership; local app navigation/CSP และ URL allowlist; UI/bridge types ไม่ส่ง persistent secrets และ backend errors sanitized.

**Validation:** malformed/unauthorized IPC rejected; packaged React/shadcn/ui/Tailwind screen renders without account/network; privileged calls ผ่าน typed boundary. **Tasks:** scaffold หลัง confirm; React app shell/shared components/theme; command/event contracts.

**Design acceptance — DS02–DS03/T048–T049:** map Signal Blue semantic tokens รวม sidebar/status/interactive states; typography/spacing/radius/control heights เป็น shared variants; fonts offline/Thai fallback; shadcn primitives และ internal fixture showcase ตาม inventory โดยแยก blue focus จาก green connected และ terminal theme จาก app CSS ตรวจ component APIs ตาม actual installed version ก่อนใช้

**Design validation:** token coverage/computed theme, state matrix default/hover/pressed/focus/disabled/loading/error และ selected+connection combinations; source palette ยังไม่ถือว่าผ่าน rendered contrast โดยอัตโนมัติ

### SST-005 — Versioned local repository / migrations

**Status:** `DONE` — [implementation/evidence](../local-storage.md); T008 only, OS secrets/T009 อยู่ SST-006

**Outcome:** catalog/settings persistence ที่เชื่อถือได้. **Evidence:** S04; independent storage design.

**Acceptance:** implementation ตาม [domain/storage contracts](domain-storage-spec.md); writes transactional, durable across restart; schemaVersion/migration rollback or recoverable failure; handle corrupt/unwritable storage โดยไม่ silent-reset ข้อมูล; FK/unique constraints ตรง domain spec.

**Validation:** temp database fixtures สำหรับ CRUD/restart/migration failure. **Tasks:** driver/repository adapters; migration runner; diagnostic/recovery paths.

### SST-006 — OS secrets and encrypted sensitive content

**Status:** `DONE` — [implementation/evidence](../secret-storage.md), [ADR 0003](../adr/0003-secret-storage-and-content-protection.md); T009/T010 only, UI consumers อยู่ SST-017/023

**Outcome:** SecretRef adapter และ sensitive-content protection. **Evidence:** N02, S04, N-T03.

**Acceptance:** ตาม [protection/journal/recovery contracts](domain-storage-spec.md) เลือกและ verify mature authenticated-protection provider (no custom crypto/plaintext fallback) และ stable operationId/ref lookup ก่อน retry ambiguous writes; credential CRUD อยู่ใน project Keychain namespace; metadata เก็บ references; missing/denied/locked provider ส่ง typed outcomes; transient input/passphrase cache มี lifetime และ app-local encrypted content ใช้ provider ตาม ADR; secret/key loss ไม่ทำ silent replacement.

**Validation:** memory provider contract tests และ macOS fixture namespace integration; metadata/log inspection ไม่มี fixture secret. **Tasks:** secure provider; protection implementation; redaction/cache/cleanup.

### SST-007 — Groups inheritance / tags / catalog domain

**Status:** `DONE` — T011/T012 ตาม [catalog evidence](../catalog.md) และ [delivery](../agent-runs/sst-007-delivery.md); ไม่มี SSH/session หรือ SST-016 UI

**Outcome:** effective connection config ที่อธิบาย provenance ได้. **Evidence:** W02/S04.

**Acceptance:** nested groups และ descendants visibility; per-field explicit inherit/value พร้อม auth bundle consistency; cycle prevention; tag AND filter; identity deletion/reassignment และ group move เป็น deterministic; live config snapshot ไม่เปลี่ยนจาก catalog edit.

**Validation:** meaningful parent/child/host override, move/cycle, duplicate reference fixtures. **Tasks:** resolver; catalog CRUD; tags/search; deletion impact logic.

## M2 — SSH terminal

### SST-008 — Connection/session state and ownership

**Status:** `DONE` — T013/T014 ตาม [sessions](../sessions.md) และ [delivery](../agent-runs/sst-008-delivery.md); ยังไม่รวม SST-009 trust/SST-010 saved-host auth

**Outcome:** engine-independent lifecycle contract. **Evidence:** S03, N-T01.

**Acceptance:** states/prompts/errors ตาม architecture; session IDs/generations ทำให้ late events ถูกละทิ้ง; cancellation ทุก nonterminal state; one owner ต่อ resources/capabilities; close/dispose idempotent; events ไม่ serialize secrets.

**Validation:** fake delayed adapter ทดสอบ cancel/auth/close/reconnect races และ real fixture smoke. **Tasks:** session registry; typed command/events; teardown ownership.

### SST-009 — Known-host verification and trust replacement

**Status:** `DONE` — T015 ตาม [known hosts](../known-hosts.md) และ [delivery](../agent-runs/sst-009-delivery.md); production transport hook-up/saved-host auth อยู่ SST-010

**Outcome:** SSH ทุก capability ใช้ policy เดียวกัน. **Evidence:** S03/S04, W01; prompts เป็น Proposed requirement.

**Acceptance:** unknown endpoint แสดง fingerprint/algorithm พร้อม accept-once/remember/reject; remembered key match ผ่าน; changed key block จน explicit replacement; rejected/cancelled prompt ไม่สร้าง authenticated channel; host+port normalization มี tests.

**Validation:** fixture สลับ server keys และ catalog labels; trust survives restart; reject ไม่เขียน trust. **Tasks:** repository/policy; prompt UI; replace/revoke flow.

### SST-010 — SSH password / imported key auth

**Status:** `DONE` — T016; [production auth/evidence](../ssh-auth.md) และ [delivery](../agent-runs/sst-010-delivery.md), independent TEST/REVIEW passed. Missing-credential prompts remain SST-011.

**Outcome:** connection จริงจาก saved host/identity. **Evidence:** S03/N01/W03/W04.

**Acceptance:** password และ selected supported key formats ผ่านจริง; resolve latest catalog+SecretRefs ที่ connect; bad credential/DNS/timeout มี sanitized typed error; failure ไม่เปิด terminal และ cleanup; library negotiation defaults ตาม ADR.

**Validation:** real server password/key/bad auth fixtures. **Tasks:** adapter wiring; credential resolution; error translation.

### SST-011 — Passphrase / keyboard-interactive prompts

**Status:** `DONE` — T017; [prompt behavior/evidence](../auth-prompts.md) และ [delivery](../agent-runs/sst-011-delivery.md), independent TEST/REVIEW passed; terminal streams remain SST-012.

**Outcome:** auth prompts ไม่ค้างหรือ cross-session. **Evidence:** S03, published auth W04.

**Acceptance:** encrypted key prompt มี retry/cancel; keyboard-interactive รองรับหลาย prompt พร้อม echo flags; response ผูก prompt/session/generation; timeout/cancel disconnect และล้าง transient data; secrets ไม่อยู่ใน logs/history.

**Validation:** fixture auth challenge + delayed response + cancel; simultaneous sessions แยก prompts. **Tasks:** prompt broker/UI; auth response adapter; lifetime/cache handling.

### SST-012 — Terminal byte stream / resize / exit

**Status:** `DONE` — T018; [terminal behavior/evidence](../terminal.md) และ [delivery](../agent-runs/sst-012-delivery.md), independent TEST/REVIEW passed; connect UI remains SST-016, Unicode/IME/clipboard SST-013, measured flow-control budgets SST-014.

**Outcome:** interactive remote PTY ใน terminal renderer. **Evidence:** S03/S05, N03 surface analogy; xterm candidate.

**Acceptance:** input/output ordered, supports PTY rows/columns; resize updates remote TTY; remote EOF/exit signal/status แยกจาก local close; reconnect ไม่ replay input; output ใช้ terminal parser ผ่าน declared trust boundary.

**Validation:** real shell + `stty`/full-screen fixture/known exit status. **Tasks:** renderer binding; stream framing; resize/exit routing.

### SST-013 — Terminal input / Unicode / clipboard

**Status:** `DONE` — T019; [evidence](../terminal-input.md) และ [delivery](../agent-runs/sst-013-delivery.md), independent TEST/REVIEW passed.

**Outcome:** typing/copy/paste/search ที่ใช้ได้บน macOS. **Evidence:** W06; behavior details Proposed.

**Acceptance:** Thai/UTF-8/combining/wide characters/IME; copy selection และ multiline paste มี active-target feedback/bracketed paste where supported; shortcuts/focus/search ไม่ส่ง input ผิด pane; clipboard/URL actions explicit.

**Validation:** manual IME/input matrix + fixture captures; nontrivial terminal parser tests ของ integration layer. **Tasks:** shortcuts/focus; paste policy; Unicode/search checks.

### SST-014 — Flow control / bounded resources

**Status:** `DONE` — T020; [evidence](../terminal-flow.md) และ [delivery](../agent-runs/sst-014-delivery.md), independent TEST/REVIEW passed.

**Outcome:** large output/input ไม่ทำ memory โตไม่จำกัด. **Evidence:** N03, no measured target performance.

**Acceptance:** queue/scrollback/concurrency limits explicit และ configurable within bounds; preserve output order ไม่มี silent loss; renderer slow/paused ทำให้ producer throttle หรือ explicit resource-limit outcome; metrics ไม่มี content/secret.

**Validation:** slow-consumer + sustained output/large paste; define memory/latency target from spike and record measured results. **Tasks:** byte acknowledgements; backpressure; performance instrumentation.

### SST-015 — Cancel / disconnect / manual reconnect

**Status:** `DONE` — T021; [evidence](../terminal-lifecycle.md) และ [delivery](../agent-runs/sst-015-delivery.md), independent TEST/REVIEW passed.

**Outcome:** session teardown/reconnect predictably. **Evidence:** S03, N-T01/N-T05.

**Acceptance:** cancel during DNS/host trust/auth/ready; unexpected loss เป็น error state; manual reconnect creates generation/PTY ใหม่; no command replay; tab/app close ปิด channels/jobs/listeners ไม่มี leaked ownership; independent sessions ไม่ถูกปิดตาม.

**Validation:** network break/fixture timeout/repeated open-close + race checks. **Tasks:** lifecycle controller; retry UX; resource cleanup.

## M3 — Catalog และ workspace UX

### SST-016 — Hosts / groups / search UI

**Status:** `DONE` — T022; [evidence](../catalog-ui.md) และ [delivery](../agent-runs/sst-016-delivery.md), independent TEST/REVIEW passed.

**Outcome:** create/edit/find/connect hosts ได้ครบ. **Evidence:** W02/W04/W12.

**Acceptance:** validated drafts/explicit save semantics; nested groups/descendant hosts/tag AND search; inherited values/provenance แสดงชัด; connect uses selected host; errors/empty states keyboard accessible; delete แสดง effects.

**Validation:** F01/F02 walkthrough กับ persistence restart. **Tasks:** catalog navigation/forms; search/filter; connection entrypoint.

### SST-017 — Identity and key management UI

**Status:** `DONE` — T023; [evidence](../identities.md) และ [delivery](../agent-runs/sst-017-delivery.md), independent TEST/REVIEW passed.

**Outcome:** reusable credentials สร้าง/แก้/import/assign ได้. **Evidence:** W03/N02.

**Acceptance:** hosts/groups bind identity; import supported key formats พร้อม encrypted-key outcome; no automatic secret reveal/export; update affects next connections; detach/reassign workflow เมื่อ delete; denied secure store แจ้ง actionable error.

**Validation:** F03 shared identity + denied provider/import failure. **Tasks:** identity forms; key import; references/delete impacts.

### SST-018 — Session tabs / split / settings

**Status:** `DONE` — T024; [evidence](../workspace.md) และ [delivery](../agent-runs/sst-018-delivery.md), independent TEST/REVIEW passed.

**Outcome:** multi-session workspace ขั้นพื้นฐาน. **Evidence:** W06.

**Acceptance:** tabs + horizontal/vertical splits ขั้นพื้นฐาน อย่างน้อยสอง sessions; Focus/Split เปลี่ยน layout ไม่ disconnect; active pane/focus/resize ถูกต้อง; close prompt ตาม active resources; font/theme/scrollback persist; ไม่มี automatic command restore/broadcast ใน MVP.

**Validation:** multiple live fixtures + resize/focus/close interactions, keyboard navigation. **Tasks:** layout tree; tab controls; settings/preferences.

**Design acceptance — DS04/T050:** terminal-first Signal Blue shell; resizable/collapsible sidebar และ auxiliary panels; traffic-light/drag/no-drag regions ไม่ทับ controls; active pane มี server/environment/user@host:port/state; blue selection/focus ต่างจาก connection health; long labels ดู/copy ได้เต็ม; terminal ANSI/font preferences แยกจาก dark application theme Light mode ยังไม่เป็น MVP requirement

## M4 — File transfer / commands / tunnels

### SST-019 — SFTP capability / ownership

**Status:** `DONE` — T025; [evidence](../sftp.md) และ [delivery](../agent-runs/sst-019-delivery.md), independent TEST/REVIEW passed.

**Outcome:** authenticated file API ที่แยกจาก terminal rendering. **Evidence:** S03/S05, W05/N-T05.

**Acceptance:** browse/stat/read/write primitives ตาม backend contract; known-host/auth policy shared; subsystem unavailable เป็น typed result; close transfer capability ไม่ปิด session อื่น; session end คืน handles และ invalidate late replies.

**Validation:** isolated SFTP server + unavailable subsystem + teardown. **Tasks:** adapter/capability; resource ownership; error mapping.

### SST-020 — SFTP local/remote browser UI

**Status:** `DONE` — T026; [evidence](../sftp-browser.md) และ [delivery](../agent-runs/sst-020-delivery.md), independent TEST/REVIEW passed.

**Outcome:** local↔remote dual pane file browser. **Evidence:** W05.

**Acceptance:** directory/path navigation, hidden-file toggle, names/types/size, loading/error; symlinks แสดงชัด; target path captured ที่ action time; open from current host uses correct identity; no broad filesystem grants beyond declared desktop access.

**Validation:** F04 with unicode names, permissions, symlink navigation. **Tasks:** local provider; remote pane; selection/path controls.

### SST-021 — Transfer jobs / progress / cancel

**Status:** `DONE` — T027; [evidence](../transfers.md) และ [delivery](../agent-runs/sst-021-delivery.md), independent TEST/REVIEW passed. Scope: regular files only, no recursion or selected-link following; exclusive creation and retained incomplete destinations until SST-022.

**Outcome:** upload/download queue ที่มี bounded concurrency. **Evidence:** W05/S03; job semantics Proposed.

**Acceptance:** queue state/bytes/unknown-total; cancel active/queued jobs; 100% หลัง successful destination close; transfer failures ไม่ทำ job อื่นเสีย; file/folder scope และ recursion behavior ระบุใน spec; no recursive-follow symlink by default.

**Validation:** real transfer hash compare, cancel mid-write, multiple jobs, disconnect. **Tasks:** job engine; progress events; cancel/cleanup UI.

### SST-022 — Transfer conflicts / partial files / errors

**Status:** `DONE` — T028; [evidence](../transfer-conflicts.md) และ [delivery](../agent-runs/sst-022-delivery.md), independent TEST/REVIEW passed. Scope: regular files only; same-directory `.part` staging, capability-gated replacement, retained stages without automatic cleanup, retry as a fresh job with new consent.

**Outcome:** users รู้ผลของ overwrite/failure/cancel. **Evidence:** W05; destructive/atomicity policies Proposed.

**Acceptance:** explicit overwrite/skip/rename decision; partial file cleanup/retention policy visible; atomic replacement ใช้เมื่อ backend capability รองรับและไม่อ้าง universal atomicity; handle permission/quota/path/disconnect errors; failed overwrite ไม่ silent-destroy unrelated file.

**Validation:** conflict/cancel/permission fixtures + file integrity check. **Tasks:** conflict resolver; temp/partial naming; retry/error UX.

### SST-023 — Snippet persistence / CRUD

**Status:** `DONE` — T029; [evidence](../snippets.md) และ [delivery](../agent-runs/sst-023-delivery.md), independent TEST/REVIEW passed. Bodies sealed with the vault key; search on names/tags only; no Paste/Run (SST-024).

**Outcome:** labeled reusable script เก็บใน local vault. **Evidence:** S04/W07.

**Acceptance:** create/edit/delete/search with restart persistence; body protection ตาม SST-003/006; multiline preserved; ไม่มี implicit run เมื่อ save/edit; invalid input feedback, empty body save ได้แบบ encrypted แต่ Paste/Run ว่างไม่ dispatch ตาม spec.

**Validation:** round-trip multiline/Unicode + sensitive-content storage check. **Tasks:** repository; editor/list; encryption integration.

### SST-024 — Snippet Paste / Run on active session

**Status:** `DONE` — T030; [evidence](../snippets.md#snippet-paste--run--sst-024) และ [delivery](../agent-runs/sst-024-delivery.md), independent TEST/REVIEW passed. Paste → target-bound composer (zero bytes); Run captures the active Ready session at the click; sent ≠ success.

**Outcome:** explicit target-safe command dispatch. **Evidence:** W07; Paste implementation choice Proposed.

**Acceptance:** Paste เข้าสู่ editable pending-input composer ไม่ส่ง terminal byte จนผู้ใช้ตัดสินใจ; Run explicit action ส่งไป captured active ready session; no active session แจ้ง error; multiline/line endings specified; sent status ไม่อ้าง remote command success.

**Validation:** fixture observes no bytes on Paste until submission; Run captured-target test ระหว่าง focus switch. **Tasks:** composer/action UI; target capture; dispatch feedback.

### SST-025 — Local tunnel service

**Status:** `DONE` — T031; [evidence](../tunnels.md) และ [delivery](../agent-runs/sst-025-delivery.md). Main-only service; UI/IPC in SST-026.

**Outcome:** local forwarding ของ SSH host. **Evidence:** S05/W08/N-T05.

**Acceptance:** valid bind/destination config; loopback default; started เมื่อ bind+SSH ready; occupied port/error typed; stop/cancel/quit closes listener และ active sockets; failed start คืน resources; config save ไม่ autostart.

**Validation:** fixture HTTP over tunnel + port collision + connection loss + listener absence after stop. **Tasks:** tunnel registry; bind adapter; teardown/status.

### SST-026 — Tunnel rules and status UI

**Status:** `DONE` — T032; [evidence](../tunnels.md#tunnel-rules-and-status-ui--sst-026) และ [delivery](../agent-runs/sst-026-delivery.md).

**Outcome:** rules CRUD/start/stop และ state visible. **Evidence:** S04/W08.

**Acceptance:** save/restart persistence; distinguish stopped/starting/running/stopping/error; validate ports/address; destination อธิบายว่า resolve จาก SSH server; duplicate/failed rules ไม่แสดง running; edit running rule มี explicit restart semantics.

**Validation:** F06 walkthrough and restart without autostart. **Tasks:** rule editor/list; status/events; stop/edit handling.

## M5 — MVP gate

### SST-027 — End-to-end / accessibility / regression gate

**Status:** automated gate `DONE` — T033 done; [report](../mvp-gate.md) และ [delivery](../agent-runs/sst-027-delivery.md). Manual macOS Thai IME/VoiceOver walkthrough (T034, DS05) pending a human operator.

**Outcome:** release checklist ที่พิสูจน์ required workflows. **Evidence:** F01–F06/W01–W12 และ investigation gaps.

**Acceptance:** E2E flows create/inherit/auth/terminal/SFTP/snippet/tunnel ผ่าน own fixtures; keyboard/focus/contrast checks; unknown/changed host key, encrypted auth, cancel/loss, malformed IPC, storage denial and transfer conflict pass; memory/latency budgets จาก SST-014 measured; no critical correctness/secret/resource-leak issue open.

**Validation:** meaningful domain/integration/E2E suite และ manual macOS Thai IME; record deviations และ unresolved lower-priority issues. **Tasks:** traceability report; regression fixture suite; UX/performance fixes.

**Design gate — DS05/T051:** ผ่าน [design-system.md §11](design-system.md#11-release-quality-checklist) สำหรับ dark MVP: contrast เป้าหมาย 4.5:1 normal text/3:1 essential graphics, focus/selection/status/PROD differentiation, reduced motion, window resize/scaling, dialogs focus-return และ Thai/IME เก็บ rendered screenshots/state matrix; structural border ที่ contrast ต่ำต้องไม่เป็น sole essential control indicator

### SST-028 — macOS package / release readiness

**Status:** automated release readiness `DONE` — T036 done; T035 and DS06/T052 partial (manual checks, 16 px icon, Dock/Finder pending); Developer ID signing/notarization not done (no credentials). [Release guide](../release/README.md), [delivery](../agent-runs/sst-028-delivery.md).

**Outcome:** reviewable local packaged MVP. **Evidence:** target platform + independent packaging ADR.

**Acceptance:** packaged artifact works on supported macOS arm64 clean fixture; secrets/storage identifiers stable across upgrades; native bindings load when packaged; install/upgrade/uninstall data semantics documented; checksums/version/release notes; signing/notarization หากมี credentials เป็น separate release gate มิฉะนั้นระบุ unsigned limitation.

**Validation:** packaged smoke for SSH/SFTP/tunnel and upgrade fixture. **Tasks:** build/package; release guide; artifact review. Publishing/upload/signing ที่ใช้ external credentials ต้องมี authorization ตาม scope ในอนาคต ไม่รวมใน confirm implementation อัตโนมัติ.

**Design package gate — DS06/T052:** fonts/license/fallback ทำงาน offline ใน package; ใช้ supplied [icon-logo.png](../logo/icon-logo.png) ตาม [logo/icon handoff](../logo/README.md) เป็น source สำหรับ derived icons 16/32/64/128/256/512/1024 px และ macOS package format; ตรวจ alpha/edges/padding/legibility/Dock/Finder และ brand lockup ใน About หาก production exports/QA ยังไม่ครบให้ระบุ limitation และไม่อ้างว่า release branding ผ่าน

**Deferred manual checks — จาก SST-020 (บันทึก 2026-10-17):** ทดสอบบน packaged app ที่ sign แล้วตอนปิด SST-028 เพราะต้องใช้สิทธิ์ระดับเครื่อง (Accessibility/Automation, clipboard จริง, TCC reset) หรือต้องมีคนกดหรือฟัง ไม่ใช่ E2E อัตโนมัติ บันทึกผลหรือ limitation ใน release record

1. **⌘C/⌘A ผ่านเมนู macOS จริง:** ในหน้า Files ทั้ง pane “This Mac” และ remote ให้กดปุ่มจริงบนคีย์บอร์ด ⌘A ต้องเลือกทุกรายการใน pane ที่ focus อยู่ ไม่ใช่ทั้งหน้า ⌘C ต้องได้ full raw path คั่นด้วยบรรทัดใหม่ (รวมชื่อไทย/NFD/escaped) เมนู Edit → Copy/Select All ต้องได้ผลเดียวกัน ใน terminal pane ⌘C/⌘A ยังเป็นของ terminal และใน text field ยังเป็นการแก้ข้อความปกติ ให้ save clipboard ก่อนและ restore หลังทดสอบ
2. **VoiceOver:** listbox ของแต่ละ pane ต้องประกาศชื่อ pane, รายการที่ active (ชื่อ, ชนิด folder/file/link, broken link, “contains hidden characters”, unreadable name), สถานะ selected และจำนวนรายการ ทุกคำสั่งในหน้า Files ใช้ได้ด้วย VoiceOver + คีย์บอร์ดอย่างเดียว ส่วน session header ต้องอ่าน target, PROD และสถานะได้
3. **Privacy prompt ตอนเปิดครั้งแรกจาก Finder:** ใช้ `tccutil reset All dev.ssterm.desktop` แล้วเปิดแอปจาก Finder (ไม่ใช่จาก terminal ซึ่งจะได้สิทธิ์ของ terminal แทน) แล้วเปิด Desktop, Documents, Downloads, network volume และ removable volume ใน pane “This Mac” prompt ต้องแสดงคำอธิบายของ ssterm ถ้าผู้ใช้กด Deny ต้องแสดง “permission denied” โดยไม่ค้าง แล้วต้องกลับมาเปิดได้หลังอนุญาตใน System Settings ก่อนทดสอบให้แก้สิ่งที่พบไว้แล้ว (2026-10-17) ใน `artifacts/package/…/SSTerm.app` คือ `Info.plist` ไม่มี `NSDocumentsFolderUsageDescription`, `NSDesktopFolderUsageDescription`, `NSDownloadsFolderUsageDescription`, `NSNetworkVolumesUsageDescription`, `NSRemovableVolumesUsageDescription` แต่มีข้อความกล้อง/ไมค์/Bluetooth แบบ generic ที่ติดมาจาก Electron ทั้งที่แอปไม่ได้ใช้ และ signature เป็น ad-hoc ที่มี `Identifier=Electron` ทำให้ macOS ถามสิทธิ์ซ้ำทุก build

## Later scope — SST-029–038 authorized

Follow the [recorded scope choices and dependency order](../agent-runs/implementation-plan.md#later-scope-authorization--sst-029-to-sst-038-2026-10-17); additional work beyond those choices still requires authorization.

### SST-029 — Local PTY / additional platforms

**Status:** automated gates `DONE` — [behavior](../local-terminal.md), [ADR 0005](../adr/0005-local-terminal-platforms.md), [delivery](../agent-runs/sst-029-delivery.md). macOS arm64 PTY/Unicode/flow/exit/job cleanup and packaged native addon/helper verified; Windows/Linux/macOS x64 declared unsupported/unverified, with no untested builds.

**Evidence:** N03/N-T04/W04. **Outcome:** optional local terminal adapter และ platform roadmap.

**Acceptance:** spawn/write/resize/exit/dispose + Unicode/backpressure/child cleanup ผ่าน local fixtures; Windows/Linux secure-store/PTY/package capability declared per platform; unsupported features มี explicit message. **Validation:** OS-specific integration matrix. **Tasks:** local adapter; platform parity ADR; packaging matrices.

### SST-030 — Jump host / multi-hop / proxy

**Status:** `DONE` — independent TEST/REVIEW/DELIVER complete; [behavior](../jump-hosts.md), [delivery](../agent-runs/sst-030-delivery.md). Per-hop trust/auth, cancellation/failure cleanup, cycle/depth limits, proxy parser bounds and schema-3 upgrade verified.

**Evidence:** W04/S03. **Outcome:** per-hop authenticated transport chain.

**Acceptance:** one-hop ก่อน multi-hop; cycle/depth limits, per-hop trust/auth, cancel/failure cleanup; HTTP/SOCKS5 optional capability; no credential leak across hops. **Validation:** bastion fixture + failed intermediate hop. **Tasks:** chain resolver; transport composition; progress/errors.

### SST-031 — Remote and dynamic forwarding

**Status:** `DONE` — ผ่าน independent TEST/REVIEW/DELIVER; [tunnels](../tunnels.md#remote-and-dynamic-socks5-forwarding--sst-031), [delivery](../agent-runs/sst-031-delivery.md); remote assigned port/`remote-bind-refused`, SOCKS5 CONNECT-only (socks5h), schema 2 migration

**Evidence:** S05/W08. **Outcome:** additional tunnel types.

**Acceptance:** server bind restrictions/remote assigned port surfaced; SOCKS behavior specified; ownership/stop/resources ตาม local contract; capability unavailable explicit. **Validation:** dedicated forwarding/SOCKS lab. **Tasks:** adapters; rule form; network tests.

### SST-032 — Remote editing / advanced transfers

**Status:** automated gates `DONE` — [behavior](../remote-edit.md), [delivery](../agent-runs/sst-032-delivery.md). Owned editor-process fixture, stale content/approval checks and private cleanup verified; native TextEdit UI/autosave is a manual release check. Resume and remote↔remote are explicitly unsupported optional scope.

**Evidence:** W05. **Outcome:** remote-edit และ optional remote↔remote/resume workflows.

**Acceptance:** temp download/editor/change/upload decision; stale remote version detection; temp cleanup; resume และ remote↔remote transport semantics explicit ไม่อ้าง server-side direct copy โดยไม่มี capability. **Validation:** concurrent editor/remote-change/cancel fixtures. **Tasks:** external editor integration; version conflict; transfer capabilities.

### SST-033 — Templates / broadcast / multi-host snippets

**Status:** `DONE` — TEST/REVIEW/DELIVER complete; [behavior](../workspace-tools.md), [delivery](../agent-runs/sst-033-delivery.md). Templates restore fresh sessions/layout; command preparation is opt-in, with explicit armed multi-target text dispatch and visible partial results.

**Evidence:** W06/W07. **Outcome:** saved layouts และ explicit multi-target operations.

**Acceptance:** template restores configuration/layout; commands restore ต้อง opt-in with visible targets; broadcast visibly armed; multi-host snippet semantics แยก existing vs new sessions; cancellation/partial results visible; no assumption remote processes survive client restart. **Validation:** multiple host fixtures and focus/target race scenarios. **Tasks:** template schema; broadcast UI; execution orchestration.

### SST-034 — Logs / history / autocomplete / AI scope

**Status: DONE (automated).** Delivered according to the authorized local opt-in choice; AI remains a privacy specification only. [Behavior](../recording.md), [delivery and final review](../agent-runs/sst-034-delivery.md). All three reported recorder criticals and the additional privacy/lifecycle findings are resolved; final packaged gate 80/80.

**Evidence:** W01. **Outcome:** separate privacy/UX spec ก่อน feature code.

**Acceptance:** local opt-in capture, retention/export/delete และ sensitive-data handling; shell integration supported shells declared; AI provider/data transmission/user consent/cost scope reviewed separately; no hidden external requests. **Validation:** fixture log/redaction/lifecycle and shell matrix. **Tasks:** privacy spec; local log/history; later shell/AI spike.

### SST-035 — Independent cloud sync

**Evidence:** S04/W09/W10; internals Unknown. **Outcome:** own account/device/encrypted sync protocol.

**Acceptance:** approved protocol/versioning; conflict/tombstone/offline merge/device enrollment; selective secret policy explicit; encrypted payload/metadata boundaries verified with test vectors; no Termius cloud compatibility claim. **Validation:** own multi-device lab/recovery/migration/merge tests. **Tasks:** sync spec/backend/client; encrypted envelope; reconciliation.

### SST-036 — Crypto protocol / key lifecycle review

**Status:** `DONE` (specification and conformance) — [delivery](../agent-runs/sst-036-delivery.md), [ADR 0006](../adr/0006-sync-cryptography-and-key-lifecycle.md), [protocol](../sync-crypto.md); documentation and isolated conformance tests only. Production sync remains SST-035.

**Evidence:** N07/N-T08/W09. **Outcome:** threat model และ reviewed independent construction.

**Acceptance:** key derivation/envelopes/device keys/rotation/recovery/version migration documented; established libraries/constructions + known-answer vectors; logout/lock/key loss defined; published Termius claims ไม่ถูกใช้แทน verification. **Validation:** protocol review and test-vector suite before cloud work. **Tasks:** crypto ADR; key lifecycle; review findings.

### SST-037 — Team vault / ACL / revocation

**Evidence:** W11. **Outcome:** team access model of own backend.

**Acceptance:** roles/membership enforcement backend+client; revoke/offline cached access limitations explicit; rekey/shared credential lifecycle and audit trail; view/connect/edit permissions tested; tenant boundaries validated. **Validation:** multi-user ACL/revocation/cached-device tests. **Tasks:** authorization spec; team services/UI; revocation/rekey.

### SST-038 — Remaining evidence / Mosh / hardware capability spikes

**Status:** `DONE` within the authorized Mosh lab / FIDO ADR-only scope — [delivery](../agent-runs/sst-038-delivery.md). No production Mosh/FIDO support is claimed.

**Evidence:** N04/N05/N-T06–08, original unanswered questions. **Outcome:** residual unknowns แยกเป็น bounded investigations.

**Authorized acceptance (supersedes original generic hardware scope):** owned Docker Mosh bootstrap/network recovery with artifact identity, focused evidence and capability matrix; FIDO investigation/ADR only because no hardware is available. FIDO PIN/touch/cancel/device verification and additional proprietary runtime/native investigations are deferred gates, not completion claims. Separate observation, upstream claim, inference and unknown. **Validation:** real owned Mosh fixture, sanitized receipt, independent test/review and ADR. **Tasks:** Mosh lab and capability report; hardware ADR and explicit future hardware matrix. See [recorded choice](../agent-runs/implementation-plan.md#later-scope-authorization--sst-029-to-sst-038-2026-10-17).

### SST-039 — Local app lock (password / Google)

**Status:** `DONE` — T053; [evidence](../app-lock.md), [ADR 0004](../adr/0004-local-app-lock.md), [delivery](../agent-runs/sst-039-delivery.md).

**Acceptance:** first launch requires choosing username + password (zod: username 3–64 without control characters, password ≥ 12, confirmation matches) or Google; a recovery code is shown once; every app start requires unlock with the chosen method before any other IPC works (enforced in main); wrong attempts back off; Google uses the system browser, loopback `127.0.0.1:55411/oauth/callback`, PKCE/state/nonce, verified ID token, bound account only, 7-day offline grace; recovery code permits re-setup and is replaced; Settings changes password, switches method and regenerates the code after re-authentication; nothing secret in SQLite, logs or renderer persistence.

**Validation:** unit (schemas, verifiers, backoff, gate, OAuth with fake JWKS, loopback listener) and E2E (setup, relaunch, wrong/right password, recovery, fake Google provider), development and packaged.

## Definition of done ร่วม

เมื่อ ticket เริ่มหลัง confirm: acceptance criteria ผ่าน, error/cancel paths ที่เกี่ยวข้องตรวจแล้ว, evidence/ADR/spec references อัปเดต, tests ที่ตรวจพฤติกรรมจริงผ่าน, ไม่มี secret ใน committed artifacts/logs และ reviewable diff พร้อม known limitations ห้ามปิด ticket เพียงเพราะมี mock UI หรือ adapter stub

Native document N-T01–08 เป็น investigation inputs ไม่ใช่ duplicate delivery backlog: map N-T01→008/012/015, N-T02→002, N-T03→006, N-T04→029, N-T05→019/025, N-T06–07→038, N-T08→036/035.
