# Execution record — M0 ถึง SST-007

**เริ่มบันทึก:** 2026-10-14 · **Latest completed ticket:** SST-007/T011–T012 `DONE`, uncommitted; SST-006 committed `9b0ba05`, SST-005 committed `e9e9097`. Authorized by “ทำงานถัดไปได้เลย”. SST-008+ ยังไม่เริ่ม Earlier sections are historical; see [current execution plan](#sst-007-execution-plan--2026-10-15).

## Authorization / acceptance

ผู้ใช้อนุมัติ pipeline ANALYZE → DESIGN → PLAN → IMPLEMENT → TEST → REVIEW → DELIVER และ commit ทีละงาน: **SST-001 delivery + commit ก่อน SST-002 delivery + commit** ขอบเขตเฉพาะ M0 ไม่รวม SST-003–028, push, external PR, publish หรือ deploy; บันทึก scope นี้ใน product implementation plan และปรับข้อความที่ยังระบุว่ารอทั้ง MVP ให้สอดคล้อง

SST-001 เป็น ADR/เอกสารเท่านั้น ไม่มี repo application manifests, scaffold, dependencies, CSS/components หรือ assets ใหม่ ส่วน SST-002 จึงสร้าง isolated fixture/spike ได้หลัง first commit; อ่าน [analysis](m0-analysis.md), [tickets](../termius/tickets.md), [tasks](../termius/tasks.md), [architecture](../termius/proposed-architecture.md), [DS01](../termius/design-system-implementation.md) และ AGENTS.md ก่อนแก้

Acceptance ของ SST-001: ADR ครอบคลุม MVP/later/macOS arm64, original ssterm UX, selected stack/exact compatible pins/build tooling, app IDs/layout, Keychain/packaging approach, auth/known-host/Paste semantics และ DS01/T047; เอกสารที่เกี่ยวข้องสอดคล้อง, validation ผ่าน, independent review ไม่มี unresolved critical/high, delivery และ commit ก่อนเปิด SST-002

## Approved design / evidence boundaries

| Area | Decision ที่ coder ต้องบันทึกใน ADR |
|---|---|
| Product / IDs | macOS arm64, local-first/account-free/single vault; production `dev.ssterm.desktop`, spike `dev.ssterm.spike`; independent original UX ไม่พึ่ง Termius native/cloud |
| Layout | npm workspaces; future `apps/desktop/src/{main,preload,renderer/src}`, renderer `@/*`; `packages/{domain,contracts,services,adapters}`; isolated `spikes/ssh-compat` และ `tests/fixtures/ssh`; ยังไม่สร้างใน SST-001 |
| Exact UI pins | Electron 44.7.2, React/react-dom 19.3.0, TypeScript 7.0.2, electron-vite 5.0.0, Vite 7.3.7, @vitejs/plugin-react 5.2.0, tailwindcss/@tailwindcss/vite 4.3.3, shadcn 4.21.5, @base-ui/react 1.9.0, lucide-react 1.57.0 |
| Compatibility | electron-vite 5 รองรับ Vite 5–7 จึงเลือก Vite 7 แทน latest Vite 8; Node 24.11.1/npm 11.6.2 ที่ตรวจพบตรง baseline; package resolution ไม่พิสูจน์ build/runtime |
| Candidates | ssh2 1.17.0 รอ SST-002; @xterm/xterm 6.0.0 ยังเป็น candidate; better-sqlite3 13.0.3 รอ storage/native gates; @napi-rs/keyring 2.1.1 เป็น proposed SecretStore/opaque SecretRef รอ SST-003/005/006; M0 ไม่มี real Keychain operation |
| Packaging | @electron/packager 20.3.0, unsigned macOS arm64 `.app` ใน SST-002; signing/notarization/distribution/native storage-secret viability รอ later gates; tested M0 host macOS 15.7.4 arm64 ไม่ใช่ minimum deployment support claim (SST-028) |
| DS01 | Signal Blue v1.0, dark-first/light-later; Base UI / nova / @shadcn registry / Lucide; 32 px controls/rows, 4 px grid, radius 8 px controls/12 px dialogs, focus 2 px; Inter/JetBrains Mono offline + Thai/system fallback |
| Remaining design gates | Rendered contrast/status/focus matrix, ANSI readability, font licenses/offline packaging และ supplied SST artwork production exports ยังไม่ผ่าน; app/terminal themes แยก; branding เดิม |
| Behavior / safety | Shared auth/known-host policy, unknown key explicit trust และ changed key block; transient prompts/secrets ไม่ persist; Paste ไป pending composer, Run explicit/captured target; reconnect ใหม่ไม่ replay; typed validated IPC, sandbox/context isolation, ownership/generation/cancel/idempotent disposal ตาม architecture |

Architect metadata อยู่ `/private/tmp/ssterm-m0/package-metadata.json`; root ตรวจ UI 13 exact pins ด้วย `npm install --package-lock-only --ignore-scripts --no-audit --no-fund --cache /private/tmp/ssterm-m0/npm-cache --prefix /private/tmp/ssterm-m0/ui-resolution` ผ่าน exit 0 (14s), ไม่มี force/legacy-peer-deps หรือ repo scaffold หลักฐานอยู่ `/private/tmp/ssterm-m0/ui-resolution-evidence.json` นี่เป็น temporary peer/engine evidence ของ root ไม่ใช่ SST-001 document checks หรือ package acceptance; coder บันทึก pins/reasons/primary-source links ใน ADR ไม่พึ่ง temporary file เพียงอย่างเดียว

## Ordered tasks / ownership

ทุก stage เขียนไฟล์ร่วมกันแบบ sequential; tester/reviewer อ่านอิสระและให้ coder แก้ findings เก็บ user changes/skills/.codex ไว้ ไม่ให้สอง workers แก้ไฟล์ทับกัน ไม่มี DB/API/frontend implementation: storage spec รอ SST-003, frontend/IPC scaffold SST-004, native storage/secret integration SST-005/006

| ID / stage | Depends | Owner / files / output |
|---|---|---|
| M0-001-A ANALYZE | Confirmation | analyst; `docs/agent-runs/m0-analysis.md`; existing behavior/acceptance/unknowns DONE; ประวัติเดิมที่ยังรอ scope อ่านคู่ authorization ล่าสุด |
| M0-001-D DESIGN | A | architect; decisions ข้างบน DONE; ยังไม่สร้าง app |
| M0-001-P PLAN | D | planner; only `docs/agent-runs/implementation-plan.md`; DONE |
| M0-001-I1 IMPLEMENT | P | coder; new `docs/adr/0001-mvp-platform-stack.md`; ADR ครบ acceptance/pins/rationale/risks/primary sources |
| M0-001-I2 IMPLEMENT | I1 | coder; `AGENTS.md`, `docs/termius/{proposed-architecture,implementation-plan,tickets,tasks,design-system-implementation,implementation-skills}.md`; link ADR, confirmation/status/decisions สอดคล้อง; SST-001 IN_PROGRESS; SST-002 ยังไม่เริ่ม |
| M0-001-T TEST | I2 | tester; read-only checks ด้านล่าง + actual results ในแผนนี้หลัง coder หยุดแก้; ไม่แต่ง application scripts/results |
| M0-001-R REVIEW | T | independent reviewer; coverage SST-001/DS01, scope/privacy/security/regression; coder แก้ findings, critical/high block delivery |
| M0-001-L DELIVER + commit | R passed | root/delivery; acceptance/status lines และแผนนี้; ติ๊ก T001/T047 เมื่อผ่านจริง, record checks/limitations/commit hash; ไม่มี push |
| M0-002-P next ticket | L + first commit | planner/root; update แผนนี้ก่อน spike code เปิด SST-002/T002–T003; pending outline ด้านล่างไม่ใช่ runtime plan สำเร็จรูป |

## Actual document validation commands

รันจาก repo root: `git status --short`, `git diff --check`, `python3 -m json.tool skills-lock.json > /dev/null`, `python3 -m json.tool docs/termius/evidence/artifact-identity.json > /dev/null`, `git diff --stat`; อ่าน diff และ new ADR ตรงเพราะ untracked file ไม่อยู่ใน `git diff` ใช้ `rg -n 'AWAITING_IMPLEMENT_CONFIRMATION|AWAITING_CONFIRMATION|SST-001|SST-002|T001|T047|DS01' AGENTS.md docs/adr docs/termius docs/agent-runs` ตรวจ status consistency ก่อน staging; หลัง staging รัน `git diff --cached --check` และ `git diff --cached --stat`

Local Markdown links/assets ของ changed files (checker ตรวจ target existence ไม่ตรวจ anchors/prose/external sources ซึ่ง reviewer ตรวจเพิ่ม):

```sh
python3 - <<'CHECK'
import pathlib, re, subprocess, urllib.parse
names = subprocess.check_output(['git','diff','--name-only','--diff-filter=ACMR'], text=True).splitlines()
names += subprocess.check_output(['git','ls-files','--others','--exclude-standard'], text=True).splitlines()
errors = []
for name in sorted(set(names)):
    if not name.endswith('.md'): continue
    path = pathlib.Path(name)
    body = re.sub(r'```.*?```', '', path.read_text(), flags=re.S)
    for raw in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', body):
        url = urllib.parse.urlsplit(raw.strip().strip('<>').split()[0])
        if not url.scheme and not url.netloc and url.path and not (path.parent / urllib.parse.unquote(url.path)).exists():
            errors.append(f'{path}: {raw}')
print('Missing local targets:', errors)
raise SystemExit(bool(errors))
CHECK
```

ยังไม่มี application lint/typecheck/unit/E2E/build scripts ใน SST-001 จึงไม่รายงานว่าผ่าน; test-fix failure เดิมสูงสุด 3 attempts ถ้าไม่มี evidence ใหม่ให้เก็บ diagnostics และ resolve concrete blocker ไม่ rerun แบบเดา

## Operational note

ผู้ใช้กำหนด: หากชน runtime/tool limit จริง ให้ตรวจเวลาท้องถิ่น Asia/Bangkok บันทึกชนิด limit/เวลาที่พบ และกลับมาทำต่อรอบ 02:05 ถัดไป เงื่อนไขนี้ไม่ใช่คำสั่งให้พักตอนยังทำงานได้ ไม่เปลี่ยน scope หรือลำดับ SST-001 → commit → SST-002 → commit และ elapsed time ไม่ใช่ approval

## Pending SST-002 / rollback / ledger

SST-002 ยังไม่เริ่ม: หลัง SST-001 commit ตรวจ local fixture runtime จริง แล้ว update ownership/actual manifests/scripts/commands ก่อนสร้าง `tests/fixtures/ssh` → `spikes/ssh-compat` → failure/lifecycle tests → unsigned arm64 package/report; acceptance มี password/encrypted key, trust/reject/changed key, PTY/resize/exit, SFTP integrity, local loopback forwarding, denied/timeout/cancel/disconnect/teardown, algorithm/API limits และ packaged runtime; ไม่ใช้ real/Termius/production data หรือ real Keychain และไม่ mark complete จาก dev-only tests

Rollback SST-001: ย้อนเฉพาะ task-owned Markdown diff เมื่อจำเป็นและ preserve user changes ไม่ reset/clean; หลัง commit revert ตามคำสั่งไม่ rewrite history SST-002 ต้องเพิ่ม teardown ของ project-owned processes/ports/throwaway paths/package ก่อน runtime เมื่อจบ M0 หยุดก่อน SST-003/004

### TEST — PASS (2026-10-14)

- รัน `git diff --check`; ผ่าน
- Parse `docs/adr/dependency-baseline.json`, `skills-lock.json`, `docs/termius/evidence/artifact-identity.json`; ผ่านทั้งหมด
- ตรวจ local targets ใน changed/untracked Markdown; missing targets 0
- เทียบ 13 exact direct pins ใน baseline กับ `/private/tmp/ssterm-m0/ui-resolution/package-lock.json` และ `/private/tmp/ssterm-m0/ui-resolution-evidence.json`; ตรงครบ 13/13, resolver exit 0, 514 packages, scripts ไม่ถูกรัน, SHA-256 ตรง `2ea90e94e0fa629a0b1fa86c24d6d1b97771560c39d8a8d5303d753abd8ac538`
- ตรวจ inventory: 38 unique tickets และ 52 unique tasks; T001/T047 ยัง unchecked รอ review/delivery, T002/T003 ยัง unchecked และ SST-002 รอ first commit; SST-001 ยัง `IN_PROGRESS`, SST-002 `NOT_STARTED`, SST-003–028 ยัง approval-gated
- ไม่พบ application manifest จึงไม่มี lint/typecheck/unit/E2E/build ที่รันได้; metadata resolution ไม่ใช่ runtime/build proof. Minimum macOS deployment support ยังคงเป็น gate ของ SST-028 ตาม ADR

**Ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT DONE · TEST DONE · REVIEW DONE · DELIVER DONE · COMMIT PENDING · SST-002 NOT_STARTED. **SST-001 commit:** pending

**REVIEW / DELIVERY:** independent reviewer PASS, no blocking findings; delivery note [sst-001-delivery.md](sst-001-delivery.md) completed. Root closed SST-001/T001/T047 after those gates and will create the authorized first commit before SST-002. Pending status label standardized to `AWAITING_IMPLEMENT_CONFIRMATION`.

## SST-002 execution plan — 2026-10-14

**SST-001 commit:** `ad9ed51` (all stages DONE); supersedes pending commit references above. First-ticket gate satisfied; **SST-002 / T002–T003 IN_PROGRESS**, M0 authorization continues; SST-003–028 remain unapproved.
ANALYZE/DESIGN complete; implement now using isolated Node CommonJS spike, ssh2 `1.17.0`, Electron `44.7.2`, @electron/packager `20.3.0`; no production app scaffold or new DS work.

| Order / owner | Files and deliverable / gate |
|---|---|
| 1 coder | `tests/fixtures/ssh/{Dockerfile,sshd_config,entrypoint.sh}`: project-owned image/container, ephemeral fixture keys/password, SSH published on dynamic `127.0.0.1` port; actual host-key rotation preserves endpoint |
| 2 coder | `spikes/ssh-compat/{package.json,package-lock.json,src/{fixture,connection,probes,report}.cjs,test/integration.test.cjs}`: bounded connect/trust/auth/cancel contract; real SSH fixture and capability tests |
| 3 coder | `spikes/ssh-compat/{electron/main.cjs,scripts/{package,run-packaged}.cjs,README.md}`: shared probes run after `app.whenReady`, unsigned macOS arm64 `.app`, documented reproducible commands |
| 4 root | Root ignore/dependency orchestration and `docs/spikes/ssh-compatibility.md` report; update scoped status/docs after evidence; coder owns code only and edits stay sequential |
| 5 tester → reviewer → root | Actual tests/package results, independent correctness/privacy/security review, fix blocking findings, then delivery + authorized SST-002 commit; no push |

Coder creates scripts before validation; from `spikes/ssh-compat` run `npm ci`, `npm test`, `npm run package:mac`, `npm run test:packaged`; root additionally runs `git diff --check` and checks changed Markdown/JSON. Record actual scripts/results/failures; no pass claims before execution.
Acceptance matrix: password/encrypted-key auth; unknown-key reject/explicit trust and changed-key block; real PTY, `stty` resize and exit; SFTP upload/download hashes; internal HTTP through loopback local forwarding; denied/timeout/cancel/connection-loss and idempotent cleanup; packaged shared probes plus API/lifecycle/algorithm limitations and backend decision.
Fixture image/server and ephemeral credentials are project-owned; no user secrets, Termius data, real Keychain or `.codex` edits. Teardown only owned containers/processes/temporary paths/listeners/sockets; preserve evidence and user changes. Retry same failure at most three times without new evidence, then resolve concrete blocker.
Rollback: stop owned fixture/package processes, dispose sockets/listeners, delete only recorded throwaway paths; revert task-owned changes if requested, never blanket reset/clean. Packaging does not close production signing/native-storage/secret gates.
**SST-002 ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT PENDING · TEST PENDING · REVIEW PENDING · DELIVER+COMMIT PENDING. Do not close SST-002/T002/T003 until real integration and packaged runtime acceptance passes; stop after M0 delivery.

**SST-002 implementation ownership:** root owns `tests/fixtures/ssh/{Dockerfile,sshd_config,entrypoint.sh}`, root `.gitignore`, environment orchestration and final reports/status. Coder owns `spikes/ssh-compat` only. Fixture accepts generated `FIXTURE_PASSWORD` and `FIXTURE_PUBLIC_KEY`; internal HTTP target is `127.0.0.1:8080`. No overlapping edits.

## Final M0 record — 2026-10-15

SST-001 completed all stages and committed `ad9ed51` before SST-002 began. SST-002 ANALYZE/DESIGN/PLAN/IMPLEMENT/TEST/REVIEW/DELIVER completed; root will create the second authorized commit now. Earlier pending/NOT_STARTED lines are historical stage snapshots, superseded by this final record.

Actual checks: clean lockfile `npm ci --omit=optional --ignore-scripts` exit 0, explicit pinned runtime preparation, `npm run check` PASS, `npm test` PASS (4 Node tests: 19 real probes + 3 regressions), `npm run package:mac` PASS, `npm run test:packaged` PASS (19 real probes). Independent tester confirmed the corrected sources/package and no remaining fixture key directories/containers; reviewer re-review found no remaining High/Medium. Evidence and operational limits: [backend report](../spikes/ssh-compatibility.md); [delivery](sst-002-delivery.md). No production UI, real Keychain, external PR, push or deployment.

Coder previously hit a usage limit; work resumed on 2026-10-15 at 08:56 Asia/Bangkok after the requested 02:05 window. No limit prevented final runtime checks. Stop after M0 commit; SST-003 onward needs new scope authorization.

## SST-003 execution plan — 2026-10-15

**Confirmation:** ผู้ใช้สั่ง “ทำงาน ถัดไปต่อได้” หลัง M0; อนุมัติเฉพาะ next ticket **SST-003 / T004–T005**. Record นี้ supersedes M0 stop condition สำหรับ SST-003 เท่านั้น; SST-004–028/DS02–DS06 ยัง `AWAITING_IMPLEMENT_CONFIRMATION`. ไม่มี authorization ใหม่ให้ commit/push หรือเริ่ม app scaffold/real database/Keychain operations.
**Scope:** documentation-only domain/privacy/storage specification; ANALYZE และ DESIGN DONE. คง Electron/React/shadcn/Tailwind และ ssh2 decision เดิม; adapters/runtime acceptance อยู่ SST-005/006. ไม่มี DB/API/frontend implementation หรือ backend spike changes.

| Order / stage | Dependency / owner / files / acceptance |
|---|---|
| 1 PLAN | DESIGN; planner แก้เฉพาะ `docs/agent-runs/implementation-plan.md` record นี้; DONE |
| 2 IMPLEMENT T004 | PLAN; coder สร้าง `docs/termius/domain-storage-spec.md`: ER/data dictionary, IDs/relations/constraints, inheritance/empty/delete rules, field protection matrix และ create/edit/delete/inherit walkthroughs; optional illustrative JSON ใต้ `docs/termius/` ต้องไม่เป็น runtime fixtures |
| 3 IMPLEMENT T005 | T004; coder ต่อไฟล์เดียวกัน: lock/key loss/recovery/backup, SecretRef journal ordering, versioned migration strategy/failure walkthroughs และ later implementation gates |
| 4 Consistency | T004–T005; coder sequentially sync `AGENTS.md`, `docs/README.md`, `docs/termius/{README,proposed-architecture,implementation-plan,tickets,tasks,implementation-skills}.md` และ narrow later-scope note ใน `docs/adr/0001-mvp-platform-stack.md` (ไม่มี root `README.md`); ลิงก์ spec/authorization/status ตรงกัน; mark complete หลัง gates ผ่านจริง |
| 5 TEST → REVIEW | IMPLEMENT; independent tester/reviewer อ่านแบบ read-only; root จัด coder แก้ findings sequentially; unresolved critical/high block completion |
| 6 DELIVER | TEST/REVIEW pass; root ปิดเฉพาะ SST-003/T004/T005 และบันทึกผลจริง/limitations; ไม่มี commit/push/external PR |

**Domain contracts:** stable vault-scoped UUIDs/revisions + composite FKs; normalized Tag unique และ KnownHost endpoint unique. Port ใช้ inherit/value, default 22; auth ใช้ inherit/value(identity)/clear แบบ atomic bundle, default none. Address เป็น direct required; environment nullable และ tags เป็น direct assignments. Identity delete preview ครอบคลุม direct/inherited impacts และ explicit detach-to-clear/reassign; key delete ถูก restrict เมื่ออ้างอิง; host delete cascade tunnel rules แต่ retain trust. Group move/delete ต้องแสดง subtree choices; active connection ใช้ captured snapshot และไม่ retarget.
**Protection:** labels/endpoints/usernames/tags/environment/public keys/settings เป็น plaintext metadata ที่อาจ sensitive; ไม่อ้าง whole-database encryption. Password/private key/passphrase อยู่ Keychain หลัง opaque immutable SecretRefs; snippet body ต้อง encrypted ด้วย local key ใน Keychain. AEAD provider/algorithm contract เลือกและพิสูจน์ใน SST-006; ห้าม custom crypto/plaintext fallback.
**Lifecycle:** app/OS lock cancel auth/transfers/snippet actions, close sessions/SFTP/tunnels, invalidate generations และ purge decrypted caches; explicit unlock/reconnect, ไม่ auto-resume. Secret operation journal เก็บ metadata เท่านั้น: staged create → OS write → SQL publish; replacement swap ref แล้ว queue old delete; delete removes references + queues OS delete; ไม่อ้าง cross-store atomic transaction.
**Recovery:** consistent DB backup มี ciphertext และไม่มี secret export จึงไม่ portable โดยอัตโนมัติ; key loss ต้องแจ้ง unrecoverable protected fields โดยไม่ silent regeneration. Migration preflight/backup + transaction; corrupt/newer schema fail closed โดยไม่ reset. Future seams อยู่ MetadataRepository/SecretStore ไม่ expose storage details สู่ React.
**Validation commands (repo root):** `git status --short`, `git diff --check`, `git diff --stat`; local Markdown-target checker ที่บันทึกข้างบนรวม new/untracked files; `python3 -m json.tool skills-lock.json > /dev/null` และ `python3 -m json.tool` สำหรับ illustrative JSON ทุกไฟล์ที่เพิ่ม. ไม่มี software test/build ที่จำเป็นสำหรับ docs-only diff นี้; backend results เดิมไม่ใช่ SST-003 runtime proof.
**Consistency checks:** `rg -n 'SST-003|SST-004|T004|T005|AWAITING_IMPLEMENT_CONFIRMATION' AGENTS.md docs/README.md docs/termius docs/agent-runs/implementation-plan.md`; tester ตรวจ 38 unique ticket IDs / 52 unique task IDs, task checkboxes/status และ scope/history แยกจาก current authorization. Review walkthrough outcomes กับ constraints/protection/lock/recovery/migration โดยตรง; JSON parse ไม่พิสูจน์ domain behavior.
**Rollback / retry:** revert เฉพาะ task-owned documentation diff เมื่อจำเป็นและ preserve user changes; ไม่ reset/clean หรือแก้ `.codex`/installed skills. Failure เดิมสูงสุด 3 attempts เมื่อไม่มี evidence ใหม่ แล้วเก็บ diagnostics/resolve blocker; ไม่มี database/secret rollback เพราะไม่แตะ runtime data.
**SST-003 ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT DONE · TEST DONE · REVIEW DONE · DELIVER DONE. Ownership sequential; final record below supersedes earlier stage snapshots. No commit/push in this scope.

**SST-003 coder handoff (2026-10-15):** เพิ่ม [domain/storage spec](../termius/domain-storage-spec.md) และ sync current authorization/index/status links ตาม scope; ไม่มี code/runtime/Keychain operation หรือ commit/push. Coder checks: `git diff --check` PASS; JSON parse `skills-lock.json` และ `docs/termius/evidence/artifact-identity.json` PASS; local Markdown target checker รวม new file ตรวจ 11 ไฟล์ missing 0; inventory 38 unique tickets/52 unique tasks PASS; SST-003 `IN_PROGRESS`, T004/T005 unchecked รอ independent TEST/REVIEW. Provider/algorithm/native packaging/OS lookup/encryption/migration behaviors ยังคง future implementation gates ไม่ใช่ runtime evidence.

### Final SST-003 record — 2026-10-15

SST-003/T004–T005 `DONE`; [delivery](sst-003-delivery.md) สรุป scope/evidence/limitations. Independent TEST พบ table delimiters และ stale current-ticket heading; root แก้และ tester ตรวจซ้ำผ่าน. Independent REVIEW พบ Medium เรื่อง typed provider outcomes; root กำหนด vocabulary/retry/reconciliation เดียวกันและ reviewer ตรวจซ้ำผ่าน ไม่มี actionable finding ค้าง. Root ปรับ ER credential ownership และตรวจ optional-cardinality notation กับเอกสาร Mermaid ทางการ; ไม่ได้ render diagram หรือทดสอบ runtime.

Final root checks PASS: 12 changed/new Markdown files, 137 local links ไม่มี target หาย, JSON parse 2 ไฟล์, 38 unique ticket IDs/index entries และ 52 unique task IDs; checked เฉพาะ T001/T002/T003/T004/T005/T047. Spec มี 63 table rows คอลัมน์สอดคล้อง, 19 ER edges ผ่าน static syntax check และ 15 paper walkthroughs; `git diff --check` ผ่าน. Checks เหล่านี้เป็น documentation validation ไม่ใช่ SQL/Keychain/crypto/lock runtime proof. M0 commits ยังคง `ad9ed51` และ `ace9601`; รอบ SST-003 ไม่มี commit/push. SST-004–028/DS02–DS06 ยังรออนุมัติ.

## SST-004 execution plan — 2026-10-15

**Authorization:** ผู้ใช้สั่ง “commit และทำงานถัดไปต่อ”: SST-003 committed `603e600`; เริ่มเฉพาะ SST-004/T006–T007 และ DS02–DS03/T048–T049 ผ่าน pipeline. Supersedes earlier stop/current-status notes สำหรับ scope นี้; ไม่มี authorization ให้ commit SST-004, push, external PR หรือเริ่ม SST-005+. ANALYZE/DESIGN DONE; PLAN นี้เป็น gate ก่อน application coding.
**Baseline:** npm workspaces เฉพาะ `apps/desktop` และ `packages/contracts`; main/preload/renderer paths, exact direct pins และ `dev.ssterm.desktop` ตาม ADR 0001. Native titlebar; initial 1280×800, minimum 960×640. ยังไม่มี catalog/database/Keychain/SSH/session adapter หรือ production icon exports.

| Order / task | Dependency / owner / files / acceptance |
|---|---|
| 1 scaffold / T006 | PLAN; root owns root/workspace `package.json`, lockfile, `tsconfig*`, `apps/desktop/electron.vite.config.ts`, build/package/runtime scripts และ test config; inspect pinned official shadcn CLI/APIs, generate required primitives ก่อนส่ง ownership renderer ให้ coder B |
| 2 boundary / T007 | Scaffold contracts available; coder A owns `packages/contracts/**`, `apps/desktop/src/{main,preload}/**` และ focused unit tests ของ boundary; typed bootstrap/ping/window events, sender/payload/window ownership guards และ lifecycle/security policy |
| 3 foundation / DS02–T048 | Generated primitives + contract types; coder B owns `apps/desktop/components.json`, `src/renderer/**` รวม offline fonts/licenses, semantic CSS/variants, independent terminal theme และ renderer entry; no root/main/preload edits |
| 4 components / DS03–T049 | DS02; coder B extends renderer shared primitives/recipes และ development-only `#showcase` dynamic import; complete design-handoff inventory/state matrix ด้วย deterministic fixtures; default product เป็น honest empty workspace |
| 5 integration / T006–T007 | A/B handoff; root owns `tests/e2e/**`, scripts/package orchestration, `.gitignore` เมื่อจำเป็น และ status/evidence docs; no concurrent edits ไปยัง worker-owned files; inspect build/runtime and exact command scripts ก่อนรัน |
| 6 TEST → REVIEW → DELIVER | Integration; independent tester/reviewer ตรวจ runtime + diff; root แก้ findings sequentially; unresolved critical/high blocks completion; mark เฉพาะ SST-004/T006/T007/T048/T049 done เมื่อ acceptance ผ่านจริง |

**Bridge:** `bootstrap()` → Result `{app:{name,version,platform}, owner:{windowId:number,generation:number}, window:{focused,sequence}}`; `ping({owner,requestId})` → Result `{requestId,ready:true}`; `onWindowState(callback)` → idempotent unsubscribe รับ `{owner,sequence,type:'focus-changed',focused}`. Fixed sanitized errors: `invalid-request | unauthorized | stale-owner | unavailable`; strict bounds/unknown-key rejection; no arbitrary channel/Node/SSH API.
**Guard order/lifecycle:** registered webContents + main frame + exact entry URL → strict payload → owner/generation. Rotate owner on main-frame load; revoke on destroy; window sequence rejects stale focus events. Validate ownership against real window resources; session ownership remains SST-008 because this ticket creates no sessions.
**Security:** sandbox/contextIsolation/webSecurity enabled; nodeIntegration/webview disabled; permission checks/requests denied, unapproved navigation/new windows/webviews blocked; external allowlist empty ไม่มี external bridge. Production ใช้ exact file URL และ ignore dev URL env; dev จำกัด HTTP `127.0.0.1` port. CSP scripts self, styles self + unsafe-inline, fonts self, production connect none; dev permits only required loopback HMR.
**DS acceptance:** Signal Blue semantic sidebar/status/interactive mappings; 32 px controls/rows, 4 px grid, 8/12 px radii, 2 px focus. Essential boundaries ≥3:1, normal text ≥4.5:1 rendered; blue selected/focus แยก green connected/icon/text และ explicit target/PROD labels ใน fixture recipes. Bundle Inter/JetBrains Mono/Noto Sans Thai + licenses; ANSI16/terminal typography separate from app CSS.
**Inventory / scope:** showcase covers controls/forms, navigation/layout, feedback/overlays, connection identity, terminal workspace และ files/tunnels/credentials recipes ตาม DS03 inventory; labels ระบุ fixtures ไม่ pretend live connections. Required states default/hover/pressed/focus/disabled/loading/error, selected+connection combinations, long/Thai text, empty/error, dialog focus trap/return; showcase unavailable in production build.
**Planned root scripts:** `dev`, `typecheck`, `test`, `build`, `package:mac`, `test:e2e` จะสร้างและตรวจ manifests ก่อนใช้; commands ยังไม่ใช่ verification results. Install pinned lock via `npm ci --ignore-scripts` แล้ว explicit cached pinned Electron runtime preparation; root บันทึก actual prep command และ package paths เมื่อ scripts มีจริง.
**Verification sequence:** inspect actual manifests → `npm run typecheck` → `npm test` → `npm run build` → `npm run package:mac` → `npm run test:e2e`; discover any lint script ก่อนใช้ ไม่อ้าง nonexistent lint. Run Playwright Electron against unpackaged และ unsigned packaged app offline; record actual OS/arm64/window/fixture contexts, screenshots, console/network failures และ unrun limitations.
**Meaningful checks:** malformed/unknown/oversized payloads, spoofed sender/frame/URL/owner, stale generation/reload/destroy, ordered focus events/unsubscribe cleanup; real bridge calls + no Node passthrough. Verify denied permissions/navigation/new windows and production dev-URL rejection; packaged offline fonts/licenses, theme computed styles, rendered contrast/status/focus, keyboard/dialog return, Thai/fallback/IME, reduced motion, resize/overflow at both sizes.
**Docs / gates:** root syncs `AGENTS.md`, ADR scoped later note, product implementation-plan/tickets/tasks/design handoff/skills docs และ delivery/evidence as needed; distinguish DS02/03 fixtures from later DS04/05/06 and real-service acceptance. Run `git diff --check`, relevant JSON parsing/local Markdown targets + task/status consistency; no pass/completion claims before actual TEST/REVIEW.
**Rollback / retry:** dispose owned windows/listeners/test processes; remove only recorded throwaway userData/package/screenshots/runtime artifacts, preserve fixtures/evidence and user changes. Revert task-owned diffs only when needed; no blanket reset/clean, real Keychain/SSH/user data operation. Same failure at most 3 attempts without new evidence, preserve diagnostics and resolve concrete blocker before retrying.
**SST-004 ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT DONE · TEST DONE · REVIEW DONE · DELIVER DONE; commit/push not authorized for this ticket.

### Final SST-004 record — 2026-10-15

ส่งมอบ desktop shell, `window.ssterm` typed bridge, Signal Blue DS02/DS03, 33 scoped official Base UI/nova components, offline fonts/licenses และ DEV-only fixture showcase. [Implementation/evidence](../desktop-shell.md) · [Delivery](sst-004-delivery.md). Coder UI hit a usage limit after writing its files; root completed the remaining API/type fixes, row geometry, formatting and runtime validation on available capacity after the user said continue; no reset-time/wait success claim.

Actual checks PASS: `npm ci --ignore-scripts --no-audit --no-fund --cache /private/tmp/ssterm-m1/npm-cache`, `npm run runtime:prepare`, `npm run typecheck`, `npm test` 13/13, `npm run build`, `npm run test:e2e` 7/7, `npm run package:mac`, `npm run test:packaged` 4/4, showcase coverage 33/33. Independent tester confirmed both E2E reports, screenshots at 1280×800/960×640, packaged 16 WOFF2 + 3 OFL licenses; reviewer found no actionable finding. Generated package/reports remain ignored under `artifacts/`; app path `artifacts/package/SSTerm-darwin-arm64/SSTerm.app`.

Runtime corrections: TypeScript 7 removed baseUrl; use explicit relative path targets. electron-vite default externalization left contracts unavailable in sandbox preload; explicit bundle exclusion fixes both main/preload. Vite embedded a small font subset as data URL; assetsInlineLimit=0 keeps strict font-src self. Modal containment assertions wait for Base UI focus guards to settle rather than reading a transient sentinel. Production CSP stays strict; DEV inline refresh is limited to the exact selected loopback origin.

SST-004/T006/T007/T048/T049 complete, while native IME/OS accessibility/full workflow contrast/performance and release fonts/icons/signing remain later gates. Real storage/Keychain/SSH/session services are not implemented. No SST-004 commit, push, external PR or deploy; SST-005–028/DS04–DS06 remain awaiting authorization.

Final documentation checks PASS: 15 changed/new Markdown files, 183 local links without missing targets, 10 JSON files parsed, 38 unique tickets/52 tasks. Checked tasks exactly T001–T007 and T047–T049; source artwork is byte-identical, direct dependency pins exact, untracked text has no trailing whitespace. No owned temporary profiles/package staging directories or development Vite listener remain. `git diff --check` PASS.

## SST-005 execution plan — 2026-10-15

**Authorization:** ผู้ใช้สั่ง commit และทำงานถัดไปต่อ; SST-004 committed `d6e1822` ก่อนเริ่ม **SST-005/T008**. Supersedes earlier stop/current-status notes เฉพาะ scope นี้; ไม่อนุมัติ commit SST-005, push, external PR หรือ SST-006+/T009/DS04–DS06. ANALYZE/DESIGN DONE; PLAN นี้เป็น gate ก่อน application coding.
**Scope / baseline:** full version-1 metadata schema, typed transactional repository/settings, bounded deterministic normalization, versioned migration runner, consistent backup และ fail-closed recovery diagnostics. ไม่มี Catalog resolver/UI, SSH, SecretStore/Keychain หรือ protected-value mutation. Follow [domain/storage contracts](../termius/domain-storage-spec.md) และ SST-005 acceptance; T009 belongs SST-006.
**Driver decision:** เลือก built-in `node:sqlite` `DatabaseSync` + `backup` หลัง actual root probes Node 24.11.1/SQLite 3.50.4 และ Electron 44.7.2/Node 24.21/SQLite 3.53.4 ผ่าน CRUD/Thai/FK/backup. Experimental warning เป็น known limitation; better-sqlite3 candidate ยังไม่ได้ทดสอบ ไม่อ้างว่าทดสอบแล้ว fail. Root บันทึก ADR rationale และ packaged gate; probes ไม่ใช่ feature completion.

| Order / task | Dependency / owner / files / acceptance |
|---|---|
| 1 contracts/schema / T008 | PLAN; coder A owns `packages/domain/**`, `packages/adapters/**`, `tests/unit/storage*.test.ts`; typed records/finite changes/results และ SQL schema/indexes/constraints/metadata manifest; no root config/main/UI edits |
| 2 repository / T008 | Schema; coder A implements open/snapshot/atomic commit, catalog + row revisions, bounded normalization and full graph validation; SQL FK/unique/CHECK plus reference/vault/kind/auth/cycle checks reject the whole transaction |
| 3 migration/backup/recovery / T008 | Repository; coder A implements safe-open identity/version/integrity/ref/protection checks, WAL-aware backup/checksum/manifest, preflight/per-step migrations and sanitized failures; future-step fixtures prove runner behavior |
| 4 composition/config / T008 | A's contracts available; root owns root/workspace manifests/lock/config, `apps/desktop/src/main/**`, contracts/preload/renderer health integration, `tests/e2e/**`, scripts and docs; edits never overlap A's files |
| 5 runtime/package / T008 | Repository + composition; root adds actual Electron main-module CRUD/backup/reopen fixtures and packaged repetition; existing IPC/security tests stay intact; owned temporary DB/profile only |
| 6 TEST → REVIEW → DELIVER | Integration; independent tester then reviewer validate acceptance/evidence; root resolves findings sequentially; unresolved critical/high blocks completion; close only SST-005/T008 after gates pass |

**Interface:** main-only `openMetadata({path}): Promise<StorageOpenResult>`; repository `snapshot(): Result<MetadataSnapshot>`, `commit({expectedCatalogRevision,changes:MetadataChange[]}): Result<MetadataSnapshot>`, `backup({destination}): Promise<Result<BackupManifest>>`, idempotent `close()`. Finite discriminated changes only; no SQL/table passthrough, filesystem paths/rows exposed to renderer or test bridge.
**Transactions:** one `BEGIN IMMEDIATE` validates complete resulting graph and expected global/row revisions before publishing; owner revision increments once for membership edits. Explicit deletion honors RESTRICT and approved cascades; no implicit auth rewrite. Reserve Snippet/SecretRef/KeyMetadata/SecretOperation tables but protected mutations return unavailable until SST-006; no plaintext body, placeholder ciphertext or invented provider.
**Open / ownership:** exclusive fresh-file creation; foreign keys on each connection, WAL/full sync/bounded busy wait. `user_version` only authoritative schema version; application_id + identity manifest guard provenance. Existing zero-byte/unrelated/corrupt/newer/ref-invalid/unknown-protection storage fails closed after safe read-only inspection, preserving original DB/WAL; no reset, downgrade or automatic salvage. Single-instance app ownership; root initializes owned userData DB before window and closes on quit.
**Backup / migration:** quiesce mutations; unresolved journal blocks backup/migration. Use online WAL-aware backup plus SHA-256/schema/protection manifest. Full-chain preflight checks supported steps, free space/writability/provider needs; preserve original pre-migration backup. Each step plus version increments atomically; failed step rolls back, earlier committed steps remain. No OS-journal replay; recovery verifies an explicit copy while preserving original identity/files.
**Integration:** `apps/desktop/src/main/storage.ts` re-exports production adapter as second stable CommonJS main entry; root configures Rollup inputs index/storage, preserveEntrySignatures strict and `[name].js`. Bootstrap shares only sanitized storage health codes; renderer shows actionable blocked alert. Electron tests require generated `out/main/storage.js`, exercising the same production module without expanding preload capabilities.
**Verification sequence (actual root scripts):** inspect final manifests → `npm run typecheck` → `npm test` → `npm run build` → `npm run test:e2e` → `npm run package:mac` → `npm run test:packaged`; no lint script exists. If lock changes, `npm ci --ignore-scripts` then `npm run runtime:prepare`; record actual commands/results and platform/fixture context, never infer PASS from probes.
**Meaningful unit/integration coverage:** CRUD/settings/Thai/IDNA/IP boundaries and restart durability; FK/unique/auth/kind/vault/cycle constraints; multi-change rollback/deletion/revision conflicts; corrupt/newer/foreign/zero/unwritable failures preserve originals; lock/busy bounded failure; WAL backup/checksum/reopen and unresolved-journal block. Inject future internal 1→2→3 migration steps to test preflight/failing-step rollback/original backup; released production schema remains version 1, not a claim of shipped historic migrations. Electron and packaged fixtures repeat real CRUD/backup/reopen; existing malformed/unauthorized IPC regressions retained.
**Docs / completion:** root syncs ADR 0001, `AGENTS.md`, architecture/domain/spec/status docs as needed and records storage evidence/delivery; distinguish main-only storage from later catalog/secret capabilities. Run `git diff --check`, affected JSON parsing/local Markdown targets and SST/T status consistency. No protected data/runtime or ticket-complete claims before actual gates.
**Rollback / retry:** close owned DB handles/processes/windows, clean only recorded temporary fixtures/artifacts; preserve original DB/WAL/pre-migration backup and diagnostics. Revert task-owned source/doc diffs only if requested; never blanket reset/clean, delete user data, touch installed skills/.codex, or replay OS-secret operations. Same failure maximum 3 attempts without new evidence, then resolve concrete blocker and continue independent work.
**SST-005 ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT DONE · TEST DONE · REVIEW DONE · DELIVER DONE. No SST-005 commit/push; SST-006+/T009 and DS04–DS06 remain awaiting confirmation.

SST-005 integration ownership refinement: coder B owns `apps/desktop/src/main/{index,boundary,storage}.ts`, `packages/contracts/src/index.ts`, renderer health hook/shell and existing boundary/bridge unit fixtures. Root retains build/manifests/runtime E2E/docs; coder A remains sole owner of domain/adapters/storage unit tests. Edits stay disjoint.

### Final SST-005 record — 2026-10-15

SST-005/T008 complete; [local storage](../local-storage.md), [ADR 0002](../adr/0002-local-metadata-storage.md) and [delivery](sst-005-delivery.md). Built-in Node 24 SQLite replaces the previously untested external candidate; no better-sqlite3 failure is claimed. Metadata Module, schema v1, typed atomic edits, safe open/backup/internal migrations and sanitized main-owned storage health are implemented; protected publication and real session/catalog workflows remain later.

Actual final checks PASS: clean lockfile npm ci --ignore-scripts, explicit runtime preparation, typecheck, npm test 33/33 (18 storage), build, development E2E 10/10, package:mac and packaged E2E 7/7. Independent tester confirmed both full JSON reports/runtime receipts, privatePermissions=true, backup hash, persistence/recovery/newer-file preservation and stable ASAR storage entry/chunk. Reviewer found one Medium permission gap; fixed by rejecting permissive existing source files/directories before writes with no chmod, added unit/runtime regressions, then focused re-review passed. No unresolved finding. Root visually inspected the packaged corrupt-store recovery message.

Migration validation uses synthetic future steps; production supports v1 only. Source permissions are a POSIX mode gate, not an ACL audit. Node 24.11.1 host warns that SQLite is experimental; Electron 44.7.2 embedded Node 24.21.0 and packaged CRUD/backup/reopen work. No real Keychain, user/Termius data or SSH access; no SST-005 commit/push/deployment. T009/SST-006 and subsequent tickets remain awaiting authorization.

Final documentation/cleanup PASS: 16 changed/new Markdown files, 195 local links without missing targets, 5 JSON files, 38 unique tickets/52 unique tasks; only T001–T008 and T047–T049 checked. Exact direct pins and new-file whitespace pass; final E2E reports have zero skipped/flaky/unexpected tests and both inline SQLite receipts confirm privatePermissions=true. Task-owned temporary profiles/database staging/probe directories and Vite listener are gone; git diff --check passes.

## SST-006 execution plan — 2026-10-15

**Authorization:** หลังรายงานสถานะ ผู้ใช้สั่ง “เริ่มทำต่อได้”; SST-005 committed `e9e9097` แล้ว จึงเริ่มเฉพาะ **SST-006 / T009–T010** ผ่าน pipeline. ไม่อนุมัติ commit/push/external PR หรือ SST-007+/DS04–DS06. ANALYZE/DESIGN DONE; PLAN นี้เป็น gate ก่อน application coding.

**ANALYZE (root, actual evidence):** schema v1 มี `secret_ref`, `secret_operation`, `snippet`, `key_metadata`, `local_vault.contentKeyRef/protectionFormat` แล้ว แต่ Adapter ปฏิเสธ protected/journal mutations (`validation.ts` type filter) และ open/migration fail-closed เมื่อมี protected content/pending journal. Root probe ใน scratchpad ติดตั้ง `@napi-rs/keyring@2.1.1` (MIT, prebuilt `keyring-darwin-arm64`) และรันจริงบน host macOS arm64 ใน namespace ทิ้ง `dev.ssterm.test.probe-<pid>`: missing `getSecret` → `null`, missing delete → `false`, binary `setSecret`/`getSecret` round-trip, `findCredentialsAsync(service)` คืน account, delete → `true` แล้ว `null`, 300 KB secret ผ่าน, เหลือ 0 items. Errors เป็น `Error{code:'GenericFailure', message}`; locked/denied แยกได้เฉพาะจากข้อความ OS ที่ adapter ต้องพิสูจน์ ไม่ fabricate.

**DESIGN decisions:**
- **Credential store:** `@napi-rs/keyring` exact pin behind main-only `SecretProvider` seam. Item identity = service namespace (production `dev.ssterm.desktop.secrets`; tests `dev.ssterm.test.<uuid>`) + account `<vaultId>/<kind>/<intendedRef>`; kind/ownership verified from identity, value never leaves main. Lookup by stable intendedRef before every retry; set only on a never-published ref (no in-place replacement of published items).
- **Outcome mapping:** reads/lookups → `present|missing|locked|denied|unavailable|error`; mutations → `confirmed|missing|denied|unavailable|unknown|error`. Rejected set/delete is `unknown` unless definitively pre-flight; locked/denied only when evidence-backed OS status text identifies it; otherwise `unavailable`. Raw provider messages never cross the seam.
- **Authenticated protection:** Node/OpenSSL `crypto` AES-256-GCM (`protectionFormat = "aes-256-gcm-v1"`, envelopeVersion 1): random 32-byte content key in Keychain (kind content-key), random 12-byte nonce per encryption, 16-byte tag; envelope = version byte + nonce + ciphertext + tag. AAD = unambiguous length-prefixed encoding of format, envelopeVersion, vaultId, snippetId, field `body`. Tamper/wrong-record/wrong-field/wrong-key/unknown-format all reject without modifying stored bytes. No custom construction, KDF passwords or plaintext fallback.
- **Journal:** new finite MetadataChange variants stage/transition/publish/retire secret operations inside the existing one-transaction commit, so publication composes with owner create/update (e.g. KeyMetadata insert + privateKeyRef publish). Replacement swaps ref and journals oldRef cleanup in the same transaction; descriptors removed only after confirmed OS absence. Content key initializes only an uninitialized vault without ciphertext; missing key never regenerates. Startup reconciliation resolves pending operations per spec §Cross-store journal; backup remains blocked while unresolved.
- **Transient lifetime:** main-only owned transient secret holder (Buffer, bounded TTL, explicit dispose that overwrites, registry purge on lock-screen/suspend/quit); no app-wide credential cache. JavaScript zeroization is best effort, not guaranteed.
- **Placement:** provider/protection Adapters in `packages/adapters`; journal orchestration `SecretService` in new `packages/services` (ADR layout). Memory/fault-injection provider is a test fixture. No renderer/preload secret IPC in this ticket (UI belongs SST-017/023).

| Order / task | Dependency / owner / acceptance |
|---|---|
| 1 IMPLEMENT / T009 | PLAN; single coder owns `packages/**`, `apps/desktop/src/main/**`, `apps/desktop/electron.vite.config.ts`, manifests/lock, `scripts/package-desktop.mjs`, `tests/**`, ADR 0003 and `docs/secret-storage.md`. Provider contract tests run against memory fixture and real Keychain test namespace; outcome mapping, namespace isolation and cleanup |
| 2 IMPLEMENT / T010 | 1; protection Module, journal changes/service/reconciliation, snippet ciphertext validation, transient holder/purge, redaction checks (fixture secrets absent from SQLite bytes, backups, logs, errors) |
| 3 runtime/package | 2; main-only `secrets` entry exercised by Electron E2E and packaged E2E against a test Keychain namespace; native binding unpacked from ASAR and loaded in packaged app |
| 4 TEST → REVIEW → DELIVER | independent tester then reviewer; root resolves findings; unresolved critical/high blocks; close only SST-006/T009/T010 |

**Verification sequence:** `npm ci --ignore-scripts` (lock changes) → `npm run runtime:prepare` → `npm run typecheck` → `npm test` → `npm run build` → `npm run test:e2e` → `npm run package:mac` → `npm run test:packaged`; `git diff --check`. Keychain tests use only `dev.ssterm.test.*` namespaces and verify zero leftover items; never the production namespace, user/Termius data or real SSH.
**Rollback:** revert task-owned diff only on request; delete only test-namespace Keychain items the tests created; preserve user data and the production namespace.

**SST-006 ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT DONE · TEST DONE · REVIEW DONE · DELIVER DONE. No SST-006 commit/push; SST-007+/DS04–DS06 remain awaiting confirmation.

### Final SST-006 record — 2026-10-15

SST-006/T009–T010 complete; [secret storage](../secret-storage.md), [ADR 0003](../adr/0003-secret-storage-and-content-protection.md) and [delivery](sst-006-delivery.md). Coder implemented provider/protection Adapters, journal change variants, new `packages/services` SecretService/TransientSecrets, lazy Keychain composition in main, a main-only `secrets` entry and native-binding ASAR unpack. Independent TEST passed all commands (49/49 unit, 11/11 E2E, 8/8 packaged) with 12/17 scratch-copy mutations caught; four Medium test gaps. Independent REVIEW passed with one Medium (reconcile could publish a ref swap without its owner payload, spec step 5) plus lows. One consolidated fix round: existing owners now take only plain ref swaps, needs-input→present publishes instead of abandoning, provider never throws raw errors, keyring loads lazily so a binding failure cannot crash startup, stale needs-input ops cancel, added the gap tests; coder confirmed each restored guard fails exactly one test.

Final checks after fixes: typecheck PASS, `npm test` 55/55 (root re-ran), build PASS, E2E 11/11, `package:mac` PASS, packaged E2E 8/8, `git diff --check` PASS; lockfile unchanged since the clean `npm ci`. Keychain item count by service name only: 0 `dev.ssterm.test*`, 0 `dev.ssterm.desktop.secrets` (root re-counted). Limitations recorded in [secret storage](../secret-storage.md#known-limitations): adapter cannot distinguish locked/denied (maps to unavailable/unknown), unsigned-binary Keychain ACL identity until SST-028, migration still refuses protected vaults before any v2, repository checks envelope structure only, no verified-restore fence or app lock (SST-008/015), best-effort zeroization, no UI consumers yet.


## SST-007 execution plan — 2026-10-15

**Authorization:** ผู้ใช้สั่ง “ทำงานถัดไปได้เลย” หลัง SST-006 committed `9b0ba05`; เปิดเฉพาะ **SST-007/T011–T012**. Supersedes earlier awaiting-confirmation notes เฉพาะ scope นี้; ไม่อนุมัติ commit/push/external PR, SST-008+ หรือ UI SST-016/DS04–DS06. ANALYZE/DESIGN DONE; PLAN นี้เป็น gate ก่อน application coding.
**Scope / acceptance:** [SST-007](../termius/tickets.md#sst-007--groups-inheritance--tags--catalog-domain), [T011–T012](../termius/tasks.md), [domain/storage contracts](../termius/domain-storage-spec.md): catalog CRUD, nested group visibility, inheritance/provenance, cycle/move/delete consistency, shared-identity impacts, search/tag AND filters; immutable resolved configs remain unchanged after catalog edits. Existing schema, SecretService and production secret provider remain intact; no new dependency/schema, SSH/session implementation, renderer/preload/IPC or secret value input.
**DESIGN / pure boundary:** `resolveHostConfig`, `queryCatalogHosts`, `catalogGroupTree` in domain; copy/deep-freeze effective config with default port 22 independent of other defaults, atomic auth bundle (identity/key/opaque refs), inherit/value/clear winning provenance and ancestry. Explicit all/ungrouped/group(+descendants) scopes; deduplicated tag-ID AND filters; NFC/lowercase search across host label/address/effective username/direct tags/ancestry labels, normalized-label then ID order.
**DESIGN / service boundary:** `CatalogModule(repository, now?, createId?)` exposes query/resolve/prepare(intent)/apply(token), finite host/group/identity/tag CRUD + set-host-tag intents. Reject unknown keys and secret fields; create IDs internally; never accept caller passwordRef. Keep existing password unless method switches or forgetPassword=true, then queue cleanup. Reject identity mutation while it owns a nonterminal secret publication.
**Preview / atomicity:** server-owned UUID tokens, maximum 64 previews, five-minute TTL; capture global catalog revision, immutable changes/impacts/generated IDs/expiry, not an encrypted whole snapshot. Apply token only against its captured revision; no fresh-revision substitution or SecretService async side effect. Reuse trusted-main Adapter `previewMetadataChanges(snapshot, changes)` around existing applyChanges/validation; no SST-006 journal refactor. Each batch <=1000 changes; reject larger plans without silent chunking.
**Deletion / impact:** group deletion explicitly reparents to parentId or removes subtree; moves cycle-check atomically. Identity deletion explicitly detaches with CLEAR or reassigns another identity. Track effectiveConnectionChanged vs provenanceChanged vs pathChanged, excluding global/timestamps/unrelated ancestor revisions; include direct/indirect identity users and respect descendant override cutoffs. Host deletion explicitly removes owned rules/memberships while retaining keys/trust/identities/tags. Tag deletion removes host+snippet assignments, increments each owner once and preserves ciphertext.
**Secret cleanup:** deletion/forget-password queues cleanup in the same metadata transaction and returns pending cleanup IDs; Catalog performs no OS provider reads/deletes. Existing SecretService.reconcile performs cleanup later; denied cleanup remains pending. Add minimal `set-snippet-tag` metadata variant with membership/revision validation only; never decrypt/reseal snippet bodies.

| Order / task | Dependency / owner / files / acceptance |
|---|---|
| 1 domain / T011–T012 | PLAN; coder A alone owns `packages/domain/src/catalog.ts`, `tests/unit/catalog-domain.test.ts`; pure resolver/tree/query and fixtures for override/clear/auth/defaults/provenance/order; no `index.ts` edits |
| 2 service + adapter / T011–T012 | PLAN + agreed domain exports; coder B alone owns `packages/domain/src/index.ts`, `packages/adapters/src/{index,validation,records}.ts` as needed, `packages/services/src/{catalog,index}.ts`, `tests/unit/catalog.test.ts`; exports A helpers, minimal metadata variant/preview and bounded transactional intent engine; no `secrets.ts` edits |
| 3 integration + evidence / T011–T012 | A/B public boundaries; root owns `apps/desktop/src/main/catalog.ts`, Electron build configuration, `tests/e2e` catalog tests, docs/status/evidence. Stable CommonJS main entry exports productionCatalogModule/pure helpers; Node/CDP createRequire exercises real SQLite fixtures + memory provider in dev/package without renderer capabilities or real Keychain access |
| 4 TEST → REVIEW → DELIVER | Integrated code; independent tester then reviewer confirm acceptance/privacy/security/regression and actual evidence; root resolves findings sequentially. Unresolved critical/high blocks completion; close only SST-007/T011–T012 after gates pass |

**Sequencing / ownership:** A and B may implement disjoint files after this handoff; B alone owns domain barrel exports to avoid overlap. Root integrates only after exported interfaces settle. No frontend/API/schema migration phase is needed; no worker edits another worker's owned files without an explicit handoff.
**Verification / baseline:** actual root scripts are `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`, `npm run package:mac`, `npm run test:packaged`; no lint script. SST-006 baseline is 55 unit / 11 development E2E / 8 packaged checks. First run catalog-specific unit/runtime checks, then related full regression scripts in that order; new changes/failures justify repeat runs. Record actual counts/platform/fixture paths; baseline counts are historical, not SST-007 PASS claims.
**Meaningful tests:** nested overrides/clear/default-port/auth consistency; copied frozen resolution survives later edits; descendants visibility, normalized search/tag AND/dedup/order; cycles/reparent/subtree deletion, direct+indirect shared-identity impacts/override cutoff; stale/expired/consumed/bounded preview tokens; malformed/unknown/secret-bearing intents; revision conflict and full batch rollback; tag removal from encrypted snippets preserves ciphertext/revision rules; queued cleanup atomicity and denied reconciliation with memory provider. Real SQLite + packaged main-module entry verifies persistence and rollback, without real SSH or production/user/Termius data.
**Docs / completion:** root synchronizes AGENTS, catalog/storage architecture/spec where necessary, product plan/tickets/tasks and delivery evidence. Validate affected Markdown local targets, relevant JSON/task consistency and `git diff --check`; do not check T011/T012 before acceptance and independent gates complete.
**Rollback / retry:** close only owned repository/provider/runtime resources; clean only recorded temporary test fixtures/artifacts. Preserve user data/production Keychain, installed skills/.codex and unrelated changes; source rollback only task-owned diff on request, never reset/clean. After three attempts at the same failure without new evidence, preserve diagnostics and resolve the concrete blocker while continuing independent work.
**SST-007 ledger:** ANALYZE DONE · DESIGN DONE · PLAN DONE · IMPLEMENT DONE · TEST DONE · REVIEW DONE · DELIVER DONE. No SST-007 commit/push; SST-008+/DS04–DS06 remain awaiting confirmation.


### Final SST-007 record — 2026-10-15

SST-007/T011–T012 complete; [catalog contract/evidence](../catalog.md) and [delivery](sst-007-delivery.md). Implemented pure resolver/query/tree with frozen config/provenance, finite main-owned CatalogModule, revision-fenced bounded impact previews and atomic CRUD/deletion/queued secret cleanup. Adapter adds shared validation projection and snippet-tag membership changes that preserve ciphertext. Shipped main-only `catalog.js`; no schema/dependency, renderer/preload/IPC changes, real SSH or SST-016 UI.

ANALYZE/architect/PLAN completed before coding; two coders owned disjoint files. Both hit usage limits, then resumed after the user's “continue” and root's clock check at 18:53:36 Asia/Bangkok (reported reset 18:53); no limit is left pending. Root integrated production entry/runtime fixtures. Actual final commands PASS: `npm run typecheck`, `npm test` **80/80** (11 pure catalog + 14 SQLite/memory-provider catalog), `npm run build`, `npm run test:e2e` **13/13**, `npm run package:mac`, `npm run test:packaged` **10/10**. Electron 44.7.2, unsigned macOS arm64. No new install/lockfile resolution was needed; no lint script exists.

Independent TEST repeated typecheck and 25 catalog unit tests, checked the actual runtime reports and decoded both catalog receipts. Development/packaged JSON under ignored `artifacts/test-results` has zero skipped/flaky/unexpected results. Receipts confirm inheritance, AND search, stale rejection, immutable capture, move/default/impact, detach/subtree deletion, SQL-journal-before-OS-cleanup, denial retained and later reconciliation. New catalog cleanup fixtures use a memory provider with real SQLite; inherited SST-006 real Keychain regressions still passed under owned `dev.ssterm.test.*` namespaces with zero-leftover assertions. No production/user/Termius data or live SSH access.

Independent REVIEW found no actionable correctness/privacy/security findings; no source change followed. DELIVER completed the scoped handoff. Limits: queued cleanup is pending until SecretService reconciliation, batch >1,000 changes rejects, preview expiry/consumption/conflict requires a new preview, config capture is not proof of a live session, and SST-006 restore/app-lock/provider limitations remain. No SST-007 commit/push/external PR/deployment; SST-008+/DS04–DS06 await authorization.

Final documentation/cleanup PASS: 14 changed/new Markdown files, 212 local links with no missing targets, 11 relevant JSON files parsed, 38 unique tickets/52 unique tasks. Checked tasks exactly T001–T012 and T047–T049 (15 done, 37 remaining); T013+/DS04–DS06 stay unchecked. Changed/new text whitespace and `git diff --check` pass. No owned catalog temporary databases/runtime directories or Vite listener on port 5173 remain.
